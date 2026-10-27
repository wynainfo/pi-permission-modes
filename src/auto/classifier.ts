/**
 * Auto mode, the model call.
 *
 * One side request per verdict: the system prompt (constant per strictness)
 * and the user message that verdict.ts built, the `report_verdict` tool for
 * models that call tools, strict JSON otherwise. Reasoning stays off,
 * temperature 0, a bounded output budget. The call has 15 seconds in all, one
 * retry inside that budget on a transport error or a 429/5xx; whatever does
 * not come back as a parsable verdict is "unavailable", which the host
 * treats as a refusal with its own message (never as an allow).
 *
 * The model is pi's current one or a `provider/model-id` from the registry
 * (the key and headers come from the registry too); the request function
 * is injected so the tests never reach a provider.
 *
 * Reasoning: the request asks for none, and pi sends a server's off switch
 * only when the model entry declares its `compat.thinkingFormat`. When a
 * verdict comes back with reasoning anyway, the classifier probes, once, in
 * the background and on the same prompt: the formats pi knows an off switch
 * for, then the Qwen soft switch (`/no_think` at the end of the user
 * message, which Qwen3 hybrids honor on any server and other models ignore).
 * The first candidate whose reply carries no reasoning is used from then on
 * (and remembered by the host); none working is reported, so the host can
 * tell the user to pick another model.
 */

import type { AssistantMessage, Context, Model, SimpleStreamOptions, Api } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import { CLASSIFIER_DEFAULTS, type ClassifierConfig } from "../schema.ts";
import { clip, parseVerdict, REPORT_VERDICT_TOOL, type Verdict } from "./verdict.ts";

export const CLASSIFIER_TIMEOUT_MS = 15_000;
/** The `thinkingFormat` values pi sends an explicit off switch for, in probe order. */
export const THINKING_OFF_FORMATS = ["qwen-chat-template", "qwen", "deepseek", "zai"] as const;
/** The text switch probed last: `/no_think` at the end of the user message. */
export const NO_THINK_SWITCH = "no_think";
export const THINKING_OFF_CANDIDATES: readonly string[] = [...THINKING_OFF_FORMATS, NO_THINK_SWITCH];

/** The request shape for a candidate: a model copy with the format, or the user message with the text switch. */
const applyOff = (model: Model<Api>, context: Context, candidate: string): { model: Model<Api>; context: Context } => {
  if (candidate !== NO_THINK_SWITCH) return { model: withThinkingFormat(model, candidate), context };
  const messages = context.messages.map((m, i) =>
    i === context.messages.length - 1 && m.role === "user" && typeof m.content === "string" ? { ...m, content: `${m.content}\n/no_think` } : m,
  );
  return { model, context: { ...context, messages } };
};

/** A copy of the model that makes pi send the format's off switch (the branch needs `reasoning: true`). */
export const withThinkingFormat = (model: Model<Api>, thinkingFormat: string): Model<Api> =>
  ({ ...model, reasoning: true, compat: { ...((model.compat as object | undefined) ?? {}), thinkingFormat } }) as Model<Api>;

export interface ClassifierOptions {
  /** Candidates known to work, by `provider/id` (from an earlier probe): a `thinkingFormat` or `no_think`. */
  knownThinkingFormats?: Readonly<Record<string, string>>;
  /** The probe's outcome: the candidate that works, or undefined when none did; `thinking` is what the model produced before the probe. */
  onThinkingFormat?: (model: string, thinkingFormat: string | undefined, thinking: number) => void;
}
/**
 * The output budget. A verdict is about 60 tokens; the rest is headroom for
 * a reasoning model that thinks before it answers (the request asks for no
 * reasoning, but a vLLM or llama.cpp server with a thinking model may not
 * honor that). The timeout bounds the wait either way.
 */
export const CLASSIFIER_MAX_TOKENS = 1500;

export type CompleteFn = (model: Model<Api>, context: Context, options: SimpleStreamOptions) => Promise<AssistantMessage>;

/** What the classifier needs from pi: the session's model and the registry (lookup and auth). */
export interface ModelSource {
  current: Model<Api> | undefined;
  find(provider: string, id: string): Model<Api> | undefined;
  auth(model: Model<Api>): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
}

/** `thinking`: characters of reasoning the model produced before answering (0 when it did not reason). */
export type ClassifierResult = { ok: true; verdict: Verdict; ms: number; model: string; thinking: number } | { ok: false; why: string; ms: number; model?: string; thinking?: number };

const thinkingChars = (msg: AssistantMessage): number => msg.content.reduce((n, c) => n + (c.type === "thinking" ? c.thinking.length : 0), 0);

export interface Classifier {
  /** Judge one prompt; never throws. */
  judge(prompt: { system: string; user: string }, signal?: AbortSignal): Promise<ClassifierResult>;
  /** The model in use, `provider/id`, or "(none)" when none can be resolved. */
  modelName(): string;
  /** A one-time warning about the configured model (not found, no key), or undefined. */
  warning(): string | undefined;
}

/**
 * Resolve `classifier.model`: "current" is the session's model; a
 * "provider/model-id" string is looked up in the registry and falls back
 * to the current model with a warning.
 */
export function resolveModel(cfg: Pick<ClassifierConfig, "model"> | undefined, source: ModelSource): { model: Model<Api> | undefined; warning?: string } {
  const want = cfg?.model ?? CLASSIFIER_DEFAULTS.model;
  if (want === "current") return { model: source.current };
  const slash = want.indexOf("/");
  if (slash <= 0 || slash === want.length - 1) {
    return { model: source.current, warning: `permission-mode: classifier.model "${want}" is not "current" or "provider/model-id"; using the current model` };
  }
  const found = source.find(want.slice(0, slash), want.slice(slash + 1));
  if (!found) return { model: source.current, warning: `permission-mode: classifier.model "${want}" is not in pi's model registry; using the current model` };
  return { model: found };
}

const isRetryable = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|5\d\d)\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network/i.test(msg);
};

const describeError = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").slice(0, 160);
};

/** The verdict in a completed message: the tool call's arguments, else the text. */
export function verdictFromMessage(msg: AssistantMessage): { verdict?: Verdict; why?: string } {
  if (msg.stopReason === "error" || msg.stopReason === "aborted") return { why: msg.errorMessage ? describeError(msg.errorMessage) : msg.stopReason };
  const call = msg.content.find((c) => c.type === "toolCall");
  if (call && call.type === "toolCall") {
    const v = parseVerdict(call.arguments);
    if (v) return { verdict: v };
    if (msg.stopReason === "length") return { why: lengthCut(msg) };
    // The raw arguments travel with the failure: the user sees what the model sent.
    let raw: string;
    try {
      raw = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments);
    } catch {
      raw = String(call.arguments);
    }
    return { why: `tool call ${call.name} without a valid verdict; it sent ${clip(raw ?? "nothing", 200)}` };
  }
  const text = msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (!text.trim()) return { why: msg.stopReason === "length" ? lengthCut(msg) : "empty answer" };
  const v = parseVerdict(text);
  if (v) return { verdict: v };
  if (msg.stopReason === "length") return { why: lengthCut(msg) };
  return { why: `the answer was not a verdict (prose or an unknown score); it said ${clip(text, 200)}` };
}

/** The answer hit the token budget: say where the tokens went, since a thinking model is the usual reason. */
const lengthCut = (msg: AssistantMessage): string => {
  const thought = msg.content.reduce((n, c) => n + (c.type === "thinking" ? c.thinking.length : 0), 0);
  return `the answer ran out of tokens (${CLASSIFIER_MAX_TOKENS})${thought > 0 ? `; the model spent them reasoning (${thought} characters), a non-reasoning classifier.model answers within budget` : ""}`;
};

export function createClassifier(cfg: ClassifierConfig | undefined, source: ModelSource, complete: CompleteFn = completeSimple as CompleteFn, opts: ClassifierOptions = {}): Classifier {
  const resolved = resolveModel(cfg, source);
  const model = resolved.model;
  const name = model ? `${model.provider}/${model.id}` : "(none)";
  const known = model ? opts.knownThinkingFormats?.[name] : undefined;
  let off: string | undefined = known && THINKING_OFF_CANDIDATES.includes(known) ? known : undefined;
  let probed = false;
  /** Try each candidate on the prompt that just produced reasoning; adopt the first that works. */
  const probe = async (context: Context, auth: { apiKey?: string; headers?: Record<string, string> }, thinking: number): Promise<void> => {
    if (!model) return;
    for (const candidate of THINKING_OFF_CANDIDATES) {
      if (candidate === off) continue;
      const req = applyOff(model, context, candidate);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CLASSIFIER_TIMEOUT_MS);
      try {
        const msg = await complete(req.model, req.context, { temperature: 0, maxTokens: CLASSIFIER_MAX_TOKENS, signal: ctrl.signal, apiKey: auth.apiKey, headers: auth.headers, timeoutMs: CLASSIFIER_TIMEOUT_MS });
        if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
        if (thinkingChars(msg) === 0 && msg.content.length > 0) {
          off = candidate;
          opts.onThinkingFormat?.(name, candidate, thinking);
          return;
        }
      } catch {
        // a server that rejects the parameter: the next candidate
      } finally {
        clearTimeout(timer);
      }
    }
    opts.onThinkingFormat?.(name, undefined, thinking);
  };
  let warned = false;
  return {
    modelName: () => name,
    warning: () => {
      if (warned) return undefined;
      warned = true;
      if (resolved.warning) return resolved.warning;
      if (!model) return "permission-mode: the Auto classifier has no model (pi has no current model); asks are refused as unavailable";
      return undefined;
    },
    async judge(prompt, signal) {
      const started = Date.now();
      const ms = () => Date.now() - started;
      if (!model) return { ok: false, why: "no model", ms: ms() };
      let auth: Awaited<ReturnType<ModelSource["auth"]>>;
      try {
        auth = await source.auth(model);
      } catch (e) {
        return { ok: false, why: `auth: ${describeError(e)}`, ms: ms(), model: name };
      }
      if (!auth.ok) return { ok: false, why: `auth: ${auth.error}`, ms: ms(), model: name };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CLASSIFIER_TIMEOUT_MS);
      const onOuter = () => ctrl.abort();
      signal?.addEventListener("abort", onOuter, { once: true });
      const context: Context = {
        systemPrompt: prompt.system,
        messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }],
        tools: [{ name: REPORT_VERDICT_TOOL.name, description: REPORT_VERDICT_TOOL.description, parameters: REPORT_VERDICT_TOOL.parameters as never }],
      };
      const options: SimpleStreamOptions = {
        temperature: 0,
        maxTokens: CLASSIFIER_MAX_TOKENS,
        signal: ctrl.signal,
        apiKey: auth.apiKey,
        headers: auth.headers,
        timeoutMs: CLASSIFIER_TIMEOUT_MS,
      };
      try {
        let why = "";
        for (let attempt = 0; attempt < 2; attempt++) {
          if (ctrl.signal.aborted) break;
          let msg: AssistantMessage;
          try {
            const req = off ? applyOff(model, context, off) : { model, context };
            msg = await complete(req.model, req.context, options);
          } catch (e) {
            why = describeError(e);
            if (isRetryable(e) && !ctrl.signal.aborted) continue;
            return { ok: false, why, ms: ms(), model: name };
          }
          const r = verdictFromMessage(msg);
          const thinking = thinkingChars(msg);
          if (thinking > 0 && !probed) {
            probed = true;
            void probe(context, auth, thinking); // in the background: this verdict is not delayed
          }
          if (r.verdict) return { ok: true, verdict: r.verdict, ms: ms(), model: name, thinking };
          why = r.why ?? "no verdict";
          // A transport-level failure reported inside the message is worth one retry too.
          if (msg.stopReason === "error" && isRetryable(msg.errorMessage) && !ctrl.signal.aborted) continue;
          return { ok: false, why, ms: ms(), model: name, thinking };
        }
        return { ok: false, why: ctrl.signal.aborted ? (signal?.aborted ? "aborted" : `timeout after ${CLASSIFIER_TIMEOUT_MS / 1000} s`) : why || "no verdict", ms: ms(), model: name };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuter);
      }
    },
  };
}

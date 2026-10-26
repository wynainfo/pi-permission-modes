/** Tests for classifier.ts against a scripted completion function: never a provider. */

import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Model, Api } from "@earendil-works/pi-ai";
import { CLASSIFIER_TIMEOUT_MS, createClassifier, type ModelSource, resolveModel, verdictFromMessage } from "./classifier.ts";

const model = (provider: string, id: string): Model<Api> => ({ id, provider, name: id, api: "openai-completions", baseUrl: "http://x", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 });
const current = model("wyna", "wyna-pro");
const small = model("local", "gemma");
const source = (over: Partial<ModelSource> = {}): ModelSource => ({ current, find: (p, id) => (p === "local" && id === "gemma" ? small : undefined), auth: async () => ({ ok: true, apiKey: "k" }), ...over });
const reply = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "x",
  model: "m",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason,
  ...(errorMessage ? { errorMessage } : {}),
  timestamp: 0,
});
const prompt = { system: "s", user: "u" };

test("resolveModel: current, a registry hit, a miss and a malformed string fall back with a warning", () => {
  assert.equal(resolveModel({ model: "current" }, source()).model, current);
  assert.equal(resolveModel(undefined, source()).model, current);
  assert.equal(resolveModel({ model: "local/gemma" }, source()).model, small);
  const miss = resolveModel({ model: "local/none" }, source());
  assert.equal(miss.model, current);
  assert.match(miss.warning ?? "", /not in pi's model registry/);
  assert.match(resolveModel({ model: "nonsense" }, source()).warning ?? "", /not "current" or "provider\/model-id"/);
  assert.equal(resolveModel({ model: "a/b/c" }, source({ find: (p, id) => (p === "a" && id === "b/c" ? small : undefined) })).model, small, "split at the first slash");
});

test("judge: a tool call answer, with the request shaped as planned", async () => {
  let seen: { system?: string; tools?: number; temperature?: number; maxTokens?: number; apiKey?: string; reasoning?: unknown } = {};
  const c = createClassifier({ model: "local/gemma" }, source(), async (m, ctx, opts) => {
    seen = { system: ctx.systemPrompt, tools: ctx.tools?.length, temperature: opts.temperature, maxTokens: opts.maxTokens, apiKey: opts.apiKey, reasoning: opts.reasoning };
    assert.equal(m, small);
    return reply([{ type: "toolCall", id: "1", name: "report_verdict", arguments: { risk: "low", authorization: "stated", reason: "named" } }], "toolUse");
  });
  const r = await c.judge(prompt);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.verdict, { risk: "low", authorization: "stated", reason: "named" });
  assert.equal(r.model, "local/gemma");
  assert.deepEqual(seen, { system: "s", tools: 1, temperature: 0, maxTokens: 1500, apiKey: "k", reasoning: undefined });
  assert.equal(c.modelName(), "local/gemma");
  assert.equal(c.warning(), undefined);
});

test("judge: a JSON text answer parses; prose, an empty answer and a token-limit cut are unavailable", async () => {
  const text = async (t: string, stop: AssistantMessage["stopReason"] = "stop") => createClassifier(undefined, source(), async () => reply([{ type: "text", text: t }], stop)).judge(prompt);
  const ok = await text('{"risk":"medium","authorization":"implied","reason":"vendor host"}');
  assert.ok(ok.ok && ok.verdict.risk === "medium");
  const prose = await text("I think this is fine, low risk.");
  assert.ok(!prose.ok && /not a verdict/.test(prose.why));
  const empty = await text("");
  assert.ok(!empty.ok && /empty answer/.test(empty.why));
  const cut = await text("", "length");
  assert.ok(!cut.ok && /ran out of tokens \(1500\)$/.test(cut.why));
  // A thinking model that used the budget on its reasoning: the failure says so.
  const thought = createClassifier(undefined, source(), async () =>
    reply([{ type: "thinking", thinking: "x".repeat(50) }, { type: "toolCall", id: "1", name: "report_verdict", arguments: {} }], "length"),
  );
  const r = await thought.judge(prompt);
  assert.ok(!r.ok && /ran out of tokens \(1500\); the model spent them reasoning \(50 characters\), a non-reasoning classifier.model/.test(r.why));
});

test("judge: one retry on a retryable error, none on another; an error message in the reply is reported", async () => {
  let calls = 0;
  const flaky = createClassifier(undefined, source(), async () => {
    calls++;
    if (calls === 1) throw new Error("HTTP 429 Too Many Requests");
    return reply([{ type: "text", text: '{"risk":"low","authorization":"none","reason":"r"}' }]);
  });
  assert.ok((await flaky.judge(prompt)).ok);
  assert.equal(calls, 2);
  calls = 0;
  const broken = createClassifier(undefined, source(), async () => {
    calls++;
    throw new Error("HTTP 401 Unauthorized");
  });
  const r = await broken.judge(prompt);
  assert.ok(!r.ok && /401/.test(r.why));
  assert.equal(calls, 1);
  const errored = createClassifier(undefined, source(), async () => reply([], "error", "model overloaded"));
  const e = await errored.judge(prompt);
  assert.ok(!e.ok && /overloaded/.test(e.why));
});

test("judge: no model, a failed auth and an aborted call are unavailable with the cause; the model warning fires once", async () => {
  const none = createClassifier(undefined, source({ current: undefined }), async () => reply([]));
  const r = await none.judge(prompt);
  assert.ok(!r.ok && r.why === "no model");
  assert.match(none.warning() ?? "", /no model/);
  assert.equal(none.warning(), undefined, "once");
  const noKey = createClassifier(undefined, source({ auth: async () => ({ ok: false, error: "no API key for wyna" }) }), async () => reply([]));
  const k = await noKey.judge(prompt);
  assert.ok(!k.ok && /auth: no API key/.test(k.why));
  const ctrl = new AbortController();
  const slow = createClassifier(undefined, source(), (_m, _c, opts) => new Promise((_res, rej) => opts.signal?.addEventListener("abort", () => rej(new Error("aborted")))));
  const p = slow.judge(prompt, ctrl.signal);
  ctrl.abort();
  const a = await p;
  assert.ok(!a.ok && a.why === "aborted");
  assert.equal(CLASSIFIER_TIMEOUT_MS, 15_000);
  const miss = createClassifier({ model: "x/y" }, source(), async () => reply([]));
  assert.match(miss.warning() ?? "", /not in pi's model registry/);
});

test("verdictFromMessage: a tool call without a valid verdict names the tool", () => {
  const r = verdictFromMessage(reply([{ type: "toolCall", id: "1", name: "report_verdict", arguments: { risk: "huge" } }], "toolUse"));
  assert.match(r.why ?? "", /tool call report_verdict without a valid verdict; it sent \{"risk":"huge"\}/);
  const str = verdictFromMessage(reply([{ type: "toolCall", id: "1", name: "report_verdict", arguments: '{"risk":"low","authorization":"stated","reason":"r"}' as never }], "toolUse"));
  assert.deepEqual(str.verdict, { risk: "low", authorization: "stated", reason: "r" }, "arguments left as a JSON string parse too");
});

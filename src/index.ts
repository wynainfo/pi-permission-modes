/**
 * Permission Mode extension
 *
 * Switchable, data-driven permission modes (cycle with alt+m or /perm). A MODE
 * is a JSON bundle of a sandbox profile + an allow/ask/deny permission policy +
 * UI metadata, defined in `schema.ts` (built-in defaults) and overridable in
 * `permission-mode.json`. The four shipped modes:
 *
 *   Default - confirm bash/edit/write; approved in-project bash runs sandboxed
 *             (writable), approved out-of-project runs UNSANDBOXED.
 *   Plan    - planning mode. In-project bash runs sandboxed READ-ONLY; reads are
 *             free; only Markdown create/edit is allowed in-project. Out-of-project
 *             access prompts. A system prompt steers the model to write a plan file.
 *   Build   - in-project reads/writes/bash run without confirmation; bash runs
 *             sandboxed. Prompts on out-of-project access or privilege escalation;
 *             approved out-of-project commands run UNSANDBOXED.
 *   YOLO    - never prompts, never sandboxes; full user permissions.
 *
 * The OS sandbox (@anthropic-ai/sandbox-runtime) is the real enforcement for
 * bash. If it's unavailable the sandboxed modes fall back to PROMPTING for
 * in-project bash and the TUI indicator shows a warning.
 *
 * This entry file is wiring only — flags, commands, shortcuts, the tool_call
 * dispatcher, the input/skill handler, and lifecycle. The logic lives in sibling
 * modules:
 *   schema.ts       mode definition types + plan prompt (defaults: permission-mode.defaults.json)
 *   resolve.ts      surface resolution engine (allow/ask/deny)
 *   bash-enforce.ts bash gate + exec plan (sandbox composition)
 *   bash-parse.ts   tree-sitter command extraction + heuristic fallback
 *   config-load.ts  layered permission-mode.json loader
 *   approvals.ts    session-scoped "Allow for session" store
 *   paths.ts        out-of-project / protected-path predicates
 *   heuristics.ts   bash escape/privilege scan (tree-sitter fallback)
 *   sandbox.ts      SandboxController (runtime lifecycle, per-mode profile)
 *   status.ts       footer indicator
 *   show-plan.ts    show_plan tool   plan-render.ts  its renderer
 *
 * Install (see README.md):
 *   pi install git:github.com/wynainfo/pi-permission-modes
 *   Linux also needs: bubblewrap, socat, ripgrep
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { askWithSession, SessionApprovals } from "./approvals.ts";
import { bashExecPlan, bashGate } from "./bash-enforce.ts";
import { analyzeBash } from "./bash-parse.ts";
import { loadModeConfig, loadStockDefaults, persistModeRule, profileToConfig, stockDefaultsFile } from "./config-load.ts";
import type { PermState } from "./modes.ts";
import { isOutside, isProtectedWrite } from "./paths.ts";
import { decide, decideBashCommand, mostRestrictive } from "./resolve.ts";
import { SandboxController } from "./sandbox.ts";
import {
  type Action,
  type ModeDef,
  PLAN_PROMPT_SENTINEL,
  type PermissionModeConfig,
  planModeSystemPrompt,
  type Surface,
} from "./schema.ts";
import { createShowPlanTool } from "./show-plan.ts";
import { updateStatus } from "./status.ts";

/** Built-in file tools whose `input.path` is gated against the matching surface. */
const FILE_TOOL_SURFACE: Record<string, Surface> = {
  read: "read",
  edit: "edit",
  write: "write",
  ls: "ls",
  grep: "grep",
  find: "find",
};

/** Tools with a dedicated branch in the dispatcher (not gated via the `tool` surface). */
const BUILTIN_HANDLED = new Set(["bash", "read", "edit", "write", "ls", "grep", "find", "web_search", "show_plan"]);

/** Our own tools that must never be hidden (show_plan is needed in Plan mode). */
const NEVER_HIDE = new Set(["show_plan"]);

export default async function (pi: ExtensionAPI) {
  // The engine starts on the shipped stock defaults (permission-mode.defaults.json);
  // session_start reloads the merged config (stock + global full-authority +
  // project tighten-only) from permission-mode.json.
  let config: PermissionModeConfig = loadStockDefaults();
  let modeName = config.defaultMode;
  // True when the current mode was auto-picked as the headless-child safety
  // fallback (no --perm flag, session entry, or forwarded env). The mode's
  // POLICY fully applies, but its systemPrompt is not injected — a planning
  // prompt steering a headless worker to write plan files and ask about alt+m
  // would misdirect it — and the fallback isn't exported to child processes
  // as if it were an explicit choice (children re-derive their own fallback).
  let fallbackMode = false;
  const root = process.cwd();

  const currentMode = (): ModeDef => config.modes[modeName] ?? config.modes[config.defaultMode];

  const sandbox = new SandboxController();
  // toolCallIds the user explicitly approved to run OUTSIDE the sandbox.
  const approvedUnsandboxed = new Set<string>();
  // "Allow for session" memory, keyed per-mode.
  const approvals = new SessionApprovals();

  /** Prompt to allow an `ask`, honoring session grants (a target list requires
   * every entry to be granted; granting remembers all). Returns true to allow.
   * When `onForever` is given, a fourth "Allow forever" option persists the rule. */
  const promptAllow = (
    ctx: ExtensionContext,
    surface: Surface,
    target: string | string[],
    title: string,
    onForever?: () => void | Promise<void>,
  ): Promise<boolean> =>
    askWithSession(
      { hasUI: ctx.hasUI, select: (t, o) => ctx.ui.select(t, o) },
      approvals,
      modeName,
      surface,
      target,
      title,
      onForever,
    );

  /** "Allow forever": persist `<mode>.permission.<surface>.<key> = allow` to the
   * global config and hot-reload so it applies now and in future sessions. */
  const learnForever = (ctx: ExtensionContext, surface: Surface, key: string) => () => {
    try {
      const file = persistModeRule(getAgentDir(), modeName, surface, key, "allow");
      config = loadModeConfig(ctx.cwd, getAgentDir(), (m) => ctx.ui.notify(m, "warning"));
      ctx.ui.notify(`permission-mode: always allow ${surface} "${key}" in ${currentMode().label} — saved to ${file}`, "info");
    } catch (e) {
      ctx.ui.notify(`permission-mode: could not save rule: ${e}`, "error");
    }
  };

  const localBash = createBashTool(root);

  pi.registerFlag("perm", {
    description: `Start in permission mode: ${config.cycleOrder.join(" | ")}`,
    type: "string",
    default: "",
  });
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for the sandboxed modes (heuristics + prompts only)",
    type: "boolean",
    default: false,
  });

  // Hide a mode's `hideTools` from the model (pre-exposure), restoring the rest.
  const applyToolVisibility = () => {
    const hide = new Set((currentMode().hideTools ?? []).filter((n) => !NEVER_HIDE.has(n)));
    const all = pi.getAllTools().map((t) => t.name);
    pi.setActiveTools(hide.size ? all.filter((n) => !hide.has(n)) : all);
  };

  const setMode = async (name: string, ctx: ExtensionContext, persist = true, viaFallback = false) => {
    if (!config.modes[name]) return;
    modeName = name;
    fallbackMode = viaFallback;
    // Forward to child pi processes (e.g. subagents) via inherited env. The child
    // adopts it on session_start unless an explicit --perm flag overrides. The
    // implicit headless fallback is NOT forwarded: a child with no explicit mode
    // derives the same safe fallback itself (and skips the systemPrompt too).
    if (!viaFallback) process.env.PI_PERMISSION_MODE = modeName;
    const m = currentMode();
    await sandbox.applyProfile(m.sandbox); // re-init runtime if the profile changed
    applyToolVisibility();
    updateStatus(ctx, m, sandbox);
    ctx.ui.notify(`Permission mode: ${m.label}`, "info");
    if (persist) pi.appendEntry<PermState>("perm-mode", { mode: modeName });
  };

  /** The most restrictive built-in-style mode for a headless child without a
   * forwarded mode: a read-only sandboxed mode if any, else the default. */
  const safeChildMode = (): string => {
    const ro = config.cycleOrder.find((n) => config.modes[n]?.sandbox.enabled && !config.modes[n]?.sandbox.writable);
    const sandboxed = config.cycleOrder.find((n) => config.modes[n]?.sandbox.enabled);
    return ro ?? sandboxed ?? config.defaultMode;
  };

  const cycle = async (ctx: ExtensionContext) => {
    const order = config.cycleOrder;
    const idx = order.indexOf(modeName);
    await setMode(order[(idx + 1) % order.length], ctx);
  };

  /**
   * Resolve which mode to start in:
   *   1. explicit --perm flag, then 2. persisted session entry (resume),
   *   3. PI_PERMISSION_MODE env (forwarded from a parent / user-set),
   *   4. headless child with none of the above → most restrictive (never YOLO),
   *      flagged as `fallback` (policy applies, systemPrompt is not injected),
   *   5. the current/default mode.
   */
  const pickMode = (ctx: ExtensionContext, useFlag: boolean): { name: string; fallback: boolean } => {
    let resolved: string | undefined;
    if (useFlag) {
      const flag = String(pi.getFlag("perm") ?? "").toLowerCase();
      if (config.modes[flag]) resolved = flag;
    }
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "perm-mode") {
        const data = entry.data as PermState | undefined;
        if (data?.mode && config.modes[data.mode]) resolved = data.mode;
      }
    }
    if (!resolved) {
      const env = process.env.PI_PERMISSION_MODE;
      if (env && config.modes[env]) resolved = env;
    }
    if (!resolved && !ctx.hasUI) return { name: safeChildMode(), fallback: true }; // headless child, no forwarded mode
    return { name: resolved ?? modeName, fallback: false };
  };

  pi.registerShortcut("alt+m", {
    description: `Cycle permission mode (${config.cycleOrder.join(" -> ")})`,
    handler: async (ctx) => cycle(ctx),
  });
  pi.registerCommand("perm", {
    description: `Set or cycle permission mode: /perm [${config.cycleOrder.join("|")}|init|clear-approvals]`,
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "clear-approvals") {
        approvals.clearAll();
        return ctx.ui.notify("permission-mode: cleared session approvals", "info");
      }
      if (arg === "init") {
        // Scaffold an editable copy of the stock defaults at the global path.
        const dest = path.join(getAgentDir(), "permission-mode", "permission-mode.json");
        if (existsSync(dest)) {
          return ctx.ui.notify(`permission-mode: ${dest} already exists — edit it directly`, "warning");
        }
        try {
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, readFileSync(stockDefaultsFile(), "utf-8"));
          return ctx.ui.notify(`permission-mode: wrote ${dest} — edit it to customize your modes`, "info");
        } catch (e) {
          return ctx.ui.notify(`permission-mode: could not write ${dest}: ${e}`, "error");
        }
      }
      if (config.modes[arg]) await setMode(arg, ctx);
      else await cycle(ctx);
    },
  });
  pi.registerCommand("sandbox", {
    description: "Show the active mode's sandbox status and configuration",
    handler: async (_args, ctx) => {
      const m = currentMode();
      if (!m.sandbox.enabled) {
        return ctx.ui.notify(`${m.label}: sandbox disabled for this mode (bash runs unsandboxed)`, "info");
      }
      if (sandbox.disabled) return ctx.ui.notify("Sandbox disabled via --no-sandbox", "info");
      if (!sandbox.ready) return ctx.ui.notify(`Sandbox unavailable: ${sandbox.warn ?? "unknown"}`, "warning");
      const c = profileToConfig(m.sandbox);
      ctx.ui.notify(
        [
          `Sandbox: ACTIVE for ${m.label} (${m.sandbox.writable ? "project-writable" : "read-only"})`,
          "",
          `Network allowed: ${c.network?.allowedDomains?.join(", ") || "(none)"}`,
          `Deny read:  ${c.filesystem?.denyRead?.join(", ") || "(none)"}`,
          `Allow write: ${c.filesystem?.allowWrite?.join(", ") || "(none)"}`,
          `Deny write:  ${c.filesystem?.denyWrite?.join(", ") || "(none)"}`,
        ].join("\n"),
        "info",
      );
    },
  });

  // Replace built-in bash so the sandbox can wrap it. Sandboxing is recomputed at
  // run time from the active mode's profile: disabled (YOLO), approved escapes,
  // and the degraded fallback run unsandboxed; non-writable modes run read-only.
  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, _ctx) {
      const approved = approvedUnsandboxed.delete(id); // user granted an escape
      const m = currentMode();
      const plan = bashExecPlan(m.sandbox.enabled, m.sandbox.writable, sandbox.ready, approved);
      const ops = plan.sandboxed ? sandbox.bashOps({ readOnly: plan.readOnly }) : null;
      if (!ops) return localBash.execute(id, params, signal, onUpdate);
      const sandboxed = createBashTool(root, { operations: ops });
      return sandboxed.execute(id, params, signal, onUpdate);
    },
  });

  // Plan Mode helper: render a written plan file to the user (display-only).
  pi.registerTool(await createShowPlanTool(root));

  pi.on("session_start", async (_event, ctx) => {
    config = loadModeConfig(ctx.cwd, getAgentDir(), (m) =>
      ctx.hasUI ? ctx.ui.notify(m, "warning") : console.error(m),
    );
    if (!config.modes[modeName]) modeName = config.defaultMode;
    // Resolve the start mode BEFORE init so the sandbox initializes with the
    // right profile, then setMode reconciles status (applyProfile is a no-op).
    const picked = pickMode(ctx, true);
    modeName = picked.name;
    await sandbox.init({
      cwd: ctx.cwd,
      noSandbox: pi.getFlag("no-sandbox") === true,
      hasUI: ctx.hasUI,
      notify: (m) => ctx.ui.notify(m, "warning"),
      profile: currentMode().sandbox,
    });
    await setMode(picked.name, ctx, false, picked.fallback);
  });
  pi.on("session_tree", async (_event, ctx) => {
    const picked = pickMode(ctx, false);
    await setMode(picked.name, ctx, false, picked.fallback);
  });
  pi.on("session_shutdown", async () => {
    approvals.clearAll(); // session-scoped grants don't outlive the session
    await sandbox.reset();
  });

  // Drop any unconsumed escape grant once the tool call resolves.
  pi.on("tool_execution_end", async (event) => {
    approvedUnsandboxed.delete(event.toolCallId);
  });

  // Inject the active mode's system prompt (if any). The handler runs each turn
  // and reads the live mode, so it auto-clears when the mode changes. The "@plan"
  // sentinel resolves to the date-stamped Plan-mode prompt. A mode picked as the
  // implicit headless fallback keeps its policy but skips the prompt injection.
  pi.on("before_agent_start", async (event) => {
    applyToolVisibility(); // keep hidden tools hidden as the tool set evolves
    const sp = currentMode().systemPrompt;
    if (!sp || fallbackMode) return undefined;
    const resolved = sp === PLAN_PROMPT_SENTINEL ? planModeSystemPrompt(new Date().toISOString().slice(0, 10)) : sp;
    return { systemPrompt: `${event.systemPrompt}\n\n${resolved}` };
  });

  // Skill gating: skills aren't tools — they're invoked via `/skill:<name>` text,
  // so intercept the input before expansion and resolve the `skill` surface.
  pi.on("input", async (event, ctx) => {
    const match = /^\/skill:([\w-]+)/.exec(event.text.trim());
    if (!match) return undefined;
    const name = match[1];
    const action = decide(currentMode(), "skill", name);
    if (action === "deny") {
      if (ctx.hasUI) ctx.ui.notify(`Skill "${name}" blocked in ${currentMode().label}`, "warning");
      return { action: "handled" as const };
    }
    if (
      action === "ask" &&
      !(await promptAllow(ctx, "skill", name, `Skill "${name}" — first use in ${currentMode().label}; allow?`, learnForever(ctx, "skill", name)))
    ) {
      return { action: "handled" as const };
    }
    return undefined; // allow → continue to expansion
  });

  pi.on("tool_call", async (event, ctx) => {
    const { toolName } = event;
    const m = currentMode();
    // `input` is a discriminated union across tools; view it loosely (custom
    // tools surface as Record<string, unknown> anyway) and guard each field.
    const input = event.input as Record<string, unknown>;
    const inPath = typeof input.path === "string" ? input.path : undefined;

    // Hard backstop: never write to protected paths (file tools aren't sandboxed),
    // unless the mode explicitly trusts everything (YOLO). Matched lexically AND
    // on the symlink-resolved canonical path, so a link can't smuggle the write.
    if (!m.bypassProtectedPaths && (toolName === "edit" || toolName === "write") && inPath !== undefined) {
      if (isProtectedWrite(root, inPath)) {
        if (ctx.hasUI) ctx.ui.notify(`Blocked write to protected path: ${inPath}`, "warning");
        return { block: true, reason: `Path "${inPath}" is protected` };
      }
    }

    // Bash.
    if (toolName === "bash") {
      const command = String(input.command ?? "");
      // Fast path: non-sandboxing modes skip AST escape analysis, but still
      // honor their explicit bash policy. YOLO remains silent because its
      // policy is `allow`; an unsandboxed `ask` mode must still prompt.
      if (!m.sandbox.enabled) {
        const gate = bashGate(decide(m, "bash", command), undefined, false, sandbox.ready);
        if (gate.kind === "block") return { block: true, reason: gate.reason };
        if (gate.kind === "prompt") {
          // Without an AST parse, scope a session grant to the exact command.
          if (!(await promptAllow(ctx, "bash", command, gate.title))) {
            return { block: true, reason: gate.reason };
          }
          if (gate.onApproveUnsandboxed) approvedUnsandboxed.add(event.toolCallId);
        }
        return undefined;
      }
      // Real AST when available: judge each (possibly nested) command against the
      // bash surface AND the cross-cutting path gate (joined string + each token,
      // see decideBashCommand), most-restrictive across the chain; detect
      // escapes/privilege.
      const analysis = await analyzeBash(command, root);
      let action: Action;
      if (analysis.commands.length > 0) {
        action = analysis.commands
          .map((c) => decideBashCommand(m, c.name, c.args) ?? "allow")
          .reduce<Action>((a, b) => mostRestrictive(a, b) ?? "allow", "allow");
      } else {
        action = decide(m, "bash", command);
      }
      const gate = bashGate(action, analysis.outsideReason, m.sandbox.enabled, sandbox.ready);
      if (gate.kind === "block") return { block: true, reason: gate.reason };
      if (gate.kind === "prompt") {
        // Session approvals are keyed on the extracted command names, and ALL
        // names in a chain must be granted for it to pass silently — "allow git
        // this session" must not cover `git status && curl ... | sh`. Granting
        // remembers every name in the chain. Without a parse (heuristic
        // fallback), the key is the exact command string.
        const names = [...new Set(analysis.commands.map((c) => c.name).filter(Boolean))];
        const keys = names.length > 0 ? names : [command];
        if (!(await promptAllow(ctx, "bash", keys, gate.title))) return { block: true, reason: gate.reason };
        if (gate.onApproveUnsandboxed) approvedUnsandboxed.add(event.toolCallId);
      }
      return undefined;
    }

    // File tools (read/edit/write/ls/grep/find).
    const surface = FILE_TOOL_SURFACE[toolName];
    if (surface && inPath !== undefined) {
      const path = inPath;
      const outside = isOutside(root, path);
      const action = decide(m, surface, path, { isOutside: outside });
      if (action === "deny") {
        // Friendly message for the Plan-mode "Markdown only" case (read-only mode).
        if ((surface === "edit" || surface === "write") && !m.sandbox.writable) {
          if (ctx.hasUI) ctx.ui.notify(`${m.label} allows editing Markdown files only: ${path}`, "warning");
          return { block: true, reason: `${m.label} allows editing Markdown files only` };
        }
        return { block: true, reason: `Path "${path}" is blocked by ${m.label}` };
      }
      if (action === "ask") {
        const title = outside ? `Outside project — allow ${toolName}? (${path})` : `Allow ${toolName}? (${path})`;
        const reason = outside ? "Access outside project blocked" : "blocked";
        if (!(await promptAllow(ctx, surface, path, title))) return { block: true, reason };
      }
      return undefined; // allow
    }

    // web_search.
    if (toolName === "web_search") {
      const action = decide(m, "web_search", String(input.query ?? "(empty)"));
      if (action === "deny") return { block: true, reason: `web search blocked by ${m.label}` };
      // Session approval is surface-wide ("allow web search this session").
      if (action === "ask" && !(await promptAllow(ctx, "web_search", "*", "Allow web search?"))) {
        return { block: true, reason: "web search blocked" };
      }
      return undefined;
    }

    // Custom / extension tools (incl. any MCP-as-tool): gate by tool name. An
    // unknown tool prompts first-use (allow once/session/forever/deny).
    if (!BUILTIN_HANDLED.has(toolName)) {
      const action = decide(m, "tool", toolName);
      if (action === "deny") return { block: true, reason: `Tool "${toolName}" blocked by ${m.label}` };
      if (
        action === "ask" &&
        !(await promptAllow(ctx, "tool", toolName, `Tool "${toolName}" — first use in ${m.label}; allow?`, learnForever(ctx, "tool", toolName)))
      ) {
        return { block: true, reason: "tool blocked" };
      }
    }

    return undefined;
  });
}

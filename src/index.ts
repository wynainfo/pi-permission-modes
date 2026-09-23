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
 *   awareness.ts    sandbox-boundary system-prompt section (injected each turn)
 *   network.ts      live network session state (grants, denies, open toggle)
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

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { askWithSession, SessionApprovals } from "./approvals.ts";
import { sandboxAwarenessPrompt } from "./awareness.ts";
import { bashExecPlan, bashGate } from "./bash-enforce.ts";
import { analyzeBash } from "./bash-parse.ts";
import {
  auditStaleDefaults,
  defaultsChangedSince,
  describeStale,
  extensionVersion,
  hasGlobalConfig,
  loadDefaultsHistory,
  readAuditState,
  writeAuditState,
} from "./config-audit.ts";
import {
  SCHEMA_URL,
  globalConfigFile,
  hasMode,
  isUnsafeDomain,
  loadModeConfig,
  loadStockDefaults,
  persistModeDomains,
  persistModeRule,
  profileToConfig,
  readGlobalConfigRaw,
  stockDefaultsFile,
} from "./config-load.ts";
import type { PermState } from "./modes.ts";
import { type NetAskResult, NetworkSession, isHostAllowed, normalizeDomain } from "./network.ts";
import { isOutside, isProtectedWrite, normalizeToolPath, sandboxAllowedRoots } from "./paths.ts";
import { decide, decideBashChain } from "./resolve.ts";
import { SandboxController, networkFiltered } from "./sandbox.ts";
import { ensureScratchDir, scratchBase, scratchBaseOverridden, scratchDirName, sweepScratchDirs, withScratchDir } from "./scratch.ts";
import {
  type Action,
  type ModeDef,
  PLAN_PROMPT_SENTINEL,
  type PermissionModeConfig,
  planModeSystemPrompt,
  type SandboxProfile,
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
const BUILTIN_HANDLED = new Set([
  "bash",
  "read",
  "edit",
  "write",
  "ls",
  "grep",
  "find",
  "web_search",
  "show_plan",
  "request_network_access", // prompts on its own — gating it would double-prompt
]);

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

  const currentMode = (): ModeDef => (hasMode(config.modes, modeName) ? config.modes[modeName] : config.modes[config.defaultMode]);

  // This session's scratch directory (scratch.ts), created at session_start.
  // The EFFECTIVE sandbox profile — what the runtime is initialized with, what
  // the bounds are computed from, what /sandbox shows — is the mode's profile
  // with the scratch dir appended to allowWrite, so it is always writable and
  // never prompts, whatever the config says about the shared base.
  let scratchDir: string | undefined;
  const effectiveSandbox = (m: ModeDef): SandboxProfile => withScratchDir(m.sandbox, scratchDir);

  const sandbox = new SandboxController();
  // toolCallIds the user explicitly approved to run OUTSIDE the sandbox.
  const approvedUnsandboxed = new Set<string>();
  // "Allow for session" memory, keyed per-mode.
  const approvals = new SessionApprovals();
  // Live network state: session domain grants/denies and the open toggle. The
  // sandbox-runtime proxy consults it (via net.decide) for every host outside
  // the allowlist, so changes apply instantly — no sandbox re-init.
  const net = new NetworkSession();
  // Latest UI-capable context, for prompts that fire OUTSIDE an event handler
  // (the network ask callback runs mid-bash, driven by the proxy).
  let uiCtx: ExtensionContext | undefined;

  /** Prompt the user about a blocked host (the connection waits meanwhile). */
  const askNetHost = async (host: string, port: number | undefined): Promise<NetAskResult> => {
    const ctx = uiCtx;
    if (!ctx?.hasUI || currentMode().sandbox.askOnBlockedHost === false) return "dismiss";
    const target = port !== undefined ? `${host}:${port}` : host;
    const choice = await ctx.ui.select(`Network: bash wants to reach ${target} (not in the allowlist) — allow?`, [
      "Allow for session",
      "Allow forever",
      "Deny",
    ]);
    if (choice === "Allow for session") return "allow-session";
    if (choice === "Allow forever") {
      try {
        const file = persistModeDomains(getAgentDir(), modeName, [host]);
        config = loadModeConfig(ctx.cwd, getAgentDir(), (m) => ctx.ui.notify(m, "warning"));
        ctx.ui.notify(`permission-mode: always allow ${host} in ${currentMode().label} — saved to ${file}`, "info");
      } catch (e) {
        ctx.ui.notify(`permission-mode: could not save domain: ${e}`, "error");
      }
      return "allow-forever";
    }
    if (choice === "Deny") return "deny";
    return "dismiss"; // dismissed prompt: deny this request, but don't remember
  };

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

  // Unsandboxed runs (YOLO, approved escapes, degraded) get TMPDIR pointed at
  // the scratch dir via the spawn hook; sandboxed runs get it from the runtime
  // (CLAUDE_TMPDIR, set at session_start). Windows tools read TEMP/TMP.
  const localBash = createBashTool(root, {
    spawnHook: (c) => {
      if (!scratchDir) return c;
      const env = { ...c.env, TMPDIR: scratchDir };
      if (process.platform === "win32") Object.assign(env, { TEMP: scratchDir, TMP: scratchDir });
      return { ...c, env };
    },
  });

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
  //
  // The base is pi's CURRENT active set, not every registered tool: the user's
  // own tool selection (`defaultTools` in settings, --exclude-tools) must stay
  // in force — the old "all tools minus hideTools" base silently re-enabled
  // grep/find/ls/powershell for everyone (#2). We remember what WE hid (a
  // subset of what was active at the time) so a mode switch restores exactly
  // that and nothing else, and we only call setActiveTools when the set
  // actually changes (this runs every turn).
  //
  // `hideTools` is honored literally — including our own `show_plan`, which
  // used to be exempt: a setup that never plans has no use for it, and a
  // config entry that is silently ignored is worse than one that works. The
  // loader warns when a mode with the Plan prompt hides it (see config-load).
  let hiddenByUs = new Set<string>();
  const applyToolVisibility = () => {
    const hide = new Set(currentMode().hideTools ?? []);
    const current = pi.getActiveTools();
    const base = [...new Set([...current, ...hiddenByUs])]; // active as it would be without our hiding
    const next = base.filter((n) => !hide.has(n));
    hiddenByUs = new Set(base.filter((n) => hide.has(n)));
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) pi.setActiveTools(next);
  };

  const setMode = async (name: string, ctx: ExtensionContext, persist = true, viaFallback = false) => {
    if (!hasMode(config.modes, name)) return;
    uiCtx = ctx;
    modeName = name;
    fallbackMode = viaFallback;
    // Forward to child pi processes (e.g. subagents) via inherited env. The child
    // adopts it on session_start unless an explicit --perm flag overrides. The
    // implicit headless fallback is NOT forwarded: a child with no explicit mode
    // derives the same safe fallback itself (and skips the systemPrompt too).
    if (!viaFallback) process.env.PI_PERMISSION_MODE = modeName;
    const m = currentMode();
    await sandbox.applyProfile(effectiveSandbox(m)); // re-init runtime if the profile changed
    applyToolVisibility();
    updateStatus(ctx, m, sandbox, net.open);
    ctx.ui.notify(`Permission mode: ${m.label}`, "info");
    if (persist) pi.appendEntry<PermState>("perm-mode", { mode: modeName });
  };

  /** The most restrictive built-in-style mode for a headless child without a
   * forwarded mode: a read-only sandboxed mode if any, else the default. */
  const safeChildMode = (): string => {
    // Search the cycle order first (deterministic), then every other mode: a
    // global config whose cycleOrder lists only YOLO must not make a headless
    // child start unsandboxed while Plan/Default still exist.
    const candidates = [...new Set([...config.cycleOrder, ...Object.keys(config.modes)])].filter((n) => hasMode(config.modes, n));
    const ro = candidates.find((n) => config.modes[n].sandbox.enabled && !config.modes[n].sandbox.writable);
    const sandboxed = candidates.find((n) => config.modes[n].sandbox.enabled);
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
      if (hasMode(config.modes, flag)) resolved = flag;
    }
    if (!resolved) {
      // An explicit --perm flag wins over the persisted entry (resume with a flag).
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === "perm-mode") {
          const data = entry.data as PermState | undefined;
          if (hasMode(config.modes, data?.mode)) resolved = data.mode;
        }
      }
    }
    if (!resolved) {
      const env = process.env.PI_PERMISSION_MODE;
      if (hasMode(config.modes, env)) resolved = env;
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
        // Scaffold an editable FULL copy of the stock defaults at the global
        // path, stamped with its provenance: every value in it overrides the
        // shipped default, and the audit (config-audit.ts) warns when one of
        // them falls behind a later version's default.
        const dest = globalConfigFile(getAgentDir());
        if (existsSync(dest)) {
          return ctx.ui.notify(`permission-mode: ${dest} already exists - edit it directly`, "warning");
        }
        try {
          const stock = JSON.parse(readFileSync(stockDefaultsFile(), "utf-8")) as Record<string, unknown>;
          const { $schema: _stockSchema, ...rest } = stock;
          const copy = {
            $schema: SCHEMA_URL, // the stock file's relative path would not resolve from the agent dir
            $comment:
              `Copied from the pi-permission-modes ${extensionVersion()} stock defaults by /perm init. ` +
              "Every value here overrides the shipped default; delete what you don't intend to change so " +
              "future default updates reach you. The extension warns at session start when a value here " +
              "still matches an outdated default; set \"acknowledgeDefaults\" to the version you reviewed " +
              "against to silence that until the defaults change again.",
            ...rest,
          };
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, `${JSON.stringify(copy, null, 2)}\n`);
          return ctx.ui.notify(`permission-mode: wrote ${dest} - edit it to customize your modes`, "info");
        } catch (e) {
          return ctx.ui.notify(`permission-mode: could not write ${dest}: ${e}`, "error");
        }
      }
      if (hasMode(config.modes, arg)) await setMode(arg, ctx);
      else await cycle(ctx);
    },
  });
  const networkEnforcing = () => sandbox.ready && networkFiltered(currentMode().sandbox);

  const toggleNetwork = async (ctx: ExtensionContext) => {
    uiCtx = ctx;
    if (!networkEnforcing()) {
      return ctx.ui.notify("permission-mode: network is not filtered in this mode/state — nothing to toggle", "info");
    }
    net.open = !net.open;
    updateStatus(ctx, currentMode(), sandbox, net.open);
    ctx.ui.notify(
      net.open
        ? "Network: OPEN for this session — domain filtering disabled (alt+n or /net restrict to re-enable)"
        : "Network: filtered — domain allowlist active",
      net.open ? "warning" : "info",
    );
  };

  pi.registerShortcut("alt+n", {
    description: "Toggle network filtering for this session (filtered <-> open)",
    handler: toggleNetwork,
  });

  pi.registerCommand("net", {
    description: "Network sandbox: /net [status|allow <domain…>|open|restrict|reset]",
    handler: async (args, ctx) => {
      uiCtx = ctx;
      const m = currentMode();
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "status").toLowerCase();
      if (sub === "open") {
        if (!net.open) return toggleNetwork(ctx);
        return ctx.ui.notify("permission-mode: network is already open for this session", "info");
      }
      if (sub === "restrict") {
        if (net.open) return toggleNetwork(ctx);
        return ctx.ui.notify("permission-mode: network filtering is already active", "info");
      }
      if (sub === "reset") {
        net.clear();
        updateStatus(ctx, m, sandbox, net.open);
        return ctx.ui.notify("permission-mode: cleared session network grants/denies; filtering restored", "info");
      }
      if (sub === "allow") {
        const domains = [...new Set(parts.slice(1).map(normalizeDomain).filter((d): d is string => d !== undefined))];
        const safe = domains.filter((d) => !isUnsafeDomain(d));
        if (safe.length === 0) {
          return ctx.ui.notify("permission-mode: usage: /net allow <domain> [domain…] — concrete hosts or *.sub wildcards", "warning");
        }
        net.grant(safe);
        const dropped = domains.length - safe.length;
        return ctx.ui.notify(
          `permission-mode: allowed for this session: ${safe.join(", ")}${dropped ? ` (${dropped} overly-broad pattern(s) rejected)` : ""}`,
          "info",
        );
      }
      // status (default)
      const state = !networkEnforcing()
        ? "OPEN — nothing filters in this mode/state"
        : net.open
          ? "OPEN for this session (/net restrict or alt+n to re-enable filtering)"
          : "filtered (alt+n or /net open to disable)";
      return ctx.ui.notify(
        [
          `Network (${m.label}): ${state}`,
          `Mode allowlist: ${m.sandbox.network?.allowedDomains?.join(", ") || "(none)"}`,
          `Session grants: ${net.grants().join(", ") || "(none)"}`,
          `Session denies: ${net.denies().join(", ") || "(none)"}`,
        ].join("\n"),
        "info",
      );
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
      const c = profileToConfig(effectiveSandbox(m));
      ctx.ui.notify(
        [
          `Sandbox: ACTIVE for ${m.label} (${m.sandbox.writable ? "project-writable" : "read-only"})`,
          "",
          `Scratch dir: ${scratchDir ?? "(none)"}`,
          `Network: ${net.open ? "OPEN for this session (alt+n)" : "filtered (alt+n)"}`,
          `Network allowed: ${c.network?.allowedDomains?.join(", ") || "(none)"}`,
          `Session grants: ${net.grants().join(", ") || "(none)"}`,
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
      if (m.sandbox.enabled && !approved && !plan.sandboxed) {
        // The gate allowed this call because the sandbox was ready; it isn't
        // any more (a failed profile switch, a re-init in flight). Never
        // degrade silently to an unsandboxed run: fail the call instead.
        throw new Error("permission-mode: the sandbox became unavailable after this command was approved; run it again");
      }
      const ops = plan.sandboxed ? sandbox.bashOps({ readOnly: plan.readOnly, keepWritable: scratchDir ? [scratchDir] : [] }) : null;
      if (!ops) return localBash.execute(id, params, signal, onUpdate);
      const sandboxed = createBashTool(root, { operations: ops });
      return sandboxed.execute(id, params, signal, onUpdate);
    },
  });

  // Plan Mode helper: render a written plan file to the user (display-only).
  pi.registerTool(await createShowPlanTool(root));

  // Model-initiated network grants: ask the user to allow domains outside the
  // sandbox allowlist (batch-capable, so one prompt covers an install that
  // needs several hosts). Grants land in the session state the ask callback
  // reads — no sandbox re-init. Available in every mode; when nothing filters
  // (YOLO, degraded, /net open) it says so instead of prompting.
  pi.registerTool({
    name: "request_network_access",
    label: "Request network access",
    promptSnippet: "Ask the user to allow bash network access to domains outside the sandbox allowlist",
    description:
      "Ask the user to allow bash network access to one or more domains outside the sandbox allowlist. " +
      "Use it when a blocked host stops you (downloads, installs, API troubleshooting), or to get every needed " +
      "domain approved up front before a command that hits several hosts. Accepts exact hosts (api.example.com) " +
      "and subdomain wildcards (*.example.com).",
    parameters: Type.Object({
      domains: Type.Array(Type.String({ description: "Domain or subdomain wildcard, e.g. api.example.com or *.example.com" }), {
        description: "The domains to request access to",
      }),
      reason: Type.String({ description: "One short line: why access is needed" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
      const { domains = [], reason = "" } = params as { domains?: string[]; reason?: string };
      const m = currentMode();
      if (!sandbox.ready || !networkFiltered(m.sandbox) || net.open) {
        return text("Network is not filtered right now - no grant needed, just run the command.");
      }
      const normalized = [...new Set(domains.map(normalizeDomain).filter((d): d is string => d !== undefined))];
      const rejected = normalized.filter(isUnsafeDomain);
      const modeList = m.sandbox.network?.allowedDomains ?? [];
      const covered = (d: string) =>
        modeList.includes(d) || net.grants().includes(d) || (!d.startsWith("*.") && (isHostAllowed(d, modeList) || net.isGranted(d)));
      const need = normalized.filter((d) => !isUnsafeDomain(d) && !covered(d));
      const rejectedNote = rejected.length ? ` Rejected as overly broad: ${rejected.join(", ")}.` : "";
      if (need.length === 0) {
        return text(
          rejected.length && normalized.length === rejected.length
            ? `No grantable domains.${rejectedNote} Use a concrete host or a *.sub wildcard.`
            : `Already allowed — just run the command.${rejectedNote}`,
        );
      }
      const pctx = ctx ?? uiCtx;
      if (!pctx?.hasUI) return text("Denied: no interactive user available to approve network access.");
      const choice = await pctx.ui.select(
        `Model requests network access to ${need.join(", ")} — ${reason.trim() || "no reason given"}. Allow?`,
        ["Allow for session", "Allow forever", "Deny"],
      );
      if (choice !== "Allow for session" && choice !== "Allow forever") {
        return text(
          `Denied by the user: ${need.join(", ")}. Don't retry these hosts — work within the allowlist or ask the user how to proceed.${rejectedNote}`,
        );
      }
      net.grant(need);
      let saved = "";
      if (choice === "Allow forever") {
        try {
          const file = persistModeDomains(getAgentDir(), modeName, need);
          config = loadModeConfig(pctx.cwd, getAgentDir(), (msg) => pctx.ui.notify(msg, "warning"));
          saved = ` (saved permanently for ${currentMode().label})`;
          pctx.ui.notify(`permission-mode: always allow ${need.join(", ")} in ${currentMode().label} — saved to ${file}`, "info");
        } catch (e) {
          pctx.ui.notify(`permission-mode: could not save domains: ${e}`, "error");
        }
      }
      return text(`Granted${saved}: ${need.join(", ")}. Retry the blocked command now.${rejectedNote}`);
    },
  });

  /**
   * Defaults audit (config-audit.ts): warn about global-config values that
   * still hold an outdated default, and - once per version change - tell
   * users with a global config which defaults changed. Never throws.
   */
  const auditGlobalConfig = (ctx: ExtensionContext) => {
    const agentDir = getAgentDir();
    const warn = (m: string) => (ctx.hasUI ? ctx.ui.notify(m, "warning") : console.error(m));
    const current = { version: extensionVersion(), defaults: loadStockDefaults() };
    const history = loadDefaultsHistory();
    const state = readAuditState(agentDir);
    try {
      if (hasGlobalConfig(agentDir)) {
        const raw = readGlobalConfigRaw(agentDir);
        if (raw) {
          const ack = typeof raw.acknowledgeDefaults === "string" ? raw.acknowledgeDefaults : undefined;
          const stale = auditStaleDefaults(raw, current, history, ack);
          if (stale.length > 0) {
            warn(
              [
                `permission-mode: ${stale.length} value(s) in ${globalConfigFile(agentDir)} still hold an outdated default:`,
                ...stale.map((f) => `  - ${describeStale(f)}`),
                `Update them, or set "acknowledgeDefaults": "${current.version}" to keep them knowingly.`,
              ].join("\n"),
            );
          }
        }
        if (state.lastVersion && state.lastVersion !== current.version) {
          const changed = defaultsChangedSince(state.lastVersion, current, history);
          if (changed.length > 0) {
            warn(
              `permission-mode: updated ${state.lastVersion} -> ${current.version}; the stock defaults changed for ` +
                `${changed.join(", ")}. Compare your global config with ${stockDefaultsFile()} so you don't miss ` +
                "security or behavior improvements.",
            );
          }
        }
      }
    } finally {
      if (state.lastVersion !== current.version) writeAuditState(agentDir, { lastVersion: current.version });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx;
    const warn = (m: string) => (ctx.hasUI ? ctx.ui.notify(m, "warning") : console.error(m));
    try {
      config = loadModeConfig(ctx.cwd, getAgentDir(), warn);
    } catch (e) {
      // The loader guards its inputs; this is the last line of defense so a
      // config problem can never skip the sandbox init below.
      warn(`permission-mode: could not load configuration, keeping the previous one: ${e instanceof Error ? e.message : String(e)}`);
    }
    auditGlobalConfig(ctx);
    if (!hasMode(config.modes, modeName)) modeName = config.defaultMode;
    // Resolve the start mode BEFORE init so the sandbox initializes with the
    // right profile, then setMode reconciles status (applyProfile is a no-op).
    const picked = pickMode(ctx, true);
    modeName = picked.name;
    // Per-session scratch directory, created up front so the sandbox profile,
    // the bounds, and the awareness prompt all agree on it. Keyed on the
    // session id (a resumed session finds its files); stale siblings swept.
    const base = scratchBase();
    const dir = path.join(base, scratchDirName(ctx.sessionManager.getSessionId?.()));
    if (ensureScratchDir(dir, { sharedBase: !scratchBaseOverridden() })) {
      scratchDir = dir;
      process.env.CLAUDE_TMPDIR = dir; // the runtime points TMPDIR here inside sandboxed commands
      sweepScratchDirs(base, dir);
    } else {
      scratchDir = undefined;
      delete process.env.CLAUDE_TMPDIR;
      if (ctx.hasUI) ctx.ui.notify(`permission-mode: could not create the scratch directory ${dir}`, "warning");
    }
    await sandbox.init({
      cwd: ctx.cwd,
      noSandbox: pi.getFlag("no-sandbox") === true,
      hasUI: ctx.hasUI,
      notify: (m) => ctx.ui.notify(m, "warning"),
      profile: effectiveSandbox(currentMode()),
      // Live network gate: the proxy consults session state for every host
      // outside the allowlist; unknown hosts prompt via askNetHost.
      askHost: (host, port) => net.decide(host, port, askNetHost),
      drainBlockedHosts: () => net.drainBlocked(),
    });
    await setMode(picked.name, ctx, false, picked.fallback);
  });
  pi.on("session_tree", async (_event, ctx) => {
    uiCtx = ctx;
    const picked = pickMode(ctx, false);
    await setMode(picked.name, ctx, false, picked.fallback);
  });
  pi.on("session_shutdown", async () => {
    approvals.clearAll(); // session-scoped grants don't outlive the session
    net.clear(); // network grants/denies and the open toggle are session-scoped too
    await sandbox.reset();
  });

  // Drop any unconsumed escape grant once the tool call resolves.
  pi.on("tool_execution_end", async (event) => {
    approvedUnsandboxed.delete(event.toolCallId);
  });

  // Inject the sandbox-awareness section and the active mode's system prompt
  // (if any). The handler runs each turn and reads the live mode + sandbox
  // state, so it auto-updates when the mode changes. The "@plan" sentinel
  // resolves to the date-stamped Plan-mode prompt. A mode picked as the
  // implicit headless fallback keeps the FACTUAL awareness section (boundary
  // knowledge helps a worker avoid failing commands) but skips the mode's
  // STEERING systemPrompt, which would misdirect a headless worker.
  pi.on("before_agent_start", async (event) => {
    applyToolVisibility(); // keep hidden tools hidden as the tool set evolves
    const m = currentMode();
    const parts: string[] = [];
    const aware = sandboxAwarenessPrompt(m, {
      active: sandbox.ready && !sandbox.disabled,
      reason: sandbox.disabled ? "disabled via --no-sandbox" : sandbox.warn,
      networkOpen: net.open,
      sessionDomains: net.grants(),
      scratchDir,
    });
    if (aware) parts.push(aware);
    const sp = m.systemPrompt;
    if (sp && !fallbackMode) {
      parts.push(sp === PLAN_PROMPT_SENTINEL ? planModeSystemPrompt(new Date().toISOString().slice(0, 10)) : sp);
    }
    if (parts.length === 0) return undefined;
    return { systemPrompt: [event.systemPrompt, ...parts].join("\n\n") };
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
    uiCtx = ctx;
    const { toolName } = event;
    const m = currentMode();
    // `input` is a discriminated union across tools; view it loosely (custom
    // tools surface as Record<string, unknown> anyway) and guard each field.
    const input = event.input as Record<string, unknown>;
    // Judge the path pi will actually open: `~`, a leading `@`, and `file://`
    // are normalized by pi's file tools before the open (see normalizeToolPath).
    const inPath = typeof input.path === "string" ? normalizeToolPath(input.path) : undefined;
    if (inPath !== undefined && inPath.includes("\0")) {
      return { block: true, reason: "Path contains a NUL byte" };
    }
    // The mode's sandbox-writable dirs (/tmp, …) are in-bounds: a path the
    // sandbox already permits is not an escape, so it must neither prompt as
    // "outside project" nor — worse — run unsandboxed once the user approves.
    const bounds = sandboxAllowedRoots(root, effectiveSandbox(m));

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
      const analysis = await analyzeBash(command, root, bounds);
      // A command no layer matches falls back to "ask" (see decideBashChain).
      const action: Action =
        analysis.commands.length > 0 ? decideBashChain(m, analysis.commands) : decide(m, "bash", command);
      const gate = bashGate(action, analysis.outsideReason, m.sandbox.enabled, sandbox.ready);
      if (gate.kind === "block") return { block: true, reason: gate.reason };
      if (gate.kind === "prompt") {
        // Session approvals are keyed on the extracted command names, and ALL
        // names in a chain must be granted for it to pass silently - "allow git
        // this session" must not cover `git status && curl ... | sh`. Granting
        // remembers every name in the chain. Without a parse (heuristic
        // fallback), the key is the exact command string.
        //
        // An ESCAPE (out-of-project path, privilege escalation) is keyed on the
        // exact command string instead: it runs UNSANDBOXED once approved, so a
        // name-level grant earned by an in-project `cat README.md` must never
        // let `cat ~/.ssh/id_rsa` through silently, and an approved escape must
        // not cover a different one that merely shares its command name.
        const names = [...new Set(analysis.commands.map((c) => c.name).filter(Boolean))];
        const keys = analysis.outsideReason ? [`escape:${command}`] : names.length > 0 ? names : [command];
        if (!(await promptAllow(ctx, "bash", keys, gate.title))) return { block: true, reason: gate.reason };
        if (gate.onApproveUnsandboxed) approvedUnsandboxed.add(event.toolCallId);
      }
      return undefined;
    }

    // File tools (read/edit/write/ls/grep/find).
    const surface = FILE_TOOL_SURFACE[toolName];
    if (surface && inPath !== undefined) {
      const path = inPath;
      const outside = isOutside(root, path, bounds);
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

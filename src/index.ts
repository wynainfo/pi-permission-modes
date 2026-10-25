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

import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as piSdk from "@earendil-works/pi-coding-agent";
import { createBashTool, getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { effectiveShells } from "./config-load.ts";
import { type AdoptedRuntime, killWindowsTree, processViolations } from "./sandbox.ts";
import { type ExposeEntry, formatEntry, parseExpose, RELAY_FILE, RELAY_SOURCE, startRelays, withRelay } from "./shells/relay.ts";
import { describeShell, PROFILE_CHANGED_REASON, readLog, type ShellLaunchArgs, ShellManager, type ShellRecord, STOP_SIGNALS, type StopSignal, tailLines } from "./shells/shells.ts";
import { createShellTools } from "./shells/tools.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { docRef, docsDir, docsPromptBlock, piReferencePaths } from "./docs.ts";
import { withGitHubTokenHelper } from "./git-auth.ts";
import { askWithSession, BlockedPaths, deniedByUser, type DenyOption, SessionApprovals } from "./approvals.ts";
import { localBindingNote, sandboxAwarenessPrompt } from "./awareness.ts";
import { PROFILE_GRANT_QUESTION, profileExclusions, profileGrantText } from "./sandbox-win.ts";
import { type PromptParts, writePromptSections } from "./prompt-sections.ts";
import { bashExecPlan, bashGate, titleWithCommand } from "./bash-enforce.ts";
import { analyzeBash, escapeTargetFromReason, escapingPaths } from "./bash-parse.ts";
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
  globalConfigFile,
  hasMode,
  isUnsafeDomain,
  loadGlobalModeConfig,
  loadModeConfig,
  loadStockDefaults,
  persistModeDomains,
  persistModeRule,
  profileToConfig,
  readGlobalConfigRaw,
  SCHEMA_URL,
  stockDefaultsFile,
} from "./config-load.ts";
import type { PermState } from "./modes.ts";
import { isHostAllowed, NetworkSession, normalizeDomain, promptNote, type NetAskResult } from "./network.ts";
import { blockablePath, canonicalPath, displayPath, insideRoots, isOutside, isProtectedWrite, normalizeToolPath, resolvePlanPath, sandboxAllowedRoots } from "./paths.ts";
import {
  approvalMessage,
  DEFAULT_APPROVE_MODE,
  PLAN_ENTRY,
  type PendingPlan,
  type PlanEntry,
  planHash,
  restorePendingPlan,
  SAFE_PLAN_PATH,
  sessionBranch,
  showPlanSucceeded,
  shownPlanPath,
} from "./plan-approval.ts";
import { decideBashChainDetailed, decideDetailed } from "./resolve.ts";
import { SandboxController, commandFilesDir, networkFiltered, runtimeInstallDir, withDeniedReads } from "./sandbox.ts";
import { windowsReadGrants, withWindowsReads } from "./sandbox-win.ts";
import { ensureScratchDir, scratchBase, scratchBaseOverridden, scratchDirName, sweepScratchDirs, withScratchDir } from "./scratch.ts";
import {
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
  "bash_output", // read-only, scoped to this session's background shells
  "kill_shell", // the shell itself was gated when it started
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
  /** Windows: modes already told that their allowLocalBinding differs from the installed loopback mode (once per session). */
  const loopbackWarned = new Set<string>();
  const root = process.cwd();

  const currentMode = (): ModeDef => (hasMode(config.modes, modeName) ? config.modes[modeName] : config.modes[config.defaultMode]);

  // This session's scratch directory (scratch.ts), created at session_start.
  // The EFFECTIVE sandbox profile — what the runtime is initialized with, what
  // the bounds are computed from, what /sandbox shows — is the mode's profile
  // with the scratch dir appended to allowWrite, so it is always writable and
  // never prompts, whatever the config says about the shared base.
  let scratchDir: string | undefined;
  /** Background shells of this session (src/shells); created at session_start once the scratch dir exists. */
  let shells: ShellManager | undefined;
  const shellsCfg = () => effectiveShells(config.shells);
  const shellsRunning = () => shells?.running().length ?? 0;
  /** Ports the user agreed to expose on every interface (bash `expose: ["0.0.0.0:N"]`), once per port and session. */
  const lanPortsAllowed = new Set<number>();
  /** Violation lines already copied into a shell's violations.log (the runtime's store is a ring of 100). */
  let shellViolationsSeen = new Map<string, Set<string>>();
  /**
   * Handoff across a `/reload`: pi re-imports this module in the same process
   * (the old instance's `pi` and `ctx` go stale, the children keep running),
   * and `globalThis` is the only state that survives. With background shells
   * running, session_shutdown parks the initialized runtime and the
   * ShellManager here instead of resetting and stopping; the next
   * session_start adopts them (same project) or cleans them up.
   */
  interface Handoff {
    cwd: string;
    runtime: AdoptedRuntime | undefined;
    shells: ShellManager;
    violationsSeen: Map<string, Set<string>>;
  }
  const HANDOFF_KEY = "__piPermissionModeShells";
  const handoffStore = globalThis as unknown as Record<string, Handoff | undefined>;
  const takeHandoff = async (cwd: string): Promise<Handoff | undefined> => {
    const h = handoffStore[HANDOFF_KEY];
    if (!h) return undefined;
    delete handoffStore[HANDOFF_KEY];
    if (h.cwd === cwd && h.shells.running().length > 0) return h;
    // Nothing left to keep: end what the previous instance left behind.
    await h.shells.stopAll("session ended");
    try {
      await h.runtime?.manager.reset();
    } catch {
      // ignore cleanup errors
    }
    return undefined;
  };
  const harvestShellViolations = () => {
    const m = sandbox.sandboxManager;
    if (!shells || !m?.annotateStderrWithSandboxFailures) return;
    for (const r of shells.running()) {
      if (!r.sandboxed || !r.commandId) continue;
      let raw = "";
      try {
        raw = m.annotateStderrWithSandboxFailures(r.commandId, "");
      } catch {
        continue;
      }
      const seen = shellViolationsSeen.get(r.id) ?? new Set<string>();
      shellViolationsSeen.set(r.id, seen);
      for (const line of processViolations(raw).block.split("\n")) {
        const l = line.trim();
        if (!l || l.startsWith("<") || seen.has(l)) continue;
        seen.add(l);
        shells.recordViolation(r.commandId, l);
      }
    }
  };
  // Paths the user blocked for the session ("Deny and block"): folded into the
  // effective profile's denyRead so the OS sandbox masks them for bash, and
  // checked directly for the (unsandboxed) file tools.
  const blocked = new BlockedPaths();
  // What the runtime is initialized with: the mode's profile plus the scratch
  // dir. The session's "Deny and block" paths are NOT part of it - they ride
  // along per command (sandbox.bashOps extraDenyRead), so a block never
  // restarts the runtime or its network proxy.
  // On Windows the sandbox account reads only what the profile grants: the
  // stock profiles get the per-user tool roots that exist on this machine
  // (sandbox-win.ts, WINDOWS_TOOL_ROOTS) unless the mode sets allowRead itself.
  const winGrants = process.platform === "win32" ? windowsReadGrants() : [];
  // pi's docs, examples and README: read-only in-bounds, see the tool_call gate.
  const piReference = piReferencePaths(piSdk as unknown as Record<string, unknown>);
  const platformProfile = (p: SandboxProfile): SandboxProfile => (process.platform === "win32" ? withWindowsReads(p, winGrants) : p);
  const runtimeProfile = (m: ModeDef): SandboxProfile => withScratchDir(platformProfile(m.sandbox), scratchDir);
  // What bash effectively runs under, for the bounds, the awareness prompt, and /sandbox.
  const effectiveSandbox = (m: ModeDef): SandboxProfile => withDeniedReads(runtimeProfile(m), blocked.list());

  const sandbox = new SandboxController();
  // toolCallIds the user explicitly approved to run OUTSIDE the sandbox.
  const approvedUnsandboxed = new Set<string>();
  // "Allow for session" memory, keyed per-mode.
  const approvals = new SessionApprovals();
  // One-step plan approval (plan-approval.ts): the plan show_plan rendered
  // last is offered for approval when the agent goes idle (A), confirmed on a
  // manual switch into the approve mode (B), and taken by /plan approve (C).
  // Persisted as perm-plan entries; restored on session_start/session_tree.
  let pendingPlan: PendingPlan | undefined;
  let planShownThisRun = false; // a show_plan succeeded during the current agent run
  let planPrompting = false; // one approval prompt at a time
  let approvingPlan = false; // setMode called by approvePlan must not ask B
  let approveModeWarned = false;
  const planCalls = new Map<string, string>(); // show_plan toolCallId -> requested path
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
    // The prompt lives as long as a sandboxed command does: when the command
    // that opened the connection has ended (or timed out), the answer has
    // nothing to apply to, so the prompt is dismissed (denied, not remembered).
    const gone = new AbortController();
    void sandbox.idle().then(() => gone.abort());
    const choice = await ctx.ui.select(`Network: bash wants to reach ${target} (not in the allowlist) - allow?`, [
      "Allow for session",
      "Allow forever",
      "Deny",
    ], { signal: gone.signal });
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
    denyAnd?: DenyOption,
  ): Promise<boolean> =>
    askWithSession(
      { hasUI: ctx.hasUI, select: (t, o) => ctx.ui.select(t, o) },
      approvals,
      modeName,
      surface,
      target,
      title,
      onForever,
      denyAnd,
    );

  /**
   * The "Deny and block … for this session" option for an escape prompt, or
   * undefined when none of the escaping paths may be blocked (see
   * blockablePath). Choosing it records the paths and re-applies the sandbox
   * profile so the runtime masks them at once.
   */
  const denyAndBlock = (ctx: ExtensionContext, targets: readonly string[]): DenyOption | undefined => {
    const m = currentMode();
    const eff = effectiveSandbox(m);
    const eligible = [
      ...new Set(
        targets
          .map((t) =>
            blockablePath(root, t, {
              alsoInside: eff.allowWrite ?? [],
              denyRead: eff.denyRead ?? [],
              allowRead: eff.allowRead ?? [],
              // What the sandbox itself needs to run: never maskable.
              protectedDirs: [path.dirname(process.execPath), runtimeInstallDir(), commandFilesDir()].filter((d): d is string => !!d),
            }),
          )
          .filter((t): t is string => t !== undefined && !blocked.covers(t)),
      ),
    ];
    if (eligible.length === 0) return undefined;
    const shown = eligible.map(displayPath).join(", ");
    return {
      label: `Deny and block ${shown} for this session`,
      run: async () => {
        for (const t of eligible) blocked.add(t);
        updateStatus(ctx, currentMode(), sandbox, net.open, { shellsRunning: shellsRunning() });
        ctx.ui.notify(
          `permission-mode: ${shown} ${eligible.length === 1 ? "is" : "are"} now unreadable inside the sandbox for this session (/perm blocks to list, /perm unblock <path> to lift)`,
          "info",
        );
      },
    };
  };

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
  // (CLAUDE_CODE_TMPDIR, set at session_start). Windows tools read TEMP/TMP.
  /** The environment of an unsandboxed run: a GitHub token in pi's environment serves git here as in the sandbox (git-auth.ts); TMPDIR is the scratch dir. */
  const hostRunEnv = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = withGitHubTokenHelper({ ...base });
    if (scratchDir) {
      env.TMPDIR = scratchDir;
      if (process.platform === "win32") Object.assign(env, { TEMP: scratchDir, TMP: scratchDir });
    }
    return env;
  };
  const localBash = createBashTool(root, { spawnHook: (c) => ({ ...c, env: hostRunEnv(c.env) }) });

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

  /** A note to the model about its background shells (respects `shells.notify: none`), in the next turn. */
  const sendShellNote = (content: string): void => {
    if (shellsCfg().notify === "none") return;
    try {
      pi.sendMessage({ customType: "perm-shell", content, display: true }, { deliverAs: "nextTurn" });
    } catch {
      // a stale pi after /reload
    }
  };

  /**
   * A sandbox restart while background shells run would strip their mounts
   * and their network, so they end first: after the user agreed (`what`
   * names the action; a No keeps everything as it is), or without asking
   * when there is no UI. True when the caller may go on.
   */
  const stopShellsForRestart = async (ctx: ExtensionContext, what: string): Promise<boolean> => {
    const n = shellsRunning();
    if (!shells || n === 0) return true;
    if (ctx.hasUI) {
      const yes = await ctx.ui.confirm(
        "Background shells",
        `${n} background shell(s) run under the current sandbox profile; ${what} restarts the sandbox and stops them. Go on?`,
      );
      if (!yes) return false;
    }
    const stopped = await shells.stopAll(PROFILE_CHANGED_REASON);
    const ids = stopped.map((r) => r.id).join(", ");
    if (ctx.hasUI) ctx.ui.notify(`permission-mode: ${stopped.length} background shell(s) stopped (${PROFILE_CHANGED_REASON}): ${ids}`, "info");
    sendShellNote(`Background shell(s) ${ids} stopped: ${PROFILE_CHANGED_REASON} (${what}).`);
    return true;
  };

  const setMode = async (name: string, ctx: ExtensionContext, persist = true, viaFallback = false) => {
    if (!hasMode(config.modes, name)) return;
    uiCtx = ctx;
    // A switch whose profile needs a runtime restart (Windows: any change;
    // elsewhere: between a filtered and an unfiltered network) ends the
    // running background shells: asked first, and a No keeps the mode.
    if (name !== modeName && shellsRunning() > 0 && sandbox.switchNeedsRestart(runtimeProfile(config.modes[name]))) {
      if (!(await stopShellsForRestart(ctx, `switching to ${config.modes[name].label}`))) {
        ctx.ui.notify(`Permission mode stays ${currentMode().label}: ${shellsRunning()} background shell(s) keep running (/shells stop all or kill_shell first)`, "info");
        return;
      }
    }
    const previous = modeName;
    modeName = name;
    fallbackMode = viaFallback;
    // Forward to child pi processes (e.g. subagents) via inherited env. The child
    // adopts it on session_start unless an explicit --perm flag overrides. The
    // implicit headless fallback is NOT forwarded: a child with no explicit mode
    // derives the same safe fallback itself (and skips the systemPrompt too).
    if (!viaFallback) process.env.PI_PERMISSION_MODE = modeName;
    const m = currentMode();
    applyToolVisibility();
    // The runtime re-initializes when the profile changed, which can take a
    // moment (on Windows it re-stamps permission entries over the project
    // tree): the footer changes at once and marks the switch in flight, then
    // settles when it has landed. Cycling past a mode skips its switch (the
    // controller drops superseded requests). Bash in the meantime is refused
    // with "run it again" rather than run under the previous profile.
    const applied = sandbox.applyProfile(runtimeProfile(m)).catch(() => {});
    // Windows: a mode whose allowLocalBinding differs from the installed
    // loopback mode is told so, once per mode and session, at the switch.
    const conflict = sandbox.loopbackConflict(m.sandbox, m.label);
    if (conflict && ctx.hasUI && !loopbackWarned.has(name)) {
      loopbackWarned.add(name);
      ctx.ui.notify(conflict, "warning");
    }
    updateStatus(ctx, m, sandbox, net.open, { shellsRunning: shellsRunning() });
    ctx.ui.notify(`Permission mode: ${m.label}`, "info");
    void applied.then(() => {
      if (modeName === name) updateStatus(ctx, currentMode(), sandbox, net.open, { shellsRunning: shellsRunning() });
    });
    if (persist) pi.appendEntry<PermState>("perm-mode", { mode: modeName });
    // B: a manual switch into the approve mode while a plan is pending (alt+m,
    // /perm <mode>). Not on session_start/resume (persist=false) and not for
    // the switch approvePlan itself performs.
    if (persist && pendingPlan && !approvingPlan && ctx.hasUI && name !== previous && name === approveModeName()) {
      const plan = pendingPlan;
      const yes = await ctx.ui.confirm(
        `Implement ${plan.path} now?`,
        `Yes sends the approval message to the model. No leaves you in ${m.label} with nothing sent (/plan approve later).`,
      );
      if (yes) await approvePlan(ctx);
    }
  };

  const approveModeName = (): string => config.plan?.approveMode ?? DEFAULT_APPROVE_MODE;

  /** The approve mode's definition, or undefined (with a one-time warning) when the config names a mode that does not exist. */
  const approveModeDef = (ctx: ExtensionContext): ModeDef | undefined => {
    const target = approveModeName();
    if (hasMode(config.modes, target)) return config.modes[target];
    if (!approveModeWarned) {
      approveModeWarned = true;
      ctx.ui.notify(`permission-mode: plan.approveMode "${target}" is not a defined mode; plan approval is off until it is fixed`, "warning");
    }
    return undefined;
  };

  /**
   * Approve the pending plan: switch to the approve mode when not already
   * there, forget the plan (also in the session), and send the approval as a
   * real user message so a new turn starts under that mode's system prompt.
   */
  const approvePlan = async (ctx: ExtensionContext): Promise<boolean> => {
    const plan = pendingPlan;
    if (!plan || !approveModeDef(ctx)) return false;
    // Approval covers what the user saw: a plan file edited after show_plan
    // rendered it (by the model in the same run, say) is not approved blindly.
    if (plan.sha && planHash(root, plan.path) !== plan.sha) {
      ctx.ui.notify(`permission-mode: ${plan.path} changed since it was shown; ask for show_plan again before approving`, "warning");
      return false;
    }
    const target = approveModeName();
    approvingPlan = true;
    try {
      if (modeName !== target) {
        await setMode(target, ctx);
        await sandbox.settled(); // the model starts building right away: the profile must have landed
      }
    } finally {
      approvingPlan = false;
    }
    pendingPlan = undefined;
    pi.appendEntry<PlanEntry>(PLAN_ENTRY, {});
    // agent_end fires while the run still counts as streaming (it settles
    // after its listeners), and a plain send throws then. A follow-up is
    // queued behind the finishing run and pi starts a fresh run for it; when
    // the agent is idle (B via alt+m, /plan approve) it is sent right away.
    pi.sendUserMessage(approvalMessage(config.plan?.approveMessage, plan.path), { deliverAs: "followUp" });
    return true;
  };

  /** A: offer the plan shown during the run that just ended. Decline keeps it pending for B and C. */
  const offerPlanApproval = async (ctx: ExtensionContext): Promise<void> => {
    const plan = pendingPlan;
    if (!plan || plan.declined || planPrompting || !ctx.hasUI) return;
    const target = approveModeDef(ctx);
    if (!target) return;
    planPrompting = true;
    try {
      const accept = `Accept: switch to ${target.label} and implement it`;
      const decline = `Decline: keep refining in ${currentMode().label}`;
      const choice = await ctx.ui.select(`Plan ready: ${plan.path}`, [accept, decline]);
      if (choice === accept) await approvePlan(ctx);
      else plan.declined = true;
    } finally {
      planPrompting = false;
    }
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

  /** The mode the session's last perm-mode entry records, if it is still defined. */
  const persistedMode = (ctx: ExtensionContext): string | undefined => {
    let found: string | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "perm-mode") {
        const data = entry.data as PermState | undefined;
        if (hasMode(config.modes, data?.mode)) found = data.mode;
      }
    }
    return found;
  };

  /**
   * Resolve which mode to start in. With `carry` (a session replaced inside
   * the same pi process: /new, /resume, /fork, /reload) the mode the user last
   * had stays: setMode exported it to PI_PERMISSION_MODE, which outlives the
   * extension runtime pi rebuilds for the new session. Otherwise:
   *   1. explicit --perm flag, then 2. persisted session entry (resume),
   *   3. PI_PERMISSION_MODE env (forwarded from a parent / user-set),
   *   4. headless child with none of the above → most restrictive (never YOLO),
   *      flagged as `fallback` (policy applies, systemPrompt is not injected),
   *   5. the current mode: config.defaultMode at session_start (rebased
   *      there after the config loads), the mode in effect on session_tree.
   */
  const pickMode = (ctx: ExtensionContext, useFlag: boolean, carry = false): { name: string; fallback: boolean } => {
    let resolved: string | undefined;
    if (carry) {
      const env = process.env.PI_PERMISSION_MODE;
      if (hasMode(config.modes, env)) return { name: env, fallback: false };
    }
    if (useFlag) {
      const flag = String(pi.getFlag("perm") ?? "").toLowerCase();
      if (hasMode(config.modes, flag)) resolved = flag;
    }
    // An explicit --perm flag wins over the persisted entry (resume with a flag).
    if (!resolved) resolved = persistedMode(ctx);
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
    description: `Set or cycle permission mode: /perm [${config.cycleOrder.join("|")}|init|clear-approvals|blocks|unblock <path>]`,
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "clear-approvals") {
        approvals.clearAll();
        const hadBlocks = blocked.list().length > 0;
        blocked.clear();
        return ctx.ui.notify(`permission-mode: cleared session approvals${hadBlocks ? " and blocked paths" : ""}`, "info");
      }
      if (arg === "blocks") {
        const list = blocked.list();
        return ctx.ui.notify(
          list.length ? `permission-mode: blocked for this session:\n${list.map((b) => `  - ${displayPath(b)}`).join("\n")}` : "permission-mode: no paths blocked for this session",
          "info",
        );
      }
      if (arg === "unblock" || arg.startsWith("unblock ")) {
        const raw = args.trim().slice("unblock".length).trim();
        if (!raw) return ctx.ui.notify("permission-mode: usage: /perm unblock <path>", "warning");
        const target = canonicalPath(root, normalizeToolPath(raw));
        if (!blocked.remove(target)) return ctx.ui.notify(`permission-mode: ${displayPath(target)} is not blocked (see /perm blocks)`, "warning");
        return ctx.ui.notify(`permission-mode: ${displayPath(target)} is readable again for this session`, "info");
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
      else if (arg === "") await cycle(ctx);
      else ctx.ui.notify(`permission-mode: unknown mode or subcommand "${arg}"; usage: /perm [${config.cycleOrder.join("|")}|init|clear-approvals|blocks|unblock <path>]`, "warning");
    },
  });
  const networkEnforcing = () => sandbox.ready && networkFiltered(currentMode().sandbox);

  const toggleNetwork = async (ctx: ExtensionContext) => {
    uiCtx = ctx;
    if (!networkEnforcing()) {
      return ctx.ui.notify("permission-mode: network is not filtered in this mode/state — nothing to toggle", "info");
    }
    net.open = !net.open;
    updateStatus(ctx, currentMode(), sandbox, net.open, { shellsRunning: shellsRunning() });
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

  pi.registerCommand("plan", {
    description: "Plan approval: /plan approve (switch to the approve mode and implement the pending plan) | /plan status",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "approve") {
        if (!pendingPlan) return ctx.ui.notify("permission-mode: no plan pending (show_plan has not rendered one in this session)", "warning");
        await approvePlan(ctx);
        return;
      }
      if (arg === "" || arg === "status") {
        return ctx.ui.notify(
          pendingPlan ? `permission-mode: pending plan: ${pendingPlan.path} (/plan approve to implement it)` : "permission-mode: no plan pending",
          "info",
        );
      }
      ctx.ui.notify("permission-mode: usage: /plan approve | status", "warning");
    },
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
        updateStatus(ctx, m, sandbox, net.open, { shellsRunning: shellsRunning() });
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
    description: "Show the active mode's sandbox status and configuration; /sandbox install|uninstall sets up the native Windows sandbox",
    handler: async (args, ctx) => {
      const m = currentMode();
      const sub = args.trim().toLowerCase();
      if (sub === "install" || sub === "uninstall") {
        if (process.platform !== "win32") {
          return ctx.ui.notify(`permission-mode: /sandbox ${sub} is for the native Windows sandbox; see ${docRef("sandboxUnavailable")} for this platform`, "info");
        }
        if (!(await stopShellsForRestart(ctx, `/sandbox ${sub}`))) return ctx.ui.notify(`permission-mode: /sandbox ${sub} not run; the background shells keep running`, "info");
        try {
          if (sub === "uninstall") {
            ctx.ui.notify("permission-mode: Windows sandbox uninstall (one UAC prompt)...", "info");
            ctx.ui.notify(`permission-mode: ${await sandbox.windowsSetup("uninstall")}`, "info");
          } else {
            // Loopback is an install-time mode: open unless every sandboxed
            // mode turns it off (a mode that differs is told at the switch).
            const sandboxed = Object.values(config.modes).filter((d) => d.sandbox.enabled);
            const allowLoopback = !(sandboxed.length > 0 && sandboxed.every((d) => d.sandbox.allowLocalBinding === false));
            const profileGrant = await ctx.ui.confirm(PROFILE_GRANT_QUESTION, profileGrantText());
            // The global config's denies inside the profile become exclusions
            // of the grant: recorded once, they cost no session anything.
            const profileExclude = profileExclusions(Object.values(loadGlobalModeConfig(getAgentDir()).modes).map((d) => d.sandbox));
            ctx.ui.notify(
              `permission-mode: Windows sandbox install (one UAC prompt${profileGrant ? ", then the profile read grant, which takes minutes the first time" : ""})...`,
              "info",
            );
            // The install, the profile grant and the first initialize take
            // minutes together, without a word from the runtime in between:
            // the footer shows the step in flight and the time spent.
            const started = Date.now();
            let stage = "install, waiting for the UAC prompt";
            const show = () => updateStatus(ctx, currentMode(), sandbox, net.open, { busy: `${stage}, ${Math.round((Date.now() - started) / 1000)} s` });
            const ticker = setInterval(show, 1000);
            const choices = {
              allowLoopback,
              profileGrant,
              profileExclude,
              onProgress: (line: string) => ctx.ui.notify(`permission-mode: ${line}`, "info"),
              onStage: (s: string) => {
                stage = s;
                show();
              },
            };
            let line: string;
            try {
              try {
                line = await sandbox.windowsSetup("install", choices);
              } catch (e) {
                if ((e as { code?: string }).code !== "install_config_conflict") throw e;
                clearInterval(ticker);
                const replace = await ctx.ui.confirm(
                  "Replace the existing sandbox install?",
                  `${e instanceof Error ? e.message : String(e)}\n\nYes installs again with loopback ${allowLoopback ? "open" : "closed"} (one more UAC prompt${profileGrant ? ", then the profile read grant, minutes the first time" : ""}); No leaves the install as it is.`,
                );
                if (!replace) return ctx.ui.notify("permission-mode: Windows sandbox install left as it is", "info");
                ctx.ui.notify("permission-mode: Windows sandbox install again, replacing the filter set (one more UAC prompt); the footer shows the step in flight...", "info");
                line = await sandbox.windowsSetup("install", { ...choices, force: true });
              }
            } finally {
              clearInterval(ticker);
              updateStatus(ctx, currentMode(), sandbox, net.open); // the busy text goes, whichever way the install ended
            }
            ctx.ui.notify(`permission-mode: ${line}`, sandbox.ready ? "info" : "warning");
          }
        } catch (e) {
          ctx.ui.notify(`permission-mode: Windows sandbox ${sub} failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        updateStatus(ctx, currentMode(), sandbox, net.open, { shellsRunning: shellsRunning() });
        return;
      }
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
          ...(sandbox.windowsStatus()
            ? [
                `Windows: commands run as srt-sandbox in ${sandbox.windowsStatus()!.bash}; helper ${sandbox.windowsStatus()!.srtWinPath}; self-check passed`,
                `Last initialize: ${((sandbox.lastInitMs ?? 0) / 1000).toFixed(1)} s` +
                  (sandbox.lastResetMs !== undefined ? `, last reset: ${(sandbox.lastResetMs / 1000).toFixed(1)} s` : "") +
                  " (a mode switch pays both; the write grant on the project is kept between sessions, a deny inside your profile the grant does not exclude costs seconds)",
                `Session init steps: ${
                  Object.entries(sandbox.initSteps)
                    .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`)
                    .join(", ") || "(none)"
                }`,
                sandbox.windowsStatus()!.profileRead === "granted"
                  ? `Profile reads: granted at install (your profile minus the credential stores${sandbox.windowsStatus()!.profileEnv.length ? `; env ${sandbox.windowsStatus()!.profileEnv.join(", ")}` : ""})`
                  : "Profile reads: absent (the project and the tool roots only; /sandbox install grants them)",
                ...(sandbox.windowsStatus()!.profileWarnings.length ? [`Profile grant warnings: ${sandbox.windowsStatus()!.profileWarnings.join(" ")}`] : []),
                ...(sandbox.windowsStatus()!.profileDenies.length
                  ? [`Profile denies not recorded with the grant (seconds each per initialize; /sandbox install records them): ${sandbox.windowsStatus()!.profileDenies.join(", ")}`]
                  : []),
              ]
            : []),
          ...(networkFiltered(m.sandbox)
            ? [`Network: ${net.open ? "OPEN for this session (alt+n)" : "filtered (alt+n)"}`, `Network allowed: ${c.network?.allowedDomains?.join(", ") || "(none)"}`]
            : ["Network: unrestricted in this mode (no allowlist configured)"]),
          `Session grants: ${net.grants().join(", ") || "(none)"}`,
          ...(sandbox.lastSwitch ? [`Last profile switch: ${sandbox.lastSwitch === "hot" ? "in place (updateConfig; running commands kept their sandbox)" : "runtime restart (reset + initialize)"}`] : []),
          ...(sandbox.pendingProfile ? [`Pending profile: the previous one stays in force until ${shellsRunning()} background shell(s) end (/shells stop all applies it now)`] : []),
          ...(sandbox.windowsStatus()
            ? [
                `Local binding: ${sandbox.windowsStatus()!.loopbackInstalled ? "on" : "off"}${localBindingNote(sandbox.windowsStatus()!.loopbackInstalled, process.platform)}` +
                  (sandbox.loopbackConflict(m.sandbox, m.label) ? `; this mode asks for ${c.network.allowLocalBinding ? "on" : "off"}, no effect until /sandbox install runs again` : ""),
              ]
            : [`Local binding: ${c.network.allowLocalBinding ? "on" : "off"}${localBindingNote(Boolean(c.network.allowLocalBinding), process.platform)}`]),
          ...(m.sandbox.macos || process.platform === "darwin"
            ? [`macOS options: enableWeakerNetworkIsolation ${c.enableWeakerNetworkIsolation ? "on" : "off"}${process.platform === "darwin" ? "" : " (macOS only, no effect here)"}`]
            : []),
          ...(m.sandbox.linux || process.platform === "linux"
            ? [
                `Linux options: allowNestedUserNamespaces ${c.allowNestedUserNamespaces ? "on" : "off"}${process.platform === "linux" ? "" : " (Linux only, no effect here)"}`,
              ]
            : []),
          `Deny read:  ${c.filesystem?.denyRead?.join(", ") || "(none)"}`,
          ...(c.filesystem.allowRead?.length
            ? [`Allow read: ${c.filesystem.allowRead.join(", ")} ${sandbox.windowsStatus() ? "(readable for the sandbox account, besides the project)" : "(inside the denied paths)"}`]
            : []),
          `Session blocks: ${blocked.list().map(displayPath).join(", ") || "(none)"}`,
          `Allow write: ${c.filesystem?.allowWrite?.join(", ") || "(none)"}`,
          ...(m.sandbox.insideRoots?.length ? [`Inside roots: ${m.sandbox.insideRoots.join(", ")} (bash escape heuristic only)`] : []),
          `Deny write:  ${c.filesystem?.denyWrite?.join(", ") || "(none)"}`,
          ...(sandbox.extras?.allowWrite.length ? [`Git dirs (worktree/submodule): writable ${sandbox.extras.allowWrite.join(", ")}; hooks and config denied`] : []),
          ...(sandbox.dependencyWarnings.length > 0 ? ["", `Runtime warnings: ${sandbox.dependencyWarnings.join("; ")}`] : []),
        ].join("\n"),
        "info",
      );
    },
  });

  // Replace built-in bash so the sandbox can wrap it. Sandboxing is recomputed at
  // run time from the active mode's profile: disabled (YOLO), approved escapes,
  // and the degraded fallback run unsandboxed; non-writable modes run read-only.
  // pi's own fields plus the background flag; the spread keeps fields pi adds later.
  const bashSchema = Type.Object({
    ...((localBash.parameters as unknown as { properties: Record<string, TSchema> }).properties),
    run_in_background: Type.Optional(
      Type.Boolean({
        description:
          "Run as a background shell that outlives this call (a dev server, a watcher, a long build): returns at once with an id; read it with bash_output, stop it with kill_shell. Same sandbox and prompts as a foreground call; timeout becomes its kill timer.",
      }),
    ),
    expose: Type.Optional(
      Type.Array(Type.Union([Type.Integer(), Type.String()]), {
        description:
          'With run_in_background on Linux: ports of a server the shell starts that this machine should reach. 8123 binds 127.0.0.1:8123 here and relays it to port 8123 inside the shell; "0.0.0.0:8123" answers on every interface (asks the user). Elsewhere a server in the shell is reachable directly and the list is only checked.',
      }),
    ),
  });
  pi.registerTool({
    ...localBash,
    parameters: bashSchema as unknown as typeof localBash.parameters,
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
      const ops = plan.sandboxed
        ? sandbox.bashOps({ readOnly: plan.readOnly, keepWritable: scratchDir ? [scratchDir] : [], extraDenyRead: blocked.list(), tmpdir: scratchDir })
        : null;
      const p = params as { command: string; timeout?: number; run_in_background?: boolean; expose?: unknown };
      if (p.run_in_background === true) return startBackgroundShell(p.command, p.timeout, p.expose, ops, m);
      if (p.expose !== undefined) {
        return { content: [{ type: "text" as const, text: "expose applies to a background shell only: pass run_in_background: true with it (a foreground command's server ends with the command)." }], details: {} };
      }
      if (!ops) return localBash.execute(id, params, signal, onUpdate);
      const sandboxed = createBashTool(root, { operations: ops });
      net.takePrompted(); // answers to an earlier command's prompts are not this one's
      const result = await sandboxed.execute(id, params, signal, onUpdate);
      // A prompt answered during the run is told to the model: it saw only a
      // connection that worked (or did not), never that a person decided it.
      const note = promptNote(net.takePrompted());
      if (note) {
        const content = [...(result.content ?? [])];
        const last = content.length ? content[content.length - 1] : undefined;
        if (last && last.type === "text") content[content.length - 1] = { ...last, text: `${last.text}\n${note}` };
        else content.push({ type: "text", text: note });
        return { ...result, content };
      }
      return result;
    },
  });

  /**
   * bash with run_in_background: start the shell (sandboxed through `ops`,
   * else on the host as bash itself would run) and answer within half a
   * second. Every refusal is a sentence; the command never runs in the
   * foreground instead.
   */
  async function startBackgroundShell(command: string, timeout: number | undefined, expose: unknown, ops: ReturnType<SandboxController["bashOps"]>, m: ModeDef) {
    const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
    if (!shells) return text("Background shells are not available in this session (no scratch directory); run the command in the foreground with a timeout.");
    if (!shellsCfg().enabled) return text("Background shells are disabled in this configuration (shells.enabled); run the command in the foreground with a timeout.");
    const refusal = shells.refusal();
    if (refusal) return text(refusal);
    // `expose`: on Linux a sandboxed shell has a loopback of its own, so the
    // ports are relayed (src/shells/relay.ts); everywhere else a server in
    // the shell is reachable as it binds, and the list is only checked.
    let relayEntries: ExposeEntry[] | undefined;
    let exposeNote = "";
    if (expose !== undefined) {
      const parsed = parseExpose(expose);
      if ("error" in parsed) return text(`Background shell not started: ${parsed.error}.`);
      const list = parsed.entries.map(formatEntry).join(", ");
      if (process.platform === "linux" && ops) {
        for (const e of parsed.entries) {
          if (e.loopback || lanPortsAllowed.has(e.port)) continue;
          const ok = uiCtx?.hasUI
            ? await uiCtx.ui.confirm("Expose on the network", `Port ${e.port} would answer on every interface of this machine (${e.host}) while the background shell runs. Allow?`)
            : false;
          if (!ok) {
            return text(
              `Background shell not started: exposing port ${e.port} on ${e.host} ${uiCtx?.hasUI ? "was refused by the user" : "needs the user's confirmation, which this session cannot ask for"}; pass ${e.port} alone for 127.0.0.1.`,
            );
          }
          lanPortsAllowed.add(e.port);
        }
        relayEntries = parsed.entries;
      } else if (process.platform === "darwin" && ops && m.sandbox.allowLocalBinding === false) {
        return text(`Background shell not started: this mode turns local binding off (sandbox.allowLocalBinding), so a server in the shell cannot listen and expose (${list}) has nothing to reach.`);
      } else {
        exposeNote = ` A server the shell starts is reachable from this machine as it binds (${ops ? "no relay is needed on this platform" : "the shell runs unsandboxed"}); expose (${list}) was checked only.`;
      }
    }
    const launch = ops
      ? async ({ command: cmd, cwd, logFd, dir }: ShellLaunchArgs) => {
          // The launch allowlist stays with the shell for its lifetime (sandbox.ts, ShellStartOptions).
          const allowedDomains = networkFiltered(m.sandbox) ? [...new Set([...(m.sandbox.network?.allowedDomains ?? []), ...net.grants()])] : undefined;
          if (!relayEntries) {
            const s = await ops.startShell(cmd, cwd, { logFd, env: process.env, allowedDomains });
            return { child: s.child, sandboxed: true, commandId: s.commandId, onClose: s.onClose };
          }
          const relayPath = path.join(dir, RELAY_FILE);
          writeFileSync(relayPath, RELAY_SOURCE, { mode: 0o600 });
          const s = await ops.startShell(withRelay(cmd, relayPath), cwd, { logFd, env: process.env, allowedDomains, ipc: true });
          try {
            const relays = await startRelays(s.child, relayEntries);
            return {
              child: s.child,
              sandboxed: true,
              commandId: s.commandId,
              ports: relays.bound,
              onClose: () => {
                relays.close();
                s.onClose();
              },
            };
          } catch (err) {
            // No listener, no shell: the process group goes, the runtime's cleanup runs once.
            try {
              if (s.child.pid) process.kill(-s.child.pid, "SIGKILL");
            } catch {
              // already gone
            }
            s.onClose();
            throw err;
          }
        }
      : async ({ command: cmd, cwd, logFd }: ShellLaunchArgs) => {
          const sh = getShellConfig();
          const child = spawn(sh.shell, [...sh.args, cmd], { cwd, env: hostRunEnv(process.env), detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", logFd, logFd] });
          child.unref();
          return { child, sandboxed: false };
        };
    const r = await shells.start(command, launch, { timeoutSeconds: timeout });
    if (r.status === "running") {
      return text(
        `Background shell ${r.id} started (pid ${r.pid}, log ${r.logFile}). It runs ${r.sandboxed ? "under the same sandbox as bash" : "unsandboxed, as bash does in this mode"}. ` +
          `Read it with bash_output (bash_id "${r.id}"), stop it with kill_shell; you will be told when it ends.` +
          (r.ports ? ` Reachable from this machine at ${r.ports.join(", ")} while it runs (relayed to the same port inside the shell; bind the server there to 127.0.0.1).` : exposeNote),
      );
    }
    const last = tailLines(readLog(r.logFile, 0).text, 20);
    return text(`Background shell ${r.id} ${describeShell(r)}.${last ? `\nOutput:\n${last}` : ""}`);
  }

  // The model's view of its background shells; the user's is /shells.
  for (const tool of createShellTools(() => shells, { onBeforeRead: harvestShellViolations })) pi.registerTool(tool);

  pi.registerCommand("shells", {
    description: "Background shells: list | stop <id|all> [TERM|INT|HUP|KILL] | logs <id> [lines] | clean",
    handler: async (args: string, ctx: ExtensionContext) => {
      uiCtx = ctx;
      const [sub, arg, extra] = args.trim().split(/\s+/);
      if (!shells) return ctx.ui.notify("permission-mode: background shells are not available in this session (no scratch directory)", "warning");
      if (!sub || sub === "list") {
        const rows = shells.list();
        if (rows.length === 0) return ctx.ui.notify("No background shells in this session. The model starts one with bash run_in_background: true.", "info");
        const now = Date.now();
        return ctx.ui.notify(
          ["Background shells:", ...rows.map((r) => `  ${r.id}  ${describeShell(r, now)}  ${r.command.replace(/\s+/g, " ").slice(0, 60)}${r.ports ? `  exposed ${r.ports.join(", ")}` : ""}  (${r.logFile})`)].join("\n"),
          "info",
        );
      }
      if (sub === "stop") {
        if (!arg) return ctx.ui.notify("Usage: /shells stop <id|all> [TERM|INT|HUP|KILL]", "warning");
        const signal = extra?.toUpperCase().replace(/^SIG/, "");
        if (signal !== undefined && !(STOP_SIGNALS as readonly string[]).includes(signal)) return ctx.ui.notify(`Unknown signal ${extra}; one of ${STOP_SIGNALS.join(", ")}`, "warning");
        const ids = arg === "all" ? shells.running().map((r) => r.id) : [arg];
        if (ids.length === 0) return ctx.ui.notify("No background shell is running.", "info");
        const results = await Promise.all(ids.map((id) => shells!.stop(id, { signal: signal as StopSignal | undefined, by: "/shells stop" })));
        updateStatus(ctx, currentMode(), sandbox, net.open, { shellsRunning: shellsRunning() });
        return ctx.ui.notify(results.join("\n"), "info");
      }
      if (sub === "logs") {
        const r = arg ? shells.get(arg) : undefined;
        if (!r) return ctx.ui.notify(`Usage: /shells logs <id> [lines]${arg ? ` (no background shell ${arg})` : ""}`, "warning");
        const n = Math.max(1, Math.min(500, Number(extra) || 40));
        const out = tailLines(readLog(r.logFile, 0).text, n);
        return ctx.ui.notify(`${r.id} ${describeShell(r)} (${r.logFile})\n${out || "(no output yet)"}`, "info");
      }
      if (sub === "clean") return ctx.ui.notify(`Removed ${shells.clean()} finished background shell folder(s).`, "info");
      return ctx.ui.notify("Usage: /shells [list | stop <id|all> [signal] | logs <id> [lines] | clean]", "warning");
    },
  });

  /** The completion notice (shells.notify): a turn of its own, a note for the next turn, or nothing. */
  function notifyShellEnd(shell: ShellRecord, lastLines: string): void {
    const mode = shellsCfg().notify;
    if (mode === "none") return;
    const content = `Background shell ${shell.id} (${shell.command.replace(/\s+/g, " ").slice(0, 80)}) ${describeShell(shell)}.${lastLines ? `\nLast output:\n${lastLines}` : ""}`;
    try {
      pi.sendMessage({ customType: "perm-shell", content, display: true }, mode === "wake" ? { triggerTurn: true, deliverAs: "followUp" } : { deliverAs: "nextTurn" });
    } catch {
      // a stale pi after /reload: the record and the log remain
    }
  }

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
                `Update them, or set "acknowledgeDefaults": "${current.version}" to keep them knowingly. See ${docRef("outdatedDefaults")}.`,
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
                `security or behavior improvements (see ${docRef("outdatedDefaults")}).`,
            );
          }
        }
      }
    } finally {
      if (state.lastVersion !== current.version) writeAuditState(agentDir, { lastVersion: current.version });
    }
  };

  pi.on("session_start", async (event, ctx) => {
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
    // Every session_start runs in a fresh extension runtime (startup, /new,
    // /resume, /fork, /reload), so modeName still holds the STOCK default here.
    // Rebase it onto the loaded config's defaultMode: otherwise pickMode's
    // last fallback would ignore a configured defaultMode whenever the stock
    // one ("default") is also a valid mode.
    modeName = config.defaultMode;
    // Resolve the start mode BEFORE init so the sandbox initializes with the
    // right profile, then setMode reconciles status (applyProfile is a no-op).
    // A fresh pi process (or a harness that sends no reason) resolves from
    // scratch; a session replaced inside the process keeps the current mode,
    // and the --perm flag only applies to the process start.
    const carry = event.reason !== undefined && event.reason !== "startup";
    const picked = pickMode(ctx, !carry, carry);
    modeName = picked.name;
    pendingPlan = restorePendingPlan(sessionBranch(ctx));
    planShownThisRun = false;
    planCalls.clear();
    // Per-session scratch directory, created up front so the sandbox profile,
    // the bounds, and the awareness prompt all agree on it. Keyed on the
    // session id (a resumed session finds its files); stale siblings swept.
    const base = scratchBase();
    const dir = path.join(base, scratchDirName(ctx.sessionManager.getSessionId?.()));
    if (ensureScratchDir(dir, { sharedBase: !scratchBaseOverridden() })) {
      scratchDir = dir;
      // The runtime points TMPDIR here inside sandboxed commands (it reads the
      // newer name first, the older one is kept for its 0.0.26-era behavior).
      process.env.CLAUDE_CODE_TMPDIR = dir;
      process.env.CLAUDE_TMPDIR = dir;
      sweepScratchDirs(base, dir);
    } else {
      scratchDir = undefined;
      delete process.env.CLAUDE_CODE_TMPDIR;
      delete process.env.CLAUDE_TMPDIR;
      if (ctx.hasUI) ctx.ui.notify(`permission-mode: could not create the scratch directory ${dir}`, "warning");
    }
    // A /reload with background shells running: the previous instance parked
    // its runtime and ShellManager (Handoff); the shells keep their sandbox.
    const handoff = await takeHandoff(ctx.cwd);
    await sandbox.init({
      cwd: ctx.cwd,
      noSandbox: pi.getFlag("no-sandbox") === true,
      hasUI: ctx.hasUI,
      notify: (m) => ctx.ui.notify(m, "warning"),
      profile: runtimeProfile(currentMode()),
      // Live network gate: the proxy consults session state for every host
      // outside the allowlist; unknown hosts prompt via askNetHost.
      askHost: (host, port) => net.decide(host, port, askNetHost),
      keepWritable: scratchDir ? [scratchDir] : [],
      adopt: handoff?.runtime,
      adoptedShells: handoff ? () => handoff.shells.running().length : undefined,
    });
    const shellHooks = {
      maxConcurrent: shellsCfg().maxConcurrent,
      killTree: killWindowsTree,
      notify: notifyShellEnd,
      onChange: () => {
        if (uiCtx) updateStatus(uiCtx, currentMode(), sandbox, net.open, { shellsRunning: shellsRunning() });
        // The last shell ended: a profile that waited for it (reload with a changed config) applies now.
        if (sandbox.pendingProfile && shellsRunning() === 0) {
          void sandbox.retryPending()?.then(() => {
            if (!uiCtx) return;
            updateStatus(uiCtx, currentMode(), sandbox, net.open, { shellsRunning: shellsRunning() });
            if (uiCtx.hasUI) uiCtx.ui.notify(`permission-mode: the sandbox profile of ${currentMode().label} is applied (the last background shell ended)`, "info");
          });
        }
      },
    };
    shellViolationsSeen = handoff?.violationsSeen ?? new Map();
    lanPortsAllowed.clear();
    shells = handoff
      ? handoff.shells.rebind(shellHooks)
      : scratchDir
        ? new ShellManager({ baseDir: path.join(scratchDir, "shells"), cwd: ctx.cwd, ...shellHooks })
        : undefined;
    if (handoff && ctx.hasUI) {
      const n = shellsRunning();
      ctx.ui.notify(
        sandbox.pendingProfile
          ? `permission-mode: ${n} background shell(s) kept across the reload; the sandbox profile they run under stays in force until they end (/shells stop all applies the new one now)`
          : `permission-mode: ${n} background shell(s) kept across the reload (/shells)`,
        "info",
      );
    }
    // Record the start mode when the session does not already end on it (a
    // carried mode, a --perm flag, a new session), so resuming it in a later
    // pi process restores the mode it was last used in. The headless fallback
    // is never recorded, like any implicit choice.
    const record = !picked.fallback && persistedMode(ctx) !== picked.name;
    await setMode(picked.name, ctx, record, picked.fallback);
  });
  pi.on("session_tree", async (_event, ctx) => {
    uiCtx = ctx;
    pendingPlan = restorePendingPlan(sessionBranch(ctx)); // the branch's own plan state
    planShownThisRun = false;
    planCalls.clear();
    const picked = pickMode(ctx, false);
    await setMode(picked.name, ctx, false, picked.fallback);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    approvals.clearAll(); // session-scoped grants don't outlive the session
    blocked.clear(); // nor do "Deny and block" paths
    net.clear(); // network grants/denies and the open toggle are session-scoped too
    pendingPlan = undefined; // restored from the session entries on the next start
    planCalls.clear();
    if (event.reason === "reload" && shells && shellsRunning() > 0) {
      // The next instance of this module adopts the shells and the runtime
      // they run under (Handoff); nothing is reset or stopped here.
      handoffStore[HANDOFF_KEY] = { cwd: ctx.cwd, runtime: await sandbox.handoff(), shells, violationsSeen: shellViolationsSeen };
      shells = undefined;
      return;
    }
    // Background shells end with the session: a reset would strip a running
    // shell's protections, so they go first (SIGTERM, SIGKILL after 5 s).
    if (shells) await shells.stopAll("session ended");
    await sandbox.reset();
  });

  // Plan approval (A): a show_plan that succeeded during this run is offered
  // once the agent is idle, so the plan is on screen and the accepting turn
  // starts under the approve mode's prompt, never under a Plan prompt still
  // in effect. Nothing is asked after the implementing run (no show_plan then).
  pi.on("agent_start", async () => {
    planShownThisRun = false;
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (!planShownThisRun) return;
    planShownThisRun = false;
    await offerPlanApproval(ctx);
  });

  // Drop any unconsumed escape grant once the tool call resolves; record a
  // rendered plan as pending (persisted, so resume and /reload keep it).
  pi.on("tool_execution_end", async (event) => {
    approvedUnsandboxed.delete(event.toolCallId);
    const requested = planCalls.get(event.toolCallId);
    if (requested === undefined) return;
    planCalls.delete(event.toolCallId);
    if (!showPlanSucceeded(event.isError, event.result)) return;
    // Only a plan shown in a planning mode (the "@plan" prompt) is offered:
    // elsewhere show_plan is plain display, and a model must not be able to
    // put "switch to Build" in front of the user from any mode it likes.
    if (currentMode().systemPrompt !== PLAN_PROMPT_SENTINEL) return;
    const planPath = shownPlanPath(event.result, requested);
    // The path ends up in a user-authored message: plain names only.
    if (!SAFE_PLAN_PATH.test(planPath)) return;
    const sha = planHash(root, planPath);
    pendingPlan = { path: planPath, declined: false, ...(sha ? { sha } : {}) };
    planShownThisRun = true;
    pi.appendEntry<PlanEntry>(PLAN_ENTRY, { path: planPath, ...(sha ? { sha } : {}) });
  });

  // The sandbox-awareness section, the docs pointer and the active mode's
  // system prompt (if any), written as pi prompt sections (prompt-sections.ts)
  // so a mode switch sends a patch instead of rewriting the request head. The
  // handler runs each turn and reads the live mode + sandbox state, so it
  // auto-updates when the mode changes; pi diffs the sections and sends
  // nothing when they are unchanged. The "@plan" sentinel resolves to the
  // date-stamped Plan-mode prompt. A mode picked as the implicit headless
  // fallback keeps the FACTUAL awareness section (boundary knowledge helps a
  // worker avoid failing commands) but skips the mode's STEERING systemPrompt,
  // which would misdirect a headless worker.
  pi.on("before_agent_start", async (event) => {
    applyToolVisibility(); // keep hidden tools hidden as the tool set evolves
    const m = currentMode();
    const parts: PromptParts = {};
    // The effective profile carries the session's blocked paths in denyRead,
    // so the model sees them under "Reads are broadly allowed EXCEPT".
    const aware = sandboxAwarenessPrompt({ ...m, sandbox: effectiveSandbox(m) }, {
      active: sandbox.ready && !sandbox.disabled,
      reason: sandbox.disabled ? "disabled via --no-sandbox" : sandbox.warn,
      networkOpen: net.open,
      sessionDomains: net.grants(),
      shells: shells !== undefined && shellsCfg().enabled,
      scratchDir,
      platform: process.platform,
      windowsLoopback: sandbox.windowsStatus()?.loopbackInstalled,
      windowsProfileRead: sandbox.windowsStatus()?.profileRead,
    });
    if (aware) parts.aware = aware;
    // Where the reference lives, in every mode: config questions arise in YOLO too.
    if (!fallbackMode) parts.docs = docsPromptBlock(docsDir());
    const sp = m.systemPrompt;
    if (sp && !fallbackMode) {
      parts.steering = sp === PLAN_PROMPT_SENTINEL ? planModeSystemPrompt(new Date().toISOString().slice(0, 10)) : sp;
    }
    return writePromptSections(event, parts);
  });

  // Skill gating: skills aren't tools — they're invoked via `/skill:<name>` text,
  // so intercept the input before expansion and resolve the `skill` surface.
  pi.on("input", async (event, ctx) => {
    const match = /^\/skill:([\w-]+)/.exec(event.text.trim());
    if (!match) return undefined;
    const name = match[1];
    const decision = decideDetailed(currentMode(), "skill", name);
    if (decision.action === "deny") {
      if (ctx.hasUI) ctx.ui.notify(`Skill "${name}" blocked in ${currentMode().label}${decision.reason ? `: ${decision.reason}` : ""}`, "warning");
      return { action: "handled" as const };
    }
    if (
      decision.action === "ask" &&
      !(await promptAllow(ctx, "skill", name, `Skill "${name}" — first use in ${currentMode().label}; allow?`, learnForever(ctx, "skill", name)))
    ) {
      if (ctx.hasUI && decision.reason) ctx.ui.notify(`Skill "${name}" blocked: ${decision.reason}`, "warning");
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
    if (toolName === "show_plan" && typeof input.path === "string") planCalls.set(event.toolCallId, resolvePlanPath(input.path));
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
    // Reference material the system prompt points at is read-only in-bounds:
    // our shipped docs, and pi's own docs, examples and README, which pi's
    // prompt names by absolute path. Reading them is not an escape (writing
    // to them still is: edit and write judge against `bounds`).
    const docBounds = [...bounds, docsDir(), ...piReference];
    // Bash only: the mode's insideRoots (remote paths named in ssh commands,
    // say) are not escapes, so the command runs sandboxed instead of prompting
    // and then running unsandboxed. File tools do not get them.
    const bashBounds = [...docBounds, ...insideRoots(root, m.sandbox)];

    // Hard backstop: never write to protected paths (file tools aren't sandboxed),
    // unless the mode explicitly trusts everything (YOLO). Matched lexically AND
    // on the symlink-resolved canonical path, so a link can't smuggle the write.
    if (!m.bypassProtectedPaths && (toolName === "edit" || toolName === "write") && inPath !== undefined) {
      if (isProtectedWrite(root, inPath)) {
        if (ctx.hasUI) ctx.ui.notify(`Blocked write to protected path: ${inPath}`, "warning");
        return { block: true, reason: `Path "${inPath}" is protected (see ${docRef("protectedPaths")})` };
      }
    }

    // Bash.
    if (toolName === "bash") {
      const command = String(input.command ?? "");
      // The prompt says what is about to start; the decision itself is the same.
      const background = (input as { run_in_background?: unknown }).run_in_background === true;
      const askTitle = (title: string) => titleWithCommand(background ? "Run in background?" : title, command);
      // Non-sandboxing modes judge the same per-command chain as sandboxed
      // ones (bash surface plus the path gate on every extracted command,
      // most restrictive across the chain): a whole-line match let
      // `cd x && sudo id` slip past `"sudo *"` and skipped the path gate
      // entirely. Only escape detection is dropped - there is no sandbox to
      // escape from. YOLO remains silent because its policy is `allow`; an
      // unsandboxed `ask` mode must still prompt.
      if (!m.sandbox.enabled) {
        const analysis = await analyzeBash(command, root, bashBounds);
        const decision =
          analysis.commands.length > 0 ? decideBashChainDetailed(m, analysis.commands) : decideDetailed(m, "bash", command);
        const gate = bashGate(decision.action, undefined, false, sandbox.ready, decision.reason);
        if (gate.kind === "block") return { block: true, reason: gate.reason };
        if (gate.kind === "prompt") {
          // Every approval here runs with full user rights, so a session grant
          // stays scoped to the exact command string, never to command names.
          if (!(await promptAllow(ctx, "bash", command, askTitle(gate.title)))) {
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
      const analysis = await analyzeBash(command, root, bashBounds);
      // A command no layer matches falls back to "ask" (see decideBashChain).
      const decision =
        analysis.commands.length > 0 ? decideBashChainDetailed(m, analysis.commands) : decideDetailed(m, "bash", command);
      const gate = bashGate(decision.action, analysis.outsideReason, m.sandbox.enabled, sandbox.ready, decision.reason);
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
        // Paths this command reaches outside the project (none for privilege
        // escalation). One already blocked this session: block outright, no
        // prompt. Otherwise the prompt offers "Deny and block".
        const targets = analysis.outsideReason?.startsWith("path outside project")
          ? analysis.usedFallback
            ? [escapeTargetFromReason(analysis.outsideReason, root)].filter((t): t is string => t !== undefined)
            : escapingPaths(analysis.commands, root, bashBounds)
          : [];
        const hit = targets.map((t) => canonicalPath(root, t)).find((t) => blocked.covers(t));
        if (hit) return { block: true, reason: `Path ${displayPath(hit)} is blocked for this session (Deny and block); /perm unblock lifts it; see ${docRef("denyAndBlock")}` };
        if (!(await promptAllow(ctx, "bash", keys, askTitle(gate.title), undefined, denyAndBlock(ctx, targets)))) return { block: true, reason: gate.reason };
        if (gate.onApproveUnsandboxed) approvedUnsandboxed.add(event.toolCallId);
      }
      return undefined;
    }

    // File tools (read/edit/write/ls/grep/find).
    const surface = FILE_TOOL_SURFACE[toolName];
    if (surface && inPath !== undefined) {
      const path = inPath;
      // A path blocked for the session ("Deny and block") is denied outright:
      // the file tools are not sandboxed, so the kernel mask alone would not cover them.
      if (blocked.covers(canonicalPath(root, path))) {
        return { block: true, reason: `Path "${path}" is blocked for this session (Deny and block); /perm unblock lifts it; see ${docRef("denyAndBlock")}` };
      }
      const outside = isOutside(root, path, surface === "edit" || surface === "write" ? bounds : docBounds);
      const decision = decideDetailed(m, surface, path, { isOutside: outside });
      if (decision.action === "deny") {
        // Friendly message for the Plan-mode "Markdown only" case (read-only mode).
        // It wins over a per-rule reason: in a read-only mode the mode constraint
        // is the pertinent explanation, and a pattern reason must not hide it.
        if ((surface === "edit" || surface === "write") && !m.sandbox.writable) {
          if (ctx.hasUI) ctx.ui.notify(`${m.label} allows editing Markdown files only: ${path}`, "warning");
          return { block: true, reason: `${m.label} allows editing Markdown files only` };
        }
        // Otherwise a per-rule reason wins: it tells the model what to do instead.
        if (decision.reason) return { block: true, reason: decision.reason };
        return { block: true, reason: `Path "${path}" is blocked by ${m.label} (see ${docRef("blockedByPolicy")})` };
      }
      if (decision.action === "ask") {
        const title = outside ? `Outside project - allow ${toolName}? (${path})` : `Allow ${toolName}? (${path})`;
        const reason = decision.reason ?? deniedByUser(outside ? `${toolName} of "${path}" outside the project` : `${toolName} of "${path}"`);
        const denyAnd = outside ? denyAndBlock(ctx, [path]) : undefined;
        if (!(await promptAllow(ctx, surface, path, title, undefined, denyAnd))) return { block: true, reason };
      }
      return undefined; // allow
    }

    // web_search.
    if (toolName === "web_search") {
      const decision = decideDetailed(m, "web_search", String(input.query ?? "(empty)"));
      if (decision.action === "deny") return { block: true, reason: decision.reason ?? `web search blocked by ${m.label} (see ${docRef("blockedByPolicy")})` };
      // Session approval is surface-wide ("allow web search this session").
      if (decision.action === "ask" && !(await promptAllow(ctx, "web_search", "*", "Allow web search?"))) {
        return { block: true, reason: decision.reason ?? deniedByUser("web search") };
      }
      return undefined;
    }

    // Custom / extension tools (incl. any MCP-as-tool): gate by tool name. An
    // unknown tool prompts first-use (allow once/session/forever/deny).
    if (!BUILTIN_HANDLED.has(toolName)) {
      const decision = decideDetailed(m, "tool", toolName);
      if (decision.action === "deny") return { block: true, reason: decision.reason ?? `Tool "${toolName}" blocked by ${m.label} (see ${docRef("toolsAndSkills")})` };
      if (
        decision.action === "ask" &&
        !(await promptAllow(ctx, "tool", toolName, `Tool "${toolName}" — first use in ${m.label}; allow?`, learnForever(ctx, "tool", toolName)))
      ) {
        return { block: true, reason: decision.reason ?? deniedByUser(`tool "${toolName}" call`) };
      }
    }

    return undefined;
  });
}

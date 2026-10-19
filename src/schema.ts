/**
 * Mode schema — the declarative vocabulary a permission mode is built from.
 *
 * A MODE is data: a named bundle of a sandbox profile, an allow/ask/deny
 * permission policy keyed by surface, plus UI metadata (label/color), an
 * optional system-prompt injection, and a hidden-tools list. The four built-in
 * modes ship in `permission-mode.defaults.json`; users override or extend them in
 * `permission-mode.json`.
 *
 * This module is pure and SDK-free (string-literal unions, not enums, for Node's
 * strip-only TS) so the resolution engine and loader can be unit-tested without
 * the host.
 */

import type { PlanApprovalConfig } from "./plan-approval.ts";

/** Three-state permission outcome (opencode-compatible semantics). */
export type Action = "allow" | "ask" | "deny";

/** Maximum length of a per-rule reason/message (loader truncates beyond this). */
export const MAX_RULE_REASON = 500;

/**
 * A single pattern-map entry: either a bare action, or an object carrying the
 * action plus an optional human-readable reason shown to the agent when the
 * rule blocks (deny) or when an ask is refused. A reason never loosens
 * anything, it only explains the decision; only the global config may set one.
 */
export interface PatternRuleObject {
  action: Action;
  reason?: string;
}

/** A pattern-map value: a bare action or an action-plus-reason object. */
export type PatternValue = Action | PatternRuleObject;

/** A glob pattern → action map. The `"*"` key is the universal fallback. */
export type PatternMap = Record<string, PatternValue>;

/** A surface value is either a shorthand action or a pattern-map. */
export type SurfaceValue = Action | PatternMap;

/**
 * The gateable surfaces.
 *   path                cross-cutting gate over ALL file access (incl. bash args);
 *                       a `path` deny overrides any per-tool allow.
 *   external_directory  the out-of-project (CWD-escape) boundary.
 *   read/write/edit/grep/find/ls   per-file-tool, matched against `input.path`.
 *   bash                per-command patterns, matched against each extracted
 *                       command name (+ path-like args via path/external_directory).
 *   web_search          the web_search tool.
 *   tool                generic surface for any non-builtin (extension) tool, by name.
 *   skill               skills, matched by skill name (gated via the input event).
 */
export type Surface =
  | "path"
  | "external_directory"
  | "read"
  | "write"
  | "edit"
  | "grep"
  | "find"
  | "ls"
  | "bash"
  | "web_search"
  | "tool"
  | "skill";

/** The set of valid surface names, for loader validation. */
export const SURFACES: Surface[] = [
  "path",
  "external_directory",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "bash",
  "web_search",
  "tool",
  "skill",
];

/** Surfaces that resolve against a filesystem path (subject to the `path` gate). */
export const FILE_SURFACES: Surface[] = ["read", "write", "edit", "grep", "find", "ls", "bash"];

/** Footer label colors (semantic theme tokens, no icons). */
export type ModeColor = "muted" | "mdLink" | "accent" | "error";

/**
 * The OS-sandbox profile for a mode. `enabled:false` runs bash unsandboxed
 * (YOLO); `writable:false` confines bash to reads (Plan). The filesystem/network
 * fields feed @anthropic-ai/sandbox-runtime.
 */
export interface SandboxProfile {
  enabled: boolean;
  writable: boolean;
  allowWrite?: string[];
  denyWrite?: string[];
  denyRead?: string[];
  /**
   * Paths readable again inside a `denyRead` region (deny-then-allow). A
   * more specific `denyRead` inside an `allowRead` entry still wins, and so
   * does a session block. Project configs may only remove entries.
   */
  allowRead?: string[];
  network?: { allowedDomains?: string[]; deniedDomains?: string[] };
  /**
   * Ask the user live when bash tries to reach a host outside the allowlist
   * (the connection waits while they decide). Defaults to true; false denies
   * silently as before. Project configs may set it to false (stricter), never
   * back to true.
   */
  askOnBlockedHost?: boolean;
  /**
   * A sandboxed command may listen on local ports and this machine may
   * connect to them while the command runs (default true). macOS: also
   * direct TCP to loopback from sandboxed bash, past the proxy (the
   * runtime's `network.allowLocalBinding`). Linux: no effect until managed
   * jobs (the sandbox's loopback is its own). Windows: `false` cannot be
   * enforced. Project configs may set false, never true.
   */
  allowLocalBinding?: boolean;
  /**
   * Roots the bash escape heuristic treats as inside: a path under one (a
   * remote path in `ssh nas ls /mnt/user`, say) is not an out-of-project
   * escape, so the command runs sandboxed as usual instead of prompting and
   * then running unsandboxed. Literal paths, `~` expands, globs are ignored.
   * Bash only: file tools, the sandbox profile and the runtime config do not
   * see them. Global config only; a project may remove entries, never add.
   */
  insideRoots?: string[];
  /**
   * macOS-only runtime options, forwarded to sandbox-runtime under their own
   * names and without effect on other platforms. Off unless set. Project
   * configs may set a key to false, never to true.
   */
  macos?: MacosOptions;
  /**
   * Linux-only runtime options, same rules as `macos`: forwarded under the
   * runtime's names, off unless set, no effect elsewhere, project configs
   * may set a key to false, never to true.
   */
  linux?: LinuxOptions;
}

/** The runtime's Linux-only switches a mode may opt into (`sandbox.linux`). */
export interface LinuxOptions {
  /** Let a sandboxed command create user and mount namespaces of its own (`allowNestedUserNamespaces`). */
  allowNestedUserNamespaces?: boolean;
}

/** The keys of `sandbox.linux`, for the loader and the status line. */
export const LINUX_KEYS = ["allowNestedUserNamespaces"] as const;

/** The runtime's macOS-only switches a mode may opt into (`sandbox.macos`). */
export interface MacosOptions {
  /** Let Go programs reach trustd for TLS verification (`enableWeakerNetworkIsolation`). */
  enableWeakerNetworkIsolation?: boolean;
}

/** The keys of `sandbox.macos`, for the loader and the status line. */
export const MACOS_KEYS = ["enableWeakerNetworkIsolation"] as const;

/** One named mode. */
export interface ModeDef {
  label: string;
  color: ModeColor;
  /**
   * Optional system-prompt injected via before_agent_start while this mode is
   * active. The sentinel `"@plan"` is resolved at runtime to the date-stamped
   * `planModeSystemPrompt(today)`; any other string is injected verbatim.
   */
  systemPrompt?: string;
  /**
   * Inject a factual description of this mode's sandbox boundaries (writable
   * paths, denied reads, network allowlist, prompt flow) into the system
   * prompt each turn, so the model picks paths/domains that work instead of
   * discovering the sandbox through failed commands. Defaults to true; set
   * false to opt out. Modes with `sandbox.enabled: false` never inject.
   */
  injectSandboxInfo?: boolean;
  sandbox: SandboxProfile;
  permission: Partial<Record<Surface, SurfaceValue>>;
  /** Tool names hidden from the model while this mode is active. */
  hideTools?: string[];
  /**
   * Skip the hard protected-path backstop (`.git`, `.env`, dotfiles) for file
   * tools. Defaults to false — the backstop applies in every mode unless a mode
   * explicitly trusts everything. Only YOLO sets this true.
   */
  bypassProtectedPaths?: boolean;
  /**
   * Internal (NOT part of the JSON schema): a project config's tighten-only
   * permission overlay, set by the loader. The resolver folds it in as an extra
   * most-restrictive layer, so it can only tighten the base policy, never loosen
   * it — regardless of the patterns it contains.
   */
  projectOverlay?: Partial<Record<Surface, SurfaceValue>>;
}

/** How the model learns that a background shell ended: a turn of its own, a note in the next turn, or not at all (it polls). */
export const SHELL_NOTIFY = ["wake", "note", "none"] as const;
export type ShellNotify = (typeof SHELL_NOTIFY)[number];

/** Background shells (bash `run_in_background`). Global config; a project may only tighten (src/shells). */
export interface ShellsConfig {
  /** false: `run_in_background` is refused with a sentence (never a silent foreground run). */
  enabled?: boolean;
  /** Running shells at most; a further start is refused. */
  maxConcurrent?: number;
  notify?: ShellNotify;
}

export const SHELLS_DEFAULTS: Required<ShellsConfig> = { enabled: true, maxConcurrent: 4, notify: "wake" };

/** Top-level config: the mode registry plus cycle/default metadata. */
export interface PermissionModeConfig {
  $schema?: string;
  defaultMode: string;
  /** alt+m cycle order; also the display order. */
  cycleOrder: string[];
  modes: Record<string, ModeDef>;
  /** One-step plan approval settings (plan-approval.ts). Global config only. */
  plan?: PlanApprovalConfig;
  /** Background shells. Global config; a project may only tighten. */
  shells?: ShellsConfig;
}

/** Sentinel a mode's `systemPrompt` can use to request the Plan-mode prompt. */
export const PLAN_PROMPT_SENTINEL = "@plan";

// The shipped default modes live in `permission-mode.defaults.json` at the package
// root (loaded by config-load.ts), so the defaults are data in the same format
// users edit. The emergency in-code fallback lives in config-load.ts.

/**
 * System-prompt addition injected while Plan Mode is active (resolved from the
 * `"@plan"` sentinel). `today` is an ISO date (YYYY-MM-DD) stamped at call time
 * so the suggested plan filename uses the current date.
 */
export function planModeSystemPrompt(today: string): string {
  return [
    "## Plan Mode is active",
    "",
    "In this mode bash runs read-only and only Markdown files can be created or",
    "edited, so do not change code now.",
    "",
    "If the user asks you to plan a task (a feature, refactor, investigation, or any",
    "multi-step change):",
    `1. Use the **Write** tool to create the plan file at \`plan/${today}_<short-kebab-description>.md\`.`,
    "   Write creates the `plan/` directory automatically — do NOT run `mkdir` or any",
    "   other bash command to make the folder (bash is read-only here and will fail).",
    "2. Keep it concise but actionable — context, approach, the files to change, and",
    "   how to verify.",
    "3. Then call the **show_plan** tool with that file path — it renders the plan in",
    "   the terminal for the user. Do NOT paste the plan text into your reply; show_plan",
    "   displays it.",
    "4. After show_plan, do NOT summarize, recap, or describe the plan, and add no other",
    "   commentary. Your entire reply must be a single short line: ask the user to review",
    "   the plan and accept it in the prompt that follows (or press `alt+m` / run `/plan approve`).",
    "",
    "For quick questions that aren't planning tasks, just answer normally.",
  ].join("\n");
}

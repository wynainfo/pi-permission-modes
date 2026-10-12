/**
 * Mode-config loading and layered merge.
 *
 * Layers, in order:
 *   1. permission-mode.defaults.json (shipped) — the four built-in modes, loaded
 *      over a minimal in-code fallback (FALLBACK_CONFIG).
 *   2. <agentDir>/permission-mode/permission-mode.json (global) — FULL authority:
 *      may add modes, redefine built-ins, and change defaultMode / cycleOrder.
 *   3. <cwd>/.pi/permission-mode.json (project) — TIGHTEN-ONLY: may only make an
 *      existing mode stricter. Its permission policy is attached as a separate
 *      most-restrictive overlay (so it can never loosen, regardless of patterns);
 *      its sandbox is intersected/unioned the stricter way. Project configs
 *      cannot add modes or change defaults.
 *
 * Pure except for the filesystem reads in `loadModeConfig`; no `pi`/`ctx`
 * dependency so the merge/tighten semantics are unit-testable.
 *
 * This module also owns the SandboxConfig shape consumed by sandbox.ts (the
 * runtime takes `{network, filesystem}`), plus the read-only override and the
 * domain-safety check ported from the former config.ts.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { NetworkConfigSchema } from "@anthropic-ai/sandbox-runtime";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { docRef } from "./docs.ts";
import type { PlanApprovalConfig } from "./plan-approval.ts";
import {
  CLASSIFIER_DEFAULTS,
  type ClassifierConfig,
  MAX_RULE_REASON,
  MODE_COLORS as COLORS,
  ON_REFUSE,
  type OnRefuse,
  type Action,
  LINUX_KEYS,
  type LinuxOptions,
  MACOS_KEYS,
  type MacosOptions,
  type GroupDef,
  type ModeDef,
  type PatternValue,
  PLAN_PROMPT_SENTINEL,
  type PermissionModeConfig,
  type SandboxProfile,
  SHELL_NOTIFY,
  SHELLS_DEFAULTS,
  type ShellNotify,
  type ShellsConfig,
  type SurfaceValue,
  type Surface,
  SURFACES,
} from "./schema.ts";

type OnError = (message: string) => void;
const noop: OnError = () => {};

/** `$schema` URL written into files this extension creates (/perm init, "Allow forever"). */
export const SCHEMA_URL = "https://raw.githubusercontent.com/wynainfo/pi-permission-modes/main/schemas/permission-mode.schema.json";

/** A project config larger than this is ignored (a FIFO or a giant file must not stall the loader). */
const MAX_CONFIG_BYTES = 1 << 20;

/** Keys that must never be used as mode names or looked up on plain objects. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Own, non-prototype entries of a plain object (empty for anything else). */
function safeEntries(v: unknown): [string, unknown][] {
  if (!isPlainObject(v)) return [];
  return Object.entries(v).filter(([k]) => !UNSAFE_KEYS.has(k));
}

/** Like safeEntries, but reports each skipped prototype-named key (a user should know their file has one). */
function modeEntries(v: unknown, where: string, onError: OnError): [string, unknown][] {
  if (!isPlainObject(v)) return [];
  for (const k of Object.keys(v)) {
    if (UNSAFE_KEYS.has(k)) onError(`permission-mode: ignoring mode "${k}" in ${where}: not a valid mode name`);
  }
  return safeEntries(v);
}

/** True when `name` is a real mode in `modes` (own property, never a prototype name). */
export function hasMode(modes: Record<string, unknown>, name: unknown): name is string {
  return typeof name === "string" && !UNSAFE_KEYS.has(name) && Object.hasOwn(modes, name);
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const MODE_COLORS = new Set<string>(COLORS);

/**
 * Keep only well-typed sandbox fields from a raw override, warning about the
 * rest. Applies to both layers: a malformed value must never throw in the
 * loader (a throwing project file would skip the global layer AND the
 * sandbox init), and a malformed global value is better dropped than crashed on.
 */
function sanitizeSandbox(raw: unknown, where: string, onError: OnError): Partial<SandboxProfile> {
  if (!isPlainObject(raw)) {
    if (raw !== undefined) onError(`permission-mode: sandbox in ${where} must be an object; ignoring`);
    return {};
  }
  const out: Partial<SandboxProfile> = {};
  const drop = (k: string) => onError(`permission-mode: ignoring sandbox.${k} in ${where}: wrong type`);
  for (const [k, v] of safeEntries(raw)) {
    switch (k) {
      case "enabled":
      case "writable":
      case "askOnBlockedHost":
      case "allowLocalBinding":
        if (typeof v === "boolean") out[k] = v;
        else drop(k);
        break;
      case "allowWrite":
      case "denyWrite":
      case "denyRead":
      case "allowRead":
      case "insideRoots":
        if (isStringArray(v)) out[k] = v;
        else drop(k);
        break;
      case "network": {
        if (!isPlainObject(v)) {
          drop(k);
          break;
        }
        // An unknown nested key must not silently do nothing (the runtime-shaped
        // `network.allowLocalBinding` is the top-level `allowLocalBinding` here).
        for (const nk of Object.keys(v)) {
          if (nk !== "allowedDomains" && nk !== "deniedDomains") onError(`permission-mode: ignoring unknown sandbox.network field "${nk}" in ${where}`);
        }
        const net: NonNullable<SandboxProfile["network"]> = {};
        if (v.allowedDomains !== undefined) {
          if (isStringArray(v.allowedDomains)) net.allowedDomains = safeDomains(v.allowedDomains, "allowedDomains", where, onError);
          else drop("network.allowedDomains");
        }
        if (v.deniedDomains !== undefined) {
          if (isStringArray(v.deniedDomains)) net.deniedDomains = safeDomains(v.deniedDomains, "deniedDomains", where, onError);
          else drop("network.deniedDomains");
        }
        out.network = net;
        break;
      }
      case "macos": {
        if (!isPlainObject(v)) {
          drop(k);
          break;
        }
        const macos: MacosOptions = {};
        for (const [mk, mv] of safeEntries(v)) {
          if (mk === "allowLocalBinding") {
            // 2.5.0 spelled the switch `sandbox.macos.allowLocalBinding`; it
            // is the top-level key now, with one meaning on every platform,
            // and the old spelling keeps working. An explicit top-level
            // value wins over it.
            if (typeof mv !== "boolean") drop(`macos.${mk}`);
            else if ((raw as Record<string, unknown>).allowLocalBinding === undefined) out.allowLocalBinding = mv;
            continue;
          }
          if (!(MACOS_KEYS as readonly string[]).includes(mk)) {
            onError(`permission-mode: ignoring unknown sandbox.macos field "${mk}" in ${where}`);
          } else if (typeof mv === "boolean") macos[mk as keyof MacosOptions] = mv;
          else drop(`macos.${mk}`);
        }
        out.macos = macos;
        break;
      }
      case "linux": {
        if (!isPlainObject(v)) {
          drop(k);
          break;
        }
        const linux: LinuxOptions = {};
        for (const [lk, lv] of safeEntries(v)) {
          if (!(LINUX_KEYS as readonly string[]).includes(lk)) {
            onError(`permission-mode: ignoring unknown sandbox.linux field "${lk}" in ${where}`);
          } else if (typeof lv === "boolean") linux[lk as keyof LinuxOptions] = lv;
          else drop(`linux.${lk}`);
        }
        out.linux = linux;
        break;
      }
      default:
        onError(`permission-mode: ignoring unknown sandbox field "${k}" in ${where}`);
    }
  }
  return out;
}

/**
 * Emergency in-code fallback — a single safe, sandboxed, ask-everything mode used
 * ONLY when the shipped `permission-mode.defaults.json` can't be read. The real
 * defaults live in that JSON; a test asserts it reproduces the intended behavior,
 * so this never silently stands in for them in a healthy install.
 */
export const FALLBACK_CONFIG: PermissionModeConfig = {
  defaultMode: "default",
  cycleOrder: ["default"],
  modes: {
    default: {
      label: "Default",
      color: "muted",
      sandbox: {
        enabled: true,
        writable: true,
        allowWrite: ["."],
        denyWrite: [],
        denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
        network: { allowedDomains: [], deniedDomains: [] },
      },
      permission: {
        path: { "*": "allow" },
        external_directory: "ask",
        read: "allow",
        grep: "allow",
        find: "allow",
        ls: "allow",
        write: "ask",
        edit: "ask",
        bash: { "*": "ask" },
        web_search: "ask",
        tool: "ask",
        skill: "ask",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Sandbox config shape (consumed by sandbox.ts / @anthropic-ai/sandbox-runtime)
// ---------------------------------------------------------------------------

/**
 * The runtime's config (`SandboxRuntimeConfig`), as far as this extension
 * fills it. `initialize()` dereferences `network` and `filesystem` and
 * iterates the lists without validating, so every list is an array here.
 * Only `allowedDomains` may stay undefined: that is how "unrestricted
 * network" is expressed (an empty array filters every host).
 */
export interface SandboxConfig {
  enabled?: boolean;
  network: { allowedDomains?: string[]; deniedDomains: string[]; allowLocalBinding?: boolean };
  filesystem: { denyRead: string[]; allowRead?: string[]; allowWrite: string[]; denyWrite: string[] };
  /** macOS: allow the trustd lookup Go programs need for TLS verification. */
  enableWeakerNetworkIsolation?: boolean;
  /** Linux: let a sandboxed command create user and mount namespaces of its own. */
  allowNestedUserNamespaces?: boolean;
}

/** Project a mode's sandbox profile into the runtime's config shape. */
export function profileToConfig(p: SandboxProfile): SandboxConfig {
  // The platform switches are emitted only when true: the runtime defaults
  // them to false, so stock output stays byte-identical and the profile key
  // stable.
  return {
    enabled: p.enabled,
    network: {
      allowedDomains: p.network?.allowedDomains,
      deniedDomains: p.network?.deniedDomains ?? [],
      // Default true; the runtime reads the key on macOS only.
      ...(p.allowLocalBinding !== false ? { allowLocalBinding: true } : {}),
    },
    ...(p.macos?.enableWeakerNetworkIsolation === true ? { enableWeakerNetworkIsolation: true } : {}),
    ...(p.linux?.allowNestedUserNamespaces === true ? { allowNestedUserNamespaces: true } : {}),
    filesystem: {
      denyRead: p.denyRead ?? [],
      ...(p.allowRead ? { allowRead: p.allowRead } : {}),
      allowWrite: p.allowWrite ?? [],
      denyWrite: p.denyWrite ?? [],
    },
  };
}

/**
 * Drop project write access (Plan Mode runs bash read-only); reads/network
 * stay. `keepWritable` survives (the session scratch dir, so temp files and
 * TMPDIR keep working in read-only modes).
 */
export function readOnlyOverride(config: SandboxConfig, keepWritable: string[] = []): SandboxConfig {
  return { ...config, filesystem: { ...config.filesystem, allowWrite: [...keepWritable] } };
}

/**
 * True when the sandbox runtime's own schema rejects the pattern: bare `*`,
 * TLD-only wildcards like `*.com`, single-label hosts like `nas01`, protocols,
 * paths. Asking the runtime keeps the two in step: an entry it rejects at
 * initialize() would otherwise take the whole sandbox down, and what it
 * admits (a `:port` suffix, a bracketed IPv6 literal) passes here too.
 */
export function isUnsafeDomain(d: string): boolean {
  return !NetworkConfigSchema.safeParse({ allowedDomains: [d], deniedDomains: [] }).success;
}

/** The one-line hint attached to a rejected network pattern. */
export const DOMAIN_PATTERN_HINT =
  "the sandbox runtime accepts a host with a dot (example.com), a *.sub wildcard, or a bracketed IPv6 literal, each with an optional :port";

/** The patterns the runtime accepts; each rejected one is reported and dropped. */
function safeDomains(list: string[], label: string, where: string, onError: (msg: string) => void): string[] {
  return list.filter((d) => {
    if (!isUnsafeDomain(d)) return true;
    onError(`permission-mode: ignoring ${label} pattern "${d}" in ${where}: ${DOMAIN_PATTERN_HINT}`);
    return false;
  });
}

const union = (a: string[] = [], b: string[] = []): string[] => [...new Set([...a, ...b])];
const intersect = (a: string[] = [], b: string[] = []): string[] => a.filter((x) => b.includes(x));

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isAction = (v: unknown): v is Action => v === "allow" || v === "ask" || v === "deny";

/**
 * JS objects iterate array-index-like keys ("0", "42", …) FIRST, regardless of
 * definition order — which silently breaks the last-match-wins semantics of a
 * pattern-map. Such keys are worth a warning (the pattern still works; only its
 * position in the map is not what the file suggests).
 */
const isIndexLikeKey = (k: string): boolean => /^(0|[1-9]\d*)$/.test(k);

/**
 * Clean one pattern-map entry value: a bare action string, or an object of the
 * form `{ action, reason? }` (`message` accepted as an alias of `reason`).
 * Invalid actions fail safe to "deny"; invalid reasons are dropped with a
 * warning (over-long reasons are truncated). The returned reason is trimmed.
 */
function cleanRule(value: unknown, label: string, onError: OnError, allowReason = true): PatternValue {
  if (isAction(value)) return value;
  if (!isPlainObject(value)) {
    onError(`permission-mode: invalid action "${String(value)}" for ${label}; treating as deny`);
    return "deny";
  }
  const action: Action = isAction(value.action) ? value.action : "deny";
  if (!isAction(value.action)) {
    onError(`permission-mode: invalid action "${String(value.action)}" for ${label}; treating as deny`);
  }
  for (const k of Object.keys(value)) {
    if (k !== "action" && k !== "reason") {
      onError(`permission-mode: ignoring unknown key "${k}" for ${label} (did you mean "reason"?)`);
    }
  }
  const rawReason = value.reason;
  if (rawReason === undefined) return action;
  // A reason is text shown to the model. Only the global config may set one:
  // a cloned repository must not get to put words in front of the model.
  if (!allowReason) {
    onError(`permission-mode: project config cannot set rule reasons; ignoring the reason for ${label} (see ${docRef("projectConfig")})`);
    return action;
  }
  if (typeof rawReason !== "string") {
    onError(`permission-mode: ignoring non-string reason for ${label}: must be a string`);
    return { action };
  }
  const trimmed = rawReason.trim();
  if (!trimmed) {
    onError(`permission-mode: ignoring empty reason for ${label}`);
    return { action };
  }
  if (trimmed.length > MAX_RULE_REASON) {
    onError(
      `permission-mode: reason for ${label} is ${trimmed.length} chars; truncating to ${MAX_RULE_REASON}`,
    );
    return { action, reason: trimmed.slice(0, MAX_RULE_REASON) };
  }
  return { action, reason: trimmed };
}

/**
 * Clean a raw permission object: drop unknown surfaces and coerce invalid action
 * values to "deny" (fail-safe), reporting each via onError. Warns on
 * array-index-like pattern keys, whose iteration order JS silently front-loads.
 */
function cleanPermission(raw: unknown, where: string, onError: OnError, allowReason = true): Partial<Record<Surface, unknown>> {
  const out: Partial<Record<Surface, unknown>> = {};
  if (!isPlainObject(raw)) {
    if (raw !== undefined) onError(`permission-mode: permission in ${where} must be an object; ignoring`);
    return out;
  }
  for (const [key, value] of safeEntries(raw)) {
    if (!SURFACES.includes(key as Surface)) {
      onError(`permission-mode: ignoring unknown surface "${key}" in ${where}`);
      continue;
    }
    const surface = key as Surface;
    if (typeof value === "string") {
      if (isAction(value)) {
        out[surface] = value;
      } else {
        onError(`permission-mode: invalid action "${value}" for ${key} in ${where}; treating as deny`);
        out[surface] = "deny";
      }
    } else if (isPlainObject(value)) {
      const map: Record<string, PatternValue> = {};
      for (const [pat, act] of safeEntries(value)) {
        if (isIndexLikeKey(pat)) {
          onError(
            `permission-mode: pattern "${pat}" for ${key} in ${where} is a bare number - JS reorders such keys to the FRONT of the map, so last-match-wins may not follow file order; prefix or quote it differently (e.g. "./${pat}")`,
          );
        }
        map[pat] = cleanRule(act, `${key}.${pat} in ${where}`, onError, allowReason);
      }
      out[surface] = map;
    } else {
      onError(`permission-mode: ignoring ${key} in ${where}: must be an action or a pattern map`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Global (full-authority) merge
// ---------------------------------------------------------------------------

function mergeMode(base: ModeDef, over: Partial<ModeDef>, where: string, onError: OnError): ModeDef {
  const overExtends = over.extends;
  const baseExtends = base.extends;
  if (overExtends !== undefined) {
    // Declaring `extends` resets the sandbox/permission content: the groups
    // (expanded once per load) supply it, so the previous layer's concrete
    // values must not leak in above them (e.g. the FALLBACK safety net
    // would otherwise overwrite the groups). An empty list detaches the mode
    // onto its own fields (missing sandbox/permission fall back to safe
    // defaults below, never to deleted-mode). Identity and display scalars
    // still inherit, and a base that is itself group-composed only carries
    // its own fields, so merging them under the override can never resurrect
    // stale concrete values.
    const rest = omitExtends(over);
    const baseComposed = baseExtends !== undefined && baseExtends.length > 0;
    const merged = {
      label: rest.label ?? base.label,
      color: rest.color ?? base.color,
      systemPrompt: rest.systemPrompt ?? base.systemPrompt,
      injectSandboxInfo: rest.injectSandboxInfo ?? base.injectSandboxInfo,
      hideTools: rest.hideTools ?? base.hideTools,
      bypassProtectedPaths: rest.bypassProtectedPaths ?? base.bypassProtectedPaths,
      sandbox: rest.sandbox
        ? { ...(baseComposed ? base.sandbox ?? {} : {}), ...rest.sandbox }
        : baseComposed
          ? base.sandbox
          : undefined,
      permission: { ...(baseComposed ? base.permission ?? {} : {}), ...(rest.permission ?? {}) },
    } as ModeDef;
    if (overExtends.length === 0) {
      // No composition and possibly no own content: fail safe to useful
      // defaults with warnings instead of letting validateExpandedModes
      // drop the mode for a missing sandbox block. Copy first: merged.sandbox
      // may alias base.sandbox, which ensureModeDefaults mutates in place.
      if (merged.sandbox) merged.sandbox = { ...merged.sandbox };
      ensureModeDefaults(merged, where, onError, " (extends: [] leaves the mode on its own fields)");
    } else {
      merged.extends = overExtends;
    }
    return merged;
  }
  const rest = omitExtends(over);
  const merged: ModeDef = {
    ...base,
    ...rest,
    sandbox: rest.sandbox ? { ...base.sandbox, ...rest.sandbox } : base.sandbox,
    // Surface-level shallow merge: an override replaces a whole surface's value.
    permission: { ...base.permission, ...(rest.permission ?? {}) },
    hideTools: rest.hideTools ?? base.hideTools,
  };
  return merged;
}

/** Strip the `extends` composition list, keeping only effective content fields. */
function omitExtends<T extends { extends?: unknown }>(v: T): Omit<T, "extends"> {
  const { extends: _e, ...rest } = v;
  void _e;
  return rest;
}

/**
 * Fail-safe defaults for a mode's sandbox booleans and permission block.
 * `note` distinguishes the pre-expansion check ("") from the
 * post-expansion one (" after expansion").
 */
function ensureModeDefaults(
  mode: { sandbox?: Partial<SandboxProfile>; permission?: Partial<Record<Surface, SurfaceValue>> },
  where: string,
  onError: OnError,
  note = "",
): void {
  const sandbox = (mode.sandbox ??= {}) as Partial<SandboxProfile>;
  if (typeof sandbox.enabled !== "boolean") {
    onError(`permission-mode: ${where}: sandbox.enabled missing${note}; defaulting to true`);
    sandbox.enabled = true;
  }
  if (typeof sandbox.writable !== "boolean") {
    onError(`permission-mode: ${where}: sandbox.writable missing${note}; defaulting to true`);
    sandbox.writable = true;
  }
  if (mode.permission === undefined) {
    onError(`permission-mode: ${where}: no permission block${note}; every surface will ask`);
    mode.permission = {};
  }
}

/** Merge one partial fragment (group or mode-own values) over an accumulator. */
function mergeFragment(acc: Partial<ModeDef>, over: Partial<ModeDef>): Partial<ModeDef> {
  const a = omitExtends(acc);
  const o = omitExtends(over);
  return {
    ...a,
    ...o,
    sandbox: (o.sandbox ? deepMerge(a.sandbox ?? {}, o.sandbox) : a.sandbox) as ModeDef["sandbox"],
    permission: deepMerge(a.permission ?? {}, o.permission ?? {}) as Partial<Record<Surface, SurfaceValue>>,
    hideTools: o.hideTools ?? a.hideTools,
  };
}

/**
 * One merge function for all composition within an extends chain (group into
 * group into mode-own). Same rule everywhere, by value kind:
 * - two plain maps/objects → merge key-wise in layer order (earlier first);
 *   a redefined key moves to the end — a plain spread would keep its first
 *   position and silently reorder last-match-wins;
 * - exact `"*"` entries go first: they are the documented universal fallback,
 *   so a trailing default can never flip layer specifics;
 * - rule objects (`{action}` values), arrays and anything else → override wins.
 * Arrays never union: unioning an allow-list would widen it, and stock entries
 * would become unremovable. So a `deniedDomains`-only layer no longer wipes
 * the allowlist, while `allowWrite`/`extends`/`hideTools` keep replace
 * semantics. Cross-config-layer merges (stock/global/project) keep their own
 * replace/reset semantics — this is composition within one layer.
 */
function deepMerge(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) return b;
  if (isPlainObject(a) && isPlainObject(b) && !isRuleObject(a) && !isRuleObject(b)) {
    const out: Record<string, unknown> = {};
    for (const src of [a, b]) {
      if ("*" in src) out["*"] = (src as Record<string, unknown>)["*"];
    }
    for (const src of [a, b]) {
      for (const [k, v] of Object.entries(src)) {
        if (k === "*") continue;
        if (UNSAFE_KEYS.has(k)) continue; // belt and braces: sanitizers already strip these
        // Capture before deleting: the delete moves a redefined key to the
        // end (order matters for last-match-wins), but the merge needs it.
        const prev = k in out ? out[k] : undefined;
        if (k in out) delete out[k];
        out[k] = deepMerge(prev, v);
      }
    }
    return out;
  }
  return b;
}

/** A pattern-rule value object: exactly `{action}` plus only `reason`/`message`.
 * Anything else shaped like it (e.g. a pattern literally named `action`
 * alongside other patterns) still merges — a lone `{"action": ...}` map is
 * indistinguishable from a rule object and stays a leaf. */
const RULE_VALUE_KEYS = new Set(["action", "reason", "message"]);
function isRuleObject(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && typeof v.action === "string" && Object.keys(v).every((k) => RULE_VALUE_KEYS.has(k));
}

/** Sanitize an `extends` list: strings only, prototype names dropped with a warning. */
function sanitizeExtends(raw: unknown, where: string, onError: OnError): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) {
    onError(`permission-mode: ignoring extends in ${where}: must be a string array`);
    return undefined;
  }
  const out: string[] = [];
  for (const name of raw as string[]) {
    if (UNSAFE_KEYS.has(name)) {
      onError(`permission-mode: ignoring extends "${name}" in ${where}: not a valid group name`);
      continue;
    }
    out.push(name);
  }
  return out;
}

/** Clean a raw group definition (same vocabulary as a mode, all optional). */
function sanitizeGroup(raw: unknown, where: string, onError: OnError): GroupDef {
  const out: GroupDef = {};
  if (!isPlainObject(raw)) {
    onError(`permission-mode: ${where} must be an object; ignoring`);
    return out;
  }
  if (raw.systemPrompt !== undefined) {
    if (typeof raw.systemPrompt === "string") {
      out.systemPrompt = raw.systemPrompt;
      onError(`permission-mode: ${where} sets systemPrompt: prompts compose silently into modes; prefer setting it on the mode`);
    } else onError(`permission-mode: ignoring systemPrompt in ${where}: must be a string`);
  }
  if (raw.injectSandboxInfo !== undefined) {
    if (typeof raw.injectSandboxInfo === "boolean") out.injectSandboxInfo = raw.injectSandboxInfo;
    else onError(`permission-mode: ignoring injectSandboxInfo in ${where}: must be a boolean`);
  }
  if (raw.sandbox !== undefined) {
    const s = sanitizeSandbox(raw.sandbox, where, onError);
    if (Object.keys(s).length > 0) out.sandbox = s;
  }
  if (raw.permission !== undefined) {
    const p = cleanPermission(raw.permission, where, onError);
    if (Object.keys(p).length > 0) out.permission = p as GroupDef["permission"];
  }
  if (raw.hideTools !== undefined) {
    if (isStringArray(raw.hideTools)) out.hideTools = [...raw.hideTools];
    else onError(`permission-mode: ignoring hideTools in ${where}: must be a string array`);
  }
  if (raw.bypassProtectedPaths !== undefined) {
    if (typeof raw.bypassProtectedPaths === "boolean") {
      out.bypassProtectedPaths = raw.bypassProtectedPaths;
      onError(`permission-mode: ${where} sets bypassProtectedPaths: the backstop removal composes silently into modes; prefer setting it on the mode`);
    } else onError(`permission-mode: ignoring bypassProtectedPaths in ${where}: must be a boolean`);
  }
  const ext = sanitizeExtends(raw.extends, where, onError);
  if (ext !== undefined) out.extends = ext;
  for (const k of Object.keys(raw)) {
    if (!["systemPrompt", "injectSandboxInfo", "sandbox", "permission", "hideTools", "bypassProtectedPaths", "extends"].includes(k)) {
      onError(`permission-mode: ignoring unknown group field "${k}" in ${where}`);
    }
  }
  return out;
}

/** Merge group registries: overrides replace whole named groups. */
function mergeGroups(
  base: Record<string, GroupDef> | undefined,
  over: unknown,
  where: string,
  onError: OnError,
): Record<string, GroupDef> {
  const out: Record<string, GroupDef> = { ...(base ?? {}) };
  if (over === undefined) return out;
  if (!isPlainObject(over)) {
    onError(`permission-mode: groups in ${where} must be an object; ignoring`);
    return out;
  }
  for (const [name, raw] of safeEntries(over)) {
    out[name] = sanitizeGroup(raw, `${where} group "${name}"`, onError);
  }
  for (const k of Object.keys(over)) {
    if (UNSAFE_KEYS.has(k)) {
      onError(`permission-mode: ignoring group "${k}" in ${where}: not a valid group name`);
    }
  }
  return out;
}

/** Recursively expand one group (its own `extends` first), with cycle detection. */
function expandGroup(
  name: string,
  groups: Record<string, GroupDef>,
  onError: OnError,
  stack: string[],
): Partial<ModeDef> {
  const g = groups[name];
  if (!g) {
    onError(`permission-mode: unknown group "${name}" in extends (${stack.join(" -> ")}); ignoring`);
    return {};
  }
  if (stack.includes(name)) {
    onError(`permission-mode: cyclic extends detected: ${[...stack, name].join(" -> ")}; ignoring`);
    return {};
  }
  let acc: Partial<ModeDef> = {};
  for (const parent of g.extends ?? []) {
    acc = mergeFragment(acc, expandGroup(parent, groups, onError, [...stack, name]));
  }
  // A group sandbox is partial by design; the merge handles partials at runtime.
  return mergeFragment(acc, omitExtends(g) as Partial<ModeDef>);
}

/** Expand a mode's `extends` list over its own fields (mode wins). */
function expandModeGroups(
  modeName: string,
  mode: ModeDef,
  groups: Record<string, GroupDef>,
  onError: OnError,
): ModeDef {
  const ext = mode.extends;
  if (!ext || ext.length === 0) return mode;
  let acc: Partial<ModeDef> = {};
  for (const name of ext) {
    acc = mergeFragment(acc, expandGroup(name, groups, onError, [`mode "${modeName}"`]));
  }
  const merged = mergeFragment(acc, omitExtends(mode));
  return { ...(merged as ModeDef), extends: ext };
}

/** Expand `extends` for every mode; keeps the `extends` list for transparency. */
function expandAllModes(config: PermissionModeConfig, onError: OnError): void {
  const groups = config.groups ?? {};
  for (const name of Object.keys(config.modes)) {
    config.modes[name] = expandModeGroups(name, config.modes[name], groups, onError);
    // Post-expansion: group-composed modes can inherit the contradiction too.
    warnModeContradictions(name, config.modes[name], onError);
  }
}

/**
 * Post-merge sanity warnings for one mode. Currently: a mode whose system
 * prompt is the Plan prompt (which instructs the model to call `show_plan`)
 * but whose `hideTools` removes that tool — honored as written, since
 * `hideTools` is intent, but the contradiction is worth a warning.
 */
function warnModeContradictions(name: string, mode: ModeDef, onError: OnError): void {
  if (mode.systemPrompt === PLAN_PROMPT_SENTINEL && mode.hideTools?.includes("show_plan")) {
    onError(
      `permission-mode: mode "${name}" hides show_plan but its "@plan" system prompt tells the model to call it; ` +
        "drop show_plan from hideTools or use a different systemPrompt",
    );
  }
}

function mergeGlobal(base: PermissionModeConfig, over: Partial<PermissionModeConfig>, onError: OnError): PermissionModeConfig {
  // Raw merge only: `extends` is expanded once per load (see load entry
  // points), so a group redefinition applies to every mode referencing it.
  const groups = mergeGroups(base.groups, (over as { groups?: unknown }).groups, "global config", onError);
  const modes: Record<string, ModeDef> = { ...base.modes };
  for (const [name, raw] of modeEntries(over.modes, "global config", onError)) {
    const where = `global mode "${name}"`;
    if (!isPlainObject(raw)) {
      onError(`permission-mode: ${where} must be an object; ignoring`);
      continue;
    }
    const m: Partial<ModeDef> = { ...(raw as Partial<ModeDef>) };
    if (raw.permission !== undefined) m.permission = cleanPermission(raw.permission, where, onError) as ModeDef["permission"];
    if (raw.sandbox !== undefined) m.sandbox = sanitizeSandbox(raw.sandbox, where, onError) as SandboxProfile;
    if (raw.hideTools !== undefined && !isStringArray(raw.hideTools)) {
      onError(`permission-mode: ignoring hideTools in ${where}: must be a string array`);
      delete m.hideTools;
    }
    if (raw.classifier !== undefined) {
      const c = sanitizeClassifier(raw.classifier, where, onError);
      if (c === undefined) delete m.classifier;
      else m.classifier = c;
    }
    const ext = sanitizeExtends(raw.extends, where, onError);
    if (ext !== undefined) m.extends = ext;
    else delete m.extends;
    if (hasMode(modes, name)) {
      modes[name] = mergeMode(modes[name], m, where, onError);
    } else {
      // A new mode: label, color, and a sandbox object are required — unless
      // it composes groups, in which case the missing pieces are validated
      // after expansion at the load entry points.
      const defersToGroups = ext !== undefined && ext.length > 0;
      if (!defersToGroups && (typeof m.label !== "string" || !MODE_COLORS.has(String(m.color)) || !isPlainObject(raw.sandbox))) {
        onError(`permission-mode: ignoring incomplete new global mode "${name}" (needs label, color, sandbox)`);
        continue;
      }
      if (!defersToGroups) ensureModeDefaults(m, where, onError);
      modes[name] = {
        ...m,
        label: m.label as ModeDef["label"],
        color: m.color as ModeDef["color"],
        sandbox: m.sandbox as SandboxProfile,
        permission: m.permission ?? {},
      };
    }
  }
  const cycleOrder = (isStringArray(over.cycleOrder) ? over.cycleOrder : base.cycleOrder).filter((n) => hasMode(modes, n));
  let defaultMode = typeof over.defaultMode === "string" ? over.defaultMode : base.defaultMode;
  if (!hasMode(modes, defaultMode)) defaultMode = cycleOrder[0] ?? base.defaultMode;
  const plan = sanitizePlan(over.plan, onError) ?? base.plan;
  const shells = sanitizeShells(over.shells, "global config", onError) ?? base.shells;
  return { defaultMode, cycleOrder, modes, ...(Object.keys(groups).length > 0 ? { groups } : {}), ...(plan ? { plan } : {}), ...(shells ? { shells } : {}) };
}

/** The longest `classifier.guidance` and `classifier.restrict` texts kept (the prompt is on every verdict). */
export const MAX_CLASSIFIER_TEXT = 2000;

/**
 * A mode's `classifier` block: `false`, or typed fields only, anything else
 * dropped with a warning. Used for both layers; the project rules are
 * applied afterwards by `tightenClassifier`.
 */
export function sanitizeClassifier(raw: unknown, where: string, onError: OnError): ClassifierConfig | false | undefined {
  if (raw === false) return false;
  if (!isPlainObject(raw)) {
    onError(`permission-mode: ${where}: classifier must be an object or false; ignoring`);
    return undefined;
  }
  const out: ClassifierConfig = {};
  const bad = (k: string, what: string) => onError(`permission-mode: ${where}: classifier.${k} ${what}; ignoring`);
  for (const [k, v] of safeEntries(raw)) {
    switch (k) {
      case "model":
        if (typeof v === "string" && v.trim()) out.model = v.trim();
        else bad(k, 'must be "current" or "provider/model-id"');
        break;
      case "strictness":
        if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) out.strictness = v;
        else bad(k, "must be a number from 0 to 1");
        break;
      case "onRefuse":
        if (typeof v === "string" && (ON_REFUSE as readonly string[]).includes(v)) out.onRefuse = v as OnRefuse;
        else bad(k, 'must be "refuse" or "ask"');
        break;
      case "guidance":
      case "restrict":
        if (typeof v === "string") out[k] = v.length > MAX_CLASSIFIER_TEXT ? v.slice(0, MAX_CLASSIFIER_TEXT) : v;
        else bad(k, "must be a string");
        break;
      default:
        onError(`permission-mode: ${where}: unknown key classifier.${k}; ignoring`);
    }
  }
  return out;
}

/** The classifier block with the defaults filled in. */
export function effectiveClassifier(cfg: ClassifierConfig): Required<Pick<ClassifierConfig, "model" | "strictness" | "onRefuse">> & ClassifierConfig {
  return { ...CLASSIFIER_DEFAULTS, ...cfg };
}

/**
 * A project's `classifier` may only tighten: raise `strictness`, switch
 * `onRefuse` from refuse to ask (a human in the loop is the stricter setting
 * for the agent), add a `restrict` text, or set the block to `false` (the
 * mode then prompts as if it had none). It may not pick the model (that
 * would route the user's prompts to a provider of the repository's
 * choosing) or set `guidance`. A project block on a mode without one adds
 * nothing: there is no classifier to tighten.
 */
export function tightenClassifier(base: ClassifierConfig | false | undefined, over: ClassifierConfig | false, where: string, onError: OnError): ClassifierConfig | false | undefined {
  const loosen = (k: string) => onError(`permission-mode: ${where}: project config cannot set classifier.${k}; ignoring (see ${docRef("projectConfig")})`);
  if (over === false) return base === undefined ? undefined : false;
  if (base === undefined || base === false) {
    if (Object.keys(over).length > 0) onError(`permission-mode: ${where}: the mode has no classifier to tighten; ignoring (see ${docRef("projectConfig")})`);
    return base;
  }
  const eff = effectiveClassifier(base);
  const out: ClassifierConfig = { ...base };
  if (over.model !== undefined) loosen("model");
  if (over.guidance !== undefined) loosen("guidance");
  if (over.strictness !== undefined) {
    if (over.strictness >= eff.strictness) out.strictness = over.strictness;
    else loosen("strictness below the global value");
  }
  if (over.onRefuse === "ask") out.onRefuse = "ask";
  else if (over.onRefuse === "refuse" && eff.onRefuse === "ask") loosen("onRefuse back to refuse");
  if (over.restrict !== undefined) out.restrict = over.restrict;
  return out;
}

/** The top-level `shells` block: typed fields only, anything else dropped with a warning. */
export function sanitizeShells(raw: unknown, where: string, onError: OnError): ShellsConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    onError(`permission-mode: ${where}: shells must be an object; ignoring`);
    return undefined;
  }
  const out: ShellsConfig = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "enabled" && typeof v === "boolean") out.enabled = v;
    else if (k === "maxConcurrent" && typeof v === "number" && Number.isInteger(v) && v >= 0) out.maxConcurrent = v;
    else if (k === "notify" && typeof v === "string" && (SHELL_NOTIFY as readonly string[]).includes(v)) out.notify = v as ShellNotify;
    else if (k === "enabled" || k === "maxConcurrent" || k === "notify") onError(`permission-mode: ${where}: shells.${k} has the wrong type; ignoring`);
    else onError(`permission-mode: ${where}: unknown key shells.${k}; ignoring`);
  }
  return out;
}

/** The `shells` block with the defaults filled in. */
export function effectiveShells(cfg: ShellsConfig | undefined): Required<ShellsConfig> {
  return { ...SHELLS_DEFAULTS, ...cfg };
}

/**
 * A project's `shells` block may only tighten: turn shells off, lower the
 * concurrency, quiet the notice (wake > note > none). Anything looser warns
 * and is ignored.
 */
export function tightenShells(base: ShellsConfig | undefined, over: ShellsConfig, onError: OnError): ShellsConfig {
  const eff = effectiveShells(base);
  const out: ShellsConfig = { ...base };
  const loosen = (k: string) => onError(`permission-mode: project config cannot loosen shells.${k}; ignoring (see ${docRef("projectConfig")})`);
  if (over.enabled !== undefined) {
    if (over.enabled === false) out.enabled = false;
    else if (!eff.enabled) loosen("enabled");
  }
  if (over.maxConcurrent !== undefined) {
    if (over.maxConcurrent <= eff.maxConcurrent) out.maxConcurrent = over.maxConcurrent;
    else loosen("maxConcurrent");
  }
  if (over.notify !== undefined) {
    if (SHELL_NOTIFY.indexOf(over.notify) >= SHELL_NOTIFY.indexOf(eff.notify)) out.notify = over.notify;
    else loosen("notify");
  }
  return out;
}

/** Post-expansion check for modes introduced via groups (label/color/sandbox now required). */
function validateExpandedModes(config: PermissionModeConfig, onError: OnError): void {
  for (const [name, mode] of Object.entries(config.modes)) {
    if (typeof mode.label !== "string" || !MODE_COLORS.has(String(mode.color)) || !isPlainObject(mode.sandbox)) {
      onError(`permission-mode: ignoring incomplete mode "${name}" after group expansion (needs label, color, sandbox)`);
      delete config.modes[name];
      continue;
    }
    ensureModeDefaults(mode, `mode "${name}"`, onError, " after expansion");
  }
  // A deleted mode must not leave dangling references behind.
  config.cycleOrder = config.cycleOrder.filter((n) => hasMode(config.modes, n));
  if (!hasMode(config.modes, config.defaultMode)) {
    const fallback = config.cycleOrder[0] ?? Object.keys(config.modes)[0];
    if (fallback !== undefined) {
      onError(`permission-mode: default mode "${config.defaultMode}" was dropped; falling back to "${fallback}"`);
      config.defaultMode = fallback;
    }
  }
}

/** The top-level `plan` block: string fields only, anything else dropped with a warning. */
function sanitizePlan(raw: unknown, onError: OnError): PlanApprovalConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    onError("permission-mode: global config: plan must be an object; ignoring");
    return undefined;
  }
  const out: PlanApprovalConfig = {};
  for (const k of ["approveMode", "approveMessage"] as const) {
    const v = raw[k];
    if (v === undefined) continue;
    if (typeof v === "string") out[k] = v;
    else onError(`permission-mode: global config: plan.${k} must be a string; ignoring`);
  }
  for (const k of Object.keys(raw)) {
    if (k !== "approveMode" && k !== "approveMessage") onError(`permission-mode: global config: unknown key plan.${k}; ignoring`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Project (tighten-only) merge
// ---------------------------------------------------------------------------

function tightenSandbox(base: SandboxProfile, rawOver: unknown, where: string, onError: OnError): SandboxProfile {
  const over = sanitizeSandbox(rawOver, where, onError);
  const result: SandboxProfile = { ...base, network: { ...base.network } };
  // Project overlays cannot change whether a mode is sandboxed. In particular,
  // they must never disable containment, and allowing them to enable a sparse
  // globally-unsandboxed profile would create a surprising, potentially
  // incomplete runtime configuration. Repeating the inherited value is a
  // harmless no-op; changing it is ignored with a warning.
  if (over.enabled !== undefined && over.enabled !== base.enabled) {
    onError(`permission-mode: project config cannot change sandbox.enabled; ignoring sandbox.enabled=${over.enabled} (see ${docRef("projectConfig")})`);
  }
  if (over.writable === false) result.writable = false; // can force read-only, never re-enable writes
  if (over.askOnBlockedHost === false) result.askOnBlockedHost = false; // silent-deny is stricter than asking
  if (over.allowLocalBinding === false) result.allowLocalBinding = false; // closing local ports is stricter
  if (over.allowLocalBinding === true && base.allowLocalBinding === false) {
    onError(`permission-mode: project config cannot enable sandbox.allowLocalBinding; ignoring (see ${docRef("projectConfig")})`);
  }
  if (over.macos) {
    // Each switch opens something, so a project may only turn one OFF.
    // Repeating the inherited value is a harmless no-op; `true` over an
    // absent or false base is ignored with a warning.
    const macos: MacosOptions = { ...base.macos };
    for (const key of MACOS_KEYS) {
      const v = over.macos[key];
      if (v === false && base.macos?.[key] === true) macos[key] = false;
      if (v === true && base.macos?.[key] !== true) {
        onError(`permission-mode: project config cannot enable sandbox.macos.${key}; ignoring (see ${docRef("projectConfig")})`);
      }
    }
    result.macos = macos;
  }
  if (over.linux) {
    // Same rule as the macOS switches: a project may only turn one off.
    const linux: LinuxOptions = { ...base.linux };
    for (const key of LINUX_KEYS) {
      const v = over.linux[key];
      if (v === false && base.linux?.[key] === true) linux[key] = false;
      if (v === true && base.linux?.[key] !== true) {
        onError(`permission-mode: project config cannot enable sandbox.linux.${key}; ignoring (see ${docRef("projectConfig")})`);
      }
    }
    result.linux = linux;
  }
  if (over.allowWrite !== undefined) result.allowWrite = intersect(base.allowWrite, over.allowWrite);
  // A root here removes a prompt, so a project may only take roots away.
  if (over.insideRoots !== undefined) result.insideRoots = intersect(base.insideRoots, over.insideRoots);
  if (over.denyRead !== undefined) result.denyRead = union(base.denyRead, over.denyRead);
  if (over.allowRead !== undefined) result.allowRead = intersect(base.allowRead, over.allowRead); // may only close carve-outs
  if (over.denyWrite !== undefined) result.denyWrite = union(base.denyWrite, over.denyWrite);
  if (over.network) {
    if (over.network.allowedDomains !== undefined) {
      const safe = safeDomains(over.network.allowedDomains, "allowedDomains", "project config", onError);
      result.network!.allowedDomains = intersect(base.network?.allowedDomains, safe);
    }
    if (over.network.deniedDomains !== undefined) {
      const safe = safeDomains(over.network.deniedDomains, "deniedDomains", "project config", onError);
      result.network!.deniedDomains = union(base.network?.deniedDomains, safe);
    }
  }
  return result;
}

function applyProject(config: PermissionModeConfig, project: unknown, onError: OnError): void {
  if (!isPlainObject(project)) {
    onError("permission-mode: project config must be a JSON object; ignoring");
    return;
  }
  if (project.defaultMode !== undefined || project.cycleOrder !== undefined) {
    onError(`permission-mode: project config cannot change defaultMode/cycleOrder; ignoring (see ${docRef("projectConfig")})`);
  }
  if (project.plan !== undefined) {
    onError(`permission-mode: project config cannot set plan (approval settings are global); ignoring (see ${docRef("projectConfig")})`);
  }
  if (project.shells !== undefined) {
    const over = sanitizeShells(project.shells, "project config", onError);
    if (over) config.shells = tightenShells(config.shells, over, onError);
  }
  if ((project as { groups?: unknown }).groups !== undefined) {
    onError("permission-mode: project config cannot define groups; ignoring");
  }
  if (project.modes !== undefined && !isPlainObject(project.modes)) {
    onError("permission-mode: project config modes must be an object; ignoring");
    return;
  }
  for (const [name, raw] of modeEntries(project.modes, "project config", onError)) {
    if (!hasMode(config.modes, name)) {
      onError(`permission-mode: project config cannot add new mode "${name}"; ignoring (see ${docRef("projectConfig")})`);
      continue;
    }
    const where = `project mode "${name}"`;
    try {
      const base = config.modes[name];
      if (!isPlainObject(raw)) {
        onError(`permission-mode: ${where} must be an object; ignoring`);
        continue;
      }
      if ((raw as { extends?: unknown }).extends !== undefined) {
        onError(`permission-mode: ${where}: project config cannot change extends; ignoring`);
      }
      if (raw.sandbox !== undefined) base.sandbox = tightenSandbox(base.sandbox, raw.sandbox, where, onError);
      if (raw.classifier !== undefined) {
        const over = sanitizeClassifier(raw.classifier, where, onError);
        if (over !== undefined) {
          const tightened = tightenClassifier(base.classifier, over, where, onError);
          if (tightened === undefined) delete base.classifier;
          else base.classifier = tightened;
        }
      }
      if (raw.permission !== undefined) {
        // Attach as a most-restrictive overlay - provably tighten-only.
        base.projectOverlay = cleanPermission(raw.permission, where, onError, false) as ModeDef["permission"];
      }
      // label/color/systemPrompt/hideTools/bypassProtectedPaths from a project are
      // ignored: they're cosmetic or could loosen, neither of which a project may do.
      // classifier is tighten-only (tightenClassifier).
    } catch (e) {
      // Defense in depth: a project file must never take the loader down.
      onError(`permission-mode: ignoring ${where}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Strip `$schema` and parse a config file, or undefined (reporting parse errors). */
function parseConfigFile(p: string, onError: OnError): Partial<PermissionModeConfig> | undefined {
  let size: number;
  try {
    const st = statSync(p); // follows symlinks: a link to a FIFO or /dev/stdin is not a regular file
    if (!st.isFile()) {
      onError(`permission-mode: ${p} is not a regular file; ignoring`);
      return undefined;
    }
    size = st.size;
  } catch {
    return undefined; // absent
  }
  if (size > MAX_CONFIG_BYTES) {
    onError(`permission-mode: ${p} is larger than ${MAX_CONFIG_BYTES} bytes; ignoring`);
    return undefined;
  }
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (!isPlainObject(data)) {
      onError(`permission-mode: ${p} must contain a JSON object; ignoring`);
      return undefined;
    }
    delete data.$schema;
    delete data.$comment; // `/perm init` provenance note
    return data as Partial<PermissionModeConfig>;
  } catch (e) {
    onError(`permission-mode: could not parse ${p}: ${e}`);
    return undefined;
  }
}

/** Absolute path to the shipped stock defaults (resolved wherever installed). */
export function stockDefaultsFile(): string {
  return fileURLToPath(new URL("../permission-mode.defaults.json", import.meta.url));
}

/**
 * The shipped default modes: `permission-mode.defaults.json` applied (full
 * authority) over the minimal FALLBACK_CONFIG via the same merge pipeline as user
 * config. If the stock file is missing/invalid, the safe fallback is returned and
 * the problem is reported — the extension always has at least one valid mode.
 */
/** Raw stock merge (no group expansion): shared so global redefinitions apply. */
function loadRawStock(onError: OnError): PermissionModeConfig {
  const stock = parseConfigFile(stockDefaultsFile(), onError);
  if (!stock) {
    onError("permission-mode: stock defaults (permission-mode.defaults.json) missing or invalid — using minimal fallback; reinstall the extension");
    return clone(FALLBACK_CONFIG);
  }
  return mergeGlobal(clone(FALLBACK_CONFIG), stock, onError);
}

export function loadStockDefaults(onError: OnError = noop): PermissionModeConfig {
  const config = loadRawStock(onError);
  expandAllModes(config, onError);
  validateExpandedModes(config, onError);
  return config;
}

/** Path to the user's global config (the one `/perm init` and persistence write). */
export function globalConfigFile(agentDir: string): string {
  return path.join(agentDir, "permission-mode", "permission-mode.json");
}

/**
 * The user's global config as written (only `$schema`/`$comment` stripped),
 * for the defaults audit - or undefined when absent or unparsable (the
 * loader reports parse errors separately).
 */
export function readGlobalConfigRaw(agentDir: string): Record<string, unknown> | undefined {
  const data = parseConfigFile(globalConfigFile(agentDir), noop) as Record<string, unknown> | undefined;
  if (data) delete data.$comment;
  return data;
}

export function loadModeConfig(cwd: string, agentDir: string, onError: OnError = noop): PermissionModeConfig {
  const projectPath = path.join(cwd, ".pi", "permission-mode.json");

  const config = loadGlobalModeConfig(agentDir, onError);
  const project = parseConfigFile(projectPath, onError);
  if (project) {
    try {
      applyProject(config, project, onError);
    } catch (e) {
      onError(`permission-mode: ignoring project config ${projectPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return config;
}

/** Stock defaults + the global layer, without the project overlay. */
export function loadGlobalModeConfig(agentDir: string, onError: OnError = noop): PermissionModeConfig {
  // Single expansion after both raw layers merge, so a global group
  // redefinition applies to every mode referencing it.
  let config = loadRawStock(onError);
  const global = parseConfigFile(globalConfigFile(agentDir), onError);
  if (global) config = mergeGlobal(config, global, onError);
  expandAllModes(config, onError);
  validateExpandedModes(config, onError);
  return config;
}

/**
 * Persist "allow forever" network domains for a mode to the global config.
 *
 * mergeGlobal replaces a mode's `network` object wholesale, so the WHOLE
 * effective allowlist must be written, not just the new entries. The base is
 * stock + global WITHOUT the project layer — a project's tighten-only
 * intersection must never be baked into the user's global config. Returns the
 * path written.
 */
/**
 * Read the global config file for a read-modify-write. A file that exists but
 * is not valid JSON (or not an object with an object `modes`) makes this
 * THROW: "Allow forever" must never replace the user's file wholesale because
 * of a stray comma. The callers surface the error; the session grant still
 * applies for this session.
 */
function readGlobalForWrite(file: string): Record<string, unknown> {
  if (!existsSync(file)) return { $schema: SCHEMA_URL };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}); fix it before saving a rule`);
  }
  if (!isPlainObject(data)) throw new Error(`${file} must contain a JSON object; fix it before saving a rule`);
  if (data.modes !== undefined && !isPlainObject(data.modes)) throw new Error(`${file}: "modes" must be an object; fix it before saving a rule`);
  return data;
}

export function persistModeDomains(agentDir: string, modeName: string, domains: string[]): string {
  const file = globalConfigFile(agentDir);
  if (UNSAFE_KEYS.has(modeName)) throw new Error(`invalid mode name "${modeName}"`);
  const base = loadGlobalModeConfig(agentDir);
  const baseNetwork = hasMode(base.modes, modeName) ? base.modes[modeName].sandbox.network : undefined;

  const data = readGlobalForWrite(file);
  const modes = (data.modes ??= {}) as Record<string, { sandbox?: { network?: Record<string, unknown> } }>;
  const mode = (modes[modeName] ??= {});
  const sandbox = (mode.sandbox ??= {});
  sandbox.network = {
    ...baseNetwork,
    allowedDomains: [...new Set([...(baseNetwork?.allowedDomains ?? []), ...domains])],
    deniedDomains: baseNetwork?.deniedDomains ?? [],
  };

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

/**
 * Persist a learned per-mode rule ("Allow forever") to the global config, e.g.
 * `modes.<mode>.permission.<surface>.<key> = "allow"`. Reads the existing file
 * (preserving the user's content incl. `$schema`), ensures the surface is a
 * pattern-map (seeding `"*": "ask"` so other names keep prompting), sets the
 * rule, and writes pretty JSON. Returns the path written.
 *
 * Global only: project config is tighten-only and cannot grant allows.
 */
export function persistModeRule(
  agentDir: string,
  modeName: string,
  surface: Surface,
  key: string,
  action: Action,
): string {
  const file = globalConfigFile(agentDir);
  if (UNSAFE_KEYS.has(modeName)) throw new Error(`invalid mode name "${modeName}"`);
  const data = readGlobalForWrite(file);
  const modes = (data.modes ??= {}) as Record<string, { permission?: Record<string, SurfaceValue> }>;
  const mode = (modes[modeName] ??= {});
  const permission = (mode.permission ??= {});
  const current = permission[surface];
  // Seed the map from what is in the FILE, else from the effective stock+global
  // surface value (the project overlay is never consulted: a project tighten
  // must not be baked into the user's global config), else "ask".
  let map: Record<string, PatternValue>;
  if (isPlainObject(current)) {
    map = { ...(current as Record<string, PatternValue>) };
  } else if (typeof current === "string") {
    map = { "*": current as Action };
  } else {
    const base = loadGlobalModeConfig(agentDir);
    const baseValue = hasMode(base.modes, modeName) ? base.modes[modeName].permission[surface] : undefined;
    map = typeof baseValue === "string" ? { "*": baseValue } : isPlainObject(baseValue) ? { ...(baseValue as Record<string, PatternValue>) } : {};
  }
  if (!("*" in map)) map["*"] = "ask"; // keep prompting for other names
  map[key] = action;
  permission[surface] = map;

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

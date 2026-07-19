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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Action,
  type ModeDef,
  type PermissionModeConfig,
  type SandboxProfile,
  type SurfaceValue,
  type Surface,
  SURFACES,
} from "./schema.ts";

type OnError = (message: string) => void;
const noop: OnError = () => {};

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

export interface SandboxConfig {
  enabled?: boolean;
  network?: { allowedDomains?: string[]; deniedDomains?: string[] };
  filesystem?: { denyRead?: string[]; allowWrite?: string[]; denyWrite?: string[] };
}

/** Project a mode's sandbox profile into the runtime's config shape. */
export function profileToConfig(p: SandboxProfile): SandboxConfig {
  return {
    enabled: p.enabled,
    network: p.network,
    filesystem: { denyRead: p.denyRead, allowWrite: p.allowWrite, denyWrite: p.denyWrite },
  };
}

/** Drop all project write access (Plan Mode runs bash read-only); reads/network stay. */
export function readOnlyOverride(config: SandboxConfig | undefined): Partial<SandboxConfig> {
  return { ...config, filesystem: { ...config?.filesystem, allowWrite: [] } };
}

/**
 * Reject domain patterns the sandbox-runtime schema would reject: bare `*`,
 * TLD-only wildcards like `*.com`, and anything carrying a protocol, path, or port.
 */
export function isUnsafeDomain(d: string): boolean {
  if (d === "*") return true;
  if (/[/:]/.test(d)) return true;
  if (/^\*\.[^.]+$/.test(d)) return true;
  return false;
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
 * Clean a raw permission object: drop unknown surfaces and coerce invalid action
 * values to "deny" (fail-safe), reporting each via onError. Warns on
 * array-index-like pattern keys, whose iteration order JS silently front-loads.
 */
function cleanPermission(raw: unknown, where: string, onError: OnError): Partial<Record<Surface, unknown>> {
  const out: Partial<Record<Surface, unknown>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
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
    } else if (value && typeof value === "object") {
      const map: Record<string, Action> = {};
      for (const [pat, act] of Object.entries(value as Record<string, unknown>)) {
        if (isIndexLikeKey(pat)) {
          onError(
            `permission-mode: pattern "${pat}" for ${key} in ${where} is a bare number — JS reorders such keys to the FRONT of the map, so last-match-wins may not follow file order; prefix or quote it differently (e.g. "./${pat}")`,
          );
        }
        if (isAction(act)) map[pat] = act;
        else onError(`permission-mode: invalid action "${act}" for ${key}.${pat} in ${where}; dropping`);
      }
      out[surface] = map;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Global (full-authority) merge
// ---------------------------------------------------------------------------

function mergeMode(base: ModeDef, over: Partial<ModeDef>): ModeDef {
  return {
    ...base,
    ...over,
    sandbox: over.sandbox ? { ...base.sandbox, ...over.sandbox } : base.sandbox,
    // Surface-level shallow merge: an override replaces a whole surface's value.
    permission: { ...base.permission, ...(over.permission ?? {}) },
    hideTools: over.hideTools ?? base.hideTools,
  };
}

function mergeGlobal(base: PermissionModeConfig, over: Partial<PermissionModeConfig>, onError: OnError): PermissionModeConfig {
  const modes: Record<string, ModeDef> = { ...base.modes };
  for (const [name, raw] of Object.entries(over.modes ?? {})) {
    const m = raw as Partial<ModeDef>;
    if (m.permission) m.permission = cleanPermission(m.permission, `global mode "${name}"`, onError) as ModeDef["permission"];
    const existing = modes[name];
    if (existing) {
      modes[name] = mergeMode(existing, m);
    } else if (m.sandbox && m.label && m.color) {
      modes[name] = m as ModeDef; // a complete new mode
    } else {
      onError(`permission-mode: ignoring incomplete new global mode "${name}" (needs label, color, sandbox)`);
    }
  }
  const cycleOrder = (over.cycleOrder ?? base.cycleOrder).filter((n) => modes[n]);
  let defaultMode = over.defaultMode ?? base.defaultMode;
  if (!modes[defaultMode]) defaultMode = cycleOrder[0] ?? base.defaultMode;
  return { defaultMode, cycleOrder, modes };
}

// ---------------------------------------------------------------------------
// Project (tighten-only) merge
// ---------------------------------------------------------------------------

function tightenSandbox(base: SandboxProfile, over: Partial<SandboxProfile>, onError: OnError): SandboxProfile {
  const result: SandboxProfile = { ...base, network: { ...base.network } };
  // Project overlays cannot change whether a mode is sandboxed. In particular,
  // they must never disable containment, and allowing them to enable a sparse
  // globally-unsandboxed profile would create a surprising, potentially
  // incomplete runtime configuration. Repeating the inherited value is a
  // harmless no-op; changing it is ignored with a warning.
  if (over.enabled !== undefined && over.enabled !== base.enabled) {
    onError(`permission-mode: project config cannot change sandbox.enabled; ignoring sandbox.enabled=${over.enabled}`);
  }
  if (over.writable === false) result.writable = false; // can force read-only, never re-enable writes
  if (over.askOnBlockedHost === false) result.askOnBlockedHost = false; // silent-deny is stricter than asking
  if (over.allowWrite !== undefined) result.allowWrite = intersect(base.allowWrite, over.allowWrite);
  if (over.denyRead !== undefined) result.denyRead = union(base.denyRead, over.denyRead);
  if (over.denyWrite !== undefined) result.denyWrite = union(base.denyWrite, over.denyWrite);
  if (over.network) {
    if (over.network.allowedDomains !== undefined) {
      const safe = over.network.allowedDomains.filter((d) => {
        if (isUnsafeDomain(d)) {
          onError(`permission-mode: ignoring overly-broad allowedDomains pattern "${d}" in project config`);
          return false;
        }
        return true;
      });
      result.network!.allowedDomains = intersect(base.network?.allowedDomains, safe);
    }
    if (over.network.deniedDomains !== undefined) {
      result.network!.deniedDomains = union(base.network?.deniedDomains, over.network.deniedDomains);
    }
  }
  return result;
}

function applyProject(config: PermissionModeConfig, project: Partial<PermissionModeConfig>, onError: OnError): void {
  if (project.defaultMode || project.cycleOrder) {
    onError("permission-mode: project config cannot change defaultMode/cycleOrder; ignoring");
  }
  for (const [name, raw] of Object.entries(project.modes ?? {})) {
    const base = config.modes[name];
    if (!base) {
      onError(`permission-mode: project config cannot add new mode "${name}"; ignoring`);
      continue;
    }
    const pm = raw as Partial<ModeDef>;
    if (pm.sandbox) base.sandbox = tightenSandbox(base.sandbox, pm.sandbox, onError);
    if (pm.permission) {
      // Attach as a most-restrictive overlay — provably tighten-only.
      base.projectOverlay = cleanPermission(pm.permission, `project mode "${name}"`, onError) as ModeDef["permission"];
    }
    // label/color/systemPrompt/hideTools/bypassProtectedPaths from a project are
    // ignored: they're cosmetic or could loosen, neither of which a project may do.
  }
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Strip `$schema` and parse a config file, or undefined (reporting parse errors). */
function parseConfigFile(p: string, onError: OnError): Partial<PermissionModeConfig> | undefined {
  if (!existsSync(p)) return undefined;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as Partial<PermissionModeConfig>;
    delete (data as { $schema?: unknown }).$schema;
    return data;
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
export function loadStockDefaults(onError: OnError = noop): PermissionModeConfig {
  const stock = parseConfigFile(stockDefaultsFile(), onError);
  if (!stock) {
    onError("permission-mode: stock defaults (permission-mode.defaults.json) missing or invalid — using minimal fallback; reinstall the extension");
    return clone(FALLBACK_CONFIG);
  }
  return mergeGlobal(clone(FALLBACK_CONFIG), stock, onError);
}

/** Path to the user's global config (the one `/perm init` and persistence write). */
export function globalConfigFile(agentDir: string): string {
  return path.join(agentDir, "permission-mode", "permission-mode.json");
}

export function loadModeConfig(cwd: string, agentDir: string, onError: OnError = noop): PermissionModeConfig {
  const projectPath = path.join(cwd, ".pi", "permission-mode.json");

  let config = loadStockDefaults(onError);
  const global = parseConfigFile(globalConfigFile(agentDir), onError);
  if (global) config = mergeGlobal(config, global, onError);
  const project = parseConfigFile(projectPath, onError);
  if (project) applyProject(config, project, onError);
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
export function persistModeDomains(agentDir: string, modeName: string, domains: string[]): string {
  const file = globalConfigFile(agentDir);
  let base = loadStockDefaults();
  const global = parseConfigFile(file, noop);
  if (global) base = mergeGlobal(base, structuredClone(global), noop);
  const baseNetwork = base.modes[modeName]?.sandbox.network;

  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch {
      data = {}; // unreadable/corrupt → start fresh rather than lose the grant
    }
  }
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
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch {
      data = {}; // unreadable/corrupt → start fresh rather than lose the grant
    }
  }
  const modes = (data.modes ??= {}) as Record<string, { permission?: Record<string, SurfaceValue> }>;
  const mode = (modes[modeName] ??= {});
  const permission = (mode.permission ??= {});
  const current = permission[surface];
  const map: Record<string, Action> =
    typeof current === "string" ? { "*": current } : { ...(current as Record<string, Action> | undefined) };
  if (!("*" in map)) map["*"] = "ask"; // keep prompting for other names
  map[key] = action;
  permission[surface] = map;

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

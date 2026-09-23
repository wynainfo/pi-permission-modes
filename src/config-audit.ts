/**
 * Config audit - keeps a user's global permission-mode.json from silently
 * falling behind the shipped defaults.
 *
 * `/perm init` copies the full stock defaults so users can edit values in
 * place, which is convenient but pins them to the defaults of whatever
 * version they ran it on: a later tightening (2.3.0 narrowed `allowWrite`
 * from /tmp to /tmp/pi) never reaches a global file that still says /tmp,
 * because the global layer has full authority. Two mechanisms close that gap:
 *
 *   1. Stale-default detection (every session start). Each leaf the global
 *      file sets - a mode's `sandbox.allowWrite`, a `permission.write`, the
 *      top-level `cycleOrder`, ... - is compared with the CURRENT default and
 *      with every OLDER default shipped since 2.0.0 (`defaults-history.json`,
 *      clear-text copies with a version range). A value equal to the current
 *      default is redundant and silent; one that differs from the current
 *      default but equals an older one is STALE and is reported with the
 *      versions it belonged to; one equal to no default at all is a deliberate
 *      customization and silent. Custom modes never match anything.
 *   2. Upgrade notice (once per version change). The last extension version
 *      seen is recorded in `<agentDir>/permission-mode/state.json`; when it
 *      differs from the running version AND the defaults changed between the
 *      two, users with a global config are told which fields changed, so a
 *      heavily customized file gets a nudge to compare even when nothing in
 *      it matches an old default verbatim.
 *
 * `"acknowledgeDefaults": "<version>"` in the global file suppresses stale
 * warnings while the running defaults still equal that version's defaults;
 * the next default change resumes them.
 *
 * The comparisons are pure; only the loaders touch the filesystem.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** One shipped defaults version: the clear-text defaults for a version range. */
export interface DefaultsVersion {
  from: string;
  to: string;
  defaults: unknown;
}

/** A leaf in the user's global config that still holds an outdated default. */
export interface StaleFinding {
  /** Dotted leaf path, e.g. `modes.build.sandbox.allowWrite`. */
  path: string;
  value: unknown;
  currentValue: unknown;
  /** Version range that shipped `value` as its default. */
  from: string;
  to: string;
}

/** Semver-ish compare on dotted numeric versions (pre-release tags ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split("-")[0].split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Order-sensitive structural equality (pattern-map key order is semantic). */
export const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Flatten a config into the leaves the audit compares: `defaultMode`,
 * `cycleOrder`, and per mode each direct field plus each key under `sandbox`
 * and `permission`. Only keys present in `raw` are yielded.
 */
export function configLeaves(raw: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!isObject(raw)) return out;
  for (const k of ["defaultMode", "cycleOrder"]) if (k in raw) out.set(k, raw[k]);
  const modes = isObject(raw.modes) ? raw.modes : {};
  for (const [name, m] of Object.entries(modes)) {
    if (!isObject(m)) continue;
    for (const [k, v] of Object.entries(m)) {
      if ((k === "sandbox" || k === "permission") && isObject(v)) {
        for (const [k2, v2] of Object.entries(v)) out.set(`modes.${name}.${k}.${k2}`, v2);
      } else {
        out.set(`modes.${name}.${k}`, v);
      }
    }
  }
  return out;
}

/** The defaults that shipped with `version`: the current ones, or a history entry covering it. */
export function defaultsFor(
  version: string,
  current: { version: string; defaults: unknown },
  history: DefaultsVersion[],
): unknown | undefined {
  if (version === current.version) return current.defaults;
  const hit = history.find((h) => compareVersions(h.from, version) <= 0 && compareVersions(version, h.to) <= 0);
  return hit?.defaults;
}

/**
 * Leaves of the user's global config that still hold an outdated default.
 * `acknowledged` suppresses everything while the current defaults equal the
 * acknowledged version's defaults.
 */
export function auditStaleDefaults(
  raw: unknown,
  current: { version: string; defaults: unknown },
  history: DefaultsVersion[],
  acknowledged?: string,
): StaleFinding[] {
  if (acknowledged) {
    const ackDefaults = defaultsFor(acknowledged, current, history);
    if (ackDefaults !== undefined && sameValue(ackDefaults, current.defaults)) return [];
  }
  const cur = configLeaves(current.defaults);
  const hist = [...history]
    .sort((a, b) => compareVersions(b.to, a.to)) // newest range first
    .map((h) => ({ ...h, leaves: configLeaves(h.defaults) }));
  const findings: StaleFinding[] = [];
  for (const [p, value] of configLeaves(raw)) {
    if (!cur.has(p)) continue; // custom mode / unknown field: nothing to compare against
    const currentValue = cur.get(p);
    if (sameValue(value, currentValue)) continue; // redundant copy of the current default
    // A value may have shipped unchanged across several ranges: report the
    // whole span (earliest `from` to latest `to` among the matching entries).
    const matches = hist.filter((h) => h.leaves.has(p) && sameValue(h.leaves.get(p), value));
    if (matches.length > 0) {
      const from = matches.reduce((a, h) => (compareVersions(h.from, a) < 0 ? h.from : a), matches[0].from);
      const to = matches.reduce((a, h) => (compareVersions(h.to, a) > 0 ? h.to : a), matches[0].to);
      findings.push({ path: p, value, currentValue, from, to });
    }
  }
  return findings;
}

/**
 * Leaf paths whose default changed between `fromVersion`'s defaults and the
 * current ones (for the one-time upgrade notice). Empty when `fromVersion`
 * is unknown or nothing changed.
 */
export function defaultsChangedSince(
  fromVersion: string,
  current: { version: string; defaults: unknown },
  history: DefaultsVersion[],
): string[] {
  const old = defaultsFor(fromVersion, current, history);
  if (old === undefined) return [];
  const a = configLeaves(old);
  const b = configLeaves(current.defaults);
  const changed: string[] = [];
  for (const p of new Set([...a.keys(), ...b.keys()])) {
    if (!sameValue(a.get(p), b.get(p))) changed.push(p);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Shipped data + persisted state (filesystem)
// ---------------------------------------------------------------------------

const pkgRoot = (): URL => new URL("../", import.meta.url);

/** The running extension's version, from its package.json. */
export function extensionVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("package.json", pkgRoot())), "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The shipped `defaults-history.json` (older defaults with their version ranges), or [] if unreadable. */
export function loadDefaultsHistory(): DefaultsVersion[] {
  try {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL("defaults-history.json", pkgRoot())), "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (h): h is DefaultsVersion => isObject(h) && typeof h.from === "string" && typeof h.to === "string" && "defaults" in h,
    );
  } catch {
    return [];
  }
}

export interface AuditState {
  /** The extension version that last ran with this agent dir. */
  lastVersion?: string;
}

export function auditStateFile(agentDir: string): string {
  return path.join(agentDir, "permission-mode", "state.json");
}

export function readAuditState(agentDir: string): AuditState {
  try {
    const raw = JSON.parse(readFileSync(auditStateFile(agentDir), "utf-8")) as unknown;
    return isObject(raw) && typeof raw.lastVersion === "string" ? { lastVersion: raw.lastVersion } : {};
  } catch {
    return {};
  }
}

/** Best-effort write; a read-only agent dir just means the notice repeats next time. */
export function writeAuditState(agentDir: string, state: AuditState): boolean {
  try {
    const file = auditStateFile(agentDir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Render one stale finding as a single warning line. */
export function describeStale(f: StaleFinding): string {
  const range = f.from === f.to ? f.from : `${f.from} to ${f.to}`;
  return `${f.path} still holds the ${range} default ${JSON.stringify(f.value)}; the current default is ${JSON.stringify(f.currentValue)}`;
}

/** True when `agentDir` has a global config file (the audit only applies then). */
export function hasGlobalConfig(agentDir: string): boolean {
  return existsSync(path.join(agentDir, "permission-mode", "permission-mode.json"));
}

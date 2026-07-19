/**
 * Tests for awareness.ts — the sandbox-boundary system-prompt section.
 * Pure module, no SDK: shapes mirror the stock Default/Plan/YOLO modes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { sandboxAwarenessPrompt } from "./awareness.ts";
import type { ModeDef } from "./schema.ts";

const DOMAINS = ["registry.npmjs.org", "pypi.org", "github.com"];

function mode(over: Partial<ModeDef> = {}, sandboxOver: Partial<ModeDef["sandbox"]> = {}): ModeDef {
  return {
    label: "Default",
    color: "muted",
    sandbox: {
      enabled: true,
      writable: true,
      allowWrite: [".", "/tmp"],
      denyWrite: [],
      denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
      network: { allowedDomains: DOMAINS, deniedDomains: [] },
      ...sandboxOver,
    },
    permission: {},
    ...over,
  };
}

test("writable sandboxed mode: renders paths, secrets, domains, and the prompt flow", () => {
  const out = sandboxAwarenessPrompt(mode(), { active: true });
  assert.ok(out);
  assert.match(out, /^## Sandbox & permissions \(Default\)\n/);
  assert.match(out, /Writable paths: the project directory, \/tmp\./); // "." rendered friendly
  for (const p of ["~/.ssh", "~/.aws", "~/.gnupg"]) assert.ok(out.includes(p), `denyRead ${p} listed`);
  for (const d of DOMAINS) assert.ok(out.includes(d), `domain ${d} listed`);
  assert.match(out, /asked for permission automatically/); // boundary-crossing is fine to issue
  assert.match(out, /protected paths/);
  assert.match(out, /blocked it silently/); // the no-prompt failure guidance
  assert.doesNotMatch(out, /write-denied/); // empty denyWrite → no bullet
});

test("read-only mode: says READ-ONLY instead of listing writable paths", () => {
  const out = sandboxAwarenessPrompt(mode({ label: "Plan Mode" }, { writable: false }), { active: true });
  assert.ok(out);
  assert.match(out, /\(Plan Mode\)/);
  assert.match(out, /READ-ONLY/);
  assert.match(out, /Write\/Edit tools/);
  assert.doesNotMatch(out, /Writable paths:/);
});

test("empty network allowlist: says bash has no network", () => {
  const out = sandboxAwarenessPrompt(mode({}, { network: { allowedDomains: [], deniedDomains: [] } }), { active: true });
  assert.ok(out);
  assert.match(out, /No network access from bash/);
  const noNet = sandboxAwarenessPrompt(mode({}, { network: undefined }), { active: true });
  assert.match(noNet ?? "", /No network access from bash/);
});

test("denyWrite entries are listed when present", () => {
  const out = sandboxAwarenessPrompt(mode({}, { denyWrite: ["dist", "vendor"] }), { active: true });
  assert.match(out ?? "", /write-denied: dist, vendor\./);
});

test("bypassProtectedPaths drops the protected-path clause", () => {
  const out = sandboxAwarenessPrompt(mode({ bypassProtectedPaths: true }), { active: true });
  assert.ok(out);
  assert.doesNotMatch(out, /protected paths/);
  assert.match(out, /policy-gated/); // the file-tools line itself stays
});

test("unsandboxed mode (YOLO): no injection", () => {
  const yolo = mode({ label: "YOLO", bypassProtectedPaths: true }, { enabled: false });
  assert.equal(sandboxAwarenessPrompt(yolo, { active: false }), undefined);
});

test("injectSandboxInfo:false opts out entirely", () => {
  assert.equal(sandboxAwarenessPrompt(mode({ injectSandboxInfo: false }), { active: true }), undefined);
  assert.equal(sandboxAwarenessPrompt(mode({ injectSandboxInfo: false }), { active: false }), undefined);
});

test("degraded: short note with the reason, no boundary bullets", () => {
  const out = sandboxAwarenessPrompt(mode(), { active: false, reason: "disabled via --no-sandbox" });
  assert.ok(out);
  assert.match(out, /^## Sandbox & permissions \(Default\)\n/);
  assert.match(out, /sandbox is unavailable here \(disabled via --no-sandbox\)/);
  assert.match(out, /confirmation instead/);
  assert.doesNotMatch(out, /Writable paths:/);
  for (const d of DOMAINS) assert.ok(!out.includes(d), `domain ${d} not listed in degraded note`);
  // No reason → the parenthetical is omitted, not rendered empty.
  const bare = sandboxAwarenessPrompt(mode(), { active: false });
  assert.match(bare ?? "", /unavailable here\.\n/);
});

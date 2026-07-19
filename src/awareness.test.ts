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

test("empty network allowlist: says nothing is allowlisted, still offers the ask flow", () => {
  const out = sandboxAwarenessPrompt(mode({}, { network: { allowedDomains: [], deniedDomains: [] } }), { active: true });
  assert.ok(out);
  assert.match(out, /No domains are allowlisted/);
  assert.match(out, /request_network_access/);
  const noNet = sandboxAwarenessPrompt(mode({}, { network: undefined }), { active: true });
  assert.match(noNet ?? "", /No domains are allowlisted/);
});

test("network bullet: live-ask flow and the request tool are explained", () => {
  const out = sandboxAwarenessPrompt(mode(), { active: true });
  assert.match(out ?? "", /pauses while the user is asked/);
  assert.match(out ?? "", /request_network_access/);
});

test("network bullet: session-granted domains are listed alongside the mode allowlist", () => {
  const out = sandboxAwarenessPrompt(mode(), { active: true, sessionDomains: ["api.internal.io"] });
  assert.match(out ?? "", /api\.internal\.io/);
});

test("networkOpen: says filtering is disabled instead of listing domains", () => {
  const out = sandboxAwarenessPrompt(mode(), { active: true, networkOpen: true });
  assert.ok(out);
  assert.match(out, /Network filtering is disabled for this session/);
  assert.ok(!out.includes("registry.npmjs.org"));
});

test("askOnBlockedHost:false: silent-deny wording, tool still offered", () => {
  const out = sandboxAwarenessPrompt(mode({}, { askOnBlockedHost: false }), { active: true });
  assert.match(out ?? "", /silently unreachable/);
  assert.match(out ?? "", /request_network_access/);
  assert.doesNotMatch(out ?? "", /pauses while the user is asked/);
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

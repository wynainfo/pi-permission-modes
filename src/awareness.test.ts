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
      allowWrite: [".", "/tmp/pi"],
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
  assert.match(out, /Writable paths: the project directory, \/tmp\/pi\./); // "." rendered friendly
  assert.doesNotMatch(out, /scratch directory/); // none given → no scratch bullet
  for (const p of ["~/.ssh", "~/.aws", "~/.gnupg"]) assert.ok(out.includes(p), `denyRead ${p} listed`);
  for (const d of DOMAINS) assert.ok(out.includes(d), `domain ${d} listed`);
  assert.match(out, /asked for permission automatically/); // boundary-crossing is fine to issue
  assert.match(out, /protected paths/);
  assert.match(out, /blocked it silently/); // the no-prompt failure guidance
  assert.doesNotMatch(out, /write-denied/); // empty denyWrite → no bullet
});

test("background processes: the teardown caveat is stated when the sandbox is active, not when degraded", () => {
  const active = sandboxAwarenessPrompt(mode(), { active: true }) ?? "";
  assert.match(active, /Background processes do not outlive the command/);
  assert.match(active, /`&`, `nohup`, and `setsid` cannot start anything long-running/);
  // Read-only bash (Plan) is sandboxed the same way.
  assert.match(sandboxAwarenessPrompt(mode({}, { writable: false }), { active: true }) ?? "", /do not outlive the command/);
  // Degraded: commands run unconfined, background jobs work as usual, so no caveat.
  assert.doesNotMatch(sandboxAwarenessPrompt(mode(), { active: false, reason: "x" }) ?? "", /outlive/);
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
  // No allowlist at all: the runtime does not filter, and the model is told so.
  const noNet = sandboxAwarenessPrompt(mode({}, { network: undefined }), { active: true });
  assert.match(noNet ?? "", /Network is unrestricted in this mode/);
  assert.doesNotMatch(noNet ?? "", /No domains are allowlisted|request_network_access/);
  // Open for the session, with denied domains: those stay unreachable.
  const open = sandboxAwarenessPrompt(mode({}, { network: { allowedDomains: ["a.com"], deniedDomains: ["evil.com"] } }), { active: true, networkOpen: true });
  assert.match(open ?? "", /all hosts are reachable from bash except the mode's denied domains \(evil\.com\)/);
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

test("unsandboxed mode (YOLO): no injection without a scratch dir, a short scratch section with one", () => {
  const yolo = mode({ label: "YOLO", bypassProtectedPaths: true }, { enabled: false });
  assert.equal(sandboxAwarenessPrompt(yolo, { active: false }), undefined);
  const out = sandboxAwarenessPrompt(yolo, { active: false, scratchDir: "/tmp/pi/sess-1" });
  assert.ok(out);
  assert.match(out, /^## Scratch directory \(YOLO\)\n/);
  assert.match(out, /Bash runs unsandboxed in this mode\./);
  assert.match(out, /scratch directory: \/tmp\/pi\/sess-1 \(\$TMPDIR inside bash points there\)/);
  assert.doesNotMatch(out, /Sandbox & permissions|Writable paths|Network/); // nothing else to brief
  // The opt-out covers the scratch section too.
  assert.equal(sandboxAwarenessPrompt(mode({ injectSandboxInfo: false }, { enabled: false }), { active: false, scratchDir: "/tmp/pi/s" }), undefined);
});

test("scratch dir: its own bullet in a writable sandboxed mode, listed once, mentioned when degraded, absent read-only", () => {
  const dir = "/tmp/pi/sess-1";
  const out = sandboxAwarenessPrompt(mode({}, { allowWrite: [".", "/tmp/pi", dir] }), { active: true, scratchDir: dir });
  assert.ok(out);
  assert.match(out, /- Writable paths: the project directory, \/tmp\/pi\. Use them for installs and build output/); // not listed there
  assert.match(out, /\n- Keep temporary files, downloads, and throwaway scripts in this session's scratch directory: \/tmp\/pi\/sess-1 /);
  assert.equal(out.split(dir).length - 1, 1); // exactly one mention
  assert.match(out, /cleaned up automatically/);
  // Degraded: the short note still names the scratch dir (bounds still apply, no prompt there).
  const degraded = sandboxAwarenessPrompt(mode(), { active: false, reason: "x", scratchDir: dir });
  assert.match(degraded ?? "", /scratch directory: \/tmp\/pi\/sess-1/);
  // Read-only bash (Plan): nothing can be written there from bash, so it isn't advertised.
  const ro = sandboxAwarenessPrompt(mode({ label: "Plan Mode" }, { writable: false }), { active: true, scratchDir: dir });
  assert.doesNotMatch(ro ?? "", /scratch directory/);
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

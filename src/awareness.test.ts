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

test("masked ~/.ssh: the SSH bullet rules out ssh, names HTTPS, a PAT, and the ! prefix, only when the keys are masked", () => {
  const ssh = /SSH keys are unreadable/;
  const out = sandboxAwarenessPrompt(mode(), { active: true })!;
  assert.match(out, ssh);
  assert.match(out, /do not use ssh/);
  assert.match(out, /insteadOf=git@github\.com: fetch/);
  assert.match(out, /fine-grained personal access token/);
  assert.doesNotMatch(out, /\bgh\b/, "gh is not recommended while its login stays readable");
  assert.match(out, /`!git clone <url>`, later `!git push`/);
  assert.match(sandboxAwarenessPrompt(mode({}, { denyRead: ["~"] }), { active: true })!, ssh, "a strict home masks ~/.ssh too");
  assert.doesNotMatch(sandboxAwarenessPrompt(mode({}, { denyRead: ["~/.aws"] }), { active: true })!, ssh);
  assert.doesNotMatch(sandboxAwarenessPrompt(mode({}, { denyRead: ["~"], allowRead: ["~/.ssh"] }), { active: true })!, ssh, "readable again");
  assert.doesNotMatch(sandboxAwarenessPrompt(mode({}, { denyRead: ["~/.ssh-other"] }), { active: true })!, ssh, "a sibling name is not a parent");
});

test("allowRead: the carve-outs are listed right after the denied paths, with '.' rendered as the project", () => {
  const out = sandboxAwarenessPrompt(mode({}, { denyRead: ["~"], allowRead: [".", "~/.cache"] }), { active: true })!;
  assert.match(out, /Reads are broadly allowed EXCEPT: ~\.\n- Readable again inside those denied paths: the project directory, ~\/\.cache\. Anything else under a denied path reads as absent\./);
  assert.doesNotMatch(sandboxAwarenessPrompt(mode(), { active: true })!, /Readable again/);
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

test("sandbox.linux: the nested-namespace line renders on linux only, and only while the switch is off", () => {
  const ns = /cannot create a user namespace here \(EPERM\)/;
  const stock = sandboxAwarenessPrompt(mode(), { active: true, platform: "linux" })!;
  assert.match(stock, ns);
  assert.match(stock, /docs\/troubleshooting\.md#nested-sandboxes-on-linux/);
  const on = sandboxAwarenessPrompt(mode({}, { linux: { allowNestedUserNamespaces: true } }), { active: true, platform: "linux" })!;
  assert.doesNotMatch(on, ns);
  // Not tied to the network branch: an open or unrestricted network still gets the line.
  const open = sandboxAwarenessPrompt(mode(), { active: true, platform: "linux", networkOpen: true })!;
  assert.match(open, ns);
  const darwin = sandboxAwarenessPrompt(mode(), { active: true, platform: "darwin" })!;
  assert.doesNotMatch(darwin, ns);
});

test("sandbox.allowLocalBinding: the server line per platform, the direct-loopback sentence on darwin, the Go TLS line on darwin only", () => {
  const loop = /Loopback services .* reachable directly/;
  const listens = /A server you start within a command listens for real/;
  const inside = /listens inside the sandbox only/;
  const go = /Go programs .* cannot verify TLS/;
  // Linux: the server is unreachable from the host whatever the setting says; no darwin lines.
  for (const sb of [{}, { allowLocalBinding: false }]) {
    const linux = sandboxAwarenessPrompt(mode({}, sb), { active: true, platform: "linux" })!;
    assert.match(linux, inside);
    assert.doesNotMatch(linux, listens);
    assert.doesNotMatch(linux, loop);
    assert.doesNotMatch(linux, go);
  }
  // darwin, stock (local binding on by default): server line, direct loopback; the Go TLS line names the trustd denial and its docs section.
  const stock = sandboxAwarenessPrompt(mode(), { active: true, platform: "darwin" })!;
  assert.match(stock, listens);
  assert.match(stock, loop);
  assert.match(stock, go);
  assert.match(stock, /docs\/troubleshooting\.md#macos-go-tls/);
  // darwin, both open: no Go TLS line.
  const on = sandboxAwarenessPrompt(mode({}, { macos: { enableWeakerNetworkIsolation: true } }), { active: true, platform: "darwin" })!;
  assert.match(on, loop);
  assert.doesNotMatch(on, go);
  const silent = sandboxAwarenessPrompt(mode({}, { askOnBlockedHost: false }), { active: true, platform: "darwin" })!;
  assert.match(silent, loop);
  assert.match(silent, /silently unreachable/);
  // darwin, off: no listening, loopback through the proxy only, with the docs section.
  const off = sandboxAwarenessPrompt(mode({}, { allowLocalBinding: false }), { active: true, platform: "darwin" })!;
  assert.doesNotMatch(off, listens);
  assert.doesNotMatch(off, loop);
  assert.match(off, /Local binding is off .* cannot listen on a port/);
  assert.match(off, /docs\/troubleshooting\.md#macos-loopback-services/);
  // The direct-loopback sentence and the Go TLS line belong to the filtered branch only; the server line stays.
  const noNet = sandboxAwarenessPrompt(mode({}, { network: undefined }), { active: true, platform: "darwin" })!;
  assert.match(noNet, /Network is unrestricted/);
  assert.match(noNet, listens);
  assert.doesNotMatch(noNet, loop);
  assert.doesNotMatch(noNet, go);
  const open = sandboxAwarenessPrompt(mode(), { active: true, platform: "darwin", networkOpen: true })!;
  assert.match(open, listens);
  assert.doesNotMatch(open, loop);
  assert.doesNotMatch(open, go);
  // Windows: the installed loopback mode decides, not the mode's key (windowsLoopback is what the install reports).
  const win = sandboxAwarenessPrompt(mode({}, { allowLocalBinding: false }), { active: true, platform: "win32", windowsLoopback: true })!;
  assert.match(win, listens);
  assert.doesNotMatch(win, loop);
  const winOff = sandboxAwarenessPrompt(mode(), { active: true, platform: "win32", windowsLoopback: false })!;
  assert.doesNotMatch(winOff, listens);
  assert.match(winOff, /Local binding is closed on this machine .* cannot listen on a port/);
  assert.doesNotMatch(winOff, /macos-loopback-services/);
  // Without the install's answer (no sandbox yet) the mode's key stands in.
  assert.match(sandboxAwarenessPrompt(mode(), { active: true, platform: "win32" })!, listens);
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

test("win32: the Windows lines name the account, what is readable, the denies and the revocation workaround; the Linux read lines are replaced", () => {
  const home = sandboxAwarenessPrompt(mode({}, { allowRead: ["~"] }), { active: true, platform: "win32" })!;
  assert.match(home, /native Windows sandbox: commands run in Git Bash as a separate local account \(srt-sandbox\)\. Readable: the project, Windows and Program Files, your user profile \(~\), EXCEPT ~\/\.ssh, ~\/\.aws, ~\/\.gnupg\./);
  assert.doesNotMatch(home, /Reads are broadly allowed/);
  assert.doesNotMatch(home, /Readable again inside/);
  assert.doesNotMatch(home, /command not found/);
  assert.match(home, /git over HTTPS and cargo are already told to skip them; System32 curl needs --ssl-no-revoke/);
  assert.match(home, /docs\/sandbox\.md#windows/);
  assert.match(home, /docs\/troubleshooting\.md#tls-revocation-on-windows/);
  assert.match(home, /A server you start within a command listens for real: the user can open it in a browser while the command runs/);
  assert.doesNotMatch(sandboxAwarenessPrompt(mode(), { active: true, platform: "linux" })!, /listens for real/);
  // ~/.ssh is denied beneath the ~ grant: the SSH advice still applies.
  assert.match(home, /SSH keys are unreadable/);
  const strict = sandboxAwarenessPrompt(mode({}, { denyRead: ["~"], allowRead: ["~/.gitconfig"] }), { active: true, platform: "win32" })!;
  assert.match(strict, /Readable: the project, Windows and Program Files, ~\/\.gitconfig, EXCEPT ~\./);
  assert.match(strict, /command not found.*docs\/troubleshooting\.md#per-user-tools-on-windows/);
  const linux = sandboxAwarenessPrompt(mode(), { active: true, platform: "linux" })!;
  assert.doesNotMatch(linux, /native Windows sandbox/);
  assert.match(linux, /Reads are broadly allowed EXCEPT/);
  // Without any deny the keys are still out of reach on Windows (nothing of the profile is granted).
  const noDeny = sandboxAwarenessPrompt(mode({}, { denyRead: [] }), { active: true, platform: "win32" })!;
  assert.match(noDeny, /SSH keys are unreadable/);
  assert.match(noDeny, /Do not ask for the token in chat or put one on a command line/);
  const sshGranted = sandboxAwarenessPrompt(mode({}, { denyRead: [], allowRead: ["~/.ssh"] }), { active: true, platform: "win32" })!;
  assert.doesNotMatch(sshGranted, /SSH keys are unreadable/);
});

test("masksSshKeys: the most specific entry decides (an allow of ~ above a deny of ~/.ssh still masks; an allow of ~/.ssh re-opens)", () => {
  const masked = sandboxAwarenessPrompt(mode({}, { allowRead: ["~"] }), { active: true })!;
  assert.match(masked, /SSH keys are unreadable/);
  const open = sandboxAwarenessPrompt(mode({}, { allowRead: ["~/.ssh"] }), { active: true })!;
  assert.doesNotMatch(open, /SSH keys are unreadable/);
});

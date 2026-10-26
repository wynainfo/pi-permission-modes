import assert from "node:assert/strict";
import test from "node:test";
import type { ModeDef } from "./schema.ts";
import { updateStatus } from "./status.ts";

const ctx = () => {
  let status = "";
  return {
    ui: { theme: { fg: (_c: string, t: string) => t }, setStatus: (_k: string, v: string) => void (status = v) },
    get status() {
      return status;
    },
  };
};
const mode = (sandbox: ModeDef["sandbox"]): ModeDef => ({ label: "Build", color: "accent", sandbox, permission: {} });

test("updateStatus: a switch in flight is marked while the sandbox enforces", () => {
  const c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: ["a.com"] } }), { ready: true, warn: undefined, disabled: false, switching: true }, false);
  assert.match(c.status, /\(applying sandbox profile\.\.\.\)/);
  assert.doesNotMatch(c.status, /sandboxed in project dir/);
  updateStatus(c as never, mode({ enabled: true, writable: true }), { ready: false, warn: "x", disabled: false, switching: true }, false);
  assert.doesNotMatch(c.status, /applying sandbox profile/);
  // A long sandbox step (the Windows install) shows as busy, in place of the warn and the switch mark.
  updateStatus(c as never, mode({ enabled: true, writable: true }), { ready: false, warn: "x", disabled: false, switching: true }, false, { busy: "profile read grant, 42 s" });
  assert.equal(c.status, "Build (sandbox: profile read grant, 42 s)  Network: open");
});

test("updateStatus: filtered / open / unrestricted / degraded", () => {
  const ready = { ready: true, warn: undefined, disabled: false };
  let c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: ["a.com"] } }), ready, false);
  assert.equal(c.status, "Build (sandboxed in project dir, alt+m)  Network: filtered (alt+n)");
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: [] } }), ready, true);
  assert.equal(c.status, "Build (sandboxed in project dir, alt+m)  Network: open (alt+n)");
  // No allowlist configured: the runtime does not filter, and the chip must not claim it does.
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true }), ready, false);
  assert.equal(c.status, "Build (sandboxed in project dir, alt+m)  Network: unrestricted");
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: ["a.com"] } }), { ready: false, warn: "sandbox init failed", disabled: false }, false);
  assert.equal(c.status, "Build (alt+m) (!) sandbox init failed  Network: open");
});

test("updateStatus: the warn is suppressed under --no-sandbox, and a mode without a sandbox never claims one", () => {
  // Ported from PR #9 by ammoniak.
  let c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: ["a.com"] } }), { ready: false, warn: "some warning", disabled: true }, false);
  assert.equal(c.status, "Build (alt+m)  Network: open", "disabled on purpose: no (!) for a warn that explains an unwanted sandbox");
  c = ctx();
  updateStatus(c as never, mode({ enabled: false, writable: true }), { ready: true, warn: undefined, disabled: false }, false);
  assert.equal(c.status, "Build (alt+m)  Network: open", "sandbox off in the mode: neither sandboxed nor filtered, whatever the controller says");
  c = ctx();
  updateStatus(c as never, mode({ enabled: true, writable: true, network: { allowedDomains: ["a.com"] } }), { ready: false, warn: undefined, disabled: false }, true);
  assert.equal(c.status, "Build (alt+m)  Network: open", "not ready and no reason yet: plain, and the open toggle is not shown as a chip");
});

test("updateStatus: a pending verdict shows (judging...) in place of the sandbox text", () => {
  const c = ctx();
  const mode = { label: "Auto", color: "warning", sandbox: { enabled: true, writable: true, network: { allowedDomains: ["a"] } }, permission: {} } as never;
  updateStatus(c as never, mode, { ready: true, warn: undefined, disabled: false }, false, { judging: true });
  assert.match(c.status, /^Auto \(judging\.\.\.\)  Network: filtered/);
  updateStatus(c as never, mode, { ready: true, warn: undefined, disabled: false }, false, { judging: false });
  assert.match(c.status, /^Auto \(sandboxed in project dir, alt\+m\)/);
});

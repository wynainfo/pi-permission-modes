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
  updateStatus(c as never, mode({ enabled: true, writable: true }), { ready: false, warn: "x", disabled: false, switching: true }, false, "profile read grant, 42 s");
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

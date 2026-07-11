import assert from "node:assert/strict";
import test from "node:test";
import { type BashGate, bashExecPlan, bashGate } from "./bash-enforce.ts";

const OUTSIDE = "path outside project: /etc/passwd";

test("bashGate: sandbox disabled (YOLO) always allows, never prompts", () => {
  for (const ready of [true, false]) {
    assert.equal(bashGate("allow", undefined, false, ready).kind, "allow");
    assert.equal(bashGate("allow", OUTSIDE, false, ready).kind, "allow"); // even an escape
    assert.equal(bashGate("ask", undefined, false, ready).kind, "allow");
  }
});

test("bashGate: escape / privilege prompts and runs unsandboxed on approval", () => {
  const g = bashGate("allow", OUTSIDE, true, true);
  assert.equal(g.kind, "prompt");
  assert.equal(g.onApproveUnsandboxed, true);
  assert.ok(g.title.includes(OUTSIDE), g.title);
});

test("bashGate: in-project + sandbox down → prompt, unsandboxed (degraded fallback)", () => {
  const g = bashGate("allow", undefined, true, false);
  assert.equal(g.kind, "prompt");
  assert.equal(g.onApproveUnsandboxed, true);
  assert.match(g.title, /sandbox unavailable/);
});

test("bashGate: in-project, sandbox ready — action drives it", () => {
  assert.deepEqual(bashGate("allow", undefined, true, true), {
    kind: "allow",
    title: "",
    reason: "",
    onApproveUnsandboxed: false,
  } satisfies BashGate);
  const ask = bashGate("ask", undefined, true, true);
  assert.equal(ask.kind, "prompt");
  assert.equal(ask.onApproveUnsandboxed, false); // approved → still sandboxed
});

test("bashGate: deny blocks regardless of sandbox state", () => {
  for (const enabled of [true, false]) {
    assert.equal(bashGate("deny", undefined, enabled, true).kind, "block");
  }
});

test("bashExecPlan: sandboxed iff enabled & ready & not escaped; readOnly iff non-writable", () => {
  // Plan: enabled, non-writable.
  assert.deepEqual(bashExecPlan(true, false, true, false), { sandboxed: true, readOnly: true });
  // Build: enabled, writable.
  assert.deepEqual(bashExecPlan(true, true, true, false), { sandboxed: true, readOnly: false });
  // YOLO: disabled.
  assert.equal(bashExecPlan(false, true, true, false).sandboxed, false);
  // Approved escape → unsandboxed.
  assert.equal(bashExecPlan(true, true, true, true).sandboxed, false);
  // Sandbox down → unsandboxed.
  assert.equal(bashExecPlan(true, true, false, false).sandboxed, false);
});

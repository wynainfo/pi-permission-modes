import assert from "node:assert/strict";
import test from "node:test";
import { type BashGate, bashExecPlan, bashGate } from "./bash-enforce.ts";

const OUTSIDE = "path outside project: /etc/passwd";

test("bashGate: sandbox disabled still honors allow/ask policy", () => {
  for (const ready of [true, false]) {
    assert.equal(bashGate("allow", undefined, false, ready).kind, "allow");
    assert.equal(bashGate("allow", OUTSIDE, false, ready).kind, "allow"); // even an escape
    const ask = bashGate("ask", undefined, false, ready);
    assert.equal(ask.kind, "prompt");
    assert.equal(ask.onApproveUnsandboxed, true);
    assert.match(ask.title, /sandbox disabled/);
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

test("bashGate: per-rule policyReason overrides block and refusal reasons", () => {
  assert.equal(bashGate("deny", undefined, true, true).reason, "bash command denied by policy (see docs/permissions.md#bash)");
  assert.equal(bashGate("deny", undefined, true, true, "use the grep tool instead").reason, "use the grep tool instead");
  // An ask refused by the user reports the rule's reason (the "what to do when refused" hint).
  assert.equal(bashGate("ask", undefined, true, true).reason, "bash blocked");
  assert.equal(bashGate("ask", undefined, true, true, "pipes are fine, bare grep is not").reason, "pipes are fine, bare grep is not");
  // Prompts caused by an escape or a down sandbox report their own cause -
  // the policy reason must not masquerade as the block's explanation.
  assert.equal(
    bashGate("ask", OUTSIDE, true, true, "pipes are fine, bare grep is not").reason,
    `bash blocked (${OUTSIDE})`,
  );
  assert.equal(
    bashGate("ask", undefined, true, false, "pipes are fine, bare grep is not").reason,
    "bash blocked (sandbox unavailable)",
  );
  // A policy-grounded ask (sandbox disabled) still reports the rule's reason.
  assert.equal(bashGate("ask", undefined, false, true, "sandbox-disabled reason").reason, "sandbox-disabled reason");
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

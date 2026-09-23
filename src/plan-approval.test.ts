import assert from "node:assert/strict";
import test from "node:test";
import { approvalMessage, DEFAULT_APPROVE_MESSAGE, restorePendingPlan, showPlanSucceeded, shownPlanPath } from "./plan-approval.ts";

test("approvalMessage: default template, {path} everywhere, empty template falls back", () => {
  assert.equal(approvalMessage(undefined, "plan/x.md"), "The plan in `plan/x.md` is approved. Implement it now.");
  assert.equal(approvalMessage("  ", "plan/x.md"), approvalMessage(DEFAULT_APPROVE_MESSAGE, "plan/x.md"));
  assert.equal(approvalMessage("Do {path}; file: {path}", "p.md"), "Do p.md; file: p.md");
  assert.equal(approvalMessage("No placeholder", "p.md"), "No placeholder");
});

test("restorePendingPlan: the latest perm-plan entry wins; an approval entry clears it", () => {
  const shown = (p: string) => ({ type: "custom", customType: "perm-plan", data: { path: p } });
  const approved = { type: "custom", customType: "perm-plan", data: {} };
  assert.equal(restorePendingPlan([]), undefined);
  assert.deepEqual(restorePendingPlan([shown("a.md")]), { path: "a.md", declined: false });
  assert.deepEqual(restorePendingPlan([shown("a.md"), shown("b.md")]), { path: "b.md", declined: false });
  assert.equal(restorePendingPlan([shown("a.md"), approved]), undefined);
  assert.deepEqual(restorePendingPlan([shown("a.md"), approved, shown("c.md")]), { path: "c.md", declined: false });
  // Other entries and malformed data are ignored.
  assert.equal(restorePendingPlan([{ type: "custom", customType: "perm-mode", data: { mode: "plan" } }]), undefined);
  assert.equal(restorePendingPlan([{ type: "custom", customType: "perm-plan", data: { path: 5 } }]), undefined);
  assert.equal(restorePendingPlan([{ type: "message", customType: "perm-plan", data: { path: "x" } }]), undefined);
});

test("showPlanSucceeded / shownPlanPath: tool-reported errors count as failure; the reported path wins", () => {
  assert.equal(showPlanSucceeded(false, { details: { path: "plan/x.md", markdown: "# x" } }), true);
  assert.equal(showPlanSucceeded(false, { details: { error: "not under plan/" } }), false);
  assert.equal(showPlanSucceeded(true, { details: { path: "plan/x.md" } }), false);
  assert.equal(showPlanSucceeded(false, undefined), true); // a renderer-less result still rendered
  assert.equal(shownPlanPath({ details: { path: "plan/real.md" } }, "plan/req.md"), "plan/real.md");
  assert.equal(shownPlanPath({ details: {} }, "plan/req.md"), "plan/req.md");
  assert.equal(shownPlanPath(undefined, "plan/req.md"), "plan/req.md");
});

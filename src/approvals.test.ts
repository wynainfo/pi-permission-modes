import assert from "node:assert/strict";
import test from "node:test";
import { type ApprovalUI, askWithSession, SessionApprovals } from "./approvals.ts";

test("SessionApprovals: remembers per (mode, surface, target)", () => {
  const a = new SessionApprovals();
  assert.equal(a.has("default", "bash", "ls"), false);
  a.remember("default", "bash", "ls");
  assert.equal(a.has("default", "bash", "ls"), true);
  assert.equal(a.has("default", "bash", "rm"), false); // different target
  assert.equal(a.has("default", "write", "ls"), false); // different surface
  assert.equal(a.has("build", "bash", "ls"), false); // different mode
});

test("SessionApprovals: clearMode and clearAll", () => {
  const a = new SessionApprovals();
  a.remember("default", "bash", "ls");
  a.remember("build", "bash", "make");
  a.clearMode("default");
  assert.equal(a.has("default", "bash", "ls"), false);
  assert.equal(a.has("build", "bash", "make"), true);
  a.clearAll();
  assert.equal(a.has("build", "bash", "make"), false);
});

const ui = (hasUI: boolean, answer?: string): ApprovalUI & { calls: number } => ({
  hasUI,
  calls: 0,
  async select(_t, _o) {
    this.calls++;
    return answer;
  },
});

test("askWithSession: no UI denies without prompting", async () => {
  const u = ui(false);
  const a = new SessionApprovals();
  assert.equal(await askWithSession(u, a, "default", "bash", "ls", "?"), false);
  assert.equal(u.calls, 0);
});

test("askWithSession: 'Allow for session' suppresses the next prompt", async () => {
  const u = ui(true, "Allow for session");
  const a = new SessionApprovals();
  assert.equal(await askWithSession(u, a, "default", "bash", "ls", "?"), true);
  assert.equal(u.calls, 1);
  // Second identical ask returns true WITHOUT prompting again.
  assert.equal(await askWithSession(u, a, "default", "bash", "ls", "?"), true);
  assert.equal(u.calls, 1);
});

test("askWithSession: 'Allow once' allows but does not remember", async () => {
  const u = ui(true, "Allow once");
  const a = new SessionApprovals();
  assert.equal(await askWithSession(u, a, "default", "bash", "ls", "?"), true);
  assert.equal(await askWithSession(u, a, "default", "bash", "ls", "?"), true);
  assert.equal(u.calls, 2); // prompted both times
});

test("askWithSession: 'Deny' (or dismiss) denies", async () => {
  assert.equal(await askWithSession(ui(true, "Deny"), new SessionApprovals(), "d", "bash", "x", "?"), false);
  assert.equal(await askWithSession(ui(true, undefined), new SessionApprovals(), "d", "bash", "x", "?"), false);
});

test("askWithSession: a target list requires EVERY entry to be granted", async () => {
  const u = ui(true, "Allow for session");
  const a = new SessionApprovals();
  // Granting a chain remembers each of its command names.
  assert.equal(await askWithSession(u, a, "default", "bash", ["git", "curl"], "?"), true);
  assert.equal(u.calls, 1);
  assert.equal(a.has("default", "bash", "git"), true);
  assert.equal(a.has("default", "bash", "curl"), true);
  // The same chain (and any subset) now passes silently.
  assert.equal(await askWithSession(u, a, "default", "bash", ["git", "curl"], "?"), true);
  assert.equal(await askWithSession(u, a, "default", "bash", ["git"], "?"), true);
  assert.equal(u.calls, 1);
  // A chain with ONE ungranted name prompts again — "allow git" must not
  // cover `git status && rm ...`.
  assert.equal(await askWithSession(u, a, "default", "bash", ["git", "rm"], "?"), true);
  assert.equal(u.calls, 2);
});

test("askWithSession: an empty target list never auto-allows", async () => {
  const u = ui(true, "Deny");
  const a = new SessionApprovals();
  assert.equal(await askWithSession(u, a, "default", "bash", [], "?"), false);
  assert.equal(u.calls, 1); // prompted (and denied), not silently allowed
});

test("askWithSession: 'Allow forever' option only appears with onForever, and persists", async () => {
  // Without onForever: only three options offered.
  const u3 = ui(true, "Allow once");
  let seen: string[] = [];
  u3.select = async (_t, o) => {
    seen = o;
    return "Allow once";
  };
  await askWithSession(u3, new SessionApprovals(), "default", "tool", "foo", "?");
  assert.deepEqual(seen, ["Allow once", "Allow for session", "Deny"]);

  // With onForever: fourth option offered; choosing it remembers + calls onForever.
  const a = new SessionApprovals();
  let persisted = 0;
  const u4 = ui(true, "Allow forever");
  u4.select = async (_t, o) => {
    seen = o;
    return "Allow forever";
  };
  const ok = await askWithSession(u4, a, "default", "tool", "foo", "?", () => {
    persisted++;
  });
  assert.equal(ok, true);
  assert.deepEqual(seen, ["Allow once", "Allow for session", "Allow forever", "Deny"]);
  assert.equal(persisted, 1);
  assert.equal(a.has("default", "tool", "foo"), true); // also covers the session
});

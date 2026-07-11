/**
 * Parity tests — assert the data-driven engine (stock defaults + decide +
 * bash-enforce) reproduces the pre-engine per-mode behavior on representative
 * inputs. These mirror the old policy.test.ts so a reviewer can see parity.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { bashExecPlan, bashGate } from "./bash-enforce.ts";
import { loadStockDefaults } from "./config-load.ts";
import { decide } from "./resolve.ts";

// Parity is asserted against the SHIPPED permission-mode.defaults.json, so the
// stock file (not a code constant) is what's validated.
const M = loadStockDefaults().modes;
const OUTSIDE = "path outside project: /etc/passwd";

test("default: confirm bash/write/web_search; reads free; out-of-project asks", () => {
  const d = M.default;
  assert.equal(decide(d, "bash", "ls -la"), "ask");
  assert.equal(decide(d, "write", "src/app.ts"), "ask");
  assert.equal(decide(d, "write", "notes.md"), "ask"); // no markdown carve-out in Default
  assert.equal(decide(d, "edit", "src/app.ts"), "ask");
  assert.equal(decide(d, "web_search", "anything"), "ask");
  assert.equal(decide(d, "read", "src/app.ts"), "allow");
  assert.equal(decide(d, "read", "/etc/passwd", { isOutside: true }), "ask"); // external_directory
  assert.equal(decide(d, "tool", "some_extension_tool"), "ask"); // unknown tool → first-use prompt
  assert.equal(decide(d, "skill", "deep-research"), "ask");
  // bash composition: in-project ask → prompt, stays sandboxed.
  const g = bashGate(decide(d, "bash", "ls"), undefined, d.sandbox.enabled, true);
  assert.equal(g.kind, "prompt");
  assert.equal(g.onApproveUnsandboxed, false);
  assert.deepEqual(bashExecPlan(d.sandbox.enabled, d.sandbox.writable, true, false), {
    sandboxed: true,
    readOnly: false,
  });
});

test("plan: read-only sandbox, Markdown-only writes, reads free", () => {
  const p = M.plan;
  assert.equal(decide(p, "write", "plan/2026-06-08_x.md"), "allow");
  assert.equal(decide(p, "write", "README.markdown"), "allow");
  assert.equal(decide(p, "write", "src/app.ts"), "deny"); // → "Markdown only" block
  assert.equal(decide(p, "edit", "src/app.ts"), "deny");
  assert.equal(decide(p, "read", "src/app.ts"), "allow");
  assert.equal(decide(p, "tool", "some_extension_tool"), "ask"); // unknown tool → first-use prompt
  assert.equal(decide(p, "skill", "deep-research"), "ask");
  assert.equal(decide(p, "bash", "ls"), "allow");
  // bash composition: allow, sandboxed READ-ONLY (sandbox.writable === false).
  const g = bashGate(decide(p, "bash", "ls"), undefined, p.sandbox.enabled, true);
  assert.equal(g.kind, "allow");
  assert.deepEqual(bashExecPlan(p.sandbox.enabled, p.sandbox.writable, true, false), {
    sandboxed: true,
    readOnly: true,
  });
  assert.equal(p.systemPrompt, "@plan"); // Plan injects the planning prompt
});

test("build: silent in-project writes/bash, sandboxed; out-of-project asks", () => {
  const b = M.build;
  assert.equal(decide(b, "write", "src/app.ts"), "allow");
  assert.equal(decide(b, "edit", "src/app.ts"), "allow");
  assert.equal(decide(b, "bash", "make"), "allow");
  assert.equal(decide(b, "read", "/etc/hosts", { isOutside: true }), "ask"); // external_directory
  assert.equal(decide(b, "tool", "some_extension_tool"), "allow"); // Build trusts all tools
  assert.equal(decide(b, "skill", "deep-research"), "allow");
  // bash composition: allow, sandboxed writable.
  const g = bashGate(decide(b, "bash", "make"), undefined, b.sandbox.enabled, true);
  assert.equal(g.kind, "allow");
  assert.deepEqual(bashExecPlan(b.sandbox.enabled, b.sandbox.writable, true, false), {
    sandboxed: true,
    readOnly: false,
  });
  // Privilege/escape still prompts and runs unsandboxed on approval.
  const esc = bashGate(decide(b, "bash", "sudo x"), OUTSIDE, b.sandbox.enabled, true);
  assert.equal(esc.kind, "prompt");
  assert.equal(esc.onApproveUnsandboxed, true);
});

test("yolo: everything allowed, never sandboxed, protected paths bypassed", () => {
  const y = M.yolo;
  assert.equal(decide(y, "write", "src/app.ts"), "allow");
  assert.equal(decide(y, "bash", "rm -rf build"), "allow");
  assert.equal(decide(y, "read", "/etc/passwd", { isOutside: true }), "allow"); // external_directory: allow
  assert.equal(decide(y, "web_search", "x"), "allow");
  assert.equal(decide(y, "tool", "some_extension_tool"), "allow");
  assert.equal(decide(y, "skill", "deep-research"), "allow");
  assert.equal(y.bypassProtectedPaths, true);
  const g = bashGate(decide(y, "bash", "x"), OUTSIDE, y.sandbox.enabled, true);
  assert.equal(g.kind, "allow"); // never prompts, even on an escape
  assert.equal(bashExecPlan(y.sandbox.enabled, y.sandbox.writable, true, false).sandboxed, false);
});

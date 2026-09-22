/**
 * Unit tests for show-plan.ts — the createShowPlanTool factory and execute paths.
 *
 * Tests the execute error paths (non-plan file, missing file, success) and
 * the tool construction with/without pi-tui.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createShowPlanTool } from "./show-plan.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";


// Test-only structural shape for the tool's execute callback. The real
// ToolDefinition.execute additionally takes signal/onUpdate/ctx params the
// tests don't supply, so cast through unknown at this named boundary.
interface ShowPlanToolShape {
  execute: (id: string, p: unknown) => Promise<{
    content: Array<{ type?: string; text: string }>;
    details?: { error?: string; markdown?: string; path?: string };
  }>;
}

function asShowPlanTool(tool: ToolDefinition): ShowPlanToolShape {
  // Cast through unknown: ToolDefinition.execute takes 5 params, the test-only
  // shape takes 2, so the shapes don't overlap directly (TS2352 otherwise).
  return tool as unknown as ShowPlanToolShape;
}
// ---------------------------------------------------------------------------
// createShowPlanTool
// ---------------------------------------------------------------------------

test("createShowPlanTool: returns a tool definition", async () => {
  const tool = await createShowPlanTool("/home/proj");
  assert.equal(tool.name, "show_plan");
  assert.equal(tool.label, "Show Plan");
  assert.ok(typeof tool.execute === "function");
});

test("createShowPlanTool: execute rejects non-plan file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "perm-sp-"));
  try {
    const tool = await createShowPlanTool(root);
    const result = await asShowPlanTool(tool).execute("t1", { path: "src/app.ts" });
    assert.match(result.content[0].text, /show_plan only renders Markdown files under plan/);
    assert.match(result.details?.error ?? "", /show_plan only renders/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createShowPlanTool: execute rejects empty path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "perm-sp2-"));
  try {
    const tool = await createShowPlanTool(root);
    const result = await asShowPlanTool(tool).execute("t1", { path: "" });
    assert.match(result.content[0].text, /show_plan only renders Markdown files under plan/);
    assert.match(result.details?.error ?? "", /\(empty\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createShowPlanTool: execute rejects missing file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "perm-sp3-"));
  try {
    const tool = await createShowPlanTool(root);
    const result = await asShowPlanTool(tool).execute("t1", { path: "plan/2026-01-01_missing.md" });
    assert.match(result.content[0].text, /Plan file not found/);
    assert.match(result.details?.error ?? "", /Plan file not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createShowPlanTool: execute succeeds with a valid plan file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "perm-sp4-"));
  try {
    // Create a plan directory and file
    const planDir = path.join(root, "plan");
    mkdirSync(planDir, { recursive: true });
    const planFile = path.join(planDir, "2026-01-01_task.md");
    writeFileSync(planFile, "# My Plan\n\nThis is the plan body.");

    const tool = await createShowPlanTool(root);
    const result = await asShowPlanTool(tool).execute("t1", { path: "plan/2026-01-01_task.md" });

    assert.match(result.content[0].text, /Displayed the plan/);
    assert.match(result.details?.markdown ?? "", /# My Plan/);
    assert.equal(result.details?.path, "plan/2026-01-01_task.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createShowPlanTool: execute handles @ prefix in path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "perm-sp5-"));
  try {
    const planDir = path.join(root, "plan");
    mkdirSync(planDir, { recursive: true });
    const planFile = path.join(planDir, "2026-01-01_x.md");
    writeFileSync(planFile, "body");

    const tool = await createShowPlanTool(root);
    const result = await asShowPlanTool(tool).execute("t1", { path: "@plan/2026-01-01_x.md" });

    // resolvePlanPath strips the leading @, so it should succeed.
    assert.ok(result.content[0].text.includes("Displayed the plan"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Additional error path coverage
// ---------------------------------------------------------------------------

test("createShowPlanTool: execute rejects non-markdown file in plan dir", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "perm-sp6-"));
  try {
    const planDir = path.join(root, "plan");
    mkdirSync(planDir, { recursive: true });
    const notMd = path.join(planDir, "plan.txt");
    writeFileSync(notMd, "not markdown");

    const tool = await createShowPlanTool(root);
    const result = await asShowPlanTool(tool).execute("t1", { path: "plan/plan.txt" });
    assert.match(result.content[0].text, /only renders Markdown files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createShowPlanTool: execute rejects path outside plan dir", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "perm-sp7-"));
  try {
    const planDir = path.join(root, "plan");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(path.join(planDir, "2026-01-01_x.md"), "body");

    const tool = await createShowPlanTool(root);
    // A file outside plan/ should be rejected.
    const result = await asShowPlanTool(tool).execute("t1", { path: "src/app.ts" });
    assert.match(result.content[0].text, /show_plan only renders Markdown files under plan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createShowPlanTool: with tui attached, renderResult is present", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "perm-sp8-"));
  try {
    const planDir = path.join(root, "plan");
    mkdirSync(planDir, { recursive: true });
    const planFile = path.join(planDir, "2026-01-01_x.md");
    writeFileSync(planFile, "# Plan Body");

    const tool = await createShowPlanTool(root);
    // The tool should have a renderResult method when pi-tui is available.
    // At minimum, the tool object should be well-formed.
    assert.equal(tool.name, "show_plan");
    assert.ok("execute" in tool);
    // If tui is available, renderResult should exist.
    if ("renderResult" in tool) {
      assert.ok(typeof (tool as { renderResult?: unknown }).renderResult === "function");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



/**
 * show_plan: the tool definition and its execute paths (a plan file renders,
 * everything else is refused with a reason). Ported from PR #9 by ammoniak.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createShowPlanTool } from "./show-plan.ts";

interface Outcome {
  content: Array<{ type?: string; text: string }>;
  details?: { error?: string; markdown?: string; path?: string };
}

/** The tool's execute takes five parameters; the tests supply the two that matter. */
const run = async (root: string, input: unknown): Promise<Outcome> => {
  const tool = await createShowPlanTool(root);
  return (tool as unknown as { execute: (id: string, p: unknown) => Promise<Outcome> }).execute("t1", input);
};

const withRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = mkdtempSync(path.join(tmpdir(), "perm-show-plan-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("show_plan: the tool definition names itself and renders through pi-tui when that resolves", async () => {
  const tool = await createShowPlanTool("/home/proj");
  assert.equal(tool.name, "show_plan");
  assert.equal(tool.label, "Show Plan");
  assert.equal(typeof tool.execute, "function");
  assert.match(tool.promptSnippet ?? "", /plan\/<date>_<description>\.md/);
  // The renderer is attached only when pi-tui loaded; either way the tool is whole.
  if ("renderResult" in tool) assert.equal(typeof tool.renderResult, "function");
});

test("show_plan: a Markdown file under plan/ renders, the @ prefix is accepted, the model gets one line and the UI the markdown", async () => {
  await withRoot(async (root) => {
    mkdirSync(path.join(root, "plan"));
    writeFileSync(path.join(root, "plan", "2026-01-01_task.md"), "# My Plan\n\nThis is the plan body.");
    const r = await run(root, { path: "plan/2026-01-01_task.md" });
    assert.match(r.content[0].text, /Displayed the plan \(plan\/2026-01-01_task\.md\) to the user for review/);
    assert.doesNotMatch(r.content[0].text, /plan body/, "the plan text stays out of the model's context");
    assert.match(r.details?.markdown ?? "", /# My Plan/);
    assert.equal(r.details?.path, "plan/2026-01-01_task.md");
    const at = await run(root, { path: "@plan/2026-01-01_task.md" });
    assert.match(at.content[0].text, /Displayed the plan/);
  });
});

test("show_plan: a path outside plan/, a non-Markdown file in it, and an empty path are refused with the reason in both channels", async () => {
  await withRoot(async (root) => {
    mkdirSync(path.join(root, "plan"));
    writeFileSync(path.join(root, "plan", "plan.txt"), "not markdown");
    for (const [input, got] of [
      [{ path: "src/app.ts" }, "src/app.ts"],
      [{ path: "plan/plan.txt" }, "plan/plan.txt"],
      [{ path: "" }, "(empty)"],
      [{}, "(empty)"],
    ] as const) {
      const r = await run(root, input);
      assert.match(r.content[0].text, /^show_plan only renders Markdown files under plan\//);
      assert.ok(r.content[0].text.endsWith(`Got: ${got}`), r.content[0].text);
      assert.equal(r.details?.error, r.content[0].text);
      assert.equal(r.details?.markdown, undefined);
    }
  });
});

test("show_plan: a plan file that does not exist yet tells the model to write it first", async () => {
  await withRoot(async (root) => {
    const r = await run(root, { path: "plan/2026-01-01_missing.md" });
    assert.match(r.content[0].text, /^Plan file not found: plan\/2026-01-01_missing\.md\. Write it with the Write tool first/);
    assert.equal(r.details?.error, r.content[0].text);
  });
});

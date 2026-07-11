/**
 * `show_plan` tool — renders a written plan Markdown file into the TUI for review.
 *
 * In Plan Mode the model writes the plan to a file (bash is read-only there), then
 * calls `show_plan` with that path. The full Markdown is rendered **display-only**
 * in the terminal; only a one-line confirmation is returned to the model, so the
 * plan is not duplicated into the LLM context (it's already there once, from the
 * Write tool input).
 *
 * pi-tui is loaded LAZILY (failure-tolerant): if it can't be resolved we skip the
 * custom renderer and pi's default rendering applies — the tool never breaks over
 * a UI dependency. Mirrors the web-search extension's render pattern.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isPlanFile, resolvePlanPath } from "./paths.ts";
import { type PlanDetails, type Tui, renderPlanResult } from "./plan-render.ts";

let _tui: Tui | undefined;
let _tried = false;

/** Resolve pi-tui once; returns undefined (cached) if it can't be loaded. */
async function loadTui(): Promise<Tui | undefined> {
  if (!_tried) {
    _tried = true;
    try {
      _tui = await import("@earendil-works/pi-tui");
    } catch {
      _tui = undefined;
    }
  }
  return _tui;
}

/**
 * Build the `show_plan` tool. Async so pi-tui can be pre-loaded before deciding
 * whether to attach the custom renderer (renderResult can't await).
 */
export async function createShowPlanTool(root: string): Promise<ToolDefinition> {
  const tui = await loadTui();

  const tool: ToolDefinition = {
    name: "show_plan",
    label: "Show Plan",
    description:
      "Render a plan Markdown file to the user in the terminal for review. In Plan Mode, after writing " +
      "the plan to plan/<date>_<description>.md, call show_plan with that path. The file is shown as " +
      "formatted Markdown inline — do NOT paste the plan text into your reply.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the plan Markdown file, e.g. plan/2026-06-07_my-task.md" }),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const rel = resolvePlanPath((params as { path?: string }).path);
      if (!isPlanFile(root, rel)) {
        const msg = `show_plan only renders Markdown files under plan/. Got: ${rel || "(empty)"}`;
        return { content: [{ type: "text", text: msg }], details: { error: msg } satisfies PlanDetails };
      }
      const abs = path.resolve(root, rel);
      if (!existsSync(abs)) {
        const msg = `Plan file not found: ${rel}. Write it with the Write tool first, then call show_plan.`;
        return { content: [{ type: "text", text: msg }], details: { error: msg } satisfies PlanDetails };
      }
      const markdown = readFileSync(abs, "utf-8");
      // Only a short confirmation goes to the model; the full plan stays in details
      // (UI-only) so it isn't duplicated into the LLM context.
      return {
        content: [
          {
            type: "text",
            text: `Displayed the plan (${rel}) to the user for review. Ask them to review it and switch to Build mode to apply it.`,
          },
        ],
        details: { markdown, path: rel } satisfies PlanDetails,
      };
    },
  };

  // Attach rich rendering only if pi-tui resolved; otherwise pi's default
  // rendering applies (the short confirmation text still shows either way).
  if (tui) {
    tool.renderResult = (result, _opts, theme) => renderPlanResult(tui, theme, result.details as PlanDetails);
  }

  return tool;
}

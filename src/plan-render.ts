/**
 * TUI rendering for the `show_plan` tool result.
 *
 * All pi-tui / pi-coding-agent imports here are TYPE-ONLY (erased at runtime), so
 * this module loads even where those packages can't be resolved — the caller
 * passes the lazily-loaded `tui` namespace in. This keeps the renderer
 * unit-testable with a fake `tui`/`theme` (see plan-render.test.ts), mirroring
 * the web-search extension's render pattern.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";

export type Tui = typeof import("@earendil-works/pi-tui");

/** UI-only payload attached to a show_plan result (never sent to the model). */
export interface PlanDetails {
  markdown?: string;
  path?: string;
  error?: string;
}

/** Build a MarkdownTheme from the host Theme so the plan renders with formatting. */
export function makeMarkdownTheme(theme: Theme): MarkdownTheme {
  const f = (color: string) => (t: string) => theme.fg(color as never, t);
  return {
    heading: f("mdHeading"),
    link: f("mdLink"),
    linkUrl: f("mdLinkUrl"),
    code: f("mdCode"),
    codeBlock: f("mdCodeBlock"),
    codeBlockBorder: f("mdCodeBlockBorder"),
    quote: f("mdQuote"),
    quoteBorder: f("mdQuoteBorder"),
    hr: f("mdHr"),
    listBullet: f("mdListBullet"),
    bold: (t: string) => theme.bold(t),
    italic: (t: string) => theme.italic(t),
    strikethrough: (t: string) => theme.strikethrough(t),
    underline: (t: string) => theme.underline(t),
  } as MarkdownTheme;
}

/**
 * Render a show_plan result: the error as a single line, or a muted `plan · <path>`
 * header above the formatted Markdown body.
 */
export function renderPlanResult(tui: Tui, theme: Theme, details: PlanDetails | undefined): Component {
  const d = details ?? {};
  if (d.error) return new tui.Text(theme.fg("error", d.error), 0, 0);
  const container = new tui.Container();
  if (d.path) container.addChild(new tui.Text(theme.fg("muted", `plan · ${d.path}`), 0, 0));
  container.addChild(new tui.Markdown(d.markdown ?? "(empty plan)", 0, 0, makeMarkdownTheme(theme)));
  return container;
}

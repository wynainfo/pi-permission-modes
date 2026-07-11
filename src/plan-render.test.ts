import assert from "node:assert/strict";
import test from "node:test";
import { type Tui, renderPlanResult } from "./plan-render.ts";

// Minimal fakes so the renderer can be exercised without the real pi-tui.
// (Plain fields — Node's strip-only TS mode rejects constructor parameter properties.)
class FakeText {
  text: string;
  constructor(text: string, _px: number, _py: number) {
    this.text = text;
  }
}
class FakeMarkdown {
  text: string;
  theme: unknown;
  constructor(text: string, _px: number, _py: number, theme: unknown) {
    this.text = text;
    this.theme = theme;
  }
}
class FakeContainer {
  children: unknown[] = [];
  addChild(c: unknown) {
    this.children.push(c);
  }
}

const tui = { Text: FakeText, Markdown: FakeMarkdown, Container: FakeContainer } as unknown as Tui;
// Theme fakes: fg returns the text verbatim; the markdown-theme builders are identity.
const theme = {
  fg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  italic: (t: string) => t,
  strikethrough: (t: string) => t,
  underline: (t: string) => t,
  // biome/tsc: cast below covers the rest of the Theme surface.
} as never;

test("renderPlanResult: error renders a single Text line", () => {
  const out = renderPlanResult(tui, theme, { error: "nope" }) as unknown as FakeText;
  assert.ok(out instanceof FakeText);
  assert.equal(out.text, "nope");
});

test("renderPlanResult: plan renders a header + markdown body", () => {
  const out = renderPlanResult(tui, theme, { markdown: "# Plan\nbody", path: "plan/x.md" }) as unknown as FakeContainer;
  assert.ok(out instanceof FakeContainer);
  assert.equal(out.children.length, 2);
  assert.ok(out.children[0] instanceof FakeText);
  assert.match((out.children[0] as FakeText).text, /plan · plan\/x\.md/);
  assert.ok(out.children[1] instanceof FakeMarkdown);
  assert.equal((out.children[1] as FakeMarkdown).text, "# Plan\nbody");
});

test("renderPlanResult: missing markdown falls back to a placeholder body", () => {
  const out = renderPlanResult(tui, theme, undefined) as unknown as FakeContainer;
  assert.ok(out instanceof FakeContainer);
  assert.equal(out.children.length, 1); // no path → no header
  assert.equal((out.children[0] as FakeMarkdown).text, "(empty plan)");
});

import assert from "node:assert/strict";
import test from "node:test";
import { PROMPT_SECTIONS, writePromptSections } from "./prompt-sections.ts";

/** A pi 0.86+ event: sections render into the prompt getter. */
function piEvent(initial: Record<string, string> = {}) {
  const sections: Record<string, string> = { ...initial };
  return {
    sections,
    event: {
      systemPromptOptions: { sections },
      get systemPrompt() {
        return ["BASE", ...Object.values(sections)].join("\n\n");
      },
    },
  };
}

test("prompt sections: parts are written by name and nothing is returned when pi renders them", () => {
  const { event, sections } = piEvent();
  const res = writePromptSections(event, { aware: "## Sandbox", docs: "## Docs", steering: "Plan Mode is active" });
  assert.equal(res, undefined);
  assert.deepEqual(sections, {
    [PROMPT_SECTIONS.aware]: "## Sandbox",
    [PROMPT_SECTIONS.docs]: "## Docs",
    [PROMPT_SECTIONS.steering]: "Plan Mode is active",
  });
  // Insertion order is the render order: awareness before the steering text.
  assert.deepEqual(Object.keys(sections), [PROMPT_SECTIONS.aware, PROMPT_SECTIONS.docs, PROMPT_SECTIONS.steering]);
});

test("prompt sections: an absent part deletes its section so pi patches it as null", () => {
  const { event, sections } = piEvent({
    [PROMPT_SECTIONS.aware]: "old",
    [PROMPT_SECTIONS.docs]: "## Docs",
    [PROMPT_SECTIONS.steering]: "Plan Mode is active",
    other_extension: "kept",
  });
  assert.equal(writePromptSections(event, { aware: "## Scratch", docs: "## Docs" }), undefined);
  assert.deepEqual(sections, { [PROMPT_SECTIONS.aware]: "## Scratch", [PROMPT_SECTIONS.docs]: "## Docs", other_extension: "kept" });
  // Nothing at all: every section goes, nothing is returned.
  assert.equal(writePromptSections(event, {}), undefined);
  assert.deepEqual(sections, { other_extension: "kept" });
});

test("prompt sections: a pi without sections gets the joined systemPrompt (today's text)", () => {
  const res = writePromptSections({ systemPrompt: "BASE" }, { aware: "## Sandbox", steering: "Plan" });
  assert.deepEqual(res, { systemPrompt: "BASE\n\n## Sandbox\n\nPlan" });
  assert.equal(writePromptSections({ systemPrompt: "BASE" }, {}), undefined);
  // systemPromptOptions present but without a sections object: same fallback.
  const res2 = writePromptSections({ systemPrompt: "BASE", systemPromptOptions: { cwd: "/p" } }, { docs: "## Docs" });
  assert.deepEqual(res2, { systemPrompt: "BASE\n\n## Docs" });
});

test("prompt sections: a pi that exposes sections but does not render them gets the joined systemPrompt", () => {
  const sections: Record<string, string> = {};
  const event = { systemPromptOptions: { sections }, systemPrompt: "BASE" }; // a plain string, never re-rendered
  const res = writePromptSections(event, { aware: "## Sandbox", docs: "## Docs" });
  assert.deepEqual(res, { systemPrompt: "BASE\n\n## Sandbox\n\n## Docs" });
  // The sections were still written (harmless on such a pi).
  assert.equal(sections[PROMPT_SECTIONS.aware], "## Sandbox");
});

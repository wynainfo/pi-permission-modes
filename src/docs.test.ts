/**
 * Guards for the shipped documentation: every reference a hint can print
 * resolves to a real file and heading, every config key is documented, the
 * index links every file, and the docs follow the repository's hyphen rule.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DOC_FILES, DOC_REFS, docRef, docsDir, docsPromptBlock } from "./docs.ts";

const dir = docsDir();

/** GitHub's heading slug: lowercase, punctuation stripped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]+/g, "")
    .replace(/ /g, "-");
}

function headings(file: string): string[] {
  const text = readFileSync(path.join(dir, file), "utf8");
  return text
    .split("\n")
    .filter((l) => /^#{1,6} /.test(l))
    .map((l) => slug(l.replace(/^#+ /, "")));
}

test("docs: the folder ships next to src and every listed file exists", () => {
  assert.ok(existsSync(dir), `docs dir ${dir}`);
  for (const f of DOC_FILES) assert.ok(existsSync(path.join(dir, f)), `docs/${f}`);
  const onDisk = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(onDisk, [...DOC_FILES].sort(), "DOC_FILES lists exactly the files on disk");
});

test("docs: every DOC_REFS entry names an existing file and heading", () => {
  for (const [key, ref] of Object.entries(DOC_REFS)) {
    const [file, anchor] = ref.split("#");
    assert.ok(file && anchor, `${key}: file#anchor`);
    assert.ok(existsSync(path.join(dir, file)), `${key}: docs/${file} exists`);
    assert.ok(headings(file).includes(anchor), `${key}: heading #${anchor} in docs/${file}`);
    assert.equal(docRef(key as keyof typeof DOC_REFS), `docs/${ref}`);
  }
});

test("docs: in-document links resolve to existing files and headings", () => {
  const link = /\]\(([a-z-]+\.md)(?:#([a-z0-9-]+))?\)/g;
  for (const f of DOC_FILES) {
    const text = readFileSync(path.join(dir, f), "utf8");
    for (const m of text.matchAll(link)) {
      const [, file, anchor] = m;
      assert.ok(existsSync(path.join(dir, file)), `${f}: link to docs/${file}`);
      if (anchor) assert.ok(headings(file).includes(anchor), `${f}: link to docs/${file}#${anchor}`);
    }
  }
});

test("docs: index.md links every other file", () => {
  const index = readFileSync(path.join(dir, "index.md"), "utf8");
  for (const f of DOC_FILES) {
    if (f === "index.md") continue;
    assert.ok(index.includes(`](${f})`), `index.md links ${f}`);
  }
});

test("docs: every schema key is documented", () => {
  const schema = JSON.parse(readFileSync(path.join(dir, "..", "schemas", "permission-mode.schema.json"), "utf8")) as {
    properties: Record<string, unknown>;
    $defs: { sandbox: { properties: Record<string, { properties?: Record<string, unknown> }> }; mode: { properties: Record<string, unknown> }; permission: { properties: Record<string, unknown> } };
  };
  const text = ["configuration.md", "modes.md", "sandbox.md", "permissions.md"]
    .map((f) => readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
  const keys = [
    ...Object.keys(schema.properties),
    ...Object.keys(schema.$defs.mode.properties),
    ...Object.keys(schema.$defs.permission.properties),
  ];
  for (const [k, v] of Object.entries(schema.$defs.sandbox.properties)) {
    if (v.properties) for (const sub of Object.keys(v.properties)) keys.push(`${k}.${sub}`);
    else keys.push(k);
  }
  for (const k of keys) assert.ok(text.includes(`\`${k}\``), `key ${k} documented`);
});

test("docs: plain hyphens only", () => {
  for (const f of DOC_FILES) {
    const text = readFileSync(path.join(dir, f), "utf8");
    const hit = new RegExp(`[${String.fromCharCode(0x2013, 0x2014, 0xb7)}]`).exec(text); // en dash, em dash, middot
    assert.equal(hit, null, `${f} contains ${hit?.[0]} at ${hit?.index}`);
  }
});

test("docs: the prompt block names the directory and every file", () => {
  const block = docsPromptBlock("/x/docs");
  assert.match(block, /^## permission-mode documentation\n/);
  assert.ok(block.includes("/x/docs"));
  for (const f of DOC_FILES) assert.ok(block.includes(f), `prompt mentions ${f}`);
  assert.ok(block.split("\n").length <= 4, "stays short: it is on every turn");
});

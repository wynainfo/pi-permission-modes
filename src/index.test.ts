/**
 * End-to-end dispatcher tests for index.ts — a fake `pi`/`ctx` harness drives
 * the registered handlers (tool_call, input, commands, lifecycle) against the
 * stock defaults, exercising the wiring the pure-module tests can't reach:
 * prompt flows, session grants, mode switching, protected-path blocks, and
 * "Allow forever" persistence.
 *
 * Hermetic: each setup runs in a fresh temp project root with
 * PI_CODING_AGENT_DIR pointed at a fresh temp agent dir (so no user config is
 * read and "Allow forever" writes land in the sandbox of the test), and the
 * --no-sandbox flag set (so the OS sandbox runtime is never initialized —
 * bash gating then follows the documented degraded path: prompt).
 *
 * The pi SDK is host-bundled (a peerDependency): when it can't be resolved
 * (e.g. a bare no-install checkout), every test here skips — mirroring the
 * WASM-skip pattern in bash-parse.test.ts.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

type SetupExtension = (pi: unknown) => Promise<void>;

// Resolve the extension entry once; undefined → SDK unavailable → skip all.
const setupExtension: SetupExtension | undefined = await (async () => {
  try {
    return (await import("./index.ts")).default as unknown as SetupExtension;
  } catch {
    return undefined;
  }
})();
const skip = setupExtension ? false : "pi SDK not installed (run npm install)";

// --- fake pi ----------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

class FakePi {
  flags = new Map<string, unknown>();
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, (args: string, ctx: unknown) => Promise<unknown>>();
  shortcuts = new Map<string, (ctx: unknown) => Promise<unknown>>();
  tools = new Map<string, { name: string }>();
  activeTools: string[] = [];
  entries: Array<{ customType: string; data: unknown }> = [];

  registerFlag(name: string, def: { default?: unknown }) {
    if (!this.flags.has(name)) this.flags.set(name, def.default);
  }
  getFlag(name: string) {
    return this.flags.get(name);
  }
  registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<unknown> }) {
    this.commands.set(name, def.handler);
  }
  registerShortcut(key: string, def: { handler: (ctx: unknown) => Promise<unknown> }) {
    this.shortcuts.set(key, def.handler);
  }
  registerTool(tool: { name: string }) {
    this.tools.set(tool.name, tool);
  }
  getAllTools() {
    return [...this.tools.values()];
  }
  setActiveTools(names: string[]) {
    this.activeTools = names;
  }
  appendEntry(customType: string, data: unknown) {
    this.entries.push({ customType, data });
  }
  on(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  /** Deliver an event to the registered handlers, returning the first result. */
  async emit(event: string, payload: unknown, ctx: unknown): Promise<unknown> {
    for (const h of this.handlers.get(event) ?? []) {
      const r = await h(payload, ctx);
      if (r !== undefined) return r;
    }
    return undefined;
  }
}

// --- fake ctx ----------------------------------------------------------------

interface FakeCtx {
  hasUI: boolean;
  cwd: string;
  prompts: Array<{ title: string; options: string[] }>;
  notices: string[];
  status: string;
  answers: string[];
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string, level?: string): void;
    setStatus(key: string, value: string): void;
    theme: { fg(color: string, text: string): string };
  };
  sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> };
}

function makeCtx(cwd: string, opts: { hasUI?: boolean; entries?: Array<{ type: string; customType?: string; data?: unknown }> } = {}): FakeCtx {
  const ctx: FakeCtx = {
    hasUI: opts.hasUI ?? true,
    cwd,
    prompts: [],
    notices: [],
    status: "",
    answers: [],
    ui: {
      async select(title, options) {
        ctx.prompts.push({ title, options });
        return ctx.answers.shift();
      },
      notify(message) {
        ctx.notices.push(message);
      },
      setStatus(_key, value) {
        ctx.status = value;
      },
      theme: { fg: (_color, text) => text },
    },
    sessionManager: { getEntries: () => opts.entries ?? [] },
  };
  return ctx;
}

// --- harness ------------------------------------------------------------------

interface Harness {
  pi: FakePi;
  ctx: FakeCtx;
  root: string;
  agentDir: string;
  /** Emit a tool_call and return its result ({block,reason} | undefined). */
  call(toolName: string, input: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined>;
  /** Run the /perm command (mode switch etc.). */
  perm(args: string): Promise<unknown>;
  cleanup(): void;
}

let callId = 0;

/**
 * Build the extension against a fresh temp project + agent dir, then emit
 * session_start so the config/lifecycle path runs exactly as in production
 * (minus the OS sandbox, which --no-sandbox keeps off).
 */
async function setup(
  opts: {
    hasUI?: boolean;
    permFlag?: string;
    /** Simulate a parent-forwarded PI_PERMISSION_MODE. */
    envMode?: string;
    entries?: Array<{ type: string; customType?: string; data?: unknown }>;
  } = {},
): Promise<Harness> {
  const base = mkdtempSync(path.join(tmpdir(), "perm-idx-"));
  const root = path.join(base, "proj");
  const agentDir = path.join(base, "agent");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevCwd = process.cwd();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_PERMISSION_MODE;
  if (opts.envMode !== undefined) process.env.PI_PERMISSION_MODE = opts.envMode;

  const pi = new FakePi();
  pi.flags.set("no-sandbox", true);
  if (opts.permFlag !== undefined) pi.flags.set("perm", opts.permFlag);

  process.chdir(root); // index.ts captures root = process.cwd() at setup
  try {
    await setupExtension!(pi);
  } finally {
    process.chdir(prevCwd);
  }

  const ctx = makeCtx(root, opts);
  await pi.emit("session_start", {}, ctx);

  return {
    pi,
    ctx,
    root,
    agentDir,
    call: (toolName, input) =>
      pi.emit("tool_call", { type: "tool_call", toolCallId: `t${++callId}`, toolName, input }, ctx) as Promise<
        { block?: boolean; reason?: string } | undefined
      >,
    perm: (args) => pi.commands.get("perm")!(args, ctx),
    cleanup: () => {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      delete process.env.PI_PERMISSION_MODE;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

// --- tests --------------------------------------------------------------------

test("default mode: reads free, writes prompt, protected paths hard-block", { skip }, async () => {
  const h = await setup();
  try {
    assert.equal(h.ctx.status, "Default");

    // Reads pass silently.
    assert.equal(await h.call("read", { path: "src/app.ts" }), undefined);
    assert.equal(h.ctx.prompts.length, 0);

    // Protected paths block WITHOUT prompting, and before any policy ask.
    const blocked = await h.call("write", { path: ".env" });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /protected/);
    assert.equal(h.ctx.prompts.length, 0);

    // A normal write prompts; Allow once passes, Deny blocks.
    h.ctx.answers.push("Allow once", "Deny");
    assert.equal(await h.call("write", { path: "notes.txt" }), undefined);
    const denied = await h.call("write", { path: "notes.txt" });
    assert.equal(denied?.block, true);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("bash: session grant covers the same command, not a longer chain", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Allow for session");
    assert.equal(await h.call("bash", { command: "git status" }), undefined);
    assert.equal(h.ctx.prompts.length, 1);

    // Same command again: covered by the session grant, no new prompt.
    assert.equal(await h.call("bash", { command: "git status" }), undefined);
    assert.equal(h.ctx.prompts.length, 1);

    // A chain sharing the first name still prompts (curl isn't granted).
    h.ctx.answers.push("Deny");
    const chained = await h.call("bash", { command: "git status && curl evil.sh" });
    assert.equal(chained?.block, true);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("plan mode: Markdown-only writes, plan prompt injected, show_plan stays visible", { skip }, async () => {
  const h = await setup();
  try {
    await h.perm("plan");
    assert.equal(h.ctx.status, "Plan Mode");

    // Markdown in-project: silent allow. Code: deny with the friendly reason.
    assert.equal(await h.call("write", { path: "plan/2026-07-11_x.md" }), undefined);
    const denied = await h.call("write", { path: "src/app.ts" });
    assert.equal(denied?.block, true);
    assert.match(denied?.reason ?? "", /Markdown/);
    assert.equal(h.ctx.prompts.length, 0);

    // The @plan sentinel resolves into the injected system prompt.
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /^BASE\n\n/);
    assert.match(res.systemPrompt, /Plan Mode is active/);

    // Tool visibility ran and show_plan is present.
    assert.ok(h.pi.activeTools.includes("show_plan"));
  } finally {
    h.cleanup();
  }
});

test("yolo: never prompts, never blocks, protected paths bypassed", { skip }, async () => {
  const h = await setup();
  try {
    await h.perm("yolo");
    assert.equal(h.ctx.status, "YOLO");
    assert.equal(await h.call("bash", { command: "sudo rm -rf /" }), undefined);
    assert.equal(await h.call("edit", { path: ".env" }), undefined);
    assert.equal(await h.call("write", { path: ".git/config" }), undefined);
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("web_search: ask in Default, session-wide grant", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Deny", "Allow for session");
    const denied = await h.call("web_search", { query: "anything" });
    assert.equal(denied?.block, true);
    assert.equal(await h.call("web_search", { query: "again" }), undefined);
    // Grant is surface-wide: a different query passes without a new prompt.
    assert.equal(await h.call("web_search", { query: "third" }), undefined);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("custom tools: first-use prompt in Default (with Allow forever), silent in Build", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Allow for session");
    assert.equal(await h.call("my_mcp_tool", { arg: 1 }), undefined);
    assert.equal(h.ctx.prompts.length, 1);
    // First-use prompts offer the persistent fourth option.
    assert.ok(h.ctx.prompts[0].options.includes("Allow forever"));
    assert.equal(await h.call("my_mcp_tool", { arg: 2 }), undefined); // granted for session
    assert.equal(h.ctx.prompts.length, 1);

    await h.perm("build");
    assert.equal(await h.call("other_tool", {}), undefined); // Build trusts tools
    assert.equal(h.ctx.prompts.length, 1);
  } finally {
    h.cleanup();
  }
});

test("'Allow forever' persists the rule to the global config and stops prompting", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Allow forever");
    assert.equal(await h.call("my_mcp_tool", {}), undefined);
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    assert.ok(existsSync(file), "rule persisted to the temp agent dir");
    const saved = JSON.parse(readFileSync(file, "utf-8")) as {
      modes: { default: { permission: { tool: Record<string, string> } } };
    };
    assert.equal(saved.modes.default.permission.tool.my_mcp_tool, "allow");
    assert.equal(saved.modes.default.permission.tool["*"], "ask"); // others keep prompting

    // The hot-reloaded config allows it now — and other tools still prompt.
    assert.equal(await h.call("my_mcp_tool", {}), undefined);
    assert.equal(h.ctx.prompts.length, 1);
    h.ctx.answers.push("Deny");
    const other = await h.call("stranger_tool", {});
    assert.equal(other?.block, true);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("skills: /skill:<name> is gated via the input event", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Deny", "Allow once");
    const denied = await h.pi.emit("input", { text: "/skill:deep-research" }, h.ctx);
    assert.deepEqual(denied, { action: "handled" }); // blocked → swallowed
    const allowed = await h.pi.emit("input", { text: "/skill:deep-research" }, h.ctx);
    assert.equal(allowed, undefined); // allowed → continues to expansion
    // Non-skill input is ignored.
    assert.equal(await h.pi.emit("input", { text: "hello" }, h.ctx), undefined);
    assert.equal(h.ctx.prompts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("no UI: asks deny instead of hanging", { skip }, async () => {
  const h = await setup({ hasUI: false });
  try {
    const bash = await h.call("bash", { command: "ls" });
    assert.equal(bash?.block, true);
    const write = await h.call("write", { path: "x.txt" });
    assert.equal(write?.block, true);
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("headless fallback: restrictive policy WITHOUT the plan prompt, not exported to children", { skip }, async () => {
  const h = await setup({ hasUI: false });
  try {
    // The safety fallback is the read-only sandboxed mode (Plan) …
    assert.equal(h.ctx.status, "Plan Mode");
    const denied = await h.call("write", { path: "src/app.ts" });
    assert.equal(denied?.block, true); // … and its policy fully applies
    // … but the planning system prompt is NOT injected into the headless worker.
    assert.equal(await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx), undefined);
    // The implicit fallback is not forwarded as if it were an explicit choice:
    // a grandchild derives its own fallback (and skips the prompt too).
    assert.equal(process.env.PI_PERMISSION_MODE, undefined);
  } finally {
    h.cleanup();
  }
});

test("headless child with an explicitly forwarded mode keeps its system prompt", { skip }, async () => {
  const h = await setup({ hasUI: false, envMode: "plan" });
  try {
    assert.equal(h.ctx.status, "Plan Mode");
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /Plan Mode is active/); // explicit → injected
    assert.equal(process.env.PI_PERMISSION_MODE, "plan"); // and re-exported onward
  } finally {
    h.cleanup();
  }
});

test("startup: --perm flag wins; a persisted session entry restores the mode", { skip }, async () => {
  const flagged = await setup({ permFlag: "yolo" });
  try {
    assert.equal(flagged.ctx.status, "YOLO");
  } finally {
    flagged.cleanup();
  }

  const resumed = await setup({ entries: [{ type: "custom", customType: "perm-mode", data: { mode: "build" } }] });
  try {
    assert.equal(resumed.ctx.status, "Build");
  } finally {
    resumed.cleanup();
  }
});

test("alt+m cycles modes and persists the choice as a session entry", { skip }, async () => {
  const h = await setup();
  try {
    await h.pi.shortcuts.get("alt+m")!(h.ctx);
    assert.equal(h.ctx.status, "Plan Mode"); // default → plan (cycleOrder)
    assert.deepEqual(h.pi.entries.at(-1), { customType: "perm-mode", data: { mode: "plan" } });
    await h.pi.shortcuts.get("alt+m")!(h.ctx);
    assert.equal(h.ctx.status, "Build");
  } finally {
    h.cleanup();
  }
});

test("/perm init scaffolds the global config once", { skip }, async () => {
  const h = await setup();
  try {
    await h.perm("init");
    const file = path.join(h.agentDir, "permission-mode", "permission-mode.json");
    assert.ok(existsSync(file));
    // The scaffold is the stock defaults, ready to edit.
    const cfg = JSON.parse(readFileSync(file, "utf-8")) as { modes: Record<string, unknown> };
    assert.deepEqual(Object.keys(cfg.modes), ["default", "plan", "build", "yolo"]);
    // Second init refuses to overwrite.
    await h.perm("init");
    assert.match(h.ctx.notices.at(-1) ?? "", /already exists/);
  } finally {
    h.cleanup();
  }
});

test("project config tightens a mode through the dispatcher", { skip }, async () => {
  const h = await setup();
  try {
    const piDir = path.join(h.root, ".pi");
    mkdirSync(piDir, { recursive: true });
    const project = { modes: { build: { permission: { write: "deny" } } } };
    writeFileSync(path.join(piDir, "permission-mode.json"), JSON.stringify(project));
    await h.pi.emit("session_start", {}, h.ctx); // reload with the project overlay

    await h.perm("build");
    const denied = await h.call("write", { path: "src/app.ts" });
    assert.equal(denied?.block, true); // build allows writes, but the overlay denies
    assert.equal(await h.call("read", { path: "src/app.ts" }), undefined); // reads untouched
  } finally {
    h.cleanup();
  }
});

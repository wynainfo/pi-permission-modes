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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { docsDir } from "./docs.ts";

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
  /** Mirrors pi: the built-in defaults are active at start (as with the stock
   * `defaultTools`), registered tools join automatically; grep/find/ls stay off. */
  activeTools: string[] = ["read", "bash", "edit", "write"];
  entries: Array<{ customType: string; data: unknown }> = [];
  /** User messages the extension sent (plan approval). */
  messages: Array<{ content: unknown; opts?: unknown }> = [];
  /** Custom messages the extension sent (background shell notices). */
  custom: Array<{ message: { customType: string; content: string }; opts?: unknown }> = [];

  sendUserMessage(content: unknown, opts?: unknown) {
    this.messages.push({ content, opts });
  }
  sendMessage(message: { customType: string; content: string }, opts?: unknown) {
    this.custom.push({ message, opts });
  }
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
    if (!this.activeTools.includes(tool.name)) this.activeTools.push(tool.name);
  }
  getAllTools() {
    return [...this.tools.values()];
  }
  getActiveTools() {
    return [...this.activeTools];
  }
  setActiveTools(names: string[]) {
    this.activeTools = [...names];
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
  /** Scripted answers for ui.confirm, and the titles it was asked with. */
  confirms: boolean[];
  confirmPrompts: string[];
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, level?: string): void;
    setStatus(key: string, value: string): void;
    theme: { fg(color: string, text: string): string };
  };
  sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }>; getSessionId(): string };
}

function makeCtx(cwd: string, opts: { hasUI?: boolean; entries?: Array<{ type: string; customType?: string; data?: unknown }> } = {}): FakeCtx {
  const ctx: FakeCtx = {
    hasUI: opts.hasUI ?? true,
    cwd,
    prompts: [],
    notices: [],
    status: "",
    answers: [],
    confirms: [],
    confirmPrompts: [],
    ui: {
      async select(title, options) {
        ctx.prompts.push({ title, options });
        return ctx.answers.shift();
      },
      async confirm(title) {
        ctx.confirmPrompts.push(title);
        return ctx.confirms.shift() ?? false;
      },
      notify(message) {
        ctx.notices.push(message);
      },
      setStatus(_key, value) {
        ctx.status = value;
      },
      theme: { fg: (_color, text) => text },
    },
    sessionManager: { getEntries: () => opts.entries ?? [], getSessionId: () => "sess-test" },
  };
  return ctx;
}

// --- harness ------------------------------------------------------------------

interface Harness {
  pi: FakePi;
  ctx: FakeCtx;
  /** The temp folder everything lives in; pass it to another setup() to start a second extension instance over the same project (a /reload). */
  base: string;
  root: string;
  agentDir: string;
  /** The scratch base this harness redirects PI_PERMISSION_TMPDIR to, and the session's folder under it. */
  scratchBase: string;
  scratchDir: string;
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
    /** Global permission-mode.json written before the first session_start. */
    globalConfig?: Record<string, unknown>;
    /** Reuse another harness's folders (the same project, agent dir and scratch base). */
    base?: string;
  } = {},
): Promise<Harness> {
  const base = opts.base ?? mkdtempSync(path.join(tmpdir(), "perm-idx-"));
  const root = path.join(base, "proj");
  const agentDir = path.join(base, "agent");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  if (opts.globalConfig) {
    mkdirSync(path.join(agentDir, "permission-mode"), { recursive: true });
    writeFileSync(path.join(agentDir, "permission-mode", "permission-mode.json"), JSON.stringify(opts.globalConfig));
  }

  const scratchBase = path.join(base, "scratch");

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevScratch = process.env.PI_PERMISSION_TMPDIR;
  const prevCwd = process.cwd();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_PERMISSION_TMPDIR = scratchBase; // never touch the real /tmp/pi from tests
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
    base,
    root,
    agentDir,
    scratchBase,
    scratchDir: path.join(scratchBase, "sess-test"),
    call: (toolName, input) =>
      pi.emit("tool_call", { type: "tool_call", toolCallId: `t${++callId}`, toolName, input }, ctx) as Promise<
        { block?: boolean; reason?: string } | undefined
      >,
    perm: (args) => pi.commands.get("perm")!(args, ctx),
    cleanup: () => {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      if (prevScratch === undefined) delete process.env.PI_PERMISSION_TMPDIR;
      else process.env.PI_PERMISSION_TMPDIR = prevScratch;
      delete process.env.CLAUDE_CODE_TMPDIR;
      delete process.env.CLAUDE_TMPDIR;
      delete process.env.PI_PERMISSION_MODE;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

// --- tests --------------------------------------------------------------------

type ToolExec = { execute(id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: Array<{ text: string }> }> };
const runTool = async (h: Harness, name: string, params: unknown): Promise<string> => {
  const tool = h.pi.tools.get(name) as unknown as ToolExec;
  const res = await tool.execute(`x${++callId}`, params, undefined, undefined, h.ctx);
  return res.content.map((c) => c.text).join("\n");
};
const settle = async (cond: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
};
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const posixOnly = process.platform === "win32" ? "POSIX process tests" : skip;

test("background shells: the gate prompts 'Run in background?' and judges the command as for a foreground call", { skip }, async () => {
  const h = await setup();
  try {
    h.ctx.answers.push("Deny");
    const r = await h.call("bash", { command: "sleep 5", run_in_background: true });
    assert.equal(r?.block, true);
    assert.match(h.ctx.prompts[0].title, /^Run in background\? `sleep 5`/);
    const fg = await h.call("bash", { command: "sleep 5" });
    assert.equal(fg?.block, true, "no answer scripted: the prompt is dismissed");
    assert.doesNotMatch(h.ctx.prompts[1].title, /background/);
  } finally {
    h.cleanup();
  }
});

test("background shells: start, inline exit, bash_output, kill_shell with a chosen signal, the footer chip, the notice", { skip: posixOnly }, async () => {
  const h = await setup();
  try {
    await h.perm("yolo"); // no sandbox in the harness: the unsandboxed launcher, as bash itself runs here
    const quick = await runTool(h, "bash", { command: "echo hi; exit 3", run_in_background: true });
    assert.match(quick, /^Background shell [0-9a-f]{6} exited 3 after \d+s\.\nOutput:\nhi$/);
    await settle(() => h.pi.custom.length === 1);
    assert.equal(h.pi.custom[0].message.customType, "perm-shell");
    assert.match(h.pi.custom[0].message.content, /exited 3 after .*\nLast output:\nhi/);
    assert.deepEqual(h.pi.custom[0].opts, { triggerTurn: true, deliverAs: "followUp" });

    const started = await runTool(h, "bash", { command: "echo ready; sleep 30", run_in_background: true });
    const id = /Background shell ([0-9a-f]{6}) started \(pid (\d+), log (.+?)\)/.exec(started)!;
    assert.ok(id, started);
    assert.match(started, /runs unsandboxed, as bash does in this mode/);
    assert.ok(id[3].startsWith(path.join(h.scratchDir, "shells")), "log under the session scratch dir");
    assert.match(h.ctx.status, /Shells: 1/);
    const out = await runTool(h, "bash_output", { bash_id: id[1], wait_seconds: 3 });
    assert.match(out, /running for \d+s/);
    assert.match(out, /--- new output ---\nready/);
    const again = await runTool(h, "bash_output", { bash_id: id[1] });
    assert.match(again, /\(no new output\)/);
    const killed = await runTool(h, "kill_shell", { shell_id: id[1], signal: "INT" });
    assert.match(killed, /killed \(kill_shell, SIGINT\)/);
    await settle(() => !pidAlive(Number(id[2])));
    assert.doesNotMatch(h.ctx.status, /Shells:/);
    assert.equal(h.pi.custom.length, 1, "no notice for a shell the model stopped");
    assert.match(await runTool(h, "kill_shell", { shell_id: id[1] }), /is not running/);
    assert.match(await runTool(h, "bash_output", { bash_id: "nope00" }), /No background shell nope00/);
  } finally {
    h.cleanup();
  }
});

test("background shells: config (disabled, maxConcurrent, notify note/none), /shells, shutdown kills", { skip: posixOnly }, async () => {
  const off = await setup({ globalConfig: { shells: { enabled: false } } });
  try {
    await off.perm("yolo");
    assert.match(await runTool(off, "bash", { command: "sleep 1", run_in_background: true }), /disabled in this configuration/);
    // (The awareness line for a disabled config is covered in awareness.test.ts: the harness runs without an active sandbox.)
  } finally {
    off.cleanup();
  }
  const h = await setup({ globalConfig: { shells: { maxConcurrent: 1, notify: "note" } } });
  try {
    await h.perm("yolo");
    const quick = await runTool(h, "bash", { command: "echo done", run_in_background: true });
    assert.match(quick, /exited 0/);
    await settle(() => h.pi.custom.length === 1);
    assert.deepEqual(h.pi.custom[0].opts, { deliverAs: "nextTurn" });
    const a = /Background shell ([0-9a-f]{6}) started \(pid (\d+)/.exec(await runTool(h, "bash", { command: "sleep 30", run_in_background: true }))!;
    assert.match(await runTool(h, "bash", { command: "sleep 30", run_in_background: true }), /1 background shell\(s\) already run/);
    await h.pi.commands.get("shells")!("", h.ctx);
    assert.match(h.ctx.notices.at(-1)!, new RegExp(`${a[1]}  running for \\d+s  sleep 30`));
    await h.pi.commands.get("shells")!("logs nope", h.ctx);
    assert.match(h.ctx.notices.at(-1)!, /no background shell nope/);
    await h.pi.emit("session_shutdown", {}, h.ctx);
    assert.ok(!pidAlive(Number(a[2])), "shutdown ends the shell");
    await h.pi.commands.get("shells")!("", h.ctx);
    assert.match(h.ctx.notices.at(-1)!, new RegExp(`${a[1]}  killed \\(session ended\\)`));
  } finally {
    h.cleanup();
  }
  const quiet = await setup({ globalConfig: { shells: { notify: "none" } } });
  try {
    await quiet.perm("yolo");
    await runTool(quiet, "bash", { command: "true", run_in_background: true });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(quiet.pi.custom.length, 0);
    await quiet.pi.commands.get("shells")!("stop all", quiet.ctx);
    assert.match(quiet.ctx.notices.at(-1)!, /No background shell is running/);
  } finally {
    quiet.cleanup();
  }
});

test("background shells: a /reload hands the running shells to the next extension instance; another project ends them", { skip: posixOnly }, async () => {
  const store = globalThis as Record<string, unknown>;
  const h = await setup();
  await h.perm("yolo");
  const first = /Background shell ([0-9a-f]{6}) started \(pid (\d+)/.exec(await runTool(h, "bash", { command: "sleep 30", run_in_background: true }))!;
  await h.pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, h.ctx);
  assert.ok(pidAlive(Number(first[2])), "a reload keeps the shell running");
  assert.ok(store.__piPermissionModeShells, "parked for the next instance");
  const next = await setup({ base: h.base });
  let third: Harness | undefined;
  try {
    assert.equal(store.__piPermissionModeShells, undefined);
    assert.match(next.ctx.notices.join("\n"), /1 background shell\(s\) kept across the reload/);
    await next.perm("yolo");
    assert.match(next.ctx.status, /Shells: 1/);
    await next.pi.commands.get("shells")!("", next.ctx);
    assert.match(next.ctx.notices.at(-1)!, new RegExp(`${first[1]}  running for`));
    assert.match(await runTool(next, "bash_output", { bash_id: first[1] }), /running for/);
    assert.match(await runTool(next, "kill_shell", { shell_id: first[1] }), /killed \(kill_shell, SIGTERM\)/);
    await settle(() => !pidAlive(Number(first[2])));
    assert.doesNotMatch(next.ctx.status, /Shells:/);

    // Parked, but the next instance opens another project: the shell ends as at a quit.
    const second = /Background shell ([0-9a-f]{6}) started \(pid (\d+)/.exec(await runTool(next, "bash", { command: "sleep 30", run_in_background: true }))!;
    await next.pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, next.ctx);
    (store.__piPermissionModeShells as { cwd: string }).cwd = path.join(next.base, "elsewhere");
    third = await setup({ base: h.base });
    assert.equal(store.__piPermissionModeShells, undefined);
    assert.ok(!pidAlive(Number(second[2])), "nothing to adopt: the shell was stopped");
    await third.perm("yolo");
    await third.pi.commands.get("shells")!("", third.ctx);
    assert.match(third.ctx.notices.at(-1)!, new RegExp(`${second[1]}  killed \\(session ended\\)`));
    // A reload without running shells resets and stops as a quit does (no handoff).
    await third.pi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, third.ctx);
    assert.equal(store.__piPermissionModeShells, undefined);
  } finally {
    third?.cleanup();
    next.cleanup();
    h.cleanup();
  }
});

test("background shells: expose is checked everywhere and relayed on Linux only (unsandboxed here: a note)", { skip: posixOnly }, async () => {
  const h = await setup();
  try {
    await h.perm("yolo");
    assert.match(await runTool(h, "bash", { command: "true", expose: [8123] }), /expose applies to a background shell only/);
    assert.match(await runTool(h, "bash", { command: "sleep 30", run_in_background: true, expose: ["nope"] }), /not started: expose entry "nope"/);
    assert.match(await runTool(h, "bash", { command: "sleep 30", run_in_background: true, expose: [0] }), /not started: expose port 0 is out of range/);
    const bashParams = (h.pi.tools.get("bash") as unknown as { parameters: { properties: Record<string, { type?: string }> } }).parameters;
    assert.equal(bashParams.properties.expose.type, "array", "the schema carries expose");
    const started = await runTool(h, "bash", { command: "sleep 30", run_in_background: true, expose: [8123, "0.0.0.0:8124"] });
    assert.match(started, /the shell runs unsandboxed\); expose \(127.0.0.1:8123, 0.0.0.0:8124\) was checked only/);
    assert.equal(h.ctx.confirmPrompts.length, 0, "no relay, no LAN question");
    await h.pi.commands.get("shells")!("stop all", h.ctx);
  } finally {
    h.cleanup();
  }
});

test("default mode: reads free, writes prompt, protected paths hard-block", { skip }, async () => {
  const h = await setup();
  try {
    // Footer: mode label + shortcut hints + network state (open here: --no-sandbox).
    assert.match(h.ctx.status, /^Default \(alt\+m\)  Network: open$/);

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
    // The reason names the user's decision, not a policy or a failure (#19).
    assert.equal(denied?.reason, 'The user denied this write of "notes.txt". Do not retry or rephrase it; if the step matters, ask the user how to proceed.');
  } finally {
    h.cleanup();
  }
});

test("sandbox-writable temp dirs are in-bounds: no 'outside project' prompt, no unsandboxed escape", { skip }, async () => {
  const h = await setup();
  try {
    // Default: reads are free in-project; /tmp/pi (in the mode's allowWrite) is
    // in-bounds too, so the external_directory ask does not fold in. /etc still does.
    assert.equal(await h.call("read", { path: "/tmp/pi/scratch/out.txt" }), undefined);
    assert.equal(h.ctx.prompts.length, 0);
    // The shipped docs are reference material: read without a prompt, never written (pi's own docs join them, see docs.test.ts).
    assert.equal(await h.call("read", { path: path.join(docsDir(), "network.md") }), undefined);
    assert.equal(h.ctx.prompts.length, 0);
    h.ctx.answers.push("Deny");
    assert.equal((await h.call("write", { path: path.join(docsDir(), "network.md"), content: "x" }))?.block, true);
    assert.match(h.ctx.prompts[0]?.title ?? "", /Outside project/);
    h.ctx.prompts.length = 0;
    h.ctx.answers.push("Deny");
    assert.equal((await h.call("read", { path: "/etc/hostname" }))?.block, true);
    assert.match(h.ctx.prompts[0]?.title ?? "", /Outside project/);

    // Bash: the sandbox is off in this harness, so in-project bash prompts as
    // "sandbox unavailable" — a /tmp path must get THAT prompt, not the
    // "path outside project" escape prompt (which would run it unsandboxed).
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: "mktemp -d /tmp/pi/scratch.XXXX" });
    assert.match(h.ctx.prompts[1]?.title ?? "", /sandbox unavailable/);
    // A sibling of the base is NOT inside it (prefix ≠ containment): still an escape.
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: "mktemp -d /tmp/pi.XXXX" });
    assert.match(h.ctx.prompts[2]?.title ?? "", /path outside project: \/tmp\/pi\.XXXX/);
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: "cat /etc/passwd" });
    assert.match(h.ctx.prompts[3]?.title ?? "", /path outside project: \/etc\/passwd/);

    // Build: a write into /tmp/pi passes silently (allowWrite covers it).
    await h.perm("build");
    assert.equal(await h.call("write", { path: "/tmp/pi/scratch/notes.txt" }), undefined);
    assert.equal(h.ctx.prompts.length, 4);

    // YOLO doesn't sandbox, so allowWrite is meaningless — its own
    // external_directory:allow is what keeps /tmp (and everything) silent.
    await h.perm("yolo");
    assert.equal(await h.call("write", { path: "/tmp/pi/scratch/notes.txt" }), undefined);
    assert.equal(h.ctx.prompts.length, 4);
  } finally {
    h.cleanup();
  }
});

test("session scratch dir: created per session, TMPDIR, in-bounds, advertised, stale siblings swept", { skip }, async () => {
  // Plant a stale and a fresh sibling BEFORE the session starts.
  const base = mkdtempSync(path.join(tmpdir(), "perm-scratch-e2e-"));
  const prev = process.env.PI_PERMISSION_TMPDIR;
  process.env.PI_PERMISSION_TMPDIR = base;
  const stale = path.join(base, "old-session");
  const fresh = path.join(base, "other-live-session");
  mkdirSync(stale);
  mkdirSync(fresh);
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  const h = await setup(); // setup overrides PI_PERMISSION_TMPDIR to its own base…
  process.env.PI_PERMISSION_TMPDIR = base; // …so re-point and start again to exercise this base
  await h.pi.emit("session_start", {}, h.ctx);
  try {
    const dir = path.join(base, "sess-test");
    assert.ok(existsSync(dir), "scratch dir created from the session id");
    assert.equal(process.env.CLAUDE_CODE_TMPDIR, dir); // the runtime points TMPDIR here inside the sandbox
    assert.equal(process.env.CLAUDE_TMPDIR, dir); // the name older runtimes read
    assert.ok(!existsSync(stale), "stale sibling swept");
    assert.ok(existsSync(fresh), "fresh sibling kept");

    // In-bounds: a read inside it is not an out-of-project ask (Default).
    assert.equal(await h.call("read", { path: path.join(dir, "notes.txt") }), undefined);
    assert.equal(h.ctx.prompts.length, 0);
    // Bash to it prompts as "sandbox unavailable" (the harness runs --no-sandbox), never as an escape.
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: `mktemp -p ${dir}` });
    assert.match(h.ctx.prompts[0]?.title ?? "", /sandbox unavailable/);

    // Advertised in the awareness section (degraded variant here).
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /Sandbox & permissions \(Default\)/);
    assert.ok(res.systemPrompt.includes(dir));
    assert.match(res.systemPrompt, /\$TMPDIR inside bash points there/);

    // Re-entering session_start (resume / reload) keeps the same folder and its files.
    writeFileSync(path.join(dir, "keep.txt"), "x");
    await h.pi.emit("session_start", {}, h.ctx);
    assert.ok(existsSync(path.join(dir, "keep.txt")));
  } finally {
    h.cleanup();
    if (prev === undefined) delete process.env.PI_PERMISSION_TMPDIR;
    else process.env.PI_PERMISSION_TMPDIR = prev;
    rmSync(base, { recursive: true, force: true });
  }
});

test("file tools judge the path pi opens: ~, @, file:// are normalized before the guards", { skip }, async () => {
  const h = await setup();
  try {
    // Default: reads are free in-project, but `~/...` is the home dir, i.e. outside: external_directory asks.
    h.ctx.answers.push("Deny");
    const home = await h.call("read", { path: "~/.ssh/id_rsa" });
    assert.equal(home?.block, true);
    assert.match(h.ctx.prompts.at(-1)?.title ?? "", /Outside project/);
    // `@` prefix is stripped by pi: the protected-path backstop must see `.env`.
    const env = await h.call("write", { path: "@.env" });
    assert.equal(env?.block, true);
    assert.match(env?.reason ?? "", /protected/);
    // file:// URLs are paths to pi.
    h.ctx.answers.push("Deny");
    const url = await h.call("read", { path: "file:///etc/passwd" });
    assert.equal(url?.block, true);
    assert.match(h.ctx.prompts.at(-1)?.title ?? "", /Outside project/);
    // NUL bytes never reach the filesystem layer.
    const nul = await h.call("write", { path: ".git\u0000/config" });
    assert.equal(nul?.block, true);
    assert.match(nul?.reason ?? "", /NUL/);
  } finally {
    h.cleanup();
  }
});

test("deny and block: an escape prompt offers it, the path is masked for the session, /perm unblock lifts it", { skip }, async () => {
  const h = await setup();
  const home = os.homedir();
  try {
    // Bash escape to a file under home: four options, the last one blocks.
    h.ctx.answers.push("Deny and block ~/secret.txt for this session");
    const first = await h.call("bash", { command: "cat ~/secret.txt" });
    assert.equal(first?.block, true);
    assert.deepEqual(h.ctx.prompts[0].options, ["Allow once", "Allow for session", "Deny", "Deny and block ~/secret.txt for this session"]);
    assert.ok(h.ctx.notices.some((n) => /~\/secret\.txt is now unreadable inside the sandbox for this session/.test(n)));
    // Listed, and enforced without a prompt for bash and for the file tools.
    await h.perm("blocks");
    assert.match(h.ctx.notices.at(-1) ?? "", /- ~\/secret\.txt/);
    const again = await h.call("bash", { command: `python3 -c 'open("${path.join(home, "secret.txt")}")' && cat ~/secret.txt` });
    assert.equal(again?.block, true);
    assert.match(again?.reason ?? "", /blocked for this session/);
    const read = await h.call("read", { path: "~/secret.txt" });
    assert.equal(read?.block, true);
    assert.match(read?.reason ?? "", /blocked for this session/);
    assert.equal(h.ctx.prompts.length, 1, "no further prompts for a blocked path");
    // Unblock: the read prompts again (external_directory ask), offering the option again.
    await h.perm("unblock ~/secret.txt");
    assert.match(h.ctx.notices.at(-1) ?? "", /readable again/);
    h.ctx.answers.push("Deny");
    assert.equal((await h.call("read", { path: "~/secret.txt" }))?.block, true);
    assert.equal(h.ctx.prompts.length, 2);
    assert.equal(h.ctx.prompts[1].options.at(-1), "Deny and block ~/secret.txt for this session");
    // Privilege and home-level escapes do not offer it.
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: "sudo id" });
    assert.deepEqual(h.ctx.prompts[2].options, ["Allow once", "Allow for session", "Deny"]);
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: "ls ~" });
    assert.deepEqual(h.ctx.prompts[3].options, ["Allow once", "Allow for session", "Deny"]); // home is never blockable
    // clear-approvals clears blocks as well.
    h.ctx.answers.push("Deny and block ~/other.txt for this session");
    await h.call("read", { path: "~/other.txt" });
    await h.perm("clear-approvals");
    assert.match(h.ctx.notices.at(-1) ?? "", /cleared session approvals and blocked paths/);
    await h.perm("blocks");
    assert.match(h.ctx.notices.at(-1) ?? "", /no paths blocked/);
  } finally {
    h.cleanup();
  }
});

test("bash: a session grant never covers an escape, and an approved escape covers only itself", { skip }, async () => {
  const h = await setup();
  try {
    // In-project `cat` granted for the session (sandbox unavailable in the harness: prompts, then granted).
    h.ctx.answers.push("Allow for session");
    assert.equal(await h.call("bash", { command: "cat README.md" }), undefined);
    assert.equal(h.ctx.prompts.length, 1);
    // The same name reaching outside the project is an escape: it must prompt again.
    h.ctx.answers.push("Deny");
    const escape = await h.call("bash", { command: "cat ~/.ssh/id_rsa" });
    assert.equal(escape?.block, true);
    assert.match(escape?.reason ?? "", /^The user denied this bash command \(path outside project: /);
    assert.equal(h.ctx.prompts.length, 2);
    assert.match(h.ctx.prompts[1].title, /path outside project/);
    // Both prompts name the command they are about (#25).
    assert.match(h.ctx.prompts[0].title, /`cat README.md`$/);
    assert.match(h.ctx.prompts[1].title, /`cat ~\/.ssh\/id_rsa`$/);
    // An approved escape is remembered for that exact command only.
    h.ctx.answers.push("Allow for session");
    assert.equal(await h.call("bash", { command: "cat /etc/hostname" }), undefined);
    assert.equal(await h.call("bash", { command: "cat /etc/hostname" }), undefined); // same: silent
    assert.equal(h.ctx.prompts.length, 3);
    h.ctx.answers.push("Deny");
    assert.equal((await h.call("bash", { command: "cat /etc/shadow" }))?.block, true); // different: prompts
    assert.equal(h.ctx.prompts.length, 4);
    // A wrapper grant does not cover privilege escalation through it.
    h.ctx.answers.push("Allow for session");
    assert.equal(await h.call("bash", { command: "env FOO=1 ls" }), undefined);
    h.ctx.answers.push("Deny");
    assert.equal((await h.call("bash", { command: "env sudo cat /etc/shadow" }))?.block, true);
    assert.match(h.ctx.prompts.at(-1)?.title ?? "", /privilege escalation/);
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
    assert.match(h.ctx.status, /^Plan Mode /);

    // Markdown in-project: silent allow. Code: deny with the friendly reason.
    assert.equal(await h.call("write", { path: "plan/2026-07-11_x.md" }), undefined);
    const denied = await h.call("write", { path: "src/app.ts" });
    assert.equal(denied?.block, true);
    assert.match(denied?.reason ?? "", /Markdown/);
    assert.equal(h.ctx.prompts.length, 0);

    // The @plan sentinel resolves into the injected system prompt, and the
    // sandbox-awareness section rides along above it (degraded variant here,
    // since the harness runs --no-sandbox).
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /^BASE\n\n/);
    assert.match(res.systemPrompt, /Sandbox & permissions \(Plan Mode\)/);
    assert.match(res.systemPrompt, /Plan Mode is active/);
    assert.ok(res.systemPrompt.indexOf("Sandbox & permissions") < res.systemPrompt.indexOf("Plan Mode is active"));

    // Tool visibility ran and show_plan is present.
    assert.ok(h.pi.activeTools.includes("show_plan"));
  } finally {
    h.cleanup();
  }
});

test("tool visibility: respects the user's active set, hides/restores only hideTools (#2)", { skip }, async () => {
  const h = await setup();
  try {
    // Session start must not enable tools the user has off (grep/find/ls stay absent).
    const initial = ["read", "bash", "edit", "write", "bash_output", "kill_shell", "show_plan", "request_network_access"];
    assert.deepEqual(h.pi.activeTools, initial);
    await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx); // runs every turn: idempotent
    assert.deepEqual(h.pi.activeTools, initial);

    // A mode hiding edit/write/grep/show_plan: edit+write+show_plan go (an
    // explicit show_plan entry is honored, #8), grep was never on (so nothing
    // to remember).
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      JSON.stringify({
        modes: {
          review: {
            label: "Review",
            color: "mdLink",
            sandbox: { enabled: true, writable: false },
            permission: { read: "allow", bash: "allow", write: "deny", edit: "deny" },
            hideTools: ["edit", "write", "grep", "show_plan"],
          },
        },
      }),
    );
    await h.pi.emit("session_start", {}, h.ctx);
    await h.perm("review");
    assert.deepEqual(h.pi.activeTools, ["read", "bash", "bash_output", "kill_shell", "request_network_access"]);
    await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx);
    assert.deepEqual(h.pi.activeTools, ["read", "bash", "bash_output", "kill_shell", "request_network_access"]);

    // Switching back restores exactly what we hid (incl. show_plan) — grep stays off.
    await h.perm("default");
    assert.deepEqual([...h.pi.activeTools].sort(), [...initial].sort());
    assert.ok(!h.pi.activeTools.includes("grep"));
    assert.ok(h.pi.activeTools.includes("show_plan"));
  } finally {
    h.cleanup();
  }
});

test("yolo: never prompts, never blocks, protected paths bypassed", { skip }, async () => {
  const h = await setup();
  try {
    await h.perm("yolo");
    assert.match(h.ctx.status, /^YOLO /);
    assert.equal(await h.call("bash", { command: "sudo rm -rf /" }), undefined);
    assert.equal(await h.call("edit", { path: ".env" }), undefined);
    assert.equal(await h.call("write", { path: ".git/config" }), undefined);
    assert.equal(h.ctx.prompts.length, 0);
    // Unsandboxed mode: no sandbox boundary briefing — only the scratch-dir pointer.
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /## Scratch directory \(YOLO\)/);
    assert.ok(res.systemPrompt.includes(h.scratchDir));
    assert.doesNotMatch(res.systemPrompt, /Sandbox & permissions/);
  } finally {
    h.cleanup();
  }
});

test("our tools carry a promptSnippet (listed in the system prompt's Available tools section)", { skip }, async () => {
  const h = await setup();
  try {
    for (const name of ["show_plan", "request_network_access"]) {
      const tool = h.pi.tools.get(name) as { promptSnippet?: string } | undefined;
      assert.ok(tool, `${name} registered`);
      assert.match(tool?.promptSnippet ?? "", /\S/, `${name} has a promptSnippet`);
      assert.ok(!tool?.promptSnippet?.includes("\n"), `${name} snippet is one line`);
    }
  } finally {
    h.cleanup();
  }
});

test("per-rule reasons: file-tool deny surfaces the reason; read-only Markdown message keeps priority", { skip }, async () => {
  const h = await setup();
  try {
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      JSON.stringify({
        modes: {
          strict: {
            label: "Strict",
            color: "accent",
            sandbox: { enabled: true, writable: true },
            permission: {
              read: "allow",
              bash: "allow",
              write: { "*": "allow", "src/*.ts": { action: "deny", reason: "generated files - edit src/*.tmpl instead" } },
            },
          },
          frozen: {
            label: "Frozen",
            color: "mdLink",
            sandbox: { enabled: true, writable: false },
            permission: {
              read: "allow",
              bash: "allow",
              write: { "*": "allow", "src/*.ts": { action: "deny", reason: "custom reason must not hide the mode constraint" } },
            },
          },
        },
      }),
    );
    await h.pi.emit("session_start", {}, h.ctx);

    await h.perm("strict");
    const denied = await h.call("write", { path: "src/app.ts" });
    assert.equal(denied?.block, true);
    assert.equal(denied?.reason, "generated files - edit src/*.tmpl instead");

    // In a read-only mode the mode constraint is the pertinent explanation:
    // the Markdown-only message wins over the pattern's reason.
    await h.perm("frozen");
    const frozen = await h.call("write", { path: "src/app.ts" });
    assert.equal(frozen?.block, true);
    assert.match(frozen?.reason ?? "", /Markdown/);
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
    assert.match(h.ctx.status, /^Plan Mode /);
    const denied = await h.call("write", { path: "src/app.ts" });
    assert.equal(denied?.block, true); // … and its policy fully applies
    // … but the planning system prompt is NOT injected into the headless
    // worker — only the FACTUAL sandbox-awareness section is (boundary
    // knowledge helps; a planning prompt would misdirect).
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /Sandbox & permissions/);
    assert.doesNotMatch(res.systemPrompt, /Plan Mode is active/);
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
    assert.match(h.ctx.status, /^Plan Mode /);
    const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /Plan Mode is active/); // explicit → injected
    assert.equal(process.env.PI_PERMISSION_MODE, "plan"); // and re-exported onward
  } finally {
    h.cleanup();
  }
});

test("startup: an explicit --perm flag beats a persisted session entry", { skip }, async () => {
  const h = await setup({ permFlag: "yolo", entries: [{ type: "custom", customType: "perm-mode", data: { mode: "plan" } }] });
  try {
    assert.match(h.ctx.status, /^YOLO /);
  } finally {
    h.cleanup();
  }
});

test("startup: --perm flag wins; a persisted session entry restores the mode", { skip }, async () => {
  const flagged = await setup({ permFlag: "yolo" });
  try {
    assert.match(flagged.ctx.status, /^YOLO /);
  } finally {
    flagged.cleanup();
  }

  const resumed = await setup({ entries: [{ type: "custom", customType: "perm-mode", data: { mode: "build" } }] });
  try {
    assert.match(resumed.ctx.status, /^Build /);
  } finally {
    resumed.cleanup();
  }
});

test("startup: a global defaultMode is the start mode; flag, session entry, and env still win", { skip }, async () => {
  // The engine boots on the stock default ("default", itself a valid mode)
  // before session_start loads the config; the configured defaultMode must
  // still be what an interactive session starts in.
  const globalConfig = { defaultMode: "build" };
  const plain = await setup({ globalConfig });
  try {
    assert.match(plain.ctx.status, /^Build /);
    assert.equal(process.env.PI_PERMISSION_MODE, "build"); // forwarded to children
  } finally {
    plain.cleanup();
  }

  const flagged = await setup({ globalConfig, permFlag: "plan" });
  try {
    assert.match(flagged.ctx.status, /^Plan Mode /);
  } finally {
    flagged.cleanup();
  }

  const resumed = await setup({ globalConfig, entries: [{ type: "custom", customType: "perm-mode", data: { mode: "yolo" } }] });
  try {
    assert.match(resumed.ctx.status, /^YOLO /);
  } finally {
    resumed.cleanup();
  }

  const forwarded = await setup({ globalConfig, envMode: "default" });
  try {
    assert.match(forwarded.ctx.status, /^Default /);
  } finally {
    forwarded.cleanup();
  }
});

test("startup: a session replaced in the same process keeps the last mode; the start mode is recorded", { skip }, async () => {
  const modeEntries = (h: Harness) => h.pi.entries.filter((e) => e.customType === "perm-mode").map((e) => (e.data as { mode: string }).mode);
  const h = await setup({ permFlag: "plan" });
  try {
    assert.match(h.ctx.status, /^Plan Mode /);
    assert.deepEqual(modeEntries(h), ["plan"], "a new session records its start mode");
    await h.perm("build");

    // /new: no entry in the new session, the --perm flag no longer applies.
    const fresh = makeCtx(h.root);
    await h.pi.emit("session_start", { type: "session_start", reason: "new" }, fresh);
    assert.match(fresh.status, /^Build /);

    // /resume of a session last used in YOLO: the user's current mode wins
    // and is recorded, so a later `pi -c` of that session restores Build.
    const before = modeEntries(h).length;
    const resumed = makeCtx(h.root, { entries: [{ type: "custom", customType: "perm-mode", data: { mode: "yolo" } }] });
    await h.pi.emit("session_start", { type: "session_start", reason: "resume" }, resumed);
    assert.match(resumed.status, /^Build /);
    assert.deepEqual(modeEntries(h).slice(before), ["build"]);

    // A process start resolves from scratch: without a flag the session's entry wins.
    h.pi.flags.delete("perm");
    const started = makeCtx(h.root, { entries: [{ type: "custom", customType: "perm-mode", data: { mode: "yolo" } }] });
    const count = modeEntries(h).length;
    await h.pi.emit("session_start", { type: "session_start", reason: "startup" }, started);
    assert.match(started.status, /^YOLO /);
    assert.equal(modeEntries(h).length, count, "a session already ending on its mode gets no new entry");
  } finally {
    h.cleanup();
  }
});

test("/perm: a bare call cycles, an unknown argument prints usage without switching", { skip }, async () => {
  const h = await setup();
  try {
    assert.match(h.ctx.status, /^Default /);
    await h.perm("buidl");
    assert.match(h.ctx.status, /^Default /);
    assert.match(h.ctx.notices.at(-1) ?? "", /unknown mode or subcommand "buidl"; usage: \/perm \[default\|plan\|build\|yolo\|init/);
    await h.perm("");
    assert.match(h.ctx.status, /^Plan Mode /);
  } finally {
    h.cleanup();
  }
});

test("alt+m cycles modes and persists the choice as a session entry", { skip }, async () => {
  const h = await setup();
  try {
    await h.pi.shortcuts.get("alt+m")!(h.ctx);
    assert.match(h.ctx.status, /^Plan Mode /); // default → plan (cycleOrder)
    assert.deepEqual(h.pi.entries.at(-1), { customType: "perm-mode", data: { mode: "plan" } });
    await h.pi.shortcuts.get("alt+m")!(h.ctx);
    assert.match(h.ctx.status, /^Build /);
  } finally {
    h.cleanup();
  }
});

test("defaults audit: stale /perm-init copy warns per field, acknowledge silences, upgrade notice fires once", { skip }, async () => {
  const h = await setup();
  try {
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "permission-mode.json");
    // A 2.2.x-era full copy: still lists /tmp in all three sandboxed modes.
    const oldCopy = JSON.parse(readFileSync(path.join(process.cwd(), "defaults-history.json"), "utf-8"))[0].defaults;
    writeFileSync(file, JSON.stringify(oldCopy));
    // Pretend the last run was 2.2.1 so the upgrade notice has something to compare.
    writeFileSync(path.join(dir, "state.json"), JSON.stringify({ lastVersion: "2.0.0" }));

    h.ctx.notices.length = 0;
    await h.pi.emit("session_start", {}, h.ctx);
    const stale = h.ctx.notices.find((n) => /still hold an outdated default/.test(n)) ?? "";
    assert.match(stale, /6 value\(s\)/); // allowWrite (changed in 2.3.0) and denyRead (changed in 2.4.0) in each sandboxed mode
    for (const m of ["default", "plan", "build"]) {
      assert.match(stale, new RegExp(`modes\\.${m}\\.sandbox\\.allowWrite still holds the 2\\.0\\.0 to 2\\.2\\.1 default`));
      assert.match(stale, new RegExp(`modes\\.${m}\\.sandbox\\.denyRead still holds the 2\\.0\\.0 to 2\\.3\\.1 default`));
    }
    assert.match(stale, /acknowledgeDefaults/);
    const upgrade = h.ctx.notices.find((n) => /updated 2\.0\.0 ->/.test(n)) ?? "";
    assert.match(upgrade, /stock defaults changed for modes\.default\.sandbox\.allowWrite/);
    // State recorded: the notice does not repeat on the next start.
    assert.match(readFileSync(path.join(dir, "state.json"), "utf-8"), /"lastVersion"/);
    h.ctx.notices.length = 0;
    await h.pi.emit("session_start", {}, h.ctx);
    assert.ok(!h.ctx.notices.some((n) => /updated .* ->/.test(n)), "upgrade notice fires once");
    assert.ok(h.ctx.notices.some((n) => /outdated default/.test(n)), "stale warning repeats until fixed");

    // Acknowledging the current version silences the stale warning.
    const cfg = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    cfg.acknowledgeDefaults = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf-8")).version;
    writeFileSync(file, JSON.stringify(cfg));
    h.ctx.notices.length = 0;
    await h.pi.emit("session_start", {}, h.ctx);
    assert.ok(!h.ctx.notices.some((n) => /outdated default/.test(n)));

    // No global config at all: silent, state still recorded.
    rmSync(file);
    rmSync(path.join(dir, "state.json"));
    h.ctx.notices.length = 0;
    await h.pi.emit("session_start", {}, h.ctx);
    assert.ok(!h.ctx.notices.some((n) => /outdated default|updated .* ->/.test(n)));
    assert.ok(existsSync(path.join(dir, "state.json")));
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
    const cfg = JSON.parse(readFileSync(file, "utf-8")) as { modes: Record<string, unknown>; $comment?: string };
    assert.deepEqual(Object.keys(cfg.modes), ["default", "plan", "build", "yolo"]);
    assert.match(String(cfg.$comment), /Copied from the pi-permission-modes \d+\.\d+\.\d+ stock defaults/);
    assert.equal(Object.keys(cfg)[1], "$comment"); // right after $schema, where a reader sees it first
    // A fresh copy never trips the audit.
    h.ctx.notices.length = 0;
    await h.pi.emit("session_start", {}, h.ctx);
    assert.ok(!h.ctx.notices.some((n) => /outdated default/.test(n)));
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

test("a hostile project config cannot take the session down: global layer applied, sandbox initialized, mode set", { skip }, async () => {
  const h = await setup();
  try {
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "permission-mode.json"), JSON.stringify({ modes: { default: { permission: { read: { "*": "allow", "*.pem": "deny" } } } } }));
    const piDir = path.join(h.root, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(path.join(piDir, "permission-mode.json"), '{"modes":{"default":null,"__proto__":{"sandbox":{"allowWrite":5}}}}');
    h.ctx.notices.length = 0;
    await h.pi.emit("session_start", {}, h.ctx);
    assert.ok(h.ctx.notices.some((n) => /Permission mode: Default/.test(n)), "session start completed (setMode ran)");
    assert.ok(h.ctx.notices.some((n) => /project mode "default" must be an object/.test(n)));
    const denied = await h.call("read", { path: "key.pem" });
    assert.equal(denied?.block, true, "the global layer is still in force");
  } finally {
    h.cleanup();
  }
});

test("prototype names are not modes anywhere: /perm, env, session entries, headless fallback", { skip }, async () => {
  const h = await setup({ envMode: "constructor" });
  try {
    assert.match(h.ctx.status, /^Default /); // env value ignored
    h.ctx.notices.length = 0;
    await h.perm("constructor"); // unknown -> usage notice, no switch, no throw
    assert.match(h.ctx.notices.at(-1) ?? "", /unknown mode or subcommand "constructor"/);
    assert.match(h.ctx.status, /^Default /);
  } finally {
    h.cleanup();
  }
  // Headless child with a cycleOrder of only YOLO still starts in a sandboxed mode.
  const g = await setup({ hasUI: false });
  try {
    const dir = path.join(g.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "permission-mode.json"), JSON.stringify({ defaultMode: "yolo", cycleOrder: ["yolo"] }));
    await g.pi.emit("session_start", {}, g.ctx);
    assert.match(g.ctx.status, /^Plan Mode /);
  } finally {
    g.cleanup();
  }
});

test("project config cannot disable sandboxing or suppress Default bash prompts", { skip }, async () => {
  const h = await setup();
  try {
    const piDir = path.join(h.root, ".pi");
    mkdirSync(piDir, { recursive: true });
    const project = { modes: { default: { sandbox: { enabled: false } } } };
    writeFileSync(path.join(piDir, "permission-mode.json"), JSON.stringify(project));
    await h.pi.emit("session_start", {}, h.ctx);

    assert.match(h.ctx.notices.join("\n"), /cannot change sandbox\.enabled/);
    h.ctx.answers.push("Deny");
    const denied = await h.call("bash", { command: "touch owned" });
    assert.equal(denied?.block, true);
    assert.equal(h.ctx.prompts.length, 1);
  } finally {
    h.cleanup();
  }
});

test("custom unsandboxed mode still honors bash ask", { skip }, async () => {
  const h = await setup();
  try {
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      JSON.stringify({
        defaultMode: "confirm-unsandboxed",
        cycleOrder: ["confirm-unsandboxed"],
        modes: {
          "confirm-unsandboxed": {
            label: "Confirm unsandboxed",
            color: "error",
            sandbox: { enabled: false, writable: true },
            permission: { bash: "ask" },
          },
        },
      }),
    );
    await h.pi.emit("session_start", {}, h.ctx);
    await h.perm("confirm-unsandboxed");

    h.ctx.answers.push("Deny");
    const denied = await h.call("bash", { command: "touch owned" });
    assert.equal(denied?.block, true);
    assert.match(h.ctx.prompts[0]?.title ?? "", /will run unsandboxed\) `touch owned`$/);
  } finally {
    h.cleanup();
  }
});

test("sandbox.insideRoots: removes the escape prompt for bash only; a project cannot add a root (#24)", { skip }, async () => {
  const h = await setup({ globalConfig: { modes: { build: { sandbox: { insideRoots: ["/mnt/user"] } } } } });
  try {
    await h.perm("build");
    // Under an inside root: no "path outside project"; the harness has no OS
    // sandbox, so the degraded-runtime prompt remains, which is not a bypass.
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: "ssh nas ls /mnt/user/photos" });
    assert.match(h.ctx.prompts.at(-1)?.title ?? "", /sandbox unavailable/);
    assert.doesNotMatch(h.ctx.prompts.at(-1)?.title ?? "", /path outside project/);
    // A sibling path is still an escape.
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: "ssh nas ls /mnt/other" });
    assert.match(h.ctx.prompts.at(-1)?.title ?? "", /path outside project: \/mnt\/other/);
    // File tools do not get the root.
    h.ctx.answers.push("Deny");
    await h.call("read", { path: "/mnt/user/photos/a.txt" });
    assert.match(h.ctx.prompts.at(-1)?.title ?? "", /Outside project - allow read/);
    // A project config cannot add a root.
    mkdirSync(path.join(h.root, ".pi"), { recursive: true });
    writeFileSync(path.join(h.root, ".pi/permission-mode.json"), JSON.stringify({ modes: { build: { sandbox: { insideRoots: ["/mnt/user", "/elsewhere"] } } } }));
    await h.pi.emit("session_start", {}, h.ctx);
    h.ctx.answers.push("Deny");
    await h.call("bash", { command: "ssh nas ls /elsewhere" });
    assert.match(h.ctx.prompts.at(-1)?.title ?? "", /path outside project: \/elsewhere/);
    assert.equal(h.ctx.prompts.length, 4);
  } finally {
    h.cleanup();
  }
});

test("unsandboxed modes judge bash per command: chains, prefixes, quoting, the path gate (#26, #21)", { skip }, async () => {
  const h = await setup({
    globalConfig: {
      modes: {
        host: {
          label: "Host",
          color: "error",
          sandbox: { enabled: false, writable: true },
          permission: {
            path: { "*": "allow", "*.env": "deny" },
            external_directory: "allow",
            bash: { "*": "allow", "rm *": "ask", "sudo *": "deny", "ssh *": "ask", "ssh nas zpool status*": "allow" },
          },
        },
      },
    },
  });
  try {
    await h.perm("host");

    // A name-anchored ask rule fires on the chained, env-prefixed, and piped forms.
    for (const command of ["cd /tmp && rm -rf scratchdir", "echo x | ssh nas cat", "VAR=1 ssh nas uptime"]) {
      h.ctx.answers.push("Deny");
      const res = await h.call("bash", { command });
      assert.equal(res?.block, true, command);
      assert.match(res?.reason ?? "", /^The user denied this bash command\./, command);
      assert.match(h.ctx.prompts.at(-1)?.title ?? "", /will run unsandboxed/, command);
    }
    assert.equal(h.ctx.prompts.length, 3);

    // A deny rule holds inside a chain, and the path gate applies to bash here too.
    for (const command of ["cd /tmp && sudo id", "ls && cat .env"]) {
      const res = await h.call("bash", { command });
      assert.equal(res?.block, true, command);
      assert.match(res?.reason ?? "", /denied by policy/, command);
    }
    assert.equal(h.ctx.prompts.length, 3); // deny blocks outright

    // Quoting does not change the outcome: both spellings hit the allow rule.
    assert.equal(await h.call("bash", { command: "ssh nas zpool status" }), undefined);
    assert.equal(await h.call("bash", { command: "ssh nas 'zpool status'" }), undefined);
    assert.equal(h.ctx.prompts.length, 3);

    // A session grant stays scoped to the exact command, not to the name.
    h.ctx.answers.push("Allow for session");
    assert.equal(await h.call("bash", { command: "rm -rf one" }), undefined);
    assert.equal(await h.call("bash", { command: "rm -rf one" }), undefined);
    assert.equal(h.ctx.prompts.length, 4);
    h.ctx.answers.push("Deny");
    assert.equal((await h.call("bash", { command: "rm -rf two" }))?.block, true);
    assert.equal(h.ctx.prompts.length, 5);
  } finally {
    h.cleanup();
  }
});

test("multi-line bash commands: policy applies across newlines (no silent allow, no YOLO noise)", { skip }, async () => {
  const h = await setup();
  try {
    // YOLO: a multi-line command used to fall through every "*" rule to the
    // "ask" fallback and prompt on every heredoc/script.
    await h.perm("yolo");
    assert.equal(await h.call("bash", { command: "cat <<'EOF' > notes.txt\nline one\nline two\nEOF" }), undefined);
    assert.equal(h.ctx.prompts.length, 0);

    // A deny rule must hold when a newline sits inside an argument, in an
    // unsandboxed mode and in a sandboxed one alike (decideBashCommand per
    // extracted command, where the per-token path layer used to be the only
    // match and yielded "allow").
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      JSON.stringify({
        modes: {
          yolo: { permission: { bash: { "*": "allow", "rm -rf *": "deny" } } },
          default: { permission: { bash: { "*": "ask", "sudo *": "deny" } } },
        },
      }),
    );
    await h.pi.emit("session_start", {}, h.ctx);

    await h.perm("yolo");
    assert.equal(await h.call("bash", { command: "echo 'a\nb'" }), undefined);
    const rm = await h.call("bash", { command: "rm -rf 'a\nb'" });
    assert.equal(rm?.block, true);
    assert.match(rm?.reason ?? "", /denied by policy/);

    await h.perm("default");
    const sudo = await h.call("bash", { command: "sudo sh -c '\nid\n'" });
    assert.equal(sudo?.block, true);
    assert.match(sudo?.reason ?? "", /denied by policy/);
    assert.equal(h.ctx.prompts.length, 0); // deny blocks outright, nothing asked
  } finally {
    h.cleanup();
  }
});

test("network: /net allow + status, request tool degrades gracefully, alt+n informs", { skip }, async () => {
  const h = await setup();
  try {
    // Degraded (--no-sandbox): nothing filters — the tool says so instead of prompting.
    const tool = h.pi.tools.get("request_network_access") as unknown as {
      execute: (id: string, p: unknown, s?: unknown, u?: unknown, ctx?: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };
    const res = await tool.execute("t-net", { domains: ["api.example.com"], reason: "testing" }, undefined, undefined, h.ctx);
    assert.match(res.content[0].text, /not filtered/);
    assert.equal(h.ctx.prompts.length, 0);

    // /net allow normalizes and records session grants; /net status reports them.
    await h.pi.commands.get("net")!("allow api.example.com https://svc.io/health", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /allowed for this session: api\.example\.com, svc\.io/);
    await h.pi.commands.get("net")!("", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /Session grants: api\.example\.com, svc\.io/);

    // Overly-broad patterns are rejected outright.
    await h.pi.commands.get("net")!("allow *", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /usage: \/net allow/);

    // alt+n with nothing enforcing explains itself instead of silently toggling.
    await h.pi.shortcuts.get("alt+n")!(h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /not filtered in this mode\/state/);

    // /net reset clears the grants.
    await h.pi.commands.get("net")!("reset", h.ctx);
    await h.pi.commands.get("net")!("status", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /Session grants: \(none\)/);
  } finally {
    h.cleanup();
  }
});

test("injectSandboxInfo:false opts a mode out of the awareness injection", { skip }, async () => {
  const h = await setup();
  try {
    // Default (sandboxed, no systemPrompt) injects the awareness section …
    const before = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.match(before.systemPrompt, /Sandbox & permissions \(Default\)/);

    // … until the global config opts it out; then only the docs pointer remains.
    const dir = path.join(h.agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      JSON.stringify({ modes: { default: { injectSandboxInfo: false } } }),
    );
    await h.pi.emit("session_start", {}, h.ctx);
    const after = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
    assert.doesNotMatch(after.systemPrompt, /Sandbox & permissions/);
    assert.match(after.systemPrompt, /## permission-mode documentation/);
  } finally {
    h.cleanup();
  }
});

test("docs pointer: every mode names the shipped docs folder; the headless fallback does not", { skip }, async () => {
  const h = await setup();
  try {
    for (const mode of ["default", "plan", "build", "yolo"]) {
      await h.perm(mode);
      const res = (await h.pi.emit("before_agent_start", { systemPrompt: "BASE" }, h.ctx)) as { systemPrompt: string };
      assert.match(res.systemPrompt, /## permission-mode documentation/, mode);
      assert.ok(res.systemPrompt.includes(docsDir()), `${mode} names the absolute docs dir`);
      assert.doesNotMatch(res.systemPrompt, /README/, "the prompt points at docs/, not the README");
    }
  } finally {
    h.cleanup();
  }
  // A headless child with no forwarded mode runs on the safety fallback: the
  // factual awareness stays, steering and the docs pointer are skipped.
  const headless = await setup({ hasUI: false });
  try {
    const res = (await headless.pi.emit("before_agent_start", { systemPrompt: "BASE" }, headless.ctx)) as { systemPrompt: string };
    assert.match(res.systemPrompt, /Sandbox & permissions/);
    assert.doesNotMatch(res.systemPrompt, /## permission-mode documentation/);
  } finally {
    headless.cleanup();
  }
});

// --- plan approval -------------------------------------------------------------

/** Emulate a Plan-mode run that rendered `planPath` with show_plan: agent_start, the tool call, its result, agent_end. */
async function runWithShownPlan(h: Harness, planPath: string, opts: { error?: string; endRun?: boolean } = {}) {
  if (!opts.error) {
    mkdirSync(path.dirname(path.join(h.root, planPath)), { recursive: true });
    writeFileSync(path.join(h.root, planPath), `# ${planPath}\n`);
  }
  await h.pi.emit("agent_start", { type: "agent_start" }, h.ctx);
  const toolCallId = `plan${++callId}`;
  const gate = await h.pi.emit("tool_call", { type: "tool_call", toolCallId, toolName: "show_plan", input: { path: planPath } }, h.ctx);
  assert.equal(gate, undefined, "show_plan itself is never gated");
  const result = opts.error ? { details: { error: opts.error } } : { details: { path: planPath, markdown: "# plan" } };
  await h.pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId, toolName: "show_plan", result, isError: false }, h.ctx);
  if (opts.endRun !== false) await h.pi.emit("agent_end", { type: "agent_end", messages: [] }, h.ctx);
}

const APPROVE_MSG = (p: string) => `The plan in \`${p}\` is approved. Implement it now.`;

test("plan approval A: Accept after the run switches to Build and sends the approval message once", { skip }, async () => {
  const h = await setup();
  try {
    await h.perm("plan");
    h.ctx.answers.push("Accept: switch to Build and implement it");
    await runWithShownPlan(h, "plan/2026-09-24_x.md");
    assert.deepEqual(h.ctx.prompts.at(-1), {
      title: "Plan ready: plan/2026-09-24_x.md",
      options: ["Accept: switch to Build and implement it", "Decline: keep refining in Plan Mode"],
    });
    assert.match(h.ctx.status, /^Build /);
    assert.deepEqual(h.pi.messages, [{ content: APPROVE_MSG("plan/2026-09-24_x.md"), opts: { deliverAs: "followUp" } }]); // queued: agent_end still counts as streaming
    // Persisted: shown, then approved (no path), so a resume does not re-offer it.
    const plan = h.pi.entries.filter((e) => e.customType === "perm-plan").map((e) => e.data as { path?: string; sha?: string });
    assert.equal(plan.length, 2);
    assert.equal(plan[0].path, "plan/2026-09-24_x.md");
    assert.match(plan[0].sha ?? "", /^[0-9a-f]{64}$/, "the shown content is hashed");
    assert.deepEqual(plan[1], {});
    await h.pi.commands.get("plan")!("status", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /no plan pending/);
    // The implementing run ends without a show_plan: nothing is asked.
    const before = h.ctx.prompts.length;
    await h.pi.emit("agent_start", { type: "agent_start" }, h.ctx);
    await h.pi.emit("agent_end", { type: "agent_end", messages: [] }, h.ctx);
    assert.equal(h.ctx.prompts.length, before);
  } finally {
    h.cleanup();
  }
});

test("plan approval: Decline keeps Plan Mode and the pending plan; B confirms on /perm build; Esc counts as decline", { skip }, async () => {
  const h = await setup();
  try {
    await h.perm("plan");
    h.ctx.answers.push("Decline: keep refining in Plan Mode");
    await runWithShownPlan(h, "plan/2026-09-24_a.md");
    assert.match(h.ctx.status, /^Plan Mode /);
    assert.equal(h.pi.messages.length, 0);
    // A second run without a new show_plan asks nothing.
    const prompts = h.ctx.prompts.length;
    await h.pi.emit("agent_start", { type: "agent_start" }, h.ctx);
    await h.pi.emit("agent_end", { type: "agent_end", messages: [] }, h.ctx);
    assert.equal(h.ctx.prompts.length, prompts);
    // Still pending for B and C.
    await h.pi.commands.get("plan")!("status", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /pending plan: plan\/2026-09-24_a\.md/);
    // B: the manual switch asks; No leaves Build with nothing sent.
    h.ctx.confirms.push(false);
    await h.perm("build");
    assert.deepEqual(h.ctx.confirmPrompts, ["Implement plan/2026-09-24_a.md now?"]);
    assert.match(h.ctx.status, /^Build /);
    assert.equal(h.pi.messages.length, 0);
    // Back to Plan, switch again, Yes sends it.
    await h.perm("plan");
    h.ctx.confirms.push(true);
    await h.perm("build");
    assert.deepEqual(h.pi.messages.map((m) => m.content), [APPROVE_MSG("plan/2026-09-24_a.md")]);
    // A dismissed prompt (Esc -> undefined) is a decline too.
    await h.perm("plan");
    await runWithShownPlan(h, "plan/2026-09-24_b.md"); // no scripted answer -> undefined
    assert.match(h.ctx.status, /^Plan Mode /);
    assert.equal(h.pi.messages.length, 1);
  } finally {
    h.cleanup();
  }
});

test("plan approval C: /plan approve switches and sends without a prompt; nothing pending -> notice only", { skip }, async () => {
  const h = await setup();
  try {
    await h.pi.commands.get("plan")!("approve", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /no plan pending/);
    assert.equal(h.pi.messages.length, 0);
    await h.perm("plan");
    await runWithShownPlan(h, "plan/2026-09-24_c.md", { endRun: false });
    const prompts = h.ctx.prompts.length;
    await h.pi.commands.get("plan")!("approve", h.ctx);
    assert.equal(h.ctx.prompts.length, prompts, "explicit approval asks nothing");
    assert.equal(h.ctx.confirmPrompts.length, 0, "the switch it performs does not ask B");
    assert.match(h.ctx.status, /^Build /);
    assert.deepEqual(h.pi.messages.map((m) => m.content), [APPROVE_MSG("plan/2026-09-24_c.md")]);
    // show_plan outside a planning mode (here Build) is plain display: nothing is offered.
    const before = h.ctx.prompts.length;
    await runWithShownPlan(h, "plan/2026-09-24_d.md");
    assert.equal(h.ctx.prompts.length, before);
    await h.pi.commands.get("plan")!("status", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /no plan pending/);
    assert.equal(h.pi.messages.length, 1);
  } finally {
    h.cleanup();
  }
});

test("plan approval: a missing approveMode warns once and disables A, B, and C; approveMessage is templated", { skip }, async () => {
  const h = await setup();
  try {
    const piDir = path.join(h.agentDir, "permission-mode");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(path.join(piDir, "permission-mode.json"), JSON.stringify({ plan: { approveMode: "nope" } }));
    await h.pi.emit("session_start", {}, h.ctx);
    await h.perm("plan");
    await runWithShownPlan(h, "plan/2026-09-24_e.md");
    assert.equal(h.ctx.prompts.length, 0, "no Accept/Decline prompt");
    assert.equal(h.ctx.notices.filter((n) => /approveMode "nope" is not a defined mode/.test(n)).length, 1);
    await h.pi.commands.get("plan")!("approve", h.ctx);
    assert.equal(h.pi.messages.length, 0);
    assert.equal(h.ctx.notices.filter((n) => /approveMode "nope"/.test(n)).length, 1, "warned once");
    assert.match(h.ctx.status, /^Plan Mode /);

    // A custom approve mode + message.
    writeFileSync(
      path.join(piDir, "permission-mode.json"),
      JSON.stringify({ plan: { approveMode: "default", approveMessage: "Go: {path} ({path})" } }),
    );
    await h.pi.emit("session_start", {}, h.ctx);
    await h.perm("plan");
    h.ctx.answers.push("Accept: switch to Default and implement it");
    await runWithShownPlan(h, "plan/2026-09-24_f.md");
    assert.match(h.ctx.status, /^Default /);
    assert.deepEqual(h.pi.messages.map((m) => m.content), ["Go: plan/2026-09-24_f.md (plan/2026-09-24_f.md)"]);
  } finally {
    h.cleanup();
  }
});

test("plan approval: headless sessions get no prompt and no switch; the plan is still recorded", { skip }, async () => {
  const h = await setup({ hasUI: false, permFlag: "plan" });
  try {
    await runWithShownPlan(h, "plan/2026-09-24_g.md");
    assert.equal(h.ctx.prompts.length, 0);
    assert.equal(h.ctx.confirmPrompts.length, 0);
    assert.equal(h.pi.messages.length, 0);
    assert.deepEqual(h.pi.entries.filter((e) => e.customType === "perm-plan").map((e) => (e.data as { path: string }).path), ["plan/2026-09-24_g.md"]);
  } finally {
    h.cleanup();
  }
});

test("plan approval: resume restores the latest perm-plan entry; an approved plan is not offered again", { skip }, async () => {
  const entries = [
    { type: "custom", customType: "perm-mode", data: { mode: "plan" } },
    { type: "custom", customType: "perm-plan", data: { path: "plan/old.md" } },
  ];
  const h = await setup({ entries });
  try {
    await h.pi.commands.get("plan")!("status", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /pending plan: plan\/old\.md/);
    // No show_plan in this run: agent_end asks nothing; B still works.
    await h.pi.emit("agent_start", { type: "agent_start" }, h.ctx);
    await h.pi.emit("agent_end", { type: "agent_end", messages: [] }, h.ctx);
    assert.equal(h.ctx.prompts.length, 0);
    h.ctx.confirms.push(true);
    await h.perm("build");
    assert.deepEqual(h.pi.messages.map((m) => m.content), [APPROVE_MSG("plan/old.md")]);
  } finally {
    h.cleanup();
  }
  const done = await setup({ entries: [...entries, { type: "custom", customType: "perm-plan", data: {} }] });
  try {
    await done.pi.commands.get("plan")!("status", done.ctx);
    assert.match(done.ctx.notices.at(-1) ?? "", /no plan pending/);
    done.ctx.confirms.push(true);
    await done.perm("build");
    assert.equal(done.ctx.confirmPrompts.length, 0, "nothing pending, nothing asked");
  } finally {
    done.cleanup();
  }
});

test("plan approval: a show_plan that reported an error leaves nothing pending", { skip }, async () => {
  const h = await setup();
  try {
    await h.perm("plan");
    await runWithShownPlan(h, "notes/x.md", { error: "show_plan only renders Markdown files under plan/." });
    assert.equal(h.ctx.prompts.length, 0);
    await h.pi.commands.get("plan")!("status", h.ctx);
    assert.match(h.ctx.notices.at(-1) ?? "", /no plan pending/);
    assert.equal(h.pi.entries.filter((e) => e.customType === "perm-plan").length, 0);
  } finally {
    h.cleanup();
  }
});

test("plan approval: a plan edited after show_plan is not approved blindly; unsafe plan names are never offered", { skip }, async () => {
  const h = await setup();
  try {
    await h.perm("plan");
    await runWithShownPlan(h, "plan/2026-09-24_h.md", { endRun: false });
    writeFileSync(path.join(h.root, "plan/2026-09-24_h.md"), "# swapped after it was shown\n");
    await h.pi.commands.get("plan")!("approve", h.ctx);
    assert.equal(h.pi.messages.length, 0);
    assert.match(h.ctx.notices.at(-1) ?? "", /changed since it was shown/);
    assert.match(h.ctx.status, /^Plan Mode /);
    // A name carrying a backtick (message injection) is displayed but not offered.
    await runWithShownPlan(h, "plan/x`y.md");
    assert.equal(h.ctx.prompts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("bare-word symlink out of the project prompts as an escape and can be denied and blocked", { skip }, async () => {
  const h = await setup();
  const outside = mkdtempSync(path.join(tmpdir(), "perm-bare-out-"));
  try {
    writeFileSync(path.join(outside, "secret.txt"), "top secret");
    symlinkSync(path.join(outside, "secret.txt"), path.join(h.root, "data"));
    await h.perm("build");
    h.ctx.answers.push(`Deny and block ${path.join(outside, "secret.txt")} for this session`);
    const res = await h.call("bash", { command: "cat data" });
    assert.equal(res?.block, true);
    assert.match(h.ctx.prompts[0]?.title ?? "", /path outside project: data/);
    assert.ok(h.ctx.prompts[0]?.options.at(-1)?.includes(path.join(outside, "secret.txt")), "the block targets the link's real file");
    const again = await h.call("bash", { command: "cat data" });
    assert.match(again?.reason ?? "", /blocked for this session/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    h.cleanup();
  }
});

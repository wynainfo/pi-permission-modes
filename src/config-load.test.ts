import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FALLBACK_CONFIG,
  isUnsafeDomain,
  loadModeConfig,
  loadStockDefaults,
  persistModeRule,
  profileToConfig,
  readOnlyOverride,
  stockDefaultsFile,
} from "./config-load.ts";
import { decide } from "./resolve.ts";

/** Build a temp agentDir + cwd, optionally seeding the global/project JSON. */
function sandbox(opts: { global?: unknown; project?: unknown } = {}): {
  cwd: string;
  agentDir: string;
  errors: string[];
  cleanup: () => void;
} {
  const tmpdir = os.tmpdir();
  if (!existsSync(tmpdir)) mkdirSync(tmpdir, { recursive: true });
  const tmp = mkdtempSync(path.join(tmpdir, "permmode-"));
  const agentDir = path.join(tmp, "agent");
  const cwd = path.join(tmp, "project");
  mkdirSync(cwd, { recursive: true });
  if (opts.global !== undefined) {
    const dir = path.join(agentDir, "permission-mode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      typeof opts.global === "string" ? opts.global : JSON.stringify(opts.global),
    );
  }
  if (opts.project !== undefined) {
    const dir = path.join(cwd, ".pi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "permission-mode.json"),
      typeof opts.project === "string" ? opts.project : JSON.stringify(opts.project),
    );
  }
  const errors: string[] = [];
  return { cwd, agentDir, errors, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

test("loadStockDefaults: reads the shipped JSON → four modes, correct defaults", () => {
  const errors: string[] = [];
  const c = loadStockDefaults((m) => errors.push(m));
  assert.equal(errors.length, 0, errors.join("; ")); // stock file present & valid
  assert.equal(c.defaultMode, "default");
  assert.deepEqual(c.cycleOrder, ["default", "plan", "build", "yolo"]);
  assert.deepEqual(Object.keys(c.modes).sort(), ["build", "default", "plan", "yolo"]);
  assert.ok(stockDefaultsFile().endsWith("permission-mode.defaults.json"));
});

test("FALLBACK_CONFIG is a valid, safe single-mode config", () => {
  assert.equal(FALLBACK_CONFIG.defaultMode, "default");
  assert.deepEqual(Object.keys(FALLBACK_CONFIG.modes), ["default"]);
  const d = FALLBACK_CONFIG.modes.default;
  assert.equal(d.sandbox.enabled, true); // sandboxed
  assert.equal(decide(d, "bash", "ls"), "ask"); // never silently allows
  assert.equal(decide(d, "write", "x.ts"), "ask");
});

test("loadModeConfig: no files → the four built-in modes", () => {
  const s = sandbox();
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.equal(c.defaultMode, "default");
  assert.deepEqual(Object.keys(c.modes).sort(), ["build", "default", "plan", "yolo"]);
  assert.equal(s.errors.length, 0);
  s.cleanup();
});

test("global: full authority — add a mode, redefine a built-in, change defaults", () => {
  const s = sandbox({
    global: {
      defaultMode: "build",
      cycleOrder: ["build", "default", "review"],
      modes: {
        default: { permission: { bash: "deny" } }, // redefine: deny bash in Default
        review: {
          label: "Review",
          color: "mdLink",
          sandbox: { enabled: true, writable: false },
          permission: { bash: "allow", write: "deny" },
        },
      },
    },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.equal(c.defaultMode, "build");
  assert.deepEqual(c.cycleOrder, ["build", "default", "review"]);
  assert.equal(decide(c.modes.default, "bash", "ls"), "deny"); // redefined
  assert.equal(decide(c.modes.default, "read", "x"), "allow"); // untouched surface preserved
  assert.ok(c.modes.review); // new mode added
  assert.equal(c.modes.review.label, "Review");
  s.cleanup();
});

test("warns on array-index-like pattern keys (JS front-loads their order)", () => {
  const s = sandbox({
    global: {
      modes: {
        // "777" would iterate FIRST regardless of file order, silently breaking
        // last-match-wins; the pattern still loads, but the user is told.
        default: { permission: { bash: { "*": "ask", "777": "deny" } } },
      },
    },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.ok(s.errors.some((e) => /bare number/.test(e) && /777/.test(e)));
  assert.equal(decide(c.modes.default, "bash", "777"), "ask"); // "777" reordered before "*" — exactly the trap being warned about
  // Non-index-like numeric-ish keys don't warn.
  const s2 = sandbox({
    global: { modes: { default: { permission: { bash: { "7z*": "allow", "0x*": "allow" } } } } },
  });
  loadModeConfig(s2.cwd, s2.agentDir, (m) => s2.errors.push(m));
  assert.ok(!s2.errors.some((e) => /bare number/.test(e)));
  s.cleanup();
  s2.cleanup();
});

test("project: tighten-only — can tighten, never loosen", () => {
  const s = sandbox({
    project: {
      modes: {
        default: { permission: { bash: "deny", write: "allow" }, sandbox: { enabled: false, writable: false } },
        yolo: { sandbox: { enabled: true } },
      },
    },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  // bash ask → deny: tightened.
  assert.equal(decide(c.modes.default, "bash", "ls"), "deny");
  // write ask + project "allow": most-restrictive overlay can't loosen → stays ask.
  assert.equal(decide(c.modes.default, "write", "x.ts"), "ask");
  // A project cannot disable globally enabled containment.
  assert.equal(c.modes.default.sandbox.enabled, true);
  assert.ok(s.errors.some((e) => /cannot change sandbox\.enabled.*false/.test(e)));
  // Project config also cannot create a new runtime profile by enabling a
  // globally unsandboxed mode.
  assert.equal(c.modes.yolo.sandbox.enabled, false);
  assert.ok(s.errors.some((e) => /cannot change sandbox\.enabled.*true/.test(e)));
  // sandbox writable forced off.
  assert.equal(c.modes.default.sandbox.writable, false);
  s.cleanup();
});

test("project: repeating inherited sandbox.enabled is a silent no-op", () => {
  const s = sandbox({
    project: {
      modes: {
        default: { sandbox: { enabled: true } },
        yolo: { sandbox: { enabled: false } },
      },
    },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.equal(c.modes.default.sandbox.enabled, true);
  assert.equal(c.modes.yolo.sandbox.enabled, false);
  assert.ok(!s.errors.some((e) => /sandbox\.enabled/.test(e)));
  s.cleanup();
});

test("project: sandbox intersect/union + unsafe domains rejected", () => {
  const s = sandbox({
    project: {
      modes: {
        build: {
          sandbox: {
            allowWrite: ["."], // intersect with ['.','/tmp'] → ['.']
            denyRead: ["~/.config"], // union
            network: { allowedDomains: ["github.com", "*.com"] }, // *.com rejected
          },
        },
      },
    },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  const sb = c.modes.build.sandbox;
  assert.deepEqual(sb.allowWrite, ["."]); // intersected
  assert.ok(sb.denyRead?.includes("~/.config") && sb.denyRead?.includes("~/.ssh")); // unioned
  assert.deepEqual(sb.network?.allowedDomains, ["github.com"]); // *.com dropped (intersect of safe)
  assert.ok(s.errors.some((e) => /overly-broad/.test(e)));
  s.cleanup();
});

test("project: cannot add a mode or change defaults", () => {
  const s = sandbox({
    project: { defaultMode: "yolo", modes: { hacker: { label: "H", color: "error", sandbox: { enabled: false, writable: true }, permission: {} } } },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.equal(c.defaultMode, "default"); // unchanged
  assert.ok(!c.modes.hacker); // not added
  assert.ok(s.errors.some((e) => /cannot add new mode/.test(e)));
  assert.ok(s.errors.some((e) => /defaultMode\/cycleOrder/.test(e)));
  s.cleanup();
});

test("malformed JSON keeps prior layer and reports the error", () => {
  const s = sandbox({ global: "{ not valid json " });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.deepEqual(Object.keys(c.modes).sort(), ["build", "default", "plan", "yolo"]); // defaults intact
  assert.ok(s.errors.some((e) => /could not parse/.test(e)));
  s.cleanup();
});

test("unknown surface and $schema are handled", () => {
  const s = sandbox({
    global: { $schema: "./x.json", modes: { default: { permission: { bogus: "deny", bash: "deny" } } } },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.equal(decide(c.modes.default, "bash", "ls"), "deny"); // valid surface applied
  assert.ok(s.errors.some((e) => /unknown surface "bogus"/.test(e)));
  s.cleanup();
});

test("readOnlyOverride drops allowWrite; profileToConfig maps fields; isUnsafeDomain", () => {
  assert.deepEqual(readOnlyOverride({ filesystem: { allowWrite: ["."], denyRead: ["~/.ssh"] } }).filesystem, {
    allowWrite: [],
    denyRead: ["~/.ssh"],
  });
  const c = profileToConfig({ enabled: true, writable: true, allowWrite: ["."], denyRead: ["~/.ssh"], denyWrite: [] });
  assert.equal(c.filesystem?.allowWrite?.[0], ".");
  assert.ok(isUnsafeDomain("*") && isUnsafeDomain("*.com") && isUnsafeDomain("http://x"));
  assert.ok(!isUnsafeDomain("*.github.com") && !isUnsafeDomain("github.com"));
});

test("persistModeRule: creates the global file with the learned rule, round-trips", () => {
  const s = sandbox();
  const file = persistModeRule(s.agentDir, "default", "tool", "fooTool", "allow");
  assert.ok(file.endsWith(path.join("permission-mode", "permission-mode.json")));
  const written = JSON.parse(readFileSync(file, "utf-8"));
  // Seeds "*": "ask" so other tools keep prompting, plus the learned allow.
  assert.deepEqual(written.modes.default.permission.tool, { "*": "ask", fooTool: "allow" });
  // The persisted allow takes effect through the normal loader.
  const c = loadModeConfig(s.cwd, s.agentDir, () => {});
  assert.equal(decide(c.modes.default, "tool", "fooTool"), "allow");
  assert.equal(decide(c.modes.default, "tool", "otherTool"), "ask"); // others still prompt
  s.cleanup();
});

test("persistModeRule: converts a string surface to a map and preserves other content", () => {
  const s = sandbox({
    global: { $schema: "./x.json", modes: { default: { permission: { tool: "allow", bash: "deny" } } } },
  });
  // Write the user's existing global file first (sandbox() only seeds it in memory if given).
  const dir = path.join(s.agentDir, "permission-mode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "permission-mode.json"),
    JSON.stringify({ $schema: "./x.json", modes: { default: { permission: { tool: "allow", bash: "deny" } } } }),
  );
  const file = persistModeRule(s.agentDir, "default", "tool", "fooTool", "allow");
  const written = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(written.$schema, "./x.json"); // preserved
  assert.equal(written.modes.default.permission.bash, "deny"); // preserved
  assert.deepEqual(written.modes.default.permission.tool, { "*": "allow", fooTool: "allow" }); // string→map
  s.cleanup();
});

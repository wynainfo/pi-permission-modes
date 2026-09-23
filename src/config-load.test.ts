import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FALLBACK_CONFIG,
  globalConfigFile,
  isUnsafeDomain,
  loadModeConfig,
  loadStockDefaults,
  persistModeDomains,
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

test("warns when a Plan-prompt mode hides show_plan; hiding it elsewhere is silent", () => {
  const s = sandbox({
    global: {
      modes: {
        plan: { hideTools: ["show_plan"] }, // contradiction: the @plan prompt calls show_plan
        build: { hideTools: ["show_plan"] }, // fine: no planning prompt here
      },
    },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.deepEqual(c.modes.plan.hideTools, ["show_plan"]); // honored as written
  assert.deepEqual(c.modes.build.hideTools, ["show_plan"]);
  assert.equal(s.errors.length, 1, s.errors.join("; "));
  assert.match(s.errors[0], /mode "plan" hides show_plan/);
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
            allowWrite: ["."], // intersect with ['.','/tmp/pi'] → ['.']
            denyRead: ["~/.config"], // union
            allowRead: ["~/.cache", "~/.local"], // intersect with the global carve-outs: a project cannot open new ones
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
  assert.deepEqual(sb.allowRead, [], "the stock mode has no carve-outs, so the project cannot add any");
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
  const base = { network: { deniedDomains: [] }, filesystem: { allowWrite: ["."], denyRead: ["~/.ssh"], denyWrite: [] } };
  assert.deepEqual(readOnlyOverride(base).filesystem, { allowWrite: [], denyRead: ["~/.ssh"], denyWrite: [] });
  const c = profileToConfig({ enabled: true, writable: true, allowWrite: ["."], denyRead: ["~/.ssh"], denyWrite: [] });
  assert.equal(c.filesystem.allowWrite[0], ".");
  assert.ok(isUnsafeDomain("*") && isUnsafeDomain("*.com") && isUnsafeDomain("http://x"));
  assert.ok(!isUnsafeDomain("*.github.com") && !isUnsafeDomain("github.com"));
});

test("profileToConfig: every list is an array, only allowedDomains may be absent (unrestricted network)", () => {
  const bare = profileToConfig({ enabled: true, writable: true });
  assert.deepEqual(bare.filesystem, { denyRead: [], allowWrite: [], denyWrite: [] });
  assert.deepEqual(bare.network, { allowedDomains: undefined, deniedDomains: [] });
  const filtered = profileToConfig({ enabled: true, writable: true, network: { allowedDomains: [] } });
  assert.deepEqual(filtered.network.allowedDomains, []); // an empty list is kept: it filters everything
  const carved = profileToConfig({ enabled: true, writable: true, denyRead: ["~"], allowRead: [".", "~/.cache"] });
  assert.deepEqual(carved.filesystem, { denyRead: ["~"], allowRead: [".", "~/.cache"], allowWrite: [], denyWrite: [] });
  assert.ok(!("allowRead" in bare.filesystem), "absent stays absent (the runtime treats undefined as none)");
  const denied = profileToConfig({ enabled: true, writable: true, network: { deniedDomains: ["evil.example"] } });
  assert.equal(denied.network.allowedDomains, undefined);
  assert.deepEqual(denied.network.deniedDomains, ["evil.example"]);
});

// The runtime does not validate what initialize() receives, so the shape is
// checked here against its exported zod schema for every stock sandboxed mode
// (skipped when the runtime is not installed, e.g. a bare checkout).
const runtimeSchema = await import("@anthropic-ai/sandbox-runtime")
  .then((m) => (m as { SandboxRuntimeConfigSchema?: { parse: (v: unknown) => unknown } }).SandboxRuntimeConfigSchema)
  .catch(() => undefined);
test("profileToConfig output validates against the runtime's SandboxRuntimeConfigSchema for the stock modes", { skip: runtimeSchema ? false : "sandbox-runtime not installed" }, () => {
  const stock = loadStockDefaults();
  const checked: string[] = [];
  for (const [name, mode] of Object.entries(stock.modes)) {
    if (!mode.sandbox.enabled) continue;
    const cfg = profileToConfig(mode.sandbox);
    assert.doesNotThrow(() => runtimeSchema!.parse({ network: cfg.network, filesystem: cfg.filesystem }), `${name}: ${JSON.stringify(cfg)}`);
    // Plan mode's per-wrap override keeps the shape too.
    assert.doesNotThrow(() => runtimeSchema!.parse(readOnlyOverride(cfg, ["/tmp/pi/s1"])));
    checked.push(name);
  }
  assert.deepEqual(checked, ["default", "plan", "build"]);
  // The README's strict-home shape (denyRead "~" with allowRead carve-outs) validates as well.
  const strict = profileToConfig({ ...stock.modes.build.sandbox, denyRead: ["~"], allowRead: [".", "/tmp/pi", "~/.cache"] });
  assert.doesNotThrow(() => runtimeSchema!.parse({ network: strict.network, filesystem: strict.filesystem }));
});

test("project: allowRead can only be narrowed, and only where the global mode has carve-outs", () => {
  const s = sandbox({
    global: { modes: { build: { sandbox: { denyRead: ["~"], allowRead: [".", "~/.cache", "~/.config"] } } } },
    project: { modes: { build: { sandbox: { allowRead: ["~/.cache", "~/Secrets"] } } } },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.deepEqual(c.modes.build.sandbox.denyRead, ["~"]);
  assert.deepEqual(c.modes.build.sandbox.allowRead, ["~/.cache"], "kept what both list; ~/Secrets was never open");
  s.cleanup();
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

test("persistModeDomains: appends to the FULL stock+global allowlist, round-trips", () => {
  const s = sandbox();
  const stockDomains = loadStockDefaults().modes.default.sandbox.network?.allowedDomains ?? [];
  const file = persistModeDomains(s.agentDir, "default", ["api.internal.io"]);
  const written = JSON.parse(readFileSync(file, "utf-8"));
  // mergeGlobal replaces `network` wholesale, so the stock domains must be
  // baked into the persisted list or they'd be lost on the next load.
  const list = written.modes.default.sandbox.network.allowedDomains as string[];
  for (const d of stockDomains) assert.ok(list.includes(d), `stock domain ${d} preserved`);
  assert.ok(list.includes("api.internal.io"));
  const c = loadModeConfig(s.cwd, s.agentDir, () => {});
  assert.ok(c.modes.default.sandbox.network?.allowedDomains?.includes("api.internal.io"));
  assert.ok(c.modes.default.sandbox.network?.allowedDomains?.includes(stockDomains[0]));
  // Idempotent: persisting again doesn't duplicate.
  persistModeDomains(s.agentDir, "default", ["api.internal.io"]);
  const again = JSON.parse(readFileSync(file, "utf-8")).modes.default.sandbox.network.allowedDomains as string[];
  assert.equal(again.filter((d) => d === "api.internal.io").length, 1);
  s.cleanup();
});

test("persistModeDomains: never bakes a project's tightened list into the global config", () => {
  // Project intersects the allowlist down to one domain; a forever-grant made
  // while that project is open must still persist against the UNTIGHTENED base.
  const s = sandbox({ project: { modes: { default: { sandbox: { network: { allowedDomains: ["github.com"] } } } } } });
  const stockDomains = loadStockDefaults().modes.default.sandbox.network?.allowedDomains ?? [];
  const file = persistModeDomains(s.agentDir, "default", ["api.internal.io"]);
  const list = JSON.parse(readFileSync(file, "utf-8")).modes.default.sandbox.network.allowedDomains as string[];
  for (const d of stockDomains) assert.ok(list.includes(d), `stock domain ${d} not lost to project tightening`);
  s.cleanup();
});

test("project: askOnBlockedHost can be forced off (silent deny), never back on", () => {
  const s = sandbox({
    global: { modes: { default: { sandbox: { askOnBlockedHost: false } } } },
    project: { modes: { default: { sandbox: { askOnBlockedHost: true } }, build: { sandbox: { askOnBlockedHost: false } } } },
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.equal(c.modes.default.sandbox.askOnBlockedHost, false); // project cannot re-enable asking
  assert.equal(c.modes.build.sandbox.askOnBlockedHost, false); // project may force silent-deny
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

test("hostile project config never throws: malformed values are ignored with warnings, the global layer stays", () => {
  const cases: unknown[] = [
    { modes: { default: null } },
    { modes: { default: { sandbox: { allowWrite: 5 } } } },
    { modes: { default: { sandbox: { denyRead: "~/.ssh", denyWrite: { a: 1 }, network: { allowedDomains: "x" } } } } },
    { modes: { default: { sandbox: 7, permission: "allow" } } },
    // As JSON text: an object LITERAL with a __proto__ key sets the prototype,
    // JSON.parse (like a file on disk) creates an own "__proto__" property.
    '{"modes":{"__proto__":{"sandbox":{"allowWrite":[]},"permission":{"bash":"deny"}}}}',
    { modes: { constructor: { permission: { bash: "deny" } } } },
    { modes: [] },
    [],
    "just a string",
  ];
  for (const project of cases) {
    const s = sandbox({
      global: { modes: { default: { permission: { read: { "*": "allow", "*.pem": "deny" } } } } },
      project: typeof project === "string" ? project : JSON.stringify(project),
    });
    const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
    assert.equal(decide(c.modes.default, "read", "key.pem"), "deny", `global layer applied for ${JSON.stringify(project)}`);
    assert.equal(c.modes.default.sandbox.enabled, true);
    assert.ok(s.errors.length > 0, `warned for ${JSON.stringify(project)}`);
    s.cleanup();
  }
  // No prototype pollution from a "__proto__" mode.
  assert.equal(({} as { projectOverlay?: unknown }).projectOverlay, undefined);
  assert.equal(Object.hasOwn(Object.prototype, "projectOverlay"), false);
});

test("project config that is not a regular file, or oversized, is ignored", () => {
  const s = sandbox();
  const dir = path.join(s.cwd, ".pi");
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(dir, "permission-mode.json")); // a directory in place of the file
  let c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.ok(c.modes.default);
  assert.match(s.errors.join("\n"), /not a regular file/);
  rmSync(path.join(dir, "permission-mode.json"), { recursive: true });
  writeFileSync(path.join(dir, "permission-mode.json"), `{"modes":{},"pad":"${"x".repeat(1 << 20)}"}`);
  s.errors.length = 0;
  c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.ok(c.modes.default);
  assert.match(s.errors.join("\n"), /larger than/);
  s.cleanup();
});

test("global: invalid action inside a pattern map is coerced to deny, not dropped", () => {
  const s = sandbox({ global: { modes: { build: { permission: { bash: { "*": "allow", "sudo*": "denny" } } } } } });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.equal(decide(c.modes.build, "bash", "sudo rm -rf /"), "deny");
  assert.match(s.errors.join("\n"), /treating as deny/);
  s.cleanup();
});

test("global: a new mode without permission/sandbox booleans gets safe defaults and warnings; prototype names are not modes", () => {
  const s = sandbox({
    global:
      '{"cycleOrder":["default","review","constructor","toString"],"modes":{' +
      '"review":{"label":"Review","color":"mdLink","sandbox":{}},' +
      '"__proto__":{"label":"X","color":"muted","sandbox":{"enabled":true,"writable":true},"permission":{}}}}',
  });
  const c = loadModeConfig(s.cwd, s.agentDir, (m) => s.errors.push(m));
  assert.deepEqual(c.cycleOrder, ["default", "review"]);
  assert.equal(c.modes.review.sandbox.enabled, true);
  assert.equal(c.modes.review.sandbox.writable, true);
  assert.deepEqual(c.modes.review.permission, {});
  assert.equal(decide(c.modes.review, "write", "x.ts"), "ask"); // no throw, least privilege
  assert.ok(!Object.hasOwn(c.modes, "__proto__"));
  assert.match(s.errors.join("\n"), /sandbox.enabled missing/);
  assert.match(s.errors.join("\n"), /no permission block/);
  s.cleanup();
});

test("persistModeRule/persistModeDomains refuse to clobber an unparsable or malformed global file", () => {
  const s = sandbox({ global: '{"defaultMode":"default","modes":{"review":{"label":"R","color":"muted","sandbox":{"enabled":true,"writable":true},"permission":{}}},}' });
  const file = globalConfigFile(s.agentDir);
  const before = readFileSync(file, "utf-8");
  assert.throws(() => persistModeRule(s.agentDir, "default", "tool", "myTool", "allow"), /not valid JSON/);
  assert.throws(() => persistModeDomains(s.agentDir, "default", ["example.com"]), /not valid JSON/);
  assert.equal(readFileSync(file, "utf-8"), before, "file untouched");
  writeFileSync(file, '{"modes":[]}');
  assert.throws(() => persistModeRule(s.agentDir, "default", "tool", "myTool", "allow"), /"modes" must be an object/);
  assert.throws(() => persistModeRule(s.agentDir, "__proto__", "tool", "x", "allow"), /invalid mode name/);
  s.cleanup();
});

test("persistModeRule seeds the map from the effective stock+global surface, never from a project overlay", () => {
  // Build's stock `tool` is "allow"; the project tightens it to "ask" - the
  // seed must still be allow so other tools in other projects stay silent.
  const s = sandbox({ project: { modes: { build: { permission: { tool: "ask" } } } } });
  const file = persistModeRule(s.agentDir, "build", "tool", "myTool", "allow");
  const written = JSON.parse(readFileSync(file, "utf-8")) as { $schema?: string; modes: { build: { permission: { tool: Record<string, string> } } } };
  assert.deepEqual(written.modes.build.permission.tool, { "*": "allow", myTool: "allow" });
  assert.match(written.$schema ?? "", /^https:\/\//); // a fresh file gets the URL schema
  // A global string shorthand seeds from the file's own value.
  writeFileSync(file, JSON.stringify({ modes: { build: { permission: { tool: "deny" } } } }));
  persistModeRule(s.agentDir, "build", "tool", "other", "allow");
  const again = JSON.parse(readFileSync(file, "utf-8")) as { modes: { build: { permission: { tool: Record<string, string> } } } };
  assert.deepEqual(again.modes.build.permission.tool, { "*": "deny", other: "allow" });
  s.cleanup();
});

test("readOnlyOverride keeps the listed dirs writable (the session scratch dir)", () => {
  const cfg = {
    filesystem: { allowWrite: [".", "/tmp/pi", "/tmp/pi/s1"], denyRead: ["~/.ssh"], denyWrite: [] },
    network: { allowedDomains: ["a"], deniedDomains: [] },
  };
  assert.deepEqual(readOnlyOverride(cfg).filesystem.allowWrite, []);
  assert.deepEqual(readOnlyOverride(cfg, ["/tmp/pi/s1"]).filesystem.allowWrite, ["/tmp/pi/s1"]);
  assert.deepEqual(readOnlyOverride(cfg, ["/tmp/pi/s1"]).filesystem.denyRead, ["~/.ssh"]);
  assert.deepEqual(readOnlyOverride(cfg, ["/tmp/pi/s1"]).network, { allowedDomains: ["a"], deniedDomains: [] });
});

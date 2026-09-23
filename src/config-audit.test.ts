import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditStaleDefaults,
  compareVersions,
  configLeaves,
  defaultsChangedSince,
  defaultsFor,
  describeStale,
  extensionVersion,
  loadDefaultsHistory,
  readAuditState,
  writeAuditState,
} from "./config-audit.ts";
import { loadStockDefaults, stockDefaultsFile } from "./config-load.ts";

// A miniature defaults lineage: 1.0 shipped /tmp, 2.0 narrowed to /tmp/pi.
const OLD = { defaultMode: "default", cycleOrder: ["default"], modes: { default: { label: "D", sandbox: { allowWrite: [".", "/tmp"] }, permission: { write: "ask" } } } };
const NEW = { defaultMode: "default", cycleOrder: ["default"], modes: { default: { label: "D", sandbox: { allowWrite: [".", "/tmp/pi"] }, permission: { write: "ask" } } } };
const HISTORY = [{ from: "1.0.0", to: "1.2.1", defaults: OLD }];
const CURRENT = { version: "2.0.0", defaults: NEW };

test("compareVersions: numeric, per component", () => {
  assert.equal(compareVersions("2.2.1", "2.10.0"), -1);
  assert.equal(compareVersions("2.2.1", "2.2.1"), 0);
  assert.equal(compareVersions("3.0.0", "2.9.9"), 1);
  assert.equal(compareVersions("2.3.0-rc.1", "2.3.0"), 0); // pre-release tag ignored
});

test("configLeaves: top-level keys, mode fields, and sandbox/permission children", () => {
  const leaves = configLeaves({ defaultMode: "x", modes: { m: { label: "L", hideTools: ["a"], sandbox: { enabled: true, network: { allowedDomains: [] } }, permission: { bash: { "*": "ask" } } } } });
  assert.deepEqual([...leaves.keys()], ["defaultMode", "modes.m.label", "modes.m.hideTools", "modes.m.sandbox.enabled", "modes.m.sandbox.network", "modes.m.permission.bash"]);
  assert.deepEqual(configLeaves(null).size, 0);
});

test("defaultsFor: current version, a covered range, or undefined", () => {
  assert.equal(defaultsFor("2.0.0", CURRENT, HISTORY), NEW);
  assert.equal(defaultsFor("1.1.0", CURRENT, HISTORY), OLD);
  assert.equal(defaultsFor("1.2.1", CURRENT, HISTORY), OLD); // inclusive upper bound
  assert.equal(defaultsFor("1.3.0", CURRENT, HISTORY), undefined);
});

test("auditStaleDefaults: stale vs redundant vs custom vs unknown", () => {
  const raw = {
    defaultMode: "default", // equals current: redundant, silent
    modes: {
      default: {
        sandbox: { allowWrite: [".", "/tmp"] }, // equals the OLD default only: STALE
        permission: { write: "deny" }, // equals no default: custom, silent
      },
      review: { sandbox: { allowWrite: [".", "/tmp"] } }, // custom mode: nothing to compare, silent
    },
  };
  const findings = auditStaleDefaults(raw, CURRENT, HISTORY);
  assert.deepEqual(findings, [
    { path: "modes.default.sandbox.allowWrite", value: [".", "/tmp"], currentValue: [".", "/tmp/pi"], from: "1.0.0", to: "1.2.1" },
  ]);
  assert.match(describeStale(findings[0]), /modes\.default\.sandbox\.allowWrite still holds the 1\.0\.0 to 1\.2\.1 default \[".","\/tmp"\]; the current default is \[".","\/tmp\/pi"\]/);
  // Pattern-map order is semantic: a reordered map is not "the same default".
  const reordered = { modes: { default: { permission: { write: "ask" } } } };
  assert.deepEqual(auditStaleDefaults(reordered, CURRENT, HISTORY), []); // equals current → silent
});

test("auditStaleDefaults: acknowledgeDefaults silences only while defaults are unchanged since then", () => {
  const raw = { modes: { default: { sandbox: { allowWrite: [".", "/tmp"] } } } };
  assert.equal(auditStaleDefaults(raw, CURRENT, HISTORY, "2.0.0").length, 0); // reviewed against current
  assert.equal(auditStaleDefaults(raw, CURRENT, HISTORY, "1.2.1").length, 1); // reviewed against the OLD defaults: still stale
  assert.equal(auditStaleDefaults(raw, CURRENT, HISTORY, "9.9.9").length, 1); // unknown version: ignored
});

test("defaultsChangedSince: leaf paths that differ between an old version and now", () => {
  assert.deepEqual(defaultsChangedSince("1.0.0", CURRENT, HISTORY), ["modes.default.sandbox.allowWrite"]);
  assert.deepEqual(defaultsChangedSince("2.0.0", CURRENT, HISTORY), []);
  assert.deepEqual(defaultsChangedSince("0.1.0", CURRENT, HISTORY), []); // unknown: nothing to say
});

test("shipped data: history parses, covers 2.0.0 to 2.2.1, differs from the current defaults", () => {
  const history = loadDefaultsHistory();
  assert.ok(history.length >= 1);
  assert.equal(history[0].from, "2.0.0");
  assert.equal(history[0].to, "2.2.1");
  const current = { version: extensionVersion(), defaults: loadStockDefaults() };
  for (const h of history) {
    assert.ok(defaultsChangedSince(h.from, current, history).length > 0, `history ${h.from}-${h.to} must differ from the current defaults`);
  }
  // The real regression this exists for: a 2.2.x /perm init copy still says /tmp.
  const oldCopy = JSON.parse(JSON.stringify(history[0].defaults)) as Record<string, unknown>;
  const stale = auditStaleDefaults(oldCopy, current, history);
  assert.deepEqual(stale.map((f) => f.path).sort(), ["modes.build.sandbox.allowWrite", "modes.default.sandbox.allowWrite", "modes.plan.sandbox.allowWrite"]);
  // And a verbatim copy of the CURRENT defaults is fully silent.
  const freshCopy = JSON.parse(readFileSync(stockDefaultsFile(), "utf-8")) as Record<string, unknown>;
  assert.deepEqual(auditStaleDefaults(freshCopy, current, history), []);
  assert.match(extensionVersion(), /^\d+\.\d+\.\d+/);
});

test("audit state: round-trips, tolerates garbage and a missing file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "perm-audit-"));
  try {
    assert.deepEqual(readAuditState(dir), {});
    assert.equal(writeAuditState(dir, { lastVersion: "2.2.1" }), true);
    assert.deepEqual(readAuditState(dir), { lastVersion: "2.2.1" });
    writeFileSync(path.join(dir, "permission-mode", "state.json"), "{ not json");
    assert.deepEqual(readAuditState(dir), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

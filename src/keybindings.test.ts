import assert from "node:assert/strict";
import test from "node:test";
import { loadPermissionKeybindings, shortcutText } from "./keybindings.ts";

test("defaults: mode and network shortcuts remain alt+m / alt+n", () => {
  const bindings = loadPermissionKeybindings(undefined);
  assert.deepEqual(bindings.sandbox, ["alt+m"]);
  assert.deepEqual(bindings.network, ["alt+n"]);
  assert.equal(bindings.warnings.length, 0);
  assert.equal(shortcutText(bindings.sandbox), "alt+m");
});

test("accepts strings and arrays, normalizes, deduplicates, and displays with slash", () => {
  const bindings = loadPermissionKeybindings({
    sandbox: [" CTRL+M ", "ctrl+m", "alt+pageDown"],
    network: "shift+f12",
  });
  assert.deepEqual(bindings.sandbox, ["ctrl+m", "alt+pageDown"]);
  assert.deepEqual(bindings.network, ["shift+f12"]);
  assert.equal(shortcutText(bindings.sandbox), "ctrl+m/alt+pageDown");
  assert.equal(bindings.warnings.length, 0);
});

test("empty arrays explicitly disable either shortcut", () => {
  const bindings = loadPermissionKeybindings({ sandbox: [], network: [] });
  assert.deepEqual(bindings.sandbox, []);
  assert.deepEqual(bindings.network, []);
  assert.equal(shortcutText(bindings.network), "");
});

test("filters invalid array entries while retaining valid keys", () => {
  const bindings = loadPermissionKeybindings({
    sandbox: ["ctrl+shift+x", "hyper+x", 42, ""],
    network: ["alt+n", "alt+alt+n"],
  });
  assert.deepEqual(bindings.sandbox, ["ctrl+shift+x"]);
  assert.deepEqual(bindings.network, ["alt+n"]);
  assert.ok(bindings.warnings.some((warning) => /keyBindings\.sandbox/.test(warning)));
  assert.ok(bindings.warnings.some((warning) => /keyBindings\.network/.test(warning)));
});

test("malformed values and all-invalid nonempty arrays fall back safely", () => {
  const bindings = loadPermissionKeybindings({ sandbox: { key: "ctrl+m" }, network: ["not-a-key"] });
  assert.deepEqual(bindings.sandbox, ["alt+m"]);
  assert.deepEqual(bindings.network, ["alt+n"]);
  assert.ok(bindings.warnings.length >= 2);

  const malformedRoot = loadPermissionKeybindings("alt+x");
  assert.deepEqual(malformedRoot.sandbox, ["alt+m"]);
  assert.deepEqual(malformedRoot.network, ["alt+n"]);
  assert.ok(malformedRoot.warnings.some((warning) => /must be a JSON object/.test(warning)));
});

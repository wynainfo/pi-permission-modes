import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import type { SandboxController } from "./sandbox.ts";
import type { ModeDef } from "./schema.ts";
import { updateStatus, type StatusOptions } from "./status.ts";

const mode: ModeDef = {
  label: "Build",
  color: "accent",
  sandbox: { enabled: true, writable: true },
  permission: {},
};

function render(
  sandboxState: { ready: boolean; warn?: string; disabled?: boolean },
  networkOpen: boolean,
  options: StatusOptions,
): string {
  let status = "";
  const ctx = {
    ui: {
      theme: { fg: (color: string, text: string) => `{${color}:${text}}` },
      setStatus: (_key: string, value: string) => {
        status = value;
      },
    },
  } as unknown as ExtensionContext;
  updateStatus(ctx, mode, sandboxState as SandboxController, networkOpen, options);
  return status;
}

test("default layout is preserved while shortcut text is dynamic", () => {
  assert.equal(
    render({ ready: true }, false, { modeShortcut: "alt+m", networkShortcut: "alt+n" }),
    "{accent:Build} {dim:(sandboxed in project dir, alt+m)}  {success:Network: filtered (alt+n)}",
  );
  assert.equal(
    render({ ready: false, disabled: true }, false, { modeShortcut: "ctrl+m/alt+m", networkShortcut: "ctrl+n" }),
    "{accent:Build} {dim:(ctrl+m/alt+m)}  {dim:Network: open}",
  );
  assert.equal(
    render(
      { ready: false, warn: "sandbox-runtime missing", disabled: false },
      false,
      { modeShortcut: "alt+m", networkShortcut: "alt+n" },
    ),
    "{accent:Build} {dim:(alt+m)} {error:(!) sandbox-runtime missing}  {dim:Network: open}",
  );
});

test("disabled shortcuts disappear cleanly from the default layout", () => {
  assert.equal(
    render({ ready: true }, false, { modeShortcut: "", networkShortcut: "" }),
    "{accent:Build} {dim:(sandboxed in project dir)}  {success:Network: filtered}",
  );
});

test("custom statusFormat replaces all placeholders with semantic colors", () => {
  const format = "%m [%M] · Network %n [%N] · %m";
  assert.equal(
    render(
      { ready: true },
      false,
      { format, modeShortcut: "ctrl+m/alt+m", networkShortcut: "ctrl+n/alt+n" },
    ),
    "{accent:Build} [{dim:ctrl+m/alt+m}] · Network {success:filtered} [{dim:ctrl+n/alt+n}] · {accent:Build}",
  );
  assert.equal(
    render({ ready: true }, true, { format: "%n", modeShortcut: "", networkShortcut: "" }),
    "{warning:open}",
  );
  assert.equal(
    render({ ready: false }, false, { format: "%n", modeShortcut: "", networkShortcut: "" }),
    "{dim:open}",
  );
});

test("sandbox degradation warning is appended even with a custom format", () => {
  assert.equal(
    render(
      { ready: false, warn: "sandbox-runtime missing", disabled: false },
      false,
      { format: "custom", modeShortcut: "alt+m", networkShortcut: "alt+n" },
    ),
    "custom {error:(!) sandbox-runtime missing}",
  );
  assert.equal(
    render(
      { ready: false, warn: "sandbox-runtime missing", disabled: false },
      false,
      { format: "", modeShortcut: "alt+m", networkShortcut: "alt+n" },
    ),
    "{error:(!) sandbox-runtime missing}",
  );
});

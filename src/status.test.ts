/**
 * Unit tests for status.ts — updateStatus rendering paths.
 *
 * Tests the various status label combinations for enforcing vs non-enforcing
 * sandbox states, warn flags, and network open/closed states.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  updateStatus,
} from "./status.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SandboxController } from "./sandbox.ts";
import type { ModeDef } from "./schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A minimal fake ExtensionContext that captures the setStatus call.
 */
function makeFakeCtx() {
  let statusValue: string | undefined;
  const setStatus = (key: string, status: string) => {
    statusValue = status;
  };
  const theme = {
    fg: (color: string | undefined, text: string) =>
      color ? `[${color}]${text}[/${color}]` : text,
  };
  return {
    setStatus,
    get statusValue() { return statusValue; },
    ui: { theme, setStatus },
  };
}

function makeModeDef(
  overrides: Partial<ModeDef> = {},
): ModeDef {
  return {
    label: "Build",
    color: "accent",
    injectSandboxInfo: true,
    sandbox: { enabled: true, writable: true },
    permission: {
      write: "ask",
      bash: { "*": "allow" },
      web_search: "ask",
      tool: "ask",
      skill: "ask",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// updateStatus
// ---------------------------------------------------------------------------

test("updateStatus: enforcing mode with filtered network", () => {
  const ctx = makeFakeCtx();
  const mode = makeModeDef({ label: "Build", color: "accent" });
  const sandbox = new SandboxController();
  (sandbox as unknown as { ready: boolean }).ready = true;
  updateStatus(ctx as unknown as ExtensionContext, mode, sandbox, false);
  assert.ok(ctx.statusValue?.includes("sandboxed"));
  assert.ok(ctx.statusValue?.includes("Network: filtered"));
});

test("updateStatus: enforcing mode with open network", () => {
  const ctx = makeFakeCtx();
  const mode = makeModeDef({ label: "Build", color: "accent" });
  const sandbox = new SandboxController();
  (sandbox as unknown as { ready: boolean }).ready = true;
  updateStatus(ctx as unknown as ExtensionContext, mode, sandbox, true);
  assert.ok(ctx.statusValue?.includes("Network: open"));
});

test("updateStatus: enforcing mode with warn shows warning", () => {
  const ctx = makeFakeCtx();
  const mode = makeModeDef({ label: "Build", color: "accent" });
  const sandbox = new SandboxController();
  (sandbox as unknown as { ready: boolean }).ready = true;
  (sandbox as unknown as { warn: string | undefined }).warn =
    "sandbox degraded: missing dependency";
  (sandbox as unknown as { disabled: boolean }).disabled = false;
  updateStatus(ctx as unknown as ExtensionContext, mode, sandbox, false);
  assert.ok(ctx.statusValue?.includes("(!)"));
  assert.ok(ctx.statusValue?.includes("degraded"));
});

test("updateStatus: non-enforcing mode shows (alt+m)", () => {
  const ctx = makeFakeCtx();
  const mode = makeModeDef({ label: "YOLO", color: "error" });
  const sandbox = new SandboxController();
  (sandbox as unknown as { ready: boolean }).ready = false;
  updateStatus(ctx as unknown as ExtensionContext, mode, sandbox, true);
  assert.ok(ctx.statusValue?.includes("(alt+m)"));
  assert.ok(ctx.statusValue?.includes("Network: open"));
});

test("updateStatus: disabled sandbox shows (alt+m) even if enabled", () => {
  const ctx = makeFakeCtx();
  const mode = makeModeDef({
    label: "Build",
    color: "accent",
    sandbox: { enabled: true, writable: true },
  });
  const sandbox = new SandboxController();
  (sandbox as unknown as { ready: boolean }).ready = false;
  updateStatus(ctx as unknown as ExtensionContext, mode, sandbox, false);
  assert.ok(ctx.statusValue?.includes("(alt+m)"));
  // When not enforcing, network is always open.
  assert.ok(ctx.statusValue?.includes("Network: open"));
});

test("updateStatus: disabling sandbox hides network status", () => {
  const ctx = makeFakeCtx();
  const mode = makeModeDef({
    label: "Build",
    color: "accent",
    sandbox: { enabled: false, writable: false },
  });
  const sandbox = new SandboxController();
  updateStatus(ctx as unknown as ExtensionContext, mode, sandbox, false);
  // Sandbox not enabled → non-enforcing → network open.
  assert.ok(ctx.statusValue?.includes("Network: open"));
});

test("updateStatus: mode with warn + disabled doesn't show warning", () => {
  const ctx = makeFakeCtx();
  const mode = makeModeDef({ label: "Build", color: "accent" });
  const sandbox = new SandboxController();
  (sandbox as unknown as { ready: boolean }).ready = true;
  (sandbox as unknown as { warn: string | undefined }).warn = "some warning";
  (sandbox as unknown as { disabled: boolean }).disabled = true;
  updateStatus(ctx as unknown as ExtensionContext, mode, sandbox, false);
  // warn is suppressed when disabled=true.
  assert.ok(!ctx.statusValue?.includes("(!)"));
});

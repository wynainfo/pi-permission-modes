/**
 * The model's two background-shell tools: `bash_output` (status and the
 * output since the last read) and `kill_shell` (a signal of the model's
 * choice, SIGKILL after a grace period). The names are the ones most models
 * already know from other harnesses; the UI side is `/shells`.
 */

import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { docRef } from "../docs.ts";
import { describeShell, READ_CAP_BYTES, type ShellManager, STOP_SIGNALS, type StopSignal } from "./shells.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

/** Lines the first read of a shell returns at most. */
export const FIRST_READ_LINES = 200;

/** Longest `wait_seconds` a bash_output call may block. */
export const MAX_WAIT_SECONDS = 60;

/** The status header plus the new output of one read, as the model sees it. */
export function renderOutput(
  manager: ShellManager,
  id: string,
  opts: { filter?: string; fromByte?: number; now?: number },
): string {
  const r = manager.get(id);
  if (!r) return `No background shell ${id}. Running: ${manager.running().map((s) => s.id).join(", ") || "(none)"}.`;
  const read = manager.read(id, { filter: opts.filter, fromByte: opts.fromByte, firstLines: FIRST_READ_LINES });
  if (!read) return `No background shell ${id}.`;
  const head = `background shell ${id} (${r.command.replace(/\s+/g, " ").slice(0, 80)}): ${describeShell(r, opts.now)}; log ${read.size} bytes, read position ${read.offset}`;
  const parts = [head];
  if (read.newBytes === 0) parts.push("(no new output)");
  else {
    const skipped = read.skippedLines > 0 ? ` (${read.skippedLines} earlier line(s) skipped; pass from_byte to read them)` : "";
    parts.push(`--- new output${skipped} ---`, read.text.replace(/\n$/, ""));
  }
  if (read.violations.trim()) parts.push("--- sandbox violations since the last read ---", read.violations.trim());
  return parts.join("\n");
}

export function createShellTools(
  getManager: () => ShellManager | undefined,
  opts: { platform?: NodeJS.Platform; onBeforeRead?: () => void } = {},
): ToolDefinition[] {
  const platform = opts.platform ?? process.platform;
  const unavailable = text("Background shells are not available in this session (no scratch directory).");
  const bashOutput: ToolDefinition = {
    name: "bash_output",
    label: "Background shell output",
    promptSnippet: "Read a background shell's status and the output written since the last read",
    description:
      "Status of a background shell started with bash run_in_background, and the output it wrote since your last bash_output call " +
      `(the first call returns the last ${FIRST_READ_LINES} lines; at most ${READ_CAP_BYTES / 1024} KB per call). ` +
      `Pass wait_seconds to block until new output arrives or the shell ends (up to ${MAX_WAIT_SECONDS}), for example until a server prints that it listens. ` +
      "Sandbox violations of the shell (refused writes, denied hosts) are appended. " +
      `See ${docRef("shells")}.`,
    parameters: Type.Object({
      bash_id: Type.String({ description: "The id bash returned when it started the shell" }),
      filter: Type.Optional(Type.String({ description: "Regular expression: only lines matching it are returned (the read position still advances past everything)" })),
      wait_seconds: Type.Optional(Type.Number({ description: `Block up to this many seconds for new output or the shell's end (max ${MAX_WAIT_SECONDS})` })),
      from_byte: Type.Optional(Type.Number({ description: "Read from this byte offset instead of continuing after the last read (0 = from the start)" })),
    }),
    async execute(_id, params) {
      const manager = getManager();
      if (!manager) return unavailable;
      const { bash_id, filter, wait_seconds, from_byte } = params as { bash_id: string; filter?: string; wait_seconds?: number; from_byte?: number };
      const r = manager.get(bash_id);
      if (!r) return text(renderOutput(manager, bash_id, {}));
      if (wait_seconds && wait_seconds > 0 && r.status === "running") {
        await manager.waitForChange(bash_id, from_byte, Math.min(wait_seconds, MAX_WAIT_SECONDS));
      }
      opts.onBeforeRead?.();
      return text(renderOutput(manager, bash_id, { filter, fromByte: from_byte }));
    },
  };
  const killShell: ToolDefinition = {
    name: "kill_shell",
    label: "Stop background shell",
    promptSnippet: "Stop a background shell with a signal of your choice",
    description:
      "Stop a background shell. You choose the signal (default TERM; INT for programs that handle Ctrl-C, HUP, or KILL) " +
      "and the grace period after which SIGKILL follows (default 10 s; 0 = never). " +
      (platform === "win32"
        ? "On Windows the process tree is ended by force at once: there is no graceful signal, so prefer the program's own shutdown (an endpoint, a quit command) when it matters. "
        : "") +
      `See ${docRef("shells")}.`,
    parameters: Type.Object({
      shell_id: Type.String({ description: "The id bash returned when it started the shell" }),
      signal: Type.Optional(Type.Union(STOP_SIGNALS.map((s) => Type.Literal(s)), { description: "TERM (default), INT, HUP or KILL" })),
      grace_seconds: Type.Optional(Type.Number({ description: "Seconds before SIGKILL follows the signal (default 10; 0 = no follow-up)" })),
    }),
    async execute(_id, params) {
      const manager = getManager();
      if (!manager) return unavailable;
      const { shell_id, signal, grace_seconds } = params as { shell_id: string; signal?: StopSignal; grace_seconds?: number };
      return text(await manager.stop(shell_id, { signal, graceSeconds: grace_seconds }));
    },
  };
  return [bashOutput, killShell];
}

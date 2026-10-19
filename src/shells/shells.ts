/**
 * Background shells: a bash call with `run_in_background: true` starts a
 * process that outlives the call. Each shell is one process tree whose main
 * process stays alive as long as the shell does; it runs under the same
 * sandbox and the same policy gate as a foreground bash call, writes its
 * output to a log file under the session's scratch directory, and ends with
 * the session.
 *
 * This module is the registry and the lifecycle (start, read, stop, notice).
 * It is SDK-free: how a process is launched (sandboxed or not) is injected as
 * a `ShellLauncher`, and how the model is told about an exit as `notify`.
 */

import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ShellStatus = "running" | "exited" | "killed" | "stopped" | "failed";

/** The stop reason of a shell ended because the sandbox restarts under another profile (status `stopped`, not `killed`). */
export const PROFILE_CHANGED_REASON = "sandbox profile changed";

/** What is persisted per shell (`meta.json`), and what the tools and `/shells` show. */
export interface ShellRecord {
  id: string;
  command: string;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  status: ShellStatus;
  /** Why it ended other than by itself: "killed by kill_shell (SIGTERM)", "timeout 60s", "session ended", "sandbox profile changed". */
  reason?: string;
  dir: string;
  logFile: string;
  sandboxed: boolean;
  /** Attribution key of the run in the sandbox's violation store (sandboxed shells only). */
  commandId?: string;
}

/** The signals the model may choose; Windows knows none of them (its stop is forced). */
export const STOP_SIGNALS = ["TERM", "INT", "HUP", "KILL"] as const;
export type StopSignal = (typeof STOP_SIGNALS)[number];

/** What a launcher hands back: the process, and what to run once it has closed. */
export interface LaunchedShell {
  child: ChildProcess;
  sandboxed: boolean;
  /** Attribution key of this run (the sandbox's violation store files events under it); undefined when unsandboxed. */
  commandId?: string;
  /** Runs once after the process closed: the runtime's cleanup, counters, temp files. */
  onClose?: () => void;
}

/** Starts the process for a shell: stdout and stderr go to `logFd`, nothing is read from stdin. */
export type ShellLauncher = (opts: { command: string; cwd: string; logFd: number }) => Promise<LaunchedShell>;

export interface ShellManagerOptions {
  /** `<scratch>/shells`; each shell gets a folder below it. */
  baseDir: string;
  cwd: string;
  maxConcurrent: number;
  platform?: NodeJS.Platform;
  /** The completion notice: called once when a shell ends by itself (exit or timeout), never for a stop the caller ordered. */
  notify?: (shell: ShellRecord, lastLines: string) => void;
  /** Called on every start and end (the footer chip follows the count). */
  onChange?: (shell: ShellRecord) => void;
  /** Stops a Windows process tree (`taskkill /T /F`); signals do not exist there. */
  killTree?: (child: ChildProcess) => void;
  now?: () => number;
}

interface LiveShell {
  record: ShellRecord;
  child?: ChildProcess;
  commandId?: string;
  logFd?: number;
  /** Where `bash_output` continues reading. */
  readOffset: number;
  /** Where `bash_output` continues reading the violations log. */
  violationsOffset: number;
  killTimer?: NodeJS.Timeout;
  graceTimer?: NodeJS.Timeout;
  /** The exit the caller ordered (no notice for it), set before the signal is sent. */
  ordered?: string;
  closed: Promise<void>;
  resolveClosed: () => void;
}

/** Result of reading a shell's output. */
export interface ShellRead {
  text: string;
  /** Bytes the log holds in total. */
  size: number;
  /** Bytes returned by this read, before the line cap. */
  newBytes: number;
  /** The read position for the next call. */
  offset: number;
  /** Lines dropped from the front of this read by the line cap. */
  skippedLines: number;
}

/** Bytes one read returns at most (the model's context is the limit, not the file). */
export const READ_CAP_BYTES = 64 * 1024;

/** How long `start` waits for an instant failure to report its exit code inline. */
export const START_GRACE_MS = 500;

/** Default grace between the stop signal and SIGKILL. */
export const DEFAULT_GRACE_SECONDS = 10;

export function newShellId(taken: (id: string) => boolean = () => false): string {
  for (;;) {
    const id = Math.random().toString(16).slice(2, 8).padEnd(6, "0");
    if (!taken(id)) return id;
  }
}

/** "3m12s", "45s", "2h03m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** One line of status for a record: "running for 12s", "exited 0 after 3m12s", "killed (SIGTERM, kill_shell) after 40s". */
export function describeShell(r: ShellRecord, now = Date.now()): string {
  const age = formatDuration((r.endedAt ?? now) - r.startedAt);
  switch (r.status) {
    case "running":
      return `running for ${age}`;
    case "exited":
      return `exited ${r.exitCode} after ${age}`;
    case "failed":
      return `failed to start${r.reason ? ` (${r.reason})` : ""}`;
    default:
      return `${r.status}${r.reason ? ` (${r.reason})` : ""} after ${age}`;
  }
}

/** The last `n` lines of `text` (a trailing newline does not count as a line). */
export function tailLines(text: string, n: number): string {
  const lines = text.replace(/\n$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/**
 * Lines of `text` matching `filter` (a regular expression source); an invalid
 * pattern returns an error message instead of lines.
 */
export function filterLines(text: string, filter: string): { text: string } | { error: string } {
  let re: RegExp;
  try {
    re = new RegExp(filter);
  } catch (err) {
    return { error: `invalid filter ${JSON.stringify(filter)}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { text: text.split("\n").filter((l) => re.test(l)).join("\n") };
}

/** Read `file` from `offset`, at most READ_CAP_BYTES from its END when more is new. */
export function readLog(file: string, offset: number, cap = READ_CAP_BYTES): ShellRead {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return { text: "", size: 0, newBytes: 0, offset, skippedLines: 0 };
  }
  const from = Math.min(offset, size);
  const newBytes = size - from;
  if (newBytes <= 0) return { text: "", size, newBytes: 0, offset: size, skippedLines: 0 };
  const start = newBytes > cap ? size - cap : from;
  let text = "";
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    text = buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
  let skippedLines = 0;
  if (start > from) {
    // Cut at a line boundary and say how much of the new output was skipped.
    const skipped = readFileRange(file, from, start);
    skippedLines = (skipped.match(/\n/g) ?? []).length;
    const nl = text.indexOf("\n");
    if (nl >= 0) {
      text = text.slice(nl + 1);
      skippedLines += 1;
    }
  }
  return { text, size, newBytes, offset: size, skippedLines };
}

function readFileRange(file: string, from: number, to: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, to - from));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export class ShellManager {
  private shells = new Map<string, LiveShell>();
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly opts: ShellManagerOptions;

  constructor(opts: ShellManagerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.platform = opts.platform ?? process.platform;
    this.loadFinished();
  }

  /** Every shell of this session, running first, then by start time. */
  list(): ShellRecord[] {
    return [...this.shells.values()]
      .map((s) => s.record)
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || a.startedAt - b.startedAt);
  }

  get(id: string): ShellRecord | undefined {
    return this.shells.get(id)?.record;
  }

  running(): ShellRecord[] {
    return this.list().filter((r) => r.status === "running");
  }

  /** Shells whose records live in `baseDir` from an earlier process (a resumed session): shown, never re-attached. */
  private loadFinished(): void {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(this.opts.baseDir);
    } catch {
      return;
    }
    for (const id of dirs) {
      try {
        const meta = JSON.parse(readFileSync(path.join(this.opts.baseDir, id, "meta.json"), "utf8")) as ShellRecord;
        if (!meta.id || this.shells.has(meta.id)) continue;
        if (meta.status === "running") {
          meta.status = "killed";
          meta.reason = "session ended";
          meta.endedAt = meta.endedAt ?? this.now();
        }
        this.shells.set(meta.id, this.liveFrom(meta));
      } catch {
        // not one of ours, or unreadable: skip
      }
    }
  }

  private liveFrom(record: ShellRecord): LiveShell {
    let resolveClosed = () => {};
    const closed = new Promise<void>((r) => (resolveClosed = r));
    if (record.status !== "running") resolveClosed();
    return { record, readOffset: 0, violationsOffset: 0, closed, resolveClosed };
  }

  private writeMeta(s: LiveShell): void {
    try {
      writeFileSync(path.join(s.record.dir, "meta.json"), JSON.stringify(s.record, null, 2));
    } catch {
      // the scratch dir may be gone at shutdown
    }
  }

  /** The reason a new shell cannot start right now, or undefined. */
  refusal(): string | undefined {
    const n = this.running().length;
    if (n >= this.opts.maxConcurrent) {
      return `${n} background shell(s) already run (${this.running()
        .map((r) => r.id)
        .join(", ")}); the limit is ${this.opts.maxConcurrent}. Stop one with kill_shell first.`;
    }
    return undefined;
  }

  /**
   * Start a shell. Resolves after at most START_GRACE_MS with the record,
   * which reports an instant failure (a typo) with its exit code; otherwise
   * the shell keeps running and the record says so.
   */
  async start(command: string, launch: ShellLauncher, opts: { timeoutSeconds?: number } = {}): Promise<ShellRecord> {
    const id = newShellId((x) => this.shells.has(x));
    const dir = path.join(this.opts.baseDir, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const logFile = path.join(dir, "output.log");
    const record: ShellRecord = { id, command, startedAt: this.now(), status: "running", dir, logFile, sandboxed: false };
    const live = this.liveFrom(record);
    this.shells.set(id, live);
    let logFd: number;
    try {
      logFd = openSync(logFile, "a", 0o600);
    } catch (err) {
      return this.failed(live, `cannot open ${logFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
    live.logFd = logFd;
    let launched: LaunchedShell;
    try {
      launched = await launch({ command, cwd: this.opts.cwd, logFd });
    } catch (err) {
      closeSync(logFd);
      return this.failed(live, err instanceof Error ? err.message : String(err));
    }
    const { child } = launched;
    record.pid = child.pid;
    record.sandboxed = launched.sandboxed;
    record.commandId = launched.commandId;
    live.child = child;
    live.commandId = launched.commandId;
    this.writeMeta(live);
    child.on("error", (err) => {
      this.append(live, `\n[permission-mode] background shell failed: ${err.message}\n`);
    });
    child.on("close", (code, signal) => {
      this.closed(live, code, signal, launched.onClose);
    });
    if (opts.timeoutSeconds && opts.timeoutSeconds > 0) {
      live.killTimer = setTimeout(() => {
        void this.stop(id, { signal: "TERM", graceSeconds: 5, reason: `timeout ${opts.timeoutSeconds}s`, notice: true });
      }, opts.timeoutSeconds * 1000);
      live.killTimer.unref();
    }
    try {
      this.opts.onChange?.(record);
    } catch {
      // ignore
    }
    // An instant exit (a typo, a missing program) is worth reporting inline.
    await Promise.race([live.closed, new Promise((r) => setTimeout(r, START_GRACE_MS))]);
    return record;
  }

  private failed(live: LiveShell, reason: string): ShellRecord {
    live.record.status = "failed";
    live.record.reason = reason;
    live.record.endedAt = this.now();
    live.resolveClosed();
    this.writeMeta(live);
    return live.record;
  }

  private append(live: LiveShell, text: string): void {
    if (live.logFd === undefined) return;
    try {
      writeFileSync(live.logFd, text);
    } catch {
      // the log may be gone
    }
  }

  private closed(live: LiveShell, code: number | null, signal: NodeJS.Signals | null, onClose?: () => void): void {
    const r = live.record;
    if (live.killTimer) clearTimeout(live.killTimer);
    if (live.graceTimer) clearTimeout(live.graceTimer);
    live.killTimer = live.graceTimer = undefined;
    r.endedAt = this.now();
    r.exitCode = code;
    r.signal = signal;
    if (live.ordered !== undefined) {
      r.status = live.ordered === "stopped" ? "stopped" : "killed";
      // reason was set by stop()
    } else if (r.reason?.startsWith("timeout")) {
      r.status = "killed";
    } else {
      r.status = "exited";
    }
    try {
      onClose?.();
    } catch {
      // best effort
    }
    if (live.logFd !== undefined) {
      try {
        closeSync(live.logFd);
      } catch {
        // already closed
      }
      live.logFd = undefined;
    }
    live.child = undefined;
    this.writeMeta(live);
    live.resolveClosed();
    try {
      this.opts.onChange?.(r);
    } catch {
      // a stale UI after /reload
    }
    if (live.ordered === undefined && this.opts.notify) {
      let last = "";
      try {
        last = tailLines(readLog(r.logFile, 0, 16 * 1024).text, 10);
      } catch {
        // no log
      }
      try {
        this.opts.notify(r, last);
      } catch {
        // a stale pi after /reload throws; the record is what matters
      }
    }
  }

  /**
   * Stop a shell: `signal` to its process group (the model's choice), SIGKILL
   * after `graceSeconds` unless 0. On Windows the stop is forced at once.
   * Returns a sentence for the caller. `notice: true` keeps the completion
   * notice (a timeout counts as the shell ending by itself).
   */
  async stop(
    id: string,
    opts: { signal?: StopSignal; graceSeconds?: number; reason?: string; notice?: boolean; by?: string } = {},
  ): Promise<string> {
    const live = this.shells.get(id);
    if (!live) return `no background shell ${id}`;
    const r = live.record;
    if (r.status !== "running" || !live.child) return `background shell ${id} is not running (${describeShell(r, this.now())})`;
    const signal = opts.signal ?? "TERM";
    const grace = opts.graceSeconds ?? DEFAULT_GRACE_SECONDS;
    const by = opts.by ?? "kill_shell";
    if (!opts.notice) live.ordered = opts.reason === PROFILE_CHANGED_REASON ? "stopped" : "killed";
    if (this.platform === "win32") {
      r.reason = opts.reason ?? `${by}, forced`;
      (this.opts.killTree ?? ((c) => c.kill("SIGKILL")))(live.child);
      await live.closed;
      return `background shell ${id} stopped (Windows: the process tree was ended by force; there is no graceful signal here)`;
    }
    r.reason = opts.reason ?? `${by}, SIG${signal}`;
    const sent = this.signal(live.child, signal);
    if (!sent) {
      await Promise.race([live.closed, new Promise((res) => setTimeout(res, 1000))]);
      return r.status === "running" ? `could not signal background shell ${id}` : `background shell ${id} ${describeShell(r, this.now())}`;
    }
    if (signal !== "KILL" && grace > 0) {
      live.graceTimer = setTimeout(() => {
        if (live.child && r.status === "running") {
          r.reason = `${r.reason}, then SIGKILL after ${grace}s`;
          this.signal(live.child, "KILL");
        }
      }, grace * 1000);
      live.graceTimer.unref();
    }
    // Report what happened within about a second; a shell that takes longer
    // to go is still being stopped (the grace timer runs on), and the caller
    // is not held for the whole grace.
    await Promise.race([live.closed, new Promise((res) => setTimeout(res, 1200))]);
    if (r.status !== "running") return `background shell ${id} ${describeShell(r, this.now())}`;
    return `SIG${signal} sent to background shell ${id}; it is still running${grace > 0 && signal !== "KILL" ? ` (SIGKILL follows after ${grace}s)` : ""}`;
  }

  private signal(child: ChildProcess, signal: StopSignal): boolean {
    const sig = `SIG${signal}` as NodeJS.Signals;
    try {
      if (child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
      return true;
    } catch {
      try {
        return child.kill(sig);
      } catch {
        return false;
      }
    }
  }

  /** Stop every running shell (shutdown, a profile change): SIGTERM, SIGKILL after `graceSeconds`. */
  async stopAll(reason: string, graceSeconds = 5): Promise<ShellRecord[]> {
    const stopped = this.running();
    await Promise.all(
      stopped.map(async (r) => {
        await this.stop(r.id, { signal: "TERM", graceSeconds, reason, by: reason });
        // The caller restarts or ends the session next: wait for the close
        // (SIGKILL follows after the grace), so no shell outlives what comes.
        const live = this.shells.get(r.id);
        if (live && r.status === "running") await Promise.race([live.closed, new Promise((res) => setTimeout(res, graceSeconds * 1000 + 1500))]);
      }),
    );
    return stopped;
  }

  /**
   * Point the callbacks (and the limit) at a new extension instance: after
   * a `/reload` the previous instance hands its manager over with the shells
   * still running (index.ts Handoff), and its closures are stale.
   */
  rebind(opts: Partial<Pick<ShellManagerOptions, "notify" | "onChange" | "killTree" | "maxConcurrent">>): this {
    Object.assign(this.opts, opts);
    return this;
  }

  /**
   * Output since the last read (or from `fromByte`), capped; the first read
   * of a shell returns at most the last `firstLines` lines.
   */
  read(id: string, opts: { fromByte?: number; filter?: string; firstLines?: number } = {}): (ShellRead & { violations: string }) | undefined {
    const live = this.shells.get(id);
    if (!live) return undefined;
    const first = live.readOffset === 0 && opts.fromByte === undefined;
    const res = readLog(live.record.logFile, opts.fromByte ?? live.readOffset);
    let text = res.text;
    let skipped = res.skippedLines;
    if (first && opts.firstLines !== undefined) {
      const lines = text.replace(/\n$/, "").split("\n");
      if (lines.length > opts.firstLines) {
        skipped += lines.length - opts.firstLines;
        text = lines.slice(lines.length - opts.firstLines).join("\n") + (text.endsWith("\n") ? "\n" : "");
      }
    }
    if (opts.filter !== undefined) {
      const f = filterLines(text, opts.filter);
      text = "error" in f ? `[${f.error}]` : f.text;
    }
    live.readOffset = res.offset;
    const v = readLog(this.violationsFile(live.record), live.violationsOffset);
    live.violationsOffset = v.offset;
    return { ...res, text, skippedLines: skipped, violations: v.text };
  }

  /**
   * Resolves when the log grew past `offset` (the next read's position when
   * omitted) or the shell ended, or after `seconds`. Consumes nothing.
   */
  async waitForChange(id: string, offset: number | undefined, seconds: number): Promise<void> {
    const live = this.shells.get(id);
    if (!live) return;
    offset ??= live.readOffset;
    const deadline = this.now() + seconds * 1000;
    while (this.now() < deadline && live.record.status === "running") {
      let size = 0;
      try {
        size = statSync(live.record.logFile).size;
      } catch {
        // no log yet
      }
      if (size > offset) return;
      await Promise.race([live.closed, new Promise((r) => setTimeout(r, 200))]);
    }
  }

  private violationsFile(r: ShellRecord): string {
    return path.join(r.dir, "violations.log");
  }

  /** Record a sandbox violation line for the shell that owns `commandId`. */
  recordViolation(commandId: string, line: string): void {
    for (const live of this.shells.values()) {
      if (live.commandId === commandId) {
        try {
          writeFileSync(this.violationsFile(live.record), `${line}\n`, { flag: "a" });
        } catch {
          // best effort
        }
        return;
      }
    }
  }

  /** The commandIds of running sandboxed shells (the violation subscription filters on them). */
  commandIds(): Set<string> {
    return new Set([...this.shells.values()].flatMap((s) => (s.record.status === "running" && s.commandId ? [s.commandId] : [])));
  }

  /** Remove the folders of finished shells. Returns how many. */
  clean(): number {
    let n = 0;
    for (const [id, live] of [...this.shells]) {
      if (live.record.status === "running") continue;
      try {
        rmSync(live.record.dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
      this.shells.delete(id);
      n++;
    }
    return n;
  }

  /** The log path exists (a shell was started in this process or found on disk). */
  hasLog(id: string): boolean {
    const r = this.get(id);
    return r !== undefined && existsSync(r.logFile);
  }
}

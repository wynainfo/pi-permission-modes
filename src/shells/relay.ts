/**
 * Port exposure for background shells on Linux. TEMPORARY: the runtime
 * gives a sandboxed command a network namespace with a loopback of its own,
 * so a server inside it is unreachable from this machine. Until the runtime
 * relays ports itself (requested upstream; docs/shells.md, Network), this
 * module does it with what the sandbox lets through: an inherited node IPC
 * channel on fd 3, which the seccomp filter allows (it blocks the creation
 * of AF_UNIX sockets, not their use). A prelude in the shell's command
 * starts a small relay (`RELAY_SOURCE`, written next to the shell's log)
 * that holds the channel; the host listens on the exposed ports and passes
 * each accepted TCP connection to the relay, which dials 127.0.0.1:<port>
 * inside and pipes. The relay exits with the shell (an "end" message from
 * the host, and a check of its parent), and that exit is what lets node
 * emit the shell's close event: the channel counts toward it and is only
 * counted once the child side closes.
 *
 * Verified on node 22 without a sandbox (a request through the relay, the
 * close timing); bwrap and the seccomp helper pass inherited fds through
 * (the runtime's own `--args` profile travels on one).
 */

import type { ChildProcess } from "node:child_process";
import net from "node:net";

/** One exposed port: the host-side bind address and the port the relay dials inside the shell. */
export interface ExposeEntry {
  host: string;
  port: number;
  /** Bound to a loopback address: reachable from this machine only (no confirmation needed). */
  loopback: boolean;
}

/** Ports one shell may expose at most. */
export const MAX_EXPOSE = 8;

/** Time the relay gets to report "ready" (node starting inside the sandbox). */
export const READY_TIMEOUT_MS = 5000;

/** The relay's file name inside the shell's folder. */
export const RELAY_FILE = "relay.cjs";

/**
 * Parse bash's `expose` parameter: an integer N binds 127.0.0.1:N; a string
 * "host:port" binds that host ("0.0.0.0:N" for every interface); "N" alone
 * is 127.0.0.1:N. Every entry relays to 127.0.0.1:N inside the shell.
 */
export function parseExpose(raw: unknown): { entries: ExposeEntry[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'expose must be a list of ports (8123) or "host:port" strings ("0.0.0.0:8123")' };
  if (raw.length > MAX_EXPOSE) return { error: `expose lists at most ${MAX_EXPOSE} ports` };
  const entries: ExposeEntry[] = [];
  for (const item of raw) {
    let host = "127.0.0.1";
    let port: number;
    if (typeof item === "number") port = item;
    else if (typeof item === "string") {
      const m = /^(?:(.+):)?(\d{1,5})$/.exec(item.trim());
      if (!m) return { error: `expose entry "${item}" is not a port or "host:port"` };
      port = Number(m[2]);
      if (m[1]) host = m[1].replace(/^\[(.*)\]$/, "$1");
    } else return { error: `expose entry ${JSON.stringify(item)} is not a port or "host:port"` };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `expose port ${port} is out of range (1 to 65535)` };
    if (host === "localhost") host = "127.0.0.1";
    if (!/^[A-Za-z0-9.:-]+$/.test(host)) return { error: `expose host "${host}" is not an address` };
    if (entries.some((e) => e.port === port)) return { error: `expose lists port ${port} twice` };
    entries.push({ host, port, loopback: host.startsWith("127.") || host === "::1" });
  }
  return { entries };
}

/** `host:port` as the model and `/shells` see it. */
export const formatEntry = (e: ExposeEntry): string => `${e.host}:${e.port}`;

/**
 * The relay that runs inside the shell. It never listens: it receives
 * accepted connections over the channel and dials the port on the shell's
 * own loopback, so a server inside may bind 127.0.0.1.
 */
export const RELAY_SOURCE = `// pi-permission-modes: port relay of a background shell (temporary; see docs/shells.md, Network).
"use strict";
const net = require("node:net");
const parent = process.ppid;
process.on("message", (m, sock) => {
  if (m === "end") process.exit(0);
  if (!sock || !m || typeof m.port !== "number") return;
  const up = net.connect({ host: "127.0.0.1", port: m.port });
  const drop = () => { sock.destroy(); up.destroy(); };
  up.on("error", drop);
  sock.on("error", drop);
  up.on("connect", () => { sock.pipe(up); up.pipe(sock); });
});
process.on("disconnect", () => process.exit(0));
setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 500);
process.send("ready");
`;

const q = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * The line that starts the relay before the user's command: node with the
 * channel on fd 3, then the fd closed and the variables unset so nothing the
 * command starts inherits them (a node program would try to speak to it).
 */
export function relayPrelude(relayPath: string, execPath: string = process.execPath): string {
  return `NODE_CHANNEL_FD=3 ${q(execPath)} ${q(relayPath)} & exec 3<&-; unset NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE`;
}

/** The user's command with the relay prelude in front (its own line: the command may start with a comment). */
export function withRelay(command: string, relayPath: string, execPath?: string): string {
  return `${relayPrelude(relayPath, execPath)}\n${command}`;
}

export interface RelaySet {
  /** The addresses bound on this machine, `host:port`. */
  bound: string[];
  /** Close the listeners (the shell ended, or is being refused). */
  close(): void;
}

/**
 * Wait for the relay's "ready", then listen on every entry and hand each
 * accepted connection to the relay. Rejects (with the listeners closed)
 * when the relay does not start, the shell ends first, or a port cannot be
 * bound; the caller then ends the shell and refuses the start.
 */
export function startRelays(child: ChildProcess, entries: ExposeEntry[], readyTimeoutMs = READY_TIMEOUT_MS): Promise<RelaySet> {
  return new Promise((resolve, reject) => {
    const servers: net.Server[] = [];
    let settled = false;
    const close = () => {
      for (const s of servers.splice(0)) s.close();
    };
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      close();
      reject(new Error(msg));
    };
    const timer = setTimeout(
      () => fail(`the port relay did not report within ${readyTimeoutMs / 1000} s (node must be runnable inside the sandbox: ${process.execPath})`),
      readyTimeoutMs,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      if (child.connected) {
        try {
          child.send("end");
        } catch {
          // the channel is gone with the shell
        }
      }
      close();
      fail("the shell ended before the port relay started");
    });
    child.on("message", (m) => {
      if (m !== "ready" || settled) return;
      clearTimeout(timer);
      void bind();
    });
    const bind = async () => {
      for (const e of entries) {
        const server = net.createServer({ pauseOnConnect: true }, (sock) => {
          // pauseOnConnect: nothing is read here, so the first bytes reach the relay with the handle.
          if (!child.connected) return sock.destroy();
          child.send({ port: e.port }, sock, { keepOpen: false }, (err) => {
            if (err) sock.destroy();
          });
        });
        servers.push(server);
        try {
          await new Promise<void>((res, rej) => {
            server.once("error", rej);
            server.listen(e.port, e.host, () => {
              server.off("error", rej);
              res();
            });
          });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          return fail(`cannot listen on ${formatEntry(e)}${code === "EADDRINUSE" ? " (the port is in use on this machine)" : code ? ` (${code})` : ""}`);
        }
      }
      if (settled) return;
      settled = true;
      child.channel?.unref(); // the listeners keep the loop alive while they are open; the channel need not
      resolve({ bound: entries.map(formatEntry), close });
    };
  });
}

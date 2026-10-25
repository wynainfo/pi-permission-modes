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

// ---------------------------------------------------------------------------
// The other direction: the agent's own foreground commands reach a port a
// running shell exposes. A foreground command has a loopback of its own too,
// so while shells expose ports, each sandboxed command starts with a small
// listener inside (`INBOUND_SOURCE`) on those ports; every accepted
// connection is handed OUT over the command's IPC channel (child to parent
// handle passing, allowed like the other direction) and pi pipes it into a
// fresh connection to the shell's exposed address on this machine, the path
// a browser takes (the host listener, the shell's channel, `RELAY_SOURCE`).
// Not by re-sending the handle: a handle received over one child's channel
// stalls when sent on over another's (node 22). No allowlist entry and no
// grant: the listener lives and dies with the command, and is only started
// for ports whose shell runs when the command spawns, so a shell's end
// revokes the access by itself.

/** The inbound relay's file name (written once per session under the scratch dir). */
export const INBOUND_FILE = "inbound.cjs";

/** Longest wait, in 50 ms steps, for the inbound listeners before the command runs. */
export const INBOUND_WAIT_STEPS = 40;

/** The listener that runs inside a foreground command: argv names the ports. */
export const INBOUND_SOURCE = `// pi-permission-modes: loopback of a foreground command to the ports of background shells (temporary; see docs/shells.md, Network).
"use strict";
const net = require("node:net");
const parent = process.ppid;
for (const arg of process.argv.slice(2)) {
  const port = Number(arg);
  const server = net.createServer({ pauseOnConnect: true }, (sock) => {
    if (!process.connected) return sock.destroy();
    process.send({ port }, sock, { keepOpen: false }, (err) => { if (err) sock.destroy(); });
  });
  server.on("error", () => {});
  server.listen(port, "127.0.0.1");
}
process.on("disconnect", () => process.exit(0));
setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 500);
`;

/** A port as `/proc/net/tcp` prints it in the local address column. */
export const hexPort = (port: number): string => port.toString(16).toUpperCase().padStart(4, "0");

/**
 * The lines that start the inbound listener before a foreground command:
 * node with the channel on fd 3, the fd closed and the variables unset for
 * the command, then a wait of at most 2 s until every port shows as
 * listening in the namespace's own /proc/net/tcp, so the command's first
 * connection does not race node's start.
 */
export function inboundPrelude(inboundPath: string, ports: number[], execPath: string = process.execPath): string {
  const args = ports.map((p) => String(p)).join(" ");
  const checks = ports.map((p) => `grep -q ':${hexPort(p)} ' /proc/net/tcp /proc/net/tcp6`).join(" && ");
  return (
    `NODE_CHANNEL_FD=3 ${q(execPath)} ${q(inboundPath)} ${args} & exec 3<&-; unset NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE\n` +
    `_pi_i=0; while [ $_pi_i -lt ${INBOUND_WAIT_STEPS} ] && ! { ${checks}; } 2>/dev/null; do sleep 0.05; _pi_i=$((_pi_i+1)); done; unset _pi_i`
  );
}

/** The command with the inbound prelude in front (its own lines: the command may start with a comment). */
export function withInbound(command: string, inboundPath: string, ports: number[], execPath?: string): string {
  return `${inboundPrelude(inboundPath, ports, execPath)}\n${command}`;
}

/** The address on this machine pi dials for an exposed entry: a wildcard bind is reached through loopback. */
export function inboundTarget(e: ExposeEntry): string {
  return e.host === "0.0.0.0" || e.host === "::" ? "127.0.0.1" : e.host;
}

/**
 * Which exposed ports are live, and where on this machine each one answers.
 * Registered when a shell's relays are up, released when the shell ends; a
 * connection for a port nobody exposes is refused.
 */
export class InboundRouter {
  private readonly targets = new Map<number, { host: string; owner: object }>();

  /** Claim the entries for one shell; the returned function releases them (idempotent, and only its own). */
  register(entries: ExposeEntry[], owner: object = {}): () => void {
    for (const e of entries) this.targets.set(e.port, { host: inboundTarget(e), owner });
    return () => {
      for (const e of entries) if (this.targets.get(e.port)?.owner === owner) this.targets.delete(e.port);
    };
  }

  /** The ports foreground commands should listen on right now, ascending. */
  ports(): number[] {
    return [...this.targets.keys()].sort((a, b) => a - b);
  }

  /**
   * Pipe a connection a foreground command handed out into the shell's
   * exposed address on this machine; false when no running shell exposes
   * the port (the caller destroys the socket: "connection refused" inside).
   */
  deliver(port: number, sock: net.Socket): boolean {
    const t = this.targets.get(port);
    if (!t) return false;
    const up = net.connect({ host: t.host, port });
    const drop = () => {
      sock.destroy();
      up.destroy();
    };
    up.on("error", drop);
    sock.on("error", drop);
    up.on("connect", () => {
      sock.pipe(up);
      up.pipe(sock);
    });
    return true;
  }
}

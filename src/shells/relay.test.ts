import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatEntry, parseExpose, RELAY_FILE, RELAY_SOURCE, relayPrelude, startRelays, withRelay } from "./relay.ts";
import { type LaunchedShell, type ShellLauncher, ShellManager } from "./shells.ts";

test("parseExpose: integers, host:port strings, loopback detection, refusals", () => {
  const ok = parseExpose([8123, "0.0.0.0:8124", "localhost:8125", "8126", "[::1]:8127"]);
  assert.ok("entries" in ok);
  assert.deepEqual(
    ok.entries.map((e) => [formatEntry(e), e.loopback]),
    [
      ["127.0.0.1:8123", true],
      ["0.0.0.0:8124", false],
      ["127.0.0.1:8125", true],
      ["127.0.0.1:8126", true],
      ["::1:8127", true],
    ],
  );
  for (const [raw, msg] of [
    [8123, "must be a list"],
    [[0], "out of range"],
    [[70000], "out of range"],
    [[1.5], "out of range"],
    [["x"], 'not a port or "host:port"'],
    [[true], 'not a port or "host:port"'],
    [["a b:80"], "not an address"],
    [[80, "0.0.0.0:80"], "twice"],
    [Array.from({ length: 9 }, (_, i) => 1000 + i), "at most 8"],
  ] as Array<[unknown, string]>) {
    const r = parseExpose(raw);
    assert.ok("error" in r, JSON.stringify(raw));
    assert.match(r.error, new RegExp(msg));
  }
});

test("relayPrelude: node on fd 3 in the background, the fd and the variables gone for the command", () => {
  const line = relayPrelude("/s/it's/relay.cjs", "/opt/node");
  assert.equal(line, `NODE_CHANNEL_FD=3 '/opt/node' '/s/it'\\''s/relay.cjs' & exec 3<&-; unset NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE`);
  assert.equal(withRelay("# first line is a comment\nnpm run dev", "/r", "/n"), `${relayPrelude("/r", "/n")}\n# first line is a comment\nnpm run dev`);
  assert.match(RELAY_SOURCE, /process\.send\("ready"\)/);
});

/** A free TCP port on 127.0.0.1. */
const freePort = (): Promise<number> =>
  new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => res(port));
    });
  });

const get = (host: string, port: number, p = "/"): Promise<{ status: number; body: string }> =>
  new Promise((res, rej) => {
    http
      .get({ host, port, path: p }, (r) => {
        let b = "";
        r.on("data", (d) => (b += d));
        r.on("end", () => res({ status: r.statusCode ?? 0, body: b }));
      })
      .on("error", rej);
  });

// Without a sandbox the shell shares this machine's loopback, and the relay
// dials the same port number it was given: the host side binds 127.0.0.2
// (Linux answers on the whole 127/8) and relays to 127.0.0.1 inside.
const linuxOnly = process.platform === "linux" ? false : "the relay is Linux-only";

test("relay: a request on the host address reaches the server inside the shell; the listener closes with the shell; a used port refuses the start", { skip: linuxOnly }, async () => {
  const base = mkdtempSync(path.join(tmpdir(), "perm-relay-"));
  const manager = new ShellManager({ baseDir: path.join(base, "shells"), cwd: base, maxConcurrent: 4, platform: "linux" });
  const port = await freePort();
  /** The unsandboxed shape of index.ts's launcher: the prelude, an IPC fd, the relays bound before start() returns. */
  const launch =
    (entries: Parameters<typeof startRelays>[1]): ShellLauncher =>
    async ({ command, cwd, logFd, dir }) => {
      const relayPath = path.join(dir, RELAY_FILE);
      writeFileSync(relayPath, RELAY_SOURCE);
      const child = spawn("bash", ["-c", withRelay(command, relayPath)], { cwd, detached: true, stdio: ["ignore", logFd, logFd, "ipc"] });
      child.unref();
      try {
        const relays = await startRelays(child, entries);
        return { child, sandboxed: false, ports: relays.bound, onClose: () => relays.close() } satisfies LaunchedShell;
      } catch (err) {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        throw err;
      }
    };
  try {
    const server = `require('http').createServer((q, r) => r.end('inner ' + q.url)).listen(${port}, '127.0.0.1')`;
    const r = await manager.start(`node -e "${server}" & wait`, launch([{ host: "127.0.0.2", port, loopback: true }]), {});
    assert.equal(r.status, "running", `${r.reason}\n${readFileSync(r.logFile, "utf8")}`);
    assert.deepEqual(r.ports, [`127.0.0.2:${port}`]);
    await new Promise((res) => setTimeout(res, 400)); // the inner node server comes up
    assert.deepEqual(await get("127.0.0.2", port, "/hello"), { status: 200, body: "inner /hello" });
    assert.match(await manager.stop(r.id, { signal: "TERM" }), /killed/);
    await new Promise((res) => setTimeout(res, 300));
    await assert.rejects(get("127.0.0.2", port), /ECONNREFUSED/, "the host listener closed with the shell");
    // A port in use on the host: the start fails with the address named, nothing keeps running.
    const busy = net.createServer();
    await new Promise<void>((res) => busy.listen(port, "127.0.0.2", res));
    const failed = await manager.start("sleep 30", launch([{ host: "127.0.0.2", port, loopback: true }]), {});
    assert.equal(failed.status, "failed");
    assert.match(failed.reason ?? "", new RegExp(`cannot listen on 127.0.0.2:${port} \\(the port is in use on this machine\\)`));
    busy.close();
    assert.equal(manager.running().length, 0);
  } finally {
    await manager.stopAll("test ended", 1);
    rmSync(base, { recursive: true, force: true });
  }
});

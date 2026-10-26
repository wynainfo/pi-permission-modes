/**
 * Tests for network.ts — domain matching (runtime-mirroring semantics),
 * normalization, and the NetworkSession decision/memory/coalescing rules.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isHostAllowed, matchesDomainPattern, NetworkSession, normalizeDomain, promptNote } from "./network.ts";

test("matchesDomainPattern mirrors the sandbox-runtime semantics", () => {
  // Exact, case-insensitive.
  assert.ok(matchesDomainPattern("github.com", "github.com"));
  assert.ok(matchesDomainPattern("GitHub.COM", "github.com"));
  assert.ok(!matchesDomainPattern("api.github.com", "github.com"));
  // *.x matches subdomains only, NOT the base domain.
  assert.ok(matchesDomainPattern("api.github.com", "*.github.com"));
  assert.ok(matchesDomainPattern("a.b.github.com", "*.github.com"));
  assert.ok(!matchesDomainPattern("github.com", "*.github.com"));
  // No suffix tricks: evilgithub.com is not *.github.com.
  assert.ok(!matchesDomainPattern("evilgithub.com", "*.github.com"));
  assert.ok(isHostAllowed("registry.npmjs.org", ["github.com", "*.npmjs.org"]));
  assert.ok(!isHostAllowed("example.com", ["github.com", "*.npmjs.org"]));
});

test("normalizeDomain strips URL decoration down to the host", () => {
  assert.equal(normalizeDomain("https://api.example.com/v1/users?x=1"), "api.example.com");
  assert.equal(normalizeDomain("http://user:pw@host.io:8443/path"), "host.io");
  assert.equal(normalizeDomain("  Example.COM  "), "example.com");
  assert.equal(normalizeDomain("*.example.com"), "*.example.com"); // patterns pass through
  assert.equal(normalizeDomain("example.com:443"), "example.com");
  assert.equal(normalizeDomain("   "), undefined);
  assert.equal(normalizeDomain("https://"), undefined);
});

test("decide: open toggle allows everything without asking", async () => {
  const s = new NetworkSession();
  s.open = true;
  let asked = 0;
  assert.equal(
    await s.decide("anything.example", 443, async () => {
      asked++;
      return "deny";
    }),
    true,
  );
  assert.equal(asked, 0);
});

test("decide: session grants allow (incl. wildcard patterns), no prompt", async () => {
  const s = new NetworkSession();
  s.grant(["api.example.com", "*.trusted.io"]);
  assert.equal(await s.decide("api.example.com", 443, undefined), true);
  assert.equal(await s.decide("sub.trusted.io", 443, undefined), true);
  assert.equal(await s.decide("other.example.com", 443, undefined), false); // not granted, nobody to ask
});

test("decide: explicit deny is remembered, dismiss is not", async () => {
  const s = new NetworkSession();
  let calls = 0;
  const deny = async (): Promise<"deny"> => {
    calls++;
    return "deny";
  };
  assert.equal(await s.decide("blocked.io", 443, deny), false);
  // Every answer is kept for the command's output until drained; a decision without a prompt is not.
  assert.deepEqual(s.takePrompted().map((p) => `${p.host}:${p.result}`).slice(-1), ["blocked.io:deny"]);
  assert.equal(await s.decide("blocked.io", 443, deny), false); // remembered - no second prompt
  assert.deepEqual(s.takePrompted(), []);
  assert.equal(calls, 1);
  assert.deepEqual(s.denies(), ["blocked.io"]);

  let dismissCalls = 0;
  const dismiss = async (): Promise<"dismiss"> => {
    dismissCalls++;
    return "dismiss";
  };
  assert.equal(await s.decide("flaky.io", 443, dismiss), false);
  assert.equal(await s.decide("flaky.io", 443, dismiss), false); // asked again — dismiss isn't memory
  assert.equal(dismissCalls, 2);
});

test("decide: allow-session grants and lifts a prior deny via grant()", async () => {
  const s = new NetworkSession();
  assert.equal(await s.decide("api.svc.io", 443, async () => "deny"), false);
  s.grant(["api.svc.io"]); // e.g. /net allow after the fact
  assert.equal(await s.decide("api.svc.io", 443, undefined), true);

  assert.equal(await s.decide("other.svc.io", 443, async () => "allow-session"), true);
  assert.equal(await s.decide("other.svc.io", 443, undefined), true); // now granted
});

test("decide: concurrent asks for the same host coalesce into one prompt", async () => {
  const s = new NetworkSession();
  let calls = 0;
  let release: (v: "allow-session") => void;
  const gate = new Promise<"allow-session">((r) => {
    release = r;
  });
  const ask = async () => {
    calls++;
    return gate;
  };
  const [a, b, c] = await Promise.all([
    s.decide("burst.io", 443, ask),
    s.decide("burst.io", 443, ask),
    (async () => {
      release!("allow-session");
      return s.decide("burst.io", 443, ask);
    })(),
  ]);
  assert.deepEqual([a, b, c], [true, true, true]);
  assert.equal(calls, 1);
});

test("clear() resets grants, denies, and the open toggle", async () => {
  const s = new NetworkSession();
  s.open = true;
  s.grant(["a.io"]);
  await s.decide("b.io", 443, async () => "deny");
  s.clear();
  assert.equal(s.open, false);
  assert.deepEqual(s.grants(), []);
  assert.deepEqual(s.denies(), []);
  assert.equal(await s.decide("a.io", 443, undefined), false);
});

test("NetworkSession: hostnames are case-insensitive in grants and remembered denies", async () => {
  const n = new NetworkSession();
  let asks = 0;
  const ask = async () => {
    asks++;
    return "deny" as const;
  };
  assert.equal(await n.decide("Api.Example.com", 443, ask), false);
  assert.equal(await n.decide("api.example.com", 443, ask), false);
  assert.equal(asks, 1, "the deny is remembered regardless of case");
  n.grant(["API.example.com"]);
  assert.equal(await n.decide("api.EXAMPLE.com", 443, ask), true);
  assert.deepEqual(n.grants(), ["api.example.com"]);
});

test("promptNote: one line per answered prompt, nothing without one", () => {
  assert.equal(promptNote([]), "");
  const note = promptNote([
    { host: "example.com", result: "allow-session" },
    { host: "cdn.example.com", result: "allow-forever" },
    { host: "evil.io", result: "deny" },
    { host: "late.io", result: "dismiss" },
  ]);
  assert.match(note, /^<sandbox_network>\n/);
  assert.match(note, /the user was asked and allowed example\.com for this session\n/);
  assert.match(note, /allowed cdn\.example\.com for this mode permanently\n/);
  assert.match(note, /denied evil\.io for this session: do not retry it, ask the user if it is needed\n/);
  assert.match(note, /dismissed the prompt for late\.io: this connection was denied, a retry asks again\n<\/sandbox_network>$/);
});

test("decide: a temporary allow holds while its command runs, is not a grant, and the classifier's answers are noted without memory", async () => {
  const s = new NetworkSession();
  let running = true;
  s.allowWhile("CDN.example", () => running);
  assert.equal(await s.decide("cdn.example", 443, undefined), true);
  assert.deepEqual(s.grants(), [], "not a session grant");
  running = false;
  assert.equal(await s.decide("cdn.example", 443, undefined), false, "gone with the command");
  assert.equal(s.isAllowedNow("cdn.example"), false);
  // allow-command: through, nothing remembered; refuse: denied, nothing remembered (a retry asks again).
  let answers: Array<"allow-command" | "refuse"> = ["allow-command", "refuse", "refuse"];
  const ask = async () => {
    s.lastReason = "the task implies it";
    return answers.shift()!;
  };
  assert.equal(await s.decide("a.example", 443, ask), true);
  assert.deepEqual(s.grants(), []);
  assert.equal(await s.decide("b.example", 443, ask), false);
  assert.deepEqual(s.denies(), []);
  assert.equal(await s.decide("b.example", 443, ask), false, "asked again, not remembered");
  const note = promptNote(s.takePrompted());
  assert.match(note, /the Auto verdict allowed a\.example for this command: the task implies it/);
  assert.match(note, /the Auto verdict refused b\.example for this command: the task implies it\. Do not retry it through another command/);
  s.allowWhile("c.example", () => true);
  s.clear();
  assert.equal(s.isAllowedNow("c.example"), false, "clear drops temporary allows too");
});

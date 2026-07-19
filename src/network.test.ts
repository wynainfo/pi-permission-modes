/**
 * Tests for network.ts — domain matching (runtime-mirroring semantics),
 * normalization, and the NetworkSession decision/memory/coalescing rules.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { NetworkSession, isHostAllowed, matchesDomainPattern, normalizeDomain } from "./network.ts";

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
  assert.equal(await s.decide("blocked.io", 443, deny), false); // remembered — no second prompt
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

test("drainBlocked reports each denied host once, then resets", async () => {
  const s = new NetworkSession();
  const deny = async (): Promise<"deny"> => "deny";
  await s.decide("x.io", 443, deny);
  await s.decide("x.io", 443, deny); // remembered deny also records a block
  await s.decide("y.io", 443, undefined);
  assert.deepEqual(s.drainBlocked().sort(), ["x.io", "y.io"]);
  assert.deepEqual(s.drainBlocked(), []);
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

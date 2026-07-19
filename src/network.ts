/**
 * Network session state — live domain grants, denials, and the open/filtered
 * toggle that back the sandbox-runtime ask callback.
 *
 * The OS sandbox filters bash network traffic through a proxy. For any host
 * that matches no allow/deny rule the runtime consults an ask callback WHILE
 * THE CONNECTION WAITS — that callback is `NetworkSession.decide`, wired up in
 * index.ts. This is what turns the former silent block into a live permission
 * prompt, and what lets `/net open`, `/net allow` and `request_network_access`
 * take effect instantly without re-initializing the sandbox: the callback
 * reads this session state on every request.
 *
 * Decision order in `decide` (mirrors the runtime, which checks its own
 * deniedDomains/allowedDomains first and only then asks):
 *   open toggle → allow · session grant → allow · remembered deny → deny
 *   → ask the user (coalesced per host) → grant/deny/dismiss.
 * A "deny" is remembered for the session (so a retrying installer doesn't
 * prompt-storm); a dismissed/unanswerable prompt denies WITHOUT remembering.
 * Every denial is recorded and drained by the bash wrapper, which appends a
 * "these hosts were blocked" hint to the command output for the model.
 *
 * Pure and SDK-free; the prompting itself is injected as a function.
 */

/** Outcome of asking the user about one host. */
export type NetAskResult = "allow-session" | "allow-forever" | "deny" | "dismiss";

/** Ask the user about a blocked host. Undefined = nobody to ask (headless / asks disabled). */
export type NetAsk = (host: string, port: number | undefined) => Promise<NetAskResult>;

/**
 * Domain-pattern match with the sandbox-runtime's exact semantics:
 * `*.example.com` matches any SUBDOMAIN (not `example.com` itself); anything
 * else matches the hostname exactly, case-insensitively.
 */
export function matchesDomainPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    return host.toLowerCase().endsWith("." + pattern.slice(2).toLowerCase());
  }
  return host.toLowerCase() === pattern.toLowerCase();
}

/** True when `host` matches any of `patterns`. */
export function isHostAllowed(host: string, patterns: Iterable<string>): boolean {
  for (const p of patterns) if (matchesDomainPattern(host, p)) return true;
  return false;
}

/**
 * Normalize a model/user-supplied domain: trim, lower-case, strip a scheme,
 * path, port, and credentials if a full URL was pasted. Returns the bare
 * host/pattern, or undefined when nothing sensible remains.
 */
export function normalizeDomain(raw: string): string | undefined {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  d = d.replace(/^[^/@]*@/, ""); // credentials
  d = d.replace(/[/?#].*$/, ""); // path/query/fragment
  d = d.replace(/:\d+$/, ""); // port
  return d.length > 0 ? d : undefined;
}

export class NetworkSession {
  /** `/net open`: filtering suspended for the session — every host allowed. */
  open = false;
  private allow = new Set<string>(); // session-granted patterns
  private deny = new Set<string>(); // session-denied hosts (explicit user denies)
  private pending = new Map<string, Promise<boolean>>(); // per-host ask coalescing
  private blocked: string[] = []; // hosts denied since the last drain (for the bash hint)

  /** Grant patterns for the session (also lifts a remembered deny). */
  grant(patterns: string[]): void {
    for (const p of patterns) {
      this.allow.add(p);
      this.deny.delete(p);
    }
  }

  grants(): string[] {
    return [...this.allow];
  }

  denies(): string[] {
    return [...this.deny];
  }

  isGranted(host: string): boolean {
    return isHostAllowed(host, this.allow);
  }

  /** Forget all session grants/denies and close the open toggle. */
  clear(): void {
    this.allow.clear();
    this.deny.clear();
    this.blocked = [];
    this.open = false;
  }

  /** Hosts denied since the last call; draining resets the list. */
  drainBlocked(): string[] {
    const out = [...new Set(this.blocked)];
    this.blocked = [];
    return out;
  }

  /**
   * The runtime ask-callback body: decide whether `host` may be reached.
   * Concurrent requests for the same host share one prompt; the answer is
   * applied per NetAskResult (see module doc for the memory rules).
   */
  async decide(host: string, port: number | undefined, ask: NetAsk | undefined): Promise<boolean> {
    if (this.open) return true;
    if (this.isGranted(host)) return true;
    if (this.deny.has(host)) {
      this.blocked.push(host);
      return false;
    }
    if (!ask) {
      this.blocked.push(host);
      return false;
    }
    let p = this.pending.get(host);
    if (!p) {
      p = (async () => {
        const result = await ask(host, port);
        if (result === "allow-session" || result === "allow-forever") {
          this.grant([host]);
          return true;
        }
        if (result === "deny") this.deny.add(host);
        return false; // deny or dismiss
      })().finally(() => this.pending.delete(host));
      this.pending.set(host, p);
    }
    const allowed = await p;
    if (!allowed) this.blocked.push(host);
    return allowed;
  }
}

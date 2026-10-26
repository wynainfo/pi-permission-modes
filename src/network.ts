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
 * The runtime records each refusal under the command that made it; the
 * bash wrapper turns those into a per-command "blocked" hint for the model.
 *
 * Pure and SDK-free; the prompting itself is injected as a function.
 */

/**
 * Outcome of asking about one host: the user's answers, plus the Auto
 * classifier's two (src/auto): "allow-command" lets the connection through
 * without a session grant (the asker registered a temporary allow bound to
 * the running command, see `allowWhile`), "refuse" denies it without
 * remembering the host (the verdict cache remembers the command).
 */
export type NetAskResult = "allow-session" | "allow-forever" | "deny" | "dismiss" | "allow-command" | "refuse";

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

/** One answer the user gave to a live network prompt, for the model to read in the command's output. */
export interface PromptedHost {
  host: string;
  result: NetAskResult;
  /** The verdict's reason, for the classifier's answers. */
  reason?: string;
}

/**
 * The block appended to a command's output when the user answered network
 * prompts during it: the model only sees a connection that worked, or one
 * that failed, and would otherwise not know a person decided it.
 */
export function promptNote(prompted: readonly PromptedHost[]): string {
  if (prompted.length === 0) return "";
  const line = (p: PromptedHost): string => {
    switch (p.result) {
      case "allow-session":
        return `the user was asked and allowed ${p.host} for this session`;
      case "allow-forever":
        return `the user was asked and allowed ${p.host} for this mode permanently`;
      case "deny":
        return `the user was asked and denied ${p.host} for this session: do not retry it, ask the user if it is needed`;
      case "allow-command":
        return `the Auto verdict allowed ${p.host} for this command${p.reason ? `: ${p.reason}` : ""}`;
      case "refuse":
        return `the Auto verdict refused ${p.host} for this command${p.reason ? `: ${p.reason}` : ""}. Do not retry it through another command; ask the user if it is needed`;
      default:
        return `the user dismissed the prompt for ${p.host}: this connection was denied, a retry asks again`;
    }
  };
  return `<sandbox_network>\n${prompted.map(line).join("\n")}\n</sandbox_network>`;
}

export class NetworkSession {
  private prompted: PromptedHost[] = [];

  /** The prompts answered since the last call (drained): the running command's. */
  takePrompted(): PromptedHost[] {
    const out = this.prompted;
    this.prompted = [];
    return out;
  }

  /** `/net open`: filtering suspended for the session — every host allowed. */
  open = false;
  /** Set by an asker before it answers "allow-command" or "refuse": the verdict's reason for the command's note. */
  lastReason: string | undefined;
  private allow = new Set<string>(); // session-granted patterns
  private deny = new Set<string>(); // session-denied hosts (explicit user denies)
  private pending = new Map<string, Promise<boolean>>(); // per-host ask coalescing
  /** Temporary allows: a host reachable while `active()` holds (the command the Auto classifier allowed it for). */
  private temporary: Array<{ host: string; active: () => boolean }> = [];

  /**
   * Allow `host` while `active()` returns true: the Auto classifier's
   * per-command allow, gone when the command ends. Never a session grant,
   * never persisted; `decide` prunes entries whose command has ended.
   */
  allowWhile(host: string, active: () => boolean): void {
    this.temporary.push({ host: host.toLowerCase(), active });
  }

  /** True when a temporary allow covers `host` and its command still runs. */
  isAllowedNow(host: string): boolean {
    this.temporary = this.temporary.filter((t) => t.active());
    const h = host.toLowerCase();
    return this.temporary.some((t) => t.host === h);
  }

  /** Grant patterns for the session (also lifts a remembered deny). */
  grant(patterns: string[]): void {
    for (const raw of patterns) {
      const p = raw.toLowerCase(); // hostnames are case-insensitive; the memory must be too
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
    this.temporary = [];
    this.open = false;
  }

  /**
   * The runtime ask-callback body: decide whether `host` may be reached.
   * Concurrent requests for the same host share one prompt; the answer is
   * applied per NetAskResult (see module doc for the memory rules).
   */
  async decide(rawHost: string, port: number | undefined, ask: NetAsk | undefined): Promise<boolean> {
    const host = rawHost.toLowerCase();
    if (this.open) return true;
    if (this.isGranted(host)) return true;
    if (this.deny.has(host)) return false;
    if (this.isAllowedNow(host)) return true;
    if (!ask) return false;
    let p = this.pending.get(host);
    if (!p) {
      p = (async () => {
        const result = await ask(host, port);
        this.prompted.push({ host, result, ...(this.lastReason ? { reason: this.lastReason } : {}) });
        this.lastReason = undefined;
        if (result === "allow-session" || result === "allow-forever") {
          this.grant([host]);
          return true;
        }
        if (result === "allow-command") return true; // the asker registered the temporary allow
        if (result === "deny") this.deny.add(host);
        return false; // deny, refuse or dismiss
      })().finally(() => this.pending.delete(host));
      this.pending.set(host, p);
    }
    return await p;
  }
}

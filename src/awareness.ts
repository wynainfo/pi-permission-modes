/**
 * Sandbox awareness — the factual "these are your enforcement boundaries"
 * system-prompt section injected each turn (via before_agent_start) while a
 * sandboxed mode is active.
 *
 * Without it the model discovers the sandbox by crashing into it: writes to
 * $HOME, installs into ~/.npm, fetches from non-allowlisted domains — then
 * wastes turns probing variants of a command the kernel will never allow.
 * This section is generated from the ACTIVE mode's merged profile (so global
 * overrides and project tighten-only overlays are reflected truthfully) and
 * states where writes work, which reads are denied, which domains are
 * reachable, and how the prompt flow handles everything else.
 *
 * Tone matters: boundary-crossing commands (out-of-project paths, sudo) are
 * NOT discouraged — the policy layer prompts the user automatically and
 * approved commands run outside the sandbox. Only silent sandbox denials
 * (non-allowlisted domains, undetected out-of-boundary writes) warrant
 * "ask the user" guidance.
 *
 * Pure and SDK-free (like schema.ts/resolve.ts) so it unit-tests without the
 * host.
 */

import { docRef } from "./docs.ts";
import { expandHome } from "./resolve.ts";
import type { ModeDef } from "./schema.ts";

/** Whether ~/.ssh is under a denied path and not readable again through allowRead. */
function masksSshKeys(denyRead: string[], allowRead: string[] = []): boolean {
  const ssh = expandHome("~/.ssh");
  // The most specific matching entry decides: a deny of ~/.ssh under an
  // allow of ~ (the Windows default) still masks, an allow at or below the
  // deny re-opens.
  const depth = (p: string): number | undefined => {
    const d = expandHome(p).replace(/\/+$/, "");
    return ssh === d || ssh.startsWith(`${d}/`) ? d.split("/").length : undefined;
  };
  const deepest = (list: readonly string[]): number => Math.max(-1, ...list.map((p) => depth(p) ?? -1));
  const deny = deepest(denyRead);
  return deny >= 0 && deepest(allowRead) < deny;
}

/** True when an allowRead entry covers ~/.ssh (`~`, `$HOME`, the expanded home, or ~/.ssh itself). */
function grantsSsh(allowRead: readonly string[] | undefined): boolean {
  const ssh = expandHome("~/.ssh");
  return (allowRead ?? []).some((p) => {
    const d = expandHome(p).replace(/[\\/]+$/, "");
    return ssh === d || ssh.startsWith(`${d}/`);
  });
}

/** True when an allowRead entry grants the whole user profile (`~`, `$HOME`, the expanded home). */
function grantsHome(allowRead: readonly string[] | undefined): boolean {
  const home = expandHome("~");
  return (allowRead ?? []).some((p) => expandHome(p).replace(/[\\/]+$/, "") === home);
}

export interface AwarenessOptions {
  /** Whether the OS sandbox is actually enforcing (ready and not --no-sandbox). */
  active: boolean;
  /** Why it isn't, when a sandboxed mode runs degraded (warn text / --no-sandbox). */
  reason?: string;
  /** `/net open` / alt+n: domain filtering suspended for this session. */
  networkOpen?: boolean;
  /** Session-granted domains (via prompts, /net allow, request_network_access). */
  sessionDomains?: string[];
  /** This session's scratch directory (scratch.ts); TMPDIR points there inside bash. */
  scratchDir?: string;
  /** `process.platform`; the macOS-only lines render only on "darwin", the Windows ones on "win32". Injected so tests cover each. */
  platform?: NodeJS.Platform;
  /** Windows: the loopback mode the sandbox was installed with, which is what applies (the mode's `allowLocalBinding` does not). */
  windowsLoopback?: boolean;
  /** Windows: whether the user's profile is readable through the install's profile read grant (minus the credential stores). */
  windowsProfileRead?: "granted" | "absent";
}

/** The one-sentence scratch-directory instruction, shared by every variant. */
const scratchSentence = (dir: string): string =>
  `Keep temporary files, downloads, and throwaway scripts in this session's scratch directory: ${dir} ` +
  "($TMPDIR inside bash points there) — not elsewhere under /tmp and not in the project; it is cleaned up automatically.";

/** Render an allowWrite entry for the prompt ("." is the project root). */
const renderWritePath = (p: string): string => (p === "." || p === "./" ? "the project directory" : p);

/**
 * The sandbox-boundary section for `mode`, or undefined when there is nothing
 * to inject: the mode opted out (`injectSandboxInfo: false`), or it doesn't
 * sandbox at all (`sandbox.enabled: false` — full permissions need no
 * boundary briefing) and there is no scratch directory to point at. An
 * unsandboxed mode WITH a scratch directory gets a short section naming it:
 * keeping temp files per session is worth it even when nothing confines bash.
 */
/**
 * The `/sandbox` suffix for the local-binding line: what the setting means
 * on this platform.
 */
export function localBindingNote(on: boolean, platform: NodeJS.Platform): string {
  if (platform === "win32") return on ? " (installed with loopback open: a server a command starts is reachable from this machine while the command runs)" : " (installed with loopback closed: no listening, local services through the proxy only)";
  if (platform === "darwin") return on ? " (a server a command starts is reachable from this machine while the command runs; loopback is reached directly, past the proxy)" : " (no listening; loopback through the proxy only)";
  return " (the sandbox's loopback is its own on Linux: a server is reachable from this machine with managed jobs only)";
}

/**
 * The awareness line about servers a sandboxed command starts: whether this
 * machine can reach one, and that it ends with the command.
 */
export function localBindingLine(on: boolean, platform: NodeJS.Platform): string {
  const within = "it ends with the command, so start, use and stop it within one command (`server & sleep 30; curl ...; kill %1`)";
  if (platform === "linux") {
    return `- A server you start within a command listens inside the sandbox only: this machine cannot reach it (the sandbox has a loopback of its own), and ${within}.`;
  }
  if (on) {
    return `- A server you start within a command listens for real: the user can open it in a browser while the command runs, and ${within}; bind it to 127.0.0.1.`;
  }
  if (platform === "win32") {
    return "- Local binding is closed on this machine (an install-time choice of the Windows sandbox): a sandboxed command cannot listen on a port, and a raw TCP client (database drivers, psql, redis-cli) cannot reach a service on localhost; proxy-aware clients (curl, package managers) reach localhost after the user's approval.";
  }
  return `- Local binding is off in this mode: a sandboxed command cannot listen on a port, and a raw TCP client (database drivers, psql, redis-cli) cannot reach a service on localhost; proxy-aware clients (curl, package managers) reach localhost after the user's approval (see ${docRef("macosLoopback")}).`;
}

export function sandboxAwarenessPrompt(mode: ModeDef, opts: AwarenessOptions): string | undefined {
  if (mode.injectSandboxInfo === false) return undefined;
  const sb = mode.sandbox;
  if (!sb.enabled) {
    if (!opts.scratchDir) return undefined;
    return [`## Scratch directory (${mode.label})`, "", `Bash runs unsandboxed in this mode. ${scratchSentence(opts.scratchDir)}`].join("\n");
  }

  const header = `## Sandbox & permissions (${mode.label})`;

  if (!opts.active) {
    const lines = [
      header,
      "",
      `This mode normally runs bash inside an OS sandbox, but the sandbox is unavailable here${opts.reason ? ` (${opts.reason})` : ""}.`,
      "Bash commands run with full user permissions and ask for the user's confirmation instead — issue them normally",
      `and let the prompt do the gating. See ${docRef("sandboxUnavailable")}.`,
    ];
    if (opts.scratchDir) lines.push("", scratchSentence(opts.scratchDir));
    return lines.join("\n");
  }

  const lines = [header, "", "Bash runs inside an OS-level sandbox with these boundaries:", ""];

  if (!sb.writable) {
    lines.push(
      "- Bash is READ-ONLY: filesystem writes from bash fail regardless of path (no mkdir, no redirects, no installs). Use the Write/Edit tools for the file changes this mode permits.",
    );
  } else {
    // The scratch dir gets its own bullet below; don't list it twice.
    const writable = (sb.allowWrite ?? []).filter((p) => p !== opts.scratchDir).map(renderWritePath);
    lines.push(
      `- Writable paths: ${writable.join(", ") || "(none)"}. Use them for installs and build output (./node_modules, an in-project venv).`,
    );
    if (opts.scratchDir) lines.push(`- ${scratchSentence(opts.scratchDir)}`);
  }
  if (sb.denyWrite?.length) {
    lines.push(`- Additionally write-denied: ${sb.denyWrite.join(", ")}.`);
  }
  const platform = opts.platform ?? process.platform;
  const win32 = platform === "win32";
  if (win32) {
    // The Windows backend runs commands as another account: reads are what
    // the profile grants, not "everything but the denies".
    const granted = opts.windowsProfileRead === "granted";
    const home = grantsHome(sb.allowRead) || granted;
    const homeDir = expandHome("~").toLowerCase();
    // With the grant, a listed path inside the profile is readable through it anyway.
    const carve = (sb.allowRead ?? [])
      .filter((p) => !grantsHome([p]) && !(granted && expandHome(p).toLowerCase().startsWith(homeDir)))
      .map(renderWritePath);
    const readable = [
      "the project",
      "Windows and Program Files",
      ...(granted
        ? ["your user profile (~) except the credential stores (.ssh, .gnupg, .aws, .azure, .kube, .docker, .config\\gh, browser profiles, Windows credential vaults, the Temp folder)"]
        : home
          ? ["your user profile (~)"]
          : []),
      ...carve,
    ];
    lines.push(
      `- This is the native Windows sandbox: commands run in Git Bash as a separate local account (srt-sandbox). Readable: ${readable.join(", ")}` +
        `${sb.denyRead?.length ? `, EXCEPT ${sb.denyRead.join(", ")}` : ""}. Anything else reads as absent or "Access is denied"` +
        `${home ? "" : `, including programs installed for the user only whose folder is not listed; a "command not found" for such a tool is the sandbox, tell the user (see ${docRef("windowsTools")})`}` +
        ` (see ${docRef("windowsSandbox")}).`,
      `- TLS revocation checks cannot leave the sandbox: git over HTTPS and cargo are already told to skip them; System32 curl needs --ssl-no-revoke, and CRYPT_E_REVOCATION_OFFLINE (0x80092013) from another schannel tool means the same. PowerShell's Invoke-WebRequest, gh, Node and Python are unaffected (see ${docRef("windowsRevocation")}).`,
      "- Services on this machine (localhost) are reached through the proxy and prompt the user once per session.",
    );
  }
  if (sb.denyRead?.length) {
    if (!win32) lines.push(`- Reads are broadly allowed EXCEPT: ${sb.denyRead.join(", ")}.`);
    if (!win32 && sb.allowRead?.length) {
      lines.push(`- Readable again inside those denied paths: ${sb.allowRead.map(renderWritePath).join(", ")}. Anything else under a denied path reads as absent.`);
    }
  }
  // On Windows nothing of the profile is readable unless granted, so the
  // keys are out of reach without any deny; elsewhere a deny must cover them.
  const sshUnreadable = win32 ? !grantsSsh(sb.allowRead) || masksSshKeys(sb.denyRead ?? [], sb.allowRead) : masksSshKeys(sb.denyRead ?? [], sb.allowRead);
  if (sshUnreadable) {
    lines.push(
      "- SSH keys are unreadable, so do not use ssh or git over SSH (`git@` remotes) from bash: authentication cannot succeed, whatever the options. " +
        "Git over HTTPS works when a credential is configured; for a `git@` remote, `git -c url.\"https://github.com/\".insteadOf=git@github.com: fetch` uses HTTPS without changing the remote. " +
        "If git asks for a username or fails with \"terminal prompts disabled\", no credential helper could answer (a credential manager cannot prompt in here): stop and tell the user. " +
        "Offer the user both ways in, theirs to choose (see " + docRef("gitAuth") + "): (A) autonomous access, a fine-grained personal access token for HTTPS that the user puts in pi's environment as GITHUB_TOKEN before starting pi; git in here then uses it for github.com by itself (read that section and give the user its steps); " +
        "(B) one-off steps on the host with pi's `!` prefix (`!git clone <url>`, later `!git push`), while you commit inside the sandbox, which needs no credential. " +
        "Do not ask for the token in chat or put one on a command line.",
    );
  }
  if (sb.network?.allowedDomains === undefined) {
    lines.push("- Network is unrestricted in this mode (no allowlist configured).");
  } else if (opts.networkOpen) {
    const denied = sb.network?.deniedDomains ?? [];
    lines.push(
      `- Network filtering is disabled for this session: all hosts are reachable from bash${denied.length ? ` except the mode's denied domains (${denied.join(", ")})` : ""}.`,
    );
  } else {
    const domains = [...new Set([...(sb.network?.allowedDomains ?? []), ...(opts.sessionDomains ?? [])])];
    const darwin = platform === "darwin";
    // Local binding opens loopback past the proxy on macOS: say so, or the
    // model rediscovers it through failed commands.
    const loopback =
      darwin && sb.allowLocalBinding !== false
        ? " Loopback services (a database on localhost) are reachable directly, without the proxy or a prompt; everything else still goes through the allowlist."
        : "";
    const scope = `${
      domains.length
        ? `- Network is limited to these domains: ${domains.join(", ")}.`
        : "- No domains are allowlisted for bash network access."
    }${loopback}`;
    lines.push(
      sb.askOnBlockedHost === false
        ? `${scope} Other hosts are silently unreachable - request access with the request_network_access tool (see ${docRef("networkAccess")}).`
        : `${scope} A request to any other host pauses while the user is asked to allow it - if they approve, simply retry the command. To get domains approved up front (e.g. before an install that hits several hosts), call the request_network_access tool (see ${docRef("networkAccess")}).`,
    );
    if (darwin && !sb.macos?.enableWeakerNetworkIsolation) {
      // Go verifies TLS through trustd on macOS, which the profile denies;
      // gh then reports an invalid token. Name the real cause.
      lines.push(
        `- Go programs (gh, kubectl, terraform, gcloud) cannot verify TLS certificates here (x509: OSStatus -26276): the sandbox denies their trustd lookup. That is the sandbox, not an invalid token or a proxy problem; tell the user (see ${docRef("macosGoTls")}).`,
      );
    }
  }
  lines.push(localBindingLine(platform === "win32" && opts.windowsLoopback !== undefined ? opts.windowsLoopback : sb.allowLocalBinding !== false, platform));
  if (platform === "linux" && !sb.linux?.allowNestedUserNamespaces) {
    // The runtime refuses nested user namespaces since 0.0.80; the programs
    // that need one fail with EPERM and a message that does not name the cause.
    lines.push(
      `- Programs that sandbox themselves cannot create a user namespace here (EPERM): Chromium and Electron (Playwright, Puppeteer), rootless podman and buildah, unshare -r. Where the program offers it, run it without its own sandbox (Chromium: --no-sandbox); otherwise tell the user (see ${docRef("linuxNamespaces")}).`,
    );
  }
  lines.push(
    "- Background processes do not outlive the command: each bash call runs in its own sandbox that is torn down when the command exits, so `&`, `nohup`, and `setsid` cannot start anything long-running. Run long tasks in the foreground with an adequate timeout, or ask the user.",
    "- Commands beyond these boundaries (out-of-project paths, sudo/doas) are fine to issue: the user is asked for permission automatically, and approved commands run outside the sandbox.",
    mode.bypassProtectedPaths
      ? "- File tools (read/edit/write/…) are policy-gated rather than OS-sandboxed."
      : `- File tools (read/edit/write/…) are policy-gated rather than OS-sandboxed; writes to protected paths (.git/, .env*, dotfiles) are blocked (see ${docRef("protectedPaths")}).`,
    "",
    `If a command fails with a permission or network error without a prompt having appeared, the sandbox blocked it silently - ask the user for that step instead of retrying variants (see ${docRef("silentFailures")}).`,
  );
  return lines.join("\n");
}

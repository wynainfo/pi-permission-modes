/**
 * Documentation references.
 *
 * The extension ships a `docs/` folder (a complete reference). Every hint
 * that explains a limit points at a file and section in it, and the system
 * prompt tells the model where the folder is, so a blocked step leads to the
 * explanation instead of to guesswork. `docs.test.ts` fails when a reference
 * here names a file or heading that does not exist.
 *
 * Pure and SDK-free.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Reference key -> `<file>#<github-heading-slug>` under `docs/`. */
export const DOC_REFS = {
  namespaces: "troubleshooting.md#bubblewrap-namespaces",
  sandboxUnavailable: "troubleshooting.md#sandbox-unavailable",
  silentFailures: "troubleshooting.md#silent-failures-inside-the-sandbox",
  sshInSandbox: "troubleshooting.md#ssh-in-the-sandbox",
  blockedByPolicy: "troubleshooting.md#blocked-by-policy",
  networkAccess: "network.md#requesting-access",
  gitAuth: "network.md#git-authentication",
  bash: "permissions.md#bash",
  protectedPaths: "permissions.md#protected-paths",
  denyAndBlock: "permissions.md#deny-and-block",
  toolsAndSkills: "permissions.md#tools-and-skills",
  projectConfig: "configuration.md#project-config",
  outdatedDefaults: "configuration.md#keeping-your-global-config-current",
  strictHome: "modes.md#strict-home",
  macosGoTls: "troubleshooting.md#macos-go-tls",
  macosLoopback: "troubleshooting.md#macos-loopback-services",
  linuxNamespaces: "troubleshooting.md#nested-sandboxes-on-linux",
  windowsSelfCheck: "troubleshooting.md#windows-sandbox-self-check",
  windowsInstall: "troubleshooting.md#windows-sandbox-install",
  windowsLoopback: "troubleshooting.md#loopback-mode-on-windows",
  windowsProfile: "troubleshooting.md#reading-your-profile-on-windows",
  windowsMappedDrive: "troubleshooting.md#mapped-drive-or-unc-project-on-windows",
  windowsSandbox: "sandbox.md#windows",
  windowsRevocation: "troubleshooting.md#tls-revocation-on-windows",
  windowsTools: "troubleshooting.md#per-user-tools-on-windows",
  shells: "shells.md#background-shells",
  autoMode: "modes.md#auto-mode",
} as const;

export type DocRefKey = keyof typeof DOC_REFS;

/** The reference as it appears in a hint: `docs/<file>#<section>`. */
export function docRef(key: DocRefKey): string {
  return `docs/${DOC_REFS[key]}`;
}

/** The documentation files, in the order the prompt lists them. */
export const DOC_FILES = [
  "index.md",
  "configuration.md",
  "modes.md",
  "permissions.md",
  "sandbox.md",
  "network.md",
  "troubleshooting.md",
  "shells.md",
  "architecture.md",
] as const;

/** Absolute path of the shipped `docs/` folder (next to `src/`). */
export function docsDir(): string {
  return fileURLToPath(new URL("../docs", import.meta.url));
}

/**
 * pi's own reference material (docs, examples, README), which pi's system
 * prompt names by absolute path: from the SDK's `getDocsPath` family where
 * the running pi exports it (1.x), else by walking up from pi's entry script
 * to its package root. Empty when neither works; reads then prompt as any
 * out-of-project path does.
 */
export function piReferencePaths(
  sdk: Record<string, unknown>,
  entry: string | undefined = process.argv[1],
  fs: { exists: (p: string) => boolean; realpath: (p: string) => string; readJson: (p: string) => unknown } = {
    exists: existsSync,
    realpath: realpathSync,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
  },
): string[] {
  const fromSdk = ["getDocsPath", "getExamplesPath", "getReadmePath"]
    .map((n) => sdk[n])
    .filter((f): f is () => string => typeof f === "function")
    .flatMap((f) => {
      try {
        const p = f();
        return typeof p === "string" && p ? [p] : [];
      } catch {
        return [];
      }
    });
  if (fromSdk.length > 0) return fromSdk;
  if (!entry) return [];
  try {
    let dir = path.dirname(fs.realpath(entry));
    for (let i = 0; i < 8; i++) {
      const pkg = path.join(dir, "package.json");
      if (fs.exists(pkg) && (fs.readJson(pkg) as { name?: string })?.name === "@earendil-works/pi-coding-agent") {
        return [path.join(dir, "docs"), path.join(dir, "examples"), path.join(dir, "README.md")];
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // unreadable entry: no reference paths
  }
  return [];
}

/**
 * The system-prompt section that names the folder. Short on purpose: it is
 * on every turn. The model is told when to read, where `docs/...` resolves,
 * and what each file covers.
 */
export function docsPromptBlock(dir: string): string {
  return [
    "## permission-mode documentation",
    "",
    `The permission modes, the bash sandbox, and the network allowlist of this session come from the pi-permission-modes extension. Its reference is in ${dir} (not in the project). ` +
      "Read it when a sandbox or permission limit blocks a step, or when the user asks about permission modes or this configuration; otherwise leave it. " +
      "A hint of the form `see docs/<file>#<section>` refers to a file in that directory. " +
      "Files: index.md (topic map and commands), configuration.md (files, layers, what a project config may change), modes.md (the stock modes, mode fields, start mode, plan approval), " +
      "permissions.md (rules, pattern syntax, resolution, protected paths, session grants), sandbox.md (every sandbox key, scratch directory, platforms), " +
      "network.md (allowlist, requesting access, git authentication), troubleshooting.md (one section per error message), shells.md (background shells: run_in_background, bash_output, kill_shell, /shells), architecture.md (for contributors).",
  ].join("\n");
}

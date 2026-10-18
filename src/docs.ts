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
  "architecture.md",
] as const;

/** Absolute path of the shipped `docs/` folder (next to `src/`). */
export function docsDir(): string {
  return fileURLToPath(new URL("../docs", import.meta.url));
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
      "network.md (allowlist, requesting access, git authentication), troubleshooting.md (one section per error message), architecture.md (for contributors).",
  ].join("\n");
}

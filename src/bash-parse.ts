/**
 * Bash command analysis via tree-sitter (real AST), with a regex fallback.
 *
 * Replaces the foolable token scan for the common case: `extractCommands` walks
 * the tree-sitter-bash CST into the list of commands in a line — including those
 * nested in `$(...)`, backticks, and subshells — so privilege escalation and
 * out-of-project path arguments are detected even when hidden inside
 * substitutions. Shell `-c` scripts (`bash -c '…'`) are re-parsed recursively so
 * their inner commands are seen too, and privilege escalation is detected
 * through wrapper commands (`env sudo …`, `nice -n 10 sudo …`). When the WASM
 * grammar can't be loaded, `analyzeBash` degrades to the original
 * `bashConfirmReason` heuristic (heuristics.ts), so behavior is never worse
 * than before.
 *
 * `extractCommands` is pure and works over a minimal node shape, so it's
 * unit-tested with hand-built trees (no WASM); only the lazy parser init touches
 * the runtime.
 */

import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { bashConfirmReason, PRIVILEGE_RE } from "./heuristics.ts";
import { isOutside, SAFE_OUTSIDE_RE } from "./paths.ts";

/** One command extracted from a bash line. */
export interface BashCommand {
  /** Command head, e.g. "git", "sudo", "cat". */
  name: string;
  /** Remaining tokens (args), quotes stripped. */
  args: string[];
  /** True when the command sits inside `$(...)`, backticks, or a subshell. */
  isNested: boolean;
}

/** Minimal structural view of a tree-sitter node (real SyntaxNode satisfies it). */
export interface SyntaxNodeLike {
  type: string;
  text: string;
  children: SyntaxNodeLike[];
}

/** Node types that introduce a nested execution context. */
const NESTING = new Set(["command_substitution", "subshell", "process_substitution"]);
/** Child node types treated as command arguments. */
const ARG_TYPES = new Set([
  "word",
  "string",
  "raw_string",
  "ansi_c_string",
  "concatenation",
  "number",
  "simple_expansion",
  "expansion",
]);

const stripQuotes = (s: string): string => s.replace(/^['"]+|['"]+$/g, "");

function parseCommand(node: SyntaxNodeLike, isNested: boolean): BashCommand {
  let name = "";
  const args: string[] = [];
  for (const child of node.children ?? []) {
    if (child.type === "command_name") {
      if (!name) name = child.text.trim();
    } else if (ARG_TYPES.has(child.type)) {
      args.push(stripQuotes(child.text));
    }
  }
  return { name, args, isNested };
}

/** Walk a CST (or fake tree) into the list of commands, marking nested ones. */
export function extractCommands(root: SyntaxNodeLike): BashCommand[] {
  const out: BashCommand[] = [];
  const walk = (node: SyntaxNodeLike, nested: boolean) => {
    const inNest = nested || NESTING.has(node.type);
    if (node.type === "command") out.push(parseCommand(node, inNest));
    for (const c of node.children ?? []) walk(c, inNest);
  };
  walk(root, false);
  return out;
}

/**
 * Command heads that run their argument list as another command, so privilege
 * escalation can hide one level down (`env sudo …`, `nice -n 10 sudo …`,
 * `xargs sudo …`). Shells with `-c` are handled separately (the script is a
 * string needing a re-parse — see `expandShellCommands`).
 */
const WRAPPER_COMMANDS = new Set([
  "env",
  "command",
  "nice",
  "ionice",
  "nohup",
  "setsid",
  "stdbuf",
  "timeout",
  "time",
  "xargs",
  "exec",
  "builtin",
]);

/** Wrapper arguments to skip when looking for the wrapped command: flags
 * (`-n`, `--`), VAR=value assignments (env), and bare numbers (timeout 5,
 * nice -n 10). */
const SKIPPABLE_WRAPPER_ARG = /^(-|\w+=|\d+$)/;

/**
 * True when the command escalates privileges — directly (`sudo …`) or through
 * known wrapper commands (`env PATH=/x sudo …`, `nice -n 10 doas …`): each
 * wrapper is unwrapped (skipping its flags/assignments/numeric args) and every
 * effective command head is tested. Bounded, so a pathological chain of
 * wrappers can't loop.
 */
export function isPrivilegeEscalation(c: BashCommand): boolean {
  let head = c.name;
  let rest = c.args;
  for (let hops = 0; hops < 8; hops++) {
    if (PRIVILEGE_RE.test(path.basename(head))) return true;
    if (!WRAPPER_COMMANDS.has(path.basename(head))) return false;
    const idx = rest.findIndex((a) => !SKIPPABLE_WRAPPER_ARG.test(a));
    if (idx === -1) return false;
    head = rest[idx];
    rest = rest.slice(idx + 1);
  }
  return false;
}

/** Shells whose `-c <script>` argument is itself a bash program. */
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** The `-c` script of a shell command (`bash -c '…'`, `sh -lc '…'`), or
 * undefined when the command isn't a shell or has no `-c` script. */
function shellCScript(c: BashCommand): string | undefined {
  if (!SHELL_COMMANDS.has(path.basename(c.name))) return undefined;
  let sawC = false;
  for (const a of c.args) {
    if (a.startsWith("-")) {
      if (a.includes("c")) sawC = true;
      continue;
    }
    // First non-flag arg: the script when -c was given, else a script file
    // path (which we can't inspect — the path itself is still policy-matched).
    return sawC ? a : undefined;
  }
  return undefined;
}

/**
 * Expand `sh|bash|… -c '<script>'` commands by re-parsing the script and
 * appending its commands (marked nested), recursively and depth-limited — so
 * privilege, path-escape, and policy matching all see what the inner shell
 * would run. `parse` is injected (the tree-sitter parser in production, a fake
 * in tests); a script that fails to parse expands to nothing.
 */
export function expandShellCommands(
  parse: (script: string) => BashCommand[],
  commands: BashCommand[],
  depth = 0,
): BashCommand[] {
  if (depth >= 3) return commands;
  const out: BashCommand[] = [];
  for (const c of commands) {
    out.push(c);
    const script = shellCScript(c);
    if (!script) continue;
    let inner: BashCommand[] = [];
    try {
      inner = parse(script).map((i) => ({ ...i, isNested: true }));
    } catch {
      // unparsable inner script → nothing to expand; the shell command itself
      // was already emitted and stays subject to policy
    }
    out.push(...expandShellCommands(parse, inner, depth + 1));
  }
  return out;
}

/**
 * Reason to prompt (escape / privilege) derived from extracted commands — the
 * AST-based equivalent of `bashConfirmReason`, but it also sees commands and
 * paths nested inside substitutions/subshells.
 */
export function outsideReasonFromCommands(commands: BashCommand[], root: string): string | undefined {
  for (const c of commands) {
    if (isPrivilegeEscalation(c)) return "privilege escalation";
    for (const tok of [c.name, ...c.args]) {
      let target: string | undefined;
      if (tok.startsWith("/")) target = tok;
      else if (tok === "~" || tok.startsWith("~/")) target = path.join(os.homedir(), tok.slice(1));
      else if (tok.includes("/") || tok === "..") target = path.resolve(root, tok);
      else continue;
      if (SAFE_OUTSIDE_RE.test(target)) continue;
      if (isOutside(root, target)) return `path outside project: ${tok}`;
    }
  }
  return undefined;
}

/** A parser that turns a command string into commands (real or, in tests, fake). */
export interface BashParser {
  parse(command: string): BashCommand[];
}

let parserPromise: Promise<BashParser | undefined> | undefined;

async function initParser(): Promise<BashParser | undefined> {
  try {
    const { Parser, Language } = await import("web-tree-sitter");
    const require = createRequire(import.meta.url);
    const coreWasm = require.resolve("web-tree-sitter/tree-sitter.wasm");
    const bashWasm = require.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
    await Parser.init({ locateFile: () => coreWasm });
    const lang = await Language.load(bashWasm);
    const parser = new Parser();
    parser.setLanguage(lang);
    return {
      parse: (command: string) => {
        const tree = parser.parse(command);
        return tree ? extractCommands(tree.rootNode as unknown as SyntaxNodeLike) : [];
      },
    };
  } catch {
    return undefined; // → analyzeBash falls back to the regex heuristic
  }
}

/** Lazy singleton tree-sitter parser (undefined if the WASM can't be loaded). */
export function getTreeSitterParser(): Promise<BashParser | undefined> {
  parserPromise ??= initParser();
  return parserPromise;
}

export interface BashAnalysis {
  /** Extracted commands (empty when the heuristic fallback was used). */
  commands: BashCommand[];
  /** Escape/privilege reason to force a prompt, or undefined. */
  outsideReason: string | undefined;
  /** True when tree-sitter was unavailable and the regex heuristic was used. */
  usedFallback: boolean;
}

/** Analyze a bash command via tree-sitter, falling back to the regex heuristic. */
export async function analyzeBash(command: string, root: string): Promise<BashAnalysis> {
  const parser = await getTreeSitterParser();
  if (parser) {
    try {
      // Expand shell -c scripts so `bash -c 'sudo …'` exposes its inner
      // commands to privilege/escape detection and policy matching alike.
      const commands = expandShellCommands((s) => parser.parse(s), parser.parse(command));
      return { commands, outsideReason: outsideReasonFromCommands(commands, root), usedFallback: false };
    } catch {
      // parse failure → fall through to the heuristic
    }
  }
  return { commands: [], outsideReason: bashConfirmReason(command, root), usedFallback: true };
}

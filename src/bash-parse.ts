/**
 * Bash command analysis via tree-sitter (real AST), with a regex fallback.
 *
 * Replaces the foolable token scan for the common case: `extractCommands` walks
 * the tree-sitter-bash CST into the list of commands in a line - including those
 * nested in `$(...)`, backticks, and subshells - so privilege escalation and
 * out-of-project path arguments are detected even when hidden inside
 * substitutions. Redirect targets (`> /etc/x`, `< file`, `$(< file)`) and the
 * words of `[[ ... ]]` tests are judged like arguments. Shell `-c` scripts
 * (`bash -c '…'`), `eval` strings, and heredocs fed to a shell (`bash <<EOF`)
 * are re-parsed recursively so their inner commands are seen too, and
 * privilege escalation is detected through wrapper commands (`env sudo …`,
 * `nice -n 10 sudo …`, `find . -exec sudo …`). When the WASM grammar can't be
 * loaded, `analyzeBash` degrades to the original `bashConfirmReason` heuristic
 * (heuristics.ts), so behavior is never worse than before.
 *
 * `extractCommands` is pure and works over a minimal node shape, so it's
 * unit-tested with hand-built trees (no WASM); only the lazy parser init touches
 * the runtime.
 */

import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { bashConfirmReason, normalizeBashToken, pathPartOfToken, PRIVILEGE_RE } from "./heuristics.ts";
import { bashPathEscapes, SAFE_OUTSIDE_RE } from "./paths.ts";

/** One command extracted from a bash line. */
export interface BashCommand {
  /** Command head, e.g. "git", "sudo", "cat". */
  name: string;
  /** Remaining tokens (args), quotes stripped. Redirect targets are appended. */
  args: string[];
  /** True when the command sits inside `$(...)`, backticks, or a subshell. */
  isNested: boolean;
  /** Body of a heredoc attached to this command (`cmd <<EOF … EOF`), if any. */
  heredoc?: string;
  /**
   * Alternative "name args…" spellings the bash policy surface is matched
   * against as well: the basename form of an absolute head (`/usr/bin/sudo id`
   * → `sudo id`) and the command a wrapper runs (`time sudo id` → `sudo id`),
   * so a `"sudo*": "deny"` rule cannot be dodged by a path or a wrapper.
   */
  aliases?: string[];
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

/** The destination word of a `file_redirect` node (undefined for `2>&1`-style fd targets). */
function redirectTarget(node: SyntaxNodeLike): string | undefined {
  for (const c of node.children ?? []) {
    if (ARG_TYPES.has(c.type)) return stripQuotes(c.text);
  }
  return undefined;
}

function parseCommand(node: SyntaxNodeLike, isNested: boolean): BashCommand {
  let name = "";
  const args: string[] = [];
  for (const child of node.children ?? []) {
    if (child.type === "command_name") {
      if (!name) name = child.text.trim();
    } else if (ARG_TYPES.has(child.type)) {
      args.push(stripQuotes(child.text));
    } else if (child.type === "file_redirect") {
      // `cmd > /etc/x` inside the command node (grammar versions differ on placement)
      const t = redirectTarget(child);
      if (t !== undefined) args.push(t);
    }
  }
  return { name, args, isNested };
}

/** All argument-like leaf words under a node (for `[[ … ]]` tests). */
function collectWords(node: SyntaxNodeLike, out: string[] = []): string[] {
  for (const c of node.children ?? []) {
    if (ARG_TYPES.has(c.type)) out.push(stripQuotes(c.text));
    else collectWords(c, out);
  }
  return out;
}

/**
 * Walk a CST (or fake tree) into the list of commands, marking nested ones.
 * A `redirected_statement` contributes its redirect targets to the wrapped
 * command's args and attaches a heredoc body; an orphan `file_redirect`
 * (`$(< file)`) and a `test_command` (`[[ -f /etc/shadow ]]`) become
 * pseudo-commands with an empty or `[[` name so their paths are judged.
 */
export function extractCommands(root: SyntaxNodeLike): BashCommand[] {
  const out: BashCommand[] = [];
  const walk = (node: SyntaxNodeLike, nested: boolean) => {
    const inNest = nested || NESTING.has(node.type);
    if (node.type === "redirected_statement") {
      const kids = node.children ?? [];
      const cmdNode = kids.find((c) => c.type === "command");
      if (cmdNode) {
        const cmd = parseCommand(cmdNode, inNest);
        for (const c of kids) {
          if (c.type === "file_redirect") {
            const t = redirectTarget(c);
            if (t !== undefined) cmd.args.push(t);
          } else if (c.type === "heredoc_redirect") {
            const body = (c.children ?? []).find((h) => h.type === "heredoc_body");
            if (body) cmd.heredoc = body.text;
          }
        }
        out.push(cmd);
        for (const c of cmdNode.children ?? []) walk(c, inNest); // substitutions inside the command
        for (const c of kids) {
          if (c === cmdNode) continue;
          // Redirects are already folded into `cmd`; only look INSIDE their
          // words for substitutions (walking the redirect node itself would
          // emit a duplicate pseudo-command).
          if (c.type === "file_redirect" || c.type === "heredoc_redirect") {
            for (const w of c.children ?? []) for (const g of w.children ?? []) walk(g, inNest);
          } else {
            walk(c, inNest);
          }
        }
        return;
      }
    }
    if (node.type === "command") out.push(parseCommand(node, inNest));
    else if (node.type === "file_redirect") {
      const t = redirectTarget(node);
      if (t !== undefined) out.push({ name: "", args: [t], isNested: true });
    } else if (node.type === "test_command") {
      out.push({ name: "[[", args: collectWords(node), isNested: inNest });
    }
    for (const c of node.children ?? []) walk(c, inNest);
  };
  walk(root, false);
  return out;
}

/**
 * Command heads that run their argument list as another command, so privilege
 * escalation can hide one level down (`env sudo …`, `nice -n 10 sudo …`,
 * `xargs sudo …`, `coproc sudo …`). Shells with `-c`, `eval`, and heredocs
 * are handled separately (the script is a string needing a re-parse - see
 * `expandShellCommands`).
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
  "coproc",
]);

/** `find`/`fd` run the command after one of these flags. */
const EXEC_FLAG_COMMANDS: Record<string, Set<string>> = {
  find: new Set(["-exec", "-execdir", "-ok", "-okdir"]),
  fd: new Set(["-x", "--exec", "-X", "--exec-batch"]),
  fdfind: new Set(["-x", "--exec", "-X", "--exec-batch"]),
};

/** Wrapper arguments to skip when looking for the wrapped command: flags
 * (`-n`, `--`), VAR=value assignments (env), and bare numbers (timeout 5,
 * nice -n 10). */
const SKIPPABLE_WRAPPER_ARG = /^(-|\w+=|\d+$)/;

/**
 * The command a wrapper chain ultimately runs: `env PATH=/x sudo id` → `sudo
 * id`, `find . -exec sudo id ;` → `sudo id ;`, `time sudo id` → `sudo id`.
 * Returns the input itself when the head is not a wrapper. Bounded, so a
 * pathological chain of wrappers can't loop.
 */
export function unwrapCommand(c: { name: string; args: string[] }): { name: string; args: string[] } {
  let head = c.name;
  let rest = c.args;
  for (let hops = 0; hops < 8; hops++) {
    const base = path.basename(head);
    const execFlags = EXEC_FLAG_COMMANDS[base];
    if (execFlags) {
      const idx = rest.findIndex((a) => execFlags.has(a));
      if (idx === -1 || idx + 1 >= rest.length) return { name: head, args: rest };
      head = rest[idx + 1];
      rest = rest.slice(idx + 2);
      continue;
    }
    if (!WRAPPER_COMMANDS.has(base)) return { name: head, args: rest };
    const idx = rest.findIndex((a) => !SKIPPABLE_WRAPPER_ARG.test(a));
    if (idx === -1) return { name: head, args: rest };
    head = rest[idx];
    rest = rest.slice(idx + 1);
  }
  return { name: head, args: rest };
}

/**
 * True when the command escalates privileges - directly (`sudo …`) or through
 * known wrapper commands (`env PATH=/x sudo …`, `nice -n 10 doas …`, `find .
 * -exec sudo …`): every effective command head along the chain is tested.
 */
export function isPrivilegeEscalation(c: BashCommand): boolean {
  let cur: { name: string; args: string[] } = c;
  for (let hops = 0; hops < 8; hops++) {
    if (PRIVILEGE_RE.test(path.basename(cur.name))) return true;
    const next = unwrapCommand(cur);
    if (next.name === cur.name && next.args === cur.args) return false;
    cur = next;
  }
  return false;
}

/**
 * Policy aliases for a command (see `BashCommand.aliases`): the basename form
 * when the head is a path, and the unwrapped command (and its basename form)
 * when the head is a wrapper. Empty when neither applies.
 */
export function policyAliases(c: BashCommand): string[] {
  const out = new Set<string>();
  const joined = (n: string, a: string[]) => [n, ...a].join(" ").trim();
  const original = joined(c.name, c.args);
  // Quote/escape-normalized spelling: `\git push`, `git pu""sh`, `$'/etc/x'`
  // must match the same patterns as their plain forms.
  const norm = { name: normalizeBashToken(c.name), args: c.args.map(normalizeBashToken) };
  for (const v of [c, norm]) {
    const j = joined(v.name, v.args);
    if (j !== original) out.add(j);
    const base = path.basename(v.name);
    if (base !== v.name) out.add(joined(base, v.args));
    const inner = unwrapCommand(v);
    if (inner.name !== v.name) {
      out.add(joined(inner.name, inner.args));
      const innerBase = path.basename(inner.name);
      if (innerBase !== inner.name) out.add(joined(innerBase, inner.args));
    }
  }
  return [...out];
}

/** Shells whose `-c <script>` argument (or stdin heredoc) is itself a bash program. */
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Shell options that take a separate value argument (`bash -o pipefail -c …`). */
const SHELL_OPTS_WITH_VALUE = new Set(["-o", "-O", "+o", "+O", "--rcfile", "--init-file"]);

/**
 * The script a command hands to a shell: the `-c` string of `bash -c '…'`,
 * `sh -lc '…'`, `bash -o pipefail -c '…'`; the joined arguments of `eval`;
 * or the heredoc body of `bash <<EOF … EOF`. Undefined when the command
 * isn't such a script (a shell running a script FILE can't be inspected; the
 * path itself is still policy-matched).
 */
function shellScript(c: BashCommand): string | undefined {
  const base = path.basename(c.name);
  if (base === "eval") return c.args.join(" ") || undefined;
  if (!SHELL_COMMANDS.has(base)) return undefined;
  let sawC = false;
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i];
    if (a === "--") {
      const next = c.args[i + 1];
      return sawC && next !== undefined ? next : c.heredoc;
    }
    if (SHELL_OPTS_WITH_VALUE.has(a)) {
      i++; // skip the option's value
      continue;
    }
    if (a.startsWith("-") || a.startsWith("+")) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) sawC = true; // -c, -lc, -ec, …
      continue;
    }
    // First non-flag arg: the script when -c was given, else a script file
    // path (which we can't inspect) or `-` (stdin: the heredoc, if any).
    if (sawC) return a;
    return a === "-" ? c.heredoc : undefined;
  }
  return c.heredoc; // `bash <<EOF` with no positional args reads the heredoc
}

/**
 * Expand shell scripts (`sh|bash|… -c '<script>'`, `eval '…'`, `bash <<EOF`)
 * by re-parsing the script and appending its commands (marked nested),
 * recursively and depth-limited - so privilege, path-escape, and policy
 * matching all see what the inner shell would run. `parse` is injected (the
 * tree-sitter parser in production, a fake in tests); a script that fails to
 * parse expands to nothing.
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
    const script = shellScript(c);
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

/** `cd`/`pushd` with no path go to `$HOME`; `-` goes to the previous directory (unknown here). */
const DIR_CHANGERS = new Set(["cd", "pushd"]);

/**
 * Reason to prompt (escape / privilege) derived from extracted commands - the
 * AST-based equivalent of `bashConfirmReason`, but it also sees commands and
 * paths nested inside substitutions/subshells. `alsoInside` lists further
 * in-bounds roots (the mode's sandbox-writable dirs): a path under one is not
 * an escape.
 */
export function outsideReasonFromCommands(
  commands: BashCommand[],
  root: string,
  alsoInside: readonly string[] = [],
): string | undefined {
  for (const c of commands) {
    if (isPrivilegeEscalation(c)) return "privilege escalation";
    if (DIR_CHANGERS.has(path.basename(c.name))) {
      const dest = c.args.find((a) => a === "-" || !a.startsWith("-"));
      if (dest === undefined || dest === "-") return `path outside project: ${c.name} ${dest ?? ""}`.trim();
    }
    for (const raw of [c.name, ...c.args]) {
      const tok = normalizeBashToken(raw);
      if (/^~[^/]/.test(tok)) return `path outside project: ${raw}`; // ~user: another user's home
      const p = pathPartOfToken(tok);
      let target: string | undefined;
      if (p.startsWith("/")) target = p;
      else if (p === "~" || p.startsWith("~/")) target = path.join(os.homedir(), p.slice(1));
      else if (p.includes("/") || p === "..") target = path.resolve(root, p);
      else continue;
      if (SAFE_OUTSIDE_RE.test(target)) continue;
      if (bashPathEscapes(root, target, alsoInside)) return `path outside project: ${raw}`;
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

/**
 * Analyze a bash command via tree-sitter, falling back to the regex heuristic.
 * `alsoInside`: extra in-bounds roots (sandbox-writable dirs) for escape detection.
 */
export async function analyzeBash(command: string, root: string, alsoInside: readonly string[] = []): Promise<BashAnalysis> {
  const parser = await getTreeSitterParser();
  if (parser) {
    try {
      // Expand shell scripts so `bash -c 'sudo …'`, `eval`, and heredocs
      // expose their inner commands to privilege/escape detection and policy
      // matching alike; attach policy aliases for wrapper/path heads.
      const commands = expandShellCommands((s) => parser.parse(s), parser.parse(command)).map((c) => {
        const aliases = policyAliases(c);
        return aliases.length ? { ...c, aliases } : c;
      });
      return { commands, outsideReason: outsideReasonFromCommands(commands, root, alsoInside), usedFallback: false };
    } catch {
      // parse failure → fall through to the heuristic
    }
  }
  return { commands: [], outsideReason: bashConfirmReason(command, root, alsoInside), usedFallback: true };
}

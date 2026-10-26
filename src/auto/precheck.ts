/**
 * Auto mode, the deterministic checks that run before the model.
 *
 * From what the bash parser and the path code already give us (the command
 * names, the escaping paths, the chain text), a few outcomes need no judge:
 *
 *   - a read of a path the mode masks (`denyRead`): an approved escape runs
 *     unsandboxed, so the mask would be gone; never approved by the judge;
 *   - a download piped into a shell, a force push, a write under pi's agent
 *     directory (the extension's own config lives there): the hard floor.
 *
 * A refusal here is handled like a model refusal (`onRefuse` decides whether
 * the user is asked instead), but an approval in chat does not lift it;
 *
 * and a few facts make the judge's job honest: a path that does not resolve
 * (a dangling symlink, a target that does not exist), a path that resolves
 * elsewhere, code the judge cannot read (a script outside the project, an
 * interpreter reading stdin), data an upload flag sends. The checks produce
 * refusals and facts, never allows.
 *
 * Pure: the one filesystem call (realpath) is injected and defaults to the
 * real one.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import type { BashCommand } from "../bash-parse.ts";
import { expandHome } from "../resolve.ts";
import type { JudgedAction } from "./verdict.ts";

export interface PrecheckContext {
  root: string;
  /** The mode's masked paths, as configured (`~` allowed). */
  denyRead: readonly string[];
  /** pi's agent directory (`~/.pi/agent`): writes under it are never approved automatically. */
  agentDir: string;
  /** Resolve a path through its symlinks; undefined when it does not exist. */
  realpath?: (p: string) => string | undefined;
}

export interface Precheck {
  /** Set when the action is refused without a model call. */
  refuse?: string;
  /** What the judge is told about the action. */
  facts: string[];
}

const defaultRealpath = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

const under = (p: string, dir: string): boolean => {
  const d = dir.replace(/[\\/]+$/, "");
  return p === d || p.startsWith(d + path.sep) || (path.sep !== "/" && p.startsWith(d + "/"));
};

/** Absolute, home-expanded, normalized; relative paths resolve against the project. */
const abs = (root: string, p: string): string => path.resolve(root, expandHome(p));

/** A token that looks like a path (what the heuristics treat as one, roughly). */
const looksLikePath = (tok: string): boolean => /^(~|\$HOME|\.{1,2}\/|\/|[A-Za-z]:[\\/])/.test(tok) || tok.includes("/");

const stripQuotes = (tok: string): string => tok.replace(/^["']|["']$/g, "");

/** A `curl ... | sh`, a `wget -O- ... | bash`, a `sh <(curl ...)`: the install one-liner. */
const PIPE_TO_SHELL = /\b(?:curl|wget|fetch)\b[^|;&\n]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:(?:ba|z|da|k|fi)?sh|python[0-9.]*|perl|node|ruby)\b/;
const SUBST_TO_SHELL = /\b(?:(?:ba|z|da|k)?sh|source|python[0-9.]*|perl|node|ruby)\b[^|;&\n]*<\(\s*(?:curl|wget|fetch)\b/;

const INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "python", "python2", "python3", "node", "perl", "ruby", "php", "source", "."]);
const READ_ONLY = new Set(["cat", "less", "more", "head", "tail", "grep", "rg", "ls", "find", "stat", "wc", "diff", "jq", "file", "bat", "tree", "du", "cd", "pwd", "echo", "test", "[", "readlink", "realpath", "md5sum", "sha256sum"]);

/** The deny-read path `p` falls under, if any. */
function deniedBy(p: string, ctx: PrecheckContext): string | undefined {
  return ctx.denyRead.find((d) => under(p, abs(ctx.root, d)));
}

function checkPath(p: string, ctx: PrecheckContext, facts: string[], realpath: (p: string) => string | undefined): string | undefined {
  const a = abs(ctx.root, p);
  const hit = deniedBy(a, ctx);
  if (hit) return `${p} is under ${hit}, which this mode masks (denyRead); only the user can approve an escape to read it.`;
  const r = realpath(a);
  if (r === undefined) {
    facts.push(`${p} does not exist or is a dangling symlink (cannot be resolved).`);
    return undefined;
  }
  if (r !== a) {
    facts.push(`${p} resolves to ${r}.`);
    const hit2 = deniedBy(r, ctx);
    if (hit2) return `${p} resolves to ${r}, under ${hit2}, which this mode masks (denyRead); only the user can approve it.`;
  }
  return undefined;
}

function checkBash(command: string, commands: readonly BashCommand[], outside: readonly string[], ctx: PrecheckContext, realpath: (p: string) => string | undefined): Precheck {
  const facts: string[] = [];
  if (PIPE_TO_SHELL.test(command) || SUBST_TO_SHELL.test(command)) return { refuse: "The command pipes a download into an interpreter; only the user can approve that.", facts };
  const agentDir = abs(ctx.root, ctx.agentDir);
  for (const c of commands) {
    const name = path.basename(c.name);
    const tokens = [...c.args, ...(c.pathTokens ?? [])].map(stripQuotes);
    if (name === "git" && c.args.includes("push") && c.args.some((a) => a === "-f" || a.startsWith("--force") || /^\+\S/.test(a))) {
      return { refuse: "The command force-pushes (rewrites published git history); only the user can approve that.", facts };
    }
    for (const t of tokens) {
      if (!looksLikePath(t)) continue;
      const a = abs(ctx.root, t);
      const hit = deniedBy(a, ctx);
      if (hit) return { refuse: `${t} is under ${hit}, which this mode masks (denyRead); only the user can approve an escape to read it.`, facts };
      if (under(a, agentDir)) {
        if (READ_ONLY.has(name)) facts.push(`${name} reads pi's agent directory (${t}).`);
        else return { refuse: `${name} on ${t}: writes under pi's agent directory (the extension's own configuration) are never approved automatically; only the user can.`, facts };
      }
    }
    if (INTERPRETERS.has(name)) {
      const script = c.args.find((a) => !a.startsWith("-"));
      const inline = c.args.some((a) => a === "-c" || a === "-e" || a === "--eval" || a === "-p");
      if (!inline) {
        if (script === undefined || script === "-") facts.push(`${name} reads its program from stdin; the code cannot be inspected here.`);
        else if (looksLikePath(script) && !under(abs(ctx.root, script), ctx.root)) facts.push(`${name} runs ${script}, a script outside the project; the code cannot be inspected here.`);
      }
    }
  }
  for (const p of outside) {
    const refuse = checkPath(p, ctx, facts, realpath);
    if (refuse) return { refuse, facts };
  }
  return { facts };
}

/** The deterministic checks for one action (see the module comment). */
export function precheck(action: JudgedAction, commands: readonly BashCommand[] | undefined, ctx: PrecheckContext): Precheck {
  const realpath = ctx.realpath ?? defaultRealpath;
  switch (action.kind) {
    case "bash":
      return checkBash(action.command, commands ?? [], action.outside, ctx, realpath);
    case "file": {
      const facts: string[] = [];
      const refuse = checkPath(action.path, ctx, facts, realpath);
      if (refuse) return { refuse, facts };
      if ((action.tool === "edit" || action.tool === "write") && under(abs(ctx.root, action.path), abs(ctx.root, ctx.agentDir))) {
        return { refuse: `${action.tool} of ${action.path}: writes under pi's agent directory (the extension's own configuration) are never approved automatically; only the user can.`, facts };
      }
      return { facts };
    }
    case "network": {
      const facts: string[] = [];
      for (const cmd of action.commands) {
        if (PIPE_TO_SHELL.test(cmd) || SUBST_TO_SHELL.test(cmd)) return { refuse: "The command pipes a download into an interpreter; only the user can approve that.", facts };
        if (/(^|\s)(-d|--data(?:-\w+)?|-F|--form|-T|--upload-file|--post-file|--body-file)\b/.test(cmd) || /\b(scp|rsync|sftp|ftp)\b/.test(cmd)) {
          facts.push("The command carries upload or data flags: something leaves the machine, not only a request.");
        }
      }
      return { facts };
    }
    default:
      return { facts: [] };
  }
}

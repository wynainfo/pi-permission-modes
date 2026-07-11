import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  gitFileBlocksSandbox,
  isMarkdown,
  isOutside,
  isPlanFile,
  isProtectedPath,
  isProtectedWrite,
  removeSandboxPlaceholders,
  resolvePlanPath,
  SAFE_OUTSIDE_RE,
  SANDBOX_PLACEHOLDER_PATHS,
} from "./paths.ts";

const ROOT = "/home/proj";

test("isOutside: empty/undefined is in-project (tools default to cwd)", () => {
  assert.equal(isOutside(ROOT, undefined), false);
  assert.equal(isOutside(ROOT, ""), false);
});

test("isOutside: in-project relative and nested paths", () => {
  assert.equal(isOutside(ROOT, "src/index.ts"), false);
  assert.equal(isOutside(ROOT, "./a/b/c"), false);
  assert.equal(isOutside(ROOT, "."), false);
});

test("isOutside: parent traversal escapes", () => {
  assert.equal(isOutside(ROOT, ".."), true);
  assert.equal(isOutside(ROOT, "../sibling"), true);
  assert.equal(isOutside(ROOT, "src/../../escape"), true);
});

test("isOutside: absolute paths classified by containment", () => {
  assert.equal(isOutside(ROOT, "/home/proj/src"), false);
  assert.equal(isOutside(ROOT, "/etc/passwd"), true);
  assert.equal(isOutside(ROOT, "/home/projector"), true); // prefix but not contained
});

test("isProtectedPath: segment-aware match of the expanded protected set", () => {
  assert.equal(isProtectedPath(".env"), true);
  assert.equal(isProtectedPath("config/.env"), true);
  assert.equal(isProtectedPath("deploy/.env.production"), true);
  assert.equal(isProtectedPath(".git/config"), true);
  assert.equal(isProtectedPath("node_modules/x"), true);
  assert.equal(isProtectedPath(".vscode/settings.json"), true);
  assert.equal(isProtectedPath("sub/.idea/workspace.xml"), true);
  assert.equal(isProtectedPath("home/.bashrc"), true);
  assert.equal(isProtectedPath(".claude/commands/foo.md"), true);
  assert.equal(isProtectedPath(".claude/agents/bar.md"), true);
});

test("isProtectedPath: does not flag look-alikes (no loose substring)", () => {
  assert.equal(isProtectedPath("src/app.ts"), false);
  assert.equal(isProtectedPath("src/.environment.ts"), false); // not .env / .env.*
  assert.equal(isProtectedPath("my.gitignore"), false);
  assert.equal(isProtectedPath("docs/environment.md"), false);
});

test("gitFileBlocksSandbox distinguishes 0-byte stub vs real gitfile", () => {
  const t = tmpdir();
  if (!existsSync(t)) mkdirSync(t, { recursive: true });
  const base = mkdtempSync(path.join(t, "perm-git-"));
  try {
    // No .git → non-git project: sandbox stays on.
    const none = path.join(base, "none");
    mkdirSync(none, { recursive: true });
    assert.equal(gitFileBlocksSandbox(none), false);

    // Real .git directory → normal repo: sandbox on.
    const repo = path.join(base, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    assert.equal(gitFileBlocksSandbox(repo), false);

    // 0-byte .git → sandbox-planted placeholder: not a worktree (cleaned instead).
    const stub = path.join(base, "stub");
    mkdirSync(stub, { recursive: true });
    writeFileSync(path.join(stub, ".git"), "");
    assert.equal(gitFileBlocksSandbox(stub), false);

    // Non-empty .git file → real worktree/submodule: degrade.
    const wt = path.join(base, "worktree");
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, ".git"), "gitdir: /elsewhere\n");
    assert.equal(gitFileBlocksSandbox(wt), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isPlanFile: markdown under the in-project plan/ dir only", () => {
  const root = "/home/proj";
  assert.equal(isPlanFile(root, "plan/2026-06-07_x.md"), true);
  assert.equal(isPlanFile(root, "plan/sub/y.markdown"), true);
  assert.equal(isPlanFile(root, "./plan/z.md"), true);
  assert.equal(isPlanFile(root, "plan/notes.txt"), false); // not markdown
  assert.equal(isPlanFile(root, "docs/x.md"), false); // not under plan/
  assert.equal(isPlanFile(root, "planner/x.md"), false); // sibling dir, not plan/
  assert.equal(isPlanFile(root, "../plan/x.md"), false); // escapes project
  assert.equal(isPlanFile(root, undefined), false);
});

test("removeSandboxPlaceholders deletes 0-byte placeholders, leaves real files/dirs", () => {
  const t2 = tmpdir();
  if (!existsSync(t2)) mkdirSync(t2, { recursive: true });
  const base = mkdtempSync(path.join(t2, "perm-rm-"));
  try {
    const proj = path.join(base, "proj");
    mkdirSync(proj, { recursive: true });

    // 0-byte placeholders the sandbox plants (files for dotfiles AND dir-names).
    for (const name of [".bashrc", ".zshrc", ".gitconfig", ".mcp.json", ".git", ".vscode", ".idea", ".claude"]) {
      writeFileSync(path.join(proj, name), "");
    }
    // Legitimate content that must NOT be touched:
    writeFileSync(path.join(proj, ".gitmodules"), "[submodule]\n"); // real non-empty file
    mkdirSync(path.join(proj, ".vscode-real"), { recursive: true });
    const realIdea = path.join(base, "realidea");
    mkdirSync(path.join(realIdea, ".idea"), { recursive: true }); // a real .idea DIR (separate proj)

    const removed = removeSandboxPlaceholders(proj);
    assert.equal(removed, 8); // all 8 zero-byte placeholders gone
    for (const name of [".bashrc", ".zshrc", ".gitconfig", ".mcp.json", ".git", ".vscode", ".idea", ".claude"]) {
      assert.equal(existsSync(path.join(proj, name)), false, name);
    }
    assert.equal(existsSync(path.join(proj, ".gitmodules")), true); // real file kept
    assert.equal(removeSandboxPlaceholders(realIdea), 0); // a real .idea dir is left alone

    // No placeholders → 0.
    const none = path.join(base, "none");
    mkdirSync(none, { recursive: true });
    assert.equal(removeSandboxPlaceholders(none), 0);

    // Nested .claude/{commands,agents} placeholders inside a real .claude dir.
    const nested = path.join(base, "nested");
    mkdirSync(path.join(nested, ".claude"), { recursive: true });
    writeFileSync(path.join(nested, ".claude", "commands"), "");
    assert.equal(removeSandboxPlaceholders(nested), 1);
    assert.equal(existsSync(path.join(nested, ".claude")), true); // real dir kept
    assert.equal(existsSync(path.join(nested, ".claude", "commands")), false);

    assert.ok(SANDBOX_PLACEHOLDER_PATHS.includes(".mcp.json"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolvePlanPath trims and strips a leading @", () => {
  assert.equal(resolvePlanPath("plan/x.md"), "plan/x.md");
  assert.equal(resolvePlanPath("  plan/x.md  "), "plan/x.md");
  assert.equal(resolvePlanPath("@plan/x.md"), "plan/x.md");
  assert.equal(resolvePlanPath(" @plan/x.md"), "plan/x.md");
  assert.equal(resolvePlanPath(undefined), "");
  assert.equal(resolvePlanPath(null), "");
});

test("isMarkdown matches .md / .markdown case-insensitively", () => {
  for (const p of ["notes.md", "deep/dir/plan.markdown", "READ.MD", "X.Markdown"]) {
    assert.equal(isMarkdown(p), true, p);
  }
  for (const p of ["readme.txt", "notmd", "file.mdx", "md", "a.md.bak"]) {
    assert.equal(isMarkdown(p), false, p);
  }
});

test("SAFE_OUTSIDE_RE matches device pseudo-files only", () => {
  assert.ok(SAFE_OUTSIDE_RE.test("/dev/null"));
  assert.ok(!SAFE_OUTSIDE_RE.test("/dev/sda"));
});

test("isProtectedWrite: symlinks cannot smuggle a write past the backstop", () => {
  const t = tmpdir();
  if (!existsSync(t)) mkdirSync(t, { recursive: true });
  const base = mkdtempSync(path.join(t, "perm-prot-"));
  try {
    const root = path.join(base, "proj");
    mkdirSync(path.join(root, ".git"), { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });

    // Lexical matches still hold, incl. not-yet-existing protected paths.
    assert.equal(isProtectedWrite(root, ".git/config"), true);
    assert.equal(isProtectedWrite(root, ".env.production"), true);
    assert.equal(isProtectedWrite(root, "src/app.ts"), false);

    // In-project symlink → .git: the canonical target is protected.
    symlinkSync(path.join(root, ".git"), path.join(root, "innocent"));
    assert.equal(isProtectedWrite(root, "innocent/config"), true);

    // Symlink → an outside dotfile: caught by basename after resolution.
    const outside = path.join(base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, ".bashrc"), "x");
    symlinkSync(path.join(outside, ".bashrc"), path.join(root, "notes.txt"));
    assert.equal(isProtectedWrite(root, "notes.txt"), true);

    // A benign in-project symlink stays writable.
    writeFileSync(path.join(root, "real.md"), "");
    symlinkSync(path.join(root, "real.md"), path.join(root, "alias.md"));
    assert.equal(isProtectedWrite(root, "alias.md"), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isProtectedWrite: a project under a protected-named dir isn't blanket-blocked", () => {
  const t = tmpdir();
  if (!existsSync(t)) mkdirSync(t, { recursive: true });
  const base = mkdtempSync(path.join(t, "perm-nm-"));
  try {
    // Debugging a dependency in place: the project root's own absolute path
    // contains node_modules, but in-project writes are judged root-relative.
    const root = path.join(base, "node_modules", "some-dep");
    mkdirSync(path.join(root, "src"), { recursive: true });
    assert.equal(isProtectedWrite(root, "src/index.js"), false);
    // The project's OWN node_modules (a segment below root) stays protected.
    assert.equal(isProtectedWrite(root, "node_modules/x/y.js"), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isOutside: follows symlinks that escape the project", () => {
  const t3 = tmpdir();
  if (!existsSync(t3)) mkdirSync(t3, { recursive: true });
  const root = mkdtempSync(path.join(t3, "perm-root-"));
  try {
    // An in-project symlink pointing outside the project resolves to outside.
    const escape = path.join(root, "link-to-etc");
    symlinkSync("/etc", escape);
    assert.equal(isOutside(root, "link-to-etc/passwd"), true);

    // An in-project symlink pointing back inside stays inside.
    writeFileSync(path.join(root, "real.txt"), "hi");
    symlinkSync(path.join(root, "real.txt"), path.join(root, "inside-link"));
    assert.equal(isOutside(root, "inside-link"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isMarkdown,
  isOutside,
  isPlanFile,
  isProtectedPath,
  isProtectedWrite,
  removeSandboxPlaceholders,
  resolvePlanPath,
  SAFE_OUTSIDE_RE,
  SANDBOX_PLACEHOLDER_PATHS,
  SANDBOX_RUNTIME_TMP_PATHS,
  bashPathEscapes,
  blockablePath,
  canonicalPath,
  displayPath,
  gitDirsOf,
  normalizeToolPath,
  sandboxAllowedRoots,
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


test("isOutside: extra in-bounds roots (sandbox-writable dirs) are not outside", () => {
  const base = mkdtempSync(path.join(tmpdir(), "perm-bounds-"));
  try {
    const root = path.join(base, "proj");
    const scratch = path.join(base, "scratch");
    mkdirSync(root);
    mkdirSync(scratch);
    assert.equal(isOutside(root, path.join(scratch, "x.txt")), true);
    assert.equal(isOutside(root, path.join(scratch, "x.txt"), [scratch]), false);
    assert.equal(isOutside(root, scratch, [scratch]), false); // the root itself
    assert.equal(isOutside(root, "../scratch/deep/x", [scratch]), false); // relative escape into a bound
    assert.equal(isOutside(root, path.join(base, "other", "x"), [scratch]), true); // sibling stays outside
    assert.equal(isOutside(root, path.join(base, "scratch2", "x"), [scratch]), true); // prefix ≠ containment
    assert.equal(isOutside(root, "src/app.ts", [scratch]), false); // project untouched
    // A symlink inside a bound that points elsewhere is still an escape.
    mkdirSync(path.join(base, "other"));
    symlinkSync(path.join(base, "other"), path.join(scratch, "link"));
    assert.equal(isOutside(root, path.join(scratch, "link", "x"), [scratch]), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("sandboxAllowedRoots: allowWrite resolved to absolute roots + the runtime temp dir", () => {
  const home = os.homedir();
  const roots = sandboxAllowedRoots(ROOT, { enabled: true, writable: true, allowWrite: [".", "/tmp", "~/scratch", "build/*"] });
  assert.deepEqual(roots, [ROOT, "/tmp", `${home}/scratch`, ...SANDBOX_RUNTIME_TMP_PATHS]); // glob entry skipped
  // Non-sandboxing mode: no bounds (allowWrite is meaningless there).
  assert.deepEqual(sandboxAllowedRoots(ROOT, { enabled: false, writable: true, allowWrite: ["/tmp"] }), []);
  // Read-only sandbox (Plan) keeps its roots: reads there are fine, writes fail in the sandbox as in-project.
  assert.ok(sandboxAllowedRoots(ROOT, { enabled: true, writable: false, allowWrite: ["/tmp"] }).includes("/tmp"));
  assert.deepEqual(sandboxAllowedRoots(ROOT, { enabled: true, writable: true }), SANDBOX_RUNTIME_TMP_PATHS);
});

test("bashPathEscapes: an in-project symlink to an outside EXECUTABLE is not an escape (venv python)", () => {
  const base = mkdtempSync(path.join(tmpdir(), "perm-venv-"));
  try {
    const root = path.join(base, "proj");
    const outside = path.join(base, "elsewhere");
    mkdirSync(path.join(root, "tools", "venv", "bin"), { recursive: true });
    mkdirSync(outside);
    const exe = path.join(outside, "python3");
    writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
    const data = path.join(outside, "secrets.txt");
    writeFileSync(data, "x", { mode: 0o644 });
    symlinkSync(exe, path.join(root, "tools", "venv", "bin", "python")); // what `python -m venv` does
    symlinkSync(data, path.join(root, "link-to-data"));
    symlinkSync(outside, path.join(root, "link-to-dir"));
    symlinkSync(path.join(outside, "missing"), path.join(root, "dangling"));
    writeFileSync(path.join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });

    assert.equal(bashPathEscapes(root, "tools/venv/bin/python"), false); // the whole point
    assert.equal(bashPathEscapes(root, "run.sh"), false); // ordinary in-project file
    assert.equal(bashPathEscapes(root, "link-to-data"), true); // symlink to an outside non-executable
    assert.equal(bashPathEscapes(root, "link-to-dir/secrets.txt"), true); // through a symlinked outside dir
    assert.equal(bashPathEscapes(root, "dangling"), true); // dangling: judged by where it points
    assert.equal(bashPathEscapes(root, exe), true); // the same executable named by its outside path
    assert.equal(bashPathEscapes(root, "../elsewhere/python3"), true); // lexically outside
    assert.equal(bashPathEscapes(root, exe, [outside]), false); // in-bounds roots still apply
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isOutside: a dangling in-project symlink is judged by where it points (write-through guard)", () => {
  const base = mkdtempSync(path.join(tmpdir(), "perm-dangling-"));
  try {
    const root = path.join(base, "proj");
    mkdirSync(root);
    symlinkSync(path.join(base, "not-yet", "created.txt"), path.join(root, "dangling-out")); // target outside, missing
    symlinkSync(path.join(root, "later.txt"), path.join(root, "dangling-in")); // target inside, missing
    assert.equal(isOutside(root, "dangling-out"), true); // a write would land outside the project
    assert.equal(isOutside(root, "dangling-in"), false);
    // A chain: in-project link -> in-project link -> outside missing target.
    symlinkSync(path.join(root, "dangling-out"), path.join(root, "hop"));
    assert.equal(isOutside(root, "hop"), true);
    // A cycle never hangs and resolves lexically (inside).
    symlinkSync(path.join(root, "b"), path.join(root, "a"));
    symlinkSync(path.join(root, "a"), path.join(root, "b"));
    assert.equal(isOutside(root, "a"), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("normalizeToolPath: mirrors pi's file-tool normalization (~, @, file://, unicode spaces)", () => {
  const home = os.homedir();
  assert.equal(normalizeToolPath("~"), home);
  assert.equal(normalizeToolPath("~/.ssh/id_rsa"), path.join(home, ".ssh/id_rsa"));
  assert.equal(normalizeToolPath("@.env"), ".env");
  assert.equal(normalizeToolPath("@/etc/passwd"), "/etc/passwd");
  assert.equal(normalizeToolPath("@~/x"), path.join(home, "x")); // @ stripped first, then ~ expanded, as in pi
  assert.equal(normalizeToolPath("file:///etc/passwd"), "/etc/passwd");
  assert.equal(normalizeToolPath("a\u00A0b.txt"), "a b.txt");
  assert.equal(normalizeToolPath("src/app.ts"), "src/app.ts"); // plain paths untouched
  assert.equal(normalizeToolPath("~user/x"), "~user/x"); // pi does not expand ~user either
  // The guards now judge what pi opens.
  assert.equal(isOutside("/home/proj", normalizeToolPath("~/.ssh/id_rsa")), true);
  assert.equal(isProtectedPath(normalizeToolPath("@.git/hooks/pre-commit")), true);
});

test("isProtectedPath: case-insensitive names, .envrc", () => {
  assert.ok(isProtectedPath(".GIT/config"));
  assert.ok(isProtectedPath(".ENV"));
  assert.ok(isProtectedPath("Node_Modules/x/index.js"));
  assert.ok(isProtectedPath(".envrc"));
  assert.ok(isProtectedPath("sub/.Envrc"));
  assert.ok(!isProtectedPath("environment.md"));
});

test("isOutside: a directory named ..foo is inside the project", () => {
  assert.equal(isOutside(ROOT, "..foo/x"), false);
  assert.equal(isOutside(ROOT, "./..foo"), false);
  assert.equal(isOutside(ROOT, "../foo"), true);
  assert.equal(isOutside(ROOT, ".."), true);
  assert.equal(isPlanFile(ROOT, "plan/..x.md"), true);
});

test("blockablePath: exact files and leaf dirs yes; roots, home, ancestors, denied, in-project no", () => {
  const home = os.homedir();
  const root = path.join(home, "temp", "test");
  assert.equal(blockablePath(root, path.join(home, "secret.txt")), path.join(home, "secret.txt"));
  assert.equal(blockablePath(root, path.join(home, "Documents")), path.join(home, "Documents")); // a private dir: the user's call
  assert.equal(blockablePath(root, "/etc/passwd"), "/etc/passwd");
  assert.equal(blockablePath(root, home), undefined); // never the home itself
  assert.equal(blockablePath(root, "/"), undefined);
  assert.equal(blockablePath(root, "/etc"), undefined); // top-level system dir
  assert.equal(blockablePath(root, "/srv"), undefined); // any direct child of /
  assert.equal(blockablePath(root, path.join(home, "temp")), undefined); // ancestor of the project
  assert.equal(blockablePath(root, root), undefined);
  assert.equal(blockablePath(root, path.join(root, "src", "x")), undefined); // inside the project: not an escape
  assert.equal(blockablePath(root, "/tmp/pi", { alsoInside: ["/tmp/pi/sess"] }), undefined); // ancestor of a writable root
  assert.equal(blockablePath(root, "/tmp/pi/other", { alsoInside: ["/tmp/pi/sess"] }), "/tmp/pi/other");
  assert.equal(blockablePath(root, path.join(home, ".ssh", "id_rsa"), { denyRead: ["~/.ssh"] }), undefined); // already masked
  // Strict home: everything under ~ is masked except the allowRead carve-outs, which stay blockable.
  const strict = { denyRead: ["~"], allowRead: [".", "~/.config"] };
  assert.equal(blockablePath(root, path.join(home, "secret.txt"), strict), undefined); // masked by "~"
  assert.equal(blockablePath(root, path.join(home, ".config", "gh", "hosts.yml"), strict), path.join(home, ".config", "gh", "hosts.yml")); // re-exposed: blockable
  assert.equal(blockablePath(root, path.join(home, ".config"), strict), path.join(home, ".config")); // the carve-out itself
  assert.equal(blockablePath(root, path.join(home, ".config", "..", "x"), strict), undefined); // normalizes back under "~"
  assert.equal(blockablePath(root, path.join(home, "Documents"), { denyRead: ["~/.ssh"], allowRead: ["~/Documents/pub"] }), undefined); // ancestor of a carve-out: could not be masked whole
  assert.equal(displayPath(path.join(home, "a", "b")), "~/a/b");
  assert.equal(displayPath("/etc/x"), "/etc/x");
  assert.equal(canonicalPath(root, "../x"), path.join(home, "temp", "x"));
});

test("gitDirsOf: worktree and submodule gitfiles resolve to their git dir and common dir; plain repos give nothing", () => {
  const base = mkdtempSync(path.join(tmpdir(), "perm-gitdirs-"));
  try {
    const main = path.join(base, "main");
    mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(path.join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
    const wt = path.join(base, "wt");
    mkdirSync(wt);
    writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
    const real = (p: string) => realpathSync(p);
    assert.deepEqual(gitDirsOf(wt), { gitdir: real(path.join(main, ".git", "worktrees", "wt")), commondir: real(path.join(main, ".git")) });
    // Submodule: relative gitdir, no commondir file.
    const sub = path.join(main, "sub");
    mkdirSync(path.join(main, ".git", "modules", "sub"), { recursive: true });
    mkdirSync(sub);
    writeFileSync(path.join(sub, ".git"), "gitdir: ../.git/modules/sub\n");
    const subDirs = gitDirsOf(sub)!;
    assert.equal(subDirs.gitdir, real(path.join(main, ".git", "modules", "sub")));
    assert.equal(subDirs.commondir, subDirs.gitdir);
    assert.equal(gitDirsOf(main), undefined); // .git is a directory
    assert.equal(gitDirsOf(base), undefined); // no .git
    writeFileSync(path.join(wt, ".git"), ""); // a 0-byte placeholder is not a gitfile
    assert.equal(gitDirsOf(wt), undefined);
    writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere/at/all\n"); // dangling: nothing to make writable
    assert.equal(gitDirsOf(wt), undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

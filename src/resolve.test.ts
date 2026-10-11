import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { decide, decideBashChain, decideBashChainDetailed, decideBashCommand, decideBashCommandDetailed, decideDetailed, expandHome, matchPattern, mostRestrictive, resolveSurface, resolveSurfaceDetailed, ruleAction, ruleReason } from "./resolve.ts";
import type { ModeDef } from "./schema.ts";

test("matchPattern: * spans path separators, ? is one char", () => {
  assert.ok(matchPattern("*.md", "foo.md"));
  assert.ok(matchPattern("*.md", "src/deep/foo.md")); // * crosses /
  assert.ok(!matchPattern("*.md", "foo.ts"));
  assert.ok(matchPattern("*", "anything/at/all"));
  assert.ok(matchPattern("file?.txt", "file1.txt"));
  assert.ok(!matchPattern("file?.txt", "file12.txt"));
});

test("matchPattern: **/ matches zero or more directories (bare relative paths)", () => {
  // `**/exemple.js` used to require a literal `/`, so a bare relative path
  // like `exemple.js` never matched and a `deny` rule was silently skipped in
  // favor of `"*": "allow"` (last-match-wins).
  assert.ok(matchPattern("**/exemple.js", "exemple.js"));
  assert.ok(matchPattern("**/exemple.js", "./exemple.js"));
  assert.ok(matchPattern("**/exemple.js", "sub/exemple.js"));
  assert.ok(matchPattern("**/exemple.js", "a/b/exemple.js"));
  assert.ok(matchPattern("**/exemple.js", "/abs/proj/exemple.js"));
  assert.ok(!matchPattern("**/exemple.js", "src/app.ts"));
  assert.ok(matchPattern("**/.env", ".env"));
  assert.ok(matchPattern("~/**/.env", "~/.env"));
  // Interior **/ also matches zero directories: `a/**/b` matches `a/b`.
  assert.ok(matchPattern("a/**/b", "a/b"));
  assert.ok(matchPattern("a/**/b", "a/x/b"));
  assert.ok(matchPattern("a/**/b", "a/x/y/b"));
  assert.ok(!matchPattern("a/**/b", "a/x/c"));
  // Only a whole `**/` segment is special: inside a name `**` stays `.*`, so
  // `foo**/bar` still needs the slash and does not match `foobar`.
  assert.ok(!matchPattern("foo**/bar", "foobar"));
  assert.ok(matchPattern("foo**/bar", "foo/bar"));
  assert.ok(matchPattern("foo**/bar", "fooX/y/bar"));
  // A bare `**` (no slash) keeps the classic `.*` meaning.
  assert.ok(matchPattern("**.js*", "exemple.js"));
  assert.ok(matchPattern("**", "anything/at/all"));
});

test("decide: a **/ deny rule catches a bare relative path", () => {
  const m = mode({ path: { "*": "allow", "**/exemple.js": "deny" }, read: "allow" });
  assert.equal(decide(m, "read", "exemple.js"), "deny"); // was "allow" before the fix
  assert.equal(decide(m, "read", "sub/exemple.js"), "deny");
  assert.equal(decide(m, "read", "src/app.ts"), "allow");
});

test("matchPattern: regex metacharacters in the pattern are literal", () => {
  assert.ok(matchPattern("a.b+c", "a.b+c"));
  assert.ok(!matchPattern("a.b+c", "aXbbbc")); // '.' and '+' must be literal
});

test("matchPattern: * and ? span newlines (multi-line bash commands hit the '*' rule)", () => {
  // Regression: `.` excludes `\n` in JS regexes, so a newline inside a command
  // argument used to make every glob miss — dropping the bash `ask`/`deny`.
  assert.ok(matchPattern("*", "echo 'a\nb'"));
  assert.ok(matchPattern("sudo *", "sudo sh -c \nid\n"));
  assert.ok(matchPattern("rm -rf *", "rm -rf a\nb"));
  assert.ok(matchPattern("echo ?", "echo \n"));
  assert.ok(!matchPattern("git *", "sudo\ngit status")); // anchoring still holds across lines
});

test("matchPattern: ~ and $HOME expand on both sides", () => {
  const home = os.homedir();
  assert.ok(matchPattern("~/.ssh/*", `${home}/.ssh/id_rsa`));
  assert.ok(matchPattern("$HOME/.aws", `${home}/.aws`));
  assert.equal(expandHome("~"), home);
  assert.equal(expandHome("$HOME/x"), `${home}/x`);
  assert.equal(expandHome("/abs/path"), "/abs/path");
});

test("resolveSurface: string shorthand, and last-match-wins in a pattern-map", () => {
  assert.equal(resolveSurface("deny", "anything"), "deny");
  assert.equal(resolveSurface(undefined, "anything"), undefined);
  // "*" first sets the default; the later specific pattern overrides it.
  const map = { "*": "allow", "*.env": "deny" } as const;
  assert.equal(resolveSurface(map, "foo.txt"), "allow");
  assert.equal(resolveSurface(map, "foo.env"), "deny");
  // Order matters: a trailing "*" would clobber the specific rule.
  const bad = { "*.env": "deny", "*": "allow" } as const;
  assert.equal(resolveSurface(bad, "foo.env"), "allow");
});

test("mostRestrictive: deny > ask > allow, undefined ignored", () => {
  assert.equal(mostRestrictive("allow", "ask", "deny"), "deny");
  assert.equal(mostRestrictive("allow", "ask"), "ask");
  assert.equal(mostRestrictive("allow", undefined), "allow");
  assert.equal(mostRestrictive(undefined, undefined), undefined);
});

const mode = (permission: ModeDef["permission"]): ModeDef => ({
  label: "T",
  color: "muted",
  sandbox: { enabled: true, writable: true },
  permission,
});

test("decide: path gate overrides a per-tool allow (most-restrictive)", () => {
  const m = mode({ path: { "*": "allow", "*.env": "deny" }, write: "allow" });
  assert.equal(decide(m, "write", "src/app.ts"), "allow");
  assert.equal(decide(m, "write", "config/.env"), "deny"); // path:deny wins over write:allow
});

test("decide: external_directory folds in only when target is outside", () => {
  const m = mode({ path: { "*": "allow" }, read: "allow", external_directory: "ask" });
  assert.equal(decide(m, "read", "src/app.ts", { isOutside: false }), "allow");
  assert.equal(decide(m, "read", "/etc/passwd", { isOutside: true }), "ask"); // external_directory:ask folds in
});

test("decide: non-file surfaces skip the path gate", () => {
  const m = mode({ path: { "*": "deny" }, web_search: "allow", tool: "allow", skill: "ask" });
  assert.equal(decide(m, "web_search", "query"), "allow"); // path gate does NOT apply
  assert.equal(decide(m, "tool", "some_tool"), "allow");
  assert.equal(decide(m, "skill", "deep-research"), "ask");
});

test("decide: fallback applies when nothing matches", () => {
  const m = mode({ read: "allow" });
  assert.equal(decide(m, "write", "x.ts"), "ask"); // default least-privilege fallback
  assert.equal(decide(m, "write", "x.ts", { fallback: "allow" }), "allow");
});

test("decideBashCommand: path gate binds bash args, not just the joined string", () => {
  const m = mode({ path: { "*": "allow", "*.env": "deny" }, bash: { "*": "allow" } });
  assert.equal(decideBashCommand(m, "cat", [".env"]), "deny");
  // The heuristic fallback only matched the whole command line, so a trailing
  // arg used to hide the target; per-token matching closes that.
  assert.equal(decideBashCommand(m, "cat", [".env", "other.txt"]), "deny");
  assert.equal(decideBashCommand(m, "cat", ["config/prod.env"]), "deny");
  assert.equal(decideBashCommand(m, "ls", ["src"]), "allow");
});

test("decideBashCommand: bash surface matches the joined name+args string", () => {
  const m = mode({ bash: { "*": "allow", "git push*": "ask", "sudo*": "deny" } });
  assert.equal(decideBashCommand(m, "git", ["push", "origin", "main"]), "ask");
  assert.equal(decideBashCommand(m, "git", ["status"]), "allow");
  assert.equal(decideBashCommand(m, "sudo", ["rm", "-rf", "/"]), "deny");
});

test("decideBashCommand: a newline in an argument cannot downgrade ask/deny to allow", () => {
  // The bash layer must keep matching when the joined "name args…" string
  // spans lines; otherwise the per-token path layer alone decides ("allow").
  const m = mode({ path: { "*": "allow" }, bash: { "*": "allow", "rm -rf *": "deny", "sudo *": "deny" } });
  assert.equal(decideBashCommand(m, "sudo", ["sh", "-c", "id"]), "deny");
  assert.equal(decideBashCommand(m, "sudo", ["sh", "-c", "\nid\n"]), "deny");
  assert.equal(decideBashCommand(m, "rm", ["-rf", "a\nb"]), "deny");
  const ask = mode({ path: { "*": "allow" }, bash: { "*": "ask" } });
  assert.equal(decideBashCommand(ask, "echo", ["hi"]), "ask");
  assert.equal(decideBashCommand(ask, "echo", ["hi\nthere"]), "ask");
  // decide() over the whole command line (heuristic fallback / unsandboxed modes).
  const allow = mode({ path: { "*": "allow" }, bash: { "*": "allow" } });
  assert.equal(decide(allow, "bash", "ls -la\npwd"), "allow");
});

test("decideBashCommand: project overlay path rules tighten bash (most-restrictive)", () => {
  const m = mode({ path: { "*": "allow" }, bash: { "*": "allow" } });
  m.projectOverlay = { path: { "*secrets*": "deny" } };
  assert.equal(decideBashCommand(m, "cat", ["config/secrets/key.pem"]), "deny");
  assert.equal(decideBashCommand(m, "cat", ["README.md"]), "allow");
});

test("decideBashCommand: undefined when no layer matches (caller picks default)", () => {
  const m = mode({});
  assert.equal(decideBashCommand(m, "ls", []), undefined);
});

test("decideBashChain: most-restrictive across the chain", () => {
  const m = mode({ path: { "*": "allow" }, bash: { "*": "allow", "curl *": "ask", "sudo *": "deny" } });
  assert.equal(decideBashChain(m, [{ name: "git", args: ["status"] }]), "allow");
  assert.equal(decideBashChain(m, [{ name: "git", args: ["status"] }, { name: "curl", args: ["x"] }]), "ask");
  assert.equal(decideBashChain(m, [{ name: "curl", args: ["x"] }, { name: "sudo", args: ["id"] }]), "deny");
});

test("decideBashChain: an unmatched command falls back to ask, not allow", () => {
  // A sparse custom mode with no "*" rule: commands it never mentions must
  // prompt (least privilege, as decide() does for file tools) — the dispatcher
  // used to treat them as "allow" within a chain.
  const sparse = mode({ bash: { "git *": "allow" } });
  assert.equal(decideBashChain(sparse, [{ name: "git", args: ["status"] }]), "allow");
  assert.equal(decideBashChain(sparse, [{ name: "ls", args: [] }]), "ask");
  assert.equal(decideBashChain(sparse, [{ name: "git", args: ["status"] }, { name: "ls", args: [] }]), "ask");
  assert.equal(decideBashChain(sparse, []), "ask");
  // The same shape through decide() (unsandboxed / heuristic path) already asked.
  assert.equal(decide(sparse, "bash", "ls"), "ask");
  // An explicit fallback is honored; a "*" rule (as every built-in has) never hits it.
  assert.equal(decideBashChain(sparse, [{ name: "ls", args: [] }], "allow"), "allow");
  const star = mode({ path: { "*": "allow" }, bash: { "*": "allow" } });
  assert.equal(decideBashChain(star, [{ name: "ls", args: [] }]), "allow");
});

test("decideBashCommand: aliases let a deny catch path heads and wrapped commands", () => {
  const m = mode({ bash: { "*": "allow", "sudo*": "deny", "git push*": "ask" } });
  assert.equal(decideBashCommand(m, "/usr/bin/sudo", ["id"]), "allow"); // without aliases: dodged
  assert.equal(decideBashCommand(m, "/usr/bin/sudo", ["id"], ["sudo id"]), "deny");
  assert.equal(decideBashCommand(m, "time", ["sudo", "id"], ["sudo id"]), "deny");
  assert.equal(decideBashChain(m, [{ name: "\\git", args: ["push"], aliases: ["git push"] }]), "ask");
});

test("decideBashCommand: normalized path tokens let the path gate catch escaped spellings", () => {
  const m = mode({ path: { "*": "allow", "*.env": "deny" }, bash: { "*": "allow" } });
  assert.equal(decideBashCommand(m, "cat", [".en\\v"]), "allow"); // raw spelling alone: dodged
  assert.equal(decideBashCommand(m, "cat", [".en\\v"], [], [".env"]), "deny");
  assert.equal(decideBashChain(m, [{ name: "cat", args: [".en\\v"], pathTokens: [".env"] }]), "deny");
});

test("ruleAction/ruleReason: bare strings carry no reason; objects carry theirs", () => {
  assert.equal(ruleAction("deny"), "deny");
  assert.equal(ruleReason("deny"), undefined);
  assert.equal(ruleAction({ action: "deny", reason: "use X instead" }), "deny");
  assert.equal(ruleReason({ action: "deny", reason: "use X instead" }), "use X instead");
  assert.equal(ruleReason({ action: "ask" }), undefined);
});

test("resolveSurfaceDetailed: winning (last-matching) rule's reason travels", () => {
  assert.deepEqual(resolveSurfaceDetailed("deny", "x"), { action: "deny" });
  assert.equal(resolveSurfaceDetailed(undefined, "x"), undefined);
  const map = { "*": "allow", "grep *": { action: "deny", reason: "use the grep tool instead" } } as const;
  assert.deepEqual(resolveSurfaceDetailed(map, "ls"), { action: "allow" });
  assert.deepEqual(resolveSurfaceDetailed(map, "grep foo"), { action: "deny", reason: "use the grep tool instead" });
  // Bare-string form keeps working with no reason.
  assert.deepEqual(resolveSurfaceDetailed({ "*": "allow", "*.env": "deny" }, "a.env"), { action: "deny" });
  // resolveSurface drops the reason but keeps the action (backwards compat).
  assert.equal(resolveSurface(map, "grep foo"), "deny");
});

test("decideDetailed: reason of the winning rule; most-restrictive still decides", () => {
  const m = mode({
    path: { "*": "allow" },
    bash: { "*": "allow", "grep *": { action: "deny", reason: "use the grep tool instead" } },
  });
  assert.deepEqual(decideDetailed(m, "bash", "ls"), { action: "allow" });
  assert.deepEqual(decideDetailed(m, "bash", "grep foo"), { action: "deny", reason: "use the grep tool instead" });
  // decide() is unchanged.
  assert.equal(decide(m, "bash", "grep foo"), "deny");
});

test("decideDetailed: ties resolve to the most specific layer's reason", () => {
  // Surface-specific reason beats the cross-cutting path gate's on a deny/deny tie.
  const m = mode({
    path: { "*": { action: "deny", reason: "path reason" } },
    write: { "*": { action: "deny", reason: "surface reason" } },
  });
  assert.deepEqual(decideDetailed(m, "write", "a.txt"), { action: "deny", reason: "surface reason" });
  // A reasonless winning layer falls back to the tied layer's reason.
  const m2 = mode({ path: { "*": { action: "deny", reason: "path reason" } }, write: "deny" });
  assert.deepEqual(decideDetailed(m2, "write", "a.txt"), { action: "deny", reason: "path reason" });
  // Project overlay's reason beats the base policy's on a tie (tighten-only kept).
  const m3 = mode({ bash: { "*": { action: "deny", reason: "base reason" } } });
  m3.projectOverlay = { bash: { "*": { action: "deny", reason: "overlay reason" } } };
  const d3 = decideDetailed(m3, "bash", "ls");
  assert.equal(d3.action, "deny");
  assert.equal(d3.reason, "overlay reason");
});

test("decideBashCommandDetailed: ties resolve to the bash surface's reason, not the path gate's", () => {
  // Same contract as decideDetailed: the path gate matches the token "grep",
  // the bash surface matches "grep *" - the surface-specific reason wins.
  const m = mode({
    path: { "*": { action: "deny", reason: "path reason" } },
    bash: { "*": "allow", "grep *": { action: "deny", reason: "bash reason" } },
  });
  assert.deepEqual(decideBashCommandDetailed(m, "grep", ["foo"]), { action: "deny", reason: "bash reason" });
  // Overlay beats base here too (tighten-only kept).
  const m2 = mode({ path: { "*": "allow" }, bash: { "*": "allow" } });
  m2.projectOverlay = { bash: { "grep *": { action: "deny", reason: "overlay reason" } } };
  assert.deepEqual(decideBashCommandDetailed(m2, "grep", ["foo"]), { action: "deny", reason: "overlay reason" });
});

test("decideBashChainDetailed: chain carries the strictest link's reason", () => {
  const m = mode({ path: { "*": "allow" }, bash: { "*": "allow", "curl *": "ask", "sudo *": { action: "deny", reason: "no sudo" } } });
  assert.deepEqual(decideBashChainDetailed(m, [{ name: "git", args: ["status"] }]), { action: "allow" });
  assert.deepEqual(decideBashChainDetailed(m, [{ name: "curl", args: ["x"] }, { name: "sudo", args: ["id"] }]), {
    action: "deny",
    reason: "no sudo",
  });
  assert.equal(decideBashCommandDetailed(m, "sudo", ["id"])?.reason, "no sudo");
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { githubTokenGitParams, githubTokenVar, withGitHubTokenHelper } from "./git-auth.ts";

test("githubTokenGitParams: a helper for github.com reading the variable, GITHUB_TOKEN before GH_TOKEN, nothing without a token", () => {
  assert.equal(githubTokenVar({}), undefined);
  assert.equal(githubTokenVar({ GH_TOKEN: "x" }), "GH_TOKEN");
  assert.equal(githubTokenVar({ GH_TOKEN: "x", GITHUB_TOKEN: "y" }), "GITHUB_TOKEN");
  assert.equal(githubTokenVar({ GITHUB_TOKEN: "" }), undefined, "an empty variable is no token");
  assert.equal(githubTokenGitParams({}), "");
  const p = githubTokenGitParams({ GITHUB_TOKEN: "github_pat_secret" });
  assert.match(p, /^'credential\.https:\/\/github\.com\.helper=' 'credential\.https:\/\/github\.com\.helper=!f\(\) \{ .*"\$GITHUB_TOKEN"; \}; f'$/);
  assert.doesNotMatch(p, /github_pat_secret/, "the token never appears in the parameters");
  assert.match(githubTokenGitParams({ GH_TOKEN: "t" }), /"\$GH_TOKEN"/);
});

test("withGitHubTokenHelper: appended after the caller's parameters; the env object is returned as is without a token", () => {
  const plain = { PATH: "/bin" };
  assert.equal(withGitHubTokenHelper(plain), plain);
  const out = withGitHubTokenHelper({ GITHUB_TOKEN: "t", GIT_CONFIG_PARAMETERS: "'core.autocrlf=true'" });
  assert.match(out.GIT_CONFIG_PARAMETERS!, /^'core\.autocrlf=true' 'credential\.https:\/\/github\.com\.helper=' /);
});

test("the helper is valid for git: `git credential fill` answers with the token for github.com", () => {
  let git: string;
  try {
    git = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return; // no git here
  }
  assert.ok(git);
  const env = withGitHubTokenHelper({ ...process.env, GITHUB_TOKEN: "github_pat_test123", HOME: process.env.TMPDIR ?? "/tmp", GIT_TERMINAL_PROMPT: "0" });
  const out = execFileSync("git", ["credential", "fill"], { env, input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
  assert.match(out, /^username=x-access-token$/m);
  assert.match(out, /^password=github_pat_test123$/m);
});

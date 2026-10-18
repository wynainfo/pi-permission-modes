/**
 * GitHub token plumbing for git inside the commands the extension runs.
 *
 * The user's way to let the agent reach a private GitHub repository is a
 * fine-grained token in pi's environment (`GITHUB_TOKEN`, or `GH_TOKEN` as
 * the GitHub CLI reads it). Git itself does not read either variable, so a
 * credential helper has to hand the token over; this module writes that
 * helper into `GIT_CONFIG_PARAMETERS` for github.com, so no git config has
 * to be edited for it. The helper is a shell snippet git runs through `sh`
 * (Git for Windows ships one). The empty entry first resets the helper list
 * for github.com, so a credential manager that cannot prompt in here is not
 * consulted ahead of the token.
 *
 * Pure and SDK-free.
 */

export const GITHUB_TOKEN_VARS = ["GITHUB_TOKEN", "GH_TOKEN"] as const;

/** The variable holding a GitHub token in `env`, if any (`GITHUB_TOKEN` before `GH_TOKEN`). */
export function githubTokenVar(env: NodeJS.ProcessEnv): string | undefined {
  return GITHUB_TOKEN_VARS.find((n) => Boolean(env[n]));
}

/**
 * `GIT_CONFIG_PARAMETERS` entries (git's single-quoted list form) that make
 * git read the token from `env`'s variable for github.com, or "" when no
 * token is set. The token itself never appears here: the helper reads the
 * variable when git asks.
 */
export function githubTokenGitParams(env: NodeJS.ProcessEnv): string {
  const v = githubTokenVar(env);
  if (!v) return "";
  const helper = `!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$${v}"; }; f`;
  return `'credential.https://github.com.helper=' 'credential.https://github.com.helper=${helper}'`;
}

/** `env` with the token helper appended to its `GIT_CONFIG_PARAMETERS` (the caller's entries stay ahead); `env` itself when no token is set. */
export function withGitHubTokenHelper<E extends NodeJS.ProcessEnv>(env: E): E {
  const params = githubTokenGitParams(env);
  if (!params) return env;
  const existing = env.GIT_CONFIG_PARAMETERS?.trim();
  return { ...env, GIT_CONFIG_PARAMETERS: existing ? `${existing} ${params}` : params };
}

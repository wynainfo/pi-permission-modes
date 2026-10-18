# Network

In the sandboxed modes, bash network traffic goes through the runtime's
proxy and is filtered by the mode's domain allowlist. The sandboxed process
has no other route out.

## Allowlist

`sandbox.network.allowedDomains` lists the hosts bash may reach: exact names,
`*.example.com` wildcards, and an optional `:port` suffix; every entry is
checked with the sandbox runtime's own rule when the config loads, and one it
would reject (a bare `*`, a `*.com` wildcard, a single-label host such as
`nas01`) is dropped with a warning instead of failing the sandbox. The stock list
covers the npm, yarn, and PyPI registries, `github.com`, `*.github.com`,
`api.github.com`, and `raw.githubusercontent.com`. An allowed host is reachable
on every port unless the entry names one. `deniedDomains` are refused even
while the network is open for the session. A mode without `allowedDomains`
has no filtering at all.

The allowlist is a domain allowlist, not traffic inspection: everything you
allow is exfiltration surface, so keep it tight. The runtime refuses an
allowed name that resolves to loopback, link-local, this host's own
addresses, or a cloud metadata endpoint, so a permitted domain cannot be
pointed at local services through DNS.

## Requesting access

A request to a host outside the allowlist is not a silent wall. With
`askOnBlockedHost` true (the default), the connection pauses while you are
asked: **Allow for session / Allow forever / Deny**. Then it proceeds or
fails. Headless sessions, dismissed prompts, and `askOnBlockedHost: false`
all deny.

Three ways to grant access:

- **The live prompt**, as above. A denied host stays denied for the session,
  so a retrying installer does not storm you with prompts.
- **`request_network_access`**, a tool the model has: it names the hosts and
  a reason, one prompt covers all of them (for example every host an install
  needs), and the model is told to retry the command once granted.
- **`/net allow <domain...>`**: grant for the session by hand.

Every refused host is reported in the command's output: the
`<sandbox_violations>` block names it, followed by
`[permission-mode] network: connection(s) blocked by the sandbox allowlist:
<hosts>`, so the model knows exactly what happened instead of guessing at
proxies. The model cannot grant itself access; every widening is an explicit
user action in the UI.

## Session grants and the open toggle

- `alt+n` or `/net open` / `/net restrict` toggles filtering for the session:
  `Network: filtered` (green) or `Network: open` (orange) in the footer. Open
  means every host is reachable except `deniedDomains`.
- `/net status` shows the allowlist, the session grants, and the session
  denies; `/net reset` forgets both.
- "Allow forever" persists the host to the active mode's allowlist in the
  global config, against the stock+global base; a project's tightened
  allowlist is never baked in.

Grants, denies, and the open toggle apply instantly, without a sandbox
restart, and (except "Allow forever") end with the session. Interactive
grants are user authority: they can reach past a project config's tightened
allowlist.

## Git authentication

The sandboxed modes mask `~/.ssh`, so git over SSH (`git@` remotes) cannot
authenticate from sandboxed bash, and the model is told not to try. For
fetches and pushes from inside the sandbox, use HTTPS with a fine-grained
personal access token limited to the repositories and permissions the agent
needs (Contents read/write, for example). A leaked token then reaches only
those repositories, and you revoke one token.

Only the operations that talk to the remote need a credential: clone,
fetch, pull, push, and opening a pull request. Commits, branches and
everything else git does locally work in the sandbox without one. That
leaves two ways to work with a private repository, and the choice is yours:

- **A. Autonomous access with a token.** The setup below. The agent clones,
  fetches, pushes and opens pull requests on its own (the GitHub CLI reads
  `GITHUB_TOKEN` too, so `gh pr create` works with the same variable). Scope
  the token to the repositories it should reach.
- **B. One-off steps on the host.** You clone with `!git clone <url>`, the
  agent works and commits inside the sandbox, and you push with `!git push`
  (or open the pull request yourself) when you are satisfied. Nothing is
  configured, no token exists, and every push stays a human action.

For option A:

1. Create the token on GitHub: Settings, Developer settings, Personal access
   tokens, Fine-grained tokens.
2. Start pi with the token in its environment, for example
   `GITHUB_TOKEN=github_pat_... pi` (`$env:GITHUB_TOKEN = "github_pat_..."`
   first, in PowerShell). `GH_TOKEN`, the GitHub CLI's name for it, works
   too. Do not store it in `~/.git-credentials` or `~/.netrc`: both are
   masked in the sandbox.

That is all: git does not read either variable by itself, so the extension
configures a credential helper for github.com in every command it runs
(sandboxed or not) while the variable is set. The helper hands git the
token when it asks; the token never appears in a command line or a config
file, and a credential manager that cannot prompt in the sandbox is no
longer consulted ahead of it for github.com. Git on the host, outside pi,
keeps using whatever you configured there. Should you want the same helper
there too:

```sh
git config --global credential.https://github.com.helper \
  '!f() { test "$1" = get && printf "username=x-access-token\npassword=%s\n" "$GITHUB_TOKEN"; }; f'
```

A `git@` remote then works over HTTPS without changing it:
`git -c url."https://github.com/".insteadOf=git@github.com: fetch` (the form
the model uses), or switch the remote to
`https://github.com/<owner>/<repo>.git`. A step you would rather keep out of
the sandbox can run with pi's `!` prefix (`!git push`), which runs on the
host with your own credentials.

On Windows the same applies: `GITHUB_TOKEN` arrives inside the sandbox with
the rest of your environment, your global git config is applied there from
a copy, and the helper runs through the `sh` Git for Windows ships. Git
Credential Manager, which Git for Windows configures for every user, cannot
prompt inside the sandbox: a private remote without a token fails at once
with `could not read Username for 'https://github.com': terminal prompts
disabled`, and the model is told to stop and offer you the two options
above rather than to ask for the token itself.

Any command inside the sandbox can read a token in its environment, so scope
the token, not the secrecy. Other credential files are masked by `denyRead`
([sandbox.md, Keys](sandbox.md#keys)); the stored login of a CLI such as the
GitHub CLI is not, unless you add its path.

/**
 * Bash enforcement — composes the policy action for a bash command with the
 * mode's sandbox profile and the live sandbox readiness into a concrete plan.
 *
 * This is the successor to the old `decideBash`: it keeps the same observable
 * behavior (prompt / sandbox / run / block) but derives it from data — the
 * resolved `Action` plus `sandbox.enabled`/`writable` — instead of a per-mode
 * switch. Pure and SDK-free so the whole matrix is parity-tested.
 *
 * Two halves:
 *   - `bashGate`     — the pre-execution decision (allow / prompt / block) the
 *                      `tool_call` handler acts on.
 *   - `bashExecPlan` — how the replaced bash tool wraps execution (sandboxed?
 *                      read-only?), recomputed at run time from the active mode.
 */

import { deniedByUser } from "./approvals.ts";
import type { Action } from "./schema.ts";

export type BashGateKind = "allow" | "prompt" | "block";

export interface BashGate {
  kind: BashGateKind;
  /** Prompt title (when kind === "prompt"). */
  title: string;
  /** Block reason (when kind === "block"). */
  reason: string;
  /** When prompting: run UNSANDBOXED once approved (escapes & degraded fallback). */
  onApproveUnsandboxed: boolean;
}

/**
 * Decide what to do with a bash command before it runs.
 *
 * @param action         policy action for the in-project command (resolved from
 *                       the `bash` surface, folding path/external_directory)
 * @param outsideReason  escape/privilege reason from `bashConfirmReason`, or
 *                       undefined when the heuristic finds nothing concerning
 * @param sandboxEnabled the active mode's `sandbox.enabled`
 * @param sandboxReady   whether the OS sandbox is initialized and usable
 *
 * Parity with the old decideBash:
 *   - sandbox disabled, action=allow     → allow (runs unsandboxed via execPlan)
 *   - sandbox disabled, action=ask       → prompt, unsandboxed on approval
 *   - escape / privilege (any other mode)→ prompt, unsandboxed on approval
 *   - in-project but sandbox down        → prompt "sandbox unavailable", unsandboxed
 *   - in-project, ready, action=allow    → allow (runs sandboxed via execPlan)
 *   - in-project, ready, action=ask      → prompt, stays sandboxed on approval
 *   - action=deny                        → block (new capability; built-ins never deny)
 */
export function bashGate(
  action: Action,
  outsideReason: string | undefined,
  sandboxEnabled: boolean,
  sandboxReady: boolean,
): BashGate {
  const gate = (kind: BashGateKind, title: string, reason: string, onApproveUnsandboxed: boolean): BashGate => ({
    kind,
    title,
    reason,
    onApproveUnsandboxed,
  });

  // A hard deny blocks regardless of sandbox state.
  if (action === "deny") return gate("block", "", "bash command denied by policy", false);

  // Disabling containment must not silently disable the policy layer. YOLO
  // still passes here because its explicit bash policy resolves to `allow`;
  // a custom unsandboxed mode with `ask` continues to require confirmation.
  if (!sandboxEnabled) {
    if (action === "ask") {
      return gate("prompt", "Allow bash? (sandbox disabled; command will run unsandboxed)", deniedByUser("bash command"), true);
    }
    return gate("allow", "", "", false);
  }

  // Out-of-project / privilege escalation: prompt, run unsandboxed once approved
  // (the sandbox would block a genuine escape anyway).
  if (outsideReason) return gate("prompt", `Allow bash? (${outsideReason})`, deniedByUser(`bash command (${outsideReason})`), true);

  // In-project but the sandbox is unavailable: never run silently unprotected.
  if (!sandboxReady) return gate("prompt", "Allow bash? (sandbox unavailable)", deniedByUser("bash command (sandbox unavailable)"), true);

  // In-project, sandbox ready: the policy action drives it.
  if (action === "ask") return gate("prompt", "Allow bash?", deniedByUser("bash command"), false);
  return gate("allow", "", "", false);
}

/**
 * The prompt title with the command it is about, so the user can judge what
 * they approve: one line, whitespace collapsed, cut at 80 characters. The
 * title alone ("Allow bash?") left the subject invisible when the last
 * rendered tool call was an unrelated earlier one (#25).
 */
export function titleWithCommand(title: string, command: string): string {
  const one = command.replace(/\s+/g, " ").trim();
  const short = one.length > 80 ? `${one.slice(0, 77)}...` : one;
  return `${title} \`${short}\``;
}

export interface BashExecPlan {
  sandboxed: boolean;
  readOnly: boolean;
}

/**
 * How to run an approved bash command. Recomputed at execution time from the
 * active mode's sandbox profile and whether the user granted an unsandboxed
 * escape for this call.
 *
 * Parity: sandboxed when the mode sandboxes AND the runtime is ready AND no
 * escape was approved; read-only iff the mode's sandbox is non-writable (Plan).
 */
export function bashExecPlan(
  sandboxEnabled: boolean,
  sandboxWritable: boolean,
  sandboxReady: boolean,
  approvedUnsandboxed: boolean,
): BashExecPlan {
  return {
    sandboxed: sandboxEnabled && sandboxReady && !approvedUnsandboxed,
    readOnly: !sandboxWritable,
  };
}

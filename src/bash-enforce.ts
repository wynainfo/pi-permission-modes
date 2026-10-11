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

import { docRef } from "./docs.ts";
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
 * @param policyReason   optional per-rule reason attached to the winning policy
 *                       rule: overrides the block reason on deny, and the refusal
 *                       reason when an ask is refused on policy grounds (never
 *                       shown on approval). Prompts caused by an escape or an
 *                       unavailable sandbox report their own cause instead, so
 *                       the model is never told a policy story about a
 *                       non-policy block.
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
  policyReason?: string,
): BashGate {
  const gate = (kind: BashGateKind, title: string, reason: string, onApproveUnsandboxed: boolean): BashGate => ({
    kind,
    title,
    reason,
    onApproveUnsandboxed,
  });

  // A hard deny blocks regardless of sandbox state.
  if (action === "deny") return gate("block", "", policyReason ?? `bash command denied by policy (see ${docRef("bash")})`, false);

  // Disabling containment must not silently disable the policy layer. YOLO
  // still passes here because its explicit bash policy resolves to `allow`;
  // a custom unsandboxed mode with `ask` continues to require confirmation.
  if (!sandboxEnabled) {
    if (action === "ask") {
      return gate("prompt", "Allow bash? (sandbox disabled; command will run unsandboxed)", policyReason ?? "bash blocked", true);
    }
    return gate("allow", "", "", false);
  }

  // Out-of-project / privilege escalation: prompt, run unsandboxed once approved
  // (the sandbox would block a genuine escape anyway). A refusal here is about
  // the escape, not the policy - report its cause, not the rule's reason.
  if (outsideReason) return gate("prompt", `Allow bash? (${outsideReason})`, `bash blocked (${outsideReason})`, true);

  // In-project but the sandbox is unavailable: never run silently unprotected.
  if (!sandboxReady) return gate("prompt", "Allow bash? (sandbox unavailable)", "bash blocked (sandbox unavailable)", true);

  // In-project, sandbox ready: the policy action drives it.
  if (action === "ask") return gate("prompt", "Allow bash?", policyReason ?? "bash blocked", false);
  return gate("allow", "", "", false);
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

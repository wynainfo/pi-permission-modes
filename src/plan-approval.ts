/**
 * One-step plan approval: after Plan Mode has rendered a plan with
 * `show_plan`, the user accepts it where it was shown instead of switching
 * modes and typing "implement it". The pure parts live here (state
 * restore, message templating, success detection); the prompts and the
 * mode switch are wired in index.ts.
 *
 * Persistence: every `show_plan` success appends a `perm-plan` entry with
 * the plan path; an approval appends one without a path. The latest entry
 * wins on resume / reload / branch navigation, so an implemented plan is
 * never offered again.
 */

/** Session entry type recording the pending plan (see restorePendingPlan). */
export const PLAN_ENTRY = "perm-plan";

/** `{ path }` = a plan is pending; `{}` = the pending plan was approved. */
export interface PlanEntry {
  path?: string;
}

export interface PendingPlan {
  /** Project-relative plan path, as show_plan validated it. */
  path: string;
  /** Declined in the end-of-run prompt: not offered again until the next show_plan (B and C still work). */
  declined: boolean;
}

/** Top-level `plan` config (global only; a project config cannot set it). */
export interface PlanApprovalConfig {
  /** Mode to switch to on approval. Default "build". */
  approveMode?: string;
  /** The user message that starts the implementing turn; `{path}` is the plan path. */
  approveMessage?: string;
}

export const DEFAULT_APPROVE_MODE = "build";
export const DEFAULT_APPROVE_MESSAGE = "The plan in `{path}` is approved. Implement it now.";

/** The approval message for `path`: the template with `{path}` filled in, or the default when the template is empty. */
export function approvalMessage(template: string | undefined, path: string): string {
  const t = template && template.trim() ? template : DEFAULT_APPROVE_MESSAGE;
  return t.split("{path}").join(path);
}

/** The pending plan recorded by the latest `perm-plan` entry, if that entry still names one. */
export function restorePendingPlan(
  entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
): PendingPlan | undefined {
  let pending: PendingPlan | undefined;
  for (const e of entries) {
    if (e.type !== "custom" || e.customType !== PLAN_ENTRY) continue;
    const p = (e.data as PlanEntry | undefined)?.path;
    pending = typeof p === "string" && p ? { path: p, declined: false } : undefined;
  }
  return pending;
}

/**
 * True when a `show_plan` call rendered a plan. The tool reports a bad path
 * or a missing file as a normal result carrying `details.error` (so the
 * model reads the reason), not as a thrown error, so both are checked.
 */
export function showPlanSucceeded(isError: boolean, result: unknown): boolean {
  if (isError) return false;
  const details = (result as { details?: { error?: unknown } } | undefined)?.details;
  return !(details && typeof details === "object" && "error" in details && details.error);
}

/** The plan path a show_plan result reports, when it does (falls back to the requested path). */
export function shownPlanPath(result: unknown, requested: string): string {
  const p = (result as { details?: { path?: unknown } } | undefined)?.details?.path;
  return typeof p === "string" && p ? p : requested;
}

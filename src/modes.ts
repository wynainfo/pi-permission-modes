/**
 * Small shared types that aren't part of the mode schema itself.
 *
 * Mode definitions, labels, colors and the cycle order now live in `schema.ts`
 * (data-driven). This module holds only the persisted session state.
 */

/** Persisted per-session so the mode survives reload / resume / tree navigation. */
export interface PermState {
  /** A mode name; validated against the loaded config's `modes` on restore. */
  mode: string;
}

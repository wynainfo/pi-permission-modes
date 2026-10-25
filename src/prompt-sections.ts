/**
 * The mode text as pi prompt sections.
 *
 * pi 0.86+ keeps the system prompt as named sections recorded in the
 * transcript; a change between turns is sent as a small patch after the
 * conversation on models that accept mid-conversation system messages, so
 * the provider's cached prefix survives a mode switch or a network grant.
 * Returning `systemPrompt` from `before_agent_start` would instead force one
 * collapsed head per request and rewrite it on every change.
 *
 * The three parts are separate sections so the static docs pointer is never
 * resent and a grant does not resend the steering text. An absent part
 * deletes its section, which pi patches as `null`.
 */

export interface PromptParts {
  /** The sandbox awareness block (boundaries, allowlist, scratch dir). */
  aware?: string;
  /** Where the shipped documentation lives. */
  docs?: string;
  /** The mode's own `systemPrompt` (Plan Mode steering). */
  steering?: string;
}

export const PROMPT_SECTIONS = {
  aware: "permission_mode",
  docs: "permission_mode_docs",
  steering: "permission_mode_steering",
} as const;

const PART_KEYS = ["aware", "docs", "steering"] as const;

/**
 * The slice of pi's `before_agent_start` event this module reads and writes.
 * `systemPromptOptions` is typed loosely: older pi type packages lack
 * `sections`, and the runtime check below is what decides.
 */
export interface PromptSectionEvent {
  readonly systemPrompt: string;
  systemPromptOptions?: unknown;
}

function sectionsOf(event: PromptSectionEvent): Record<string, string> | undefined {
  const opts = event.systemPromptOptions;
  if (!opts || typeof opts !== "object") return undefined;
  const sections = (opts as { sections?: unknown }).sections;
  return sections && typeof sections === "object" ? (sections as Record<string, string>) : undefined;
}

/**
 * Write the parts into the event's sections. Returns `undefined` when pi
 * renders them (nothing to return), or today's joined `systemPrompt` on a pi
 * without sections, or one that exposes them but leaves them out of the
 * rendered prompt (`event.systemPrompt` re-renders from the options in pi
 * 0.86+, so the check is the render itself).
 */
export function writePromptSections(event: PromptSectionEvent, parts: PromptParts): { systemPrompt: string } | undefined {
  const texts = PART_KEYS.map((k) => parts[k]).filter((t): t is string => !!t);
  const sections = sectionsOf(event);
  if (sections) {
    for (const key of PART_KEYS) {
      const text = parts[key];
      if (text) sections[PROMPT_SECTIONS[key]] = text;
      else delete sections[PROMPT_SECTIONS[key]];
    }
    if (texts.length === 0 || event.systemPrompt.includes(texts[0])) return undefined;
  }
  if (texts.length === 0) return undefined;
  return { systemPrompt: [event.systemPrompt, ...texts].join("\n\n") };
}

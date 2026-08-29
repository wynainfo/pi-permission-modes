export interface PermissionKeybindings {
  sandbox: string[];
  network: string[];
  warnings: string[];
}

const DEFAULT_SANDBOX_KEYS = ["alt+m"];
const DEFAULT_NETWORK_KEYS = ["alt+n"];
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const SPECIAL_KEYS = new Map(
  [
    "escape",
    "esc",
    "enter",
    "return",
    "tab",
    "space",
    "backspace",
    "delete",
    "insert",
    "clear",
    "home",
    "end",
    "pageUp",
    "pageDown",
    "up",
    "down",
    "left",
    "right",
    ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  ].map((key) => [key.toLowerCase(), key]),
);
const SYMBOL_KEYS = new Set(["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?"]);

/** Validate and normalize the documented pi `modifier+key` syntax. */
function normalizeKey(value: string): string | undefined {
  const input = value.trim();
  if (!input) return undefined;

  let base: string;
  let modifiers: string[];
  if (input === "+") {
    base = "+";
    modifiers = [];
  } else if (input.endsWith("++")) {
    base = "+";
    modifiers = input.slice(0, -2).split("+");
  } else {
    const parts = input.split("+");
    base = parts.pop() ?? "";
    modifiers = parts;
  }

  const normalizedModifiers = modifiers.map((modifier) => modifier.toLowerCase());
  if (
    normalizedModifiers.some((modifier) => !MODIFIERS.has(modifier)) ||
    new Set(normalizedModifiers).size !== normalizedModifiers.length
  ) {
    return undefined;
  }

  const lowerBase = base.toLowerCase();
  const normalizedBase =
    /^[a-z0-9]$/.test(lowerBase) || SYMBOL_KEYS.has(base) ? lowerBase : SPECIAL_KEYS.get(lowerBase);
  if (!normalizedBase) return undefined;
  if (normalizedModifiers.length === 0) return normalizedBase;
  return normalizedBase === "+"
    ? `${normalizedModifiers.join("+")}++`
    : `${normalizedModifiers.join("+")}+${normalizedBase}`;
}

function parseKeys(value: unknown, fallback: string[], name: string, warnings: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (Array.isArray(value) && value.length === 0) return []; // explicit disable

  const candidates = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  if (!candidates) {
    warnings.push(`permission-mode: keyBindings.${name} must be a string or string array; using ${fallback.join("/")}`);
    return [...fallback];
  }

  const keys: string[] = [];
  let invalid = 0;
  for (const candidate of candidates) {
    const key = typeof candidate === "string" ? normalizeKey(candidate) : undefined;
    if (!key) {
      invalid++;
      continue;
    }
    if (!keys.some((existing) => existing.toLowerCase() === key.toLowerCase())) keys.push(key);
  }
  if (invalid > 0) warnings.push(`permission-mode: ignored ${invalid} invalid keyBindings.${name} value(s)`);
  if (keys.length > 0) return keys;

  warnings.push(`permission-mode: keyBindings.${name} has no valid keys; using ${fallback.join("/")}`);
  return [...fallback];
}

/** Resolve extension shortcuts from permission-mode.json's top-level `keyBindings` object. */
export function loadPermissionKeybindings(value: unknown): PermissionKeybindings {
  const warnings: string[] = [];
  let raw: Record<string, unknown> = {};
  if (value !== undefined) {
    if (value && typeof value === "object" && !Array.isArray(value)) raw = value as Record<string, unknown>;
    else warnings.push("permission-mode: keyBindings must be a JSON object; using default shortcuts");
  }
  return {
    sandbox: parseKeys(raw.sandbox, DEFAULT_SANDBOX_KEYS, "sandbox", warnings),
    network: parseKeys(raw.network, DEFAULT_NETWORK_KEYS, "network", warnings),
    warnings,
  };
}

/** Match pi's key-hint convention for actions with multiple bindings. */
export function shortcutText(keys: string[]): string {
  return keys.join("/");
}

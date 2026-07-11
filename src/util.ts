/**
 * Small dependency-free utilities. Kept SDK-free so they can be unit-tested in
 * plain Node without the pi host.
 */

/** True when an error is a "module/package not found" failure (any of Node's spellings). */
export function isModuleNotFound(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === "ERR_MODULE_NOT_FOUND" ||
    e?.code === "MODULE_NOT_FOUND" ||
    /cannot find (module|package)/i.test(e?.message ?? "")
  );
}

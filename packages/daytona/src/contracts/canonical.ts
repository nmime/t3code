/**
 * Canonical JSON: deterministic serialization used for profile digests and
 * idempotency payload hashes. Object keys sorted, `undefined` dropped.
 */

export function canonicalize(value: unknown): string {
  return render(value);
}

function render(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) return JSON.stringify(String(value));
    return JSON.stringify(value);
  }
  if (t === "boolean" || t === "string") return JSON.stringify(value);
  if (t === "bigint") return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(render).join(",")}]`;
  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${render(v)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/**
 * Secret redaction for imported configuration.
 *
 * Credentials live in the secrets broker, never in configuration files, and a
 * Mac home directory is never copied blindly into a Linux sandbox.
 */

const SECRET_KEY_PATTERN =
  /(api[_-]?key|token|secret|password|passwd|credential|authorization|auth)/i;

const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, "sk-ant-***"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-***"],
  [/\bghp_[A-Za-z0-9]{8,}\b/g, "ghp_***"],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, "github_pat_***"],
  [/\bAKIA[0-9A-Z]{8,}\b/g, "AKIA***"],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, "xox*-***"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<jwt>"],
];

export function redactValue(key: string, value: string): string {
  if (SECRET_KEY_PATTERN.test(key)) return "***";
  return redactText(value);
}

export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Redact secret-looking assignments in TOML/INI-style config text. */
export function redactTomlLike(text: string): { text: string; redactedKeys: string[] } {
  const redactedKeys: string[] = [];
  const out = text
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s*[\w.-]+\s*=\s*)(.+)$/);
      if (!match) return redactText(line);
      const key = match[1]!.split("=")[0]!.trim();
      if (SECRET_KEY_PATTERN.test(key)) {
        redactedKeys.push(key);
        return `${match[1]}***`;
      }
      return `${match[1]}${redactText(match[2]!)}`;
    })
    .join("\n");
  return { text: out, redactedKeys };
}

/** Deep-redact JSON-compatible structures. */
export function redactJson<T>(value: T): { value: T; redactedKeys: string[] } {
  const redactedKeys: string[] = [];
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
        if (SECRET_KEY_PATTERN.test(key) && typeof entry === "string" && entry.length > 0) {
          out[key] = "***";
          redactedKeys.push(key);
        } else {
          out[key] = walk(entry);
        }
      }
      return out;
    }
    if (typeof input === "string") return redactText(input);
    return input;
  };
  return { value: walk(value) as T, redactedKeys };
}

/**
 * macOS-specific leftovers that will not work inside a Linux sandbox:
 * Homebrew paths, macOS binaries, Keychain references, socket paths.
 */
export function findMacSpecificLines(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\/Users\//,
    /\bbrew\b/i,
    /\bdarwin\b/i,
    /\bosx\b/i,
    /\/Library\//,
    /keychain/i,
    /\.sock\b/,
  ];
  text.split("\n").forEach((line, index) => {
    if (patterns.some((p) => p.test(line))) out.push(`${index + 1}: ${line.trim()}`);
  });
  return out;
}

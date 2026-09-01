const PRIVATE_KEY_BLOCK = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu;
const HEADER_SECRET = /\b(authorization|cookie|proxy-authorization|set-cookie)\s*:\s*[^\r\n]*/giu;
const KEY_VALUE_SECRET = /\b(api[-_]?key|access[-_]?token|auth[-_]?token|password|passwd|refresh[-_]?token|secret|session[-_]?token|token)\b(\s*[:=]\s*)([^\s,;]+)/giu;
const URI_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@([^/\s]+)/giu;

export function redactAndroidOutput(value: string, roots: readonly string[] = []): string {
  let result = value
    .replace(/\0/gu, "")
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]")
    .replace(HEADER_SECRET, (_match, name: string) => `${name}: [REDACTED]`)
    .replace(KEY_VALUE_SECRET, (_match, name: string, separator: string) => `${name}${separator}[REDACTED]`)
    .replace(URI_CREDENTIALS, "$1[REDACTED]@[HOST]");

  const uniqueRoots = [...new Set(roots.map((root) => root.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const root of uniqueRoots) {
    result = result.replace(new RegExp(escapeRegExp(root), "giu"), "[PATH]");
    const slashRoot = root.replace(/\\/gu, "/");
    if (slashRoot !== root) {
      result = result.replace(new RegExp(escapeRegExp(slashRoot), "giu"), "[PATH]");
    }
  }
  return result;
}

export function redactAndroidUiValue(value: string, passwordField = false): string | undefined {
  if (value === "") return undefined;
  if (passwordField) return "[REDACTED]";
  const redacted = redactAndroidOutput(value);
  return redacted.length <= 512 ? redacted : `${redacted.slice(0, 511)}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

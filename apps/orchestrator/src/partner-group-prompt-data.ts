/** Escape external data before placing it inside a prompt's trust boundary. */
export function escapeUntrustedPromptMarkup(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** One JSON line: group fields cannot create lines or close the envelope. */
export function untrustedJsonBlock(value: unknown): string {
  const payload = escapeUntrustedPromptMarkup((JSON.stringify(value) ?? "null").replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`));
  return `<untrusted-data>\n${payload}\n</untrusted-data>`;
}

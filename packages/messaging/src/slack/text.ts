export const SLACK_TEXT_LIMIT = 4_000;

/** Keep each provider post within Slack's recommended text length without splitting a surrogate pair. */
export function splitSlackText(value: string): readonly string[] {
  if (typeof value !== "string") throw new TypeError("Slack text must be a string.");
  if (value.length === 0) return [];
  const parts: string[] = [];
  let part = "";
  let encodedLength = 0;
  for (const character of value) {
    const nextLength = character === "&" ? 5 : character === "<" || character === ">" ? 4 : character.length;
    if (encodedLength + nextLength > SLACK_TEXT_LIMIT) {
      parts.push(part);
      part = "";
      encodedLength = 0;
    }
    part += character;
    encodedLength += nextLength;
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

/** Slack markup entities prevent provider-side mention expansion of assistant output. */
export function safeSlackText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

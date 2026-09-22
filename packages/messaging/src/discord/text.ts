import { MessagingTransportError } from "../types.js";

export const DISCORD_TEXT_LIMIT = 2_000;

/** Splits Discord text while keeping fenced code blocks valid in every part. */
export function splitDiscordText(source: string, limit = DISCORD_TEXT_LIMIT): readonly string[] {
  if (!Number.isSafeInteger(limit) || limit < 8 || limit > DISCORD_TEXT_LIMIT) {
    throw invalidInput("Invalid Discord text limit.");
  }
  if (source.length === 0) return [];
  if (source.length <= limit) return [source];

  const chunks: string[] = [];
  let remaining = source;
  let fenceLanguage = "";
  let inFence = false;
  while (remaining.length > 0) {
    const prefix = inFence ? `\`\`\`${fenceLanguage}\n` : "";
    const reserve = 4;
    const capacity = limit - prefix.length - reserve;
    if (capacity < 1) throw invalidInput("Discord code fence language is too long.");
    let end = safeUtf16Boundary(remaining, Math.min(capacity, remaining.length));
    if (end < remaining.length) {
      const candidate = remaining.slice(0, end);
      const boundary = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
      if (boundary >= Math.floor(capacity * 0.6)) end = boundary + 1;
    }
    let body = remaining.slice(0, end).trimEnd();
    if (body.length === 0) body = remaining.slice(0, end);
    const fenceState = scanFences(body, inFence, fenceLanguage);
    const closes = fenceState.inFence ? (body.endsWith("\n") ? "```" : "\n```") : "";
    chunks.push(`${prefix}${body}${closes}`);
    remaining = remaining.slice(end).trimStart();
    inFence = fenceState.inFence;
    fenceLanguage = fenceState.language;
  }
  return chunks;
}

function scanFences(source: string, initial: boolean, language: string): {
  readonly inFence: boolean;
  readonly language: string;
} {
  let inFence = initial;
  let activeLanguage = language;
  for (const match of source.matchAll(/^```([^`\r\n]*)\s*$/gmu)) {
    if (inFence) {
      inFence = false;
      activeLanguage = "";
    } else {
      inFence = true;
      activeLanguage = (match[1] ?? "").trim().slice(0, 64);
    }
  }
  return { inFence, language: activeLanguage };
}

function safeUtf16Boundary(value: string, proposed: number): number {
  if (proposed >= value.length) return value.length;
  const previous = value.charCodeAt(proposed - 1);
  const next = value.charCodeAt(proposed);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? proposed - 1
    : proposed;
}

function invalidInput(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}

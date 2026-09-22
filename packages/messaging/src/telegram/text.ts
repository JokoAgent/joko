import { MessagingTransportError } from "../types.js";

export const TELEGRAM_TEXT_LIMIT = 4_096;

/** Splits on a useful boundary without ever bisecting a UTF-16 surrogate pair. */
export function splitTelegramText(source: string, limit = TELEGRAM_TEXT_LIMIT): readonly string[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TELEGRAM_TEXT_LIMIT) {
    throw new MessagingTransportError("invalid_input", "Invalid Telegram text limit.", {
      retryable: false,
      effect: "none"
    });
  }
  if (source.length === 0) return [];

  const chunks: string[] = [];
  let remaining = source;
  while (remaining.length > limit) {
    let end = safeUtf16Boundary(remaining, limit);
    const candidate = remaining.slice(0, end);
    const newline = candidate.lastIndexOf("\n");
    const space = candidate.lastIndexOf(" ");
    const preferred = Math.max(newline, space);
    if (preferred >= Math.floor(limit * 0.6)) end = preferred + 1;
    const chunk = remaining.slice(0, end).trimEnd();
    if (chunk.length === 0) {
      end = safeUtf16Boundary(remaining, limit);
      chunks.push(remaining.slice(0, end));
    } else {
      chunks.push(chunk);
    }
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function escapeTelegramHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function safeUtf16Boundary(value: string, proposed: number): number {
  if (proposed >= value.length) return value.length;
  const previous = value.charCodeAt(proposed - 1);
  const next = value.charCodeAt(proposed);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? proposed - 1
    : proposed;
}

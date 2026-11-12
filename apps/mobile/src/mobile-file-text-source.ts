export const mobileFileTextMaximumLines = 5_000;

export function normalizeMobileFileText(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

export function mobileFileTextSource(text: string): {
  readonly lines: readonly string[];
  readonly clipped: boolean;
  readonly text: string;
  readonly normalizedText: string;
  readonly totalLines: number;
} {
  const normalizedText = normalizeMobileFileText(text);
  const lines = normalizedText === "" ? [] : normalizedText.split("\n");
  const clipped = lines.length > mobileFileTextMaximumLines;
  let end = text.length;
  if (clipped) {
    const breaks = /\r\n?|\n/gu; let match: RegExpExecArray | null;
    for (let line = 0; (match = breaks.exec(text)); line += 1) { if (line === mobileFileTextMaximumLines - 1) { end = match.index; break; } }
  }
  return { lines: lines.slice(0, mobileFileTextMaximumLines), clipped, text: text.slice(0, end), normalizedText, totalLines: lines.length };
}

export const mobileFileTextMaximumLines = 5_000;

export function mobileFileTextSource(text: string): { readonly lines: readonly string[]; readonly clipped: boolean; readonly text: string } {
  const lines = text === "" ? [] : text.replace(/\r\n?/gu, "\n").split("\n");
  const clipped = lines.length > mobileFileTextMaximumLines;
  let end = text.length;
  if (clipped) {
    const breaks = /\r\n?|\n/gu; let match: RegExpExecArray | null;
    for (let line = 0; (match = breaks.exec(text)); line += 1) { if (line === mobileFileTextMaximumLines - 1) { end = match.index; break; } }
  }
  return { lines: lines.slice(0, mobileFileTextMaximumLines), clipped, text: text.slice(0, end) };
}

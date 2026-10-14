export const LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD = 14;
export const AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD = 4;
export const LONG_USER_MESSAGE_COLLAPSED_LINES = 10;
export const AUTOMATION_USER_MESSAGE_COLLAPSED_LINES = 3;

const HALF_WIDTH_UNITS_PER_VISUAL_LINE = 34;
const MIN_HALF_WIDTH_UNITS_PER_VISUAL_LINE = 24;
const WIDE_CHAR_RE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/g;
const LINE_BREAK_RE = /\r\n|\r|\n/;

/** A conservative prefilter avoids measuring short input. Native layout decides the final result. */
export function mayExceedVisualLineThreshold(content: string, threshold: number): boolean {
  const trimmed = content.trim();
  return !!trimmed && trimmed.split(LINE_BREAK_RE).length
    + trimmed.length * 2 / MIN_HALF_WIDTH_UNITS_PER_VISUAL_LINE > threshold;
}

/** Estimate only until the bounded native measurement arrives, avoiding a full-height first frame. */
export function resolveUserMessageCollapse(content: string, measuredLines: number | null, threshold: number): boolean {
  if (measuredLines !== null) return measuredLines > threshold;
  const trimmed = content.trim();
  if (!trimmed) return false;
  let visualLines = 0;
  for (const line of trimmed.split(LINE_BREAK_RE)) {
    visualLines += Math.max(1, Math.ceil((line.length + (line.match(WIDE_CHAR_RE)?.length ?? 0)) / HALF_WIDTH_UNITS_PER_VISUAL_LINE));
    if (visualLines > threshold) return true;
  }
  return false;
}

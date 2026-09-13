import { useLayoutEffect, useRef, useState } from "react";

/** Collapse threshold for normal, manually-authored user messages. */
export const LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD = 14;

/** Collapse recurring scheduler prompts after four visual lines. */
export const AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD = 4;

/** A nominal 456 px text column at the Timeline's 15 px user-message size. */
const HALF_WIDTH_UNITS_PER_VISUAL_LINE = 60;

/**
 * Conservative coarse-filter capacity for the narrowest supported message bubble.
 * The filter may admit extra messages for measurement, but must not exclude text
 * that can cross the threshold after the Timeline narrows.
 */
const MIN_HALF_WIDTH_UNITS_PER_VISUAL_LINE = 24;
const FALLBACK_LINE_HEIGHT_PX = 24;
const LINE_BREAK_RE = /\r\n|\r|\n/u;
const WIDE_CHAR_RE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/gu;

function estimatedVisualLineCount(line: string): number {
  if (line.length === 0) return 1;
  const wideCount = line.match(WIDE_CHAR_RE)?.length ?? 0;
  return Math.max(1, Math.ceil((line.length + wideCount) / HALF_WIDTH_UNITS_PER_VISUAL_LINE));
}

/** Initial, nominal-width estimate used only until the layout measurement runs. */
export function shouldInitiallyCollapseUserMessage(
  content: string,
  threshold = LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD
): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;

  let lines = 0;
  for (const line of trimmed.split(LINE_BREAK_RE)) {
    lines += estimatedVisualLineCount(line);
    if (lines > threshold) return true;
  }
  return false;
}

/**
 * Cheap, deliberately conservative gate for mounting the hidden layout mirror.
 * It assumes every character is full-width and the bubble is at its narrowest,
 * leaving the actual collapse decision to measured layout.
 */
export function mayExceedUserMessageLineThreshold(
  content: string,
  threshold = LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD
): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  const logicalLines = trimmed.split(LINE_BREAK_RE).length;
  return logicalLines + (trimmed.length * 2) / MIN_HALF_WIDTH_UNITS_PER_VISUAL_LINE > threshold;
}

export function measuredUserMessageVisualLines(scrollHeight: number, lineHeight: number): number {
  const safeScrollHeight = Number.isFinite(scrollHeight) ? Math.max(0, scrollHeight) : 0;
  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight > 0
    ? lineHeight
    : FALLBACK_LINE_HEIGHT_PX;
  // Rounding gives sub-pixel glyph/line-box variance a half-line tolerance.
  return Math.round(safeScrollHeight / safeLineHeight);
}

export function shouldCollapseMeasuredUserMessage(
  scrollHeight: number,
  lineHeight: number,
  threshold = LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD
): boolean {
  return measuredUserMessageVisualLines(scrollHeight, lineHeight) > threshold;
}

/**
 * Measures a hidden, same-width text mirror and keeps the decision current as
 * Timeline/sidebar/window width changes reflow the message.
 */
export function useUserMessageAutoCollapse(
  content: string,
  enabled: boolean,
  threshold = LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD
) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [shouldCollapse, setShouldCollapse] = useState(
    () => enabled && shouldInitiallyCollapseUserMessage(content, threshold)
  );

  useLayoutEffect(() => {
    if (!enabled) {
      setShouldCollapse(false);
      return;
    }
    const mirror = mirrorRef.current;
    if (mirror === null) return;

    const measure = (): void => {
      const computedLineHeight = Number.parseFloat(getComputedStyle(mirror).lineHeight);
      const next = shouldCollapseMeasuredUserMessage(mirror.scrollHeight, computedLineHeight, threshold);
      setShouldCollapse((current) => current === next ? current : next);
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(mirror);
    return () => observer.disconnect();
  }, [content, enabled, threshold]);

  return { mirrorRef, shouldCollapse };
}

import type {
  QueueItemTextEditView,
  QueueItemView,
  TimelineInlineTextRangeView,
  TimelineInputMentionRangeView
} from "./model.js";
import {
  SELECTION_QUOTE_BLOCK_MARKER_LINE,
  visibleSelectionQuoteMessageText
} from "./selection-quote.js";

/**
 * Build the plain queue editor projection from the canonical queued input.
 * Quote marker lines are product-private, so remove them through explicit
 * deletion transactions and carry only ranges whose exact source survives.
 */
export function queueItemEditProjection(item: QueueItemView): QueueItemTextEditView {
  let result: QueueItemTextEditView = {
    text: item.text,
    mentionRanges: item.mentionRanges ?? [],
    pastedTextRanges: item.pastedTextRanges ?? [],
    textSplices: []
  };
  if (item.quotesEncoded !== true) return result;

  // Composer serialization is LF-canonical. A non-canonical imported body is
  // still shown markerless, but no source range is allowed to cross that
  // normalization boundary without an exact transaction receipt.
  if (result.text.includes("\r")) {
    return unownedTextEdit(result, visibleSelectionQuoteMessageText(result.text, true));
  }

  for (;;) {
    const removal = lastQuoteMarkerLine(result.text);
    if (removal === undefined) break;
    result = removeTextRange(result, removal.start, removal.end);
  }
  const visible = visibleSelectionQuoteMessageText(item.text, true);
  return result.text === visible
    ? result
    : unownedTextEdit(result, visible);
}

/** Map exact range ownership through one textarea edit without token guessing. */
export function remapQueueItemTextEdit(
  previous: QueueItemTextEditView,
  nextText: string,
  transaction?: QueueItemTextEditTransaction
): QueueItemTextEditView {
  if (transaction === undefined) {
    return previous.text === nextText ? previous : unownedTextEdit(previous, nextText);
  }
  if (
    previous.text === nextText
    && transaction.selectionStart === transaction.selectionEnd
  ) return previous;
  let editStart = transaction.selectionStart;
  let previousEnd = transaction.selectionEnd;
  if (!Number.isSafeInteger(editStart) || !Number.isSafeInteger(previousEnd)
    || editStart < 0 || previousEnd < editStart || previousEnd > previous.text.length) {
    return unownedTextEdit(previous, nextText);
  }
  const delta = nextText.length - previous.text.length;
  if (editStart === previousEnd && delta < 0) {
    if (transaction.inputType.endsWith("Backward")) editStart = previousEnd + delta;
    else if (transaction.inputType.endsWith("Forward")) previousEnd = editStart - delta;
    else return unownedTextEdit(previous, nextText);
  }
  const insertedLength = nextText.length - (previous.text.length - (previousEnd - editStart));
  const nextEnd = editStart + insertedLength;
  if (editStart < 0 || previousEnd > previous.text.length || insertedLength < 0 || nextEnd > nextText.length
    || previous.text.slice(0, editStart) !== nextText.slice(0, editStart)
    || previous.text.slice(previousEnd) !== nextText.slice(nextEnd)) {
    return unownedTextEdit(previous, nextText);
  }
  return {
    text: nextText,
    mentionRanges: remapRanges(previous.mentionRanges, editStart, previousEnd, delta),
    pastedTextRanges: remapRanges(previous.pastedTextRanges, editStart, previousEnd, delta),
    textSplices: [...previous.textSplices, {
      start: editStart,
      end: previousEnd,
      replacementText: nextText.slice(editStart, nextEnd)
    }]
  };
}

export interface QueueItemTextEditTransaction {
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly inputType: string;
}

export function equalQueueItemTextEdit(left: QueueItemTextEditView, right: QueueItemTextEditView): boolean {
  return left.text === right.text
    && left.mentionRanges.length === right.mentionRanges.length
    && left.mentionRanges.every((range, index) => {
      const other = right.mentionRanges[index];
      return other !== undefined && range.start === other.start && range.end === other.end && range.mentionIndex === other.mentionIndex;
    })
    && left.pastedTextRanges.length === right.pastedTextRanges.length
    && left.pastedTextRanges.every((range, index) => {
      const other = right.pastedTextRanges[index];
      return other !== undefined && range.start === other.start && range.end === other.end && range.display === other.display;
    });
}

function removeTextRange(input: QueueItemTextEditView, start: number, end: number): QueueItemTextEditView {
  return {
    text: `${input.text.slice(0, start)}${input.text.slice(end)}`,
    mentionRanges: remapRanges(input.mentionRanges, start, end, start - end),
    pastedTextRanges: remapRanges(input.pastedTextRanges, start, end, start - end),
    textSplices: [...input.textSplices, { start, end, replacementText: "" }]
  };
}

function unownedTextEdit(previous: QueueItemTextEditView, text: string): QueueItemTextEditView {
  return {
    text,
    mentionRanges: [],
    pastedTextRanges: [],
    textSplices: [...previous.textSplices, {
      start: 0,
      end: previous.text.length,
      replacementText: text
    }]
  };
}

function remapRanges<T extends TimelineInputMentionRangeView | TimelineInlineTextRangeView>(
  ranges: readonly T[],
  editStart: number,
  previousEditEnd: number,
  delta: number
): readonly T[] {
  return ranges.flatMap((range): readonly T[] => {
    if (range.end <= editStart) return [range];
    if (range.start >= previousEditEnd) return [{ ...range, start: range.start + delta, end: range.end + delta }];
    return [];
  });
}

function lastQuoteMarkerLine(text: string): { readonly start: number; readonly end: number } | undefined {
  const lines = text.split("\n");
  let offset = text.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const start = offset - line.length;
    if (line.trimStart() === SELECTION_QUOTE_BLOCK_MARKER_LINE) {
      if (index < lines.length - 1) return { start, end: offset + 1 };
      return start > 0 ? { start: start - 1, end: offset } : { start, end: offset };
    }
    offset = start - 1;
  }
  return undefined;
}

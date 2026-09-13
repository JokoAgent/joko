import type { VoiceDraftFence } from "./voice-draft-fence.js";

export interface VoiceInsertedEditTracker {
  readonly sessionId: string;
  readonly insertedText: string;
  readonly rawTranscriptText?: string;
  readonly expectedText: string;
  readonly leftContext: string;
  readonly rightContext: string;
}

export type VoiceInsertedEditInspection =
  | { readonly edited: true; readonly beforeText: string; readonly afterText: string; readonly rawTranscriptText?: string }
  | { readonly edited: false; readonly reason: "unchanged" | "insertedTextPresent" | "anchorsUnavailable" | "rangeUnavailable" | "empty" | "tooLong" };

const MAXIMUM_ANCHOR_CHARACTERS = 80;
const MINIMUM_ANCHOR_CHARACTERS = 2;

export function createVoiceInsertedEditTracker(input: {
  readonly fence: VoiceDraftFence;
  readonly insertedText: string;
  readonly rawTranscriptText?: string;
}): VoiceInsertedEditTracker {
  const prefix = input.fence.originalText.slice(0, input.fence.from);
  const suffix = input.fence.originalText.slice(input.fence.to);
  return Object.freeze({
    sessionId: input.fence.sessionId,
    insertedText: input.insertedText,
    ...(input.rawTranscriptText === undefined ? {} : { rawTranscriptText: input.rawTranscriptText }),
    expectedText: `${prefix}${input.insertedText}${suffix}`,
    leftContext: prefix.slice(-MAXIMUM_ANCHOR_CHARACTERS),
    rightContext: suffix.slice(0, MAXIMUM_ANCHOR_CHARACTERS)
  });
}

/**
 * Extracts only the text still bracketed by the original composer context.
 * Edits elsewhere are ignored so they cannot become dictionary evidence.
 */
export function inspectVoiceInsertedEdit(
  tracker: VoiceInsertedEditTracker,
  currentText: string
): VoiceInsertedEditInspection {
  if (currentText === tracker.expectedText) return { edited: false, reason: "unchanged" };
  if (currentText.includes(tracker.insertedText)) return { edited: false, reason: "insertedTextPresent" };
  const hasLeft = tracker.leftContext.length >= MINIMUM_ANCHOR_CHARACTERS;
  const hasRight = tracker.rightContext.length >= MINIMUM_ANCHOR_CHARACTERS;
  if (!hasLeft && !hasRight) return inspectWholeReplacement(tracker, currentText);
  if (!hasLeft && tracker.leftContext.length > 0 || !hasRight && tracker.rightContext.length > 0) {
    return { edited: false, reason: "anchorsUnavailable" };
  }
  const leftIndex = hasLeft ? currentText.lastIndexOf(tracker.leftContext) : 0;
  if (leftIndex < 0) return { edited: false, reason: "rangeUnavailable" };
  const start = hasLeft ? leftIndex + tracker.leftContext.length : 0;
  const end = hasRight ? currentText.indexOf(tracker.rightContext, start) : currentText.length;
  if (end < start) return { edited: false, reason: "rangeUnavailable" };
  return editedResult(tracker, currentText.slice(start, end));
}

function inspectWholeReplacement(
  tracker: VoiceInsertedEditTracker,
  currentText: string
): VoiceInsertedEditInspection {
  return editedResult(tracker, currentText);
}

function editedResult(
  tracker: VoiceInsertedEditTracker,
  value: string
): VoiceInsertedEditInspection {
  const afterText = value.replace(/\r\n?/gu, "\n").trim();
  if (afterText === "") return { edited: false, reason: "empty" };
  if (afterText === tracker.insertedText.trim()) return { edited: false, reason: "unchanged" };
  if (afterText.length > tracker.insertedText.length + 80) return { edited: false, reason: "tooLong" };
  return Object.freeze({
    edited: true,
    beforeText: tracker.insertedText,
    afterText,
    ...(tracker.rawTranscriptText === undefined ? {} : { rawTranscriptText: tracker.rawTranscriptText })
  });
}

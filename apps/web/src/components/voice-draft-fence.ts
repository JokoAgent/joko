import type { JSONContent } from "@tiptap/core";
import { composerDocumentPlainText } from "../composer-quote-document.js";
import { replaceComposerDocumentTextRange } from "./composer-inline-mention.js";

export interface VoiceDraftFence {
  readonly sessionId: string;
  readonly revision: number;
  readonly from: number;
  readonly to: number;
  readonly originalText: string;
}

export type VoiceDraftApplyResult =
  | {
      readonly applied: true;
      readonly document: JSONContent;
      readonly text: string;
      readonly caret: number;
    }
  | { readonly applied: false; readonly reason: "staleSession" | "staleRevision" | "textChanged" | "rangeUnavailable" | "empty" };

export function createVoiceDraftFence(input: {
  readonly sessionId: string;
  readonly revision: number;
  readonly text: string;
  readonly selection?: { readonly from: number; readonly to: number };
}): VoiceDraftFence {
  const fallback = Math.max(0, input.text.length);
  const from = clampOffset(input.selection?.from ?? fallback, input.text.length);
  const to = clampOffset(input.selection?.to ?? from, input.text.length);
  return Object.freeze({
    sessionId: input.sessionId,
    revision: input.revision,
    from: Math.min(from, to),
    to: Math.max(from, to),
    originalText: input.text
  });
}

/**
 * Applies a terminal transcript only to the exact editor version and selection
 * captured at microphone start. A late result can never replace newer input.
 */
export function applyVoiceDraftResult(input: {
  readonly fence: VoiceDraftFence;
  readonly sessionId: string;
  readonly revision: number;
  readonly document: JSONContent;
  readonly text: string;
  readonly transcript: string;
}): VoiceDraftApplyResult {
  const transcript = input.transcript.replace(/\r\n?/gu, "\n").trim();
  if (transcript.length === 0) return { applied: false, reason: "empty" };
  if (input.fence.sessionId !== input.sessionId) return { applied: false, reason: "staleSession" };
  if (input.fence.revision !== input.revision) return { applied: false, reason: "staleRevision" };
  if (input.fence.originalText !== input.text) return { applied: false, reason: "textChanged" };
  const document = replaceComposerDocumentTextRange(input.document, input.fence.from, input.fence.to, transcript);
  if (document === undefined) return { applied: false, reason: "rangeUnavailable" };
  return {
    applied: true,
    document,
    text: composerDocumentPlainText(document),
    caret: input.fence.from + transcript.length
  };
}

function clampOffset(value: number, maximum: number): number {
  return Number.isInteger(value) ? Math.max(0, Math.min(value, maximum)) : maximum;
}

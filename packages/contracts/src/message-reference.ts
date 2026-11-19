export interface TaskMessageReferenceAnchor {
  readonly sourceSessionId: string;
  readonly messageId: string;
  readonly eventId: string;
}

export interface TaskMessageReferenceRange extends TaskMessageReferenceAnchor {
  readonly start: number;
  readonly end: number;
}

export function isTaskMessageReferenceAnchor(anchor: TaskMessageReferenceAnchor): boolean {
  return [anchor.sourceSessionId, anchor.messageId, anchor.eventId].every((id) => typeof id === "string"
    && id.trim() === id && id.length > 0 && id.length <= 1_024 && !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(id));
}

/** Stable relative route used for an explicitly inserted whole-message reference. */
export function taskMessageReferenceHref(anchor: TaskMessageReferenceAnchor): string {
  return `#/tasks/${encodeURIComponent(anchor.sourceSessionId)}?message=${encodeURIComponent(anchor.messageId)}&event=${encodeURIComponent(anchor.eventId)}`;
}

export function validInputMessageReferences(
  text: string,
  references: readonly TaskMessageReferenceRange[],
  occupied: readonly { readonly start: number; readonly end: number }[] = []
): boolean {
  if (!Array.isArray(references) || references.length > 32) return false;
  let previousEnd = 0;
  for (const reference of references) {
    if (reference === null || typeof reference !== "object"
      || !Number.isSafeInteger(reference.start) || !Number.isSafeInteger(reference.end)
      || reference.start < previousEnd || reference.end <= reference.start || reference.end > text.length
      || !isTaskMessageReferenceAnchor(reference)
      || text.slice(reference.start, reference.end) !== taskMessageReferenceHref(reference)
      || occupied.some((range) => range.start < reference.end && reference.start < range.end)) return false;
    previousEnd = reference.end;
  }
  return true;
}

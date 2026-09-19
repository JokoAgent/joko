import { create } from "@bufbuild/protobuf";
import {
  CapabilitySupport,
  InputContentSchema,
  InputPartSchema,
  QueueItemState,
  QueueTextEditSpliceSchema,
  capabilityNames,
  type BackendDescriptor,
  type InputContent,
  type QueueItem,
  type QueueTextEditSplice
} from "@joko/contracts";
import type { TimelineRow } from "./timeline";

export type MobileMessageActionId = "add-to-composer" | "delete";

export interface MobileMessageActionItem {
  readonly id: MobileMessageActionId;
  readonly label: string;
  readonly destructive?: boolean;
  readonly separatorBefore?: boolean;
}

export function buildMobileMessageActions(
  row: TimelineRow,
  input: { readonly canDelete: boolean }
): readonly MobileMessageActionItem[] {
  if (!row.completed || (row.kind !== "user" && row.kind !== "assistant")) return [];
  const actions: MobileMessageActionItem[] = [];
  if (row.text.trim()) actions.push({ id: "add-to-composer", label: "Add to composer" });
  if (input.canDelete) actions.push({
    id: "delete",
    label: "Delete message",
    destructive: true,
    separatorBefore: actions.length > 0
  });
  return actions;
}

export class DeferredSheetAction<T> {
  #generation = 0;
  #pending?: { readonly generation: number; readonly value: T };

  open(): void {
    this.#generation += 1;
    this.#pending = undefined;
  }

  select(value: T): number {
    this.#pending = { generation: this.#generation, value };
    return this.#generation;
  }

  cancel(): number {
    this.#pending = undefined;
    return this.#generation;
  }

  closed(generation: number): T | undefined {
    if (generation !== this.#generation || this.#pending?.generation !== generation) return undefined;
    const value = this.#pending.value;
    this.#pending = undefined;
    return value;
  }
}

export function backendSupports(backend: BackendDescriptor | undefined, capability: string): boolean {
  return backend?.capabilities?.capabilities.some(
    (item) => item.name === capability && item.support === CapabilitySupport.SUPPORTED
  ) === true;
}

export interface MobileQueueCapabilities {
  readonly cancel: boolean;
  readonly edit: boolean;
  readonly reorder: boolean;
}

export function mobileQueueCapabilities(backend: BackendDescriptor | undefined): MobileQueueCapabilities {
  return {
    cancel: backendSupports(backend, capabilityNames.queueCancel),
    edit: backendSupports(backend, capabilityNames.queueEdit),
    reorder: backendSupports(backend, capabilityNames.queueReorder)
  };
}

export function currentSessionQueueItems(
  items: readonly QueueItem[],
  sessionId: string | undefined
): readonly QueueItem[] {
  if (!sessionId) return [];
  return items.filter((item) => item.sessionId === sessionId).sort(compareQueueItems);
}

export function acceptedQueueItems(
  items: readonly QueueItem[],
  sessionId: string | undefined
): readonly QueueItem[] {
  return currentSessionQueueItems(items, sessionId).filter((item) => item.state === QueueItemState.ACCEPTED);
}

export function queueItemText(input: InputContent | undefined): string | undefined {
  if (!input) return undefined;
  if (input.parts.some((part) => part.content.case === "image" || part.content.case === "file")) return undefined;
  const text = input.parts.filter((part) => part.content.case === "text");
  if (text.length !== 1) return undefined;
  return text[0]!.content.case === "text" ? text[0]!.content.value : undefined;
}

export function queueItemHasStructuredInput(input: InputContent | undefined): boolean {
  return input !== undefined && (input.quotesEncoded
    || input.pastedTextRanges.length > 0
    || input.mentionRanges.length > 0
    || input.parts.some((part) => part.content.case !== "text"));
}

export function editQueueItemText(
  input: InputContent | undefined,
  replacementText: string
): { readonly input: InputContent; readonly textSplices: readonly QueueTextEditSplice[] } | undefined {
  const originalText = queueItemText(input);
  if (input === undefined || originalText === undefined || !replacementText.trim()) return undefined;
  if (replacementText === originalText) return undefined;
  const parts = [create(InputPartSchema, { content: { case: "text", value: replacementText } })];
  return {
    input: create(InputContentSchema, { parts }),
    textSplices: [create(QueueTextEditSpliceSchema, {
      start: 0,
      end: originalText.length,
      replacementText
    })]
  };
}

export type MobileQueueMove =
  | { readonly placement: "before"; readonly anchorQueueItemId: string }
  | { readonly placement: "after"; readonly anchorQueueItemId: string };

export function queueMove(
  items: readonly QueueItem[],
  queueItemId: string,
  direction: "up" | "down"
): MobileQueueMove | undefined {
  const index = items.findIndex((item) => item.queueItemId === queueItemId);
  if (index < 0) return undefined;
  if (direction === "up") {
    const anchor = items[index - 1];
    return anchor ? { placement: "before", anchorQueueItemId: anchor.queueItemId } : undefined;
  }
  const anchor = items[index + 1];
  return anchor ? { placement: "after", anchorQueueItemId: anchor.queueItemId } : undefined;
}

function compareQueueItems(left: QueueItem, right: QueueItem): number {
  if (left.ordinal < right.ordinal) return -1;
  if (left.ordinal > right.ordinal) return 1;
  return left.queueItemId.localeCompare(right.queueItemId, "en");
}

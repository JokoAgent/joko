import type { MobileComposerRichEditSegment } from "./mobile-composer-rich-document";

interface MobileComposerRichWebBaseMessage {
  readonly instanceId: string;
}

export interface MobileComposerRichReadyMessage extends MobileComposerRichWebBaseMessage {
  readonly type: "ready";
}

export interface MobileComposerRichPongMessage extends MobileComposerRichWebBaseMessage {
  readonly type: "pong";
  readonly id: string;
}

export interface MobileComposerRichChangeMessage extends MobileComposerRichWebBaseMessage {
  readonly type: "change";
  readonly documentId: number;
  readonly segments: readonly MobileComposerRichEditSegment[];
  readonly start: number;
  readonly end: number;
}

export interface MobileComposerRichSelectionMessage extends MobileComposerRichWebBaseMessage {
  readonly type: "selection";
  readonly documentId: number;
  readonly start: number;
  readonly end: number;
}

export interface MobileComposerRichPasteMessage extends MobileComposerRichWebBaseMessage {
  readonly type: "paste";
  readonly documentId: number;
  readonly start: number;
  readonly end: number;
  readonly text?: string;
}

export interface MobileComposerRichPasteImagesStartMessage extends MobileComposerRichWebBaseMessage {
  readonly type: "pasteImagesStart";
  readonly documentId: number;
  readonly requestId: string;
  readonly count: number;
}

export interface MobileComposerRichPasteImageMessage extends MobileComposerRichWebBaseMessage {
  readonly type: "pasteImage";
  readonly documentId: number;
  readonly requestId: string;
  readonly index: number;
  readonly mediaType: MobileComposerPastedImageMediaType;
  readonly name: string;
  readonly base64: string;
}

export interface MobileComposerRichPasteImageFailedMessage extends MobileComposerRichWebBaseMessage {
  readonly type: "pasteImageFailed";
  readonly documentId: number;
  readonly requestId: string;
  readonly index: number;
}

export interface MobileComposerRichHeightMessage extends MobileComposerRichWebBaseMessage {
  readonly type: "height";
  readonly height: number;
}

export interface MobileComposerRichFocusMessage extends MobileComposerRichWebBaseMessage {
  readonly type: "focus";
}

export interface MobileComposerRichBlurMessage extends MobileComposerRichWebBaseMessage {
  readonly type: "blur";
}

export interface MobileComposerRichCompositionMessage extends MobileComposerRichWebBaseMessage {
  readonly type: "composition";
  readonly composing: boolean;
}

export type MobileComposerCommandPaletteKey = "ArrowUp" | "ArrowDown" | "Enter" | "Tab" | "Escape";

export interface MobileComposerRichPaletteKeyMessage extends MobileComposerRichWebBaseMessage {
  readonly type: "paletteKey";
  readonly key: MobileComposerCommandPaletteKey;
}

export interface MobileComposerRichActivateMessage extends MobileComposerRichWebBaseMessage {
  readonly type: "activate";
  readonly documentId: number;
  readonly occurrenceKey: string;
}

export type MobileComposerRichWebMessage = MobileComposerRichReadyMessage
  | MobileComposerRichPongMessage
  | MobileComposerRichChangeMessage
  | MobileComposerRichSelectionMessage
  | MobileComposerRichPasteMessage
  | MobileComposerRichPasteImagesStartMessage
  | MobileComposerRichPasteImageMessage
  | MobileComposerRichPasteImageFailedMessage
  | MobileComposerRichHeightMessage
  | MobileComposerRichFocusMessage
  | MobileComposerRichBlurMessage
  | MobileComposerRichCompositionMessage
  | MobileComposerRichPaletteKeyMessage
  | MobileComposerRichActivateMessage;

export const mobileComposerPastedImageMediaTypes = [
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp"
] as const;
export type MobileComposerPastedImageMediaType = typeof mobileComposerPastedImageMediaTypes[number];

const maximumPastedImageCount = 20;
const maximumPastedImageBase64Characters = 40_000_000;
const maximumPastedImageNameCharacters = 255;
const maximumPasteRequestIdCharacters = 64;
const maximumProtocolCharacters = maximumPastedImageBase64Characters + 4_096;
const maximumInstanceCharacters = 128;
const maximumIdentityCharacters = 2_100;
const maximumDocumentCharacters = 1_000_000;
const maximumPasteCharacters = 2_000_000;
const maximumSegments = 131_073;
const maximumHeight = 4_096;

export function parseMobileComposerRichWebMessage(raw: string): MobileComposerRichWebMessage | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > maximumProtocolCharacters) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !validIdentity(value.instanceId, maximumInstanceCharacters) || typeof value.type !== "string") {
    return undefined;
  }
  const instanceId = value.instanceId;
  if (value.type === "ready" && exactKeys(value, ["type", "instanceId"])) {
    return { type: "ready", instanceId };
  }
  if (value.type === "pong" && exactKeys(value, ["type", "instanceId", "id"])
    && validIdentity(value.id, maximumInstanceCharacters)) {
    return { type: "pong", instanceId, id: value.id };
  }
  if (value.type === "change" && exactKeys(value, ["type", "instanceId", "documentId", "segments", "start", "end"])
    && validDocumentId(value.documentId) && validSelection(value.start, value.end)) {
    const segments = parseSegments(value.segments);
    if (segments) return {
      type: "change",
      instanceId,
      documentId: value.documentId,
      segments,
      start: value.start as number,
      end: value.end as number
    };
  }
  if (value.type === "selection" && exactKeys(value, ["type", "instanceId", "documentId", "start", "end"])
    && validDocumentId(value.documentId) && validSelection(value.start, value.end)) {
    return { type: "selection", instanceId, documentId: value.documentId,
      start: value.start as number, end: value.end as number };
  }
  if (value.type === "paste"
    && (exactKeys(value, ["type", "instanceId", "documentId", "start", "end"])
      || exactKeys(value, ["type", "instanceId", "documentId", "start", "end", "text"]))
    && validDocumentId(value.documentId) && validSelection(value.start, value.end)
    && (value.text === undefined || typeof value.text === "string" && value.text.length <= maximumPasteCharacters)) {
    return {
      type: "paste",
      instanceId,
      documentId: value.documentId,
      start: value.start as number,
      end: value.end as number,
      ...(value.text === undefined ? {} : { text: value.text })
    };
  }
  if (value.type === "pasteImagesStart"
    && exactKeys(value, ["type", "instanceId", "documentId", "requestId", "count"])
    && validDocumentId(value.documentId) && validPasteRequestId(value.requestId)
    && Number.isSafeInteger(value.count) && (value.count as number) >= 1
    && (value.count as number) <= maximumPastedImageCount) {
    return {
      type: "pasteImagesStart",
      instanceId,
      documentId: value.documentId,
      requestId: value.requestId,
      count: value.count as number
    };
  }
  if (value.type === "pasteImageFailed"
    && exactKeys(value, ["type", "instanceId", "documentId", "requestId", "index"])
    && validDocumentId(value.documentId) && validPasteRequestId(value.requestId)
    && validPastedImageIndex(value.index)) {
    return {
      type: "pasteImageFailed",
      instanceId,
      documentId: value.documentId,
      requestId: value.requestId,
      index: value.index as number
    };
  }
  if (value.type === "pasteImage"
    && exactKeys(value, [
      "type", "instanceId", "documentId", "requestId", "index", "mediaType", "name", "base64"
    ])
    && validDocumentId(value.documentId) && validPasteRequestId(value.requestId)
    && validPastedImageIndex(value.index) && isPastedImageMediaType(value.mediaType)
    && typeof value.name === "string" && value.name.length > 0
    && value.name.length <= maximumPastedImageNameCharacters
    && !/[\u0000-\u001f\u007f]/u.test(value.name)
    && typeof value.base64 === "string" && value.base64.length > 0
    && value.base64.length <= maximumPastedImageBase64Characters) {
    return {
      type: "pasteImage",
      instanceId,
      documentId: value.documentId,
      requestId: value.requestId,
      index: value.index as number,
      mediaType: value.mediaType,
      name: value.name,
      base64: value.base64
    };
  }
  if (value.type === "height" && exactKeys(value, ["type", "instanceId", "height"])
    && typeof value.height === "number" && Number.isSafeInteger(value.height)
    && value.height >= 1 && value.height <= maximumHeight) {
    return { type: "height", instanceId, height: value.height };
  }
  if (value.type === "focus" && exactKeys(value, ["type", "instanceId"])) {
    return { type: "focus", instanceId };
  }
  if (value.type === "blur" && exactKeys(value, ["type", "instanceId"])) {
    return { type: "blur", instanceId };
  }
  if (value.type === "composition" && exactKeys(value, ["type", "instanceId", "composing"])
    && typeof value.composing === "boolean") {
    return { type: "composition", instanceId, composing: value.composing };
  }
  if (value.type === "paletteKey" && exactKeys(value, ["type", "instanceId", "key"])
    && isCommandPaletteKey(value.key)) {
    return { type: "paletteKey", instanceId, key: value.key };
  }
  if (value.type === "activate" && exactKeys(value, ["type", "instanceId", "documentId", "occurrenceKey"])
    && validDocumentId(value.documentId) && validIdentity(value.occurrenceKey, maximumIdentityCharacters)) {
    return {
      type: "activate",
      instanceId,
      documentId: value.documentId,
      occurrenceKey: value.occurrenceKey
    };
  }
  return undefined;
}

function parseSegments(value: unknown): readonly MobileComposerRichEditSegment[] | undefined {
  if (!Array.isArray(value) || value.length > maximumSegments) return undefined;
  const segments: MobileComposerRichEditSegment[] = [];
  let textCharacters = 0;
  for (const segment of value) {
    if (!isRecord(segment) || typeof segment.type !== "string") return undefined;
    if (segment.type === "text"
      && (exactKeys(segment, ["type", "text"]) || exactKeys(segment, ["type", "text", "slashCommand"]))
      && typeof segment.text === "string" && segment.text.length > 0
      && (segment.slashCommand === undefined || typeof segment.slashCommand === "string"
        && segment.slashCommand === segment.text && segment.slashCommand.length <= 257
        && /^\/[^\s/\u0000-\u001f\u007f\u2028\u2029]+$/u.test(segment.slashCommand))) {
      textCharacters += segment.text.length;
      if (!Number.isSafeInteger(textCharacters) || textCharacters > maximumDocumentCharacters) return undefined;
      segments.push({
        type: "text",
        text: segment.text,
        ...(segment.slashCommand === undefined ? {} : { slashCommand: segment.slashCommand })
      });
      continue;
    }
    if (segment.type === "occurrence" && exactKeys(segment, ["type", "occurrenceKey"])
      && validIdentity(segment.occurrenceKey, maximumIdentityCharacters)) {
      segments.push({ type: "occurrence", occurrenceKey: segment.occurrenceKey });
      continue;
    }
    return undefined;
  }
  return segments;
}

function validSelection(start: unknown, end: unknown): start is number {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end)
    && (start as number) >= 0 && (end as number) >= (start as number)
    && (end as number) <= maximumDocumentCharacters;
}

function validDocumentId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function validPasteRequestId(value: unknown): value is string {
  return validIdentity(value, maximumPasteRequestIdCharacters);
}

function validPastedImageIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    && (value as number) < maximumPastedImageCount;
}

function isPastedImageMediaType(value: unknown): value is MobileComposerPastedImageMediaType {
  return typeof value === "string" && (mobileComposerPastedImageMediaTypes as readonly string[]).includes(value);
}

function isCommandPaletteKey(value: unknown): value is MobileComposerCommandPaletteKey {
  return value === "ArrowUp" || value === "ArrowDown" || value === "Enter" || value === "Tab" || value === "Escape";
}

function validIdentity(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

export const mobileComposerRichProtocolLimits = {
  maximumDocumentCharacters,
  maximumHeight,
  maximumPasteCharacters,
  maximumPasteRequestIdCharacters,
  maximumPastedImageBase64Characters,
  maximumPastedImageCount,
  maximumPastedImageNameCharacters,
  maximumProtocolCharacters,
  maximumSegments
};

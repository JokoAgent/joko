import { assertAudioArtifactMetadata, validInlineTextRanges, validInputMentionRanges, type AudioArtifactMetadata, type BlobRef, type EventPayload, type InlineTextRange, type InputMentionRange, type MentionInput, type MessageBlock, type PromptInput } from "@joko/core";
import type { PersistedEvent } from "@joko/store";

const PROJECTION_FORMAT = 1;
export const MAXIMUM_PORTABLE_SESSION_MESSAGES = 100_000;
const MAX_BLOCKS_PER_MESSAGE = 10_000;
const MAX_PROJECTION_BYTES = 128 * 1024 * 1024;
const MAX_STRING_BYTES = 16 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface PortableProjectedMessage {
  readonly sourceOrder: number;
  readonly emittedAt: number;
  readonly role: "user" | "assistant";
  readonly blocks: readonly MessageBlock[];
  readonly acceptedInput?: PromptInput;
  readonly usage?: Extract<EventPayload, { readonly type: "message_complete" }>["usage"];
  readonly generationDurationMs?: Extract<EventPayload, { readonly type: "message_complete" }>["generationDurationMs"];
  readonly generationReliable?: Extract<EventPayload, { readonly type: "message_complete" }>["generationReliable"];
  readonly automationOrigin?: Extract<EventPayload, { readonly type: "message_complete" }>["automationOrigin"];
  readonly inputDelivery?: Extract<EventPayload, { readonly type: "message_complete" }>["inputDelivery"];
}

export interface PortableSessionProjection {
  readonly format: 1;
  readonly messages: readonly PortableProjectedMessage[];
  readonly artifacts: readonly PortableProjectedArtifact[];
}

export interface PortableProjectedArtifact {
  readonly sourceOrder: number;
  readonly emittedAt: number;
  readonly payload: Extract<EventPayload, { type: "artifact" }> | { readonly type: "status"; readonly key: "artifact_unavailable"; readonly text: string };
}

export class PortableSessionProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortableSessionProjectionError";
  }
}

/**
 * Retains completed public messages and standalone Artifacts. Native persistence remains the model
 * context authority; this projection is the durable, renderer-safe history.
 */
export function projectPortableSessionMessages(
  events: readonly Pick<PersistedEvent, "emittedAt" | "payload">[]
): PortableSessionProjection {
  const messages: PortableProjectedMessage[] = [];
  const artifacts: PortableProjectedArtifact[] = [];
  for (const [sourceOrder, event] of events.entries()) {
    if (event.payload.type === "artifact") artifacts.push({ sourceOrder, emittedAt: event.emittedAt, payload: event.payload });
    if (event.payload.type === "status" && event.payload.key === "artifact_unavailable") artifacts.push({ sourceOrder, emittedAt: event.emittedAt, payload: { type: "status", key: "artifact_unavailable", text: event.payload.text ?? "" } });
    if (event.payload.type !== "message_complete" || event.payload.automaticContinuation !== undefined
      || event.payload.acceptedInput?.automaticContinuation !== undefined) continue;
    messages.push({
      sourceOrder,
      emittedAt: event.emittedAt,
      role: event.payload.role,
      blocks: event.payload.blocks,
      ...(event.payload.acceptedInput === undefined ? {} : {
        acceptedInput: projectAcceptedInputMentions(
          event.payload.acceptedInput,
          (mention) => mention.kind === "session" ? undefined : mention
        )
      }),
      ...(event.payload.usage === undefined ? {} : { usage: event.payload.usage }),
      ...(event.payload.generationDurationMs === undefined
        ? {}
        : { generationDurationMs: event.payload.generationDurationMs }),
      ...(event.payload.generationReliable === undefined
        ? {}
        : { generationReliable: event.payload.generationReliable }),
      ...(event.payload.automationOrigin === undefined ? {} : { automationOrigin: event.payload.automationOrigin }),
      ...(event.payload.inputDelivery === undefined ? {} : { inputDelivery: event.payload.inputDelivery })
    });
  }
  const projection: PortableSessionProjection = { format: PROJECTION_FORMAT, messages, artifacts };
  validatePortableSessionProjection(projection);
  return projection;
}

export function encodePortableSessionProjection(projection: PortableSessionProjection): Uint8Array {
  validatePortableSessionProjection(projection);
  const bytes = Buffer.from(JSON.stringify(projection), "utf8");
  if (bytes.byteLength > MAX_PROJECTION_BYTES) throw invalid("Portable Session message history is too large.");
  return bytes;
}

export function decodePortableSessionProjection(bytes: Uint8Array): PortableSessionProjection {
  if (bytes.byteLength > MAX_PROJECTION_BYTES) throw invalid("Portable Session message history is too large.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid("Portable Session message history is not valid UTF-8 JSON.");
  }
  validatePortableSessionProjection(value);
  return value;
}

export function collectPortableProjectionBlobRefs(
  projection: PortableSessionProjection
): ReadonlyMap<string, BlobRef> {
  validatePortableSessionProjection(projection);
  const refs = new Map<string, BlobRef>();
  const collect = (blob: BlobRef): void => {
    const previous = refs.get(blob.id);
    if (previous !== undefined && !sameBlob(previous, blob)) throw invalid("Portable Session reuses a Blob ID for different content.");
    refs.set(blob.id, blob);
  };
  for (const message of projection.messages) {
    for (const image of message.acceptedInput?.images ?? []) collect(image.blob);
    for (const file of message.acceptedInput?.files ?? []) collect(file.blob);
    for (const block of message.blocks) {
      if (block.kind !== "image" && block.kind !== "artifact") continue;
      collect(block.blob);
      if (block.kind === "artifact" && block.audioMetadata?.artwork !== undefined) collect(block.audioMetadata.artwork.blob);
    }
  }
  for (const { payload } of projection.artifacts) if (payload.type === "artifact") {
    collect(payload.artifact);
    if (payload.audioMetadata?.artwork !== undefined) collect(payload.audioMetadata.artwork.blob);
  }
  return refs;
}

/** Rebinds package-local Blob identities to the receiving Artifact Store. */
export function rebindPortableProjectionBlobs(
  projection: PortableSessionProjection,
  replacements: ReadonlyMap<string, BlobRef>
): PortableSessionProjection {
  validatePortableSessionProjection(projection);
  const sourceRefs = collectPortableProjectionBlobRefs(projection);
  const replace = (blob: BlobRef): BlobRef => {
    const replacement = replacements.get(blob.id);
    if (replacement === undefined || replacement.sha256 !== blob.sha256 || replacement.byteLength !== blob.byteLength || replacement.mimeType !== blob.mimeType) throw invalid("Portable Session media is missing or mismatched.");
    return replacement;
  };
  const audio = (value: AudioArtifactMetadata | undefined): AudioArtifactMetadata | undefined => value?.artwork === undefined ? value : { ...value, artwork: { ...value.artwork, blob: replace(value.artwork.blob) } };
  const messages = projection.messages.map((message): PortableProjectedMessage => ({
    ...message,
    ...(message.acceptedInput === undefined ? {} : {
      acceptedInput: rebindAcceptedInput(message.acceptedInput, sourceRefs, replacements, replace)
    }),
    blocks: message.blocks.map((block): MessageBlock => {
      if (block.kind !== "image" && block.kind !== "artifact") return block;
      const replacement = replace(block.blob);
      return { ...block, blob: replacement, ...(block.kind !== "artifact" || block.audioMetadata === undefined ? {} : { audioMetadata: audio(block.audioMetadata) }) };
    })
  }));
  const artifacts = projection.artifacts.map((entry): PortableProjectedArtifact => entry.payload.type === "status" ? entry : { ...entry, payload: { ...entry.payload, artifact: replace(entry.payload.artifact), ...(entry.payload.audioMetadata === undefined ? {} : { audioMetadata: audio(entry.payload.audioMetadata) }) } });
  const rebound: PortableSessionProjection = { format: PROJECTION_FORMAT, messages, artifacts };
  validatePortableSessionProjection(rebound);
  return rebound;
}

/**
 * An export may deliberately exclude media or observe a stale Artifact. Keep
 * the surrounding message while replacing only the unavailable block.
 */
export function omitUnavailablePortableProjectionBlobs(
  projection: PortableSessionProjection,
  availableSourceIds: ReadonlySet<string>
): PortableSessionProjection {
  validatePortableSessionProjection(projection);
  const sourceRefs = collectPortableProjectionBlobRefs(projection);
  const audio = (value: AudioArtifactMetadata): AudioArtifactMetadata => {
    if (value.artwork === undefined || availableSourceIds.has(value.artwork.blob.id)) return value;
    const { artwork: _artwork, ...retained } = value;
    return retained;
  };
  const messages = projection.messages.map((message): PortableProjectedMessage => ({
    ...message,
    ...(message.acceptedInput === undefined ? {} : {
      acceptedInput: omitAcceptedInputBlobs(message.acceptedInput, sourceRefs, availableSourceIds)
    }),
    blocks: message.blocks.map((block): MessageBlock => {
      if (block.kind !== "image" && block.kind !== "artifact") return block;
      if (availableSourceIds.has(block.blob.id)) return block.kind === "artifact" && block.audioMetadata !== undefined ? { ...block, audioMetadata: audio(block.audioMetadata) } : block;
      const label = block.kind === "image" ? block.alt ?? block.blob.fileName ?? "image" : block.label;
      return { kind: "text", text: `[Unavailable attachment: ${label}]` };
    })
  }));
  const artifacts = projection.artifacts.map((entry): PortableProjectedArtifact => {
    if (entry.payload.type === "status") return entry;
    const value = entry.payload;
    if (!availableSourceIds.has(value.artifact.id)) return { sourceOrder: entry.sourceOrder, emittedAt: entry.emittedAt, payload: { type: "status", key: "artifact_unavailable", text: value.audioMetadata?.title || value.artifact.fileName || value.purpose } };
    return { ...entry, payload: { ...value, ...(value.audioMetadata === undefined ? {} : { audioMetadata: audio(value.audioMetadata) }) } };
  });
  const filtered: PortableSessionProjection = { format: PROJECTION_FORMAT, messages, artifacts };
  validatePortableSessionProjection(filtered);
  return filtered;
}

export function portableProjectionEventPayloads(
  projection: PortableSessionProjection
): readonly { readonly emittedAt: number; readonly payload: EventPayload }[] {
  validatePortableSessionProjection(projection);
  const events: { sourceOrder: number; emittedAt: number; payload: EventPayload }[] = projection.messages.map((message) => ({
    sourceOrder: message.sourceOrder,
    emittedAt: message.emittedAt,
    payload: {
      type: "message_complete",
      role: message.role,
      blocks: message.blocks,
      ...(message.acceptedInput === undefined ? {} : { acceptedInput: message.acceptedInput }),
      ...(message.usage === undefined ? {} : { usage: message.usage }),
      ...(message.generationDurationMs === undefined
        ? {}
        : { generationDurationMs: message.generationDurationMs }),
      ...(message.generationReliable === undefined
        ? {}
        : { generationReliable: message.generationReliable }),
      ...(message.automationOrigin === undefined ? {} : { automationOrigin: message.automationOrigin }),
      ...(message.inputDelivery === undefined ? {} : { inputDelivery: message.inputDelivery })
    }
  }));
  return [...events, ...projection.artifacts].sort((left, right) => left.sourceOrder - right.sourceOrder)
    .map(({ emittedAt, payload }) => ({ emittedAt, payload }));
}

export function validatePortableSessionProjection(value: unknown): asserts value is PortableSessionProjection {
  if (!isRecord(value) || value["format"] !== PROJECTION_FORMAT || !Array.isArray(value["messages"]) || !Array.isArray(value["artifacts"])) {
    throw invalid("Portable Session message history has an unsupported shape.");
  }
  if (value["messages"].length > MAXIMUM_PORTABLE_SESSION_MESSAGES) {
    throw invalid("Portable Session message history has too many messages.");
  }
  for (const rawMessage of value["messages"]) validateMessage(rawMessage);
  assertExactKeys(value, ["format", "messages", "artifacts"], "projection");
  if (value["artifacts"].length > 10_000) throw invalid("Portable Session contains too many Artifacts.");
  for (const entry of value["artifacts"]) {
    if (!isRecord(entry) || !Number.isSafeInteger(entry["emittedAt"]) || Number(entry["emittedAt"]) < 0 || !isRecord(entry["payload"])) throw invalid("Portable Artifact is invalid.");
    assertExactKeys(entry, ["sourceOrder", "emittedAt", "payload"], "Artifact");
    const payload = entry["payload"];
    if (payload["type"] === "status" && payload["key"] === "artifact_unavailable") {
      boundedString(payload["text"], "unavailable Artifact text");
      assertExactKeys(payload, ["type", "key", "text"], "unavailable Artifact");
    } else {
      if (payload["type"] !== "artifact") throw invalid("Portable Artifact type is invalid.");
      validateBlob(payload["artifact"]);
      boundedString(payload["purpose"], "Artifact purpose");
      validateAudio(payload["audioMetadata"], payload["artifact"]);
      assertExactKeys(payload, ["type", "artifact", "purpose", "audioMetadata"], "Artifact payload");
    }
  }
  const sourceOrders = new Set<number>();
  for (const entry of [...value["messages"], ...value["artifacts"]]) {
    const order = entry["sourceOrder"];
    if (!Number.isSafeInteger(order) || order < 0 || sourceOrders.has(order)) throw invalid("Portable Session source order is missing, invalid or duplicated.");
    sourceOrders.add(order);
  }
}

function validateMessage(value: unknown): asserts value is PortableProjectedMessage {
  if (!isRecord(value) || !Number.isSafeInteger(value["emittedAt"]) || Number(value["emittedAt"]) < 0
    || (value["role"] !== "user" && value["role"] !== "assistant") || !Array.isArray(value["blocks"])) {
    throw invalid("Portable Session message history contains an invalid message.");
  }
  if (value["blocks"].length > MAX_BLOCKS_PER_MESSAGE) throw invalid("Portable Session message contains too many blocks.");
  for (const block of value["blocks"]) validateBlock(block);
  if (value["acceptedInput"] !== undefined) {
    if (value["role"] !== "user") throw invalid("Portable Session accepted input requires a user message.");
    validateAcceptedInput(value["acceptedInput"]);
  }
  if (value["usage"] !== undefined) validateMessageUsage(value["usage"]);
  validateMessageGenerationTiming(value);
  if (value["inputDelivery"] !== undefined
    && !["prompt", "steer", "follow_up", "scheduler"].includes(String(value["inputDelivery"]))) {
    throw invalid("Portable Session input delivery metadata is invalid.");
  }
  if (value["automationOrigin"] !== undefined) validateAutomationOrigin(value["automationOrigin"]);
  assertExactKeys(value, [
    "sourceOrder",
    "emittedAt",
    "role",
    "blocks",
    "acceptedInput",
    "usage",
    "generationDurationMs",
    "generationReliable",
    "automationOrigin",
    "inputDelivery"
  ], "message");
}

function validateMessageGenerationTiming(value: Readonly<Record<string, unknown>>): void {
  const duration = value["generationDurationMs"];
  const reliable = value["generationReliable"];
  if (duration === undefined && reliable === undefined) return;
  if (value["role"] !== "assistant") {
    throw invalid("Portable Session user messages cannot contain model generation timing.");
  }
  if (reliable !== undefined && typeof reliable !== "boolean") {
    throw invalid("Portable Session message generation timing is invalid.");
  }
  if (duration !== undefined && (!Number.isSafeInteger(duration) || Number(duration) <= 0)) {
    throw invalid("Portable Session message generation timing is invalid.");
  }
  if (reliable === true && duration === undefined) {
    throw invalid("Portable Session reliable generation timing requires a duration.");
  }
  if (duration !== undefined && reliable !== true) {
    throw invalid("Portable Session generation duration must be explicitly reliable.");
  }
}

function validateMessageUsage(value: unknown): void {
  if (!isRecord(value)) throw invalid("Portable Session message usage is invalid.");
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) {
      throw invalid("Portable Session message usage is invalid.");
    }
  }
  for (const key of ["contextTokens", "contextWindow"] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) {
      throw invalid("Portable Session message usage is invalid.");
    }
  }
  if (typeof value["cost"] !== "number" || !Number.isFinite(value["cost"]) || value["cost"] < 0) {
    throw invalid("Portable Session message usage is invalid.");
  }
  assertExactKeys(value, [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
    "contextTokens",
    "contextWindow",
    "cost"
  ], "message usage");
}

function validateAcceptedInput(value: unknown): asserts value is PromptInput {
  if (!isRecord(value)
    || typeof value["text"] !== "string"
    || !Array.isArray(value["images"])
    || !Array.isArray(value["files"])
    || !Array.isArray(value["mentions"])
    || (value["disposition"] !== "prompt" && value["disposition"] !== "steer" && value["disposition"] !== "follow_up")) {
    throw invalid("Portable Session accepted input is invalid.");
  }
  boundedString(value["text"], "accepted input text");
  if (value["images"].length + value["files"].length + value["mentions"].length > MAX_BLOCKS_PER_MESSAGE) {
    throw invalid("Portable Session accepted input contains too many parts.");
  }
  for (const image of value["images"]) validateImageInput(image);
  for (const file of value["files"]) validateFileInput(file);
  for (const mention of value["mentions"]) validateMentionInput(mention);
  if (value["quotesEncoded"] !== undefined && typeof value["quotesEncoded"] !== "boolean") {
    throw invalid("Portable Session quote metadata is invalid.");
  }
  validatePastedTextRanges(value["pastedTextRanges"], value["text"]);
  validateMentionRanges(
    value["mentionRanges"],
    value["text"],
    value["mentions"] as readonly MentionInput[],
    value["pastedTextRanges"] as readonly InlineTextRange[] | undefined
  );
  assertExactKeys(value, [
    "text",
    "images",
    "files",
    "mentions",
    "disposition",
    "quotesEncoded",
    "pastedTextRanges",
    "mentionRanges"
  ], "accepted input");
}

function validateImageInput(value: unknown): void {
  if (!isRecord(value)) throw invalid("Portable Session image input is invalid.");
  validateBlob(value["blob"]);
  if (value["alt"] !== undefined) boundedString(value["alt"], "image input alternative text");
  assertExactKeys(value, ["blob", "alt"], "image input");
}

function validateFileInput(value: unknown): void {
  if (!isRecord(value)) throw invalid("Portable Session file input is invalid.");
  validateBlob(value["blob"]);
  if (value["workspacePath"] !== undefined) boundedString(value["workspacePath"], "file input workspace path");
  assertExactKeys(value, ["blob", "workspacePath"], "file input");
}

function validateMentionInput(value: unknown): asserts value is MentionInput {
  if (!isRecord(value)
    || (value["kind"] !== "workspace_file" && value["kind"] !== "workspace_directory"
      && value["kind"] !== "resource" && value["kind"] !== "artifact")) {
    throw invalid("Portable Session mention input is invalid.");
  }
  boundedString(value["label"], "mention label", 4_096);
  boundedString(value["reference"], "mention reference", 4_096);
  if (value["kind"] === "workspace_file" || value["kind"] === "workspace_directory") {
    boundedNonEmptyString(value["workspaceId"], "mention workspace ID", 4_096);
  }
  if (value["kind"] === "workspace_file") {
    if (value["lineRange"] !== undefined) validateWorkspaceLineRange(value["lineRange"]);
    assertExactKeys(value, ["kind", "label", "reference", "workspaceId", "lineRange"], "workspace file mention");
    return;
  }
  if (value["kind"] === "workspace_directory") {
    assertExactKeys(value, ["kind", "label", "reference", "workspaceId"], "workspace directory mention");
    return;
  }
  if (value["kind"] === "resource") {
    boundedNonEmptyString(value["discoveredRevision"], "resource mention discovered revision", 4_096);
    if (value["reference"] !== value["reference"].trim()
      || value["discoveredRevision"] !== value["discoveredRevision"].trim()
      || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value["reference"])
      || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value["discoveredRevision"])) {
      throw invalid("Portable Session resource mention identity is invalid.");
    }
    if (typeof value["resourceVersion"] !== "string"
      || value["resourceVersion"].length > 20
      || !/^[1-9][0-9]*$/u.test(value["resourceVersion"])
      || BigInt(value["resourceVersion"]) > 18_446_744_073_709_551_615n) {
      throw invalid("Portable Session resource mention entity revision is invalid.");
    }
    if (!Number.isSafeInteger(value["runtimeGeneration"]) || Number(value["runtimeGeneration"]) < 1) {
      throw invalid("Portable Session resource mention runtime generation is invalid.");
    }
    assertExactKeys(
      value,
      ["kind", "label", "reference", "discoveredRevision", "resourceVersion", "runtimeGeneration"],
      "resource mention"
    );
    return;
  }
  boundedNonEmptyString(value["reference"], "artifact mention identity", 1_024);
  boundedNonEmptyString(value["sourceSessionId"], "artifact mention source Session ID", 1_024);
  if (value["reference"] !== value["reference"].trim()
    || value["sourceSessionId"] !== value["sourceSessionId"].trim()
    || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value["reference"])
    || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value["sourceSessionId"])) {
    throw invalid("Portable Session Artifact mention identity is invalid.");
  }
  assertExactKeys(value, ["kind", "label", "reference", "sourceSessionId"], "artifact mention");
}

function validateWorkspaceLineRange(value: unknown): void {
  if (!isRecord(value)
    || !Number.isSafeInteger(value["startLine"])
    || !Number.isSafeInteger(value["endLine"])
    || Number(value["startLine"]) <= 0
    || Number(value["endLine"]) < Number(value["startLine"])) {
    throw invalid("Portable Session workspace mention line range is invalid.");
  }
  assertExactKeys(value, ["startLine", "endLine"], "workspace mention line range");
}

function validateMentionRanges(
  value: unknown,
  text: string,
  mentions: readonly MentionInput[],
  pastedTextRanges: readonly InlineTextRange[] | undefined
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw invalid("Portable Session mention range metadata is invalid.");
  const ranges: InputMentionRange[] = [];
  for (const rawRange of value) {
    if (!isRecord(rawRange)
      || !Number.isSafeInteger(rawRange["start"])
      || !Number.isSafeInteger(rawRange["end"])
      || !Number.isSafeInteger(rawRange["mentionIndex"])) {
      throw invalid("Portable Session mention range is invalid.");
    }
    assertExactKeys(rawRange, ["start", "end", "mentionIndex"], "mention range");
    ranges.push({
      start: Number(rawRange["start"]),
      end: Number(rawRange["end"]),
      mentionIndex: Number(rawRange["mentionIndex"])
    });
  }
  if (!validInputMentionRanges(text, mentions, ranges, pastedTextRanges ?? [])) {
    throw invalid("Portable Session mention ranges do not match the accepted input.");
  }
}

function rebindAcceptedInput(
  input: PromptInput,
  sourceRefs: ReadonlyMap<string, BlobRef>,
  replacements: ReadonlyMap<string, BlobRef>,
  replace: (blob: BlobRef) => BlobRef
): PromptInput {
  return projectAcceptedInputMentions({
    ...input,
    images: input.images.map((image) => ({ ...image, blob: replace(image.blob) })),
    files: input.files.map((file) => ({ blob: replace(file.blob) }))
  }, (mention) => {
    if (mention.kind !== "artifact") return undefined;
    const source = sourceRefs.get(mention.reference);
    const replacement = replacements.get(mention.reference);
    if (source === undefined || replacement === undefined || !sameBlobContent(source, replacement)) return undefined;
    return { ...mention, reference: replacement.id };
  });
}

function omitAcceptedInputBlobs(
  input: PromptInput,
  sourceRefs: ReadonlyMap<string, BlobRef>,
  availableSourceIds: ReadonlySet<string>
): PromptInput {
  return projectAcceptedInputMentions({
    ...input,
    images: input.images.filter((image) => availableSourceIds.has(image.blob.id)),
    files: input.files.filter((file) => availableSourceIds.has(file.blob.id))
  }, (mention) => mention.kind === "session"
    ? undefined
    : mention.kind !== "artifact" || sourceRefs.has(mention.reference) && availableSourceIds.has(mention.reference)
      ? mention
      : undefined);
}

function projectAcceptedInputMentions(
  input: PromptInput,
  project: (mention: MentionInput) => MentionInput | undefined
): PromptInput {
  const mentions: MentionInput[] = [];
  const replacementIndexes = new Map<number, number>();
  for (const [index, mention] of input.mentions.entries()) {
    const projected = project(mention);
    if (projected === undefined) continue;
    replacementIndexes.set(index, mentions.length);
    mentions.push(projected);
  }
  const mentionRanges = input.mentionRanges?.flatMap((range): InputMentionRange[] => {
    const mentionIndex = replacementIndexes.get(range.mentionIndex);
    return mentionIndex === undefined ? [] : [{ ...range, mentionIndex }];
  });
  const {
    sessionReferenceSnapshots: _sessionReferenceSnapshots,
    artifactReferenceSnapshots: _artifactReferenceSnapshots,
    ...portableInput
  } = input;
  return {
    ...portableInput,
    mentions,
    ...(mentionRanges === undefined ? {} : { mentionRanges })
  };
}

function validatePastedTextRanges(value: unknown, text: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw invalid("Portable Session pasted-text metadata is invalid.");
  const ranges: InlineTextRange[] = [];
  for (const rawRange of value) {
    if (!isRecord(rawRange)
      || !Number.isSafeInteger(rawRange["start"])
      || !Number.isSafeInteger(rawRange["end"])) {
      throw invalid("Portable Session pasted-text range is invalid.");
    }
    boundedString(rawRange["display"], "pasted-text display", 2_000);
    assertExactKeys(rawRange, ["start", "end", "display"], "pasted-text range");
    ranges.push({
      start: Number(rawRange["start"]),
      end: Number(rawRange["end"]),
      display: rawRange["display"]
    });
  }
  if (!validInlineTextRanges(text, ranges)) {
    throw invalid("Portable Session pasted-text ranges do not match the message text.");
  }
}

function validateBlock(value: unknown): asserts value is MessageBlock {
  if (!isRecord(value) || typeof value["kind"] !== "string") throw invalid("Portable Session message block is invalid.");
  switch (value["kind"]) {
    case "text":
      boundedString(value["text"], "text block");
      assertExactKeys(value, ["kind", "text"], "text block");
      return;
    case "thinking":
      boundedString(value["text"], "thinking block");
      if (typeof value["redacted"] !== "boolean") throw invalid("Portable Session thinking block is invalid.");
      assertExactKeys(value, ["kind", "text", "redacted"], "thinking block");
      return;
    case "image":
      validateBlob(value["blob"]);
      if (value["alt"] !== undefined) boundedString(value["alt"], "image alternative text");
      assertExactKeys(value, ["kind", "blob", "alt"], "image block");
      return;
    case "artifact":
      validateBlob(value["blob"]);
      boundedString(value["label"], "artifact label");
      validateAudio(value["audioMetadata"], value["blob"]);
      assertExactKeys(value, ["kind", "blob", "label", "audioMetadata"], "artifact block");
      return;
    case "tool_call":
      boundedString(value["callId"], "tool call ID", 4_096);
      boundedString(value["name"], "tool name", 4_096);
      boundedString(value["input"], "tool input");
      assertExactKeys(value, ["kind", "callId", "name", "input"], "tool call block");
      return;
    case "tool_result":
      boundedString(value["callId"], "tool result call ID", 4_096);
      boundedString(value["output"], "tool output");
      if (typeof value["isError"] !== "boolean") throw invalid("Portable Session tool result block is invalid.");
      assertExactKeys(value, ["kind", "callId", "output", "isError"], "tool result block");
      return;
    default:
      throw invalid("Portable Session message block kind is unsupported.");
  }
}

function validateAudio(audio: unknown, blob: BlobRef): void {
  if (audio === undefined) return;
  try { assertAudioArtifactMetadata(audio); } catch { throw invalid("Portable audio metadata is invalid."); }
  if (!blob.mimeType.startsWith("audio/")) throw invalid("Portable audio metadata requires an audio Artifact.");
}

function validateBlob(value: unknown): asserts value is BlobRef {
  if (!isRecord(value)) throw invalid("Portable Session Blob reference is invalid.");
  boundedString(value["id"], "Blob ID", 4_096);
  if (typeof value["sha256"] !== "string" || !SHA256_PATTERN.test(value["sha256"])) {
    throw invalid("Portable Session Blob digest is invalid.");
  }
  if (!Number.isSafeInteger(value["byteLength"]) || Number(value["byteLength"]) < 0) {
    throw invalid("Portable Session Blob length is invalid.");
  }
  boundedString(value["mimeType"], "Blob media type", 1_024);
  if (value["fileName"] !== undefined) boundedString(value["fileName"], "Blob file name", 4_096);
  assertExactKeys(value, ["id", "sha256", "byteLength", "mimeType", "fileName"], "Blob reference");
}

function validateAutomationOrigin(value: unknown): void {
  if (!isRecord(value) || value["kind"] !== "scheduler") throw invalid("Portable Session automation origin is invalid.");
  boundedString(value["scheduleId"], "Schedule ID", 4_096);
  if (value["scheduleName"] !== undefined) boundedString(value["scheduleName"], "Schedule name", 4_096);
  if (value["runId"] !== undefined) boundedString(value["runId"], "Run ID", 4_096);
  assertExactKeys(value, ["kind", "scheduleId", "scheduleName", "runId"], "automation origin");
}

function boundedString(value: unknown, label: string, maximumBytes = MAX_STRING_BYTES): asserts value is string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw invalid(`Portable Session ${label} is invalid.`);
  }
}

function boundedNonEmptyString(value: unknown, label: string, maximumBytes = MAX_STRING_BYTES): asserts value is string {
  boundedString(value, label, maximumBytes);
  if (value.trim().length === 0) throw invalid(`Portable Session ${label} is invalid.`);
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const names = new Set(allowed);
  if (Object.keys(value).some((key) => !names.has(key))) throw invalid(`Portable Session ${label} has unsupported fields.`);
}

function sameBlob(left: BlobRef, right: BlobRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256 && left.byteLength === right.byteLength
    && left.mimeType === right.mimeType && left.fileName === right.fileName;
}

function sameBlobContent(left: BlobRef, right: BlobRef): boolean {
  return left.sha256 === right.sha256 && left.byteLength === right.byteLength && left.mimeType === right.mimeType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): PortableSessionProjectionError {
  return new PortableSessionProjectionError(message);
}

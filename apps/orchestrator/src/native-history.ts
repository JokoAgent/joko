import { createHash } from "node:crypto";

import type {
  AdapterEventMetadata,
  BlobRef,
  EventPayload,
  NativeSessionBinding,
  NativeHistoryProjection as AdapterNativeHistoryProjection
} from "@joko/core";
import {
  NATIVE_HISTORY_ASSISTANT_SOURCE_FIELD,
  NATIVE_HISTORY_ASSISTANT_STREAM_FIELD,
  NATIVE_HISTORY_ASSISTANT_TOOL_RESULT_FIELD,
  NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD,
  NATIVE_HISTORY_LEGACY_REWIND_ANCHORS_FIELD,
  NATIVE_HISTORY_OBSERVED_ASSISTANT_FIELD,
  NATIVE_HISTORY_USER_IMAGES_FIELD,
  isNativeNavigationTarget,
  nativeHistoryEventContext,
  withNativeHistoryEventContext
} from "@joko/core";
import type { PersistedEvent, QueueItemRecord } from "@joko/store";

import { nativeBindingFingerprint } from "./native-state-observation.js";

export { NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD } from "@joko/core";

export interface NativeHistoryEventProjection {
  readonly id: string;
  readonly emittedAt?: number;
  readonly payload: EventPayload;
  readonly pi?: NonNullable<AdapterEventMetadata["pi"]>;
  readonly metadata?: {
    readonly namespace: string;
    readonly fields: Readonly<Record<string, string | number | boolean>>;
  };
  readonly observedMetadataFields?: readonly string[];
}

/**
 * Assign durable product event IDs to a Backend-owned native-history
 * projection. Orchestrator deliberately treats all native identities and payloads as
 * opaque: interpreting a Backend's persistence taxonomy belongs to its Adapter.
 */
export function projectNativeHistory(
  sessionId: string,
  nativeReference: string,
  history: AdapterNativeHistoryProjection
): readonly NativeHistoryEventProjection[] {
  const bindingFingerprint = nativeBindingFingerprint(nativeReference);
  const seen = new Set<string>();
  return history.events.map((event) => {
    const nativeEntryId = boundedIdentity(event.nativeEntryId, "entry", 4_096);
    const nativeParentEntryId = event.nativeParentEntryId === undefined
      ? undefined
      : boundedIdentity(event.nativeParentEntryId, "parent entry", 4_096);
    if (event.nativeRewindBefore !== undefined && !isNativeNavigationTarget(event.nativeRewindBefore)) {
      throw new Error("Native history projection contains an invalid rewind target.");
    }
    const projectionKind = boundedIdentity(event.projectionKind, "projection kind", 256);
    if (!Number.isSafeInteger(event.contentIndex) || event.contentIndex < 0) {
      throw new Error("Native history projection contains an invalid content index.");
    }
    if (event.emittedAt !== undefined && (!Number.isSafeInteger(event.emittedAt) || event.emittedAt < 0)) {
      throw new Error("Native history projection contains an invalid timestamp.");
    }
    const projectionIdentity = `${nativeEntryId}\0${projectionKind}\0${event.contentIndex}`;
    if (seen.has(projectionIdentity)) {
      throw new Error(`Native history contains duplicate projection identity '${nativeEntryId}/${projectionKind}/${event.contentIndex}'.`);
    }
    seen.add(projectionIdentity);
    const adapterMetadata = event.metadata;
    const observedMetadataFields = event.observedMetadataFields;
    if (observedMetadataFields !== undefined && (observedMetadataFields.length > 16
      || new Set(observedMetadataFields).size !== observedMetadataFields.length
      || observedMetadataFields.some(field => boundedIdentity(field, "observed metadata field", 256) === NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD
        || adapterMetadata === undefined || !Object.hasOwn(adapterMetadata.fields, field)))) {
      throw new Error("Native history projection contains invalid observed metadata fields.");
    }
    const payload = withNativeHistoryEventContext(event.payload, {
      identity: {
        entryId: nativeEntryId,
        ...(nativeParentEntryId === undefined ? {} : { parentEntryId: nativeParentEntryId }),
        ...(event.nativeRewindBefore === undefined ? {} : { rewindBefore: event.nativeRewindBefore })
      }
    });
    return {
      id: deterministicNativeEventId(
        sessionId,
        bindingFingerprint,
        nativeEntryId,
        projectionKind,
        event.contentIndex
      ),
      ...(event.emittedAt === undefined ? {} : { emittedAt: event.emittedAt }),
      ...(observedMetadataFields === undefined ? {} : { observedMetadataFields }),
      payload,
      ...(adapterMetadata?.pi === undefined ? {} : { pi: adapterMetadata.pi }),
      metadata: nativeHistoryBindingMetadata(bindingFingerprint, adapterMetadata)
    };
  });
}

/** Preserve the first observation without relaxing the Store's immutable event comparison. */
export function nativeHistoryReplayMetadata(
  projection: NativeHistoryEventProjection,
  recorded: NativeHistoryEventProjection["metadata"]
): NativeHistoryEventProjection["metadata"] {
  const metadata = projection.metadata;
  if (metadata === undefined || recorded?.namespace !== metadata.namespace || projection.observedMetadataFields === undefined) return metadata;
  const observed = new Set(projection.observedMetadataFields);
  return { ...metadata, fields: Object.fromEntries(Object.entries(metadata.fields).map(([field, value]) => [field,
    observed.has(field) && Object.hasOwn(recorded.fields, field) && typeof recorded.fields[field] === typeof value
      ? recorded.fields[field]! : value
  ])) };
}

function observedCodexMarker(binding: NativeSessionBinding, marker: PersistedEvent | undefined): PersistedEvent | undefined {
  if (marker?.payload.type !== "native_session_changed" || marker.payload.opaqueRef !== binding.opaqueRef
    || marker.payload.nativeSessionId !== binding.nativeSessionId || marker.generation > binding.generation
    || marker.metadata?.namespace !== "codex.native_history") return undefined;
  return marker;
}

export function observedNativeUserImages(binding: NativeSessionBinding, candidate: PersistedEvent | undefined):
  readonly (readonly [entryId: string, blockIndex: number, blob: BlobRef])[] {
  const encoded = observedCodexMarker(binding, candidate)?.metadata?.fields[NATIVE_HISTORY_USER_IMAGES_FIELD];
  const values = parseObservedEntries(encoded);
  return values.filter((value): value is [string, number, BlobRef] => {
    if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== "string" || value[0].length === 0
      || !Number.isSafeInteger(value[1]) || value[1] < 0) return false;
    const blob: unknown = value[2];
    if (typeof blob !== "object" || blob === null) return false;
    const record = blob as Record<string, unknown>;
    return typeof record["id"] === "string" && record["id"].length > 0
      && typeof record["sha256"] === "string" && /^[0-9a-f]{64}$/u.test(record["sha256"])
      && typeof record["byteLength"] === "number" && Number.isSafeInteger(record["byteLength"]) && record["byteLength"] > 0
      && record["mimeType"] === "image/png" && typeof record["fileName"] === "string";
  });
}

function parseObservedEntries(encoded: string | number | boolean | undefined): readonly unknown[] {
  if (typeof encoded !== "string") return [];
  try {
    const values: unknown = JSON.parse(encoded);
    return Array.isArray(values) ? values : [];
  } catch { return []; }
}

/** Present current native observations through the immutable original User Event. */
export function withObservedNativeUserPresentation(event: PersistedEvent, binding: NativeSessionBinding | undefined,
  findMarker: () => PersistedEvent | undefined): PersistedEvent {
  const payload = event.payload;
  if (payload.type !== "message_complete" || payload.role !== "user" || binding === undefined
    || event.generation > binding.generation || event.metadata?.namespace !== "codex.native_history"
    || event.metadata.fields["nativeHydration"] !== true) return event;
  const identity = payload.nativeHistory?.identity;
  if (identity === undefined) return event;
  const marker = observedCodexMarker(binding, findMarker());
  if (marker === undefined || marker.sessionId !== event.sessionId || marker.generation < event.generation
    || marker.backendId !== event.backendId || marker.targetId !== event.targetId || marker.globalCursor < event.globalCursor
    || event.metadata.fields[NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD] !== nativeBindingFingerprint(binding.opaqueRef)) return event;
  const rewindBefore = identity.rewindBefore === undefined && identity.parentEntryId !== undefined
    && parseObservedEntries(marker.metadata?.fields[NATIVE_HISTORY_LEGACY_REWIND_ANCHORS_FIELD]).some((anchor) =>
      Array.isArray(anchor) && anchor.length === 2 && anchor[0] === identity.entryId && anchor[1] === identity.parentEntryId)
    ? { kind: "native_entry" as const, entryId: identity.parentEntryId } : undefined;
  const images = new Map<number, BlobRef>();
  if (event.runId === undefined && payload.acceptedInput === undefined && payload.partnerPrivateOrigin === undefined) {
    for (const [entryId, blockIndex, blob] of observedNativeUserImages(binding, marker)) {
      if (entryId === identity.entryId) images.set(blockIndex, blob);
    }
  }
  if (rewindBefore === undefined && images.size === 0) return event;
  return { ...event, payload: { ...payload,
    ...(rewindBefore === undefined ? {} : { nativeHistory: { ...payload.nativeHistory, identity: { ...identity, rewindBefore } } }),
    ...(images.size === 0 ? {} : { blocks: payload.blocks.map((block, blockIndex) => {
      const blob = images.get(blockIndex);
      return blob !== undefined && block.kind === "text" && block.text === "[Image input]" ? { kind: "image" as const, blob } : block;
    }) })
  } };
}

export function observedClaudeAssistantInputEntry(
  projection: NativeHistoryEventProjection,
  source: PersistedEvent,
  earlierEntries: ReadonlyMap<string, EventPayload>
): string | undefined {
  const parentId = nativeHistoryEventContext(projection.payload)?.identity?.parentEntryId;
  const observedResult = source.metadata?.fields[NATIVE_HISTORY_ASSISTANT_TOOL_RESULT_FIELD];
  if (observedResult === undefined) return parentId;
  if (parentId === undefined || parentId !== observedResult) return undefined;
  const result = earlierEntries.get(parentId);
  if (result?.type !== "tool_result" || result.isError) return undefined;
  const callEntryId = result.nativeHistory?.identity?.parentEntryId;
  const call = callEntryId === undefined ? undefined : earlierEntries.get(callEntryId);
  if (call?.type !== "message_complete" || call.role !== "assistant" || call.blocks.length !== 1
    || call.blocks[0]?.kind !== "tool_call" || call.blocks[0].callId !== result.callId || call.blocks[0].name !== result.name) return undefined;
  const precedingTextId = call.nativeHistory?.identity?.parentEntryId;
  const precedingText = precedingTextId === undefined ? undefined : earlierEntries.get(precedingTextId);
  return precedingText?.type === "message_complete" && precedingText.role === "assistant"
    && precedingText.blocks.length === 1 && precedingText.blocks[0]?.kind === "text"
    ? precedingText.nativeHistory?.identity?.parentEntryId : undefined;
}

/** Carry the live Run facts only when the SDK frame and its original input both
 * appear in the persistence-confirmed native projection. */
export function adoptObservedNativeAssistant(
  projection: NativeHistoryEventProjection,
  source: PersistedEvent,
  input: QueueItemRecord | undefined,
  bindingFingerprint: string
) {
  const { payload, metadata } = projection;
  const sourceFields = source.metadata?.fields;
  const streamId = sourceFields?.[NATIVE_HISTORY_ASSISTANT_STREAM_FIELD];
  if (metadata?.namespace !== "claude-code.native_history" || metadata.fields["nativeHydration"] !== true
    || payload.type !== "message_complete" || payload.role !== "assistant" || payload.blocks.length !== 1
    || source.metadata?.namespace !== "claude-code" || sourceFields?.[NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD] !== bindingFingerprint
    || payload.nativeHistory?.identity?.entryId !== sourceFields?.[NATIVE_HISTORY_OBSERVED_ASSISTANT_FIELD]
    || typeof streamId !== "string" || !/^claude-block-[0-9a-f-]{36}-\d+-\d+$/u.test(streamId)
    || source.payload.type !== "message_complete" || source.payload.role !== "assistant" || source.payload.blocks.length !== 1
    || source.payload.turnUsage !== undefined || source.payload.partnerPrivateOrigin !== undefined
    || input === undefined || input.disposition !== "prompt" || input.sessionId !== source.sessionId
    || source.runId === undefined || source.runId !== input.runId || source.operationId === undefined || source.operationId !== input.operationId
    || source.attemptId === undefined || source.attemptId !== input.attemptId) return undefined;
  const block = payload.blocks[0], observed = source.payload.blocks[0];
  if (block?.kind !== "text" || observed?.kind !== "text" || block.text !== observed.text) return undefined;
  const { usage, usageIsEstimate, modelSubstitution, generationDurationMs, generationReliable } = source.payload;
  return {
    payload: {
      ...payload,
      ...(usage == null ? {} : { usage }),
      ...(usageIsEstimate == null ? {} : { usageIsEstimate }),
      ...(modelSubstitution == null ? {} : { modelSubstitution }),
      ...(generationDurationMs == null ? {} : { generationDurationMs }),
      ...(generationReliable == null ? {} : { generationReliable })
    },
    metadata: { ...metadata, fields: { ...metadata.fields,
      [NATIVE_HISTORY_ASSISTANT_SOURCE_FIELD]: source.id,
      [NATIVE_HISTORY_ASSISTANT_STREAM_FIELD]: streamId
    } },
    runId: source.runId,
    attemptId: source.attemptId,
    operationId: source.operationId,
    emittedAt: source.emittedAt
  };
}

export function bindNativeHistoryEventMetadata(
  payload: EventPayload,
  nativeReference: string | undefined,
  metadata: AdapterEventMetadata | undefined
): AdapterEventMetadata | undefined {
  if (nativeReference === undefined || nativeHistoryEventContext(payload) === undefined) return metadata;
  return {
    ...nativeHistoryBindingMetadata(nativeBindingFingerprint(nativeReference), metadata),
    ...(metadata?.pi === undefined ? {} : { pi: metadata.pi })
  };
}

export function deterministicNativeEventId(
  sessionId: string,
  bindingFingerprint: string,
  entryId: string,
  projectionKind: string,
  contentIndex: number
): string {
  const digest = createHash("sha256")
    .update(sessionId).update("\0")
    .update(bindingFingerprint).update("\0")
    .update(entryId).update("\0")
    .update(projectionKind).update("\0")
    .update(String(contentIndex))
    .digest("hex");
  return `native-event-${digest}`;
}

function nativeHistoryBindingMetadata(
  bindingFingerprint: string,
  metadata: AdapterEventMetadata | undefined
): Pick<AdapterEventMetadata, "namespace" | "fields"> {
  return {
    namespace: metadata?.namespace ?? "joko.native_history",
    fields: {
      ...metadata?.fields,
      [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: bindingFingerprint
    }
  };
}

function boundedIdentity(value: string, label: string, maximumLength: number): string {
  if (value.trim() === "" || value.length > maximumLength || value.includes("\0")) {
    throw new Error(`Native history projection contains an invalid ${label} identity.`);
  }
  return value;
}

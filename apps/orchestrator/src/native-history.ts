import { createHash } from "node:crypto";

import type {
  AdapterEventMetadata,
  EventPayload,
  NativeHistoryProjection as AdapterNativeHistoryProjection
} from "@joko/core";
import {
  NATIVE_HISTORY_ASSISTANT_SOURCE_FIELD,
  NATIVE_HISTORY_ASSISTANT_STREAM_FIELD,
  NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD,
  NATIVE_HISTORY_OBSERVED_ASSISTANT_FIELD,
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

import { createHash } from "node:crypto";

import type {
  AdapterEventMetadata,
  EventPayload,
  NativeHistoryProjection as AdapterNativeHistoryProjection
} from "@joko/core";
import {
  NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD,
  nativeHistoryEventContext,
  withNativeHistoryEventContext
} from "@joko/core";

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
    const payload = withNativeHistoryEventContext(event.payload, {
      identity: {
        entryId: nativeEntryId,
        ...(nativeParentEntryId === undefined ? {} : { parentEntryId: nativeParentEntryId })
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
      payload,
      ...(adapterMetadata?.pi === undefined ? {} : { pi: adapterMetadata.pi }),
      metadata: nativeHistoryBindingMetadata(bindingFingerprint, adapterMetadata)
    };
  });
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

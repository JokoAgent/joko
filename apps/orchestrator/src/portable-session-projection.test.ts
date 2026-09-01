import { describe, expect, it } from "vitest";
import type { PersistedEvent } from "@joko/store";
import {
  MAXIMUM_PORTABLE_SESSION_MESSAGES,
  PortableSessionProjectionError,
  collectPortableProjectionBlobRefs,
  decodePortableSessionProjection,
  encodePortableSessionProjection,
  omitUnavailablePortableProjectionBlobs,
  portableProjectionEventPayloads,
  projectPortableSessionMessages,
  rebindPortableProjectionBlobs
} from "./portable-session-projection.js";

const sourceBlob = {
  id: "source-blob",
  sha256: "a".repeat(64),
  byteLength: 3,
  mimeType: "image/png",
  fileName: "image.png"
} as const;

function event(overrides: Partial<PersistedEvent> = {}): PersistedEvent {
  return {
    id: "event-1",
    globalCursor: 1n,
    sequence: 1n,
    revision: 1n,
    emittedAt: 123,
    backendId: "backend",
    targetId: "target",
    sessionId: "session",
    generation: 1,
    traceId: "trace",
    payload: {
      type: "message_complete",
      role: "assistant",
      blocks: [
        { kind: "text", text: "hello" },
        { kind: "image", blob: sourceBlob, alt: "preview" }
      ]
    },
    ...overrides
  };
}

describe("portable Session message projection", () => {
  it("accepts exactly the format message limit and rejects the 100001st message", { timeout: 20_000 }, () => {
    const source = event();
    const exact = Array<PersistedEvent>(MAXIMUM_PORTABLE_SESSION_MESSAGES).fill(source);
    expect(projectPortableSessionMessages(exact).messages).toHaveLength(MAXIMUM_PORTABLE_SESSION_MESSAGES);
    expect(() => projectPortableSessionMessages([...exact, source])).toThrowError(PortableSessionProjectionError);
  });

  it("retains only completed messages and round-trips strict UTF-8 JSON", () => {
    const projection = projectPortableSessionMessages([
      event({ payload: { type: "status", key: "working" } }),
      event()
    ]);
    expect(projection.messages).toHaveLength(1);
    expect(decodePortableSessionProjection(encodePortableSessionProjection(projection))).toEqual(projection);
    expect(portableProjectionEventPayloads(projection)).toEqual([{
      emittedAt: 123,
      payload: event().payload
    }]);
  });

  it("round-trips ordered pasted-text UTF-16 ranges and rejects unsafe metadata", () => {
    const source = event({
      payload: {
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: "A😀pasteZ" }],
        pastedTextRanges: [{ start: 3, end: 8, display: "Pasted text (1 line)" }]
      }
    });
    const projection = projectPortableSessionMessages([source]);
    expect(decodePortableSessionProjection(encodePortableSessionProjection(projection))).toEqual(projection);
    expect(portableProjectionEventPayloads(projection)[0]?.payload).toEqual(source.payload);

    expect(() => decodePortableSessionProjection(Buffer.from(JSON.stringify({
      ...projection,
      messages: [{ ...projection.messages[0], pastedTextRanges: [{ start: 1, end: 2, display: "split" }] }]
    })))).toThrowError(PortableSessionProjectionError);
    expect(() => decodePortableSessionProjection(Buffer.from(JSON.stringify({
      ...projection,
      messages: [{ ...projection.messages[0], pastedTextRanges: [
        { start: 3, end: 8, display: "later" },
        { start: 0, end: 1, display: "earlier" }
      ] }]
    })))).toThrowError(PortableSessionProjectionError);
  });

  it("preserves per-message usage and rejects malformed accounting", () => {
    const source = event({
      payload: {
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "answer" }],
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          totalTokens: 23,
          cost: 0.012345
        },
        generationDurationMs: 1_200,
        generationReliable: true
      }
    });
    const projection = projectPortableSessionMessages([source]);
    expect(decodePortableSessionProjection(encodePortableSessionProjection(projection))).toEqual(projection);
    expect(portableProjectionEventPayloads(projection)[0]?.payload).toEqual(source.payload);
    expect(() => decodePortableSessionProjection(Buffer.from(JSON.stringify({
      ...projection,
      messages: [{ ...projection.messages[0], usage: { ...projection.messages[0]?.usage, cost: -1 } }]
    })))).toThrowError(PortableSessionProjectionError);
    expect(() => decodePortableSessionProjection(Buffer.from(JSON.stringify({
      ...projection,
      messages: [{ ...projection.messages[0], generationDurationMs: undefined }]
    })))).toThrowError(PortableSessionProjectionError);
    expect(() => decodePortableSessionProjection(Buffer.from(JSON.stringify({
      ...projection,
      messages: [{ ...projection.messages[0], generationReliable: false }]
    })))).toThrowError(PortableSessionProjectionError);

    const { generationDurationMs: _discardedDuration, ...unreliableMessage } = projection.messages[0]!;
    const unreliable = {
      ...projection,
      messages: [{
        ...unreliableMessage,
        generationReliable: false
      }]
    };
    expect(decodePortableSessionProjection(encodePortableSessionProjection(unreliable))).toEqual(unreliable);
  });

  it("collects and rebinds media without accepting an identity mismatch", () => {
    const projection = projectPortableSessionMessages([event()]);
    expect([...collectPortableProjectionBlobRefs(projection)]).toEqual([[sourceBlob.id, sourceBlob]]);
    const receivedBlob = { ...sourceBlob, id: "received-blob" };
    const rebound = rebindPortableProjectionBlobs(projection, new Map([[sourceBlob.id, receivedBlob]]));
    expect(rebound.messages[0]?.blocks[1]).toEqual({ kind: "image", blob: receivedBlob, alt: "preview" });
    expect(() => rebindPortableProjectionBlobs(projection, new Map([
      [sourceBlob.id, { ...receivedBlob, sha256: "b".repeat(64) }]
    ]))).toThrowError(PortableSessionProjectionError);
  });

  it("keeps messages when media is excluded or unavailable", () => {
    const projection = projectPortableSessionMessages([event()]);
    const filtered = omitUnavailablePortableProjectionBlobs(projection, new Set());
    expect(filtered.messages[0]?.blocks).toEqual([
      { kind: "text", text: "hello" },
      { kind: "text", text: "[Unavailable attachment: preview]" }
    ]);
    expect(collectPortableProjectionBlobRefs(filtered).size).toBe(0);
  });

  it("rejects unsafe extensions, malformed Blobs, invalid delivery metadata, and invalid UTF-8", () => {
    const base = projectPortableSessionMessages([event()]);
    expect(() => decodePortableSessionProjection(Buffer.from(JSON.stringify({
      ...base,
      messages: [{ ...base.messages[0], unexpected: true }]
    })))).toThrowError(PortableSessionProjectionError);
    expect(() => decodePortableSessionProjection(Buffer.from(JSON.stringify({
      ...base,
      messages: [{ ...base.messages[0], blocks: [{ kind: "image", blob: { ...sourceBlob, sha256: "bad" } }] }]
    })))).toThrowError(PortableSessionProjectionError);
    expect(() => decodePortableSessionProjection(Buffer.from(JSON.stringify({
      ...base,
      messages: [{ ...base.messages[0], inputDelivery: "later" }]
    })))).toThrowError(PortableSessionProjectionError);
    expect(() => decodePortableSessionProjection(Uint8Array.from([0xff]))).toThrowError(PortableSessionProjectionError);
  });

  it("detects one package-local Blob ID bound to different content", () => {
    const projection = projectPortableSessionMessages([
      event(),
      event({
        id: "event-2",
        emittedAt: 124,
        payload: {
          type: "message_complete",
          role: "user",
          blocks: [{ kind: "artifact", blob: { ...sourceBlob, sha256: "b".repeat(64) }, label: "other" }]
        }
      })
    ]);
    expect(() => collectPortableProjectionBlobRefs(projection)).toThrowError(PortableSessionProjectionError);
  });
});

import { describe, expect, it } from "vitest";
import type { BlobRef, PromptInput } from "@joko/core";
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

const sourceFile = {
  id: "source-file",
  sha256: "b".repeat(64),
  byteLength: 5,
  mimeType: "text/plain",
  fileName: "notes.txt"
} as const;

const sourceArtifact = {
  id: "source-artifact",
  sha256: "c".repeat(64),
  byteLength: 8,
  mimeType: "application/pdf",
  fileName: "report.pdf"
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

function acceptedInput(): PromptInput {
  const text = "A😀pasteZ @workspace @resource @artifact @artifact @orphan";
  const occurrence = (value: string, from = 0) => {
    const start = text.indexOf(value, from);
    return { start, end: start + value.length };
  };
  const workspace = occurrence("@workspace");
  const resource = occurrence("@resource");
  const firstArtifact = occurrence("@artifact");
  const secondArtifact = occurrence("@artifact", firstArtifact.end);
  const orphan = occurrence("@orphan");
  return {
    text,
    images: [{ blob: sourceBlob, alt: "Input preview" }],
    files: [{ blob: sourceFile, workspacePath: "notes.txt" }],
    mentions: [
      {
        kind: "workspace_file",
        workspaceId: "source-workspace",
        label: "workspace",
        reference: "src/main.ts",
        lineRange: { startLine: 2, endLine: 5 }
      },
      { kind: "resource", label: "resource", reference: "resource-one", discoveredRevision: "revision-one", resourceVersion: "7", runtimeGeneration: 3 },
      {
        kind: "artifact",
        label: "artifact",
        reference: sourceArtifact.id,
        sourceSessionId: "session-source"
      },
      {
        kind: "artifact",
        label: "orphan",
        reference: "unrepresented-artifact",
        sourceSessionId: "session-source"
      }
    ],
    disposition: "steer",
    quotesEncoded: true,
    pastedTextRanges: [{ start: 3, end: 8, display: "Pasted text (1 line)" }],
    mentionRanges: [
      { ...workspace, mentionIndex: 0 },
      { ...resource, mentionIndex: 1 },
      { ...firstArtifact, mentionIndex: 2 },
      { ...secondArtifact, mentionIndex: 2 },
      { ...orphan, mentionIndex: 3 }
    ]
  };
}

function acceptedEvent(): PersistedEvent {
  return event({
    payload: {
      type: "message_complete",
      role: "user",
      blocks: [
        { kind: "text", text: "native expanded input" },
        { kind: "artifact", blob: sourceArtifact, label: "Report" }
      ],
      acceptedInput: acceptedInput(),
      inputDelivery: "steer"
    }
  });
}

describe("portable Session message projection", () => {
  it("retains source order across simultaneous messages, Artifacts and missing-media markers", () => {
    const artifact = event({ payload: { type: "artifact", artifact: sourceBlob, purpose: "preview" } });
    const message = event();
    const projection = projectPortableSessionMessages([artifact, message, artifact]);
    const restored = decodePortableSessionProjection(encodePortableSessionProjection(projection));
    expect(portableProjectionEventPayloads(restored).map((entry) => entry.payload.type)).toEqual(["artifact", "message_complete", "artifact"]);
    const missing = omitUnavailablePortableProjectionBlobs(restored, new Set());
    expect(portableProjectionEventPayloads(missing).map((entry) => entry.payload.type)).toEqual(["status", "message_complete", "status"]);
    for (const sourceOrder of [undefined, -1, 0]) {
      expect(() => decodePortableSessionProjection(Buffer.from(JSON.stringify({ ...restored,
        messages: [{ ...restored.messages[0], sourceOrder }]
      })))).toThrowError(PortableSessionProjectionError);
    }
  });

  it("keeps visible text while stripping historical-task authority from a portable projection", () => {
    const text = "Use @Earlier";
    const projected = projectPortableSessionMessages([event({
      payload: {
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text }],
        acceptedInput: {
          text, images: [], files: [], disposition: "prompt",
          mentions: [{ kind: "session", label: "Earlier", reference: "source-task" }],
          mentionRanges: [{ start: 4, end: 12, mentionIndex: 0 }],
          sessionReferenceSnapshots: [{
            mentionIndex: 0, sessionId: "source-task", throughCursor: "7", sourceGeneration: 1,
            historyBindingFingerprint: `sha256:${"a".repeat(64)}`
          }]
        }
      }
    })]);
    expect(projected.messages[0]?.acceptedInput).toEqual({
      text, images: [], files: [], disposition: "prompt", mentions: [], mentionRanges: []
    });
    expect(() => encodePortableSessionProjection(projected)).not.toThrow();
  });

  it("retains public Artifact source identity while stripping its Queue-private authority", () => {
    const source = acceptedEvent();
    if (source.payload.type !== "message_complete" || source.payload.acceptedInput === undefined) {
      throw new Error("Expected accepted input.");
    }
    const projected = projectPortableSessionMessages([{
      ...source,
      payload: {
        ...source.payload,
        acceptedInput: {
          ...source.payload.acceptedInput,
          artifactReferenceSnapshots: [{
            mentionIndex: 2,
            sourceSessionId: "session-source",
            artifactId: sourceArtifact.id,
            sourceAuthorityFingerprint: `sha256:${"a".repeat(64)}`,
            targetSessionId: "session-target",
            targetAuthorityFingerprint: `sha256:${"b".repeat(64)}`,
            artifactRevision: "4",
            artifactFingerprint: `sha256:${"c".repeat(64)}`
          }]
        }
      }
    }]);
    const accepted = projected.messages[0]?.acceptedInput;
    expect(accepted?.mentions).toContainEqual({
      kind: "artifact",
      label: "artifact",
      reference: sourceArtifact.id,
      sourceSessionId: "session-source"
    });
    expect(accepted).not.toHaveProperty("artifactReferenceSnapshots");
    expect(Buffer.from(encodePortableSessionProjection(projected)).toString("utf8"))
      .not.toContain("sourceAuthorityFingerprint");
  });

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

  it("round-trips the complete accepted input and rejects legacy top-level rendering metadata", () => {
    const source = acceptedEvent();
    const projection = projectPortableSessionMessages([source]);
    expect(decodePortableSessionProjection(encodePortableSessionProjection(projection))).toEqual(projection);
    expect(portableProjectionEventPayloads(projection)[0]?.payload).toEqual(source.payload);

    for (const legacy of [
      { quotesEncoded: true },
      { pastedTextRanges: [{ start: 3, end: 8, display: "legacy" }] }
    ]) {
      expect(() => decodePortableSessionProjection(Buffer.from(JSON.stringify({
        ...projection,
        messages: [{ ...projection.messages[0], ...legacy }]
      })))).toThrowError(PortableSessionProjectionError);
    }
  });

  it("strictly validates every accepted-input part, workspace identity and UTF-16 range", () => {
    const projection = projectPortableSessionMessages([acceptedEvent()]);
    const input = projection.messages[0]!.acceptedInput!;
    const rejects = (candidate: unknown) => expect(() => decodePortableSessionProjection(Buffer.from(JSON.stringify({
      ...projection,
      messages: [{ ...projection.messages[0], acceptedInput: candidate }]
    })))).toThrowError(PortableSessionProjectionError);

    const { files: _files, ...missingRequiredPart } = input;
    rejects(missingRequiredPart);
    rejects({ ...input, unexpected: true });
    rejects({ ...input, images: [{ ...input.images[0], unexpected: true }] });
    rejects({ ...input, files: [{ ...input.files[0], workspacePath: 42 }] });
    rejects({ ...input, mentions: [{ kind: "workspace_file", label: "source", reference: "src/main.ts" }] });
    rejects({ ...input, mentions: [{ kind: "resource", label: "resource", reference: "resource-one" }] });
    rejects({ ...input, mentions: [{ kind: "artifact", label: "artifact", reference: sourceArtifact.id }] });
    rejects({ ...input, mentions: [{
      kind: "artifact", label: "artifact", reference: sourceArtifact.id, sourceSessionId: " session-source"
    }] });
    rejects({ ...input, artifactReferenceSnapshots: [] });
    rejects({ ...input, mentions: [{
      kind: "workspace_directory", workspaceId: "source-workspace", label: "source", reference: "src",
      lineRange: { startLine: 1, endLine: 2 }
    }] });
    rejects({ ...input, mentions: [{
      kind: "workspace_file", workspaceId: "source-workspace", label: "source", reference: "src/main.ts",
      lineRange: { startLine: 0, endLine: 2 }
    }] });
    rejects({ ...input, mentionRanges: [{ start: 1, end: 2, mentionIndex: 0 }] });
    rejects({ ...input, mentionRanges: [{ start: 10, end: 20, mentionIndex: 99 }] });
    rejects({ ...input, pastedTextRanges: [
      { start: 3, end: 8, display: "later" },
      { start: 0, end: 1, display: "earlier" }
    ] });
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

  it("collects and rebinds accepted attachments while retiring source-only authority", () => {
    const projection = projectPortableSessionMessages([acceptedEvent()]);
    expect([...collectPortableProjectionBlobRefs(projection)]).toEqual([
      [sourceBlob.id, sourceBlob],
      [sourceFile.id, sourceFile],
      [sourceArtifact.id, sourceArtifact]
    ]);
    const receivedBlob = { ...sourceBlob, id: "received-blob" };
    const receivedFile = { ...sourceFile, id: "received-file" };
    const receivedArtifact = { ...sourceArtifact, id: "received-artifact" };
    const rebound = rebindPortableProjectionBlobs(projection, new Map<string, BlobRef>([
      [sourceBlob.id, receivedBlob],
      [sourceFile.id, receivedFile],
      [sourceArtifact.id, receivedArtifact],
      ["unrepresented-artifact", { ...receivedArtifact, id: "must-not-be-guessed" }]
    ]));
    expect(rebound.messages[0]?.blocks[1]).toEqual({ kind: "artifact", blob: receivedArtifact, label: "Report" });
    expect(rebound.messages[0]?.acceptedInput).toMatchObject({
      text: acceptedInput().text,
      images: [{ blob: receivedBlob, alt: "Input preview" }],
      files: [{ blob: receivedFile }],
      mentions: [{
        kind: "artifact",
        label: "artifact",
        reference: receivedArtifact.id,
        sourceSessionId: "session-source"
      }]
    });
    expect(rebound.messages[0]?.acceptedInput?.files[0]).not.toHaveProperty("workspacePath");
    expect(rebound.messages[0]?.acceptedInput?.mentionRanges).toEqual([
      { start: acceptedInput().text.indexOf("@artifact"), end: acceptedInput().text.indexOf("@artifact") + 9, mentionIndex: 0 },
      {
        start: acceptedInput().text.indexOf("@artifact", acceptedInput().text.indexOf("@artifact") + 9),
        end: acceptedInput().text.indexOf("@artifact", acceptedInput().text.indexOf("@artifact") + 9) + 9,
        mentionIndex: 0
      }
    ]);
    expect(() => rebindPortableProjectionBlobs(projection, new Map<string, BlobRef>([
      [sourceBlob.id, { ...receivedBlob, sha256: "d".repeat(64) }],
      [sourceFile.id, receivedFile],
      [sourceArtifact.id, receivedArtifact]
    ]))).toThrowError(PortableSessionProjectionError);
  });

  it("rejects service-owned continuation identity in decoded portable input", () => {
    const projection = projectPortableSessionMessages([acceptedEvent()]);
    const message = projection.messages[0]!;
    expect(() => decodePortableSessionProjection(Buffer.from(JSON.stringify({
      ...projection,
      messages: [{
        ...message,
        acceptedInput: {
          ...message.acceptedInput,
          automaticContinuation: {
            recoveryId: "recovery",
            sourceRunId: "run",
            attempt: 1,
            maximumAttempts: 1,
            sessionTotal: 1
          }
        }
      }]
    })))).toThrowError(PortableSessionProjectionError);
  });

  it("keeps messages and text while omitting unavailable attachments and unproven Artifact mentions", () => {
    const projection = projectPortableSessionMessages([acceptedEvent()]);
    const filtered = omitUnavailablePortableProjectionBlobs(projection, new Set([
      sourceFile.id,
      sourceArtifact.id,
      "unrepresented-artifact"
    ]));
    expect(filtered.messages[0]?.blocks).toEqual([
      { kind: "text", text: "native expanded input" },
      { kind: "artifact", blob: sourceArtifact, label: "Report" }
    ]);
    expect(filtered.messages[0]?.acceptedInput).toMatchObject({
      text: acceptedInput().text,
      images: [],
      files: [{ blob: sourceFile, workspacePath: "notes.txt" }],
      mentions: [
        { kind: "workspace_file", workspaceId: "source-workspace", label: "workspace", reference: "src/main.ts" },
        { kind: "resource", label: "resource", reference: "resource-one", discoveredRevision: "revision-one", resourceVersion: "7", runtimeGeneration: 3 },
        {
          kind: "artifact",
          label: "artifact",
          reference: sourceArtifact.id,
          sourceSessionId: "session-source"
        }
      ]
    });
    expect(filtered.messages[0]?.acceptedInput?.mentionRanges?.map((range) => range.mentionIndex)).toEqual([0, 1, 2, 2]);
    expect([...collectPortableProjectionBlobRefs(filtered).keys()]).toEqual([sourceFile.id, sourceArtifact.id]);

    const withoutMedia = omitUnavailablePortableProjectionBlobs(projection, new Set());
    expect(withoutMedia.messages[0]?.blocks).toEqual([
      { kind: "text", text: "native expanded input" },
      { kind: "text", text: "[Unavailable attachment: Report]" }
    ]);
    expect(withoutMedia.messages[0]?.acceptedInput).toMatchObject({
      text: acceptedInput().text,
      images: [],
      files: [],
      mentions: [
        { kind: "workspace_file", workspaceId: "source-workspace", label: "workspace", reference: "src/main.ts" },
        { kind: "resource", label: "resource", reference: "resource-one", discoveredRevision: "revision-one", resourceVersion: "7", runtimeGeneration: 3 }
      ]
    });
    expect(collectPortableProjectionBlobRefs(withoutMedia).size).toBe(0);
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

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PersistedEvent } from "@joko/store";
import { decodePortableSessionPackage, isEncryptedPortableSessionPackage } from "./portable-session-package.js";
import { decodePortableSessionProjection } from "./portable-session-projection.js";
import {
  PortableSessionExportTooLargeError,
  buildPortableSessionExport,
  materializePortableSessionImport,
  preparePortableSessionImport
} from "./portable-session-transfer.js";

const blob = {
  id: "blob-1",
  sha256: createHash("sha256").update(Uint8Array.from([1, 2, 3])).digest("hex"),
  byteLength: 3,
  mimeType: "image/png",
  fileName: "preview.PNG"
} as const;

function events(): PersistedEvent[] {
  return [{
    id: "event-1",
    globalCursor: 1n,
    sequence: 1n,
    revision: 1n,
    emittedAt: 10,
    backendId: "backend",
    targetId: "target",
    sessionId: "session",
    generation: 1,
    traceId: "trace",
    payload: {
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "image", blob, alt: "diagram" }]
    }
  }];
}

describe("portable Session export composition", () => {
  it("packages native history, projection, media, and password encryption", async () => {
    const built = await buildPortableSessionExport({
      applicationVersion: "0.1.0",
      title: "Task",
      workspaceKind: "project",
      backendCapability: "native-portable-session-v1",
      events: events(),
      nativeSession: nativeSession("{\"type\":\"session\"}\n"),
      password: "secret phrase",
      readBlob: async () => ({ data: Uint8Array.from([1, 2, 3]), mimeType: "image/png" }),
      exportedAt: "2026-08-25T00:00:00.000Z"
    });
    expect(built).toMatchObject({ fidelity: "full", messageCount: 1, mediaCount: 1, missingMediaCount: 0 });
    expect(isEncryptedPortableSessionPackage(built.bytes)).toBe(true);
    const decoded = decodePortableSessionPackage(built.bytes, { password: "secret phrase" });
    expect(decoded.entries.map((entry) => entry.path)).toEqual([
      "projection/messages.json",
      "native/main.jsonl",
      "projection/media-map.json",
      `media/000000-${blob.sha256}.png`
    ]);
  });

  it("preserves messages with an explicit unavailable marker when media is missing or excluded", async () => {
    const built = await buildPortableSessionExport({
      applicationVersion: "0.1.0",
      title: "Task",
      workspaceKind: "dialogue",
      backendCapability: "native-portable-session-v1",
      events: events(),
      excludeMedia: true,
      readBlob: async () => { throw new Error("must not read"); }
    });
    expect(built).toMatchObject({ fidelity: "product_only", mediaCount: 0, missingMediaCount: 1 });
    const decoded = decodePortableSessionPackage(built.bytes);
    const projectionEntry = decoded.entries.find((entry) => entry.path === "projection/messages.json")!;
    expect(decodePortableSessionProjection(projectionEntry.bytes).messages[0]?.blocks).toEqual([
      { kind: "text", text: "[Unavailable attachment: diagram]" }
    ]);
  });

  it("marks collaboration projection as partial until child native histories are portable", async () => {
    const built = await buildPortableSessionExport({
      applicationVersion: "0.1.0",
      title: "Task",
      workspaceKind: "project",
      backendCapability: "native-portable-session-v1",
      events: [],
      nativeSession: nativeSession("{}\n"),
      workers: [{
        id: "worker",
        title: "Research",
        state: "completed",
        focused: false,
        backendCapability: "managed-subagent-v1"
      }],
      workerDetail: [{ id: "worker", result: "done" }],
      readBlob: async () => { throw new Error("unused"); }
    });
    expect(built).toMatchObject({ fidelity: "partial", workerCount: 1 });
    expect(decodePortableSessionPackage(built.bytes).entries.some((entry) => entry.kind === "collaboration")).toBe(true);
  });

  it("reports bounded oversize details before package materialization", async () => {
    await expect(buildPortableSessionExport({
      applicationVersion: "0.1.0",
      title: "Task",
      workspaceKind: "project",
      backendCapability: "native-portable-session-v1",
      events: events(),
      contentLimitBytes: 2,
      readBlob: async () => ({ data: Uint8Array.from([1, 2, 3]), mimeType: "image/png" })
    })).rejects.toBeInstanceOf(PortableSessionExportTooLargeError);
  });

  it("prepares and materializes a receiving projection with new Artifact identities", async () => {
    const built = await buildPortableSessionExport({
      applicationVersion: "0.1.0",
      title: "Task",
      workspaceKind: "project",
      backendCapability: "native-portable-session-v1",
      events: events(),
      nativeSession: nativeSession("{}\n"),
      readBlob: async () => ({ data: Uint8Array.from([1, 2, 3]), mimeType: "image/png" })
    });
    const prepared = preparePortableSessionImport(built.bytes);
    expect(prepared).toMatchObject({
      manifest: { title: "Task", fidelity: "full" },
      media: [{ sourceId: blob.id, blob }]
    });
    const materialized = await materializePortableSessionImport(prepared, async (input) => ({
      id: "received-blob",
      sha256: input.sha256,
      byteLength: input.bytes.byteLength,
      mimeType: input.mimeType,
      ...(input.fileName === undefined ? {} : { fileName: input.fileName })
    }));
    expect(materialized.events[0]?.payload).toMatchObject({
      type: "message_complete",
      blocks: [{ kind: "image", blob: { id: "received-blob", sha256: blob.sha256 } }]
    });
    expect(materialized.nativeSession?.bytes).toEqual(Buffer.from("{}\n"));
  });
});

function nativeSession(text: string) {
  const bytes = Buffer.from(text);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    nativeSessionId: "native"
  };
}

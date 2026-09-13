import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BlobRef } from "@joko/core";
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
  it("retains audio without a missing cover and replaces a missing track without orphan artwork", async () => {
    const fixture = audioMedia();
    for (const missing of ["cover", "audio"] as const) {
      const built = await buildPortableSessionExport({
        applicationVersion: "0.1.0", title: "Tracks", workspaceKind: "dialogue", backendCapability: "native-portable-session-v1",
        events: fixture.events,
        readBlob: async (blob) => {
          if (blob.id === missing) throw new Error("Unavailable");
          return fixture.readBlob(blob);
        }
      });
      const prepared = preparePortableSessionImport(built.bytes);
      expect(prepared.projection.messages).toHaveLength(0);
      expect(built.mediaCount).toBe(missing === "cover" ? 1 : 0);
      expect(prepared.projection.artifacts[0]?.payload).toEqual(missing === "cover"
        ? { type: "artifact", artifact: fixture.audio, purpose: "audio", audioMetadata: { kind: "music", title: "Track", description: "Piano" } }
        : { type: "status", key: "artifact_unavailable", text: "Track" });
      const materialized = await materializePortableSessionImport(prepared, async (input) => ({ id: "receiving-audio", sha256: input.sha256, byteLength: input.bytes.byteLength, mimeType: input.mimeType }));
      expect(materialized.blobs).toHaveLength(missing === "cover" ? 1 : 0);
    }
  });

  it("rejects forged audio types and artwork bytes or dimensions before receiving any media", async () => {
    for (const invalid of ["audio-type", "artwork-bytes", "artwork-dimensions"] as const) {
      const fixture = audioMedia(invalid);
      const built = await buildPortableSessionExport({
        applicationVersion: "0.1.0", title: "Tracks", workspaceKind: "dialogue", backendCapability: "native-portable-session-v1",
        events: fixture.events, readBlob: fixture.readBlob
      });
      const storeBlob = vi.fn();
      await expect(materializePortableSessionImport(preparePortableSessionImport(built.bytes), storeBlob)).rejects.toBeInstanceOf(Error);
      expect(storeBlob).not.toHaveBeenCalled();
    }
  });

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

function audioMedia(invalid?: "audio-type" | "artwork-bytes" | "artwork-dimensions") {
  const wave = Buffer.alloc(46);
  wave.write("RIFF"); wave.writeUInt32LE(38, 4); wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(2, 40);
  const png = invalid === "artwork-bytes" ? Buffer.from("not an image")
    : Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFElEQVQImWP4P4Ph/wwGEP4/gwEAMI4GXTG6t9EAAAAASUVORK5CYII=", "base64");
  const identity = (id: string, bytes: Buffer, mimeType: string): BlobRef => ({ id, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, mimeType });
  const audio = identity("audio", wave, invalid === "audio-type" ? "audio/ogg" : "audio/wav");
  const artwork = identity("cover", png, "image/png");
  const source: PersistedEvent[] = [{ ...events()[0]!, payload: {
    type: "artifact", artifact: audio, purpose: "audio", audioMetadata: { kind: "music", title: "Track", description: "Piano", artwork: { blob: artwork, width: invalid === "artwork-dimensions" ? 3 : 2, height: 2, alt: "Cover" } }
  } }];
  return { audio, events: source, readBlob: async (blob: BlobRef) => ({ data: blob.id === "audio" ? wave : png, mimeType: blob.mimeType }) };
}

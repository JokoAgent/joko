import { describe, expect, it, vi } from "vitest";
import {
  MobileAttachmentFiles,
  type MobileAttachmentFileDriver,
  type MobileAttachmentFileSnapshot
} from "./mobile-attachment-files";
import type {
  MobileAttachmentPolicy,
  MobileLocalComposerAttachment,
  MobilePickedAttachmentCandidate
} from "./mobile-attachments";

const policy: MobileAttachmentPolicy = {
  images: true,
  files: true,
  maximumItems: 3,
  maximumBytes: 16,
  imageMediaTypes: ["image/png"],
  fileMediaTypes: ["application/pdf"]
};

function fileFixture(files: readonly MobilePickedAttachmentCandidate[], sources: Readonly<Record<string, Uint8Array>>) {
  const stored = new Map<string, MobileAttachmentFileSnapshot>();
  const key = (profileId: string, attachmentId: string) => `${profileId}\u001f${attachmentId}`;
  const driver: MobileAttachmentFileDriver = {
    pick: vi.fn(async () => ({ canceled: false, files })),
    stage: vi.fn(async (profileId, attachmentId, sourceUri) => {
      const bytes = sources[sourceUri];
      if (!bytes) throw new Error("source missing");
      const snapshot = { uri: `file:///durable/${profileId}/${attachmentId}`, byteSize: bytes.byteLength,
        bytes: Uint8Array.from(bytes) };
      stored.set(key(profileId, attachmentId), snapshot);
      return snapshot;
    }),
    stageBytes: vi.fn(async (profileId, attachmentId, bytes) => {
      const snapshot = { uri: `file:///durable/${profileId}/${attachmentId}`, byteSize: bytes.byteLength,
        bytes: Uint8Array.from(bytes) };
      stored.set(key(profileId, attachmentId), snapshot);
      return snapshot;
    }),
    read: vi.fn(async (profileId, attachmentId) => {
      const value = stored.get(key(profileId, attachmentId));
      if (!value) throw new Error("staged bytes missing");
      return { ...value, bytes: Uint8Array.from(value.bytes) };
    }),
    remove: vi.fn(async (profileId, attachmentId) => { stored.delete(key(profileId, attachmentId)); }),
    clearProfile: vi.fn(async (profileId) => {
      for (const candidate of [...stored.keys()]) if (candidate.startsWith(`${profileId}\u001f`)) stored.delete(candidate);
    })
  };
  return { driver, stored, key };
}

const digest = async (bytes: Uint8Array): Promise<string> => bytes[0] === 1 ? "a".repeat(64) : "b".repeat(64);

describe("mobile durable attachment files", () => {
  it("treats picker cancellation as no change without allocating an identity", async () => {
    const fixture = fileFixture([], {});
    vi.mocked(fixture.driver.pick).mockResolvedValue({ canceled: true, files: [] });
    const newId = vi.fn(() => "unused");

    await expect(new MobileAttachmentFiles(fixture.driver, digest).pickAndStage(
      "profile", [], policy, newId
    )).resolves.toEqual([]);

    expect(newId).not.toHaveBeenCalled();
    expect(fixture.driver.stage).not.toHaveBeenCalled();
  });

  it("copies picker URIs into exact-profile durable storage, hashes in order, and recovers after restart", async () => {
    const selected = [
      { uri: "content://picker/pixel", fileName: "camera/pixel.png", mediaType: "image/png", byteSize: 2 },
      { uri: "content://picker/proof", fileName: "proof.pdf", mediaType: "application/pdf", byteSize: 3 }
    ];
    const fixture = fileFixture(selected, {
      "content://picker/pixel": new Uint8Array([1, 2]),
      "content://picker/proof": new Uint8Array([2, 3, 4])
    });
    let id = 0;
    const files = new MobileAttachmentFiles(fixture.driver, digest, () => 5_000);

    const staged = await files.pickAndStage("profile-one", [], policy, () => `attachment-${++id}`);

    expect(fixture.driver.pick).toHaveBeenCalledWith(["image/png", "application/pdf"]);
    expect(fixture.driver.stage).toHaveBeenNthCalledWith(1, "profile-one", "attachment-1", "content://picker/pixel");
    expect(fixture.driver.stage).toHaveBeenNthCalledWith(2, "profile-one", "attachment-2", "content://picker/proof");
    expect(staged).toEqual([
      {
        state: "local", attachmentId: "attachment-1", kind: "image", fileName: "pixel.png",
        mediaType: "image/png", byteSize: 2, sha256Hex: "a".repeat(64), capturedAtUnixMs: 5_000
      },
      {
        state: "local", attachmentId: "attachment-2", kind: "file", fileName: "proof.pdf",
        mediaType: "application/pdf", byteSize: 3, sha256Hex: "b".repeat(64), capturedAtUnixMs: 5_000
      }
    ]);

    const restarted = new MobileAttachmentFiles(fixture.driver, digest, () => 9_000);
    await expect(restarted.verifyForUpload("profile-one", staged[0]!)).resolves.toEqual({
      uri: "file:///durable/profile-one/attachment-1",
      fileName: "pixel.png",
      mediaType: "image/png",
      byteSize: 2,
      sha256Hex: "a".repeat(64)
    });
  });

  it("copies authenticated bytes into exact-profile storage and removes a mismatched durable copy", async () => {
    const fixture = fileFixture([], {});
    const files = new MobileAttachmentFiles(fixture.driver, digest, () => 6_000);
    const candidate = {
      bytes: new Uint8Array([1, 2]),
      fileName: "workspace.png",
      mediaType: "image/png",
      byteSize: 2,
      sha256Hex: "a".repeat(64)
    };

    await expect(files.stageVerifiedBytes(
      "profile-one", [], policy, candidate, () => "download-one"
    )).resolves.toEqual({
      state: "local",
      attachmentId: "download-one",
      kind: "image",
      fileName: "workspace.png",
      mediaType: "image/png",
      byteSize: 2,
      sha256Hex: "a".repeat(64),
      capturedAtUnixMs: 6_000
    });
    expect(fixture.driver.stageBytes).toHaveBeenCalledWith(
      "profile-one", "download-one", candidate.bytes
    );

    vi.mocked(fixture.driver.stageBytes).mockImplementationOnce(async (profileId, attachmentId) => {
      const value = {
        uri: `file:///durable/${profileId}/${attachmentId}`,
        byteSize: 2,
        bytes: new Uint8Array([2, 2])
      };
      fixture.stored.set(fixture.key(profileId, attachmentId), value);
      return value;
    });
    await expect(files.stageVerifiedBytes(
      "profile-one", [], policy, candidate, () => "download-tampered"
    )).rejects.toThrow(/staged SHA-256/u);
    expect(fixture.driver.remove).toHaveBeenCalledWith("profile-one", "download-tampered");
    expect(fixture.stored.has(fixture.key("profile-one", "download-tampered"))).toBe(false);

    await expect(files.stageVerifiedBytes(
      "profile-one", [], policy, { ...candidate, sha256Hex: "b".repeat(64) }, () => "download-unverified"
    )).rejects.toThrow(/before staging/u);
    expect(fixture.driver.stageBytes).not.toHaveBeenCalledWith(
      "profile-one", "download-unverified", candidate.bytes
    );
  });

  it("keeps a separately verified annotation source and removes it with the visible attachment", async () => {
    const fixture = fileFixture([], {});
    const files = new MobileAttachmentFiles(fixture.driver, digest, () => 7_000);
    const bytes = new Uint8Array([1, 9]);
    await expect(files.stageOwnedBytes(
      "profile-one", "annotation-source-one", bytes, "a".repeat(64)
    )).resolves.toMatchObject({
      uri: "file:///durable/profile-one/annotation-source-one",
      byteSize: 2,
      sha256Hex: "a".repeat(64)
    });
    await expect(files.readOwnedBytes(
      "profile-one", "annotation-source-one", 2, "a".repeat(64)
    )).resolves.toMatchObject({ byteSize: 2, bytes });

    fixture.stored.set(fixture.key("profile-one", "annotation-source-one"), {
      uri: "file:///durable/profile-one/annotation-source-one", byteSize: 2, bytes: new Uint8Array([2, 9])
    });
    await expect(files.readOwnedBytes(
      "profile-one", "annotation-source-one", 2, "a".repeat(64)
    )).rejects.toThrow(/SHA-256/u);
    fixture.stored.set(fixture.key("profile-one", "annotation-source-one"), {
      uri: "file:///durable/profile-one/annotation-source-one", byteSize: 2, bytes
    });

    await files.remove("profile-one", {
      state: "uploaded",
      attachmentId: "rendered-one",
      kind: "image",
      fileName: "annotated.png",
      mediaType: "image/png",
      byteSize: 2,
      sha256Hex: "a".repeat(64),
      capturedAtUnixMs: 7_001,
      blobId: "blob-one",
      annotation: {
        source: {
          storageId: "annotation-source-one",
          fileName: "original.png",
          mediaType: "image/png",
          byteSize: 2,
          sha256Hex: "a".repeat(64),
          capturedAtUnixMs: 7_000
        },
        strokes: [{ points: [{ x: 0.2, y: 0.3 }] }]
      }
    });
    expect(fixture.stored.has(fixture.key("profile-one", "annotation-source-one"))).toBe(false);
  });

  it("reserves annotation source identities before writing a new visible attachment", async () => {
    const fixture = fileFixture([], {});
    const files = new MobileAttachmentFiles(fixture.driver, digest, () => 7_000);
    const current: MobileLocalComposerAttachment = {
      state: "local",
      attachmentId: "rendered-one",
      kind: "image",
      fileName: "annotated.png",
      mediaType: "image/png",
      byteSize: 2,
      sha256Hex: "a".repeat(64),
      capturedAtUnixMs: 7_001,
      annotation: {
        source: {
          storageId: "annotation-source-one",
          fileName: "original.png",
          mediaType: "image/png",
          byteSize: 2,
          sha256Hex: "a".repeat(64),
          capturedAtUnixMs: 7_000
        },
        strokes: [{ points: [{ x: 0.2, y: 0.3 }] }]
      }
    };

    await expect(files.stageVerifiedBytes("profile-one", [current], policy, {
      bytes: new Uint8Array([1, 9]),
      fileName: "next.png",
      mediaType: "image/png",
      byteSize: 2,
      sha256Hex: "a".repeat(64)
    }, () => "annotation-source-one")).rejects.toThrow(/already in use/u);
    expect(fixture.driver.stageBytes).not.toHaveBeenCalled();
  });

  it("cleans every copied item when a later picker result changes during staging", async () => {
    const selected = [
      { uri: "content://picker/one", fileName: "one.png", mediaType: "image/png", byteSize: 2 },
      { uri: "content://picker/two", fileName: "two.pdf", mediaType: "application/pdf", byteSize: 3 }
    ];
    const fixture = fileFixture(selected, {
      "content://picker/one": new Uint8Array([1, 2]),
      "content://picker/two": new Uint8Array([2, 3])
    });
    let id = 0;

    await expect(new MobileAttachmentFiles(fixture.driver, digest).pickAndStage(
      "profile", [], policy, () => `attachment-${++id}`
    )).rejects.toThrow(/changed while it was being copied/u);

    expect(fixture.driver.remove).toHaveBeenCalledWith("profile", "attachment-1");
    expect(fixture.driver.remove).toHaveBeenCalledWith("profile", "attachment-2");
    expect(fixture.stored.size).toBe(0);
  });

  it("fails closed when durable bytes are missing, resized, or fail their saved digest", async () => {
    const selected = [{
      uri: "content://picker/one", fileName: "one.png", mediaType: "image/png", byteSize: 2
    }];
    const fixture = fileFixture(selected, { "content://picker/one": new Uint8Array([1, 2]) });
    const files = new MobileAttachmentFiles(fixture.driver, digest);
    const [staged] = await files.pickAndStage("profile", [], policy, () => "attachment-one");
    const exact = staged as MobileLocalComposerAttachment;

    fixture.stored.set(fixture.key("profile", exact.attachmentId), {
      uri: "file:///durable/profile/attachment-one", byteSize: 2, bytes: new Uint8Array([2, 3])
    });
    await expect(files.verifyForUpload("profile", exact)).rejects.toThrow(/SHA-256/u);

    fixture.stored.set(fixture.key("profile", exact.attachmentId), {
      uri: "file:///durable/profile/attachment-one", byteSize: 1, bytes: new Uint8Array([1])
    });
    await expect(files.verifyForUpload("profile", exact)).rejects.toThrow(/changed after it was staged/u);

    fixture.stored.delete(fixture.key("profile", exact.attachmentId));
    await expect(files.verifyForUpload("profile", exact)).rejects.toThrow(/staged bytes missing/u);
  });

  it("removes only local bytes and clears only the exact profile directory", async () => {
    const selected = [{
      uri: "content://picker/one", fileName: "one.png", mediaType: "image/png", byteSize: 2
    }];
    const fixture = fileFixture(selected, { "content://picker/one": new Uint8Array([1, 2]) });
    const files = new MobileAttachmentFiles(fixture.driver, digest);
    const [first] = await files.pickAndStage("profile-one", [], policy, () => "attachment-one");
    await files.pickAndStage("profile-two", [], policy, () => "attachment-two");

    await files.remove("profile-one", first!);
    expect(fixture.stored.has(fixture.key("profile-one", "attachment-one"))).toBe(false);
    expect(fixture.stored.has(fixture.key("profile-two", "attachment-two"))).toBe(true);

    await files.clearProfile("profile-two");
    expect(fixture.stored.size).toBe(0);
  });
});

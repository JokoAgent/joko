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

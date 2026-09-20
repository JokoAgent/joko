import { describe, expect, it, vi } from "vitest";
import type { MobileAttachmentFiles } from "./mobile-attachment-files";
import type { MobileAttachmentPolicy, MobileLocalComposerAttachment } from "./mobile-attachments";
import { emptyMobileComposerDraft, mobileComposerDraftsEqual, type MobileComposerDraft } from "./mobile-composer-document";
import {
  MobileComposerImagePaste,
  commitMobileComposerImagePaste,
  decodeMobileComposerPastedImageBase64,
  inspectMobileComposerPastedImageBytes,
  type MobileComposerImagePasteConverter
} from "./mobile-composer-image-paste";

const policy: MobileAttachmentPolicy = {
  images: true,
  files: false,
  maximumItems: 4,
  maximumBytes: 1_024,
  imageMediaTypes: ["image/png", "image/gif"],
  fileMediaTypes: []
};

function filesFixture(failAt = 0) {
  let stage = 0;
  const staged: MobileLocalComposerAttachment[] = [];
  const files = {
    digestOwnedBytes: vi.fn(async (bytes: Uint8Array) => (bytes[0] ?? 0).toString(16).padStart(2, "0").repeat(32)),
    stageVerifiedBytes: vi.fn(async (
      _profileId: string,
      _current: readonly MobileLocalComposerAttachment[],
      _policy: MobileAttachmentPolicy,
      candidate: { readonly bytes: Uint8Array; readonly fileName: string; readonly mediaType: string;
        readonly byteSize: number; readonly sha256Hex: string },
      newId: () => string
    ) => {
      stage += 1;
      if (stage === failAt) throw new Error("stage failed");
      const attachment: MobileLocalComposerAttachment = {
        state: "local",
        attachmentId: newId(),
        kind: "image",
        fileName: candidate.fileName,
        mediaType: candidate.mediaType,
        byteSize: candidate.byteSize,
        sha256Hex: candidate.sha256Hex,
        capturedAtUnixMs: stage
      };
      staged.push(attachment);
      return attachment;
    }),
    remove: vi.fn(async (_profileId: string, attachment: MobileLocalComposerAttachment) => {
      const index = staged.findIndex((value) => value.attachmentId === attachment.attachmentId);
      if (index >= 0) staged.splice(index, 1);
    })
  };
  return { files: files as unknown as MobileAttachmentFiles, raw: files, staged };
}

describe("mobile composer clipboard image paste", () => {
  it("decodes canonical base64 and rejects aliases or non-zero padding bits", () => {
    expect([...decodeMobileComposerPastedImageBase64("AQID")]).toEqual([1, 2, 3]);
    expect([...decodeMobileComposerPastedImageBase64("AQ==")]).toEqual([1]);
    expect(() => decodeMobileComposerPastedImageBase64("AR==")).toThrow(/canonical/u);
    expect(() => decodeMobileComposerPastedImageBase64("AQI")).toThrow(/base64/u);
    expect(() => decodeMobileComposerPastedImageBase64("AQ I=")).toThrow(/base64/u);
  });

  it("verifies PNG, GIF, WebP, JPEG, HEIC, and HEIF signatures with bounded dimensions", () => {
    expect(inspectMobileComposerPastedImageBytes(png(5, 4), "image/png")).toEqual({ width: 5, height: 4 });
    expect(inspectMobileComposerPastedImageBytes(gif(6, 3), "image/gif")).toEqual({ width: 6, height: 3 });
    expect(inspectMobileComposerPastedImageBytes(webp(7, 5), "image/webp")).toEqual({ width: 7, height: 5 });
    expect(inspectMobileComposerPastedImageBytes(jpeg(8, 6), "image/jpeg")).toEqual({ width: 8, height: 6 });
    expect(inspectMobileComposerPastedImageBytes(isoImage(["mif1", "heic"], 9, 7), "image/heic"))
      .toEqual({ width: 9, height: 7 });
    expect(inspectMobileComposerPastedImageBytes(isoImage(["mif1"], 10, 8), "image/heif"))
      .toEqual({ width: 10, height: 8 });
    expect(() => inspectMobileComposerPastedImageBytes(png(5, 4), "image/jpeg")).toThrow(/signature/u);
    const truncatedGif = gif(6, 3).slice(0, -1);
    expect(() => inspectMobileComposerPastedImageBytes(truncatedGif, "image/gif")).toThrow(/truncated/u);
  });

  it("stages a verified batch in clipboard order with controlled names", async () => {
    const fixture = filesFixture();
    let id = 0;
    const staged = await new MobileComposerImagePaste(fixture.files).stage(
      "profile-one",
      [],
      policy,
      [
        { base64: base64(png(5, 4)), mediaType: "image/png", name: "../../forged.png" },
        { base64: base64(gif(6, 3)), mediaType: "image/gif", name: "second.gif" }
      ],
      () => `paste-${++id}`
    );

    expect(staged.map(({ attachmentId, fileName, mediaType }) => ({ attachmentId, fileName, mediaType }))).toEqual([
      { attachmentId: "paste-1", fileName: "pasted-image-1.png", mediaType: "image/png" },
      { attachmentId: "paste-2", fileName: "pasted-image-2.gif", mediaType: "image/gif" }
    ]);
    expect(fixture.raw.stageVerifiedBytes).toHaveBeenCalledTimes(2);
  });

  it("converts an unadmitted verified raster to JPEG and verifies the result before staging", async () => {
    const fixture = filesFixture();
    const converter: MobileComposerImagePasteConverter = { convertToJpeg: vi.fn(async () => jpeg(8, 6)) };
    const jpegPolicy = { ...policy, imageMediaTypes: ["image/jpeg"] };

    const staged = await new MobileComposerImagePaste(fixture.files, converter).stage(
      "profile-one",
      [],
      jpegPolicy,
      [{ base64: base64(png(5, 4)), mediaType: "image/png", name: "source.png" }],
      () => "paste-one"
    );

    expect(converter.convertToJpeg).toHaveBeenCalledWith(expect.any(Uint8Array), "image/png");
    expect(staged[0]).toMatchObject({ fileName: "pasted-image-1.jpg", mediaType: "image/jpeg" });
  });

  it("cleans every staged item if a later item fails and never trusts a declared MIME", async () => {
    const failing = filesFixture(2);
    let id = 0;
    await expect(new MobileComposerImagePaste(failing.files).stage(
      "profile-one",
      [],
      policy,
      [
        { base64: base64(png(5, 4)), mediaType: "image/png", name: "one.png" },
        { base64: base64(gif(6, 3)), mediaType: "image/gif", name: "two.gif" }
      ],
      () => `paste-${++id}`
    )).rejects.toThrow("stage failed");
    expect(failing.raw.remove).toHaveBeenCalledWith("profile-one", expect.objectContaining({ attachmentId: "paste-1" }));
    expect(failing.staged).toEqual([]);

    const untouched = filesFixture();
    await expect(new MobileComposerImagePaste(untouched.files).stage(
      "profile-one",
      [],
      policy,
      [{ base64: base64(jpeg(8, 6)), mediaType: "image/png", name: "forged.png" }],
      () => "unused"
    )).rejects.toThrow(/signature/u);
    expect(untouched.raw.stageVerifiedBytes).not.toHaveBeenCalled();
  });

  it("commits a verified batch through snapshot, authority, CAS, flush, and readback", async () => {
    const fixture = filesFixture();
    const input = emptyMobileComposerDraft();
    let retained: { readonly input: MobileComposerDraft } | undefined = { input };
    const validateAuthority = vi.fn();
    const flush = vi.fn(async () => undefined);

    const result = await commitMobileComposerImagePaste({
      buildDraft: (next) => ({ input: next }),
      files: fixture.files,
      flush,
      imagePaste: new MobileComposerImagePaste(fixture.files),
      input,
      newId: () => "paste-one",
      payloads: [{ base64: base64(png(5, 4)), mediaType: "image/png", name: "source.png" }],
      policy,
      profileId: "profile-one",
      readBackMatches: (draft) => retained !== undefined && mobileComposerDraftsEqual(retained.input, draft.input),
      saveIfRevision: (draft, revision) => {
        expect(revision).toBe(7);
        retained = draft;
        return true;
      },
      snapshot: Promise.resolve({ revision: 7, draft: retained }),
      snapshotMatches: (draft) => draft !== undefined && mobileComposerDraftsEqual(draft.input, input),
      validateAuthority
    });

    expect(validateAuthority).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(result.input.attachments).toHaveLength(1);
    expect(retained?.input.attachments[0]?.attachmentId).toBe("paste-one");
  });

  it("removes pre-CAS bytes but retains the recoverable draft and bytes after CAS", async () => {
    const input = emptyMobileComposerDraft();
    const payloads = [{ base64: base64(png(5, 4)), mediaType: "image/png" as const, name: "source.png" }];
    const rejected = filesFixture();
    await expect(commitMobileComposerImagePaste({
      buildDraft: (next) => next,
      files: rejected.files,
      flush: async () => undefined,
      imagePaste: new MobileComposerImagePaste(rejected.files),
      input,
      newId: () => "rejected",
      payloads,
      policy,
      profileId: "profile-one",
      readBackMatches: () => false,
      saveIfRevision: () => false,
      snapshot: Promise.resolve({ revision: 2, draft: input }),
      snapshotMatches: (draft) => draft !== undefined && mobileComposerDraftsEqual(draft, input),
      validateAuthority: () => undefined
    })).rejects.toThrow(/changed/u);
    expect(rejected.raw.remove).toHaveBeenCalledOnce();
    expect(rejected.staged).toEqual([]);

    const recoverable = filesFixture();
    let retained: MobileComposerDraft | undefined;
    await expect(commitMobileComposerImagePaste({
      buildDraft: (next) => next,
      files: recoverable.files,
      flush: async () => { throw new Error("storage unavailable"); },
      imagePaste: new MobileComposerImagePaste(recoverable.files),
      input,
      newId: () => "recoverable",
      payloads,
      policy,
      profileId: "profile-one",
      readBackMatches: () => false,
      saveIfRevision: (draft) => { retained = draft; return true; },
      snapshot: Promise.resolve({ revision: 3, draft: input }),
      snapshotMatches: (draft) => draft !== undefined && mobileComposerDraftsEqual(draft, input),
      validateAuthority: () => undefined
    })).rejects.toThrow("storage unavailable");
    expect(retained?.attachments[0]?.attachmentId).toBe("recoverable");
    expect(recoverable.raw.remove).not.toHaveBeenCalled();
    expect(recoverable.staged).toHaveLength(1);
  });
});

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  writeU32(bytes, 8, 13, false);
  bytes.set([73, 72, 68, 82], 12);
  writeU32(bytes, 16, width, false);
  writeU32(bytes, 20, height, false);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([73, 69, 78, 68], 37);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    height >>> 8, height & 0xff, width >>> 8, width & 0xff,
    0x01, 0x01, 0x11, 0x00, 0xff, 0xd9
  ]);
}

function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([82, 73, 70, 70], 0);
  writeU32(bytes, 4, 22, true);
  bytes.set([87, 69, 66, 80, 86, 80, 56, 88], 8);
  writeU32(bytes, 16, 10, true);
  writeU24(bytes, 24, width - 1);
  writeU24(bytes, 27, height - 1);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(29);
  bytes.set([..."GIF89a"].map((value) => value.charCodeAt(0)), 0);
  writeU16(bytes, 6, width);
  writeU16(bytes, 8, height);
  bytes[13] = 0x2c;
  writeU16(bytes, 18, width);
  writeU16(bytes, 20, height);
  bytes[23] = 2;
  bytes[24] = 2;
  bytes[25] = 0x44;
  bytes[26] = 0x01;
  bytes[27] = 0;
  bytes[28] = 0x3b;
  return bytes;
}

function isoImage(brands: readonly string[], width: number, height: number): Uint8Array {
  const major = brands[0] ?? "";
  const ftyp = box("ftyp", concatenate(ascii(major), new Uint8Array(4), ...brands.slice(1).map(ascii)));
  const ispePayload = new Uint8Array(12);
  writeU32(ispePayload, 4, width, false);
  writeU32(ispePayload, 8, height, false);
  const metadata = box("meta", concatenate(new Uint8Array(4), box("iprp", box("ipco", box("ispe", ispePayload)))));
  return concatenate(ftyp, metadata);
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.byteLength);
  writeU32(bytes, 0, bytes.byteLength, false);
  bytes.set(ascii(type), 4);
  bytes.set(payload, 8);
  return bytes;
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
}

function concatenate(...values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((length, value) => length + value.byteLength, 0));
  let offset = 0;
  for (const value of values) { output.set(value, offset); offset += value.byteLength; }
  return output;
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8 & 0xff;
}

function writeU24(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8 & 0xff;
  bytes[offset + 2] = value >>> 16 & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number, littleEndian: boolean): void {
  for (let index = 0; index < 4; index += 1) {
    bytes[offset + (littleEndian ? index : 3 - index)] = value >>> (index * 8) & 0xff;
  }
}

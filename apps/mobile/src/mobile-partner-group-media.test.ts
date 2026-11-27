import { create } from "@bufbuild/protobuf";
import * as wire from "@joko/contracts";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createMobileGroupMedia } from "./mobile-partner-group-media";
import { MobileImageOutput, mobileImageOutputTesting } from "./mobile-image-output";
import { MobileMediaPreviewFiles } from "./mobile-media-preview";
import { MobileModelPreviewFiles } from "./mobile-model-preview";
import type { MobilePdfPreviewLease } from "./mobile-pdf-preview";

const photos = vi.hoisted(() => ({
  platform: { OS: "ios", Version: 28 }, permission: vi.fn<() => Promise<boolean>>(), write: vi.fn()
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "image-id" }));
vi.mock("expo-modules-core", () => ({ requireNativeModule: () => ({ saveImage: photos.write }) }));
vi.mock("expo-media-library/legacy", () => ({
  isAvailableAsync: async () => true, getPermissionsAsync: async () => ({ granted: false, canAskAgain: true }),
  requestPermissionsAsync: async () => ({ granted: await photos.permission() }), saveToLibraryAsync: photos.write
}));
vi.mock("react-native", () => ({
  Platform: photos.platform, PermissionsAndroid: {
    PERMISSIONS: { WRITE_EXTERNAL_STORAGE: "write" }, RESULTS: { GRANTED: "granted" },
    request: async () => await photos.permission() ? "granted" : "denied"
  }
}));

async function fixture(file?: { readonly mediaType: string; readonly name: string; readonly category: wire.PartnerGroupAttachmentCategory; readonly bytes: Uint8Array }) {
  const bytes = file?.bytes ?? Uint8Array.from(await sharp({ create: { width: 4, height: 3, channels: 3, background: "orange" } }).png().toBuffer());
  const blob = create(wire.BlobRefSchema, { blobId: "group-blob", fileName: file?.name ?? "picture.png", mediaType: file?.mediaType ?? "image/png",
    byteSize: BigInt(bytes.length), sha256Hex: createHash("sha256").update(bytes).digest("hex") });
  const attachment = create(wire.PartnerGroupAttachmentSchema, { id: "group-attachment", name: blob.fileName, blob, category: file?.category ?? wire.PartnerGroupAttachmentCategory.IMAGE });
  const message = create(wire.PartnerGroupMessageSchema, { id: "group-message", sequence: 2n, attachments: [attachment] }), group = create(wire.PartnerGroupSummarySchema, { id: "group", revision: { value: 1n } });
  let visible = true, current = true, next = 0;
  const get = vi.fn(async () => create(wire.GetPartnerGroupResponseSchema, { detail: { group, messages: visible ? [message] : [] } }));
  const download = vi.fn(async () => ({ bytes, mediaType: blob.mediaType }));
  const pdf: MobilePdfPreviewLease = { profileId: "group-owner", leaseId: "pdf-preview", uri: "file:///preview-pdf-preview.pdf",
    fileName: "preview-pdf-preview.pdf", mediaType: "application/pdf", localByteSize: bytes.length, sha256Hex: blob.sha256Hex };
  const pdfFiles = { stage: vi.fn(async () => pdf), remove: vi.fn(async () => {}) };
  const driver = {
    prepare: vi.fn(async () => undefined),
    write: vi.fn(async (fileName: string, bytes: Uint8Array) =>
      ({ uri: `file:///preview/${fileName}`, fileName, byteSize: bytes.length, bytes })),
    remove: vi.fn(async () => undefined)
  };
  const digest = async (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const tools = createMobileGroupMedia({ ownerKey: "group-owner", api: { get } as unknown as wire.PartnerGroupApi,
    newId: () => `media-${++next}`, current: signal => { signal.throwIfAborted(); if (!current) throw new Error("Owner changed"); },
    thumbnail: async () => undefined, download, authorize: vi.fn(), pdfPreview: { profileId: "group-owner", files: pdfFiles },
    mediaPreview: { profileId: "group-owner", files: new MobileMediaPreviewFiles(driver, digest) },
    modelPreview: { profileId: "group-owner", files: new MobileModelPreviewFiles(driver, digest) } });
  return { tools, group, message, attachment, bytes, blob, get, download, pdf, pdfFiles, driver,
    hide: () => { visible = false; }, retire: () => { current = false; } };
}
it("revalidates a cached group image against its exact message and requires confirmed current bytes for image output", async () => {
  const f = await fixture(), signal = new AbortController().signal;
  const thumbnail = await f.tools.prepareMediaThumbnail(f.group, f.message, f.attachment, signal); expect(thumbnail.content).toMatchObject({ kind: "image", width: 4, height: 3 });
  f.tools.confirmMediaThumbnail(thumbnail.leaseId, { width: 4, height: 3, mediaType: "image/png", isAnimated: false }); f.tools.releaseMediaThumbnail(thumbnail.leaseId);
  const session = await f.tools.prepareMediaImage(f.group, f.message, f.attachment, signal), decoded = { width: 4, height: 3, mediaType: "image/png", isAnimated: false };
  await expect(f.tools.prepareMediaOutput(session.leaseId, decoded, signal)).rejects.toThrow(/Confirm/);
  f.tools.confirmMediaImage(session.leaseId, decoded); const output = await f.tools.prepareMediaOutput(session.leaseId, decoded, signal);
  expect(output.source).toMatchObject({ sha256Hex: f.blob.sha256Hex, width: 4, height: 3, bytes: f.bytes }); f.hide();
  await expect(output.assertCurrent()).rejects.toThrow(/source changed/); await expect(f.tools.prepareMediaThumbnail(f.group, f.message, f.attachment, signal)).rejects.toThrow(/source changed/);
  f.tools.closeMediaImage(session.leaseId); await expect(f.tools.prepareMediaOutput(session.leaseId, decoded, signal)).rejects.toThrow(/closed/);
});
it("rejects a late verified image download after the mobile profile owner has retired", async () => {
  const f = await fixture(); let finish!: (value: Awaited<ReturnType<typeof f.download>>) => void;
  f.download.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.tools.prepareMediaImage(f.group, f.message, f.attachment, new AbortController().signal);
  await vi.waitFor(() => expect(f.download).toHaveBeenCalled()); f.retire(); finish({ bytes: f.bytes, mediaType: "image/png" }); await expect(pending).rejects.toThrow(/Owner changed/);
});

it("rechecks the image lease when the last group read completes", async () => {
  const f = await fixture(), signal = new AbortController().signal;
  const session = await f.tools.prepareMediaImage(f.group, f.message, f.attachment, signal);
  const decoded = { width: 4, height: 3, mediaType: "image/png", isAnimated: false };
  f.tools.confirmMediaImage(session.leaseId, decoded);
  const output = await f.tools.prepareMediaOutput(session.leaseId, decoded, signal);
  const response = await f.get();
  let finish!: (current: typeof response) => void;
  f.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const checking = output.assertCurrent();
  f.tools.closeMediaImage(session.leaseId);
  finish(response);
  await expect(checking).rejects.toThrow(/closed/u);
  const reads = f.get.mock.calls.length;
  await expect(output.assertCurrent()).rejects.toThrow(/closed/u);
  expect(f.get).toHaveBeenCalledTimes(reads);
});

describe.each(["ios", "android"])("%s group image save after the photo permission prompt", platform => {
  it.each(["revoked", "message removed", "closed", "cancelled", "granted"])("%s", async outcome => {
    photos.platform.OS = platform;
    photos.write.mockClear();
    const f = await fixture(), controller = new AbortController();
    const session = await f.tools.prepareMediaImage(f.group, f.message, f.attachment, controller.signal);
    const decoded = { width: 4, height: 3, mediaType: "image/png", isAnimated: false };
    f.tools.confirmMediaImage(session.leaseId, decoded);
    const output = await f.tools.prepareMediaOutput(session.leaseId, decoded, controller.signal);
    let grant!: (allowed: boolean) => void, prompted!: () => void;
    const prompt = new Promise<void>(resolve => { prompted = resolve; });
    photos.permission.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; prompted(); }));
    const file = { uri: "file:///cache/group.png", fileName: "group.png" };
    const removeTemporary = vi.fn(async () => {});
    const publisher = new MobileImageOutput({
      maintain: vi.fn(), copyImage: vi.fn(), writeTemporary: async () => file, removeTemporary,
      saveImage: mobileImageOutputTesting.saveImage, shareImage: vi.fn(), sharingAvailable: vi.fn()
    });
    const saving = publisher.perform("save", output.source, undefined, controller.signal, output.assertCurrent);
    await prompt;
    expect(photos.write).not.toHaveBeenCalled();
    if (outcome === "revoked") f.retire();
    if (outcome === "message removed") f.hide();
    if (outcome === "closed") f.tools.closeMediaImage(session.leaseId);
    if (outcome === "cancelled") controller.abort();
    grant(true);
    if (outcome === "granted") {
      await saving;
      expect(photos.write.mock.calls).toEqual([platform === "ios" ? [file.uri] : [file.uri, file.fileName, "image/png"]]);
    } else {
      await expect(saving).rejects.toThrow(/owner changed|source changed|closed|abort/iu);
      expect(photos.write).not.toHaveBeenCalled();
    }
    expect(removeTemporary).toHaveBeenCalledExactlyOnceWith(file);
  });
});

it("opens the ready text attachment only through its original readable group and rejects changed bytes", async () => {
  const f = await fixture({ category: wire.PartnerGroupAttachmentCategory.TEXT, name: "notes.txt", mediaType: "text/plain",
    bytes: new TextEncoder().encode("An approved group attachment.") });
  const signal = new AbortController().signal;
  await expect(f.tools.prepareMediaFile(f.group, f.message, f.attachment, signal)).resolves.toMatchObject({
    kind: "text", title: "notes.txt", text: "An approved group attachment."
  });
  expect(f.get).toHaveBeenCalledWith(f.group.id, 3n, signal);
  f.download.mockResolvedValueOnce({ bytes: new Uint8Array(f.bytes.length), mediaType: f.blob.mediaType });
  await expect(f.tools.prepareMediaFile(f.group, f.message, f.attachment, signal)).rejects.toThrow(/bytes changed/u);
  const downloads = f.download.mock.calls.length;
  f.hide();
  await expect(f.tools.prepareMediaFile(f.group, f.message, f.attachment, signal)).rejects.toThrow(/source changed/u);
  expect(f.download).toHaveBeenCalledTimes(downloads);
});

it("gives the PDF viewer a verified local lease and retires it if group access changes during staging", async () => {
  const f = await fixture({ category: wire.PartnerGroupAttachmentCategory.PDF, name: "report.pdf", mediaType: "application/pdf",
    bytes: new TextEncoder().encode("%PDF-1.7 fixture bytes") });
  const signal = new AbortController().signal;
  const preview = await f.tools.prepareMediaFile(f.group, f.message, f.attachment, signal);
  expect(preview).toEqual({ kind: "pdf", pdf: f.pdf });
  expect(f.pdfFiles.stage).toHaveBeenCalledWith("group-owner", "media-1", "report.pdf", "application/pdf", f.blob.sha256Hex, f.bytes, signal);
  await f.tools.releaseMediaFile(preview);
  f.pdfFiles.stage.mockImplementationOnce(async () => { f.hide(); return f.pdf; });
  await expect(f.tools.prepareMediaFile(f.group, f.message, f.attachment, signal)).rejects.toThrow(/source changed/u);
  expect(f.pdfFiles.remove).toHaveBeenCalledTimes(2);
});

it.each([
  { name: "voice.wav", mediaType: "audio/wav", bytes: new TextEncoder().encode("RIFF\0\0\0\0WAVE"),
    expected: { kind: "media", media: { mediaKind: "audio" } } },
  { name: "demo.webm", mediaType: "video/webm", bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new TextEncoder().encode("webm\0V_VP9")]),
    expected: { kind: "media", media: { mediaKind: "video" } } },
  { name: "scene.glb", mediaType: "model/gltf-binary", bytes: groupGlb(),
    expected: { kind: "model", model: { modelKind: "glb", references: [] } } }
])("opens a verified original $name and cleans up the native viewer lease", async ({ name, mediaType, bytes, expected }) => {
  const f = await fixture({ name, mediaType, bytes, category: wire.PartnerGroupAttachmentCategory.FILE });
  const signal = new AbortController().signal;
  const open = () => f.tools.prepareMediaFile(f.group, f.message, f.attachment, signal);
  const preview = await open();
  expect(preview).toMatchObject(expected);
  const [fileName, written] = f.driver.write.mock.calls[0]!;
  expect(fileName).toMatch(/^preview-/u);
  if (preview.kind === "model") {
    const descriptor = preview.model.files[0]!;
    expect(written.slice(descriptor.byteOffset, descriptor.byteOffset + descriptor.byteSize)).toEqual(bytes);
  } else expect(written).toEqual(bytes);
  await f.tools.releaseMediaFile(preview);
  expect(f.driver.remove).toHaveBeenCalledTimes(1);
  f.driver.write.mockImplementationOnce(async (fileName, bytes) => {
    f.retire();
    return { uri: `file:///preview/${fileName}`, fileName, byteSize: bytes.length, bytes };
  });
  await expect(open()).rejects.toThrow(/Owner changed/u);
  expect(f.driver.remove).toHaveBeenCalledTimes(2);
});

it("rejects a group video whose authorized bytes use an audio container", async () => {
  const f = await fixture({ category: wire.PartnerGroupAttachmentCategory.FILE, name: "demo.webm", mediaType: "video/webm",
    bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new TextEncoder().encode("webm\0A_OPUS")]) });
  await expect(f.tools.prepareMediaFile(f.group, f.message, f.attachment, new AbortController().signal)).rejects.toThrow(/container/u);
  expect(f.driver.write).not.toHaveBeenCalled();
});

function groupGlb(): Uint8Array {
  const json = new TextEncoder().encode('{"asset":{"version":"2.0"}} ');
  const bytes = new Uint8Array(20 + json.length);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, bytes.length, true);
  header.setUint32(12, json.length, true);
  header.setUint32(16, 0x4e4f534a, true);
  bytes.set(json, 20);
  return bytes;
}

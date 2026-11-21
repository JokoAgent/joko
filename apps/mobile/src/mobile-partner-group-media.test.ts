import { create } from "@bufbuild/protobuf";
import * as wire from "@joko/contracts";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { createMobileGroupMedia } from "./mobile-partner-group-media";
import type { MobilePdfPreviewLease } from "./mobile-pdf-preview";

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
  const tools = createMobileGroupMedia({ ownerKey: "group-owner", api: { get } as unknown as wire.PartnerGroupApi,
    newId: () => `media-${++next}`, current: signal => { signal.throwIfAborted(); if (!current) throw new Error("Owner changed"); },
    thumbnail: async () => undefined, download, authorize: vi.fn(), pdfPreview: { profileId: "group-owner", files: pdfFiles } });
  return { tools, group, message, attachment, bytes, blob, get, download, pdf, pdfFiles, hide: () => { visible = false; }, retire: () => { current = false; } };
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

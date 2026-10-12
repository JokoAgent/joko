import { create } from "@bufbuild/protobuf";
import * as wire from "@joko/contracts";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { createMobileGroupMedia } from "./mobile-partner-group-media";

async function fixture() {
  const bytes = Uint8Array.from(await sharp({ create: { width: 4, height: 3, channels: 3, background: "orange" } }).png().toBuffer());
  const blob = create(wire.BlobRefSchema, { blobId: "group-image-blob", fileName: "picture.png", mediaType: "image/png", byteSize: BigInt(bytes.length), sha256Hex: createHash("sha256").update(bytes).digest("hex") });
  const attachment = create(wire.PartnerGroupAttachmentSchema, { id: "group-image", name: blob.fileName, blob, category: wire.PartnerGroupAttachmentCategory.IMAGE });
  const message = create(wire.PartnerGroupMessageSchema, { id: "group-message", sequence: 2n, attachments: [attachment] }), group = create(wire.PartnerGroupSummarySchema, { id: "group", revision: { value: 1n } });
  let visible = true, current = true, next = 0;
  const get = vi.fn(async () => create(wire.GetPartnerGroupResponseSchema, { detail: { group, messages: visible ? [message] : [] } }));
  const download = vi.fn(async () => ({ bytes, mediaType: blob.mediaType }));
  const tools = createMobileGroupMedia({ ownerKey: "group-owner", api: { get } as unknown as wire.PartnerGroupApi,
    newId: () => `media-${++next}`, current: signal => { signal.throwIfAborted(); if (!current) throw new Error("Owner changed"); },
    thumbnail: async () => undefined, download, authorize: vi.fn() });
  return { tools, group, message, attachment, bytes, blob, get, download, hide: () => { visible = false; }, retire: () => { current = false; } };
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

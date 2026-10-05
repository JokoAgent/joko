import { Code } from "@connectrpc/connect";
import { ImageThumbnailUnavailableReason } from "@joko/contracts";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorE2eFixture, sha256 } from "./fixture.js";

describe("canonical image thumbnail HTTP product chain", () => {
  let fixture: OrchestratorE2eFixture | undefined;
  afterEach(async () => { await fixture?.close(); fixture = undefined; });

  it("renders an animated file's first frame over authenticated HTTP while retaining the exact original animation and static chat policy", async () => {
    fixture = await OrchestratorE2eFixture.start(); const paired = await fixture.pair("File thumbnail owner");
    const frame = (pixel: number) => [33, 249, 4, 0, 10, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, pixel, 1, 0];
    const bytes = Uint8Array.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 255, 0, 0, 0, 0, 255, ...frame(68), ...frame(76), 59]);
    const begun = await paired.clients.artifact.beginBlobUpload({ fileName: "animation.gif", mediaType: "image/gif", byteSize: BigInt(bytes.length), sha256Hex: sha256(bytes) });
    const uploaded = await fetch(`${fixture.baseUrl}${begun.upload!.ticket!.relativeEndpoint}`, { method: "PUT", headers: { authorization: `Bearer ${paired.authKey}`, "content-type": "application/octet-stream" }, body: bytes.buffer });
    expect(uploaded.status).toBe(201); const { blob } = await paired.clients.artifact.completeBlobUpload({ uploadId: begun.upload!.uploadId });
    const store = fixture.application.store; const before = { count: store.countArtifacts(), cursor: store.getSnapshot().globalCursor };
    const request = { expectedSourceBlob: blob!, maximumEdgePixels: 256 }; const thumbnail = await paired.clients.artifact.getImageThumbnail(request);
    expect(thumbnail.sourceBlob).toEqual(blob); expect(thumbnail.result).toMatchObject({ case: "thumbnail", value: { mediaType: "image/webp", widthPixels: 1, heightPixels: 1, sourceWidthPixels: 1, sourceHeightPixels: 1 } });
    expect((await paired.clients.artifact.getImageThumbnail(request)).result).toEqual(thumbnail.result);
    expect((await paired.clients.artifact.getImageThumbnail({ ...request, maximumEdgePixels: 1024 })).result).toEqual({ case: "unavailable", value: ImageThumbnailUnavailableReason.UNSUPPORTED });
    const original = await paired.clients.artifact.getBlobDownloadTicket({ blobId: blob!.blobId });
    const download = await fetch(`${fixture.baseUrl}${original.ticket!.relativeEndpoint}`, { headers: { authorization: `Bearer ${paired.authKey}` } });
    expect(download.status).toBe(200); expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    expect({ count: store.countArtifacts(), cursor: store.getSnapshot().globalCursor }).toEqual(before);
    await expect(fixture.anonymous.artifact.getImageThumbnail(request)).rejects.toMatchObject({ code: Code.Unauthenticated });
    fixture.application.connections.revoke(paired.connectionId); await expect(paired.clients.artifact.getImageThumbnail(request)).rejects.toMatchObject({ code: Code.Unauthenticated });
  });

  it("uploads a real source, reads authenticated derivatives without new durable records and preserves original downloads", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const paired = await fixture.pair("Thumbnail owner");
    const bytes = rgbPng(1400, 700);
    const begun = await paired.clients.artifact.beginBlobUpload({ fileName: "source.png", mediaType: "image/png",
      byteSize: BigInt(bytes.length), sha256Hex: sha256(bytes) });
    const uploaded = await fetch(`${fixture.baseUrl}${begun.upload!.ticket!.relativeEndpoint}`, { method: "PUT",
      headers: { authorization: `Bearer ${paired.authKey}`, "content-type": "application/octet-stream" },
      body: Uint8Array.from(bytes).buffer });
    expect(uploaded.status).toBe(201);
    const { blob } = await paired.clients.artifact.completeBlobUpload({ uploadId: begun.upload!.uploadId });
    expect(blob).toMatchObject({ fileName: "source.png", sha256Hex: sha256(bytes), mediaType: "image/png" });

    const store = fixture.application.store;
    const records = () => ({ artifacts: store.countArtifacts(), eventCursor: store.getSnapshot().globalCursor });
    const before = records();
    const request = { expectedSourceBlob: blob!, maximumEdgePixels: 1024 };
    const response = await paired.clients.artifact.getImageThumbnail(request);
    expect(response.sourceBlob).toEqual(blob);
    expect(response.result.case).toBe("thumbnail");
    if (response.result.case !== "thumbnail") throw new Error("Thumbnail missing.");
    const image = response.result.value;
    expect(image).toMatchObject({ mediaType: "image/webp", widthPixels: 1024, heightPixels: 512,
      sourceWidthPixels: 1400, sourceHeightPixels: 700, sha256Hex: sha256(image.data) });
    expect(Buffer.from(image.data.subarray(0, 4)).toString("ascii")).toBe("RIFF");
    expect(Buffer.from(image.data.subarray(8, 12)).toString("ascii")).toBe("WEBP");
    expect((await paired.clients.artifact.getImageThumbnail(request)).result).toEqual(response.result);
    expect((await paired.clients.artifact.getImageThumbnail({ ...request, maximumEdgePixels: 256 })).result)
      .toMatchObject({ case: "thumbnail", value: { widthPixels: 256, heightPixels: 128 } });
    await expect(paired.clients.artifact.getImageThumbnail({ ...request, expectedSourceBlob: { ...blob!, sha256Hex: "a".repeat(64) } }))
      .rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(fixture.anonymous.artifact.getImageThumbnail(request)).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(records()).toEqual(before);

    const original = await paired.clients.artifact.getBlobDownloadTicket({ blobId: blob!.blobId });
    const downloaded = await fetch(`${fixture.baseUrl}${original.ticket!.relativeEndpoint}`, {
      headers: { authorization: `Bearer ${paired.authKey}` } });
    expect(downloaded.status).toBe(200); expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
    fixture.application.connections.revoke(paired.connectionId);
    await expect(paired.clients.artifact.getImageThumbnail(request)).rejects.toMatchObject({ code: Code.Unauthenticated });
  });
});

/** A valid RGB PNG fixture independent of the service's image transformer. */
function rgbPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * (1 + width * 3) + 1 + x * 3; rows[index] = x % 256; rows[index + 1] = y % 256; rows[index + 2] = 130;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]); const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); body.copy(result, 4); let crc = 0xffff_ffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb8_8320 ^ (crc >>> 1) : crc >>> 1; }
  result.writeUInt32BE((crc ^ 0xffff_ffff) >>> 0, result.length - 4); return result;
}

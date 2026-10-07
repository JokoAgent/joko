import { create } from "@bufbuild/protobuf";
import { EventSchema, MessageRole } from "@joko/contracts";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { animatedPngBytes, gifBytes, svgBytes, bmpBytes, tiffBytes, isoImageBytes, iconBytes, iconDibBytes } from "./test/image-formats";
import { producedArtifactEvent, producedImageEvent, toolMediaEvent } from "./test/timeline-media";
import {
  confirmMobileImageGalleryCanvas,
  inspectMobileImageGalleryBytes,
  mobileImageGalleryDimensionsMatch,
  mobileImageGalleryMediaType,
  mobileTimelineGalleryPages,
  mobileTimelineGalleryWindowKey
} from "./mobile-image-gallery";

const sha = "a".repeat(64);

describe("mobile image gallery", () => {
  it("preserves typed tool, produced artifact and produced image source identities without interpreting URLs", () => {
    const message = create(EventSchema, { eventId: "canonical", identity: { sessionId: "session" },
      cursor: { generation: 1n, sequence: 1n }, payload: { kind: { case: "messageCompleted", value: {
        messageId: "message", role: MessageRole.ASSISTANT, blocks: [{ content: { case: "image", value: {
          altText: "Picture", blob: { blobId: "image", fileName: "image.png", mediaType: "image/png", byteSize: 128n, sha256Hex: sha }
        } } }]
      } } }
    });
    const tool = toolMediaEvent(message);
    expect(mobileTimelineGalleryPages(tool)).toMatchObject([{ title: "Picture", source: { kind: "tool", eventId: "canonical", contentIndex: 0 } }]);
    expect(mobileTimelineGalleryPages(producedArtifactEvent(message))).toMatchObject([{
      source: { kind: "artifactProduced", artifactId: "canonical-file" }
    }]);
    expect(mobileTimelineGalleryPages(producedImageEvent(message))).toMatchObject([{
      source: { kind: "imageProduced", messageId: "message" }
    }]);
    if (tool.payload?.kind.case !== "toolCallCompleted") throw new Error("fixture");
    tool.payload.kind.value.toolCall!.runId = "foreign";
    expect(mobileTimelineGalleryPages(tool)).toEqual([]);
  });
  it("accepts bounded static JPEG, PNG, and WebP bytes while rejecting malformed animation and mismatched MIME", () => {
    expect(inspectMobileImageGalleryBytes(png(40, 30), "image/png"))
      .toEqual({ mediaType: "image/png", width: 40, height: 30 });
    expect(inspectMobileImageGalleryBytes(jpeg(320, 240), "image/jpeg"))
      .toEqual({ mediaType: "image/jpeg", width: 320, height: 240 });
    expect(inspectMobileImageGalleryBytes(webpExtended(90, 50), "image/webp"))
      .toEqual({ mediaType: "image/webp", width: 90, height: 50 });
    expect(() => inspectMobileImageGalleryBytes(webpExtended(90, 50, true), "image/webp"))
      .toThrow(/signature or dimensions/u);
    expect(() => inspectMobileImageGalleryBytes(png(40, 30), "image/jpeg"))
      .toThrow(/signature or dimensions/u);
    expect(mobileImageGalleryMediaType("image/gif")).toBe("image/gif");
    expect(mobileImageGalleryMediaType("image/svg+xml")).toBe("image/svg+xml");
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("matches the decoded canvas of a real JPEG with EXIF orientation %s", async (orientation) => {
    const bytes = await sharp({ create: { width: 6, height: 4, channels: 3, background: "#ff9800" } })
      .withMetadata({ orientation }).jpeg().toBuffer();
    const pixels = await sharp(bytes).autoOrient().raw().toBuffer({ resolveWithObject: true });
    expect(inspectMobileImageGalleryBytes(bytes, "image/jpeg"))
      .toEqual({ mediaType: "image/jpeg", width: pixels.info.width, height: pixels.info.height });
  });

  it.each(["png", "webp"] as const)("confirms only the raw or EXIF-declared canvas of static %s", async (format) => {
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const bytes = await sharp({ create: { width: 6, height: 4, channels: 3, background: "orange" } })
        .withMetadata({ orientation }).toFormat(format).toBuffer();
      const original = Uint8Array.from(bytes);
      const image = inspectMobileImageGalleryBytes(bytes, "image/" + format);
      expect(image).toEqual({ mediaType: "image/" + format, width: 6, height: 4,
        ...(orientation >= 5 ? { nativeQuarterTurn: true } : {}) });
      const rotated = await sharp(bytes).autoOrient().toBuffer({ resolveWithObject: true });
      const native = { width: rotated.info.width, height: rotated.info.height };
      const confirmed = confirmMobileImageGalleryCanvas(image, native);
      expect(confirmed).toEqual({ mediaType: "image/" + format, ...native });
      expect(confirmMobileImageGalleryCanvas(image, { width: 6, height: 4 })).toMatchObject({ width: 6, height: 4 });
      expect(mobileImageGalleryDimensionsMatch(confirmed, 4, 6)).toBe(native.width === 4);
      expect(() => confirmMobileImageGalleryCanvas(image, { width: 6, height: 5 })).toThrow(/canvas/u);
      expect(Uint8Array.from(bytes)).toEqual(original);
    }
  });

  it("reads bounded primary JPEG orientation in either byte order and before or after the frame header", () => {
    const frame = jpeg(6, 4);
    for (const little of [true, false]) for (const orientation of [undefined, 1, 2, 3, 4, 5, 6, 7, 8]) {
      const header = jpegExifHeader(orientation, little);
      const before = Buffer.concat([frame.subarray(0, 2), header, frame.subarray(2)]);
      const after = Buffer.concat([frame.subarray(0, -2), header, frame.subarray(-2)]);
      for (const bytes of [before, after]) expect(inspectMobileImageGalleryBytes(bytes, "image/jpeg"))
        .toEqual({ mediaType: "image/jpeg", width: (orientation ?? 1) >= 5 ? 4 : 6, height: (orientation ?? 1) >= 5 ? 6 : 4 });
    }
    const header = jpegExifHeader(6, true);
    const outside = Buffer.from(header); outside.writeUInt32LE(header.length, 14);
    const badType = Buffer.from(header); badType.writeUInt16LE(4, 22);
    const duplicate = Buffer.concat([header, header]);
    for (const metadata of [outside, badType, duplicate, jpegExifHeader(9, true)]) {
      expect(() => inspectMobileImageGalleryBytes(Buffer.concat([frame.subarray(0, 2), metadata, frame.subarray(2)]), "image/jpeg"))
        .toThrow(/signature or dimensions/u);
    }
  });

  it("inspects complete GIF and animated PNG frames without flattening their original bytes", async () => {
    expect(inspectMobileImageGalleryBytes(gifBytes(), "image/gif")).toEqual({ mediaType: "image/gif", width: 1, height: 1 });
    expect(inspectMobileImageGalleryBytes(gifBytes(true), "image/gif")).toEqual({ mediaType: "image/gif", width: 1, height: 1, animated: true });
    expect((await sharp(gifBytes(true)).metadata()).pages).toBe(2);
    expect(inspectMobileImageGalleryBytes(animatedPngBytes(), "image/png")).toEqual({ mediaType: "image/png", width: 1, height: 1, animated: true });
    expect(() => inspectMobileImageGalleryBytes(gifBytes(true).slice(0, -1), "image/gif")).toThrow(/truncated/u);
    expect(() => inspectMobileImageGalleryBytes(animatedPngBytes().slice(0, -1), "image/png")).toThrow(/signature/u);
    const outside = gifBytes(); outside[33] = 2;
    expect(() => inspectMobileImageGalleryBytes(outside, "image/gif")).toThrow(/frame dimensions/u);
  });

  it("preserves complete APNG frame streams across empty fdAT fragments before and after their data", async () => {
    const source = Buffer.from(animatedPngBytes());
    const frameOffset = source.indexOf("fdAT") - 4; const frameLength = source.readUInt32BE(frameOffset);
    const compressed = source.subarray(frameOffset + 12, frameOffset + 8 + frameLength);
    const chunk = (type: string, payload: Uint8Array): Buffer => {
      const bytes = Buffer.alloc(12 + payload.length);
      bytes.writeUInt32BE(payload.length); bytes.write(type, 4); bytes.set(payload, 8);
      let crc = 0xffff_ffff;
      for (const byte of bytes.subarray(4, -4)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb8_8320 : 0);
      }
      bytes.writeUInt32BE((crc ^ 0xffff_ffff) >>> 0, bytes.length - 4);
      return bytes;
    };
    const fdAT = (sequence: number, data: Uint8Array = new Uint8Array()): Buffer => {
      const payload = Buffer.alloc(4 + data.length); payload.writeUInt32BE(sequence); payload.set(data, 4);
      return chunk("fdAT", payload);
    };
    const replaceFrameData = (fragments: readonly Uint8Array[]): Buffer => Buffer.concat([
      source.subarray(0, frameOffset), ...fragments, source.subarray(frameOffset + 12 + frameLength)
    ]);
    const readChunks = (bytes: Buffer): { readonly type: string; readonly data: Buffer }[] => {
      const chunks = [];
      for (let offset = 8; offset < bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        chunks.push({ type: bytes.toString("ascii", offset + 4, offset + 8), data: bytes.subarray(offset + 8, offset + 8 + length) });
        offset += 12 + length;
      }
      return chunks;
    };
    const require = createRequire(import.meta.url);
    const canvasPrimitives = createRequire(require.resolve("pdfjs-dist/package.json"))("@napi-rs/canvas") as {
      readonly loadImage: (bytes: Uint8Array) => Promise<{ readonly width: number; readonly height: number }>;
      readonly createCanvas: (width: number, height: number) => {
        readonly getContext: (kind: "2d") => {
          readonly drawImage: (image: { readonly width: number; readonly height: number }, x: number, y: number) => void;
          readonly getImageData: (x: number, y: number, width: number, height: number) => { readonly data: Uint8ClampedArray };
        };
      };
    };
    for (const [before, after] of [[true, false], [false, true], [true, true]] as const) {
      let sequence = 2; const fragments = [];
      if (before) fragments.push(fdAT(sequence++));
      fragments.push(fdAT(sequence++, compressed));
      if (after) fragments.push(fdAT(sequence));
      const bytes = replaceFrameData(fragments); const preserved = Buffer.from(bytes);
      const inspected = inspectMobileImageGalleryBytes(bytes, "image/png");
      expect(inspected).toEqual({ mediaType: "image/png", width: 1, height: 1, animated: true });
      expect(inspectMobileImageGalleryBytes(bytes, "image/apng")).toMatchObject({ mediaType: "image/apng", previewMediaType: "image/png", animated: true });
      const chunks = readChunks(bytes);
      expect(inflateSync(Buffer.concat(chunks.filter((part) => part.type === "IDAT").map((part) => part.data))))
        .toEqual(Buffer.from([0, 255, 0, 0, 255]));
      expect(inflateSync(Buffer.concat(chunks.filter((part) => part.type === "fdAT").map((part) => part.data.subarray(4)))))
        .toEqual(Buffer.from([0, 0, 255, 0, 255]));
      const controls = chunks.filter((part) => part.type === "fcTL");
      expect(controls.map((part) => part.data)).toEqual(readChunks(source).filter((part) => part.type === "fcTL").map((part) => part.data));
      expect(controls.map((part) => part.data.readUInt16BE(20) * 1_000 / part.data.readUInt16BE(22))).toEqual([100, 100]);
      expect(chunks.find((part) => part.type === "acTL")!.data.readUInt32BE(4)).toBe(0);
      const nativeImage = await canvasPrimitives.loadImage(bytes);
      expect(confirmMobileImageGalleryCanvas(inspected, nativeImage)).toEqual(inspected);
      const context = canvasPrimitives.createCanvas(nativeImage.width, nativeImage.height).getContext("2d");
      context.drawImage(nativeImage, 0, 0);
      expect(Array.from(context.getImageData(0, 0, 1, 1).data)).toEqual([255, 0, 0, 255]);
      expect(bytes).toEqual(preserved);
    }
    const truncated = Buffer.from(fdAT(2, compressed)); truncated.writeUInt32BE(truncated.length, 0);
    for (const bytes of [
      replaceFrameData([chunk("fdAT", Uint8Array.from([0, 0, 2]))]),
      replaceFrameData([fdAT(3, compressed)]),
      replaceFrameData([fdAT(2), fdAT(2, compressed)]),
      replaceFrameData([fdAT(2), fdAT(3)]),
      replaceFrameData([truncated])
    ]) expect(() => inspectMobileImageGalleryBytes(bytes, "image/png")).toThrow(/signature/u);
  });

  it("accepts real extended static and animated WebP while checking each frame rectangle", async () => {
    const staticBytes = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 255, g: 152, b: 0, alpha: 0.5 } } }).webp().toBuffer();
    expect(inspectMobileImageGalleryBytes(staticBytes, "image/webp")).toEqual({ mediaType: "image/webp", width: 3, height: 2 });
    const moving = await sharp(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]), { raw: { width: 1, height: 2, channels: 4, pageHeight: 1 } })
      .webp({ loop: 0, delay: [100, 100] }).toBuffer();
    expect((await sharp(moving).metadata()).pages).toBe(2);
    expect(inspectMobileImageGalleryBytes(moving, "image/webp")).toEqual({ mediaType: "image/webp", width: 1, height: 1, animated: true });
    const outside = Uint8Array.from(moving); const frame = Buffer.from(outside).indexOf("ANMF"); outside[frame + 10] = 1;
    expect(() => inspectMobileImageGalleryBytes(outside, "image/webp")).toThrow(/signature/u);
  });

  it("preserves real animated WebP frames with bounded unknown trailers after their bitstream", async () => {
    const pixels = Buffer.from([
      ...Array.from({ length: 4 }, () => [255, 0, 0, 255]).flat(),
      ...Array.from({ length: 4 }, () => [0, 255, 0, 255]).flat()
    ]);
    const source = await sharp(pixels, { raw: { width: 2, height: 4, channels: 4, pageHeight: 2 } })
      .webp({ lossless: true, loop: 0, delay: [100, 125] }).toBuffer();
    const frameOffset = source.indexOf("ANMF");
    expect(frameOffset).toBeGreaterThan(0);
    const frameLength = source.readUInt32LE(frameOffset + 4);
    const bitstream = source.subarray(frameOffset + 24, frameOffset + 8 + frameLength);
    const chunk = (type: string, payload: Uint8Array): Buffer => {
      const bytes = Buffer.alloc(8 + payload.length + payload.length % 2);
      bytes.write(type); bytes.writeUInt32LE(payload.length, 4); bytes.set(payload, 8);
      return bytes;
    };
    const withFrameData = (data: Uint8Array, encoded = source): Buffer => {
      const offset = encoded.indexOf("ANMF"); const length = encoded.readUInt32LE(offset + 4);
      const header = encoded.subarray(offset + 8, offset + 24);
      const bytes = Buffer.concat([encoded.subarray(0, offset), chunk("ANMF", Buffer.concat([header, data])),
        encoded.subarray(offset + 8 + length + length % 2)]);
      bytes.writeUInt32LE(bytes.length - 8, 4);
      return bytes;
    };
    const unknown = chunk("JUNK", Uint8Array.from([1, 2, 3]));
    const original = withFrameData(Buffer.concat([bitstream, unknown, chunk("DATA", new Uint8Array())]));
    const preserved = Buffer.from(original);
    const inspected = inspectMobileImageGalleryBytes(original, "image/webp");
    expect(inspected).toEqual({ mediaType: "image/webp", width: 2, height: 2, animated: true });
    const decoded = await sharp(original, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 2, height: 4, pageHeight: 2, pages: 2, channels: 4 });
    expect(decoded.data).toEqual(pixels);
    expect((await sharp(original).metadata())).toMatchObject({ width: 2, height: 2, pages: 2, delay: [100, 125], loop: 0 });
    expect(decoded.data).toEqual(await sharp(source, { animated: true }).ensureAlpha().raw().toBuffer());

    const alphaPixels = Buffer.from(pixels);
    for (let index = 3; index < alphaPixels.length; index += 4) alphaPixels[index] = index < 16 ? 128 : 64;
    const alphaSource = await sharp(alphaPixels, { raw: { width: 2, height: 4, channels: 4, pageHeight: 2 } })
      .webp({ loop: 0, delay: [100, 125] }).toBuffer();
    const alphaFrame = alphaSource.indexOf("ANMF"); const alphaFrameLength = alphaSource.readUInt32LE(alphaFrame + 4);
    const alphaData = alphaSource.subarray(alphaFrame + 24, alphaFrame + 8 + alphaFrameLength);
    expect(alphaData.toString("ascii", 0, 4)).toBe("ALPH");
    const alphaChunkLength = 8 + alphaData.readUInt32LE(4) + alphaData.readUInt32LE(4) % 2;
    expect(alphaData.toString("ascii", alphaChunkLength, alphaChunkLength + 4)).toBe("VP8 ");
    const alphaOriginal = withFrameData(Buffer.concat([alphaData, unknown]), alphaSource);
    expect(inspectMobileImageGalleryBytes(alphaOriginal, "image/webp")).toEqual(inspected);
    const alphaDecoded = await sharp(alphaOriginal, { animated: true }).ensureAlpha().raw().toBuffer();
    expect(alphaDecoded).toEqual(await sharp(alphaSource, { animated: true }).ensureAlpha().raw().toBuffer());
    expect(Array.from(alphaDecoded.filter((_, index) => index % 4 === 3)))
      .toEqual(Array.from(alphaPixels.filter((_, index) => index % 4 === 3)));
    expect((await sharp(alphaOriginal).metadata())).toMatchObject({ pages: 2, delay: [100, 125], loop: 0 });

    const require = createRequire(import.meta.url);
    const canvasPrimitives = createRequire(require.resolve("pdfjs-dist/package.json"))("@napi-rs/canvas") as {
      readonly loadImage: (bytes: Uint8Array) => Promise<{ readonly width: number; readonly height: number }>;
      readonly createCanvas: (width: number, height: number) => {
        readonly getContext: (kind: "2d") => {
          readonly drawImage: (image: { readonly width: number; readonly height: number }, x: number, y: number) => void;
          readonly getImageData: (x: number, y: number, width: number, height: number) => { readonly data: Uint8ClampedArray };
        };
      };
    };
    const nativeImage = await canvasPrimitives.loadImage(original);
    expect(confirmMobileImageGalleryCanvas(inspected, nativeImage)).toEqual(inspected);
    const nativeCanvas = canvasPrimitives.createCanvas(nativeImage.width, nativeImage.height);
    const context = nativeCanvas.getContext("2d"); context.drawImage(nativeImage, 0, 0);
    expect(Array.from(context.getImageData(0, 0, 2, 2).data)).toEqual(Array.from(pixels.subarray(0, 16)));
    expect(original).toEqual(preserved);

    const oversized = Buffer.from(unknown); oversized.writeUInt32LE(0xffff_ffff, 4);
    const invalid = [
      withFrameData(Buffer.concat([unknown, bitstream])),
      withFrameData(Buffer.concat([bitstream, unknown, bitstream])),
      withFrameData(unknown),
      withFrameData(Buffer.concat([bitstream, unknown.subarray(0, -1)])),
      withFrameData(Buffer.concat([bitstream, oversized])),
      withFrameData(Buffer.concat([bitstream, unknown.subarray(0, 7)])),
      withFrameData(Buffer.concat([chunk("ALPH", Uint8Array.from([0])), bitstream])),
      ...["VP8X", "ICCP", "ANIM", "ANMF", "EXIF", "XMP ", "ALPH"].map((type) =>
        withFrameData(Buffer.concat([bitstream, chunk(type, Uint8Array.from([1, 2, 3]))])))
    ];
    for (const bytes of invalid) expect(() => inspectMobileImageGalleryBytes(bytes, "image/webp")).toThrow(/signature/u);
  });

  it("bounds self-contained SVG previews and gives both native decoders the same canvas", () => {
    const decoded = inspectMobileImageGalleryBytes(svgBytes('<defs><linearGradient id="paint"/></defs><rect width="20" height="10" fill="url(#paint)"/>'), "image/svg+xml");
    expect(decoded).toMatchObject({ mediaType: "image/svg+xml", width: 40, height: 20 });
    expect(decoded.previewMarkup).toContain('viewBox="0 0 40 20"');
    expect(decoded.previewMarkup).toContain('viewBox="0 0 20 10"');
    expect(inspectMobileImageGalleryBytes(new TextEncoder().encode('<svg viewBox="0 0 12 8"><path d="M0 0 L12 8"/></svg>'), "image/svg+xml"))
      .toMatchObject({ width: 12, height: 8 });
    for (const body of ['<script/>', '<rect onload="alert(1)"/>', '<image href="https://example.com/picture.png"/>',
      '<rect fill="u\\72l(https://example.com/picture)"/>', '<style><![CDATA[@im]]><!-- split -->port "https://example.com/style";</style>',
      '<set attributeName="href" to="https://example.com/picture"/>', '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>']) {
      expect(() => inspectMobileImageGalleryBytes(svgBytes(body), "image/svg+xml"), body).toThrow(/self-contained/u);
    }
    expect(() => inspectMobileImageGalleryBytes(new TextEncoder().encode('<!DOCTYPE svg><svg/>'), "image/svg+xml")).toThrow(/self-contained/u);
    expect(() => inspectMobileImageGalleryBytes(new TextEncoder().encode('<svg width="20000" height="10"/>'), "image/svg+xml")).toThrow(/safe decode/u);
  });

  it("projects the canonical container formats without changing their MIME or original bytes", () => {
    const fixtures = [
      { mediaType: "image/bmp", bytes: bmpBytes(3, 2) }, { mediaType: "image/tiff", bytes: tiffBytes(3, 2) },
      { mediaType: "image/avif", bytes: isoImageBytes(["avif"], 3, 2) }, { mediaType: "image/heic", bytes: isoImageBytes(["heic", "mif1"], 3, 2) },
      { mediaType: "image/heif", bytes: isoImageBytes(["mif1"], 3, 2) }
    ];
    for (const { bytes, mediaType } of fixtures) {
      const original = Uint8Array.from(bytes);
      expect(mobileImageGalleryMediaType(mediaType)).toBe(mediaType);
      expect(inspectMobileImageGalleryBytes(bytes, mediaType)).toEqual({ mediaType, width: 3, height: 2 });
      expect(bytes).toEqual(original);
      expect(() => inspectMobileImageGalleryBytes(bytes.slice(0, 11), mediaType)).toThrow(/invalid/u);
    }
    expect(inspectMobileImageGalleryBytes(animatedPngBytes(), "image/apng"))
      .toMatchObject({ mediaType: "image/apng", width: 1, height: 1, animated: true, previewMediaType: "image/png" });
    expect(() => inspectMobileImageGalleryBytes(png(1, 1), "image/apng")).toThrow(/signature/u);
    expect(() => inspectMobileImageGalleryBytes(isoImageBytes(["heic"], 3, 2), "image/avif")).toThrow(/signature/u);
    expect(() => inspectMobileImageGalleryBytes(isoImageBytes(["avif"], 20_000, 2), "image/avif")).toThrow(/safe decode/u);
  });

  it("preserves the native-decodable abbreviated BMP family and requires its exact canvas", async () => {
    const require = createRequire(import.meta.url);
    const canvasPrimitives = createRequire(require.resolve("pdfjs-dist/package.json"))("@napi-rs/canvas") as {
      readonly loadImage: (bytes: Uint8Array) => Promise<{ readonly width: number; readonly height: number }>;
      readonly createCanvas: (width: number, height: number) => {
        readonly getContext: (kind: "2d") => {
          readonly drawImage: (image: { readonly width: number; readonly height: number }, x: number, y: number) => void;
          readonly getImageData: (x: number, y: number, width: number, height: number) => { readonly data: Uint8ClampedArray };
        };
      };
    };
    const encode = (headerSize: number): Buffer => {
      const pixelOffset = 14 + headerSize;
      const bytes = Buffer.alloc(pixelOffset + 36);
      bytes.write("BM"); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(pixelOffset, 10);
      bytes.writeUInt32LE(headerSize, 14); bytes.writeInt32LE(4, 18); bytes.writeInt32LE(3, 22);
      bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28);
      for (let offset = pixelOffset; offset < bytes.length; offset += 3) bytes.set([0, 152, 255], offset);
      return bytes;
    };
    for (const headerSize of [16, 20, 24, 28, 32, 36]) {
      const bytes = encode(headerSize); const original = Uint8Array.from(bytes);
      const raster = await canvasPrimitives.loadImage(bytes);
      expect({ width: raster.width, height: raster.height }).toEqual({ width: 4, height: 3 });
      const context = canvasPrimitives.createCanvas(raster.width, raster.height).getContext("2d");
      context.drawImage(raster, 0, 0);
      const pixels = context.getImageData(0, 0, raster.width, raster.height).data;
      expect([...pixels]).toEqual(Array.from({ length: 12 }, () => [255, 152, 0, 255]).flat());
      const inspected = inspectMobileImageGalleryBytes(bytes, "image/bmp");
      expect(inspected).toEqual({ mediaType: "image/bmp", width: 4, height: 3 });
      expect(confirmMobileImageGalleryCanvas(inspected, raster)).toEqual(inspected);
      expect(() => confirmMobileImageGalleryCanvas(inspected, { width: 3, height: 4 })).toThrow(/canvas/u);
      expect(bytes).toEqual(Buffer.from(original));
      expect(() => inspectMobileImageGalleryBytes(bytes.subarray(0, 29), "image/bmp")).toThrow(/signature/u);
    }
    for (const headerSize of [17, 18, 22, 30, 38]) {
      expect(() => inspectMobileImageGalleryBytes(encode(headerSize), "image/bmp")).toThrow(/signature/u);
    }
    const source = encode(16);
    for (const mutate of [
      (bytes: Buffer) => bytes.writeUInt32LE(bytes.length - 1, 2),
      (bytes: Buffer) => bytes.writeUInt32LE(29, 10),
      (bytes: Buffer) => bytes.writeUInt32LE(bytes.length, 10),
      (bytes: Buffer) => bytes.writeInt32LE(0, 18),
      (bytes: Buffer) => bytes.writeInt32LE(-1, 18),
      (bytes: Buffer) => bytes.writeInt32LE(0, 22),
      (bytes: Buffer) => bytes.writeUInt16LE(0, 26),
      (bytes: Buffer) => bytes.writeUInt16LE(2, 26),
      (bytes: Buffer) => bytes.writeUInt16LE(0, 28),
      (bytes: Buffer) => bytes.writeUInt16LE(2, 28)
    ]) {
      const invalid = Buffer.from(source); mutate(invalid);
      expect(() => inspectMobileImageGalleryBytes(invalid, "image/bmp")).toThrow(/signature/u);
    }
    const oversized = Buffer.from(source); oversized.writeInt32LE(20_000, 18);
    expect(() => inspectMobileImageGalleryBytes(oversized, "image/bmp")).toThrow(/safe decode/u);
  });

  it("binds ISO dimensions to the primary item's exact property associations, crop and rotation", () => {
    const bytes = isoImageBytes(["avif"], 80, 60, { thumbnail: { width: 200, height: 150 }, crop: { width: 40, height: 30 }, rotate: 1, wideAssociations: true });
    expect(inspectMobileImageGalleryBytes(bytes, "image/avif")).toEqual({ mediaType: "image/avif", width: 30, height: 40 });
    const missing = Uint8Array.from(bytes); const pitm = Buffer.from(missing).indexOf("pitm"); missing[pitm + 9] = 99;
    expect(() => inspectMobileImageGalleryBytes(missing, "image/avif")).toThrow(/signature/u);
    const wrongProperty = Uint8Array.from(bytes); const ipma = Buffer.from(wrongProperty).indexOf("ipma"); wrongProperty[ipma + 16] = 127;
    expect(() => inspectMobileImageGalleryBytes(wrongProperty, "image/avif")).toThrow(/signature/u);
    expect(() => inspectMobileImageGalleryBytes(isoImageBytes(["avif"], 80, 60, { crop: { width: 90, height: 60 } }), "image/avif")).toThrow(/signature/u);
    expect(() => inspectMobileImageGalleryBytes(isoImageBytes(["avif", "avis"], 3, 2), "image/avif"))
      .toThrow(/signature/u);
  });

  it("accepts one bounded classic TIFF image and leaves complex documents as files", () => {
    for (const littleEndian of [false, true]) {
      expect(inspectMobileImageGalleryBytes(tiffBytes(4, 3, { littleEndian, orientation: 6 }), "image/tiff"))
        .toEqual({ mediaType: "image/tiff", width: 3, height: 4 });
    }
    expect(() => inspectMobileImageGalleryBytes(tiffBytes(4, 3, { big: true }), "image/tiff")).toThrow(/signature/u);
    expect(() => inspectMobileImageGalleryBytes(tiffBytes(4, 3, { additionalPages: 1 }), "image/tiff")).toThrow(/signature/u);
    expect(() => inspectMobileImageGalleryBytes(tiffBytes(4, 3, { leadingThumbnail: true }), "image/tiff")).toThrow(/signature/u);
    const cycle = tiffBytes(4, 3); new DataView(cycle.buffer).setUint32(cycle.length - 4, 8, true);
    expect(() => inspectMobileImageGalleryBytes(cycle, "image/tiff")).toThrow(/signature/u);
    expect(() => inspectMobileImageGalleryBytes(tiffBytes(4, 3).slice(0, -1), "image/tiff")).toThrow(/signature/u);
  });

  it("previews the largest exact PNG icon entry and refuses overlap, mismatched entry dimensions, or animated payloads", async () => {
    const full = await sharp({ create: { width: 256, height: 256, channels: 4, background: "#ff9800" } }).png().toBuffer();
    const bytes = iconBytes([{ bytes: iconDibBytes(1, 1), width: 1, height: 1 }, { bytes: full, width: 256, height: 256 }]);
    for (const mediaType of ["image/x-icon", "image/vnd.microsoft.icon"]) {
      const decoded = inspectMobileImageGalleryBytes(bytes, mediaType);
      expect(decoded).toMatchObject({ mediaType, width: 256, height: 256, originalOnly: true, previewMediaType: "image/png" });
      expect(decoded.previewBytes).toEqual(Uint8Array.from(full));
    }
    const overlap = Uint8Array.from(bytes); new DataView(overlap.buffer).setUint32(34, 38, true);
    expect(() => inspectMobileImageGalleryBytes(overlap, "image/x-icon")).toThrow(/signature/u);
    expect(() => inspectMobileImageGalleryBytes(iconBytes([{ bytes: full, width: 255, height: 256 }]), "image/x-icon")).toThrow(/signature/u);
    expect(() => inspectMobileImageGalleryBytes(iconBytes([{ bytes: animatedPngBytes(), width: 1, height: 1 }]), "image/x-icon")).toThrow(/signature/u);
  });

  it("composites icon DIB palettes, color depth, alpha and AND masks into a real portable PNG", async () => {
    for (const bits of [1, 4, 8, 16, 24, 32]) {
      const bytes = iconBytes([{ bytes: iconDibBytes(3, 2, bits), width: 3, height: 2, bits }]);
      const decoded = inspectMobileImageGalleryBytes(bytes, "image/x-icon");
      expect(decoded).toMatchObject({ width: 3, height: 2, originalOnly: true, previewMediaType: "image/png" });
      const pixels = await sharp(decoded.previewBytes!).raw().toBuffer({ resolveWithObject: true });
      expect(pixels.info).toMatchObject({ width: 3, height: 2, channels: 4 }); expect([...pixels.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    }
    for (const [alpha, mask, expected] of [[0, true, 0], [128, true, 128]] as const) {
      const decoded = inspectMobileImageGalleryBytes(iconBytes([{ bytes: iconDibBytes(3, 2, 32, alpha, mask), width: 3, height: 2 }]), "image/x-icon");
      expect((await sharp(decoded.previewBytes!).raw().toBuffer())[3]).toBe(expected);
    }
    const full = inspectMobileImageGalleryBytes(iconBytes([{ bytes: iconDibBytes(256, 256, 32, 128), width: 256, height: 256 }]), "image/x-icon");
    const fullPixels = await sharp(full.previewBytes!).raw().toBuffer();
    expect(fullPixels.length).toBe(256 * 256 * 4); expect([...fullPixels.subarray(-4)]).toEqual([255, 0, 0, 128]);
    const dib = iconDibBytes(3, 2); const bitfields = new Uint8Array(dib.length + 16);
    bitfields.set(dib.subarray(0, 40)); bitfields.set(dib.subarray(40), 56);
    const view = new DataView(bitfields.buffer); view.setUint32(0, 56, true); view.setUint32(16, 3, true);
    [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000].forEach((mask, index) => view.setUint32(40 + index * 4, mask, true));
    for (let index = 56; index < 80; index += 4) bitfields[index + 3] = 128;
    const preview = inspectMobileImageGalleryBytes(iconBytes([{ bytes: bitfields, width: 3, height: 2 }]), "image/x-icon");
    expect([...(await sharp(preview.previewBytes!).raw().toBuffer()).subarray(0, 4)]).toEqual([255, 0, 0, 128]);
  });

  it("keeps ordered unique image pages inside one completed message", () => {
    const event = create(EventSchema, {
      eventId: "done",
      identity: { sessionId: "session" },
      cursor: { generation: 4n, sequence: 9n },
      payload: { kind: { case: "messageCompleted", value: {
        messageId: "message",
        role: MessageRole.ASSISTANT,
        blocks: [
          { content: { case: "text", value: "Here" } },
          { content: { case: "image", value: { blob: {
            blobId: "blob-one", fileName: "one.png", mediaType: "image/png", byteSize: 100n, sha256Hex: sha
          }, widthPixels: 20, heightPixels: 10, altText: "First" } } },
          { content: { case: "image", value: { blob: {
            blobId: "blob-one", fileName: "duplicate.png", mediaType: "image/png", byteSize: 100n, sha256Hex: sha
          }, widthPixels: 20, heightPixels: 10 } } },
          { content: { case: "artifact", value: { blob: {
            blobId: "blob-two", fileName: "two.webp", mediaType: "image/webp", byteSize: 90n,
            sha256Hex: "b".repeat(64)
          }, label: "Second" } } },
          { content: { case: "artifact", value: { blob: {
            blobId: "animated", fileName: "moving.gif", mediaType: "image/gif", byteSize: 80n,
            sha256Hex: "c".repeat(64)
          }, label: "Animated" } } }
        ]
      } } }
    });

    expect(mobileTimelineGalleryPages(event).map((page) => ({
      title: page.title,
      source: page.source,
      mediaType: page.mediaType
    }))).toEqual([
      { title: "First", mediaType: "image/png", source: {
        kind: "timeline", eventId: "done", messageId: "message", contentKind: "block", contentIndex: 1
      } },
      { title: "Second", mediaType: "image/webp", source: {
        kind: "timeline", eventId: "done", messageId: "message", contentKind: "block", contentIndex: 3
      } },
      { title: "Animated", mediaType: "image/gif", source: {
        kind: "timeline", eventId: "done", messageId: "message", contentKind: "block", contentIndex: 4
      } }
    ]);
  });

  it("projects only authoritative accepted user images before a completion event exists", () => {
    const accepted = create(EventSchema, {
      eventId: "accepted",
      identity: { sessionId: "session" },
      cursor: { generation: 1n, sequence: 3n },
      payload: { kind: { case: "messageStarted", value: {
        messageId: "user-message",
        role: MessageRole.USER,
        userInputAccepted: true,
        userInput: { parts: [{ content: { case: "image", value: { blob: {
          blobId: "accepted-image", fileName: "accepted.png", mediaType: "image/png",
          byteSize: 68n, sha256Hex: sha
        }, widthPixels: 0, heightPixels: 0, altText: "Accepted image" } } }] }
      } } }
    });
    const imported = create(EventSchema, {
      eventId: "imported",
      identity: { sessionId: "session" },
      cursor: { generation: 1n, sequence: 4n },
      payload: { kind: { case: "messageStarted", value: {
        messageId: "imported-message",
        role: MessageRole.USER,
        userInputAccepted: false,
        userInput: { parts: [{ content: { case: "image", value: { blob: {
          blobId: "imported-image", fileName: "imported.png", mediaType: "image/png",
          byteSize: 68n, sha256Hex: sha
        }, widthPixels: 1, heightPixels: 1, altText: "Imported image" } } }] }
      } } }
    });

    expect(mobileTimelineGalleryPages(accepted)).toMatchObject([{
      title: "Accepted image",
      source: {
        kind: "timeline",
        eventId: "accepted",
        messageId: "user-message",
        contentKind: "inputPart",
        contentIndex: 0
      }
    }]);
    expect(mobileTimelineGalleryPages(imported)).toEqual([]);
  });

  it("changes the frozen source-window identity when a durable event is added", () => {
    const first = create(EventSchema, {
      eventId: "one", identity: { sessionId: "session" }, cursor: { generation: 1n, sequence: 1n },
      payload: { kind: { case: "runDone", value: { runId: "run" } } }
    });
    const second = create(EventSchema, {
      eventId: "two", identity: { sessionId: "session" }, cursor: { generation: 1n, sequence: 2n },
      payload: { kind: { case: "runDone", value: { runId: "run" } } }
    });
    expect(mobileTimelineGalleryWindowKey([first, second]))
      .not.toBe(mobileTimelineGalleryWindowKey([first]));
    expect(mobileTimelineGalleryWindowKey([first, first]))
      .toBe(mobileTimelineGalleryWindowKey([first]));
  });
});

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  writeU32Be(bytes, 8, 13);
  bytes.set([73, 72, 68, 82], 12);
  writeU32Be(bytes, 16, width);
  writeU32Be(bytes, 20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  writeU32Be(bytes, 33, 0);
  bytes.set([73, 69, 78, 68], 37);
  return bytes;
}

function jpegExifHeader(orientation: number | undefined, little: boolean): Buffer {
  const header = Buffer.alloc(orientation === undefined ? 24 : 36);
  header.set([0xff, 0xe1]); header.writeUInt16BE(header.length - 2, 2); header.write("Exif\0\0", 4);
  header.write(little ? "II" : "MM", 10);
  const view = new DataView(header.buffer, header.byteOffset + 10, header.byteLength - 10);
  view.setUint16(2, 42, little); view.setUint32(4, 8, little);
  if (orientation !== undefined) {
    view.setUint16(8, 1, little); view.setUint16(10, 0x0112, little); view.setUint16(12, 3, little);
    view.setUint32(14, 1, little); view.setUint16(18, orientation, little);
  }
  return header;
}

function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    height >>> 8, height & 0xff, width >>> 8, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9
  ]);
}

function webpExtended(width: number, height: number, animated = false): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([82, 73, 70, 70], 0);
  writeU32Le(bytes, 4, 22);
  bytes.set([87, 69, 66, 80, 86, 80, 56, 88], 8);
  writeU32Le(bytes, 16, 10);
  bytes[20] = animated ? 0x02 : 0;
  writeU24Le(bytes, 24, width - 1);
  writeU24Le(bytes, 27, height - 1);
  return bytes;
}

function writeU24Le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8 & 0xff;
  bytes[offset + 2] = value >>> 16 & 0xff;
}

function writeU32Be(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24 & 0xff;
  bytes[offset + 1] = value >>> 16 & 0xff;
  bytes[offset + 2] = value >>> 8 & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeU32Le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8 & 0xff;
  bytes[offset + 2] = value >>> 16 & 0xff;
  bytes[offset + 3] = value >>> 24 & 0xff;
}

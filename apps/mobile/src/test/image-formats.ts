import { deflateSync } from "node:zlib";

/** A complete two-frame RGBA PNG with real zlib streams and chunk checksums. */
export function animatedPngBytes(): Uint8Array {
  const ihdr = new Uint8Array(13); writeU32(ihdr, 0, 1); writeU32(ihdr, 4, 1); ihdr.set([8, 6], 8);
  const control = new Uint8Array(8); writeU32(control, 0, 2);
  const frame = (sequence: number) => {
    const value = new Uint8Array(26); writeU32(value, 0, sequence); writeU32(value, 4, 1); writeU32(value, 8, 1);
    value[21] = 1; value[23] = 10; return value;
  };
  const red = deflateSync(Uint8Array.from([0, 255, 0, 0, 255]));
  const green = deflateSync(Uint8Array.from([0, 0, 255, 0, 255]));
  const second = new Uint8Array(4 + green.length); writeU32(second, 0, 2); second.set(green, 4);
  return concatenate([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("acTL", control),
    chunk("fcTL", frame(0)), chunk("IDAT", red), chunk("fcTL", frame(1)), chunk("fdAT", second), chunk("IEND", new Uint8Array())]);
}

export function gifBytes(animated = false): Uint8Array {
  const header = Uint8Array.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]);
  const frame = (white: boolean) => Uint8Array.from([
    0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, white ? 0x4c : 0x44, 1, 0
  ]);
  return concatenate([header, frame(false), ...(animated ? [frame(true)] : []), Uint8Array.from([0x3b])]);
}

export function svgBytes(body = '<rect width="20" height="10" fill="#ff9800"/>'): Uint8Array {
  return new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 20 10">${body}</svg>`);
}

export function paddedPngBytes(png: Uint8Array, byteSize: number): Uint8Array {
  return concatenate([png.subarray(0, -12), chunk("paDD", new Uint8Array(byteSize - png.length - 12)), png.subarray(-12)]);
}

export function bmpBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(54 + Math.ceil(width * 24 / 32) * 4 * height);
  bytes.set([66, 77]); setU32(bytes, 2, bytes.length, true); setU32(bytes, 10, 54, true); setU32(bytes, 14, 40, true);
  setU32(bytes, 18, width, true); setU32(bytes, 22, height, true); setU16(bytes, 26, 1, true); setU16(bytes, 28, 24, true);
  return bytes;
}

export function tiffBytes(width: number, height: number, options: {
  readonly big?: boolean; readonly littleEndian?: boolean; readonly orientation?: number;
  readonly additionalPages?: number; readonly leadingThumbnail?: boolean
} = {}): Uint8Array {
  const big = options.big === true; const little = options.littleEndian !== false;
  const header = big ? 16 : 8; const entrySize = big ? 20 : 12; const countSize = big ? 8 : 2; const offsetSize = big ? 8 : 4;
  const directorySize = countSize + 4 * entrySize + offsetSize;
  const pages = 1 + (options.additionalPages ?? 0);
  const bytes = new Uint8Array(header + pages * directorySize);
  bytes.set(little ? [73, 73] : [77, 77]); setU16(bytes, 2, big ? 43 : 42, little);
  if (big) setU16(bytes, 4, 8, little);
  const setOffset = (offset: number, value: number) => setU32(bytes, offset + (big && !little ? 4 : 0), value, little);
  setOffset(big ? 8 : 4, header);
  for (let page = 0; page < pages; page++) {
    const start = header + page * directorySize;
    if (big) setOffset(start, 4); else setU16(bytes, start, 4, little);
    const thumbnail = page === 0 && options.leadingThumbnail;
    const entries = [[254, thumbnail ? 1 : 0], [256, thumbnail ? 2 : width], [257, thumbnail ? 1 : height], [274, options.orientation ?? 1]];
    entries.forEach(([tag, value], index) => {
      const offset = start + countSize + index * entrySize;
      setU16(bytes, offset, tag!, little); setU16(bytes, offset + 2, 4, little);
      if (big) setOffset(offset + 4, 1); else setU32(bytes, offset + 4, 1, little);
      setU32(bytes, offset + (big ? 12 : 8), value!, little);
    });
    setOffset(start + countSize + 4 * entrySize, page + 1 < pages ? start + directorySize : 0);
  }
  return bytes;
}

export function isoImageBytes(brands: readonly string[], width: number, height: number, options: {
  readonly thumbnail?: { readonly width: number; readonly height: number };
  readonly rotate?: number; readonly crop?: { readonly width: number; readonly height: number };
  readonly wideAssociations?: boolean
} = {}): Uint8Array {
  const ftyp = imageBox("ftyp", concatenate([imageAscii(brands[0] ?? ""), new Uint8Array(4), ...brands.slice(1).map(imageAscii)]));
  const extent = (w: number, h: number) => { const value = new Uint8Array(12); setU32(value, 4, w, false); setU32(value, 8, h, false); return imageBox("ispe", value); };
  const properties = [...(options.thumbnail ? [extent(options.thumbnail.width, options.thumbnail.height)] : []), extent(width, height)];
  const primaryIndex = properties.length;
  if (options.crop) {
    const value = new Uint8Array(32);
    [options.crop.width, 1, options.crop.height, 1, 0, 1, 0, 1].forEach((number, index) => setU32(value, index * 4, number, false));
    properties.push(imageBox("clap", value));
  }
  if (options.rotate !== undefined) properties.push(imageBox("irot", Uint8Array.from([options.rotate])));
  const wide = options.wideAssociations === true;
  const entry = (id: number, indices: readonly number[]) => {
    const value = new Uint8Array(3 + indices.length * (wide ? 2 : 1)); setU16(value, 0, id, false); value[2] = indices.length;
    indices.forEach((property, index) => wide ? setU16(value, 3 + index * 2, property, false) : value[3 + index] = property); return value;
  };
  const primaryId = options.thumbnail ? 2 : 1;
  const pitm = new Uint8Array(6); setU16(pitm, 4, primaryId, false);
  const associationHeader = new Uint8Array(8); associationHeader[3] = wide ? 1 : 0; setU32(associationHeader, 4, primaryId, false);
  const ipma = imageBox("ipma", concatenate([associationHeader, ...(options.thumbnail ? [entry(1, [1])] : []),
    entry(primaryId, Array.from({ length: properties.length - primaryIndex + 1 }, (_, index) => primaryIndex + index))]));
  return concatenate([ftyp, imageBox("meta", concatenate([new Uint8Array(4), imageBox("pitm", pitm),
    imageBox("iprp", concatenate([imageBox("ipco", concatenate(properties)), ipma]))]))]);
}

export function iconBytes(images: readonly { readonly bytes: Uint8Array; readonly width: number; readonly height: number; readonly bits?: number }[]): Uint8Array {
  const bytes = new Uint8Array(6 + images.length * 16 + images.reduce((total, image) => total + image.bytes.length, 0));
  setU16(bytes, 2, 1, true); setU16(bytes, 4, images.length, true); let payload = 6 + images.length * 16;
  images.forEach((image, index) => {
    const offset = 6 + index * 16; bytes[offset] = image.width === 256 ? 0 : image.width; bytes[offset + 1] = image.height === 256 ? 0 : image.height;
    setU16(bytes, offset + 4, 1, true); setU16(bytes, offset + 6, image.bits ?? 32, true);
    setU32(bytes, offset + 8, image.bytes.length, true); setU32(bytes, offset + 12, payload, true);
    bytes.set(image.bytes, payload); payload += image.bytes.length;
  });
  return bytes;
}

export function iconDibBytes(width: number, height: number, bits = 32, alpha = 255, transparent = false): Uint8Array {
  const colors = bits <= 8 ? 2 ** bits : 0; const stride = Math.ceil(width * bits / 32) * 4; const maskStride = Math.ceil(width / 32) * 4;
  const bytes = new Uint8Array(40 + colors * 4 + stride * height + maskStride * height);
  setU32(bytes, 0, 40, true); setU32(bytes, 4, width, true); setU32(bytes, 8, height * 2, true);
  setU16(bytes, 12, 1, true); setU16(bytes, 14, bits, true);
  for (let index = 0; index < colors; index++) bytes.set([0, 0, 255, 0], 40 + index * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = 40 + colors * 4 + y * stride + x * (bits / 8);
      if (bits === 32) bytes.set([0, 0, 255, alpha], offset);
      else if (bits === 24) bytes.set([0, 0, 255], offset);
      else if (bits === 16) setU16(bytes, offset, 0x7c00, true);
    }
    if (transparent) bytes.fill(255, 40 + colors * 4 + stride * height + y * maskStride, 40 + colors * 4 + stride * height + (y + 1) * maskStride);
  }
  return bytes;
}

function imageBox(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.length); setU32(bytes, 0, bytes.length, false); bytes.set(imageAscii(type), 4); bytes.set(payload, 8); return bytes;
}
function imageAscii(value: string): Uint8Array { return Uint8Array.from([...value].map((character) => character.charCodeAt(0))); }
function setU16(bytes: Uint8Array, offset: number, value: number, little: boolean): void { new DataView(bytes.buffer, bytes.byteOffset + offset, 2).setUint16(0, value, little); }
function setU32(bytes: Uint8Array, offset: number, value: number, little: boolean): void { new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value, little); }

function chunk(type: string, data: Uint8Array): Uint8Array {
  const value = new Uint8Array(12 + data.length); writeU32(value, 0, data.length);
  value.set(new TextEncoder().encode(type), 4); value.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of value.subarray(4, 8 + data.length)) {
    crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  writeU32(value, 8 + data.length, (crc ^ 0xffffffff) >>> 0); return value;
}
function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes.set([value >>> 24 & 255, value >>> 16 & 255, value >>> 8 & 255, value & 255], offset);
}
function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
}

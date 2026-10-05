import { assertMobileImageGalleryDimensions } from "./mobile-image-dimensions";

interface IconImage {
  readonly width: number;
  readonly height: number;
  readonly bits: number;
  readonly bytes: Uint8Array;
  readonly dib?: IconBitmap;
}
interface IconBitmap {
  readonly pixels: number;
  readonly stride: number;
  readonly mask: number;
  readonly maskStride: number;
  readonly palette: number;
  readonly colors: number;
  readonly paletteSize: number;
  readonly topDown: boolean;
  readonly channels?: readonly number[];
}

/** Preview one exact largest icon entry as PNG, so a platform decoder cannot silently select a thumbnail. */
export function inspectMobileIconBytes(bytes: Uint8Array, inspectPng: (bytes: Uint8Array) => {
  readonly width: number; readonly height: number; readonly animated?: boolean
}): { readonly width: number; readonly height: number; readonly previewBytes: Uint8Array; readonly originalOnly: true } | undefined {
  if (u16(bytes, 0) !== 0 || u16(bytes, 2) !== 1) return undefined;
  const count = u16(bytes, 4);
  if (!count || count > 256 || 6 + count * 16 > bytes.length) return undefined;
  const images: IconImage[] = []; const ranges: { start: number; end: number }[] = [];
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 16;
    const width = bytes[offset] || 256; const height = bytes[offset + 1] || 256;
    const length = u32(bytes, offset + 8)!; const start = u32(bytes, offset + 12)!;
    if (bytes[offset + 3] !== 0 || u16(bytes, offset + 4)! > 1 || length < 12
      || start < 6 + count * 16 || length > bytes.length - start
      || ranges.some((range) => start < range.end && start + length > range.start)) return undefined;
    ranges.push({ start, end: start + length });
    const payload = bytes.subarray(start, start + length);
    assertMobileImageGalleryDimensions(width, height);
    if (payload[0] === 137 && payload[1] === 80 && payload[2] === 78 && payload[3] === 71) {
      const png = inspectPng(payload);
      if (png.animated || png.width !== width || png.height !== height) return undefined;
      const channels = [1, 0, 3, 1, 2, 0, 4][payload[25]!] ?? 0;
      const bits = payload[24]! * channels;
      if (!bits || bits > 64) return undefined;
      images.push({ width, height, bits, bytes: payload });
    } else {
      const bits = u16(payload, 14) ?? 0;
      const core = u32(payload, 0) === 12;
      const exactBits = core ? u16(payload, 10) ?? 0 : bits;
      const dib = iconBitmap(payload, width, height, exactBits);
      const advertisedBits = u16(bytes, offset + 6)!;
      if (!dib || advertisedBits !== 0 && advertisedBits !== exactBits) return undefined;
      images.push({ width, height, bits: exactBits, bytes: payload, dib });
    }
  }
  const selected = images.sort((left, right) => right.width * right.height - left.width * left.height || right.bits - left.bits)[0]!;
  return { width: selected.width, height: selected.height, originalOnly: true,
    previewBytes: selected.dib ? bitmapPng(selected) : Uint8Array.from(selected.bytes) };
}

function iconBitmap(bytes: Uint8Array, width: number, height: number, bits: number): IconBitmap | undefined {
  const header = u32(bytes, 0); const core = header === 12;
  if (!header || header > bytes.length || ![12, 40, 52, 56, 108, 124].includes(header)
    || ![1, 4, 8, 16, 24, 32].includes(bits)) return undefined;
  const signedHeight = core ? u16(bytes, 6) : i32(bytes, 8);
  if ((core ? u16(bytes, 4) : i32(bytes, 4)) !== width || !signedHeight || Math.abs(signedHeight) !== height * 2
    || (core ? u16(bytes, 8) : u16(bytes, 12)) !== 1) return undefined;
  const compression = core ? 0 : u32(bytes, 16)!;
  if (compression !== 0 && compression !== 3 && compression !== 6 || compression !== 0 && bits !== 16 && bits !== 32) return undefined;
  let palette = header; let channels: readonly number[] | undefined;
  if (compression === 3 || compression === 6) {
    const count = compression === 6 || header >= 56 && u32(bytes, 52) !== 0 ? 4 : 3;
    if (header === 40) palette += count * 4;
    else if (header < 40 + count * 4) return undefined;
    if (palette > bytes.length) return undefined;
    const masks = Array.from({ length: count }, (_, index) => u32(bytes, 40 + index * 4)!);
    if (masks.some((mask, index) => !mask || bits === 16 && mask > 0xffff
      || masks.slice(0, index).some((prior) => (prior & mask) !== 0) || !contiguousMask(mask))) return undefined;
    channels = masks;
  } else if (bits === 16) channels = [0x7c00, 0x03e0, 0x001f];
  const maximumColors = bits <= 8 ? 2 ** bits : 0;
  const colors = core ? maximumColors : u32(bytes, 32) || maximumColors;
  if (colors > maximumColors) return undefined;
  const paletteSize = core ? 3 : 4;
  const pixels = palette + colors * paletteSize;
  const stride = Math.ceil(width * bits / 32) * 4; const maskStride = Math.ceil(width / 32) * 4;
  const mask = pixels + stride * height;
  if (mask > bytes.length || bits !== 32 && mask + maskStride * height > bytes.length
    || bytes.length !== mask && mask + maskStride * height > bytes.length) return undefined;
  return { pixels, stride, mask, maskStride, palette, colors, paletteSize, topDown: signedHeight < 0,
    ...(channels ? { channels } : {}) };
}

function bitmapPng(image: IconImage): Uint8Array {
  const { bytes, width, height, bits } = image; const dib = image.dib!;
  const rgba = new Uint8Array(width * height * 4); let hasAlpha = dib.channels?.length === 4;
  for (let y = 0; y < height; y++) {
    const row = dib.pixels + (dib.topDown ? y : height - 1 - y) * dib.stride;
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (bits <= 8) {
        const packed = bytes[row + Math.floor(x * bits / 8)]!;
        const color = bits === 8 ? packed : bits === 4 ? packed >>> (x % 2 === 0 ? 4 : 0) & 15 : packed >>> (7 - x % 8) & 1;
        if (color >= dib.colors) throw new Error("The icon palette index is invalid.");
        const entry = dib.palette + color * dib.paletteSize;
        rgba.set([bytes[entry + 2]!, bytes[entry + 1]!, bytes[entry]!, 255], out);
      } else if (dib.channels) {
        const pixel = bits === 16 ? u16(bytes, row + x * 2)! : u32(bytes, row + x * 4)!;
        rgba.set([channel(pixel, dib.channels[0]!), channel(pixel, dib.channels[1]!), channel(pixel, dib.channels[2]!),
          dib.channels[3] ? channel(pixel, dib.channels[3]) : 255], out);
      } else {
        const pixel = row + x * (bits / 8);
        const alpha = bits === 32 ? bytes[pixel + 3]! : 255;
        if (bits === 32 && alpha > 0) hasAlpha = true;
        rgba.set([bytes[pixel + 2]!, bytes[pixel + 1]!, bytes[pixel]!, alpha], out);
      }
    }
  }
  for (let y = 0; y < height; y++) {
    const row = dib.mask + (dib.topDown ? y : height - 1 - y) * dib.maskStride;
    for (let x = 0; x < width; x++) {
      if (hasAlpha) continue;
      const transparent = row < bytes.length && (bytes[row + Math.floor(x / 8)]! & 1 << (7 - x % 8)) !== 0;
      rgba[(y * width + x) * 4 + 3] = transparent ? 0 : 255;
    }
  }
  return rgbaPng(rgba, width, height);
}

function contiguousMask(mask: number): boolean {
  let value = mask >>> 0; while ((value & 1) === 0 && value > 0) value >>>= 1;
  return value > 0 && (value & (value + 1)) === 0;
}
function channel(pixel: number, mask: number): number {
  let shift = 0; while ((mask >>> shift & 1) === 0 && shift < 32) shift++;
  const maximum = mask >>> shift; return Math.round(((pixel & mask) >>> shift) * 255 / maximum);
}

/** A bounded, portable PNG encoder using stored DEFLATE blocks; no Node or native codec dependency. */
function rgbaPng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const scan = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) scan.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const compressed = new Uint8Array(2 + scan.length + Math.ceil(scan.length / 65_535) * 5 + 4);
  compressed.set([0x78, 0x01]); let offset = 2;
  for (let start = 0; start < scan.length; start += 65_535) {
    const length = Math.min(65_535, scan.length - start);
    compressed.set([start + length === scan.length ? 1 : 0, length & 255, length >>> 8, ~length & 255, ~length >>> 8 & 255], offset);
    offset += 5; compressed.set(scan.subarray(start, start + length), offset); offset += length;
  }
  let a = 1; let b = 0;
  for (const byte of scan) { a = (a + byte) % 65_521; b = (b + a) % 65_521; }
  be32(compressed, offset, b * 65_536 + a);
  const ihdr = new Uint8Array(13); be32(ihdr, 0, width); be32(ihdr, 4, height); ihdr.set([8, 6], 8);
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", compressed), pngChunk("IEND", new Uint8Array())];
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0)); let start = 0;
  for (const part of parts) { result.set(part, start); start += part.length; } return result;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12); be32(bytes, 0, data.length);
  bytes.set(new TextEncoder().encode(type), 4); bytes.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, bytes.length - 4)) {
    crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  be32(bytes, bytes.length - 4, (crc ^ 0xffffffff) >>> 0); return bytes;
}
function be32(bytes: Uint8Array, offset: number, value: number): void { new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value, false); }
function u16(bytes: Uint8Array, offset: number): number | undefined {
  return offset >= 0 && offset + 2 <= bytes.length ? new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true) : undefined;
}
function u32(bytes: Uint8Array, offset: number): number | undefined {
  return offset >= 0 && offset + 4 <= bytes.length ? new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true) : undefined;
}
function i32(bytes: Uint8Array, offset: number): number | undefined { const value = u32(bytes, offset); return value === undefined ? undefined : value > 0x7fffffff ? value - 0x100000000 : value; }

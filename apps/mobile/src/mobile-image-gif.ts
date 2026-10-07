export interface MobileGifDimensions {
  readonly width: number; readonly height: number; readonly animated: boolean;
}

/** Reads every block before native decoding; frame rectangles must fit the logical canvas. */
export function inspectMobileGifBytes(bytes: Uint8Array): MobileGifDimensions {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 14
    || ascii(bytes, 0, 6) !== "GIF87a" && ascii(bytes, 0, 6) !== "GIF89a") {
    throw new Error("The GIF signature is invalid.");
  }
  const width = readU16Le(bytes, 6); const height = readU16Le(bytes, 8);
  if (!width || !height) throw new Error("The GIF dimensions are invalid.");
  let offset = 13; const packed = bytes[10]!;
  if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1);
  if (offset > bytes.byteLength) throw new Error("The GIF color table is truncated.");
  let frames = 0;
  while (offset < bytes.byteLength) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      if (!frames || offset !== bytes.byteLength) throw new Error("The GIF structure is invalid.");
      return { width, height, animated: frames > 1 };
    }
    if (marker === 0x21) {
      if (offset >= bytes.byteLength) break;
      offset += 1; offset = skipSubBlocks(bytes, offset); continue;
    }
    if (marker === 0x2c) {
      if (offset + 9 > bytes.byteLength) break;
      const left = readU16Le(bytes, offset); const top = readU16Le(bytes, offset + 2);
      const frameWidth = readU16Le(bytes, offset + 4); const frameHeight = readU16Le(bytes, offset + 6);
      if (left === undefined || top === undefined || !frameWidth || !frameHeight
        || left + frameWidth > width || top + frameHeight > height) throw new Error("The GIF frame dimensions are invalid.");
      const framePacked = bytes[offset + 8]!; offset += 9;
      if ((framePacked & 0x80) !== 0) offset += 3 * 2 ** ((framePacked & 0x07) + 1);
      if (offset >= bytes.byteLength) break;
      const minimumCodeSize = bytes[offset++];
      if (minimumCodeSize === undefined || minimumCodeSize < 2 || minimumCodeSize > 12) throw new Error("The GIF image code size is invalid.");
      offset = skipSubBlocks(bytes, offset); frames += 1; continue;
    }
    throw new Error("The GIF contains an invalid block.");
  }
  throw new Error("The GIF is truncated.");
}

function skipSubBlocks(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (offset < bytes.byteLength) {
    const length = bytes[offset++];
    if (length === undefined) break;
    if (!length) return offset;
    if (offset + length > bytes.byteLength) break;
    offset += length;
  }
  throw new Error("The GIF sub-block is truncated.");
}
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return offset + length > bytes.byteLength ? "" : String.fromCharCode(...bytes.subarray(offset, offset + length));
}
function readU16Le(bytes: Uint8Array, offset: number): number | undefined {
  return offset + 2 > bytes.byteLength ? undefined : bytes[offset]! | bytes[offset + 1]! << 8;
}

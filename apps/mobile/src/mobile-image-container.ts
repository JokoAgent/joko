import { assertMobileImageGalleryDimensions } from "./mobile-image-dimensions";

export interface MobileImageContainer {
  readonly width: number;
  readonly height: number;
  readonly originalOnly?: boolean;
  readonly animated?: boolean;
  readonly previewBytes?: Uint8Array;
}

export function inspectMobileBmpBytes(bytes: Uint8Array): MobileImageContainer | undefined {
  if (ascii(bytes, 0, 2) !== "BM") return undefined;
  const fileSize = u32(bytes, 2, true);
  const pixelOffset = u32(bytes, 10, true);
  const dibSize = u32(bytes, 14, true);
  if (fileSize !== bytes.byteLength || pixelOffset === undefined || dibSize === undefined
    || pixelOffset < 14 + dibSize || pixelOffset >= bytes.byteLength || 14 + dibSize > bytes.byteLength) return undefined;
  if (dibSize === 12) {
    const width = u16(bytes, 18, true); const height = u16(bytes, 20, true);
    return width && height && u16(bytes, 22, true) === 1 ? { width, height } : undefined;
  }
  // Abbreviated OS/2 headers retain the complete canvas; absent trailing codec fields use native defaults.
  if (dibSize < 40 && ![16, 20, 24, 28, 32, 36].includes(dibSize)) return undefined;
  const width = i32(bytes, 18, true); const signedHeight = i32(bytes, 22, true);
  const bits = u16(bytes, 28, true);
  if (width === undefined || width < 1 || !signedHeight || u16(bytes, 26, true) !== 1
    || ![1, 4, 8, 16, 24, 32].includes(bits ?? 0)) return undefined;
  return { width, height: Math.abs(signedHeight) };
}

/** Read one bounded, classic TIFF image. Multi-page/BigTIFF stays a normal file. */
export function inspectMobileTiffBytes(bytes: Uint8Array): MobileImageContainer | undefined {
  const order = ascii(bytes, 0, 2); const little = order === "II";
  if (!little && order !== "MM") return undefined;
  if (u16(bytes, 2, little) !== 42) return undefined;
  const directory = u32(bytes, 4, little);
  if (directory === undefined || directory < 8) return undefined;
  const count = u16(bytes, directory, little);
  if (count === undefined || count > 4_096) return undefined;
  const nextOffset = directory + 2 + count * 12;
  if (nextOffset + 4 > bytes.byteLength || u32(bytes, nextOffset, little) !== 0) return undefined;
  const values = new Map<number, number>();
  for (let index = 0; index < count; index++) {
    const offset = directory + 2 + index * 12;
    const tag = u16(bytes, offset, little)!;
    if (tag !== 256 && tag !== 257 && tag !== 274 && tag !== 254) continue;
    if (values.has(tag)) return undefined;
    const type = u16(bytes, offset + 2, little);
    if (u32(bytes, offset + 4, little) !== 1 || type !== 3 && type !== 4) return undefined;
    const value = type === 3 ? u16(bytes, offset + 8, little) : u32(bytes, offset + 8, little);
    if (value === undefined) return undefined;
    values.set(tag, value);
  }
  const width = values.get(256); const height = values.get(257); const orientation = values.get(274) ?? 1;
  if (!width || !height || orientation < 1 || orientation > 8 || (values.get(254) ?? 0) !== 0) return undefined;
  assertMobileImageGalleryDimensions(width, height);
  return orientation >= 5 ? { width: height, height: width } : { width, height };
}

interface IsoBox { readonly type: string; readonly start: number; readonly data: number; readonly end: number }

/** Resolve pitm -> ipma -> ipco. Unrelated ispe properties cannot authorize a thumbnail decode. */
export function inspectMobileIsoImageBytes(bytes: Uint8Array, mediaType: "image/avif" | "image/heic" | "image/heif"): MobileImageContainer | undefined {
  let boxCount = 0;
  const boxes = (start: number, end: number): readonly IsoBox[] | undefined => {
    const result: IsoBox[] = [];
    while (start < end) {
      if (start + 8 > end || ++boxCount > 16_384) return undefined;
      let size = u32(bytes, start, false)!; let header = 8;
      if (size === 1) { const large = u64(bytes, start + 8, false); if (large === undefined) return undefined; size = large; header = 16; }
      else if (size === 0) size = end - start;
      if (size < header || size > end - start) return undefined;
      result.push({ type: ascii(bytes, start + 4, 4), start, data: start + header, end: start + size });
      start += size;
    }
    return start === end ? result : undefined;
  };
  const unique = (items: readonly IsoBox[], type: string): IsoBox | undefined => {
    const matches = items.filter((item) => item.type === type); return matches.length === 1 ? matches[0] : undefined;
  };
  const top = boxes(0, bytes.length); if (!top) return undefined;
  const ftyp = unique(top, "ftyp"); const meta = unique(top, "meta");
  if (!ftyp || !meta || ftyp.end - ftyp.data < 8 || (ftyp.end - ftyp.data) % 4 !== 0
    || meta.data + 4 > meta.end || u32(bytes, meta.data, false) !== 0) return undefined;
  const brands = new Set([ascii(bytes, ftyp.data, 4)]);
  for (let offset = ftyp.data + 8; offset < ftyp.end; offset += 4) brands.add(ascii(bytes, offset, 4));
  if (brands.has("avis") || brands.has("hevc") || brands.has("hevx") || brands.has("msf1")
    || top.some((box) => box.type === "moov")
    || mediaType === "image/avif" && !brands.has("avif")
    || mediaType === "image/heic" && !["heic", "heix"].some((brand) => brands.has(brand))
    || mediaType === "image/heif" && !brands.has("mif1")) return undefined;
  const children = boxes(meta.data + 4, meta.end); if (!children) return undefined;
  const pitm = unique(children, "pitm"); const iprp = unique(children, "iprp");
  if (!pitm || !iprp || pitm.end - pitm.data < 6 || bytes[pitm.data]! > 1
    || u32(bytes, pitm.data, false)! % 0x1000000 !== 0) return undefined;
  const primaryId = bytes[pitm.data] === 0 ? u16(bytes, pitm.data + 4, false) : u32(bytes, pitm.data + 4, false);
  if (!primaryId || pitm.end - pitm.data !== (bytes[pitm.data] === 0 ? 6 : 8)) return undefined;
  const propertyBoxes = boxes(iprp.data, iprp.end); if (!propertyBoxes) return undefined;
  const ipco = unique(propertyBoxes, "ipco"); if (!ipco) return undefined;
  const properties = boxes(ipco.data, ipco.end); if (!properties || properties.length > 32_767) return undefined;
  const associations = new Map<number, readonly number[]>(); const seenVersions = new Set<number>();
  for (const box of propertyBoxes) {
    if (box.type === "ipco") continue;
    if (box.type !== "ipma" || box.data + 8 > box.end) return undefined;
    const versionFlags = u32(bytes, box.data, false)!; const version = bytes[box.data]!;
    const flags = versionFlags % 0x1000000;
    if (version > 1 || flags > 1 || seenVersions.has(versionFlags)) return undefined;
    seenVersions.add(versionFlags);
    const count = u32(bytes, box.data + 4, false)!;
    if (count > 4_096) return undefined;
    let offset = box.data + 8; let previousId = 0;
    for (let index = 0; index < count; index++) {
      const itemSize = version === 0 ? 2 : 4;
      if (offset + itemSize + 1 > box.end) return undefined;
      const id = version === 0 ? u16(bytes, offset, false)! : u32(bytes, offset, false)!;
      if (id <= previousId || associations.has(id)) return undefined;
      previousId = id; offset += itemSize;
      const propertyCount = bytes[offset++]!; const indices: number[] = [];
      for (let property = 0; property < propertyCount; property++) {
        const wide = flags === 1;
        if (offset + (wide ? 2 : 1) > box.end) return undefined;
        const association = wide ? u16(bytes, offset, false)! : bytes[offset]!;
        offset += wide ? 2 : 1;
        const propertyIndex = association & (wide ? 0x7fff : 0x7f);
        if (propertyIndex > properties.length || propertyIndex === 0 && (association & (wide ? 0x8000 : 0x80)) !== 0) return undefined;
        if (propertyIndex !== 0) {
          if (indices.includes(propertyIndex)) return undefined;
          indices.push(propertyIndex);
        }
      }
      associations.set(id, indices);
    }
    if (offset !== box.end) return undefined;
  }
  const primaryProperties = associations.get(primaryId)?.map((index) => properties[index - 1]!);
  if (!primaryProperties) return undefined;
  const ispe = unique(primaryProperties, "ispe");
  if (!ispe || ispe.end - ispe.data !== 12 || u32(bytes, ispe.data, false) !== 0) return undefined;
  let width = u32(bytes, ispe.data + 4, false)!; let height = u32(bytes, ispe.data + 8, false)!;
  assertMobileImageGalleryDimensions(width, height);
  const transforms = new Set<string>();
  for (const property of primaryProperties) {
    const { type, data, end } = property;
    if (type !== "irot" && type !== "imir" && type !== "clap") continue;
    if (transforms.has(type)) return undefined;
    transforms.add(type);
    if (type === "irot" || type === "imir") {
      if (end - data !== 1 || bytes[data]! > (type === "irot" ? 3 : 1)) return undefined;
      if (type === "irot" && bytes[data]! % 2 !== 0) [width, height] = [height, width];
    } else {
      if (end - data !== 32) return undefined;
      const ratio = (offset: number, signed = false) => {
        const denominator = u32(bytes, data + offset + 4, false)!;
        return denominator ? (signed ? i32(bytes, data + offset, false)! : u32(bytes, data + offset, false)!) / denominator : NaN;
      };
      const cropWidth = ratio(0); const cropHeight = ratio(8);
      const left = (width - cropWidth) / 2 + ratio(16, true); const top = (height - cropHeight) / 2 + ratio(24, true);
      if (!Number.isSafeInteger(cropWidth) || !Number.isSafeInteger(cropHeight)
        || !Number.isFinite(left) || !Number.isFinite(top) || left < 0 || top < 0
        || left + cropWidth > width || top + cropHeight > height) return undefined;
      width = cropWidth; height = cropHeight;
    }
  }
  assertMobileImageGalleryDimensions(width, height);
  return { width, height };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return offset >= 0 && offset + length <= bytes.length ? String.fromCharCode(...bytes.subarray(offset, offset + length)) : "";
}
function u16(bytes: Uint8Array, offset: number, little: boolean): number | undefined {
  if (offset < 0 || offset + 2 > bytes.length) return undefined;
  return little ? bytes[offset]! + bytes[offset + 1]! * 256 : bytes[offset]! * 256 + bytes[offset + 1]!;
}
function u32(bytes: Uint8Array, offset: number, little: boolean): number | undefined {
  if (offset < 0 || offset + 4 > bytes.length) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, little);
}
function i32(bytes: Uint8Array, offset: number, little: boolean): number | undefined {
  const value = u32(bytes, offset, little); return value === undefined ? undefined : value > 0x7fffffff ? value - 0x100000000 : value;
}
function u64(bytes: Uint8Array, offset: number, little: boolean): number | undefined {
  if (offset < 0 || offset + 8 > bytes.length) return undefined;
  const high = u32(bytes, offset + (little ? 4 : 0), little)!; const low = u32(bytes, offset + (little ? 0 : 4), little)!;
  const value = high * 0x100000000 + low; return Number.isSafeInteger(value) ? value : undefined;
}

interface WebmElement {
  readonly id: number;
  readonly start: number;
  readonly sizeAt: number;
  readonly width: number;
  readonly data: number;
  readonly end: number;
  readonly unknown: boolean;
}

/** Finalize the streaming MediaRecorder output so its preview has a finite timeline. */
export function finalizeRecordedWebm(bytes: Uint8Array<ArrayBuffer>, milliseconds: number): Uint8Array<ArrayBuffer> {
  const readElement = (start: number, limit: number): WebmElement => {
    let offset = start;
    const readInteger = (isId: boolean) => {
      const first = bytes[offset];
      if (!first) throw new Error("Invalid WebM metadata.");
      let width = 1, marker = 128;
      while ((first & marker) === 0) { width++; marker >>= 1; }
      if (width > (isId ? 4 : 8) || offset + width > limit) throw new Error("Invalid WebM metadata.");
      let value = isId ? first : first & (marker - 1);
      let unknown = !isId && value === marker - 1;
      for (let index = 1; index < width; index++) {
        const byte = bytes[offset + index]!;
        value = value * 256 + byte;
        unknown &&= byte === 255;
      }
      offset += width;
      return { value, width, unknown };
    };
    const id = readInteger(true).value, sizeAt = offset, size = readInteger(false);
    const end = size.unknown ? limit : offset + size.value;
    if (!Number.isSafeInteger(end) || end > limit || end <= start) throw new Error("Invalid WebM metadata.");
    return { id, start, sizeAt, width: size.width, data: offset, end, unknown: size.unknown };
  };
  const children = (start: number, end: number): WebmElement[] => {
    const elements: WebmElement[] = [];
    for (let offset = start; offset < end;) {
      const element = readElement(offset, end);
      elements.push(element);
      offset = element.end;
    }
    return elements;
  };
  const header = (element: WebmElement, payloadBytes: number): Uint8Array[] => {
    const id = bytes.subarray(element.start, element.sizeAt);
    if (element.unknown) return [id, bytes.subarray(element.sizeAt, element.data)];
    let width = element.width;
    while (payloadBytes >= 2 ** (7 * width) - 1) width++;
    const length = new Uint8Array(width);
    let value = BigInt(payloadBytes) | (1n << BigInt(7 * width));
    for (let index = width - 1; index >= 0; index--) {
      length[index] = Number(value & 255n);
      value >>= 8n;
    }
    return [id, length];
  };
  const segment = children(0, bytes.length).find(element => element.id === 0x18538067);
  if (!segment) throw new Error("WebM segment missing.");
  const top = children(segment.data, segment.end);
  const info = top.find(element => element.id === 0x1549a966);
  if (!info) throw new Error("WebM info missing.");
  const metadata = children(info.data, info.end);
  if (metadata.some(element => element.id === 0x4489)) return bytes;
  // SeekHead and Cues carry file offsets that would need to be rewritten.
  if (top.some(element => element.id === 0x114d9b74 || element.id === 0x1c53bb6b)) return bytes;
  const scale = metadata.find(element => element.id === 0x2ad7b1);
  let nanoseconds = 1_000_000;
  if (scale) {
    nanoseconds = 0;
    for (let index = scale.data; index < scale.end; index++) nanoseconds = nanoseconds * 256 + bytes[index]!;
  }
  if (!Number.isSafeInteger(nanoseconds) || nanoseconds < 1 || !Number.isFinite(milliseconds)) throw new Error("Invalid WebM timing.");
  const duration = new Uint8Array(11);
  duration.set([0x44, 0x89, 0x88]);
  new DataView(duration.buffer).setFloat64(3, Math.max(1, milliseconds) * 1_000_000 / nanoseconds);
  const nextInfo = header(info, info.end - info.data + duration.length);
  const payloadBytes = segment.end - segment.data + duration.length + nextInfo[1]!.length - info.width;
  const parts = [bytes.subarray(0, segment.start), ...header(segment, payloadBytes), bytes.subarray(segment.data, info.start),
    ...nextInfo, bytes.subarray(info.data, info.end), duration, bytes.subarray(info.end)];
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

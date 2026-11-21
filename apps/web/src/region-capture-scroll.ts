interface ScrollFrame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** Compare the common pixels only. A positive result appends the newly exposed bottom rows. */
export function regionScrollOffset(previous: ScrollFrame, next: ScrollFrame): number | undefined {
  const { width, height } = previous;
  if (width !== next.width || height !== next.height || width < 16 || height < 40
    || previous.data.byteLength !== width * height * 4 || next.data.byteLength !== width * height * 4) return undefined;
  const positions = Array.from({ length: 13 }, (_, index) => Math.floor((index + 2) * width / 16));
  const score = (offset: number): number => {
    const overlap = height - Math.abs(offset);
    const first = Math.max(0, offset), second = Math.max(0, -offset);
    let difference = 0;
    for (let sample = 1; sample <= 14; sample++) {
      const row = Math.floor(overlap * sample / 15);
      for (const x of positions) {
        const a = ((first + row) * width + x) * 4, b = ((second + row) * width + x) * 4;
        difference += Math.abs(previous.data[a]! - next.data[b]!) + Math.abs(previous.data[a + 1]! - next.data[b + 1]!)
          + Math.abs(previous.data[a + 2]! - next.data[b + 2]!);
      }
    }
    return difference / (14 * positions.length * 3);
  };
  if (score(0) < 2.5) return 0;
  const minimumOverlap = Math.max(24, Math.ceil(height * 0.24));
  let best: { readonly shift: number; readonly score: number } | undefined;
  const candidates: { readonly shift: number; readonly score: number }[] = [];
  for (let shift = minimumOverlap - height; shift <= height - minimumOverlap; shift++) {
    if (Math.abs(shift) <= 2) continue;
    const distance = score(shift);
    if (distance > 9) continue;
    const candidate = { shift, score: distance };
    candidates.push(candidate);
    if (best === undefined || distance < best.score) best = candidate;
  }
  if (best === undefined || candidates.some(candidate => Math.abs(candidate.shift - best!.shift) > 3 && candidate.score <= best!.score + 1.25)) {
    return undefined;
  }
  return best.shift;
}

export function regionScrollExtraRows(frame: ScrollFrame, offset: number): ImageData {
  const rows = Math.abs(offset);
  if (!Number.isSafeInteger(rows) || rows <= 0 || rows >= frame.height) throw new Error("The scrolling capture has no distinct rows.");
  const bytesPerRow = frame.width * 4;
  const start = offset > 0 ? (frame.height - rows) * bytesPerRow : 0;
  return new ImageData(frame.data.slice(start, start + rows * bytesPerRow), frame.width, rows);
}

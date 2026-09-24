export interface SimulatorRgbaImage {
  readonly width: number;
  readonly height: number;
  /** Unpremultiplied RGBA bytes, four bytes per pixel in row-major order. */
  readonly data: Uint8Array;
}

export interface SimulatorPixelDiff {
  readonly width: number;
  readonly height: number;
  readonly comparedPixels: number;
  readonly differentPixels: number;
  readonly differenceRatio: number;
  readonly meanAbsoluteError: number;
  readonly maxAbsoluteError: number;
  readonly threshold: number;
}

export class SimulatorVisualDiffError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT", message: string) { super(message); }
}

function requireImage(image: SimulatorRgbaImage): void {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
      image.width < 1 || image.height < 1 || image.width > 8_192 || image.height > 8_192 ||
      image.data.byteLength !== image.width * image.height * 4) {
    throw new SimulatorVisualDiffError("INVALID_ARGUMENT", "Simulator RGBA image is invalid.");
  }
}

/** Compare every RGBA channel; the threshold applies to each pixel's largest channel error. */
export function compareSimulatorRgbaImages(baseline: SimulatorRgbaImage,
  current: SimulatorRgbaImage, threshold = 16): SimulatorPixelDiff {
  requireImage(baseline);
  requireImage(current);
  if (baseline.width !== current.width || baseline.height !== current.height ||
      !Number.isSafeInteger(threshold) || threshold < 0 || threshold > 255) {
    throw new SimulatorVisualDiffError("INVALID_ARGUMENT",
      "Simulator image dimensions or visual threshold are invalid.");
  }
  const comparedPixels = baseline.width * baseline.height;
  let differentPixels = 0;
  let totalAbsoluteError = 0;
  let maxAbsoluteError = 0;
  for (let offset = 0; offset < baseline.data.byteLength; offset += 4) {
    let pixelMaximum = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const error = Math.abs(baseline.data[offset + channel]! - current.data[offset + channel]!);
      totalAbsoluteError += error;
      pixelMaximum = Math.max(pixelMaximum, error);
      maxAbsoluteError = Math.max(maxAbsoluteError, error);
    }
    if (pixelMaximum > threshold) differentPixels += 1;
  }
  return { width: baseline.width, height: baseline.height, comparedPixels,
    differentPixels, differenceRatio: differentPixels / comparedPixels,
    meanAbsoluteError: totalAbsoluteError / baseline.data.byteLength,
    maxAbsoluteError, threshold };
}

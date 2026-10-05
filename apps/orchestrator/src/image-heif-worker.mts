import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";
import type { HeifThumbnailRequest } from "./image-heif-thumbnail.js";

interface DecodedImage {
  get_width(): number;
  get_height(): number;
  is_primary(): boolean;
  display(image: { data: Uint8ClampedArray; width: number; height: number }, done: (value: { data: Uint8ClampedArray } | null) => void): void;
  free(): void;
}
interface HeifModule { HeifDecoder: new () => { decode(bytes: Uint8Array): DecodedImage[] } }

try {
  const request = workerData as HeifThumbnailRequest;
  const libheif = createRequire(import.meta.url)("libheif-js/wasm-bundle") as HeifModule;
  const images = new libheif.HeifDecoder().decode(request.bytes);
  try {
    const primary = images.filter((image) => image.is_primary());
    if (primary.length !== 1) throw new Error("Missing primary image.");
    const image = primary[0]!; const width = image.get_width(); const height = image.get_height();
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width !== request.width || height !== request.height || width > request.maximumDimension || height > request.maximumDimension
      || width * height > request.maximumPixels) throw new Error("The primary image exceeds its pixel budget.");
    const pixels = await new Promise<Uint8ClampedArray>((resolve, reject) => {
      image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (value) => {
        if (value?.data.length === width * height * 4) resolve(value.data);
        else reject(new Error("The primary image decode failed."));
      });
    });
    const renderer = sharp(pixels, { raw: { width, height, channels: 4 }, limitInputPixels: request.maximumPixels }).timeout({ seconds: 5 });
    // HEIF container transforms are already applied by the decoder; retain EXIF's separate orientation.
    if (request.orientation === 2 || request.orientation === 5 || request.orientation === 7) renderer.flop();
    if (request.orientation === 4) renderer.flip();
    if (request.orientation === 3) renderer.rotate(180);
    if (request.orientation === 6 || request.orientation === 7) renderer.rotate(90);
    if (request.orientation === 5 || request.orientation === 8) renderer.rotate(270);
    const output = await renderer.resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 70 }).toBuffer({ resolveWithObject: true });
    if (!output.data.length || output.data.length > request.maximumOutputBytes || output.info.format !== "webp") throw new Error("The thumbnail exceeds its budget.");
    const data = Uint8Array.from(output.data);
    parentPort!.postMessage({ data, widthPixels: output.info.width, heightPixels: output.info.height }, [data.buffer]);
  } finally { for (const image of images) image.free(); }
} catch { parentPort?.postMessage({ failed: true }); }
finally { parentPort?.close(); }

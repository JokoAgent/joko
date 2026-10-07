import { awaitMobileMarkdownResourceRead } from "./mobile-markdown-resources";
import { decodeMobileBase64, mobileImageRequiresNativeRaster } from "./mobile-image-annotation";
import { inspectMobileImageGalleryBytes, mobileImageGalleryDimensionsMatch } from "./mobile-image-gallery";
import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";

export interface MobileAnnotationRasterDriver {
  toPng(uri: string, signal: AbortSignal): Promise<string>;
}

/** Keep original image bytes intact; only the disposable drawing source is rasterized. */
export async function prepareMobileAnnotationRaster(input: {
  readonly base64: string;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
}, signal: AbortSignal, driver: MobileAnnotationRasterDriver = nativeRasterDriver): Promise<{
  readonly base64: string;
  readonly mediaType: string;
}> {
  signal.throwIfAborted();
  if (!mobileImageRequiresNativeRaster(input.mediaType)) return { base64: input.base64, mediaType: input.mediaType };
  const source = inspectMobileImageGalleryBytes(
    decodeMobileBase64(input.base64, MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES),
    input.mediaType
  );
  if (source.animated || source.originalOnly) throw new Error("The drawing source must be one static image.");
  if (!mobileImageGalleryDimensionsMatch(source, input.width, input.height)) {
    throw new Error("The drawing source canvas changed.");
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(cancel, 30_000);
  try {
    const base64 = await awaitMobileMarkdownResourceRead(
      driver.toPng(`data:${input.mediaType};base64,${input.base64}`, controller.signal),
      controller.signal
    );
    signal.throwIfAborted();
    const rendered = inspectMobileImageGalleryBytes(
      decodeMobileBase64(base64, MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES),
      "image/png"
    );
    if (rendered.animated || rendered.nativeQuarterTurn
      || rendered.width !== input.width || rendered.height !== input.height) {
      throw new Error("The rasterized drawing source canvas changed.");
    }
    return { base64, mediaType: "image/png" };
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", cancel);
  }
}

const nativeRasterDriver: MobileAnnotationRasterDriver = {
  async toPng(uri, signal) {
    const [{ ImageManipulator, SaveFormat }, { File }] = await Promise.all([
      import("expo-image-manipulator"),
      import("expo-file-system")
    ]);
    signal.throwIfAborted();
    const context = ImageManipulator.manipulate(uri);
    let image: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
    let output: InstanceType<typeof File> | undefined;
    try {
      image = await context.renderAsync();
      signal.throwIfAborted();
      const saved = await image.saveAsync({ format: SaveFormat.PNG, base64: true });
      output = new File(saved.uri);
      signal.throwIfAborted();
      if (!saved.base64) throw new Error("The native drawing source was empty.");
      return saved.base64;
    } finally {
      try {
        image?.release();
      } finally {
        try {
          context.release();
        } finally {
          if (output?.exists) output.delete();
        }
      }
    }
  }
};

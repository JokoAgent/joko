import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isoImageBytes, tiffBytes } from "./test/image-formats";

const native = vi.hoisted(() => ({
  render: vi.fn(),
  save: vi.fn(),
  releaseImage: vi.fn(),
  releaseContext: vi.fn(),
  remove: vi.fn()
}));
vi.mock("expo-image-manipulator", () => ({
  SaveFormat: { PNG: "png" },
  ImageManipulator: { manipulate: () => ({ renderAsync: native.render, release: native.releaseContext }) }
}));
vi.mock("expo-file-system", () => ({
  File: class {
    exists = true;
    delete() { native.remove(); }
  }
}));

import { prepareMobileAnnotationRaster } from "./mobile-annotation-raster";

const source = {
  base64: Buffer.from(isoImageBytes(["heic", "mif1"], 6, 4)).toString("base64"),
  mediaType: "image/heic",
  width: 6,
  height: 4
};

async function png(width = 6, height = 4): Promise<string> {
  return (await sharp({ create: { width, height, channels: 3, background: "#ff9800" } }).png().toBuffer()).toString("base64");
}

beforeEach(() => {
  for (const mock of Object.values(native)) mock.mockReset();
  native.render.mockResolvedValue({ saveAsync: native.save, release: native.releaseImage });
});

describe("native drawing source", () => {
  it.each(["image/tiff", "image/heic", "image/heif"])(
    "keeps ordinary raster bytes intact and rasterizes %s to its confirmed PNG canvas",
    async (mediaType) => {
      const bytes = mediaType === "image/tiff"
        ? tiffBytes(6, 4)
        : isoImageBytes(mediaType === "image/heic" ? ["heic", "mif1"] : ["mif1"], 6, 4);
      const exact = { base64: Buffer.from(bytes).toString("base64"), mediaType, width: 6, height: 4 };
      const original = exact.base64;
      const controller = new AbortController();
      const base64 = await png();
      const driver = { toPng: vi.fn(async () => base64) };
      const ordinary = { ...exact, base64, mediaType: "image/png" };
      await expect(prepareMobileAnnotationRaster(ordinary, controller.signal, driver))
        .resolves.toEqual({ base64, mediaType: "image/png" });
      expect(driver.toPng).not.toHaveBeenCalled();
      await expect(prepareMobileAnnotationRaster(exact, controller.signal, driver))
        .resolves.toEqual({ base64, mediaType: "image/png" });
      expect(driver.toPng).toHaveBeenCalledWith(`data:${mediaType};base64,${exact.base64}`, expect.any(AbortSignal));
      expect(exact.base64).toBe(original);
      await expect(prepareMobileAnnotationRaster(exact, controller.signal, { toPng: async () => png(4, 6) }))
        .rejects.toThrow(/canvas changed/u);
      await expect(prepareMobileAnnotationRaster({ ...exact, width: 5 }, controller.signal, driver))
        .rejects.toThrow(/canvas changed/u);
    }
  );

  it("keeps multiple-page TIFF originals out of the static drawing conversion", async () => {
    const base64 = Buffer.from(tiffBytes(6, 4, { additionalPages: 1 })).toString("base64");
    const driver = { toPng: vi.fn() };
    await expect(prepareMobileAnnotationRaster({ ...source, base64, mediaType: "image/tiff" }, new AbortController().signal, driver))
      .rejects.toThrow();
    expect(driver.toPng).not.toHaveBeenCalled();
  });

  it("leaves unsupported image types outside the native raster conversion", async () => {
    const base64 = await png();
    const driver = { toPng: vi.fn() };
    await expect(prepareMobileAnnotationRaster({ ...source, base64, mediaType: "image/png" }, new AbortController().signal, driver))
      .resolves.toEqual({ base64, mediaType: "image/png" });
    expect(driver.toPng).not.toHaveBeenCalled();
  });

  it("releases native images and removes the generated temporary PNG after conversion", async () => {
    const base64 = await png();
    native.save.mockResolvedValue({ uri: "file:///owned-render.png", base64 });
    await expect(prepareMobileAnnotationRaster(source, new AbortController().signal))
      .resolves.toEqual({ base64, mediaType: "image/png" });
    expect(native.save).toHaveBeenCalledExactlyOnceWith({ format: "png", base64: true });
    expect(native.releaseImage).toHaveBeenCalledOnce();
    expect(native.releaseContext).toHaveBeenCalledOnce();
    expect(native.remove).toHaveBeenCalledOnce();
  });

  it("rejects a retired conversion and cleans up its late native output", async () => {
    let finish!: (value: { uri: string; base64: string }) => void;
    native.save.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = prepareMobileAnnotationRaster(source, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(native.remove).not.toHaveBeenCalled();
    finish({ uri: "file:///owned-late-render.png", base64: await png() });
    await vi.waitFor(() => expect(native.remove).toHaveBeenCalledOnce());
    expect(native.releaseImage).toHaveBeenCalledOnce();
    expect(native.releaseContext).toHaveBeenCalledOnce();
  });
});

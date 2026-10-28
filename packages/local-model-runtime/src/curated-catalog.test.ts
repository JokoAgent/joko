import { describe, expect, it } from "vitest";

import { curatedModelsForHost, modelPreflight, recommendedModelsForHost } from "./curated-catalog.js";

const GIB = 1024 ** 3;

describe("curated local model catalog", () => {
  it("selects Apple packages and prioritizes recommendations that fit memory", () => {
    const host = { platform: "darwin" as const, arch: "arm64" as const, totalMemoryBytes: 64 * GIB };
    const catalog = curatedModelsForHost(host);
    expect(catalog.find((model) => model.id === "qwen38-27b")?.libraryName).toBe("qwen3.8:27b-mxfp8");
    expect(recommendedModelsForHost(host).map((model) => model.id)).toEqual(["qwen38-27b"]);
  });

  it("uses the smaller Apple package below the 64 GB threshold", () => {
    const catalog = curatedModelsForHost({ platform: "darwin", arch: "arm64", totalMemoryBytes: 32 * GIB });
    expect(catalog.find((model) => model.id === "qwen38-27b")).toMatchObject({
      libraryName: "qwen3.8:27b-mlx",
      minimumMemoryGb: 32,
      appleSiliconOnly: true
    });
  });

  it("keeps constrained models visible while disk preflight blocks unsafe pulls", () => {
    const host = { platform: "linux" as const, arch: "x64" as const, totalMemoryBytes: 8 * GIB };
    const catalog = curatedModelsForHost(host);
    const model = catalog.find((item) => item.id === "qwen35-9b")!;
    expect(catalog).toContain(model);
    expect(modelPreflight({ model, ...host, freeDiskBytes: 1 * GIB })).toMatchObject({
      allowed: false,
      memory: "constrained",
      disk: "insufficient",
      publicErrorCode: "DISK_SPACE_LOW"
    });
  });

  it("offers the high-memory recommendation in catalog order and retains exact platform downloads", () => {
    const host = { platform: "darwin" as const, arch: "arm64" as const, totalMemoryBytes: 192 * GIB };
    expect(recommendedModelsForHost(host).map(model => model.id)).toEqual(["qwen38-flash-next", "qwen38-27b"]);
    const generic = curatedModelsForHost({ ...host, platform: "win32", arch: "x64" });
    expect(generic.find(model => model.id === "qwen35-4b")).toMatchObject({
      libraryName: "qwen3.5:4b-q4_K_M", sizeBytes: 3_389_983_260, minimumMemoryGb: 8, appleSiliconOnly: false
    });
    expect(generic.find(model => model.id === "laguna-s21-118b")).toMatchObject({
      libraryName: "laguna-s-2.1:q4_K_M", sizeBytes: 96_031_832_391, minimumMemoryGb: 192
    });
    expect(generic.some(model => model.id === "gpt-oss-20b")).toBe(false);
  });
});

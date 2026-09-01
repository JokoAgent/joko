import { describe, expect, it } from "vitest";

import { curatedModelsForHost, modelPreflight, recommendedModelsForHost } from "./curated-catalog.js";

const GIB = 1024 ** 3;

describe("curated local model catalog", () => {
  it("selects Apple packages and prioritizes recommendations that fit memory", () => {
    const host = { platform: "darwin" as const, arch: "arm64" as const, totalMemoryBytes: 64 * GIB };
    const catalog = curatedModelsForHost(host);
    expect(catalog.find((model) => model.id === "qwen38-27b")?.libraryName).toBe("qwen3.8:27b-mxfp8");
    expect(recommendedModelsForHost(host).map((model) => model.id)).toEqual(["qwen38-27b", "gpt-oss-20b", "ornith15-35b"]);
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
    const model = catalog.find((item) => item.id === "gpt-oss-20b")!;
    expect(catalog).toContain(model);
    expect(modelPreflight({ model, ...host, freeDiskBytes: 1 * GIB })).toMatchObject({
      allowed: false,
      memory: "constrained",
      disk: "insufficient",
      publicErrorCode: "DISK_SPACE_LOW"
    });
  });
});

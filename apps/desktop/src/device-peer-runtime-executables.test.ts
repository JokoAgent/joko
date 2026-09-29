import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDesktopDevicePeerRuntimeRoot } from "./device-peer-runtime-executables.js";

describe("Desktop Device peer runtime composition", () => {
  it("uses the staged tree beside compiled main.js during development", () => {
    const sourceDirectory = resolve("apps/desktop/dist");
    expect(resolveDesktopDevicePeerRuntimeRoot({
      packaged: false,
      resourcesPath: resolve("apps/desktop/release/resources"),
      sourceDirectory
    })).toBe(resolve(sourceDirectory, "orchestrator-runtime"));
  });

  it("uses the packaged resources tree after relocation", () => {
    const resourcesPath = resolve("apps/desktop/release/resources");
    expect(resolveDesktopDevicePeerRuntimeRoot({
      packaged: true,
      resourcesPath,
      sourceDirectory: resolve("apps/desktop/dist")
    })).toBe(resolve(resourcesPath, "orchestrator-runtime"));
  });

  it("rejects a runtime base that is not normalized and absolute", () => {
    expect(() => resolveDesktopDevicePeerRuntimeRoot({
      packaged: false,
      resourcesPath: resolve("apps/desktop/release/resources"),
      sourceDirectory: "apps/desktop/dist"
    })).toThrow(/runtime base is invalid/iu);
  });
});

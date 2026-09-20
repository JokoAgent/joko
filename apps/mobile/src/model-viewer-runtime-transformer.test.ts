import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MobileModelRuntimeBundle } from "./mobile-model-viewer";

const require = createRequire(import.meta.url);
const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transformer = require(resolve(mobileRoot, "svg-string-transformer.cjs")) as {
  readonly testing: {
    readonly buildModelViewerRuntimeModule: (source: string, filename: string) => string;
  };
};

describe("mobile model-viewer Metro bundle", () => {
  it("deterministically embeds the pinned model-viewer and Three.js runtime", () => {
    const entry = resolve(mobileRoot, "src", "model-viewer-runtime.modeljs");
    const first = transformer.testing.buildModelViewerRuntimeModule(readFileSync(entry, "utf8"), entry);
    const second = transformer.testing.buildModelViewerRuntimeModule(readFileSync(entry, "utf8"), entry);
    expect(second).toBe(first);
    const prefix = "module.exports = ";
    const bundle = JSON.parse(first.slice(prefix.length, -1)) as MobileModelRuntimeBundle;
    expect(bundle.modelViewerVersion).toBe("4.3.1");
    expect(bundle.threeVersion).toBe("0.183.2");
    expect(bundle.script.length).toBeGreaterThan(1_000_000);
    expect(bundle.script).toContain("jokoModelViewerRuntime");
    expect(bundle.script).not.toMatch(/<\/script/iu);
    expect(createHash("sha256").update(bundle.script, "utf8").digest("hex")).toBe(bundle.scriptSha256Hex);
  });

  it("refuses arbitrary .modeljs entries", () => {
    expect(() => transformer.testing.buildModelViewerRuntimeModule("", resolve(mobileRoot, "src", "forged.modeljs")))
      .toThrow(/audited Joko model-viewer runtime entry/u);
  });
});

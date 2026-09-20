import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MobilePdfJsRuntimeBundle } from "./mobile-pdf-viewer";

const require = createRequire(import.meta.url);
const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transformer = require(resolve(mobileRoot, "svg-string-transformer.cjs")) as {
  readonly testing: {
    readonly buildPdfJsRuntimeModule: (source: string, filename: string) => string;
    readonly expectedStandardFonts: readonly string[];
  };
};

describe("mobile pdf.js Metro bundle", () => {
  it("deterministically embeds the pinned runtime, complete CMaps and standard fonts", () => {
    const entry = resolve(mobileRoot, "src", "pdfjs-runtime.pdfjs");
    const moduleSource = transformer.testing.buildPdfJsRuntimeModule(readFileSync(entry, "utf8"), entry);
    const prefix = "module.exports = ";
    expect(moduleSource.startsWith(prefix)).toBe(true);
    const bundle = JSON.parse(moduleSource.slice(prefix.length, -1)) as MobilePdfJsRuntimeBundle;
    expect(bundle.version).toBe("5.7.284");
    expect(bundle.script.length).toBeGreaterThan(1_000_000);
    expect(createHash("sha256").update(bundle.script, "utf8").digest("hex")).toBe(bundle.scriptSha256Hex);
    expect(Object.keys(bundle.cMaps)).toHaveLength(169);
    expect(Object.keys(bundle.cMaps).filter((name) => name.endsWith(".bcmap"))).toHaveLength(168);
    expect(bundle.cMaps["UniGB-UTF16-H.bcmap"]).toBeTruthy();
    expect(bundle.cMaps["LICENSE"]).toBeTruthy();
    expect(Object.keys(bundle.standardFonts).sort()).toEqual([...transformer.testing.expectedStandardFonts].sort());
    expect(bundle.standardFonts["FoxitSymbol.pfb"]).toBeTruthy();
    expect(bundle.standardFonts["FoxitDingbats.pfb"]).toBeTruthy();
    expect(bundle.cMapByteSize).toBeGreaterThan(1_000_000);
    expect(bundle.standardFontByteSize).toBeGreaterThan(700_000);
  });

  it("refuses arbitrary .pdfjs entries", () => {
    expect(() => transformer.testing.buildPdfJsRuntimeModule("", resolve(mobileRoot, "src", "forged.pdfjs")))
      .toThrow(/audited Joko pdf\.js runtime entry/u);
  });
});

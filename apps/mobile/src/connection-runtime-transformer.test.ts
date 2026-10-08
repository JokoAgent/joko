import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transformer = require(resolve(mobileRoot, "connection-runtime-transformer.cjs")) as {
  readonly buildConnectionRuntimeModule: (source: string, filename: string) => Promise<string>;
};

describe("mobile shared connection Metro runtime", () => {
  it("bundles Metro's mobile-relative entry identically to the absolute entry", async () => {
    const metroFilename = join("src", "connection-runtime.connjs");
    const absoluteFilename = resolve(mobileRoot, metroFilename);
    const source = readFileSync(absoluteFilename, "utf8");
    const absoluteModule = await transformer.buildConnectionRuntimeModule(source, absoluteFilename);
    const metroModule = await transformer.buildConnectionRuntimeModule(source, metroFilename);
    expect(metroModule).toBe(absoluteModule);
    const bundle = JSON.parse(metroModule.slice("module.exports = ".length, -1)) as { readonly bundleSha256Hex: string };
    expect(bundle.bundleSha256Hex).toMatch(/^[a-f0-9]{64}$/u);
  }, 20_000);
});

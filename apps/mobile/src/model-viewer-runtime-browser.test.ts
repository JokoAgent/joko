import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MobileModelRuntimeBundle } from "./mobile-model-viewer";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  readonly JSDOM: new (html?: string, options?: {
    readonly runScripts?: "outside-only";
    readonly pretendToBeVisual?: boolean;
    readonly url?: string;
  }) => {
    readonly window: Window & { eval(source: string): unknown; close(): void };
  };
};
const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transformer = require(resolve(mobileRoot, "svg-string-transformer.cjs")) as {
  readonly testing: { readonly buildModelViewerRuntimeModule: (source: string, filename: string) => string };
};

describe("bundled mobile model-viewer browser runtime", () => {
  it("boots the pinned custom element without fetching executable code", async () => {
    const entry = resolve(mobileRoot, "src", "model-viewer-runtime.modeljs");
    const moduleSource = transformer.testing.buildModelViewerRuntimeModule(readFileSync(entry, "utf8"), entry);
    const bundle = JSON.parse(moduleSource.slice("module.exports = ".length, -1)) as MobileModelRuntimeBundle;
    const dom = new JSDOM("", { runScripts: "outside-only", pretendToBeVisual: true,
      url: "https://joko-model.invalid/" });
    installStandardWebPlatform(dom.window);
    dom.window.eval(bundle.script);
    const scope = dom.window as unknown as Window & {
      jokoModelViewerRuntime: { readonly ready: Promise<boolean> };
      ModelViewerElement: {
        readonly dracoDecoderLocation: string;
        readonly ktx2TranscoderLocation: string;
        readonly lottieLoaderLocation: string;
      };
    };
    await expect(scope.jokoModelViewerRuntime.ready).resolves.toBe(true);
    const element = scope.customElements.get("model-viewer");
    expect(element).toBeTypeOf("function");
    expect(scope.ModelViewerElement.dracoDecoderLocation).toBe("/joko-disabled-decoders/draco/");
    expect(scope.ModelViewerElement.ktx2TranscoderLocation).toBe("/joko-disabled-decoders/basis/");
    expect(scope.ModelViewerElement.lottieLoaderLocation).toBe("/joko-disabled-decoders/lottie.js");
    dom.window.close();
  });
});

function installStandardWebPlatform(window: Window): void {
  const host = globalThis as unknown as Record<string, unknown>;
  const target = window as unknown as Record<string, unknown>;
  for (const name of [
    "AbortController", "Blob", "DOMMatrix", "Headers", "ReadableStream", "Request", "Response",
    "TextDecoder", "TextEncoder", "URL", "URLSearchParams", "fetch", "structuredClone"
  ]) {
    const value = host[name];
    if (target[name] === undefined && value !== undefined) {
      Object.defineProperty(target, name, { configurable: true, value });
    }
  }
}

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildMobileFileMarkdownHtml, mobileFileMarkdownImagesScript } from "./mobile-file-markdown-html";
import type { MobileMarkdownRichRuntime } from "./mobile-markdown-rich-html";

const require = createRequire(import.meta.url); const { JSDOM } = require("jsdom");
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."); const transformer = require(resolve(root, "svg-string-transformer.cjs"));
const colors = { surface: "#fafafa", background: "#ffffff", ink: "#242a2d", muted: "#637073", accent: "#ff9800", border: "#e1e2df", negative: "#cc634e" };

describe("file Markdown document", () => {
  it("retains intrinsic EXIF proportions both on first render and in-place resource adoption", () => {
    const key = '["image","portrait.png"]';
    const resources = { leaseId: "file", references: new Map([[key, { key, label: "Portrait", kind: "image" as const,
      relativePath: "portrait.png", image: { uri: "data:image/png;base64,AAAA", width: 160, height: 100, nativeQuarterTurn: true as const } }]]) };
    const runtime = { katexScript: "", katexCss: "", mermaidScript: "" };
    for (const initial of [resources, undefined]) {
      const dom = new JSDOM(buildMobileFileMarkdownHtml({ text: "![Portrait](portrait.png)", label: "File", colors, resources: initial }, runtime), { runScripts: "dangerously" });
      if (!initial) dom.window.eval(mobileFileMarkdownImagesScript(resources));
      const image = dom.window.document.querySelector("img") as HTMLImageElement;
      expect(image.getAttribute("src")).toBe("data:image/png;base64,AAAA");
      expect(image.hasAttribute("width")).toBe(false); expect(image.hasAttribute("height")).toBe(false);
      expect(image.style.width).toBe("auto"); expect(image.style.height).toBe("auto");
      expect(image.style.objectFit).toBe("contain"); expect(image.style.aspectRatio).toBe("");
      dom.window.close();
    }
  });

  it("renders real offline math, semantic source blocks and line anchors, escapes hostile content and adopts only leased images in place", () => {
    const entry = resolve(root, "src/rich-markdown-runtime.richjs");
    const module = transformer.testing.buildRichMarkdownRuntimeModule(readFileSync(entry, "utf8"), entry);
    const runtime = JSON.parse(module.slice("module.exports = ".length, -1)) as MobileMarkdownRichRuntime;
    const text = ["# Title", "", "| Key | Value |", "| --- | --- |", "| a | b |", "", "$$", "x^2 + \\frac{1}{2}", "$$", "",
      "```ts", "const value = '<script>window.spoof=1</script>';", "```", "", "![Pixel](pixel.png)", "", "[web](https://example.invalid) [unsafe](javascript:alert(1))", "",
      "```mermaid", "graph TD; A-->B", "```"].join("\n");
    const scrolled: string[] = [];
    const dom = new JSDOM(buildMobileFileMarkdownHtml({ text, colors, label: "File <title>", focusLine: 4 }, runtime), { runScripts: "dangerously", beforeParse(window: Window) {
      Object.defineProperty((window as Window & typeof globalThis).HTMLElement.prototype, "scrollIntoView", { value: function(this: HTMLElement) { scrolled.push(this.getAttribute("data-source-line") ?? ""); } });
    } });
    const document = dom.window.document as Document;
    expect(document.querySelector("h1")?.textContent).toBe("Title"); expect(document.querySelector("th")?.textContent).toBe("Key");
    expect(document.querySelector(".katex")).not.toBeNull(); expect(document.querySelector("pre code")?.textContent).toContain("<script>window.spoof=1</script>");
    expect(dom.window.spoof).toBeUndefined(); expect(document.querySelectorAll("a")).toHaveLength(1);
    expect(document.querySelector("a")?.getAttribute("href")).toBe("https://example.invalid"); expect(scrolled).toContain("2");
    expect(document.querySelector("main")?.getAttribute("aria-label")).toBe("File <title>");
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toContain("connect-src 'none'");
    expect(document.querySelector("img")).toBeNull(); const article = document.querySelector("main");
    const key = '["image","pixel.png"]'; const descriptor = { leaseId: "file", references: new Map([[key, { key, label: "Pixel", kind: "image" as const,
      relativePath: "docs/pixel.png", image: { uri: "data:image/png;base64,AAAA", width: 1, height: 1 } }]]) };
    dom.window.eval(mobileFileMarkdownImagesScript(descriptor)); expect(document.querySelector("main")).toBe(article);
    expect(document.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    dom.window.eval(mobileFileMarkdownImagesScript()); expect(document.querySelector("img")).toBeNull(); expect(document.querySelector(".image-fallback")?.textContent).toBe("Pixel");
    expect(document.querySelector("pre code[data-mermaid-source]")).toBeNull(); expect(document.body.textContent).toContain("// mermaid");
    dom.window.close();
  });
});

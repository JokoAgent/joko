import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildMobileMarkdownRichHtml, parseMobileMarkdownRichStatus, type MobileMarkdownRichRuntime } from "./mobile-markdown-rich-html";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transformer = require(resolve(root, "svg-string-transformer.cjs"));
const colors = { surface: "#ffffff", background: "#f7f6f3", ink: "#242a2d", muted: "#637073",
  accent: "#ff9800", border: "#e1e2df", negative: "#cc634e" };

describe("mobile rich Markdown runtime", () => {
  it("builds pinned offline engines and executes real KaTeX with exact source fallback and a scoped status", async () => {
    const entry = resolve(root, "src", "rich-markdown-runtime.richjs");
    const source = transformer.testing.buildRichMarkdownRuntimeModule(readFileSync(entry, "utf8"), entry);
    const bundle = JSON.parse(source.slice("module.exports = ".length, -1)) as MobileMarkdownRichRuntime & {
      mermaidVersion: string; katexVersion: string;
    };
    expect(bundle).toMatchObject({ mermaidVersion: "11.16.0", katexVersion: "0.16.47" });
    expect(bundle.katexCss).toContain("data:font/woff2;base64,");
    const messages: string[] = [];
    const html = buildMobileMarkdownRichHtml({ instanceId: "math-1", kind: "math", source: "x^2 + \\frac{1}{2}", colors }, bundle);
    const dom = new JSDOM(html, { runScripts: "dangerously", beforeParse(window: Window) {
      Object.assign(window, { ReactNativeWebView: { postMessage: (value: string) => messages.push(value) } });
    } });
    expect(dom.window.document.querySelector(".katex")).not.toBeNull();
    expect(messages.some((value) => parseMobileMarkdownRichStatus(value, "math-1")?.state === "ready")).toBe(true);
    expect(messages.every((value) => parseMobileMarkdownRichStatus(value, "foreign") === undefined)).toBe(true);
    dom.window.close();
    const malicious = "\\invalidcommand </script><img src=https://example.test/secret>";
    const fallback = new JSDOM(buildMobileMarkdownRichHtml({ instanceId: "math-2", kind: "math", source: malicious, colors }, bundle), { runScripts: "dangerously" });
    expect(fallback.window.document.querySelector("#root pre")?.textContent).toBe(malicious);
    expect(fallback.window.document.querySelector("img")).toBeNull();
    expect(fallback.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content).toContain("connect-src 'none'");
    fallback.window.close();
    const mermaidDom = new JSDOM("", { runScripts: "outside-only" });
    mermaidDom.window.eval(bundle.mermaidScript);
    const engine = mermaidDom.window.jokoMermaid;
    engine.initialize({ startOnLoad: false, securityLevel: "strict" });
    expect(await engine.parse("graph TD; A-->B")).toMatchObject({ diagramType: "flowchart-v2" });
    await expect(engine.parse("this is not a diagram")).rejects.toThrow();
    mermaidDom.window.close();
  });
});

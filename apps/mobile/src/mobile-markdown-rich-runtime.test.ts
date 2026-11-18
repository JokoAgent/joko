import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildMobileMarkdownRichHtml, parseMobileMarkdownDiagramPng, parseMobileMarkdownRichStatus,
  requestMobileMarkdownDiagramPngScript, type MobileMarkdownRichRuntime
} from "./mobile-markdown-rich-html";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transformer = require(resolve(root, "svg-string-transformer.cjs"));
const colors = { surface: "#ffffff", background: "#f7f6f3", ink: "#242a2d", muted: "#637073",
  accent: "#ff9800", border: "#e1e2df", negative: "#cc634e" };

describe("mobile rich Markdown runtime", () => {
  it.each([false, true].flatMap(dark => (["math", "mermaid"] as const).map(kind => ({ dark, kind }))))(
    "accepts the application theme for $kind without treating dark=$dark as a CSS color", ({ dark, kind }) => {
      const theme = { ...colors, surface: dark ? "#24292d" : "#ffffff", ink: dark ? "#f4f4f2" : "#242a2d",
        brandBackground: dark ? "#302920" : "#fff1db", dark };
      const html = buildMobileMarkdownRichHtml({ instanceId: "theme-rich", kind,
        source: kind === "math" ? "x^2" : "graph TD; A-->B", colors: theme },
      { mermaidScript: "", katexScript: "", katexCss: "" });
      expect(html).toContain(`background:${theme.surface};color:${theme.ink}`);
      expect(html).toContain("connect-src 'none'");
      expect(html).not.toContain(theme.brandBackground);
    });

  it("rejects injected declared colors and oversized rich source", () => {
    const input = { instanceId: "theme-rich", kind: "math" as const, source: "x^2", colors };
    const runtime = { mermaidScript: "", katexScript: "", katexCss: "" };
    for (const key of Object.keys(colors) as (keyof typeof colors)[]) {
      expect(() => buildMobileMarkdownRichHtml({ ...input, colors: { ...colors, [key]: "#fff;display:none" } }, runtime)).toThrow("invalid");
    }
    expect(() => buildMobileMarkdownRichHtml({ ...input, source: "x".repeat(100_001) }, runtime)).toThrow("invalid");
  });

  const malformedFlow = "flowchart TD\nA[foo(bar)] --> B";
  const repairedFlow = 'flowchart TD\nA["foo(bar)"] --> B';
  const gantt = "gantt\ndateFormat YYYY-MM-DD\nFirst task :first, 2026-11-18, 2d";
  it.each([
    { source: gantt, attempts: [gantt], rejected: [], state: "ready", zoomable: true },
    { source: malformedFlow, attempts: [malformedFlow, repairedFlow], rejected: [malformedFlow], state: "ready", zoomable: false },
    { source: malformedFlow, attempts: [malformedFlow, repairedFlow], rejected: [malformedFlow, repairedFlow], state: "error", zoomable: true },
    { source: "invalid diagram", attempts: ["invalid diagram"], rejected: ["invalid diagram"], state: "error", zoomable: false }
  ])("keeps the original source and reports $state after the expected Mermaid attempts", async ({ source, attempts, rejected, state, zoomable }) => {
    const statuses: ReturnType<typeof parseMobileMarkdownRichStatus>[] = [];
    const engine = {
      initialize: vi.fn(),
      render: vi.fn(async (_id: string, text: string) => {
        if (rejected.includes(text)) throw new Error("The diagram could not be rendered.");
        return { svg: '<svg viewBox="0 0 760 120"><title>Preview</title></svg>' };
      })
    };
    const html = buildMobileMarkdownRichHtml({ instanceId: "diagram", kind: "mermaid", source, colors, zoomable },
      { mermaidScript: "", katexScript: "", katexCss: "" });
    const dom = new JSDOM(html, { runScripts: "dangerously", beforeParse(window: Window) {
      Object.assign(window, { jokoMermaid: engine,
        ReactNativeWebView: { postMessage: (value: string) => statuses.push(parseMobileMarkdownRichStatus(value, "diagram")) } });
    } });
    try {
      await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe(state));
      expect(engine.initialize).toHaveBeenCalledWith(expect.objectContaining({ gantt: { useWidth: 760 }, securityLevel: "strict" }));
      expect(engine.render.mock.calls.map(([, text]) => text)).toEqual(attempts);
      const root = dom.window.document.querySelector("#root");
      expect(root?.classList.contains("diagram")).toBe(state === "ready");
      if (state === "ready") expect(root?.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 760 120");
      else expect(root?.querySelector("pre")?.textContent).toBe(source);
      expect(html.includes("height:calc(100vh - 16px)")).toBe(zoomable);
    } finally { dom.window.close(); }
  });

  it("encodes the full chart viewBox with the surface color on an explicit PNG request", async () => {
    const receipts: string[] = [];
    const drawnSvg: string[] = [];
    const canvas = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
    const engine = { initialize: vi.fn(), render: vi.fn(async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="40 -10 760 120"><title>Only the chart</title></svg>'
    })) };
    class ImageForCanvas {
      onload?: () => void;
      set src(data: string) {
        drawnSvg.push(decodeURIComponent(data.slice(data.indexOf(",") + 1)));
        queueMicrotask(() => this.onload?.());
      }
    }
    const dom = new JSDOM(buildMobileMarkdownRichHtml({ instanceId: "chart", kind: "mermaid", colors, source: gantt, zoomable: true },
      { mermaidScript: "", katexScript: "", katexCss: "" }), {
      runScripts: "dangerously",
      beforeParse(window: Window & typeof globalThis) {
        Object.assign(window, { Image: ImageForCanvas, jokoMermaid: engine,
          ReactNativeWebView: { postMessage: (raw: string) => receipts.push(raw) } });
        Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", { value: () => canvas });
        Object.defineProperty(window.HTMLCanvasElement.prototype, "toDataURL", { value: () => "data:image/png;base64,QQ==" });
      }
    });
    try {
      await vi.waitFor(() => expect(receipts.some(raw => parseMobileMarkdownRichStatus(raw, "chart")?.state === "ready")).toBe(true));
      expect(drawnSvg).toEqual([]);
      dom.window.eval(requestMobileMarkdownDiagramPngScript("original"));
      await vi.waitFor(() => expect(parseMobileMarkdownDiagramPng(receipts.at(-1)!, "chart", "original")).toEqual({ base64: "QQ==" }));
      expect(drawnSvg).toHaveLength(1);
      expect(drawnSvg[0]).toContain('viewBox="40 -10 760 120"');
      expect(drawnSvg[0]).toContain('width="2280" height="360"');
      expect(drawnSvg[0]).toContain("<title>Only the chart</title>");
      expect(canvas.fillStyle).toBe(colors.surface);
      expect(canvas.fillRect).toHaveBeenCalledWith(0, 0, 2280, 360);
      expect(canvas.drawImage).toHaveBeenCalledWith(expect.any(ImageForCanvas), 0, 0, 2280, 360);
      expect(parseMobileMarkdownDiagramPng(receipts.at(-1)!, "other-chart", "original")).toBeUndefined();
    } finally { dom.window.close(); }
  });

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
    await expect(engine.parse(malformedFlow)).rejects.toThrow();
    expect(await engine.parse(repairedFlow)).toMatchObject({ diagramType: "flowchart-v2" });
    expect(await engine.parse(gantt)).toMatchObject({ diagramType: "gantt" });
    await expect(engine.parse("this is not a diagram")).rejects.toThrow();
    mermaidDom.window.close();
  });
});

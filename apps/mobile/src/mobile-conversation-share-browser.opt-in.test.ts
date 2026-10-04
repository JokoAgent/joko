import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { buildMobileConversationShareHtml } from "./mobile-conversation-share-html";
import type { MobileMarkdownRichRuntime } from "./mobile-markdown-rich-html";
import type { MobileConversationShareSnapshot } from "./mobile-conversation-share";

vi.mock("./connection-artwork", () => ({
  mobileConnectionAppIcon: (theme: string) => readFileSync(resolve(import.meta.dirname, "../../../packages/brand-assets/src/icon-" + theme + ".svg"), "utf8")
}));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const enabled = process.env["JOKO_MOBILE_RICH_SHARE_BROWSER"] === "1" && !!process.env["JOKO_BROWSER_EXECUTABLE"];
const browserIt = enabled ? it : it.skip;

describe("offline mobile rich image document in a real browser", () => {
  browserIt("renders pinned math and diagrams, fits wide blocks and preserves image failures without external requests", async () => {
    const transformer = require(resolve(root, "svg-string-transformer.cjs"));
    const entry = resolve(root, "src", "rich-markdown-runtime.richjs");
    const runtime = JSON.parse(transformer.testing.buildRichMarkdownRuntimeModule(readFileSync(entry, "utf8"), entry)
      .slice("module.exports = ".length, -1)) as MobileMarkdownRichRuntime & { mermaidVersion: string; katexVersion: string };
    expect(runtime).toMatchObject({ mermaidVersion: "11.16.0", katexVersion: "0.16.47" });
    const browser = await chromium.launch({ executablePath: process.env["JOKO_BROWSER_EXECUTABLE"], headless: true });
    const requests: string[] = [];
    const text = "# Export\n\n**Bold text** and inline $x^2$.\n\n```typescript\nconst label = 'A very long complete line of source that must remain in the image, including this ending';\n```\n\n| First column | Second column | Third column | Fourth column |\n| --- | --- | --- | --- |\n| one | two | three | final cell |\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n```mermaid\nflowchart LR\n A[Start] → B[Complete]\n```\n\n```mermaid\nthis is not a diagram\n```\n\n$$\n\\invalidcommand\n$$\n\n[Website](https://example.test/export) ![Missing external image](https://example.test/image.png)\n\n<script>window.injected = true</script>";
    const snapshot: MobileConversationShareSnapshot = { leaseId: "share", allShareableIds: ["a", "b", "c"], messages: [
      { clientId: "a", kind: "user", body: "Question", bodyParts: [{ kind: "text", text: "Question" }], attachments: [] },
      { clientId: "c", kind: "assistant", body: text, attachments: [], bodyParts: [{ kind: "text", text },
        { kind: "image", key: "canonical", label: "Decoded image" }, { kind: "image", key: "bad-image", label: "Failed image" },
        { kind: "text", text: "After both images" }],
        images: new Map([["canonical", { uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", width: 1, height: 1 }],
          ["bad-image", { uri: "data:image/png;base64,AAAA", width: 10, height: 10 }]]) }
    ] };
    try {
      for (const dark of [false, true]) for (const width of [360, 640]) {
        const page = await browser.newPage({ viewport: { width, height: 760 }, deviceScaleFactor: 1 });
        page.on("request", (request) => { if (!request.url().startsWith("data:") && !request.url().startsWith("about:")) requests.push(request.url()); });
        await page.route("**/*", (route) => route.abort());
        const colors = dark
          ? { background: "#202628", surfaceElevated: "#303638", textPrimary: "#f6f4ef", textSecondary: "#a5afad", textTertiary: "#73807d" }
          : { background: "#f7f6f3", surfaceElevated: "#ffffff", textPrimary: "#242a2d", textSecondary: "#637073", textTertiary: "#8d9792" };
        await page.setContent(buildMobileConversationShareHtml({ snapshot, colors, width, dark }, runtime), { waitUntil: "load" });
        const dimensions = await page.evaluate(async () => await (window as unknown as {
          jokoConversationShareReady: Promise<{ width: number; height: number }>;
        }).jokoConversationShareReady);
        expect(dimensions.width).toBe(width); expect(dimensions.height).toBeGreaterThan(400);
        expect(await page.locator(".katex").count()).toBe(2);
        expect(await page.locator("[data-mermaid-source] svg").count()).toBe(1);
        expect(await page.locator("[data-mermaid-source]").nth(1).textContent()).toBe("this is not a diagram");
        expect(await page.locator("[data-latex]").last().textContent()).toBe("\\invalidcommand");
        expect(await page.locator("img").count()).toBe(1);
        expect((await page.locator("img").boundingBox())?.width).toBe(1);
        expect(await page.locator(".share-image-fallback").allTextContents()).toEqual(["Missing external image", "Failed image"]);
        expect(await page.locator(".share-gap").textContent()).toBe("⋯");
        expect((await page.locator(".share-footer").textContent())?.trim()).toBe("Joko");
        expect(await page.locator("pre code").textContent()).toContain("including this ending");
        expect(await page.locator("td").last().textContent()).toBe("final cell");
        const fitted = await page.locator(".share-fit").evaluateAll((nodes) => nodes.every((node) => {
          const bounds = node.getBoundingClientRect();
          return bounds.height > 0 && bounds.right <= window.innerWidth - 27
            && node.firstElementChild!.getBoundingClientRect().width <= bounds.width + 1;
        }));
        expect(fitted).toBe(true);
        expect(await page.locator("a,[href],iframe,object").count()).toBe(0);
        expect(await page.evaluate(() => (window as unknown as { injected?: boolean }).injected)).toBeUndefined();
        const directory = resolve(root, "dist", "share-verification");
        await mkdir(directory, { recursive: true });
        const png = await page.locator("#joko-share-stage").screenshot({ path: resolve(directory, "rich-" + width + "-" + (dark ? "dark" : "light") + ".png") });
        const stats = await sharp(png).stats();
        expect(stats.channels.some((channel) => channel.stdev > 5)).toBe(true);
        await page.close();
      }
      expect(requests).toEqual([]);
    } finally { await browser.close(); }
  }, 45_000);
});

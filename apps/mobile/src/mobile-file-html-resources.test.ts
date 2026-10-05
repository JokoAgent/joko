import { create } from "@bufbuild/protobuf";
import { BlobRefSchema } from "@joko/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { MobileFileHtmlReader, type MobileFileHtmlContext } from "./mobile-file-html-reader";
import { withHtmlPreviewCsp } from "./mobile-file-html";
import { collectHtmlLocalResourceRefs, planHtmlResourceFetches, applyHtmlResourceUrls, fetchHtmlResourceUrls, resolveHtmlResourcePath } from "./mobile-file-html-resources";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

function resource(text: string, mediaType = "text/javascript") {
  const bytes = new TextEncoder().encode(text);
  return { bytes, mediaType, blob: create(BlobRefSchema, { blobId: "resource", fileName: "app.js", mediaType,
    byteSize: BigInt(bytes.length), sha256Hex: bytesToHex(sha256(bytes)) }) };
}
describe("HTML file resource ownership", () => {
  it("collects real attributes and CSS, keeps raw text intact and bounds every resource to the canonical parent", () => {
    const html = '<!-- <script><img src=comment.png> --><script>const fake = "<img src=private.png>";</script><textarea><img src=hidden.png></textarea>'
      + '<style>p{background:url(./a.png)}</style><div style="background:url(a.png?cache=1)"></div>'
      + '<img src="a.png"><script src="app.js"></script><link href="theme.css"><source src="clip.webm">'
      + '<video src="movie.mp4" poster="a.png"></video><audio src="sound.mp3"></audio><svg><image xlink:href="sprite.svg#mark"></image></svg>'
      + '<img src="../secret.png"><img src="%2e%2e/secret.png"><img src="/private.png"><img src="%2Fprivate.png">'
      + '<img src="https://external.invalid/p.png"><img src="data:image/png;base64,AA"><img src="c:%5cprivate.png">';
    const refs = collectHtmlLocalResourceRefs(html, "docs"); const plan = planHtmlResourceFetches(refs);
    expect(plan.targets.map((item) => [item.relativePath, item.refCount])).toEqual([
      ["docs/a.png", 4], ["docs/app.js", 1], ["docs/theme.css", 1], ["docs/clip.webm", 1],
      ["docs/movie.mp4", 1], ["docs/sound.mp3", 1], ["docs/sprite.svg", 1]
    ]);
    expect(resolveHtmlResourcePath("", "./root.png")).toBe("root.png");
    expect(resolveHtmlResourcePath("docs", "..\\private.png")).toBeNull();
    expect(collectHtmlLocalResourceRefs('<!-- <img src="private.png"><style>body{background:url(hidden.png)}</style> --><p>self contained</p>', "")).toEqual([]);
    const changed = applyHtmlResourceUrls(html, refs, new Map([["docs/a.png", "data:image/png;base64,AAAA"], ["docs/sprite.svg", "data:image/svg+xml;base64,AAAA"]]));
    const dom = new JSDOM(changed); expect(dom.window.document.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(dom.window.document.querySelector("image")!.getAttribute("xlink:href")).toBe("data:image/svg+xml;base64,AAAA#mark");
    expect(dom.window.document.querySelector("script")!.textContent).toContain("<img src=private.png>"); dom.window.close();
    const repeated = collectHtmlLocalResourceRefs(Array.from({ length: 40 }, (_, i) => '<img src="i' + i + '.png">').join("") + '<img src="i39.png"><img src="i0.png">', "");
    expect(planHtmlResourceFetches(repeated)).toMatchObject({ targets: expect.any(Array), skipped: 8 });
    expect(planHtmlResourceFetches(repeated).targets).toHaveLength(32); expect(planHtmlResourceFetches(repeated).targets[0]!.refCount).toBe(2);
  });

  it("charges each actual inline occurrence, bounds concurrent reservations and lets one failed resource leave the page usable", async () => {
    const targets = Array.from({ length: 6 }, (_, i) => ({ relativePath: String(i), mimeType: "image/png", refCount: i === 0 ? 3 : 1 }));
    let active = 0; let peak = 0;
    const output = await fetchHtmlResourceUrls(targets, async (target, limits) => {
      active++; peak = Math.max(peak, active); await Promise.resolve(); active--;
      expect(limits.maxBytes).toBeLessThanOrEqual(12);
      if (target.relativePath === "1") throw new Error("gone");
      return "data:image/png;base64,AAAA";
    }, { perResourceMaxBytes: 12, totalBudgetChars: 320, concurrency: 99 });
    expect(peak).toBeLessThanOrEqual(4); expect(output.failed).toBe(1);
    expect([...output.urls].reduce((total, [path, uri]) => total + uri.length * targets[Number(path)]!.refCount, 0)).toBeLessThanOrEqual(320);
    expect(output.urls.has("0")).toBe(true);
    const inflated = await fetchHtmlResourceUrls(targets.slice(0, 1), async () => "data:image/png;base64," + "A".repeat(200), { totalBudgetChars: 320 });
    expect(inflated).toMatchObject({ failed: 0, overBudget: 1 }); expect(inflated.urls.size).toBe(0);
  });

  it("waits for authenticated complete bytes, rejects a digest mismatch and mounts usable inline script and CSS", async () => {
    const reader = new MobileFileHtmlReader(); const assertCurrent = vi.fn(); const revalidateSource = vi.fn(async () => undefined);
    const readResource = vi.fn(async (target) => target.relativePath.endsWith("broken.png") ? { ...resource("corrupt", "image/png"), bytes: new Uint8Array([0]) }
      : target.relativePath.endsWith("theme.css") ? resource("p {color: rgb(12, 34, 56)}", "text/css")
        : resource('document.getElementById("action").onclick=function(){document.getElementById("result").textContent="clicked";}'));
    const html = '<link rel="stylesheet" href="theme.css"><p id="result">idle</p><button id="action">Go</button><script src="app.js"></script><img src="broken.png">';
    const descriptor = await reader.prepare("page", html, { baseDirectory: "docs", assertCurrent, revalidateSource, readResource }, new AbortController().signal);
    expect(descriptor).toMatchObject({ total: 3, failed: 1, overBudget: 0 }); expect(revalidateSource).toHaveBeenCalledTimes(2);
    expect(readResource).toHaveBeenCalledTimes(3);
    const dom = new JSDOM(withHtmlPreviewCsp(descriptor.html), { runScripts: "dangerously", resources: "usable" });
    await new Promise<void>((resolve) => dom.window.addEventListener("load", () => resolve(), { once: true }));
    dom.window.document.getElementById("action")!.click(); expect(dom.window.document.getElementById("result")!.textContent).toBe("clicked");
    expect(dom.window.getComputedStyle(dom.window.document.querySelector("p")!).color).toBe("rgb(12, 34, 56)");
    dom.window.close(); reader.release(descriptor.leaseId); expect(() => reader.assertCurrent(descriptor.leaseId)).toThrow(/released/u);
    readResource.mockClear(); revalidateSource.mockClear();
    await reader.prepare("self", "<p>self-contained</p>", { baseDirectory: "docs", assertCurrent, revalidateSource, readResource }, new AbortController().signal);
    expect(readResource).not.toHaveBeenCalled(); expect(revalidateSource).not.toHaveBeenCalled(); reader.releaseAll();
  });

  it("cancels promptly while raw late reads hold all four slots across the next page", async () => {
    const reader = new MobileFileHtmlReader(); let pending: (() => void)[] = []; let active = 0; let peak = 0;
    const readResource = vi.fn(() => new Promise<ReturnType<typeof resource>>((resolve) => {
      active++; peak = Math.max(peak, active); pending.push(() => { active--; resolve(resource("/* small */")); });
    }));
    const context: MobileFileHtmlContext = { baseDirectory: "", assertCurrent: (signal) => signal?.throwIfAborted(), revalidateSource: vi.fn(async () => undefined), readResource };
    const html = Array.from({ length: 8 }, (_, i) => '<script src="app' + i + '.js"></script>').join("");
    const controller = new AbortController(); const old = reader.prepare("old", html, context, controller.signal);
    await vi.waitFor(() => expect(readResource).toHaveBeenCalledTimes(3));
    controller.abort(); await expect(old).rejects.toThrow();
    const middleController = new AbortController();
    const middleContext: MobileFileHtmlContext = { ...context, revalidateSource: vi.fn(() => new Promise<void>((resolve) => {
      active++; peak = Math.max(peak, active); pending.push(() => { active--; resolve(); });
    })) };
    const middle = reader.prepare("middle", '<script src="app.js"></script>', middleContext, middleController.signal);
    await vi.waitFor(() => expect(middleContext.revalidateSource).toHaveBeenCalledOnce()); expect(active).toBe(4);
    middleController.abort(); await expect(middle).rejects.toThrow();
    const next = reader.prepare("next", '<script src="app.js"></script>', context, new AbortController().signal);
    await Promise.resolve(); expect(context.revalidateSource).toHaveBeenCalledTimes(1);
    pending.shift()!(); await vi.waitFor(() => expect(readResource).toHaveBeenCalledTimes(4));
    expect(peak).toBe(4);
    while (pending.length) pending.shift()!();
    const descriptor = await next; expect(descriptor.failed).toBe(0); expect(descriptor.html).toContain("data:text/javascript;base64,"); reader.releaseAll();
  });
});

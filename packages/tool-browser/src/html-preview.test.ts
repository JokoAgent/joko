import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import { BrowserProvider } from "./provider.js";
import { HTML_PREVIEW_CSP, installHtmlSnapshot, validateHtmlSnapshot, workspaceHtmlPreviewUrl } from "./html-preview.js";

describe("isolated HTML snapshots", () => {
  it("rejects missing, oversized and misaddressed snapshots before page creation", () => {
    const url = workspaceHtmlPreviewUrl("preview-1");
    expect(() => validateHtmlSnapshot(url)).toThrow(/expired/u);
    expect(() => validateHtmlSnapshot("https://other.preview.joko.invalid/asset.html")).toThrow(/expired/u);
    expect(() => validateHtmlSnapshot("https://example.test/", { html: "<p>hello</p>", assertCurrent: () => undefined })).toThrow(/isolated/u);
    expect(() => validateHtmlSnapshot(url, { html: "é".repeat(1_048_577), assertCurrent: () => undefined })).toThrow(/bounded/u);
  });

  it.skipIf(process.env.JOKO_BROWSER_EXECUTABLE === undefined)("runs inline interactions in an opaque document while blocking unsupported resources, popups, forms and downloads", async () => {
    const browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    try {
      const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      const page = await context.newPage();
      let active = true;
      let downloads = 0;
      page.on("download", () => { downloads += 1; });
      const url = workspaceHtmlPreviewUrl("snapshot-one");
      await installHtmlSnapshot(page, url, { assertCurrent: () => { if (!active) throw new Error("retired"); }, html: `<!doctype html><title>Snapshot</title>
        <style>p { color: rgb(1, 2, 3) }</style><p id="text">Visible</p>
        <script>document.getElementById('text').textContent = 'executed';</script><button id="interactive" onclick="document.getElementById('text').textContent = 'clicked'">Interact</button>
        <img src="https://remote.example.test/image.png"><iframe src="https://remote.example.test/frame"></iframe>
        <a id="popup" target="_blank" href="https://remote.example.test/popup">Popup</a>
        <a id="download" download="file.txt" href="data:text/plain,content">Download</a>
        <form action="https://remote.example.test/form"><button id="submit">Submit</button></form>
        <a id="navigate" href="https://remote.example.test/navigate">Navigate</a>` });
      const response = await page.goto(url);
      expect(response?.headers()["content-security-policy"]).toBe(HTML_PREVIEW_CSP);
      expect(await page.locator("#text").textContent()).toBe("executed");
      await page.locator("#interactive").click();
      expect(await page.locator("#text").textContent()).toBe("clicked");
      expect(await page.locator("#text").evaluate((node) => getComputedStyle(node).color)).toBe("rgb(1, 2, 3)");
      expect(await page.evaluate(() => window.origin)).toBe("null");
      expect(await page.evaluate(() => { try { return localStorage.length; } catch (error) { return (error as Error).name; } })).toBe("SecurityError");
      const successes: string[] = [];
      page.on("response", (value) => { successes.push(value.url()); });
      await expect(page.evaluate(() => fetch("https://remote.example.test/fetch"))).rejects.toThrow();
      await page.locator("#popup").click();
      await page.locator("#download").click();
      await page.locator("#submit").click();
      expect(context.pages()).toHaveLength(1);
      expect(downloads).toBe(0);
      expect(page.url()).toBe(url);
      await page.locator("#navigate").click().catch(() => undefined);
      expect(successes).toEqual([]);
      active = false;
      await expect(page.goto(url)).rejects.toThrow();
    } finally { await browser.close(); }
  }, 20_000);

  it.skipIf(process.env.JOKO_BROWSER_EXECUTABLE === undefined)("opens a governed page and refuses URL-only recovery after the runtime retires its source", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-html-browser-"));
    const provider = new BrowserProvider({ providerId: "browser", executablePath: process.env.JOKO_BROWSER_EXECUTABLE!,
      profileDirectories: { sidebar: join(root, "sidebar"), external: join(root, "external") }, targetMode: "sidebar", downloadDirectory: join(root, "downloads"), uploadRoots: [] });
    const url = workspaceHtmlPreviewUrl("runtime-owned");
    const dispose = vi.fn();
    try {
      await provider.start();
      const originalPage = (await provider.listPages())[0]!;
      const originalTakeover = await provider.beginHumanTakeover({ providerId: provider.id, pageId: originalPage.id, generation: provider.generation, owner: "connection" });
      let originalContext: import("playwright-core").BrowserContext | undefined;
      await provider.runHumanTakeoverOperation(originalTakeover, async (page) => {
        originalContext = page.context();
        await originalContext.addCookies([{ name: "authenticated", value: "fixture", domain: "account.example.test", path: "/" }]);
      });
      await provider.endHumanTakeover(originalTakeover);
      const takeover = await provider.openHumanPage({ providerId: provider.id, generation: provider.generation, owner: "connection", url }, 5_000,
        { html: "<!doctype html><title>Local snapshot</title><p>Managed</p>", assertCurrent: () => undefined, dispose });
      expect(dispose).not.toHaveBeenCalled();
      expect((await provider.listPages()).find((page) => page.id === takeover.pageId)).toMatchObject({ title: "Local snapshot", url });
      await provider.runHumanTakeoverOperation(takeover, async (page) => {
        expect(page.context()).not.toBe(originalContext);
        expect(await page.context().cookies()).toEqual([]);
        expect(await originalContext!.cookies()).toHaveLength(1);
        expect(page.context().serviceWorkers()).toEqual([]);
        expect(await page.evaluate(() => window.opener)).toBe(null);
      });
      await provider.stop();
      expect(dispose).toHaveBeenCalledOnce();
      await provider.start();
      expect(() => provider.openHumanPage({ providerId: provider.id, generation: provider.generation, owner: "connection", url })).toThrow(/expired/u);
      const releaseFailed = vi.fn();
      await expect(provider.openHumanPage({ providerId: provider.id, generation: provider.generation + 1, owner: "connection", url }, 5_000,
        { html: "<p>Stale</p>", assertCurrent: () => undefined, dispose: releaseFailed })).rejects.toThrow(/stale/u);
      expect(releaseFailed).toHaveBeenCalledOnce();
      const releaseInvalid = vi.fn();
      expect(() => provider.openHumanPage({ providerId: provider.id, generation: provider.generation, owner: "", url }, 5_000,
        { html: "<p>Invalid</p>", assertCurrent: () => undefined, dispose: releaseInvalid })).toThrow(/owner/u);
      expect(releaseInvalid).toHaveBeenCalledOnce();
    } finally { await provider.stop(); await rm(root, { recursive: true, force: true }); }
  }, 20_000);

  it.skipIf(process.env.JOKO_BROWSER_EXECUTABLE === undefined)("loads nested local styles, modules and images, then fences old resources across reload and owner retirement", async () => {
    const browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    try {
      const page = await browser.newPage({ serviceWorkers: "block", acceptDownloads: false });
      const url = workspaceHtmlPreviewUrl("resources", "pages/demo.html");
      let active = true;
      let revision = 1;
      let release!: () => void;
      let started!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const reading = new Promise<void>((resolve) => { started = resolve; });
      const paths: string[] = [];
      const dispose = vi.fn();
      const replacedDispose = vi.fn();
      const snapshot = (): import("./html-preview.js").BrowserHtmlSnapshot => ({
        html: `<!doctype html><link rel="stylesheet" href="../assets/main.css"><script type="module" src="../assets/main.mjs"></script><p id="value">${revision}</p><img id="image" src="../assets/image.svg">`,
        assertCurrent: () => { if (!active) throw new Error("retired"); }, reload: async () => snapshot(), dispose: revision === 1 ? dispose : replacedDispose,
        readResource: async (path, signal) => {
          paths.push(path);
          if (path === "assets/late.js") { started(); await pending; signal.throwIfAborted(); }
          const resource = {
            "assets/main.css": ["@import './nested/theme.css';", "text/css"],
            "assets/nested/theme.css": ["p { color: rgb(4, 5, 6) }", "text/css"],
            "assets/main.mjs": ["import {word} from './nested/word.mjs'; document.getElementById('value').textContent += word;", "text/javascript"],
            "assets/nested/word.mjs": ["export const word = ' interactive';", "text/javascript"],
            "assets/image.svg": ['<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><rect width="3" height="2" fill="red"/></svg>', "image/svg+xml"],
            "assets/late.js": ["globalThis.late = true;", "text/javascript"]
          }[path];
          if (resource === undefined) throw new Error("Unknown resource");
          return { body: Buffer.from(resource[0]!), mediaType: resource[1]! };
        }
      });
      await installHtmlSnapshot(page, url, snapshot());
      await page.goto(url);
      expect(await page.locator("#value").textContent()).toBe("1 interactive");
      expect(await page.locator("#value").evaluate((node) => getComputedStyle(node).color)).toBe("rgb(4, 5, 6)");
      expect(await page.locator("#image").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(3);
      expect(await page.evaluate(() => window.origin)).toBe("null");
      await page.evaluate(() => { const script = document.createElement("script"); script.src = "../assets/late.js"; document.head.append(script); });
      await reading;
      revision = 2;
      await page.reload();
      release();
      expect(await page.locator("#value").textContent()).toBe("2 interactive");
      expect(await page.evaluate(() => "late" in globalThis)).toBe(false);
      revision = 3;
      await page.reload();
      expect(await page.locator("#value").textContent()).toBe("3 interactive");
      expect(paths.filter((path) => path === "assets/nested/word.mjs")).toHaveLength(3);
      active = false;
      await expect(page.reload()).rejects.toThrow();
      expect(dispose).not.toHaveBeenCalled();
      await page.close();
      expect(dispose).toHaveBeenCalledOnce();
      expect(replacedDispose).not.toHaveBeenCalled();
    } finally { await browser.close(); }
  }, 20_000);

  it("bounds total retained resource bytes and discards a closed page's late read", async () => {
    let route!: (value: any) => Promise<void>;
    let close!: () => void;
    const frame = {};
    const page = { once: (_: string, callback: () => void) => { close = callback; }, route: async (_: string, callback: typeof route) => { route = callback; }, isClosed: () => false, mainFrame: () => frame };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const readResource = vi.fn(async (path: string) => { if (path.endsWith("late.js")) await pending; return { body: Buffer.alloc(2 * 1024 * 1024), mediaType: "text/javascript" }; });
    const url = workspaceHtmlPreviewUrl("budget");
    await installHtmlSnapshot(page as unknown as import("playwright-core").Page, url, { html: "<p>Bounded</p>", assertCurrent: () => undefined, readResource });
    const request = (path: string) => ({ request: () => ({ url: () => new URL(path, url).href, method: () => "GET", isNavigationRequest: () => false, resourceType: () => "script" }), fulfill: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) });
    for (let index = 0; index < 7; index += 1) { const value = request(`${index}.js`); await route(value); expect(value.fulfill).toHaveBeenCalledOnce(); }
    const excessive = request("excessive.js"); await route(excessive);
    expect(excessive.fulfill).not.toHaveBeenCalled(); expect(excessive.abort).toHaveBeenCalledOnce();
    const foreign = request("https://other.preview.joko.invalid/file.js"); await route(foreign);
    expect(foreign.fulfill).not.toHaveBeenCalled();
    const dispose = vi.fn();
    let readSignal: AbortSignal | undefined;
    const blockedRead = vi.fn(async (_path: string, signal: AbortSignal) => { readSignal = signal; await pending; return { body: Buffer.from("globalThis.late = true"), mediaType: "text/javascript" }; });
    await installHtmlSnapshot(page as unknown as import("playwright-core").Page, url, { html: "<p>Bounded</p>", assertCurrent: () => undefined, readResource: blockedRead, dispose });
    const late = Array.from({ length: 9 }, (_, index) => request(`late-${index}.js`));
    const results = late.map((value) => route(value));
    await Promise.resolve();
    expect(blockedRead).toHaveBeenCalledTimes(8);
    expect(dispose).not.toHaveBeenCalled();
    close();
    expect(readSignal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    release(); await Promise.all(results);
    expect(blockedRead).toHaveBeenCalledTimes(8);
    for (const value of late) { expect(value.fulfill).not.toHaveBeenCalled(); expect(value.abort).toHaveBeenCalledOnce(); }
  });
});

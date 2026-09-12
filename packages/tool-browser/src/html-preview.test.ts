import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import { BrowserProvider } from "./provider.js";
import { HTML_PREVIEW_CSP, installHtmlSnapshot, isWorkspaceHtmlPreviewUrl, validateHtmlSnapshot, workspaceHtmlPreviewUrl } from "./html-preview.js";

describe("isolated HTML snapshots", () => {
  it("rejects missing, oversized and misaddressed snapshots before page creation", () => {
    const url = workspaceHtmlPreviewUrl("preview-1");
    expect(() => validateHtmlSnapshot(url)).toThrow(/expired/u);
    expect(() => validateHtmlSnapshot("http://other.preview.joko.localhost/asset.html")).toThrow(/expired/u);
    expect(() => validateHtmlSnapshot("https://example.test/", { html: "<p>hello</p>", assertCurrent: () => undefined })).toThrow(/isolated/u);
    expect(() => validateHtmlSnapshot(url, { html: "é".repeat(1_048_577), assertCurrent: () => undefined })).toThrow(/bounded/u);
  });

  it("rejects a percent-encoded Workspace path that cannot fit the governed navigation URL", () => {
    const path = `${"🦊".repeat(1_000)}.html`;
    expect(path.length).toBeLessThan(4_096);
    expect(() => workspaceHtmlPreviewUrl("encoded-path", path)).toThrow(/URL exceeds/u);
    expect(isWorkspaceHtmlPreviewUrl(`http://encoded-path.preview.joko.localhost/${encodeURIComponent(path)}`)).toBe(false);
  });

  it("loads another document only within the page origin and cancels a superseded document generation", async () => {
    let route!: (value: any) => Promise<void>;
    const frame = {};
    const page = { once: vi.fn(), route: async (_: string, callback: typeof route) => { route = callback; }, routeWebSocket: vi.fn(async () => undefined), isClosed: () => false, mainFrame: () => frame };
    let release!: () => void;
    let started!: () => void;
    let slowSignal: AbortSignal | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const readDocument = vi.fn(async (path: string, signal: AbortSignal) => {
      if (path === "pages/slow.html") { slowSignal = signal; started(); await pending; }
      return { html: `<p>${path}</p>`, mediaType: "text/html" as const };
    });
    const url = workspaceHtmlPreviewUrl("documents", "pages/index.html");
    await installHtmlSnapshot(page as unknown as import("playwright-core").Page, url, {
      html: "<a href='./next.html'>Next</a>", assertCurrent: () => undefined, readDocument
    });
    const navigation = (path: string, origin = url) => ({
      request: () => ({ url: () => new URL(path, origin).href, method: () => "GET", isNavigationRequest: () => true,
        resourceType: () => "document", frame: () => frame }),
      fulfill: vi.fn(async () => undefined), abort: vi.fn(async () => undefined)
    });

    const slow = navigation("slow.html?attempt=one");
    const slowResult = route(slow);
    await reading;
    const next = navigation("next.html?attempt=two");
    await route(next);
    expect(slowSignal?.aborted).toBe(true);
    expect(next.abort).not.toHaveBeenCalled();
    expect(next.fulfill).toHaveBeenCalledWith(expect.objectContaining({ body: "<p>pages/next.html</p>", contentType: "text/html; charset=utf-8" }));
    expect(readDocument).toHaveBeenLastCalledWith("pages/next.html", expect.any(AbortSignal));
    release(); await slowResult;
    expect(slow.fulfill).not.toHaveBeenCalled();
    expect(slow.abort).toHaveBeenCalledOnce();

    const foreign = navigation("other.html", "http://other.preview.joko.localhost/");
    await route(foreign);
    expect(foreign.fulfill).toHaveBeenCalledWith(expect.objectContaining({ status: 204 }));
    expect(foreign.abort).not.toHaveBeenCalled();
    expect(readDocument).toHaveBeenCalledTimes(2);
  });

  it("matches local static files to their exact Chromium request type and MIME while freezing each path", async () => {
    let route!: (value: any) => Promise<void>;
    const page = { once: vi.fn(), route: async (_: string, callback: typeof route) => { route = callback; }, routeWebSocket: vi.fn(async () => undefined), isClosed: () => false, mainFrame: vi.fn() };
    const files = new Map<string, { readonly body: Buffer; readonly mediaType: string }>([
      ["assets/app.js", { body: Buffer.from("export {}"), mediaType: "text/javascript" }],
      ["assets/app.css", { body: Buffer.from("body {}"), mediaType: "text/css" }],
      ["assets/icon.svg", { body: Buffer.from("<svg/>"), mediaType: "image/svg+xml" }],
      ["assets/type.woff2", { body: Buffer.from("font"), mediaType: "font/woff2" }],
      ["assets/sound.mp3", { body: Buffer.from("audio"), mediaType: "audio/mpeg" }],
      ["assets/movie.mp4", { body: Buffer.from("video"), mediaType: "video/mp4" }],
      ["assets/data.json", { body: Buffer.from("{}"), mediaType: "application/json" }],
      ["assets/module.wasm", { body: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), mediaType: "application/wasm" }],
      ["assets/font-as-binary.woff2", { body: Buffer.from("font"), mediaType: "application/octet-stream" }],
      ["assets/json-as-script.json", { body: Buffer.from("{}"), mediaType: "application/json" }],
      ["assets/wasm-as-other.wasm", { body: Buffer.from([0]), mediaType: "application/wasm" }]
    ]);
    const readResource = vi.fn(async (path: string) => files.get(path)!);
    const url = workspaceHtmlPreviewUrl("static-types");
    await installHtmlSnapshot(page as unknown as import("playwright-core").Page, url, {
      html: "<p>Static</p>", assertCurrent: () => undefined, readResource
    });
    const resource = (path: string, resourceType: string) => ({
      request: () => ({ url: () => new URL(path, url).href, method: () => "GET", isNavigationRequest: () => false, resourceType: () => resourceType }),
      fulfill: vi.fn(async () => undefined), abort: vi.fn(async () => undefined)
    });
    const allowed = [
      ["assets/app.js", "script"], ["assets/app.css", "stylesheet"], ["assets/icon.svg", "image"],
      ["assets/type.woff2", "font"], ["assets/sound.mp3", "media"], ["assets/movie.mp4", "media"],
      ["assets/data.json", "fetch"], ["assets/module.wasm", "xhr"]
    ] as const;
    for (const [path, resourceType] of allowed) {
      const value = resource(path, resourceType);
      await route(value);
      expect(value.abort, `${path} should be fulfilled`).not.toHaveBeenCalled();
      expect(value.fulfill, `${path} should be fulfilled`).toHaveBeenCalledOnce();
    }
    const cachedFont = resource("assets/type.woff2?variant=two", "font");
    await route(cachedFont);
    expect(cachedFont.fulfill).toHaveBeenCalledOnce();
    expect(readResource.mock.calls.filter(([path]) => path === "assets/type.woff2")).toHaveLength(1);

    for (const [path, resourceType] of [
      ["assets/font-as-binary.woff2", "font"], ["assets/json-as-script.json", "script"], ["assets/wasm-as-other.wasm", "other"]
    ] as const) {
      const value = resource(path, resourceType);
      await route(value);
      expect(value.fulfill, `${path} should be blocked`).not.toHaveBeenCalled();
      expect(value.abort, `${path} should be blocked`).toHaveBeenCalledOnce();
    }
  });

  it.skipIf(process.env.JOKO_BROWSER_EXECUTABLE === undefined)("runs inline interactions in an opaque secure document while blocking frames, popups, forms and downloads", async () => {
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
        <iframe src="https://remote.example.test/frame"></iframe>
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
      expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
      expect(await page.evaluate(() => { try { return localStorage.length; } catch (error) { return (error as Error).name; } })).toBe("SecurityError");
      await page.locator("#popup").click();
      await page.locator("#download").click();
      await page.locator("#submit").click();
      expect(context.pages()).toHaveLength(1);
      expect(downloads).toBe(0);
      expect(page.url()).toBe(url);
      await page.locator("#navigate").click().catch(() => undefined);
      expect(page.url()).toBe(url);
      active = false;
      await expect(page.goto(url)).rejects.toThrow();
    } finally { await browser.close(); }
  }, 20_000);

  it.skipIf(process.env.JOKO_BROWSER_EXECUTABLE === undefined)("uses Chromium's font, media and fetch classifications and follows a governed local document link", async () => {
    const browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    try {
      const page = await browser.newPage({ serviceWorkers: "block", acceptDownloads: false });
      const url = workspaceHtmlPreviewUrl("browser-types", "pages/index.html");
      const requested = new Map<string, string>();
      page.on("request", (request) => {
        const target = new URL(request.url());
        if (target.origin === new URL(url).origin) requested.set(decodeURIComponent(target.pathname.slice(1)), request.resourceType());
      });
      const readDocument = vi.fn(async (path: string) => ({
        html: `<!doctype html><p id="document">${path}</p><script>document.body.dataset.documentReady = "yes";</script>`,
        mediaType: "text/html" as const
      }));
      const readResource = vi.fn(async (path: string) => {
        const value = {
          "assets/type.woff2": [Buffer.from("not-a-real-font"), "font/woff2"],
          "assets/sound.mp3": [Buffer.from("ID3"), "audio/mpeg"],
          "assets/movie.mp4": [Buffer.from("not-a-real-video"), "video/mp4"],
          "assets/data.json": [Buffer.from('{"answer":42}'), "application/json"],
          "assets/empty.wasm": [Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), "application/wasm"]
        }[path];
        if (value === undefined) throw new Error(`Unknown resource: ${path}`);
        return { body: value[0] as Buffer, mediaType: value[1] as string };
      });
      await installHtmlSnapshot(page, url, {
        html: `<!doctype html><style>@font-face { font-family: Local; src: url('../assets/type.woff2') format('woff2'); } #font { font-family: Local }</style>
          <p id="font">Font</p><audio preload="auto" src="../assets/sound.mp3"></audio><video preload="auto" src="../assets/movie.mp4"></video>
          <a id="next" href="./details.html">Next</a><output id="result"></output><script>
          Promise.all([fetch('../assets/data.json').then((response) => response.json()), WebAssembly.instantiateStreaming(fetch('../assets/empty.wasm'))])
            .then(([data]) => { document.getElementById('result').textContent = String(data.answer); document.body.dataset.ready = 'yes'; });</script>`,
        assertCurrent: () => undefined, readDocument, readResource
      });
      await page.goto(url);
      await page.waitForFunction(() => document.body.dataset.ready === "yes");
      await expect.poll(() => [...requested.keys()]).toEqual(expect.arrayContaining([
        "assets/type.woff2", "assets/sound.mp3", "assets/movie.mp4", "assets/data.json", "assets/empty.wasm"
      ]));
      expect(await page.locator("#result").textContent()).toBe("42");
      expect([...requested]).toEqual(expect.arrayContaining([
        ["assets/type.woff2", "font"], ["assets/sound.mp3", "media"], ["assets/movie.mp4", "media"],
        ["assets/data.json", "fetch"], ["assets/empty.wasm", "fetch"]
      ]));
      await page.locator("#next").click();
      await page.waitForURL("**/pages/details.html");
      expect(await page.locator("#document").textContent()).toBe("pages/details.html");
      expect(await page.evaluate(() => window.origin)).toBe("null");
      expect(readDocument).toHaveBeenCalledWith("pages/details.html", expect.any(AbortSignal));
    } finally { await browser.close(); }
  }, 20_000);

  it.skipIf(process.env.JOKO_BROWSER_EXECUTABLE === undefined)("loads isolated HTTP and WebSocket resources without allowing an external document navigation", async () => {
    const requests: { readonly path: string; readonly referer: string | undefined }[] = [];
    const failures: { readonly url: string; readonly error: string | undefined }[] = [];
    const consoleMessages: string[] = [];
    const webSocketMessages: string[] = [];
    const webSocketOrigins: (string | undefined)[] = [];
    const sockets = new Set<Duplex>();
    const server = createServer((request, response) => {
      requests.push({ path: request.url ?? "", referer: request.headers.referer });
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (request.url === "/style.css") { response.setHeader("Content-Type", "text/css"); response.end("#network { color: rgb(7, 8, 9) }"); return; }
      if (request.url === "/script.js") { response.setHeader("Content-Type", "text/javascript"); response.end("document.body.dataset.networkScript = 'yes'"); return; }
      if (request.url === "/pixel.svg") { response.setHeader("Content-Type", "image/svg+xml"); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="5" height="4"/>'); return; }
      if (request.url === "/data.json") { response.setHeader("Content-Type", "application/json"); response.end('{"answer":42}'); return; }
      response.setHeader("Content-Type", "text/html"); response.end("<p>External document</p>");
    });
    server.on("upgrade", (request, socket) => {
      webSocketOrigins.push(request.headers.origin);
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("end", () => socket.end());
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") { socket.destroy(); return; }
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const message = Buffer.from("server");
      socket.write(Buffer.concat([Buffer.from([0x81, message.byteLength]), message]));
      socket.on("data", (chunk) => {
        if (chunk.byteLength < 6 || (chunk[1]! & 0x80) === 0) return;
        const opcode = chunk[0]! & 0x0f;
        const length = chunk[1]! & 0x7f;
        if (length >= 126 || chunk.byteLength < 6 + length) return;
        const mask = chunk.subarray(2, 6);
        const payload = Buffer.alloc(length);
        for (let index = 0; index < length; index += 1) payload[index] = chunk[6 + index]! ^ mask[index % 4]!;
        if (opcode === 1) webSocketMessages.push(payload.toString("utf8"));
        else if (opcode === 8) {
          socket.write(Buffer.concat([Buffer.from([0x88, payload.byteLength]), payload]));
          socket.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    try {
      const page = await browser.newPage({ serviceWorkers: "block", acceptDownloads: false });
      page.on("requestfailed", (request) => failures.push({ url: request.url(), error: request.failure()?.errorText }));
      page.on("console", (message) => consoleMessages.push(message.text()));
      const url = workspaceHtmlPreviewUrl("network-resources");
      await installHtmlSnapshot(page, url, { assertCurrent: () => undefined, html: `<!doctype html>
        <link rel="stylesheet" href="${origin}/style.css"><p id="network">Network</p>
        <img id="network-image" src="${origin}/pixel.svg"><script src="${origin}/script.js"></script>
        <a id="external-navigation" href="${origin}/outside.html">Leave</a><a id="local-navigation" href="details.html">Details</a><output id="network-result"></output>
        <script>
          (async () => {
            try {
              const data = await fetch("${origin}/data.json").then((response) => response.json());
              document.getElementById("network-result").textContent = String(data.answer);
              document.body.dataset.networkWebSocket = await new Promise((resolve) => {
                const timeout = setTimeout(() => resolve("timeout"), 3000);
                const socket = new WebSocket("ws://127.0.0.1:${port}/socket");
                socket.onopen = () => socket.send("client");
                socket.onmessage = (event) => { clearTimeout(timeout); document.body.dataset.networkWebSocketMessage = event.data; resolve("open"); };
                socket.onerror = () => { clearTimeout(timeout); resolve("error"); };
              });
            } catch (error) { document.body.dataset.networkError = String(error); }
            document.body.dataset.networkReady = "yes";
          })();
        </script>`,
        readDocument: async (path) => ({ html: `<!doctype html><h1 id="network-details">${path}</h1>`, mediaType: "text/html" })
      });
      await page.goto(url);
      await page.waitForFunction(() => document.body.dataset.networkReady === "yes");
      expect({
        color: await page.locator("#network").evaluate((node) => getComputedStyle(node).color),
        imageWidth: await page.locator("#network-image").evaluate((node) => (node as HTMLImageElement).naturalWidth),
        result: await page.locator("#network-result").textContent(),
        script: await page.evaluate(() => document.body.dataset.networkScript),
        error: await page.evaluate(() => document.body.dataset.networkError),
        webSocket: await page.evaluate(() => document.body.dataset.networkWebSocket),
        webSocketMessage: await page.evaluate(() => document.body.dataset.networkWebSocketMessage),
        requests,
        failures,
        consoleMessages
      }).toEqual({ color: "rgb(7, 8, 9)", imageWidth: 5, result: "42", script: "yes", error: undefined, webSocket: "open", webSocketMessage: "server",
        requests: expect.arrayContaining([expect.objectContaining({ path: "/style.css" }), expect.objectContaining({ path: "/script.js" }),
          expect.objectContaining({ path: "/pixel.svg" }), expect.objectContaining({ path: "/data.json" })]), failures: [], consoleMessages: [] });
      expect(requests.map((request) => request.path)).toEqual(expect.arrayContaining(["/style.css", "/script.js", "/pixel.svg", "/data.json"]));
      expect(requests.every((request) => request.referer === undefined)).toBe(true);
      await expect.poll(() => webSocketMessages).toContain("client");
      expect(webSocketOrigins).toEqual(["null"]);
      await page.locator("#external-navigation").click().catch(() => undefined);
      expect(page.url()).toBe(url);
      await page.locator("#local-navigation").click();
      await page.waitForURL("**/details.html");
      expect(await page.locator("#network-details").textContent()).toBe("details.html");
      await expect.poll(() => sockets.size).toBe(0);
    } finally {
      await browser.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  }, 20_000);

  it.skipIf(process.env.JOKO_BROWSER_EXECUTABLE === undefined)("opens an external headed governed page and refuses URL-only recovery after the runtime retires its source", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-html-browser-"));
    const provider = new BrowserProvider({ providerId: "browser", executablePath: process.env.JOKO_BROWSER_EXECUTABLE!,
      profileDirectories: { sidebar: join(root, "sidebar"), external: join(root, "external") }, targetMode: "external", downloadDirectory: join(root, "downloads"), uploadRoots: [] });
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
    const page = { once: (_: string, callback: () => void) => { close = callback; }, route: async (_: string, callback: typeof route) => { route = callback; }, routeWebSocket: vi.fn(async () => undefined), isClosed: () => false, mainFrame: () => frame };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const readResource = vi.fn(async (path: string) => { if (path.endsWith("late.js")) await pending; return { body: Buffer.alloc(2 * 1024 * 1024), mediaType: "text/javascript" }; });
    const url = workspaceHtmlPreviewUrl("budget");
    await installHtmlSnapshot(page as unknown as import("playwright-core").Page, url, { html: "<p>Bounded</p>", assertCurrent: () => undefined, readResource });
    const request = (path: string) => ({ request: () => ({ url: () => new URL(path, url).href, method: () => "GET", isNavigationRequest: () => false, resourceType: () => "script" }), fulfill: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) });
    for (let index = 0; index < 7; index += 1) { const value = request(`${index}.js`); await route(value); expect(value.fulfill).toHaveBeenCalledOnce(); }
    const excessive = request("excessive.js"); await route(excessive);
    expect(excessive.fulfill).not.toHaveBeenCalled(); expect(excessive.abort).toHaveBeenCalledOnce();
    const foreign = request("http://other.preview.joko.localhost/file.js"); await route(foreign);
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

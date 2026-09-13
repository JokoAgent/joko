import type { Page, Request, WebSocketRoute } from "playwright-core";
import WebSocket, { type RawData } from "ws";
import { MAXIMUM_TAKEOVER_NAVIGATION_URL_LENGTH } from "./takeovers.js";

export const HTML_PREVIEW_MAXIMUM_BYTES = 2 * 1024 * 1024;
export const HTML_PREVIEW_TOTAL_BYTES = 16 * 1024 * 1024;
export const HTML_PREVIEW_MAXIMUM_RESOURCES = 128;
export const HTML_PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' http: https:; style-src 'unsafe-inline' http: https:; img-src data: http: https:; media-src data: http: https:; font-src data: http: https:; connect-src http: https: ws: wss:; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

export interface BrowserHtmlResource { readonly body: Buffer; readonly mediaType: string }
export interface BrowserHtmlDocument { readonly html: string; readonly mediaType: "text/html" }
export interface BrowserHtmlSnapshot {
  readonly html: string;
  readonly assertCurrent: () => void;
  readonly readDocument?: (path: string, signal: AbortSignal) => Promise<BrowserHtmlDocument>;
  readonly readResource?: (path: string, signal: AbortSignal) => Promise<BrowserHtmlResource>;
  readonly reload?: (signal: AbortSignal) => Promise<BrowserHtmlSnapshot>;
  /** Idempotently releases the original read owner when this page ends. */
  readonly dispose?: () => void;
}

export function workspaceHtmlPreviewUrl(id: string, path = "index.html"): string {
  if (!/^[a-z0-9-]{1,80}$/u.test(id) || !validPath(path)) throw new Error("Invalid HTML preview identity.");
  const url = `http://${id}.preview.joko.localhost/${path.split("/").map(encodeURIComponent).join("/")}`;
  if (url.length > MAXIMUM_TAKEOVER_NAVIGATION_URL_LENGTH) throw new RangeError("HTML preview URL exceeds its safe bound.");
  return url;
}

export function isWorkspaceHtmlPreviewUrl(url: string): boolean {
  if (url.length > MAXIMUM_TAKEOVER_NAVIGATION_URL_LENGTH) return false;
  try {
    const value = new URL(url);
    return value.protocol === "http:" && /^[a-z0-9-]{1,80}\.preview\.joko\.localhost$/u.test(value.hostname)
      && value.port === "" && value.username === "" && value.password === "" && validPath(decodeURIComponent(value.pathname.slice(1)));
  } catch { return false; }
}

function validPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !/[\\:\x00-\x1f]/u.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const RESOURCE_MEDIA_TYPES = new Map<string, ReadonlySet<string>>([
  ["script", new Set(["text/javascript"])],
  ["stylesheet", new Set(["text/css"])],
  ["image", new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon", "image/svg+xml"])],
  ["font", new Set(["font/woff", "font/woff2", "font/ttf", "font/otf"])],
  ["media", new Set([
    "audio/aac", "audio/flac", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm",
    "video/mp4", "video/ogg", "video/quicktime", "video/webm", "video/x-m4v", "video/x-matroska", "video/x-msvideo"
  ])],
  ["fetch", new Set(["application/json", "application/wasm"])],
  ["xhr", new Set(["application/json", "application/wasm"])]
]);

function matchesResourceMediaType(resourceType: string, mediaType: string): boolean {
  return RESOURCE_MEDIA_TYPES.get(resourceType)?.has(mediaType) === true;
}

export function validateHtmlSnapshot(url: string, snapshot?: BrowserHtmlSnapshot): void {
  if (snapshot === undefined) {
    if (new URL(url).hostname.endsWith(".preview.joko.localhost")) throw new Error("This HTML snapshot expired. Open the source file again.");
    return;
  }
  if (!isWorkspaceHtmlPreviewUrl(url) || Buffer.byteLength(snapshot.html, "utf8") > HTML_PREVIEW_MAXIMUM_BYTES) {
    throw new Error("HTML preview requires a bounded isolated snapshot.");
  }
  snapshot.assertCurrent();
}

/** This page alone owns the virtual workspace origin, bytes and read authority. */
export async function installHtmlSnapshot(page: Page, url: string, snapshot: BrowserHtmlSnapshot): Promise<void> {
  validateHtmlSnapshot(url, snapshot);
  const sourceUrl = new URL(url);
  const sourcePath = decodeURIComponent(sourceUrl.pathname.slice(1));
  let current: BrowserHtmlSnapshot | undefined = snapshot;
  const dispose = snapshot.dispose;
  let generation = new AbortController();
  let firstNavigation = true;
  let bytes = Buffer.byteLength(snapshot.html, "utf8");
  let count = 0;
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  const readBounded = <T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    const cancel = (): void => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      reject(signal.reason);
    };
    const start = (): void => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) { reject(signal.reason); waiting.shift()?.(); return; }
      inFlight += 1;
      void Promise.resolve().then(read).then(resolve, reject).finally(() => { inFlight -= 1; waiting.shift()?.(); });
    };
    if (inFlight < 8) start(); else { waiting.push(start); signal.addEventListener("abort", cancel, { once: true }); }
  });
  const resources = new Map<string, Promise<BrowserHtmlResource>>();
  const networkSockets = new Set<WebSocket>();
  page.once("close", () => {
    generation.abort(); current = undefined; resources.clear();
    for (const socket of networkSockets) closeNetworkSocket(socket);
    networkSockets.clear(); dispose?.();
  });
  await page.routeWebSocket("**/*", async (socket) => {
    try {
      current?.assertCurrent();
      if (current === undefined || page.isClosed() || !htmlNetworkSocketAllowed(new URL(socket.url()))) {
        throw new Error("Unsupported HTML WebSocket.");
      }
      const owner = current;
      const socketSignal = generation.signal;
      const upstream = await openHtmlNetworkSocket(socket, socketSignal, () => {
        socketSignal.throwIfAborted();
        owner.assertCurrent();
        if (current === undefined || page.isClosed()) throw new Error("Closed HTML preview.");
      });
      networkSockets.add(upstream);
      upstream.addEventListener("close", () => networkSockets.delete(upstream), { once: true });
    } catch { await socket.close({ code: 1008, reason: "Blocked by HTML preview policy" }).catch(() => undefined); }
  });
  await page.route("**/*", async (route) => {
    let signal = generation.signal;
    try {
      current?.assertCurrent();
      if (current === undefined || page.isClosed()) throw new Error("Closed HTML preview.");
      const request = route.request();
      const target = new URL(request.url());
      if (target.origin !== sourceUrl.origin) {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          await route.fulfill({ status: 204, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
          return;
        }
        if (!htmlNetworkRequestAllowed(request, target)) throw new Error("Unsupported HTML network request.");
        current.assertCurrent();
        const response = await route.fetch({ maxRedirects: 0 });
        signal.throwIfAborted();
        current.assertCurrent();
        await route.fulfill({ response });
        return;
      }
      if (!isWorkspaceHtmlPreviewUrl(request.url()) || request.method() !== "GET") {
        throw new Error("Unsupported HTML request.");
      }
      const path = decodeURIComponent(target.pathname.slice(1));
      let body: string | Buffer;
      let mediaType: string;
      if (request.isNavigationRequest()) {
        if (request.frame() !== page.mainFrame() || request.resourceType() !== "document" || !validPath(path)) {
          throw new Error("Unsupported HTML navigation.");
        }
        if (path !== sourcePath && current.readDocument === undefined) throw new Error("Unsupported HTML navigation.");
        generation.abort(); generation = new AbortController(); signal = generation.signal;
        for (const socket of networkSockets) closeNetworkSocket(socket);
        networkSockets.clear();
        resources.clear(); count = 0;
        bytes = 0;
        const initialRoot = firstNavigation && path === sourcePath;
        firstNavigation = false;
        if (path === sourcePath) {
          if (!initialRoot && current.reload !== undefined) {
            const source = current;
            const next = await readBounded(() => source.reload!(signal), signal);
            signal.throwIfAborted(); source.assertCurrent();
            validateHtmlSnapshot(url, next);
            current = next;
          }
          body = current.html;
        } else {
          const source = current;
          const document = await readBounded(() => source.readDocument!(path, signal), signal);
          signal.throwIfAborted(); source.assertCurrent();
          if (document.mediaType !== "text/html" || typeof document.html !== "string") throw new Error("HTML document type mismatch.");
          body = document.html;
        }
        bytes = Buffer.byteLength(body, "utf8");
        if (bytes > HTML_PREVIEW_MAXIMUM_BYTES) throw new Error("HTML resource budget exhausted.");
        mediaType = "text/html; charset=utf-8";
      } else {
        const resourceType = request.resourceType();
        if (!RESOURCE_MEDIA_TYPES.has(resourceType)) throw new Error("Unsupported HTML resource.");
        if (!validPath(path) || current.readResource === undefined) throw new Error("Invalid HTML resource.");
        let reading = resources.get(path);
        if (reading === undefined) {
          if (++count > HTML_PREVIEW_MAXIMUM_RESOURCES || bytes >= HTML_PREVIEW_TOTAL_BYTES) throw new Error("HTML resource budget exhausted.");
          const source = current;
          reading = readBounded(() => source.readResource!(path, signal), signal).then((value) => {
            signal.throwIfAborted(); source.assertCurrent();
            if (value.body.byteLength > HTML_PREVIEW_MAXIMUM_BYTES || bytes + value.body.byteLength > HTML_PREVIEW_TOTAL_BYTES) throw new Error("HTML resource budget exhausted.");
            bytes += value.body.byteLength;
            return value;
          });
          resources.set(path, reading);
        }
        const resource = await reading;
        body = resource.body; mediaType = resource.mediaType;
        if (!matchesResourceMediaType(resourceType, mediaType)) throw new Error("HTML resource type mismatch.");
      }
      signal.throwIfAborted(); current.assertCurrent();
      await route.fulfill({ status: 200, contentType: mediaType, body,
        headers: { "Content-Security-Policy": HTML_PREVIEW_CSP, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" } });
    } catch { await route.abort("blockedbyclient").catch(() => undefined); }
  });
}

function htmlNetworkRequestAllowed(request: Request, target: URL): boolean {
  return (target.protocol === "http:" || target.protocol === "https:")
    && target.username === "" && target.password === ""
    && !target.hostname.endsWith(".preview.joko.localhost")
    && !request.isNavigationRequest() && RESOURCE_MEDIA_TYPES.has(request.resourceType());
}

function htmlNetworkSocketAllowed(target: URL): boolean {
  return (target.protocol === "ws:" || target.protocol === "wss:")
    && target.username === "" && target.password === ""
    && !target.hostname.endsWith(".preview.joko.localhost");
}

async function openHtmlNetworkSocket(route: WebSocketRoute, signal: AbortSignal, assertCurrent: () => void): Promise<WebSocket> {
  const upstream = new WebSocket(route.url(), route.protocols(), {
    followRedirects: false,
    origin: "null"
  });
  upstream.binaryType = "arraybuffer";
  const pendingPageMessages: (string | Buffer)[] = [];
  let opened = false;
  const retire = (): void => {
    closeNetworkSocket(upstream);
    void route.close({ code: 1008, reason: "HTML preview document retired" }).catch(() => undefined);
  };
  signal.addEventListener("abort", retire, { once: true });
  route.onMessage((message) => {
    try {
      assertCurrent();
      if (opened) upstream.send(message);
      else pendingPageMessages.push(message);
    } catch { retire(); }
  });
  route.onClose((code, reason) => {
    if (code === undefined) closeNetworkSocket(upstream);
    else {
      try { upstream.close(code, reason); }
      catch { closeNetworkSocket(upstream); }
    }
  });
  upstream.on("message", (data, isBinary) => {
    try {
      assertCurrent();
      route.send(isBinary ? webSocketBuffer(data) : data.toString());
    } catch { retire(); }
  });
  upstream.once("close", (eventCode, eventReason) => {
    signal.removeEventListener("abort", retire);
    const code = eventCode === 1005 || eventCode === 1006 ? 1011 : eventCode;
    const reason = eventReason.toString("utf8");
    void route.close({ code, ...(reason === "" ? {} : { reason }) }).catch(() => undefined);
  });
  upstream.on("error", () => { void route.close({ code: 1011, reason: "HTML WebSocket failed" }).catch(() => undefined); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("HTML WebSocket connection timed out.")), 30_000);
      const cleanup = (): void => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", aborted);
        upstream.off("open", opened);
        upstream.off("close", closed);
        upstream.off("error", failed);
      };
      const opened = (): void => { cleanup(); resolve(); };
      const closed = (): void => { cleanup(); reject(new Error("HTML WebSocket connection closed before opening.")); };
      const failed = (): void => { cleanup(); reject(new Error("HTML WebSocket connection failed.")); };
      const aborted = (): void => { cleanup(); reject(signal.reason); };
      upstream.once("open", opened);
      upstream.once("close", closed);
      upstream.once("error", failed);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
    assertCurrent();
    opened = true;
    for (const message of pendingPageMessages.splice(0)) upstream.send(message);
  } catch (error) { closeNetworkSocket(upstream); throw error; }
  return upstream;
}

function closeNetworkSocket(socket: WebSocket): void {
  try { socket.terminate(); } catch { /* The transport is already closed. */ }
}

function webSocketBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

import type { Page } from "playwright-core";

export const HTML_PREVIEW_MAXIMUM_BYTES = 2 * 1024 * 1024;
export const HTML_PREVIEW_TOTAL_BYTES = 16 * 1024 * 1024;
export const HTML_PREVIEW_MAXIMUM_RESOURCES = 128;
export const HTML_PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' https://*.preview.joko.invalid; style-src 'unsafe-inline' https://*.preview.joko.invalid; img-src data: https://*.preview.joko.invalid; media-src data:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

export interface BrowserHtmlResource { readonly body: Buffer; readonly mediaType: string }
export interface BrowserHtmlSnapshot {
  readonly html: string;
  readonly assertCurrent: () => void;
  readonly readResource?: (path: string, signal: AbortSignal) => Promise<BrowserHtmlResource>;
  readonly reload?: (signal: AbortSignal) => Promise<BrowserHtmlSnapshot>;
  /** Idempotently releases the original read owner when this page ends. */
  readonly dispose?: () => void;
}

export function workspaceHtmlPreviewUrl(id: string, path = "index.html"): string {
  if (!/^[a-z0-9-]{1,80}$/u.test(id) || !validPath(path)) throw new Error("Invalid HTML preview identity.");
  return `https://${id}.preview.joko.invalid/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function isWorkspaceHtmlPreviewUrl(url: string): boolean {
  try {
    const value = new URL(url);
    return value.protocol === "https:" && /^[a-z0-9-]{1,80}\.preview\.joko\.invalid$/u.test(value.hostname)
      && value.port === "" && value.username === "" && value.password === "" && validPath(decodeURIComponent(value.pathname.slice(1)));
  } catch { return false; }
}

function validPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !/[\\:\x00-\x1f]/u.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function validateHtmlSnapshot(url: string, snapshot?: BrowserHtmlSnapshot): void {
  if (snapshot === undefined) {
    if (new URL(url).hostname.endsWith(".preview.joko.invalid")) throw new Error("This HTML snapshot expired. Open the source file again.");
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
  let current: BrowserHtmlSnapshot | undefined = snapshot;
  const dispose = snapshot.dispose;
  let generation = new AbortController();
  let firstNavigation = true;
  let documentReadPending = false;
  let bytes = Buffer.byteLength(snapshot.html, "utf8");
  let count = 0;
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  const readBounded = (read: () => Promise<BrowserHtmlResource>, signal: AbortSignal): Promise<BrowserHtmlResource> => new Promise((resolve, reject) => {
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
  page.once("close", () => { generation.abort(); current = undefined; resources.clear(); dispose?.(); });
  await page.route("**/*", async (route) => {
    let signal = generation.signal;
    try {
      current?.assertCurrent();
      if (current === undefined || page.isClosed()) throw new Error("Closed HTML preview.");
      const request = route.request();
      const target = new URL(request.url());
      if (target.origin !== sourceUrl.origin || request.method() !== "GET") throw new Error("Unsupported HTML request.");
      let body: string | Buffer;
      let mediaType: string;
      if (request.isNavigationRequest()) {
        if (request.frame() !== page.mainFrame() || target.pathname !== sourceUrl.pathname) throw new Error("Unsupported HTML navigation.");
        if (documentReadPending) throw new Error("HTML refresh is already reading its source.");
        generation.abort(); generation = new AbortController(); signal = generation.signal;
        resources.clear(); count = 0;
        if (!firstNavigation && current.reload !== undefined) {
          documentReadPending = true;
          try {
            const next = await current.reload(signal);
            signal.throwIfAborted();
            validateHtmlSnapshot(url, next);
            current = next;
          } finally { documentReadPending = false; }
        }
        firstNavigation = false;
        bytes = Buffer.byteLength(current.html, "utf8");
        body = current.html; mediaType = "text/html; charset=utf-8";
      } else {
        if (!["script", "stylesheet", "image"].includes(request.resourceType())) throw new Error("Unsupported HTML resource.");
        const path = decodeURIComponent(target.pathname.slice(1));
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
        if ((request.resourceType() === "script" && mediaType !== "text/javascript")
          || (request.resourceType() === "stylesheet" && mediaType !== "text/css")
          || (request.resourceType() === "image" && !mediaType.startsWith("image/"))) throw new Error("HTML resource type mismatch.");
      }
      signal.throwIfAborted(); current.assertCurrent();
      await route.fulfill({ status: 200, contentType: mediaType, body,
        headers: { "Content-Security-Policy": HTML_PREVIEW_CSP, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" } });
    } catch { await route.abort("blockedbyclient").catch(() => undefined); }
  });
}

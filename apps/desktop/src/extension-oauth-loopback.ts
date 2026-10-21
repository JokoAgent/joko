// Adapted from the fixed controller loopback listener. See NOTICE / LICENSE.cindy.
import { createServer } from "node:http";
import type { ExtensionOAuthAuthorization } from "@joko/contracts";

// The callback is a standalone browser document. Use the same neutral surfaces
// and brand accent as the application, including the system dark preference.
const RESULT_STYLE = `:root{color-scheme:light;--bg:#f2f2f2;--surface:#fafafa;--text:#0d0d0d;--accent:#ff9800}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0d0d0d;--surface:#151515;--text:#f2f2f2}}body{margin:24px;font:16px/1.5 system-ui;color:var(--text);background:var(--bg)}main{max-width:480px;margin:48px auto;padding:24px;border-radius:16px;background:var(--surface)}h1{margin:0 0 16px;font-size:24px;color:var(--accent)}p{margin:0 0 12px}`;

export function validateExtensionOAuthOffer(offer: ExtensionOAuthAuthorization): void {
  const callback = new URL(offer.callbackUrl), authorize = new URL(offer.authorizeUrl);
  if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || !callback.port || Number(callback.port) < 1024
    || callback.username || callback.password || callback.search || callback.hash || callback.pathname !== "/callback"
    || authorize.protocol !== "https:" || authorize.username || authorize.password || offer.authorizeUrl.length > 32_768
    || !/^[A-Za-z0-9_-]{43}$/u.test(offer.state) || authorize.searchParams.getAll("state").length !== 1 || authorize.searchParams.get("state") !== offer.state
    || authorize.searchParams.getAll("redirect_uri").length !== 1 || authorize.searchParams.get("redirect_uri") !== offer.callbackUrl
    || authorize.searchParams.get("response_type") !== "code" || offer.corsHosts.length > 32 || offer.corsOrigins.length > 32
    || !offer.corsOrigins.includes(authorize.origin) || offer.corsOrigins.some(value => { try { const url = new URL(value); return url.protocol !== "https:" || url.origin !== value; } catch { return true; } })
    || offer.corsHosts.some(host => !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(host))) throw new Error("Invalid plugin authorization offer.");
}
export async function listenForExtensionOAuth(offer: ExtensionOAuthAuthorization, deliver: (value: { readonly state: string; readonly code?: string; readonly error?: string }) => Promise<void>, assertCurrent: () => void) {
  validateExtensionOAuthOffer(offer); assertCurrent();
  const endpoint = new URL(offer.callbackUrl); let consumed = false, closed = false;
  const server = createServer({ maxHeaderSize: 16_384, requestTimeout: 10_000, headersTimeout: 10_000 }, (request, response) => {
    response.setHeader("Cache-Control", "no-store"); response.setHeader("Referrer-Policy", "no-referrer"); response.setHeader("X-Content-Type-Options", "nosniff");
    const reply = (status: number) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
      response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Joko</title><style>${RESULT_STYLE}</style><main><h1>Joko</h1><p>${status === 200 ? "Authorization result received. Return to Joko." : "Authorization could not be received. Return to Joko and try again."}</p><p lang="zh">${status === 200 ? "已收到授权结果，请返回 Joko。" : "无法接收授权结果，请返回 Joko 重试。"}</p></main></html>`);
    };
    try {
      assertCurrent();
      if (closed || request.headers.host !== endpoint.host || !request.url?.startsWith("/") || request.url.startsWith("//") || request.url.length > 12_288) { reply(400); return; }
      const url = new URL(request.url, endpoint.origin);
      if (url.pathname !== endpoint.pathname) { reply(404); return; }
      const origin = request.headers.origin;
      if (origin !== undefined) {
        const from = new URL(origin);
        if (from.protocol !== "https:" || from.origin !== origin || !offer.corsOrigins.includes(origin) && !offer.corsHosts.some(host => host.startsWith("*.")
          ? from.hostname.endsWith(host.slice(1)) && from.hostname !== host.slice(2) : from.hostname === host)) { reply(403); return; }
        response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin");
        response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS"); response.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
      if (request.method !== "GET") { reply(405); return; }
      if (consumed) { reply(409); return; }
      const state = url.searchParams.get("state"), code = url.searchParams.get("code"), error = url.searchParams.get("error");
      if (url.searchParams.getAll("state").length !== 1 || state !== offer.state || url.searchParams.getAll("code").length + url.searchParams.getAll("error").length !== 1
        || code !== null && (!code || code.length > 8_192 || /[\r\n\u0000]/u.test(code)) || error !== null && (!error || error.length > 256 || /[\r\n\u0000]/u.test(error))) { reply(400); return; }
      consumed = true;
      void deliver({ state, ...(code === null ? { error: "access_denied" } : { code }) }).then(() => reply(200), () => reply(502));
    } catch { reply(410); }
  });
  server.maxConnections = 8;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>(resolve => { closed = true; server.close(() => resolve()); server.closeAllConnections(); });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(Number(endpoint.port), "127.0.0.1", () => { server.removeListener("error", reject); server.on("error", () => { void close(); }); resolve(); }); });
    assertCurrent(); return { close };
  } catch { await close(); throw new Error("Plugin authorization callback listener is unavailable."); }
}

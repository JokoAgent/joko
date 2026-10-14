import type { DesktopWallpaperStore } from "./wallpaper-store.js";

export const DESKTOP_WALLPAPER_SCHEME = "joko-wallpaper";

/** Only this Desktop owner's immutable current WebP; no filesystem paths or general media protocol. */
export function createDesktopWallpaperProtocolHandler(store: Pick<DesktopWallpaperStore, "readImage">,
  assertRequestCurrent: (request: Request) => void = () => undefined): (request: Request) => Promise<Response> {
  return async request => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    const match = /^joko-wallpaper:\/\/image\/([a-f0-9]{64})\.webp$/u.exec(request.url);
    if (!match || request.headers.has("range")) return new Response(null, { status: 403 });
    try {
      assertRequestCurrent(request); const bytes = await store.readImage(match[1]!); assertRequestCurrent(request);
      return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), { headers: {
        "content-type": "image/webp", "content-length": String(bytes.byteLength),
        "cache-control": "private, no-store", "x-content-type-options": "nosniff"
      } });
    } catch { return new Response(null, { status: 404 }); }
  };
}

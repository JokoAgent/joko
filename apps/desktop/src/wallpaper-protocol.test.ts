import { describe, expect, it } from "vitest";
import { createDesktopWallpaperProtocolHandler } from "./wallpaper-protocol.js";

const id = "a".repeat(64), url = `joko-wallpaper://image/${id}.webp`;
describe("Desktop wallpaper protocol", () => {
  it("serves only the exact owned image and HEAD without a body", async () => {
    const bytes = new Uint8Array([1, 2, 3]); let reads = 0;
    const handler = createDesktopWallpaperProtocolHandler({ readImage: async actual => { reads++; expect(actual).toBe(id); return bytes; } });
    const response = await handler(new Request(url));
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const head = await handler(new Request(url, { method: "HEAD" }));
    expect(head.headers.get("cache-control")).toBe("private, no-store");
    expect(head.headers.get("content-length")).toBe("3"); expect(await head.text()).toBe(""); expect(reads).toBe(2);
  });
  it("rejects query, fragment, foreign host, extra paths, wrong identifiers, formats, Range and mutation methods before reading", async () => {
    let reads = 0; const handler = createDesktopWallpaperProtocolHandler({ readImage: async () => { reads++; return new Uint8Array([1]); } });
    for (const target of [`${url}?cache=1`, `${url}#fragment`, `joko-wallpaper://other/${id}.webp`, `${url}/extra`,
      `joko-wallpaper://image/${id.toUpperCase()}.webp`, `joko-wallpaper://image/${id}.png`, "joko-wallpaper://image/private.webp"])
      expect((await handler(new Request(target))).status).toBe(403);
    expect((await handler(new Request(url, { headers: { range: "bytes=0-1" } }))).status).toBe(403);
    expect((await handler(new Request(url, { method: "POST" }))).status).toBe(405); expect(reads).toBe(0);
  });
  it("does not release bytes when the request owner retires while the read is pending", async () => {
    let current = true, release!: () => void; const ready = new Promise<void>(done => { release = done; });
    const handler = createDesktopWallpaperProtocolHandler({ readImage: async () => { await ready; return new Uint8Array([1, 2]); } },
      () => { if (!current) throw new Error("retired request"); });
    const pending = handler(new Request(url)); current = false; release();
    expect((await pending).status).toBe(404);
    expect((await createDesktopWallpaperProtocolHandler({ readImage: async () => { throw new Error("private path error"); } })(new Request(url))).status).toBe(404);
  });
});

import { once } from "node:events";
import { copyFile, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserProvider, sanitizeBrowserFileName, sanitizeBrowserUrlForDisplay, stageBrowserDownload, validateWebUrl } from "./provider.js";

describe("browser URL policy", () => {
  it("accepts HTTP(S) and rejects active local schemes", () => {
    expect(validateWebUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(() => validateWebUrl("file:///etc/passwd")).toThrow();
    expect(() => validateWebUrl("javascript:alert(1)")).toThrow();
  });

  it("rejects embedded credentials", () => {
    expect(() => validateWebUrl("https://user:secret@example.com/")).toThrow(/Credentials/);
  });

  it("redacts credential-shaped URL state before publishing it", () => {
    const displayed = sanitizeBrowserUrlForDisplay(
      "https://example.com/callback?q=ordinary&code=oauth-secret&cursor=abcdefghijklmnopqrstuvwxyz0123456789#access_token=hidden"
    );
    expect(displayed).toContain("q=ordinary");
    expect(displayed).toContain("code=%5Bredacted%5D");
    expect(displayed).toContain("cursor=%5Bredacted%5D");
    expect(displayed).not.toContain("oauth-secret");
    expect(displayed).not.toContain("access_token");
  });

  it("sanitizes download names without exposing path components", () => {
    expect(sanitizeBrowserFileName("../../private/report?.pdf")).toBe("report_.pdf");
    expect(sanitizeBrowserFileName("C:\\secret\\CON.txt")).toBe("_CON.txt");
  });

  it("checks the private original before staging a regular file under its configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-browser-download-"));
    try {
      const path = join(root, "chromium-download-id");
      await writeFile(path, "verified");
      const staged = await stageBrowserDownload({
        suggestedFilename: () => "../quarterly/report.pdf",
        path: async () => path,
        saveAs: (destination) => copyFile(path, destination)
      }, root, 64);
      expect(staged.fileName).toBe("report.pdf");
      expect(dirname(staged.verifiedLocalPath)).toBe(await realpath(root));
      expect(staged.verifiedLocalPath).not.toContain("report.pdf");
      expect(await readFile(staged.verifiedLocalPath, "utf8")).toBe("verified");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an already completed oversized download before making a copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-browser-download-limit-"));
    try {
      const path = join(root, "chromium-download-id");
      await writeFile(path, Buffer.alloc(9));
      await expect(stageBrowserDownload({
        suggestedFilename: () => "large.bin",
        path: async () => path,
        saveAs: (destination) => copyFile(path, destination)
      }, root, 8)).rejects.toThrow(/size limit/);
      expect(await readdir(root)).toEqual(["chromium-download-id"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it.skipIf(process.env.JOKO_BROWSER_EXECUTABLE === undefined)("cancels known and unknown oversized Chromium downloads while the HTTP response is open", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-chromium-download-limit-"));
  const downloadDirectory = join(root, "downloads");
  const maximumDownloadBytes = 64 * 1024;
  const small = Buffer.alloc(maximumDownloadBytes, 0xa5);
  const disconnected = new Set<string>();
  const published: { fileName: string; bytes: Buffer }[] = [];
  const activities: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url;
    if (url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" }).end(
        '<a href="/known">Known size</a> <a href="/unknown">Unknown size</a> <a href="/small">Allowed size</a>');
      return;
    }
    if (url !== "/known" && url !== "/unknown" && url !== "/small") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Disposition", `attachment; filename="${url.slice(1)}.bin"`);
    if (url === "/small") {
      response.setHeader("Content-Length", small.length);
      response.end(small);
      return;
    }
    if (url === "/known") response.setHeader("Content-Length", maximumDownloadBytes * 4);
    response.once("close", () => { if (!response.writableEnded) disconnected.add(url); });
    // Hold both responses open. The known download stays below the actual byte limit.
    response.write(Buffer.alloc(url === "/known" ? 4096 : maximumDownloadBytes * 2));
  });
  const provider = new BrowserProvider({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, targetMode: "sidebar",
    profileDirectories: { sidebar: join(root, "sidebar"), external: join(root, "external") },
    downloadDirectory, uploadRoots: [], maximumDownloadBytes,
    onDownload: async (_pageId, path, fileName) => { published.push({ fileName, bytes: await readFile(path) }); },
    onActivity: ({ type, detail }) => { if (type === "download") activities.push(detail); }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The browser download fixture has no TCP address.");
    await provider.start();
    const lease = provider.acquireAgentLease("download-limit-test");
    const page = await provider.createPage(lease, `http://127.0.0.1:${address.port}/`);
    for (const path of ["/known", "/unknown"]) {
      await provider.act(page.id, lease, { type: "click", selector: `a[href="${path}"]` });
      await expect.poll(() => disconnected.has(path), { timeout: 8_000 }).toBe(true);
    }
    await expect.poll(() => activities).toEqual(Array<string>(2).fill("A browser download was cancelled before ingest."));
    expect(published).toEqual([]);
    await expect.poll(() => readdir(downloadDirectory)).toEqual([]);

    await provider.act(page.id, lease, { type: "click", selector: 'a[href="/small"]' });
    await expect.poll(() => published).toEqual([{ fileName: "small.bin", bytes: small }]);
    await expect.poll(() => readdir(downloadDirectory)).toEqual([]);
  } finally {
    const stopping = provider.stop();
    server.closeAllConnections();
    try { await Promise.all([stopping, new Promise<void>(resolve => server.close(() => resolve()))]); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}, 45_000);

import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeBrowserFileName, sanitizeBrowserUrlForDisplay, stageBrowserDownload, validateWebUrl } from "./provider.js";

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

  it("stages a verified regular download under its configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-browser-download-"));
    try {
      const staged = await stageBrowserDownload({
        suggestedFilename: () => "../quarterly/report.pdf",
        saveAs: (path) => writeFile(path, "verified")
      }, root, 64);
      expect(staged.fileName).toBe("report.pdf");
      expect(dirname(staged.verifiedLocalPath)).toBe(await realpath(root));
      expect(staged.verifiedLocalPath).not.toContain("report.pdf");
      expect(await readFile(staged.verifiedLocalPath, "utf8")).toBe("verified");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes rejected oversized download staging files", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-browser-download-limit-"));
    try {
      await expect(stageBrowserDownload({
        suggestedFilename: () => "large.bin",
        saveAs: (path) => writeFile(path, Buffer.alloc(9))
      }, root, 8)).rejects.toThrow(/size limit/);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

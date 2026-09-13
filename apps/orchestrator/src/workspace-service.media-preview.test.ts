import { createHash } from "node:crypto";
import { mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_MEDIA_PREVIEW_TOTAL_MAXIMUM_BYTES,
  WORKSPACE_PDF_PREVIEW_MAXIMUM_BYTES,
  WORKSPACE_RASTER_PREVIEW_MAXIMUM_BYTES,
  WorkspaceService
} from "./workspace-service.js";

const rasterAndPdfFixtures = [
  { name: "pixel.png", mediaType: "image/png", bytes: Buffer.from("89504e470d0a1a0a00000000", "hex") },
  { name: "photo.jpg", mediaType: "image/jpeg", bytes: Buffer.from("ffd8ffe000104a46494600", "hex") },
  { name: "photo.jpeg", mediaType: "image/jpeg", bytes: Buffer.from("ffd8ffdb00044349", "hex") },
  { name: "motion.gif", mediaType: "image/gif", bytes: Buffer.from("47494638396101000100", "hex") },
  { name: "modern.webp", mediaType: "image/webp", bytes: Buffer.from("524946460400000057454250", "hex") },
  { name: "sample.bmp", mediaType: "image/bmp", bytes: Buffer.from("424d0a00000000000000", "hex") },
  { name: "favicon.ico", mediaType: "image/x-icon", bytes: Buffer.from("0000010001000101", "hex") },
  { name: "manual.pdf", mediaType: "application/pdf", bytes: Buffer.from("%PDF-1.7\n%%EOF\n", "utf8") }
] as const;

describe("WorkspaceService media previews", () => {
  it("returns complete raster and PDF byte snapshots with content revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-media-"));
    for (const fixture of rasterAndPdfFixtures) await writeFile(join(root, fixture.name), fixture.bytes);
    const service = new WorkspaceService();
    await service.register({ id: "media", root, displayName: "Media", trusted: true });

    const previews = new Map<string, Awaited<ReturnType<WorkspaceService["preview"]>>>();
    for (const fixture of rasterAndPdfFixtures) {
      const preview = await service.preview("media", fixture.name);
      previews.set(fixture.name, preview);
      expect(preview).toMatchObject({
        mediaType: fixture.mediaType,
        truncated: false,
        entry: {
          path: fixture.name,
          size: fixture.bytes.byteLength,
          revision: contentRevision(fixture.bytes)
        }
      });
      expect(preview.text).toBeUndefined();
      expect(preview.bytes).toEqual(fixture.bytes);
      expect(preview.entry.revision).not.toContain(root);
    }

    const originalPng = rasterAndPdfFixtures[0];
    const pngPreview = previews.get(originalPng.name);
    await writeFile(join(root, originalPng.name), Buffer.from("replacement", "utf8"));
    expect(pngPreview?.bytes).toEqual(originalPng.bytes);
    expect(pngPreview?.entry.revision).toBe(contentRevision(originalPng.bytes));
  });

  it("keeps SVG and drawio as text while local audio and video stay binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-media-semantics-"));
    const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0\"/></svg>\n";
    const drawio = "<mxfile><diagram id=\"one\">xml</diagram></mxfile>\n";
    await writeFile(join(root, "diagram.svg"), svg, "utf8");
    await writeFile(join(root, "diagram.drawio"), drawio, "utf8");
    await writeFile(join(root, "recording.mp3"), "ID3-ascii-probe", "utf8");
    await writeFile(join(root, "recording.mp4"), "ftyp-isom-ascii-probe", "utf8");
    const service = new WorkspaceService();
    await service.register({ id: "semantics", root, displayName: "Semantics", trusted: true });

    await expect(service.preview("semantics", "diagram.svg")).resolves.toMatchObject({
      mediaType: "image/svg+xml",
      text: svg,
      truncated: false
    });
    await expect(service.preview("semantics", "diagram.drawio")).resolves.toMatchObject({
      mediaType: "application/xml",
      text: drawio,
      truncated: false
    });
    for (const [name, mediaType] of [["recording.mp3", "audio/mpeg"], ["recording.mp4", "video/mp4"]] as const) {
      const preview = await service.preview("semantics", name);
      expect(preview).toMatchObject({ mediaType, truncated: false });
      expect(preview.text).toBeUndefined();
      expect(preview.bytes).toBeUndefined();
    }
  });

  it("does not widen formal Workspace image support to Git Review-only extensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-media-subset-"));
    for (const name of ["animation.apng", "photo.jfif", "picture.avif"]) {
      await writeFile(join(root, name), Buffer.from([0, 1, 2, 3]));
    }
    const service = new WorkspaceService();
    await service.register({ id: "subset", root, displayName: "Subset", trusted: true });

    for (const name of ["animation.apng", "photo.jfif", "picture.avif"]) {
      const preview = await service.preview("subset", name);
      expect(preview).toMatchObject({ mediaType: "application/octet-stream", truncated: false });
      expect(preview.text).toBeUndefined();
      expect(preview.bytes).toBeUndefined();
    }
  });

  it("returns safe binary fallbacks for raster and PDF files over their bounded limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-media-limit-"));
    const imagePath = join(root, "large.png");
    const pdfPath = join(root, "large.pdf");
    await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
    await writeFile(pdfPath, "%PDF-1.7\n", "utf8");
    await truncate(imagePath, WORKSPACE_RASTER_PREVIEW_MAXIMUM_BYTES + 1);
    await truncate(pdfPath, WORKSPACE_PDF_PREVIEW_MAXIMUM_BYTES + 1);
    const service = new WorkspaceService();
    await service.register({ id: "limits", root, displayName: "Limits", trusted: true });

    expect(WORKSPACE_PDF_PREVIEW_MAXIMUM_BYTES).toBeLessThanOrEqual(WORKSPACE_MEDIA_PREVIEW_TOTAL_MAXIMUM_BYTES);
    for (const [name, mediaType] of [["large.png", "image/png"], ["large.pdf", "application/pdf"]] as const) {
      const preview = await service.preview("limits", name);
      expect(preview).toMatchObject({ mediaType, truncated: false });
      expect(preview.text).toBeUndefined();
      expect(preview.bytes).toBeUndefined();
      expect(preview.entry.revision).not.toMatch(/^sha256:/u);
    }
  });

  it("rejects mutation during a media read with a typed stale error", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-media-race-"));
    const path = join(root, "race.png");
    await writeFile(path, Buffer.from("89504e470d0a1a0a", "hex"));
    const service = new WorkspaceService({
      afterWorkspacePreviewRead: async ({ workspaceId, path: relativePath }) => {
        expect({ workspaceId, relativePath }).toEqual({ workspaceId: "race", relativePath: "race.png" });
        await writeFile(path, Buffer.from("89504e470d0a1a0a00010203", "hex"));
      }
    });
    await service.register({ id: "race", root, displayName: "Race", trusted: true });

    await expect(service.preview("race", "race.png")).rejects.toMatchObject({
      name: "WorkspaceFilePreviewError",
      kind: "stale",
      code: "WORKSPACE_FILE_PREVIEW_STALE"
    });
  });

  it("rejects symbolic links, special targets, and non-canonical paths without exposing absolute paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-workspace-media-paths-"));
    const actual = join(root, "actual");
    await mkdir(actual);
    await writeFile(join(actual, "pixel.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    await mkdir(join(root, "directory.png"));
    // A junction exercises the same lexical symlink gate on Windows without
    // requiring developer-mode privileges for file symbolic links.
    await symlink(actual, join(root, "linked"), "junction");
    const service = new WorkspaceService();
    await service.register({ id: "paths", root, displayName: "Paths", trusted: true });

    await expect(service.preview("paths", "linked/pixel.png")).rejects.toMatchObject({
      kind: "unsupported",
      code: "WORKSPACE_FILE_PREVIEW_UNSUPPORTED"
    });
    await expect(service.preview("paths", "directory.png")).rejects.toMatchObject({ kind: "unsupported" });
    await expect(service.preview("paths", "actual/../actual/pixel.png")).rejects.toMatchObject({
      kind: "invalid",
      code: "WORKSPACE_FILE_PREVIEW_INVALID"
    });
    try {
      await service.preview("paths", join(actual, "pixel.png"));
      throw new Error("Expected an absolute preview path to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ kind: "invalid", code: "WORKSPACE_FILE_PREVIEW_INVALID" });
      expect(error instanceof Error ? error.message : String(error)).not.toContain(root);
    }
  });
});

function contentRevision(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}:${bytes.byteLength}`;
}

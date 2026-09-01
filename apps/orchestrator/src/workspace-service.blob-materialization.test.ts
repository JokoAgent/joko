import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { OperationalStore } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import {
  WORKSPACE_PDF_PREVIEW_MAXIMUM_BYTES,
  WORKSPACE_RASTER_PREVIEW_MAXIMUM_BYTES,
  WorkspaceService
} from "./workspace-service.js";

describe("Workspace file Blob materialization", () => {
  it("streams video, oversized raster/PDF, and arbitrary binary snapshots through Blob tickets", async () => {
    const fixture = await createFixture(64 * 1024 * 1024);
    try {
      const files = [
        { name: "movie.mp4", size: 256 * 1024, mediaType: "video/mp4", header: Buffer.from("00000018667479706d703432", "hex") },
        { name: "oversized.png", size: WORKSPACE_RASTER_PREVIEW_MAXIMUM_BYTES + 1, mediaType: "image/png", header: Buffer.from("89504e470d0a1a0a", "hex") },
        { name: "oversized.pdf", size: WORKSPACE_PDF_PREVIEW_MAXIMUM_BYTES + 1, mediaType: "application/pdf", header: Buffer.from("%PDF-1.7\n", "utf8") },
        { name: "archive.bin", size: 128 * 1024, mediaType: "application/octet-stream", header: Buffer.from([0, 1, 2, 3]) }
      ] as const;
      for (const file of files) {
        const absolute = join(fixture.workspaceRoot, file.name);
        await writeFile(absolute, file.header);
        await truncate(absolute, file.size);
      }

      for (const file of files) {
        const preview = await fixture.workspaces.preview("workspace", file.name);
        expect(preview).toMatchObject({
          mediaType: file.mediaType,
          truncated: false,
          entry: { path: file.name, size: file.size }
        });
        expect(preview.text).toBeUndefined();
        expect(preview.bytes).toBeUndefined();

        const artifact = await fixture.workspaces.materializeFile(
          "workspace",
          file.name,
          preview.entry.revision,
          (handle, options) => fixture.artifacts.ingestFileHandle(handle, {
            ...options,
            fileName: file.name,
            mimeType: preview.mediaType,
            expiresAt: Date.now() + 60_000
          })
        );
        expect(artifact).toMatchObject({
          byteLength: file.size,
          fileName: file.name,
          mimeType: file.mediaType
        });
        expect(artifact.id).not.toContain(fixture.workspaceRoot);

        const ticket = await fixture.artifacts.createDownloadTicket(artifact.id);
        const download = await fixture.artifacts.openDownload(ticket.ticketId, ticket.secret);
        const streamed = await streamDigest(download.stream);
        const source = await streamDigest(createReadStream(join(fixture.workspaceRoot, file.name)));
        expect(streamed).toEqual({ byteLength: file.size, sha256: artifact.sha256 });
        expect(streamed).toEqual(source);
      }
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("rejects a changed source before Blob publication and removes the private staging copy", async () => {
    const fixture = await createFixture(4 * 1024 * 1024, async ({ path }) => {
      await writeFile(join(fixture.workspaceRoot, path), Buffer.alloc(64 * 1024, 0x62));
    });
    try {
      await writeFile(join(fixture.workspaceRoot, "race.bin"), Buffer.alloc(64 * 1024, 0x61));
      const preview = await fixture.workspaces.preview("workspace", "race.bin");

      await expect(fixture.workspaces.materializeFile(
        "workspace",
        "race.bin",
        preview.entry.revision,
        (handle, options) => fixture.artifacts.ingestFileHandle(handle, {
          ...options,
          fileName: "race.bin",
          mimeType: preview.mediaType,
          expiresAt: Date.now() + 60_000
        })
      )).rejects.toMatchObject({
        name: "WorkspaceFilePreviewError",
        kind: "stale",
        code: "WORKSPACE_FILE_PREVIEW_STALE"
      });

      expect(fixture.store.listArtifacts({ limit: 100 })).toEqual([]);
      expect(await readdir(join(fixture.artifactRoot, "incoming"))).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("fails closed on stale revisions, symlinks, cancellation, and the configured Blob size limit", async () => {
    const fixture = await createFixture(8);
    try {
      await writeFile(join(fixture.workspaceRoot, "nine.bin"), Buffer.alloc(9, 1));
      const preview = await fixture.workspaces.preview("workspace", "nine.bin");
      const ingest = vi.fn((handle, options) => fixture.artifacts.ingestFileHandle(handle, options));

      await expect(fixture.workspaces.materializeFile(
        "workspace",
        "nine.bin",
        "meta:stale",
        ingest
      )).rejects.toMatchObject({ kind: "stale" });
      expect(ingest).not.toHaveBeenCalled();

      await expect(fixture.workspaces.materializeFile(
        "workspace",
        "nine.bin",
        preview.entry.revision,
        ingest
      )).rejects.toMatchObject({ kind: "read_failed" });
      expect(await readdir(join(fixture.artifactRoot, "incoming"))).toEqual([]);

      const controller = new AbortController();
      controller.abort();
      await expect(fixture.workspaces.materializeFile(
        "workspace",
        "nine.bin",
        preview.entry.revision,
        ingest,
        controller.signal
      )).rejects.toMatchObject({ name: "AbortError" });

      const targetDirectory = join(fixture.workspaceRoot, "actual");
      await mkdir(targetDirectory);
      await writeFile(join(targetDirectory, "linked.bin"), Buffer.from([0]));
      await symlink(targetDirectory, join(fixture.workspaceRoot, "linked"), "junction");
      await expect(fixture.workspaces.materializeFile(
        "workspace",
        "linked/linked.bin",
        "meta:untrusted",
        ingest
      )).rejects.toMatchObject({ kind: "unsupported" });
      expect(fixture.store.listArtifacts({ limit: 100 })).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

async function createFixture(
  maximumBlobBytes: number,
  afterWorkspaceArtifactRead?: (input: { readonly workspaceId: string; readonly path: string }) => Promise<void>
): Promise<{
  readonly directory: string;
  readonly workspaceRoot: string;
  readonly artifactRoot: string;
  readonly store: OperationalStore;
  readonly artifacts: ArtifactStore;
  readonly workspaces: WorkspaceService;
  readonly close: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "joko-workspace-blob-"));
  const workspaceRoot = join(directory, "workspace");
  const artifactRoot = join(directory, "artifacts");
  await mkdir(workspaceRoot);
  const store = new OperationalStore(join(directory, "orchestrator.db"));
  const artifacts = new ArtifactStore({
    rootDirectory: artifactRoot,
    repository: new OperationalArtifactRepository(store),
    ingestRoots: [workspaceRoot],
    maximumBlobBytes
  });
  await artifacts.initialize();
  const workspaces = new WorkspaceService({
    ...(afterWorkspaceArtifactRead === undefined ? {} : { afterWorkspaceArtifactRead })
  });
  await workspaces.register({ id: "workspace", root: workspaceRoot, displayName: "Workspace", trusted: true });
  return {
    directory,
    workspaceRoot,
    artifactRoot,
    store,
    artifacts,
    workspaces,
    close: async () => {
      await workspaces.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function streamDigest(stream: Readable): Promise<{ readonly sha256: string; readonly byteLength: number }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    byteLength += bytes.byteLength;
  }
  return { sha256: hash.digest("hex"), byteLength };
}

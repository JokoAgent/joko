import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { operationBodyHash, type OperationRecord } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";

const connection = {
  id: "connection-workspace-files",
  name: "Workspace Files tests",
  authKeyDigest: "digest",
  state: "active" as const,
  pairedAt: 1,
  revision: 1n
};

function context(): never {
  return {
    requestHeader: new Headers({ authorization: "Bearer workspace-files-test" }),
    signal: new AbortController().signal
  } as never;
}

describe("Connect formal Workspace Files contracts", () => {
  it("streams only typed, capability-gated workspace-relative changes", async () => {
    const watchChanges = vi.fn(async function* () {
      yield {
        workspaceId: "workspace-files",
        kind: "renamed" as const,
        path: "src/new.ts",
        previousPath: "src/old.ts",
        revision: { opaqueRevision: "meta:9", byteSize: 12, modifiedAt: 123 },
        sequence: 9n,
        streamRevision: "sha256:stream-nine",
        observedAt: 456
      };
    });
    const registrations = [{ id: "workspace-files", root: "C:\\private\\project", displayName: "Project", trusted: true }];
    const services = createConnectServices(application({
      workspaces: { watchChanges, listRegistrations: () => registrations },
      supportsWatch: true
    }));
    const stream = services.workspace.watchWorkspaceFileChanges(create(contract.WatchWorkspaceFileChangesRequestSchema, {
      scope: create(contract.WorkspaceFileChangeScopeSchema, {
        kind: { case: "workspace", value: { workspaceId: "workspace-files" } }
      })
    }), context());
    const values = [];
    for await (const response of stream) values.push(response);
    expect(watchChanges).toHaveBeenCalledWith(
      { kind: "workspace", workspaceId: "workspace-files" },
      expect.any(AbortSignal)
    );
    expect(values).toEqual([{
      change: expect.objectContaining({
        workspaceId: "workspace-files",
        kind: contract.WorkspaceFileChangeKind.RENAMED,
        relativePath: "src/new.ts",
        previousRelativePath: "src/old.ts",
        revision: expect.objectContaining({ opaqueRevision: "meta:9", byteSize: 12n }),
        sequence: 9n,
        streamRevision: "sha256:stream-nine"
      })
    }]);
    expect(Object.values(values[0]?.change ?? {}).map(String).join(" ")).not.toContain("private");

    const unsupported = createConnectServices(application({
      workspaces: { watchChanges, listRegistrations: () => registrations },
      supportsWatch: false
    }));
    const unsupportedStream = unsupported.workspace.watchWorkspaceFileChanges(create(contract.WatchWorkspaceFileChangesRequestSchema, {
      scope: { kind: { case: "workspace", value: { workspaceId: "workspace-files" } } }
    }), context());
    await expect(unsupportedStream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: Code.FailedPrecondition });
  });

  it("binds listing pages to a content-derived full-result revision", async () => {
    let records = [workspaceEntry(".env", "revision-a"), workspaceEntry("ignored/result.txt", "revision-b")];
    const list = vi.fn(async () => records);
    const services = createConnectServices(application({ workspaces: { list } }));
    const request = (pageToken = "") => create(contract.ListWorkspaceEntriesRequestSchema, {
      workspaceId: "workspace-files",
      parentRelativePath: "",
      includeHidden: true,
      listingPolicy: contract.WorkspaceEntryListingPolicy.DOCUMENT_TREE,
      page: { pageSize: 1, pageToken }
    });

    const first = await services.workspace.listWorkspaceEntries(request(), context());
    const repeated = await services.workspace.listWorkspaceEntries(request(), context());
    const nextPageToken = first.page?.nextPageToken ?? "";
    expect(nextPageToken).not.toBe("");
    expect(first.revision?.etag).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(repeated.revision?.etag).toBe(first.revision?.etag);
    expect(first.entries?.map((entry) => entry.relativePath)).toEqual([".env"]);
    expect(list).toHaveBeenCalledWith("workspace-files", "", {
      recursive: false,
      maximumEntries: 10_000,
      listingPolicy: "document_tree"
    });

    const second = await services.workspace.listWorkspaceEntries(request(nextPageToken), context());
    expect(second.entries?.map((entry) => entry.relativePath)).toEqual(["ignored/result.txt"]);
    expect(second.revision?.etag).toBe(first.revision?.etag);

    const decoded = JSON.parse(Buffer.from(nextPageToken, "base64url").toString("utf8")) as Record<string, unknown>;
    const outsideToken = Buffer.from(JSON.stringify({ ...decoded, offset: 999 }), "utf8").toString("base64url");
    await expect(services.workspace.listWorkspaceEntries(request(outsideToken), context()))
      .rejects.toMatchObject({ code: Code.FailedPrecondition });

    records = [workspaceEntry(".env", "revision-a"), workspaceEntry("ignored/result.txt", "revision-after")];
    await expect(services.workspace.listWorkspaceEntries(request(nextPageToken), context()))
      .rejects.toMatchObject({ code: Code.Aborted });
    const changed = await services.workspace.listWorkspaceEntries(request(), context());
    expect(changed.revision?.etag).not.toBe(first.revision?.etag);
  });

  it("projects the typed cancellable file index and streaming fixed-string search", async () => {
    const listFiles = vi.fn(async () => ({
      paths: [".env", "src/App.tsx"],
      truncated: true,
      revision: "sha256:index-fence"
    }));
    const searchStream = vi.fn(async function* () {
      yield {
        kind: "match" as const,
        match: {
          path: "src/App.tsx",
          line: 2,
          column: 4,
          endColumn: 10,
          startByte: 11,
          endByte: 17,
          preview: "   Needle",
          submatches: [
            { startByte: 3, endByte: 9 }
          ],
          revision: "sha256:file-fence"
        }
      };
      yield {
        kind: "end" as const,
        truncated: false,
        totalResults: 1,
        totalFiles: 1,
        revision: "sha256:stream-fence"
      };
    });
    const services = createConnectServices(application({ workspaces: { listFiles, searchStream } }));

    const index = await services.workspace.listWorkspaceFiles(create(contract.ListWorkspaceFilesRequestSchema, {
      workspaceId: "workspace-files"
    }), context());
    expect(index).toMatchObject({
      relativePaths: [".env", "src/App.tsx"],
      truncated: true,
      revision: { value: 0n, etag: "sha256:index-fence" }
    });
    expect(listFiles).toHaveBeenCalledWith("workspace-files", expect.any(AbortSignal));

    const responses = [];
    for await (const response of services.workspace.streamWorkspaceSearch(create(contract.StreamWorkspaceSearchRequestSchema, {
      workspaceId: "workspace-files",
      query: "Need(le)?",
      caseSensitive: true
    }), context())) responses.push(response);
    expect(searchStream).toHaveBeenCalledWith("workspace-files", "Need(le)?", true, expect.any(AbortSignal));
    expect(responses).toEqual([
      {
        event: {
          case: "match",
          value: expect.objectContaining({
            relativePath: "src/App.tsx",
            linePreview: "   Needle",
            submatches: [expect.objectContaining({ startByte: 3n, endByte: 9n })]
          })
        }
      },
      {
        event: {
          case: "end",
          value: expect.objectContaining({
            truncated: false,
            totalMatches: 1n,
            totalFiles: 1n,
            revision: expect.objectContaining({ etag: "sha256:stream-fence" })
          })
        }
      }
    ]);
  });

  it("publishes a typed terminal project-search failure instead of dropping its reason", async () => {
    const searchStream = vi.fn(async function* () {
      yield {
        kind: "error" as const,
        code: "RG_UNAVAILABLE" as const,
        message: "ripgrep is unavailable."
      };
    });
    const services = createConnectServices(application({ workspaces: { searchStream } }));
    const responses = [];
    for await (const response of services.workspace.streamWorkspaceSearch(create(contract.StreamWorkspaceSearchRequestSchema, {
      workspaceId: "workspace-files",
      query: "needle",
      caseSensitive: false
    }), context())) responses.push(response);
    expect(responses).toEqual([{
      event: {
        case: "error",
        value: expect.objectContaining({
          code: "RG_UNAVAILABLE",
          phase: "workspace_search",
          message: "ripgrep is unavailable.",
          retryable: true
        })
      }
    }]);
  });

  it.each([
    ["ui/Card.vue", "xml", "text/plain"],
    ["ui/Card.svelte", "xml", "text/plain"],
    ["styles/theme.sass", "css", "text/plain"],
    ["schema/query.graphql", "graphql", "text/plain"],
    ["schema/query.gql", "graphql", "text/plain"],
    ["build/rules.mk", "makefile", "text/plain"],
    ["scripts/build.sc", "scala", "text/plain"],
    ["src/main.ts", "typescript", "text/typescript"],
    ["src/main.mjs", "javascript", "text/javascript"],
    ["styles/theme.css", "css", "text/css"],
    ["config/settings.yml", "yaml", "application/yaml"],
    ["config/settings.xml", "xml", "application/xml"],
    ["docs/guide.mdown", "markdown", "text/markdown"],
    ["Makefile", "makefile", "text/plain"],
    ["notes.custom", "", "text/plain", "application/octet-stream"],
    ["invalid.ts", "", "application/octet-stream", "text/typescript"]
  ])("publishes the snapshot MIME and code language identity for %s", async (path, languageId, mediaType, advisoryType = mediaType) => {
    const preview = vi.fn(async () => ({
      entry: {
        path,
        name: path,
        kind: "file" as const,
        size: 7,
        modifiedAt: 1,
        revision: "sha256:fixture:7",
        generated: false
      },
      mediaType,
      ...(mediaType === "application/octet-stream" ? {} : { text: "fixture" }),
      truncated: false
    }));
    const list = vi.fn(async () => [workspaceEntry(path, "revision")]);
    const materializeFile = vi.fn(async () => ({
      id: "blob-detected-binary", sha256: "a".repeat(64), byteLength: 7, mimeType: mediaType,
      fileName: path, storagePath: "artifact-only", createdAt: 1, expiresAt: 301_000
    }));
    const services = createConnectServices(application({ workspaces: { preview, list, materializeFile } }));
    const catalog = await services.workspace.listWorkspaceEntries(create(contract.ListWorkspaceEntriesRequestSchema, {
      workspaceId: "workspace-files"
    }), context());
    expect(catalog.entries?.[0]?.mediaType).toBe(advisoryType ?? mediaType);
    const response = await services.workspace.readWorkspaceFile(create(contract.ReadWorkspaceFileRequestSchema, {
      workspaceId: "workspace-files",
      relativePath: path
    }), context());
    expect(response.preview?.entry?.mediaType).toBe(mediaType);
    expect(response.preview?.content).toMatchObject(mediaType === "application/octet-stream"
      ? { case: "blob", value: { mediaType } } : { case: "text", value: { languageId } });
  });

  it("accepts a stable listed metadata fence while returning the stronger content revision", async () => {
    const digest = "a".repeat(64);
    const preview = vi.fn(async () => ({
      entry: {
        path: "README.md",
        name: "README.md",
        kind: "file" as const,
        size: 7,
        modifiedAt: 1,
        revision: `sha256:${digest}:7`,
        generated: false
      },
      observedRevision: "meta:listed-file",
      mediaType: "text/markdown",
      text: "fixture",
      truncated: false
    }));
    const services = createConnectServices(application({ workspaces: { preview } }));
    const response = await services.workspace.readWorkspaceFile(create(contract.ReadWorkspaceFileRequestSchema, {
      workspaceId: "workspace-files",
      relativePath: "README.md",
      expectedRevision: create(contract.FileRevisionSchema, {
        opaqueRevision: "meta:listed-file",
        byteSize: 7n,
        modifiedAt: { seconds: 0n, nanos: 1_000_000 }
      })
    }), context());

    expect(response.preview?.entry?.revision).toMatchObject({
      opaqueRevision: `sha256:${digest}:7`,
      sha256Hex: digest,
      byteSize: 7n
    });
    await expect(services.workspace.readWorkspaceFile(create(contract.ReadWorkspaceFileRequestSchema, {
      workspaceId: "workspace-files",
      relativePath: "README.md",
      expectedRevision: create(contract.FileRevisionSchema, { opaqueRevision: "meta:stale-file" })
    }), context())).rejects.toMatchObject({ code: Code.Aborted });
  });

  it("materializes an exact revision-fenced Blob for a complete Workspace file request", async () => {
    const bytes = Buffer.from("complete text file", "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const preview = vi.fn(async () => ({
      entry: {
        path: "notes/complete.txt",
        name: "complete.txt",
        kind: "file" as const,
        size: bytes.byteLength,
        modifiedAt: 12,
        revision: "meta:complete-text",
        generated: false
      },
      observedRevision: "meta:complete-text",
      mediaType: "text/plain",
      text: "c",
      truncated: true
    }));
    const materializeFile = vi.fn(async () => ({
      id: "blob-complete-text",
      sha256: digest,
      byteLength: bytes.byteLength,
      mimeType: "text/plain",
      fileName: "complete.txt",
      storagePath: "artifact-only",
      createdAt: 1,
      expiresAt: 301_000
    }));
    const services = createConnectServices(application({ workspaces: { preview, materializeFile } }));
    const response = await services.workspace.readWorkspaceFile(create(contract.ReadWorkspaceFileRequestSchema, {
      workspaceId: "workspace-files",
      relativePath: "notes/complete.txt",
      startByte: 0n,
      maximumBytes: BigInt(bytes.byteLength),
      expectedRevision: create(contract.FileRevisionSchema, {
        opaqueRevision: "meta:complete-text",
        byteSize: BigInt(bytes.byteLength)
      }),
      requireBlob: true
    }), context());

    expect(preview).toHaveBeenCalledWith("workspace-files", "notes/complete.txt", 1);
    expect(materializeFile).toHaveBeenCalledWith(
      "workspace-files",
      "notes/complete.txt",
      "meta:complete-text",
      expect.any(Function),
      expect.any(AbortSignal)
    );
    expect(response.preview).toMatchObject({
      truncated: false,
      entry: {
        relativePath: "notes/complete.txt",
        mediaType: "text/plain",
        revision: {
          opaqueRevision: `sha256:${digest}:${bytes.byteLength}`,
          sha256Hex: digest,
          byteSize: BigInt(bytes.byteLength)
        }
      },
      content: {
        case: "blob",
        value: {
          blobId: "blob-complete-text",
          fileName: "complete.txt",
          mediaType: "text/plain",
          byteSize: BigInt(bytes.byteLength),
          sha256Hex: digest
        }
      }
    });
  });

  it("rejects invalid or insufficient complete Workspace Blob bounds before materialization", async () => {
    const materializeFile = vi.fn();
    const preview = vi.fn(async () => ({
      entry: {
        path: "bounded.bin",
        name: "bounded.bin",
        kind: "file" as const,
        size: 9,
        modifiedAt: 1,
        revision: "meta:bounded",
        generated: false
      },
      mediaType: "application/octet-stream",
      truncated: false
    }));
    const services = createConnectServices(application({ workspaces: { preview, materializeFile } }));
    const request = (overrides: { startByte?: bigint; maximumBytes?: bigint }) => create(
      contract.ReadWorkspaceFileRequestSchema,
      {
        workspaceId: "workspace-files",
        relativePath: "bounded.bin",
        startByte: overrides.startByte ?? 0n,
        maximumBytes: overrides.maximumBytes ?? 9n,
        expectedRevision: create(contract.FileRevisionSchema, { opaqueRevision: "meta:bounded" }),
        requireBlob: true
      }
    );

    await expect(services.workspace.readWorkspaceFile(request({ maximumBytes: 0n }), context()))
      .rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(services.workspace.readWorkspaceFile(request({ startByte: 1n }), context()))
      .rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(services.workspace.readWorkspaceFile(request({ maximumBytes: 8n }), context()))
      .rejects.toMatchObject({ code: Code.ResourceExhausted });
    expect(materializeFile).not.toHaveBeenCalled();
  });

  it("returns typed Artifact refs for raster, PDF, video, and arbitrary binary files", async () => {
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const pdfBytes = Buffer.from("%PDF-1.7\n", "utf8");
    const rasters = new Map([
      ["pixel.png", "image/png"], ["photo.jpg", "image/jpeg"], ["photo.jpeg", "image/jpeg"],
      ["motion.gif", "image/gif"], ["modern.webp", "image/webp"], ["sample.bmp", "image/bmp"],
      ["favicon.ico", "image/x-icon"], ["motion.apng", "image/apng"], ["modern.AVIF", "image/avif"],
      ["photo.heic", "image/heic"], ["photo.heif", "image/heif"], ["scan.tif", "image/tiff"], ["scan.tiff", "image/tiff"]
    ]);
    const binaries = new Map([
      ["recording.mp3", "audio/mpeg"], ["movie.mov", "video/quicktime"],
      ["font.woff2", "font/woff2"], ["module.wasm", "application/wasm"],
      ["archive.bin", "application/octet-stream"]
    ]);
    const ingestBytes = vi.fn(async (bytes: Uint8Array, options?: { fileName?: string; mimeType?: string; expiresAt?: number }) => ({
      id: `blob-${options?.fileName ?? "unknown"}`,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      byteLength: bytes.byteLength,
      mimeType: options?.mimeType ?? "application/octet-stream",
      fileName: options?.fileName,
      storagePath: "artifact-only",
      createdAt: 1,
      expiresAt: options?.expiresAt
    }));
    const preview = vi.fn(async (_workspaceId: string, path: string) => {
      const mediaType = rasters.get(path) ?? binaries.get(path) ?? "application/pdf";
      const bytes = rasters.has(path) ? imageBytes : path.endsWith(".pdf") ? pdfBytes : undefined;
      return {
        entry: {
          path,
          name: path,
          kind: "file" as const,
          size: bytes?.byteLength ?? 9,
          modifiedAt: 1,
          revision: "revision",
          generated: false
        },
        mediaType,
        ...(bytes === undefined ? {} : { bytes }),
        truncated: false
      };
    });
    const materializeFile = vi.fn(async (_workspaceId: string, path: string, _expectedRevision: string) => ({
      id: `blob-${path}`,
      sha256: createHash("sha256").update(path).digest("hex"),
      byteLength: 9,
      mimeType: binaries.get(path)!,
      fileName: path,
      storagePath: "artifact-only",
      createdAt: 1,
      expiresAt: 301_000
    }));
    const list = vi.fn(async () => [...rasters.keys(), ...binaries.keys()].map((path) => workspaceEntry(path, "revision")));
    const services = createConnectServices(application({ workspaces: { list, preview, materializeFile }, ingestBytes }));
    const catalog = await services.workspace.listWorkspaceEntries(create(contract.ListWorkspaceEntriesRequestSchema, {
      workspaceId: "workspace-files"
    }), context());
    for (const [path, mediaType] of rasters) {
      expect(catalog.entries?.find((entry) => entry.relativePath === path)?.mediaType).toBe(mediaType);
      const image = await services.workspace.readWorkspaceFile(create(contract.ReadWorkspaceFileRequestSchema, {
        workspaceId: "workspace-files", relativePath: path
      }), context());
      expect(image.preview?.entry?.mediaType).toBe(mediaType);
      expect(image.preview?.content).toMatchObject({
        case: "image",
        value: { blob: { blobId: `blob-${path}`, mediaType, disposition: contract.BlobDisposition.INLINE } }
      });
    }
    const pdf = await services.workspace.readWorkspaceFile(create(contract.ReadWorkspaceFileRequestSchema, {
      workspaceId: "workspace-files",
      relativePath: "manual.pdf"
    }), context());
    for (const [path, mediaType] of binaries) {
      expect(catalog.entries?.find((entry) => entry.relativePath === path)?.mediaType).toBe(mediaType);
      const binary = await services.workspace.readWorkspaceFile(create(contract.ReadWorkspaceFileRequestSchema, {
        workspaceId: "workspace-files", relativePath: path
      }), context());
      expect(binary.preview?.entry?.mediaType).toBe(mediaType);
      expect(binary.preview?.content).toMatchObject({
        case: "blob", value: { blobId: `blob-${path}`, mediaType, disposition: contract.BlobDisposition.ATTACHMENT }
      });
    }

    expect(pdf.preview?.entry?.mediaType).toBe("application/pdf");
    expect(pdf.preview?.content).toMatchObject({
      case: "blob",
      value: { blobId: "blob-manual.pdf", mediaType: "application/pdf", disposition: contract.BlobDisposition.ATTACHMENT }
    });
    expect(ingestBytes).toHaveBeenCalledTimes(rasters.size + 1);
    expect(ingestBytes).toHaveBeenCalledWith(imageBytes, expect.objectContaining({ fileName: "pixel.png", mimeType: "image/png" }));
    expect(ingestBytes).toHaveBeenCalledWith(pdfBytes, expect.objectContaining({ fileName: "manual.pdf", mimeType: "application/pdf" }));
    expect(materializeFile).toHaveBeenCalledWith(
      "workspace-files",
      "recording.mp3",
      "revision",
      expect.any(Function),
      expect.any(AbortSignal)
    );
  });

  it("rejects workspace binaries above the configured Blob streaming limit before materialization", async () => {
    const materializeFile = vi.fn();
    const preview = vi.fn(async () => ({
      entry: {
        path: "too-large.bin",
        name: "too-large.bin",
        kind: "file" as const,
        size: 9,
        modifiedAt: 1,
        revision: "meta:too-large",
        generated: false
      },
      mediaType: "application/octet-stream",
      truncated: false
    }));
    const services = createConnectServices(application({
      workspaces: { preview, materializeFile },
      maximumBlobBytes: 8
    }));

    await expect(services.workspace.readWorkspaceFile(create(contract.ReadWorkspaceFileRequestSchema, {
      workspaceId: "workspace-files",
      relativePath: "too-large.bin"
    }), context())).rejects.toMatchObject({ code: Code.ResourceExhausted });
    expect(materializeFile).not.toHaveBeenCalled();
  });

  it("forwards search flags and preserves exact ranges, revisions, truncation, and pagination", async () => {
    const searchPage = vi.fn(async () => ({
      matches: [{
        path: "src/utf8.ts",
        line: 7,
        column: 3,
        endColumn: 9,
        startByte: 123,
        endByte: 131,
        preview: "  needle",
        revision: "sha256:file-fence"
      }],
      totalResults: 6,
      totalFiles: 3,
      truncated: true,
      nextOffset: 6,
      revision: "sha256:search-page-fence"
    }));
    const services = createConnectServices(application({ workspaces: { searchPage } }));
    const response = await services.workspace.searchWorkspace(create(contract.SearchWorkspaceRequestSchema, {
      workspaceId: "workspace-files",
      query: "Need(le)?",
      relativePathPrefix: "src",
      caseSensitive: true,
      regularExpression: true,
      page: create(contract.PageRequestSchema, {
        pageSize: 2,
        pageToken: pageToken(4)
      })
    }), context());

    expect(searchPage).toHaveBeenCalledWith("workspace-files", "Need(le)?", {
      glob: "src/**",
      maximumResults: 2,
      offset: 4,
      caseSensitive: true,
      regularExpression: true
    });
    expect(response.matches).toEqual([expect.objectContaining({
      relativePath: "src/utf8.ts",
      range: expect.objectContaining({
        startByte: 123n,
        endByte: 131n,
        startLine: 7,
        startColumn: 3,
        endLine: 7,
        endColumn: 9
      }),
      revision: expect.objectContaining({ opaqueRevision: "sha256:file-fence" })
    })]);
    expect(response).toMatchObject({
      truncated: true,
      totalFiles: 3n,
      revision: { value: 0n, etag: "sha256:search-page-fence" },
      page: { nextPageToken: pageToken(6), totalSize: 6n }
    });
  });

  it("claims CRUD Operations before effects and capability-gates every mutation", async () => {
    const trace: string[] = [];
    const createEntry = vi.fn(async () => { trace.push("create-effect"); });
    const moveEntry = vi.fn(async () => { trace.push("move-effect"); });
    const deleteEntry = vi.fn(async () => { trace.push("delete-effect"); });
    const copyEntry = vi.fn(async () => { trace.push("copy-effect"); });
    const services = createConnectServices(application({
      workspaces: { createEntry, moveEntry, deleteEntry, copyEntry },
      trace,
      supportsWrite: true
    }));

    const mutations = [
      create(contract.OperationMutationSchema, { payload: { case: "createWorkspaceEntry", value: create(contract.CreateWorkspaceEntryMutationSchema, {
        workspaceId: "workspace-files",
        relativePath: "new.txt",
        kind: contract.WorkspaceEntryCreateKind.FILE,
        expectedRevision: contract.workspaceEntryAbsentRevision
      }) } }),
      create(contract.OperationMutationSchema, { payload: { case: "moveWorkspaceEntry", value: create(contract.MoveWorkspaceEntryMutationSchema, {
        workspaceId: "workspace-files", sourceRelativePath: "a.txt", destinationRelativePath: "b.txt", expectedRevision: "r1"
      }) } }),
      create(contract.OperationMutationSchema, { payload: { case: "deleteWorkspaceEntry", value: create(contract.DeleteWorkspaceEntryMutationSchema, {
        workspaceId: "workspace-files", relativePath: "b.txt", expectedRevision: "r2", confirmRecursive: false
      }) } }),
      create(contract.OperationMutationSchema, { payload: { case: "copyWorkspaceEntry", value: create(contract.CopyWorkspaceEntryMutationSchema, {
        workspaceId: "workspace-files", sourceRelativePath: "a.txt", destinationRelativePath: "copy.txt", expectedRevision: "r3"
      }) } })
    ];
    for (const [index, mutation] of mutations.entries()) {
      await services.operation.submitOperation(create(contract.SubmitOperationRequestSchema, {
        operationId: `workspace-files-operation-${index}`,
        connectionId: connection.id,
        mutation
      }), context());
    }
    expect(trace).toEqual([
      "claimed", "create-effect",
      "claimed", "move-effect",
      "claimed", "delete-effect",
      "claimed", "copy-effect"
    ]);

    const unsupportedCreate = vi.fn(async () => undefined);
    const unsupportedTrace: string[] = [];
    const unsupported = createConnectServices(application({
      workspaces: { createEntry: unsupportedCreate },
      trace: unsupportedTrace,
      supportsWrite: false
    }));
    const response = await unsupported.operation.submitOperation(create(contract.SubmitOperationRequestSchema, {
      operationId: "workspace-files-unsupported",
      connectionId: connection.id,
      mutation: mutations[0]
    }), context());
    expect(unsupportedCreate).not.toHaveBeenCalled();
    expect(unsupportedTrace).toEqual(["claimed"]);
    expect(response.operation?.result?.payload).toMatchObject({
      case: "acknowledgement",
      value: { accepted: false }
    });
  });
});

function workspaceEntry(path: string, revision: string) {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    kind: "file" as const,
    size: 7,
    modifiedAt: 123,
    revision,
    generated: false
  };
}

function application(input: {
  readonly workspaces: Record<string, unknown>;
  readonly ingestBytes?: (bytes: Uint8Array, options?: object) => Promise<object>;
  readonly maximumBlobBytes?: number;
  readonly trace?: string[];
  readonly supportsWrite?: boolean;
  readonly supportsWatch?: boolean;
}): OrchestratorApplication {
  const trace = input.trace ?? [];
  const store = {
    findOperation: () => undefined,
    listTargets: () => [{ descriptor: { id: "target-files", backendId: "backend-files" }, metadata: { workspaceId: "workspace-files" } }],
    getBackend: () => ({ descriptor: { capabilities: new Map([
      ["workspace.files.write", {
        key: "workspace.files.write",
        supported: input.supportsWrite ?? true
      }],
      ["workspace.files.watch", {
        key: "workspace.files.watch",
        supported: input.supportsWatch ?? true
      }]
    ]) } })
  };
  const sessionHost = {
    mutate: async (mutation: { operationId: string; kind: string; body: unknown; effect?: () => Promise<void>; commit: (value: object) => unknown }) => {
      trace.push("claimed");
      await mutation.effect?.();
      const value = mutation.commit(store);
      return {
        replayed: false,
        value,
        operation: completedRecord(mutation.operationId, mutation.kind, mutation.body, value)
      };
    }
  };
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections: {
      authenticate: () => connection,
      onRevoked: () => () => undefined,
      fence: () => undefined
    },
    artifacts: {
      maximumBlobBytes: input.maximumBlobBytes ?? 256 * 1024 * 1024,
      ingestBytes: input.ingestBytes ?? (async () => { throw new Error("Unexpected artifact ingest."); })
    },
    blobTransfers: {},
    artifactRepository: {},
    workspaces: input.workspaces,
    workspaceChanges: {},
    sessionHost,
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
}

function completedRecord(id: string, kind: string, body: unknown, response: unknown): OperationRecord<unknown> {
  return {
    id,
    connectionId: connection.id,
    kind,
    body,
    bodyHash: operationBodyHash(body),
    completionMode: "external_effect",
    status: "completed",
    response,
    createdAt: 1,
    updatedAt: 2,
    revision: 1n
  };
}

function pageToken(offset: number): string {
  return Buffer.from(`joko-page:${offset}`, "utf8").toString("base64url");
}

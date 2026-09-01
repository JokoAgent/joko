import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  ErrorInfoSchema,
  FileKind,
  GetSnapshotResponseSchema,
  GitFileStatus,
  ListWorkspaceChangeSetsResponseSchema,
  ListWorkspaceEntriesResponseSchema,
  ListWorkspaceFilesResponseSchema,
  OperationState,
  SearchWorkspaceResponseSchema,
  SnapshotSchema,
  SubmitOperationResponseSchema,
  StreamWorkspaceSearchResponseSchema,
  WorkspaceEntryCreateKind,
  WorkspaceEntryListingPolicy,
  WorkspaceFileChangeKind,
  WatchWorkspaceFileChangesResponseSchema,
  workspaceEntryAbsentRevision
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("formal Workspace Files gateway", () => {
  it("maps the typed workspace watcher stream and rejects absolute path leakage", async () => {
    const streamInputs: any[] = [];
    const transport = transportFor(
      async (method) => { throw new Error(`Unexpected unary RPC ${method.localName}`); },
      create(SnapshotSchema),
      (method, input) => {
        if (method.localName !== "watchWorkspaceFileChanges") return idleStream();
        streamInputs.push(input);
        return workspaceChanges([
          create(WatchWorkspaceFileChangesResponseSchema, {
            change: {
              workspaceId: "workspace-1",
              kind: WorkspaceFileChangeKind.RESYNC,
              sequence: 1n,
              streamRevision: "stream-1",
              observedAt: { seconds: 10n, nanos: 0 }
            }
          }),
          create(WatchWorkspaceFileChangesResponseSchema, {
            change: {
              workspaceId: "workspace-1",
              kind: WorkspaceFileChangeKind.MODIFIED,
              relativePath: "src/App.tsx",
              revision: {
                sha256Hex: "",
                opaqueRevision: "meta:2",
                byteSize: 42n,
                modifiedAt: { seconds: 11n, nanos: 500_000_000 }
              },
              sequence: 2n,
              streamRevision: "stream-2",
              observedAt: { seconds: 12n, nanos: 0 }
            }
          })
        ]);
      }
    );
    const gateway = await connectedGateway(transport);
    const values = [];
    for await (const change of gateway.watchWorkspaceFileChanges({ kind: "workspace", workspaceId: "workspace-1" })) {
      values.push(change);
    }
    expect(streamInputs).toEqual([{
      scope: { kind: { case: "workspace", value: { workspaceId: "workspace-1" } } }
    }]);
    expect(values).toEqual([
      expect.objectContaining({ kind: "resync", sequence: 1n, workspaceId: "workspace-1" }),
      expect.objectContaining({
        kind: "modified",
        path: "src/App.tsx",
        revision: "meta:2",
        byteSize: 42,
        modifiedAt: 11_500,
        sequence: 2n
      })
    ]);
    gateway.disconnect();

    const unsafeTransport = transportFor(
      async (method) => { throw new Error(`Unexpected unary RPC ${method.localName}`); },
      create(SnapshotSchema),
      (method) => method.localName === "watchWorkspaceFileChanges"
        ? workspaceChanges([create(WatchWorkspaceFileChangesResponseSchema, {
            change: {
              workspaceId: "workspace-1",
              kind: WorkspaceFileChangeKind.CREATED,
              relativePath: "C:\\secrets.txt",
              sequence: 1n,
              streamRevision: "stream-unsafe"
            }
          })])
        : idleStream()
    );
    const unsafeGateway = await connectedGateway(unsafeTransport);
    const unsafe = unsafeGateway.watchWorkspaceFileChanges({ kind: "owner" })[Symbol.asyncIterator]();
    await expect(unsafe.next()).rejects.toThrow(/non-canonical workspace file change path/u);
    unsafeGateway.disconnect();
  });

  it("fails closed on cross-scope and same-path rename watcher responses", async () => {
    const scopedTransport = transportFor(
      async (method) => { throw new Error(`Unexpected unary RPC ${method.localName}`); },
      create(SnapshotSchema),
      (method) => method.localName === "watchWorkspaceFileChanges"
        ? workspaceChanges([create(WatchWorkspaceFileChangesResponseSchema, {
            change: {
              workspaceId: "workspace-other",
              kind: WorkspaceFileChangeKind.RESYNC,
              sequence: 1n,
              streamRevision: "stream-other"
            }
          })])
        : idleStream()
    );
    const scopedGateway = await connectedGateway(scopedTransport);
    const scoped = scopedGateway.watchWorkspaceFileChanges({ kind: "workspace", workspaceId: "workspace-1" })[Symbol.asyncIterator]();
    await expect(scoped.next()).rejects.toThrow(/outside the requested scope/u);
    scopedGateway.disconnect();

    const renameTransport = transportFor(
      async (method) => { throw new Error(`Unexpected unary RPC ${method.localName}`); },
      create(SnapshotSchema),
      (method) => method.localName === "watchWorkspaceFileChanges"
        ? workspaceChanges([create(WatchWorkspaceFileChangesResponseSchema, {
            change: {
              workspaceId: "workspace-1",
              kind: WorkspaceFileChangeKind.RENAMED,
              relativePath: "src/same.ts",
              previousRelativePath: "src/same.ts",
              sequence: 1n,
              streamRevision: "stream-same"
            }
          })])
        : idleStream()
    );
    const renameGateway = await connectedGateway(renameTransport);
    const renamed = renameGateway.watchWorkspaceFileChanges({ kind: "owner" })[Symbol.asyncIterator]();
    await expect(renamed.next()).rejects.toThrow(/identical paths/u);
    renameGateway.disconnect();
  });

  it("forwards one directory page and preserves every public entry field", async () => {
    const calls: any[] = [];
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "listWorkspaceEntries") throw new Error(`Unexpected RPC ${method.localName}`);
      calls.push(input);
      return create(ListWorkspaceEntriesResponseSchema, {
        entries: [{
          workspaceId: "workspace-1",
          relativePath: "src/generated",
          displayName: "generated",
          kind: FileKind.DIRECTORY,
          revision: {
            sha256Hex: "a".repeat(64),
            byteSize: 42n,
            modifiedAt: { seconds: 123n, nanos: 456_000_000 },
            opaqueRevision: "entry-revision"
          },
          generated: true,
          ignored: true,
          hidden: true,
          mediaType: "inode/directory"
        }],
        page: { nextPageToken: "directory-next", totalSize: 7n },
        revision: { value: 31n, etag: "directory-revision" }
      });
    }, snapshotWithWorkspace());
    const gateway = await connectedGateway(transport);

    await expect(gateway.listWorkspaceEntryPage("workspace-1", "src", "directory-input", 900, {
      policy: "documentTree",
      includeHidden: true
    })).resolves.toEqual({
      entries: [{
        path: "src/generated",
        name: "generated",
        kind: "directory",
        size: 42,
        modifiedAt: 123_456,
        revision: "entry-revision",
        mediaType: "inode/directory",
        ignored: true,
        hidden: true,
        generated: true,
        status: "modified"
      }],
      nextPageToken: "directory-next",
      totalSize: 7,
      revision: "directory-revision"
    });
    expect(calls.filter((call) => call.parentRelativePath === "src")).toEqual([{
      workspaceId: "workspace-1",
      parentRelativePath: "src",
      includeHidden: true,
      listingPolicy: WorkspaceEntryListingPolicy.DOCUMENT_TREE,
      page: { pageSize: 500, pageToken: "directory-input" }
    }]);
    gateway.disconnect();
  });

  it("collects every directory page and rejects a revision change between pages", async () => {
    const requestedTokens: string[] = [];
    const requestedPolicies: Array<{ readonly includeHidden: boolean; readonly listingPolicy: WorkspaceEntryListingPolicy }> = [];
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "listWorkspaceEntries") throw new Error(`Unexpected RPC ${method.localName}`);
      requestedTokens.push(input.page.pageToken);
      requestedPolicies.push({ includeHidden: input.includeHidden, listingPolicy: input.listingPolicy });
      if (input.parentRelativePath === "stable") {
        return create(ListWorkspaceEntriesResponseSchema, input.page.pageToken === "page-2"
          ? {
              entries: [entry("stable/b.ts", "b.ts", "b-revision")],
              page: { totalSize: 2n },
              revision: { etag: "tree-revision" }
            }
          : {
              entries: [entry("stable/a.ts", "a.ts", "a-revision")],
              page: { nextPageToken: "page-2", totalSize: 2n },
              revision: { etag: "tree-revision" }
            });
      }
      return create(ListWorkspaceEntriesResponseSchema, input.page.pageToken === "drift-2"
        ? {
            entries: [entry("drift/b.ts", "b.ts", "b-revision")],
            page: { totalSize: 2n },
            revision: { etag: "tree-after" }
          }
        : {
            entries: [entry("drift/a.ts", "a.ts", "a-revision")],
            page: { nextPageToken: "drift-2", totalSize: 2n },
            revision: { etag: "tree-before" }
          });
    });
    const gateway = await connectedGateway(transport);

    await expect(gateway.listWorkspaceEntries("workspace-1", "stable")).resolves.toMatchObject([
      { path: "stable/a.ts", revision: "a-revision" },
      { path: "stable/b.ts", revision: "b-revision" }
    ]);
    await expect(gateway.listWorkspaceEntries("workspace-1", "drift")).rejects.toMatchObject({
      name: "GatewayError",
      code: "WORKSPACE_ENTRY_RESULT_CHANGED"
    });
    expect(requestedTokens).toEqual(["", "page-2", "", "drift-2"]);
    expect(requestedPolicies).toEqual(Array.from({ length: 4 }, () => ({
      includeHidden: false,
      listingPolicy: WorkspaceEntryListingPolicy.UNSPECIFIED
    })));
    gateway.disconnect();
  });

  it("collects every root page before publishing the initial Workspace snapshot", async () => {
    const tokens: string[] = [];
    let projected: import("./model.js").AppSnapshot | undefined;
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "listWorkspaceEntries") throw new Error(`Unexpected RPC ${method.localName}`);
      tokens.push(input.page.pageToken);
      return create(ListWorkspaceEntriesResponseSchema, input.page.pageToken === ""
        ? {
            entries: [entry("a.ts", "a.ts", "a-revision")],
            page: { nextPageToken: "root-page-2", totalSize: 2n },
            revision: { etag: "root-revision" }
          }
        : {
            entries: [entry("z.ts", "z.ts", "z-revision")],
            page: { totalSize: 2n },
            revision: { etag: "root-revision" }
          });
    }, snapshotWithWorkspace());
    const gateway = createOrchestratorGateway(
      { id: "connection-root-pages", deviceId: "device-test", name: "Workspace Files", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      { onSnapshot: (snapshot) => { projected = snapshot; } },
      () => transport
    );
    await gateway.connect();

    expect(tokens).toEqual(["", "root-page-2"]);
    expect(projected?.workspaces[0]?.entries).toMatchObject([
      { path: "a.ts", revision: "a-revision" },
      { path: "z.ts", revision: "z-revision" }
    ]);
    gateway.disconnect();
  });

  it("collects every Workspace change-set page for complete rewind history", async () => {
    const tokens: string[] = [];
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "listWorkspaceChangeSets") throw new Error(`Unexpected RPC ${method.localName}`);
      tokens.push(input.page.pageToken);
      return create(ListWorkspaceChangeSetsResponseSchema, input.page.pageToken === ""
        ? {
            changeSets: [{
              changeSetId: "change-new",
              workspaceId: "workspace-1",
              sessionId: "session-1",
              runId: "run-new",
              turnId: "turn-new",
              completeBaseline: true
            }],
            page: { nextPageToken: "change-page-2", totalSize: 2n }
          }
        : {
            changeSets: [{
              changeSetId: "change-old",
              workspaceId: "workspace-1",
              sessionId: "session-1",
              runId: "run-old",
              turnId: "turn-old",
              completeBaseline: true
            }],
            page: { totalSize: 2n }
          });
    });
    const gateway = await connectedGateway(transport);

    await expect(gateway.listWorkspaceChangeSets("workspace-1", "session-1")).resolves.toMatchObject([
      { id: "change-new", runId: "run-new" },
      { id: "change-old", runId: "run-old" }
    ]);
    expect(tokens).toEqual(["", "change-page-2"]);
    gateway.disconnect();
  });

  it("maps the rg filename index and progressive fixed-string search stream", async () => {
    const streamInputs: any[] = [];
    const transport = transportFor(
      async (method, input) => {
        if (method.localName !== "listWorkspaceFiles") throw new Error(`Unexpected RPC ${method.localName}`);
        expect(input).toEqual({ workspaceId: "workspace-1" });
        return create(ListWorkspaceFilesResponseSchema, {
          relativePaths: [".env", "src/App.tsx"],
          truncated: true,
          revision: { etag: "sha256:index-fence" }
        });
      },
      snapshotWithWorkspace(),
      (method, input) => {
        if (method.localName !== "streamWorkspaceSearch") return idleStream();
        streamInputs.push(input);
        return workspaceChanges([
          create(StreamWorkspaceSearchResponseSchema, {
            event: {
              case: "match",
              value: {
                relativePath: "src/App.tsx",
                range: { startByte: 8n, endByte: 14n, startLine: 2, startColumn: 3, endLine: 2, endColumn: 9 },
                linePreview: "  前🐾后🐾",
                submatches: [
                  { startByte: 5n, endByte: 9n },
                  { startByte: 12n, endByte: 16n }
                ],
                revision: { opaqueRevision: "sha256:file-fence" }
              }
            }
          }),
          create(StreamWorkspaceSearchResponseSchema, {
            event: {
              case: "end",
              value: {
                truncated: false,
                totalMatches: 1n,
                totalFiles: 1n,
                revision: { etag: "sha256:search-fence" }
              }
            }
          })
        ]);
      }
    );
    const gateway = await connectedGateway(transport);
    await expect(gateway.listWorkspaceFiles("workspace-1")).resolves.toEqual({
      paths: [".env", "src/App.tsx"],
      truncated: true,
      revision: "sha256:index-fence"
    });

    const events = [];
    for await (const event of gateway.streamWorkspaceSearch("workspace-1", "Need(le)?", true)) events.push(event);
    expect(streamInputs).toEqual([{ workspaceId: "workspace-1", query: "Need(le)?", caseSensitive: true }]);
    expect(events).toEqual([
      {
        kind: "match",
        match: {
          path: "src/App.tsx",
          line: 2,
          preview: "  前🐾后🐾",
          submatches: [
            { startByte: 5, endByte: 9 },
            { startByte: 12, endByte: 16 }
          ],
          range: { startByte: 8, endByte: 14, startLine: 2, startColumn: 3, endLine: 2, endColumn: 9 },
          revision: "sha256:file-fence"
        }
      },
      {
        kind: "end",
        truncated: false,
        totalMatches: 1,
        totalFiles: 1,
        revision: "sha256:search-fence"
      }
    ]);
    gateway.disconnect();
  });

  it("preserves a terminal workspace-search error code and user-visible reason", async () => {
    const transport = transportFor(
      async (method) => { throw new Error(`Unexpected unary RPC ${method.localName}`); },
      snapshotWithWorkspace(),
      (method) => method.localName === "streamWorkspaceSearch"
        ? workspaceChanges([create(StreamWorkspaceSearchResponseSchema, {
            event: {
              case: "error",
              value: create(ErrorInfoSchema, {
                code: "RG_UNAVAILABLE",
                phase: "workspace_search",
                message: "ripgrep is unavailable.",
                retryable: true,
                recoveryActions: [],
                diagnosticId: ""
              })
            }
          })])
        : idleStream()
    );
    const gateway = await connectedGateway(transport);
    const events = [];
    for await (const event of gateway.streamWorkspaceSearch("workspace-1", "needle", false)) events.push(event);
    expect(events).toEqual([{
      kind: "error",
      code: "RG_UNAVAILABLE",
      message: "ripgrep is unavailable."
    }]);
    gateway.disconnect();
  });

  it("forwards exact search options, wraps the server cursor with its revision, and maps full ranges", async () => {
    const calls: any[] = [];
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "searchWorkspace") throw new Error(`Unexpected RPC ${method.localName}`);
      calls.push(input);
      const secondPage = input.page.pageToken === "server-page-2";
      return create(SearchWorkspaceResponseSchema, {
        matches: [{
          relativePath: secondPage ? "src/second.ts" : "src/first.ts",
          range: secondPage
            ? { startByte: 91n, endByte: 101n, startLine: 9, startColumn: 4, endLine: 10, endColumn: 2 }
            : { startByte: 12n, endByte: 27n, startLine: 3, startColumn: 5, endLine: 4, endColumn: 7 },
          linePreview: secondPage ? "SECOND Match" : "FIRST Match",
          revision: { opaqueRevision: secondPage ? "second-file-revision" : "first-file-revision" }
        }],
        page: secondPage
          ? { totalSize: 23n }
          : { nextPageToken: "server-page-2", totalSize: 23n },
        revision: { value: 41n, etag: "search-revision" },
        totalFiles: 2n,
        truncated: !secondPage
      });
    });
    const gateway = await connectedGateway(transport);

    const first = await gateway.searchWorkspacePage("workspace-1", {
      query: "[A-Z]+ Match",
      caseSensitive: true,
      regularExpression: true,
      pageSize: 900
    });
    expect(first).toMatchObject({
      matches: [{
        path: "src/first.ts",
        line: 3,
        preview: "FIRST Match",
        range: {
          startByte: 12,
          endByte: 27,
          startLine: 3,
          startColumn: 5,
          endLine: 4,
          endColumn: 7
        },
        revision: "first-file-revision"
      }],
      truncated: true,
      totalMatches: 23,
      totalFiles: 2,
      revision: "search-revision"
    });
    expect(first.nextPageToken).toMatch(/^joko-workspace-search-v1:/u);

    const second = await gateway.searchWorkspacePage("workspace-1", {
      query: "[A-Z]+ Match",
      caseSensitive: true,
      regularExpression: true,
      pageSize: 25,
      pageToken: first.nextPageToken
    });
    expect(second).toMatchObject({
      matches: [{
        path: "src/second.ts",
        line: 9,
        range: {
          startByte: 91,
          endByte: 101,
          startLine: 9,
          startColumn: 4,
          endLine: 10,
          endColumn: 2
        },
        revision: "second-file-revision",
        pageToken: first.nextPageToken
      }],
      truncated: false,
      totalMatches: 23,
      totalFiles: 2,
      revision: "search-revision"
    });
    expect(calls).toEqual([
      {
        workspaceId: "workspace-1",
        query: "[A-Z]+ Match",
        relativePathPrefix: "",
        caseSensitive: true,
        regularExpression: true,
        page: { pageSize: 500, pageToken: "" }
      },
      {
        workspaceId: "workspace-1",
        query: "[A-Z]+ Match",
        relativePathPrefix: "",
        caseSensitive: true,
        regularExpression: true,
        page: { pageSize: 25, pageToken: "server-page-2" }
      }
    ]);
    gateway.disconnect();
  });

  it("rejects a later search page when the workspace revision fence changes", async () => {
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "searchWorkspace") throw new Error(`Unexpected RPC ${method.localName}`);
      const secondPage = input.page.pageToken === "server-next";
      return create(SearchWorkspaceResponseSchema, {
        matches: [{
          relativePath: "src/a.ts",
          range: { startByte: 0n, endByte: 1n, startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
          linePreview: "a",
          revision: { opaqueRevision: "file-revision" }
        }],
        page: secondPage ? {} : { nextPageToken: "server-next" },
        revision: { etag: secondPage ? "search-after" : "search-before" }
      });
    });
    const gateway = await connectedGateway(transport);
    const first = await gateway.searchWorkspacePage("workspace-1", {
      query: "a",
      caseSensitive: false,
      regularExpression: false
    });

    await expect(gateway.searchWorkspacePage("workspace-1", {
      query: "a",
      caseSensitive: false,
      regularExpression: false,
      pageToken: first.nextPageToken
    })).rejects.toMatchObject({
      name: "GatewayError",
      code: "WORKSPACE_SEARCH_RESULT_CHANGED"
    });
    gateway.disconnect();
  });

  it("collects every convenience-search page and fails closed on cyclic or terminally truncated results", async () => {
    const pageTokens: string[] = [];
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "searchWorkspace") throw new Error(`Unexpected RPC ${method.localName}`);
      pageTokens.push(input.page.pageToken);
      const secondPage = input.page.pageToken === "server-page-2";
      return create(SearchWorkspaceResponseSchema, {
        matches: [{
          relativePath: secondPage ? "src/second.ts" : "src/first.ts",
          range: { startByte: 0n, endByte: 1n, startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
          linePreview: secondPage ? "second" : "first",
          revision: { opaqueRevision: secondPage ? "file-2" : "file-1" }
        }],
        page: secondPage ? { totalSize: 2n } : { nextPageToken: "server-page-2", totalSize: 2n },
        revision: { etag: "search-fence" },
        totalFiles: 2n
      });
    }, snapshotWithWorkspace());
    const gateway = await connectedGateway(transport);
    await expect(gateway.searchWorkspace("workspace-1", "match")).resolves.toMatchObject([
      { path: "src/first.ts" },
      { path: "src/second.ts" }
    ]);
    expect(pageTokens).toEqual(["", "server-page-2"]);
    gateway.disconnect();

    let cyclicCalls = 0;
    const cyclicGateway = await connectedGateway(transportFor(async (method) => {
      if (method.localName !== "searchWorkspace") throw new Error(`Unexpected RPC ${method.localName}`);
      cyclicCalls += 1;
      return create(SearchWorkspaceResponseSchema, {
        page: { nextPageToken: "loop" },
        revision: { etag: "search-fence" }
      });
    }, snapshotWithWorkspace()));
    await expect(cyclicGateway.searchWorkspace("workspace-1", "match")).rejects.toThrow("cyclic Workspace search page token");
    expect(cyclicCalls).toBe(2);
    cyclicGateway.disconnect();

    const truncatedGateway = await connectedGateway(transportFor(async (method) => {
      if (method.localName !== "searchWorkspace") throw new Error(`Unexpected RPC ${method.localName}`);
      return create(SearchWorkspaceResponseSchema, {
        page: { totalSize: 1n },
        revision: { etag: "search-fence" },
        truncated: true
      });
    }, snapshotWithWorkspace()));
    await expect(truncatedGateway.searchWorkspace("workspace-1", "match")).rejects.toThrow("truncated before every match");
    truncatedGateway.disconnect();
  });

  it("submits exact create, move, delete, and copy mutations with public revision fences", async () => {
    const mutations: any[] = [];
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "submitOperation") throw new Error(`Unexpected RPC ${method.localName}`);
      mutations.push(input.mutation.payload);
      return create(SubmitOperationResponseSchema, {
        operation: {
          operationId: input.operationId,
          connectionId: input.connectionId,
          state: OperationState.SUCCEEDED
        }
      });
    });
    const gateway = await connectedGateway(transport);

    await gateway.createWorkspaceEntry({ workspaceId: "workspace-1", path: "src/new", kind: "directory" });
    await gateway.createWorkspaceEntry({ workspaceId: "workspace-1", path: "src/new/a.ts", kind: "file" });
    await gateway.moveWorkspaceEntry({
      workspaceId: "workspace-1",
      sourcePath: "src/old.ts",
      destinationPath: "src/new.ts",
      expectedRevision: "move-revision"
    });
    await gateway.deleteWorkspaceEntry({
      workspaceId: "workspace-1",
      path: "src/obsolete",
      expectedRevision: "delete-revision",
      confirmRecursive: true
    });
    await gateway.copyWorkspaceEntry({
      workspaceId: "workspace-1",
      sourcePath: "src/original.ts",
      destinationPath: "src/copy.ts",
      expectedRevision: "copy-revision"
    });

    expect(mutations).toMatchObject([
      {
        case: "createWorkspaceEntry",
        value: {
          workspaceId: "workspace-1",
          relativePath: "src/new",
          kind: WorkspaceEntryCreateKind.DIRECTORY,
          expectedRevision: workspaceEntryAbsentRevision
        }
      },
      {
        case: "createWorkspaceEntry",
        value: {
          workspaceId: "workspace-1",
          relativePath: "src/new/a.ts",
          kind: WorkspaceEntryCreateKind.FILE,
          expectedRevision: workspaceEntryAbsentRevision
        }
      },
      {
        case: "moveWorkspaceEntry",
        value: {
          workspaceId: "workspace-1",
          sourceRelativePath: "src/old.ts",
          destinationRelativePath: "src/new.ts",
          expectedRevision: "move-revision"
        }
      },
      {
        case: "deleteWorkspaceEntry",
        value: {
          workspaceId: "workspace-1",
          relativePath: "src/obsolete",
          expectedRevision: "delete-revision",
          confirmRecursive: true
        }
      },
      {
        case: "copyWorkspaceEntry",
        value: {
          workspaceId: "workspace-1",
          sourceRelativePath: "src/original.ts",
          destinationRelativePath: "src/copy.ts",
          expectedRevision: "copy-revision"
        }
      }
    ]);
    gateway.disconnect();
  });

  it("preserves a typed operation failure code for Files UI recovery", async () => {
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "submitOperation") throw new Error(`Unexpected RPC ${method.localName}`);
      return create(SubmitOperationResponseSchema, {
        operation: {
          operationId: input.operationId,
          connectionId: input.connectionId,
          state: OperationState.CONFLICT,
          error: {
            code: "WORKSPACE_ENTRY_STALE",
            message: "The selected file changed."
          }
        }
      });
    });
    const gateway = await connectedGateway(transport);

    await expect(gateway.moveWorkspaceEntry({
      workspaceId: "workspace-1",
      sourcePath: "src/a.ts",
      destinationPath: "src/b.ts",
      expectedRevision: "stale-revision"
    })).rejects.toMatchObject({
      name: "GatewayError",
      code: "WORKSPACE_ENTRY_STALE",
      message: "The selected file changed."
    });
    gateway.disconnect();
  });
});

function entry(relativePath: string, displayName: string, opaqueRevision: string): any {
  return {
    workspaceId: "workspace-1",
    relativePath,
    displayName,
    kind: FileKind.REGULAR,
    revision: { opaqueRevision },
    generated: false
  };
}

function snapshotWithWorkspace(): ReturnType<typeof create<typeof SnapshotSchema>> {
  return create(SnapshotSchema, {
    workspaces: [{
      workspaceId: "workspace-1",
      targetId: "target-1",
      displayName: "Workspace",
      git: {
        changes: [{
          relativePath: "src/generated",
          indexStatus: GitFileStatus.UNMODIFIED,
          workingTreeStatus: GitFileStatus.MODIFIED
        }]
      }
    }]
  });
}

function transportFor(
  handle: (method: any, input: any) => Promise<unknown> | unknown,
  snapshot = create(SnapshotSchema),
  handleStream?: (method: any, input: any) => AsyncIterable<unknown>
): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, { snapshot }));
      }
      return response(method, await handle(method, input));
    }),
    stream: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: AsyncIterable<any>) => {
      const request = handleStream === undefined ? undefined : (await input[Symbol.asyncIterator]().next()).value;
      return response(method, handleStream?.(method, request) ?? idleStream(), true);
    })
  } as unknown as Transport;
}

async function connectedGateway(transport: Transport) {
  const gateway = createOrchestratorGateway(
    { id: "connection-workspace-files", deviceId: "device-test", name: "Workspace Files", origin: "https://orchestrator.example" , serverId: "server-test" },
    "secret",
    {},
    () => transport
  );
  await gateway.connect();
  return gateway;
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}

async function* workspaceChanges(values: readonly unknown[]): AsyncIterable<unknown> {
  yield* values;
}

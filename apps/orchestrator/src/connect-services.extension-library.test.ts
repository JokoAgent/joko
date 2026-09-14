import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import type { ExtensionCatalogDescriptor } from "./extension-catalog.js";
import { ExtensionLibraryManager } from "./extension-library-manager.js";
import type { PiResourceDescriptor } from "./resource-manager.js";

const EXTENSION_ID = `extension_${"e".repeat(32)}`;
const CONNECTION_ID = "connection-extension-library";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function context(): unknown {
  return { requestHeader: new Headers({ authorization: "Bearer extension-library-test" }), signal: new AbortController().signal };
}

async function invoke<T>(handler: unknown, request: unknown): Promise<T> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (input: unknown, handlerContext: unknown) => T | Promise<T>)(request, context());
}

function stubApplication(overrides: Record<string, unknown>): OrchestratorApplication {
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store: {},
    connections: {},
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined,
    ...overrides
  } as unknown as OrchestratorApplication;
}

describe("Connect Extension Library boundary", () => {
  it("maps the bounded file and SQL protocol and revokes exact authority and connection sessions", async () => {
    const temporaryPath = await mkdtemp(join(tmpdir(), "joko-connect-extension-library-"));
    cleanups.push(() => rm(temporaryPath, { recursive: true, force: true }));
    const manager = new ExtensionLibraryManager({
      rootDirectory: join(temporaryPath, "libraries"),
      freeBytes: async () => 64 * 1024 * 1024 * 1024
    });
    await manager.initialize();
    cleanups.push(() => manager.close());

    let entry = extensionEntry();
    const resource = extensionResource();
    let revoked: (() => void) | undefined;
    const fence = vi.fn();
    const services = createConnectServices(stubApplication({
      store: {
        getBackend: () => ({ revision: 9n, descriptor: { id: "pi", instanceGeneration: 3 } })
      },
      connections: {
        authenticate: () => ({
          id: CONNECTION_ID,
          name: "Extension Library tests",
          authKeyDigest: "digest",
          state: "active",
          pairedAt: 1,
          revision: 1n
        }),
        fence,
        onRevoked: (_connectionId: string, listener: () => void) => {
          revoked = listener;
          return () => undefined;
        }
      },
      piResources: { list: () => [resource], get: () => resource },
      extensionCatalog: {
        reconcile: () => ({ revision: 1n, entries: [entry], recoveredFromCorruption: false }),
        get: () => entry
      },
      extensionLibraries: manager,
      sessionHost: {}
    }));

    const overview = await invoke<contract.GetExtensionLibraryOverviewResponse>(
      services.extension.getExtensionLibraryOverview,
      { extensionId: EXTENSION_ID, expectedRevision: { value: 7n } }
    );
    expect(overview.library).toMatchObject({
      extensionId: EXTENSION_ID,
      name: "Canvas",
      state: contract.ExtensionLibraryState.READY,
      files: 0,
      bytes: 0n
    });

    const opened = await invoke<contract.OpenExtensionLibraryResponse>(services.extension.openExtensionLibrary, {
      extensionId: EXTENSION_ID,
      expectedRevision: { value: 7n }
    });
    const sessionId = opened.library?.sessionId;
    expect(sessionId).toMatch(/^library_session_[a-f0-9]{32}$/u);
    expect(opened.library).not.toHaveProperty("path");
    expect(opened.library?.limits).toMatchObject({
      maximumReadBytes: 16n * 1024n * 1024n,
      maximumStreamBytes: 8n * 1024n * 1024n * 1024n,
      maximumFiles: 50_000
    });

    const written = await libraryCall(services.extension.callExtensionLibrary, sessionId!, {
      case: "write",
      value: { path: "notes/hello.txt", content: new TextEncoder().encode("hello"), ifNotExists: true }
    });
    expect(written.result).toMatchObject({
      case: "write",
      value: { path: "notes/hello.txt", bytes: 5n }
    });
    const read = await libraryCall(services.extension.callExtensionLibrary, sessionId!, {
      case: "read",
      value: { path: "notes/hello.txt" }
    });
    expect(read.result.case).toBe("read");
    if (read.result.case !== "read") throw new Error("Expected a Library read result.");
    expect(new TextDecoder().decode(read.result.value.content)).toBe("hello");
    expect(read.result.value.path).toBe("notes/hello.txt");

    const openedDatabase = await libraryCall(services.extension.callExtensionLibrary, sessionId!, {
      case: "sqlOpen",
      value: { path: "state.sqlite", create: true, readOnly: false }
    });
    if (openedDatabase.result.case !== "sqlHandle") throw new Error("Expected a SQLite handle.");
    const handleId = openedDatabase.result.value.handleId;
    await libraryCall(services.extension.callExtensionLibrary, sessionId!, {
      case: "sqlExecute",
      value: {
        handleId,
        statement: create(contract.ExtensionLibrarySqlStatementSchema, {
          sql: "CREATE TABLE cards(id INTEGER PRIMARY KEY, title TEXT NOT NULL)"
        })
      }
    });
    await libraryCall(services.extension.callExtensionLibrary, sessionId!, {
      case: "sqlExecute",
      value: {
        handleId,
        statement: create(contract.ExtensionLibrarySqlStatementSchema, {
          sql: "INSERT INTO cards(title) VALUES (?)",
          parameters: [create(contract.ExtensionLibrarySqlValueSchema, {
            value: { case: "textValue", value: "first" }
          })]
        })
      }
    });
    const selected = await libraryCall(services.extension.callExtensionLibrary, sessionId!, {
      case: "sqlExecute",
      value: {
        handleId,
        statement: create(contract.ExtensionLibrarySqlStatementSchema, {
          sql: "SELECT id, title FROM cards"
        })
      }
    });
    expect(selected.result).toMatchObject({
      case: "sqlResult",
      value: {
        rows: [{ cells: [
          { name: "id", value: { value: { case: "integerValue", value: "1" } } },
          { name: "title", value: { value: { case: "textValue", value: "first" } } }
        ] }]
      }
    });

    await expect(libraryCall(services.extension.callExtensionLibrary, sessionId!, {
      case: "read",
      value: { path: "D:\\private.txt" }
    })).rejects.toMatchObject({ code: Code.InvalidArgument });

    entry = { ...entry, revision: 8n };
    await expect(libraryCall(services.extension.callExtensionLibrary, sessionId!, {
      case: "read",
      value: { path: "notes/hello.txt" }
    })).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(fence).toHaveBeenCalled();

    const reopened = await invoke<contract.OpenExtensionLibraryResponse>(services.extension.openExtensionLibrary, {
      extensionId: EXTENSION_ID,
      expectedRevision: { value: 8n }
    });
    revoked?.();
    await vi.waitFor(async () => {
      await expect(manager.closeSession(reopened.library!.sessionId, CONNECTION_ID)).resolves.toBe(false);
    });
  });
});

async function libraryCall(
  handler: unknown,
  sessionId: string,
  operation: { readonly case: string; readonly value: unknown }
): Promise<contract.ExtensionLibraryCallResult> {
  const response = await invoke<contract.CallExtensionLibraryResponse>(handler, {
    sessionId,
    call: create(contract.ExtensionLibraryCallSchema, {
      operation: operation as contract.ExtensionLibraryCall["operation"]
    })
  });
  if (response.result === undefined) throw new Error("Library call response is missing its result.");
  return response.result;
}

function extensionEntry(): ExtensionCatalogDescriptor {
  return {
    id: EXTENSION_ID,
    revision: 7n,
    owner: {
      kind: "resource",
      resourceId: "resource-library",
      discoveredRevision: "sha256:library",
      resourceVersion: 5n
    },
    source: "local",
    installed: true,
    installState: "installed",
    name: "Canvas",
    version: "1.0.0",
    author: "Joko",
    description: "Canvas extension",
    enabled: true,
    library: { schemaVersion: 1, extensionEntry: "extensions/canvas.ts" },
    sidebarSupported: false,
    sidebarVisible: false,
    tools: [],
    permissions: [],
    commands: [],
    setup: { state: "not_required", revision: 0n, fields: [] },
    useSupported: false
  };
}

function extensionResource(): PiResourceDescriptor {
  return {
    id: "resource-library",
    backendId: "pi",
    kind: "package",
    scope: "managed",
    name: "@sample/canvas",
    version: "1.0.0",
    sourceKind: "local",
    sourceIdentity: "local-canvas",
    sourceDisplay: "Canvas package",
    canonicalPathFingerprint: `sha256:${"a".repeat(64)}`,
    symbolicLinkDetected: false,
    specialFileDetected: false,
    discoveredRevision: "sha256:library",
    resourceDetails: [{
      kind: "extension",
      name: "canvas.ts",
      entryPath: "extensions/canvas.ts",
      library: { schemaVersion: 1 },
      compatibility: "supported",
      compatibilityIssues: [],
      detectedApis: [],
      adaptedApis: [],
      unsupportedApis: []
    }],
    runtimeRequirements: [],
    warnings: [],
    disabledLifecycleScripts: [],
    canToggle: true,
    requiresExtensionApproval: false,
    postMutationNotice: false,
    state: "loaded",
    enabled: true,
    versionNumber: 5n,
    updatedAt: 1,
    packageIdentity: "@sample/canvas"
  };
}

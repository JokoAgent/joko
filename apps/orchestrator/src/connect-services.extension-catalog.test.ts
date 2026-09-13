import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { operationBodyHash, type OperationRecord } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import type { ExtensionCatalogDescriptor } from "./extension-catalog.js";
import type { ExtensionSourceDescriptor } from "./extension-source-manager.js";

const connection = {
  id: "connection-extension",
  name: "Extension tests",
  authKeyDigest: "digest",
  state: "active" as const,
  pairedAt: 1,
  revision: 1n
};

function context(): unknown {
  return { requestHeader: new Headers({ authorization: "Bearer extension-test" }), signal: new AbortController().signal };
}

function stubApplication(overrides: Record<string, unknown>): OrchestratorApplication {
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store: {},
    connections: { authenticate: () => connection },
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

async function invoke<T>(handler: unknown, request: unknown): Promise<T> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (input: unknown, handlerContext: unknown) => T | Promise<T>)(request, context());
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

function immediateHost(store: object, extra: Record<string, unknown> = {}) {
  return {
    mutate: async (input: {
      readonly operationId: string;
      readonly kind: string;
      readonly body: unknown;
      readonly effect?: () => Promise<void>;
      readonly commit: (value: object) => unknown;
    }) => {
      await input.effect?.();
      const value = input.commit(store);
      return { replayed: false, value, operation: completedRecord(input.operationId, input.kind, input.body, value) };
    },
    ...extra
  };
}

describe("Connect Extension catalog boundary", () => {
  it("maps a filtered runtime-backed catalog and preserves its owner and revision identity", async () => {
    const base = extensionEntry();
    const runtime = {
      ...base,
      commands: [{ name: "review", description: "Review changes", sessionId: "runtime-session" }],
      useSupported: true
    };
    const reconcile = vi.fn(() => catalog(base));
    const snapshot = vi.fn(() => catalog(runtime));
    const getCommands = vi.fn(async () => [{
      name: "review",
      description: "Review changes",
      source: "extension" as const,
      loaded: true,
      resourceId: "resource-1"
    }]);
    const services = createConnectServices(stubApplication({
      store: {
        getSession: () => ({ descriptor: { backendId: "pi" } }),
        getBackend: () => ({ descriptor: { capabilities: new Map() } })
      },
      piResources: { list: () => [] },
      extensionCatalog: { reconcile, snapshot },
      sessionHost: { getCommands }
    }));

    const listed = await invoke<contract.ListExtensionsResponse>(services.extension.listExtensions, {
      source: contract.ExtensionCatalogSource.LOCAL,
      installed: true,
      query: "  REVIEW  ",
      sessionId: "runtime-session",
      page: { pageSize: 10, pageToken: "" }
    });
    expect(listed.catalogRevision?.value).toBe(11n);
    expect(listed.extensions).toHaveLength(1);
    expect(listed.extensions[0]).toMatchObject({
      extensionId: base.id,
      revision: { value: 7n },
      source: contract.ExtensionCatalogSource.LOCAL,
      commands: [{ name: "review", sessionId: "runtime-session" }],
      useSupported: true,
      owner: {
        kind: {
          case: "resource",
          value: {
            resourceId: "resource-1",
            discoveredRevision: "sha256:owner",
            resourceVersion: { value: 4n }
          }
        }
      }
    });
    expect(snapshot).toHaveBeenCalledWith({ sessionId: "runtime-session", commands: await getCommands.mock.results[0]!.value });

    const detail = await invoke<contract.GetExtensionResponse>(services.extension.getExtension, {
      extensionId: base.id,
      sessionId: "runtime-session"
    });
    expect(detail.extension?.extensionId).toBe(base.id);
    expect(detail.catalogRevision?.value).toBe(11n);
  });

  it("rejects stale setup mutations and binds credential tickets and commits to the authenticated connection", async () => {
    const entry = extensionEntry({
      setup: {
        state: "in_progress",
        attemptId: "attempt-1",
        revision: 1n,
        fields: [{
          id: "token",
          label: "Token",
          description: "Protected token",
          kind: "secret",
          required: true,
          configured: false,
          options: []
        }]
      },
      useSupported: false
    });
    const beginSetup = vi.fn(() => ({ ...entry, revision: 8n }));
    const beginSetupCredentialUpload = vi.fn(() => ({
      credentialUploadTicketId: "credential-ticket-1",
      expiresAt: 2_000,
      maximumBytes: 1_024
    }));
    const commitSetupCredential = vi.fn(async () => ({ ...entry, revision: 8n }));
    const store = { findOperation: vi.fn(() => undefined) };
    const services = createConnectServices(stubApplication({
      store,
      credentials: {},
      extensionCatalog: {
        reconcile: () => catalog(entry),
        beginSetup,
        beginSetupCredentialUpload,
        commitSetupCredential
      },
      sessionHost: immediateHost(store)
    }));

    const beginMutation = create(contract.OperationMutationSchema, {
      payload: {
        case: "beginExtensionSetup",
        value: { extensionId: entry.id, expectedRevision: { value: 7n } }
      }
    });
    await invoke(services.operation.submitOperation, {
      operationId: "extension-begin",
      connectionId: connection.id,
      mutation: beginMutation
    });
    expect(beginSetup).toHaveBeenCalledWith(entry.id, 7n);

    const staleMutation = create(contract.OperationMutationSchema, {
      payload: {
        case: "beginExtensionSetup",
        value: { extensionId: entry.id, expectedRevision: { value: 6n } }
      }
    });
    await expect(invoke(services.operation.submitOperation, {
      operationId: "extension-stale",
      connectionId: connection.id,
      mutation: staleMutation
    })).rejects.toMatchObject({ code: Code.Aborted });

    const ticket = await invoke<contract.BeginExtensionSetupCredentialUploadResponse>(
      services.extension.beginExtensionSetupCredentialUpload,
      {
        extensionId: entry.id,
        attemptId: "attempt-1",
        fieldId: "token",
        kind: contract.CredentialKind.HEADER_SECRET
      }
    );
    expect(beginSetupCredentialUpload).toHaveBeenCalledWith({
      extensionId: entry.id,
      attemptId: "attempt-1",
      fieldId: "token",
      kind: "header_secret",
      connectionId: connection.id
    });
    expect(ticket.ticket).toMatchObject({
      ticketId: "credential-ticket-1",
      relativeEndpoint: "/v1/credentials/upload/credential-ticket-1",
      maximumBytes: 1_024n
    });

    const commitMutation = create(contract.OperationMutationSchema, {
      payload: {
        case: "commitExtensionSetupCredential",
        value: {
          extensionId: entry.id,
          attemptId: "attempt-1",
          fieldId: "token",
          credentialUploadTicketId: "credential-ticket-1",
          expectedRevision: { value: 7n }
        }
      }
    });
    await invoke(services.operation.submitOperation, {
      operationId: "extension-secret-commit",
      connectionId: connection.id,
      mutation: commitMutation
    });
    expect(commitSetupCredential).toHaveBeenCalledWith({
      extensionId: entry.id,
      attemptId: "attempt-1",
      fieldId: "token",
      credentialUploadTicketId: "credential-ticket-1",
      connectionId: connection.id,
      expectedRevision: 7n
    });
  });

  it("maps exact source/preflight state and submits revision-fenced source lifecycle effects", async () => {
    const source = extensionSource();
    const add = vi.fn(async () => source);
    const refresh = vi.fn(async () => ({ ...source, revision: 5n }));
    const remove = vi.fn(async () => undefined);
    const gitPreflight = vi.fn(async () => ({ available: true, version: "2.43.0", minimumVersion: "2.25" }));
    const sourceSnapshot = vi.fn(() => ({ revision: 4n, sources: [source], recoveredFromCorruption: false }));
    const auditAvailability = vi.fn(async () => sourceSnapshot());
    const store = { findOperation: vi.fn(() => undefined) };
    const reconcile = vi.fn(() => ({ revision: 1n, entries: [], recoveredFromCorruption: false }));
    const services = createConnectServices(stubApplication({
      store,
      extensionSources: { add, refresh, remove, gitPreflight, snapshot: sourceSnapshot, auditAvailability },
      extensionCatalog: { reconcile },
      sessionHost: immediateHost(store)
    }));

    const preflight = await invoke<contract.GetExtensionSourceGitPreflightResponse>(services.extension.getExtensionSourceGitPreflight, {});
    expect(preflight.preflight).toMatchObject({ available: true, version: "2.43.0", minimumVersion: "2.25" });
    const listed = await invoke<contract.ListExtensionSourcesResponse>(services.extension.listExtensionSources, {
      page: { pageSize: 10, pageToken: "" }
    });
    expect(listed.catalogRevision?.value).toBe(4n);
    expect(auditAvailability).toHaveBeenCalledTimes(1);
    expect(listed.sources).toMatchObject([{
      sourceId: source.id,
      revision: { value: 4n },
      kind: contract.ExtensionSourceKind.LOCAL,
      location: { kind: { case: "local", value: { path: "D:\\extensions" } } },
      name: "community-extensions",
      state: contract.ExtensionSourceState.READY,
      discoveredExtensionCount: 1,
      declaredEntryCount: 1
    }]);

    const addMutation = create(contract.OperationMutationSchema, {
      payload: {
        case: "addExtensionSource",
        value: {
          source: { kind: { case: "git", value: { repositoryUrl: "https://example.test/extensions.git", sparsePaths: [".agents/plugins"] } } },
          expectedCatalogRevision: { value: 4n }
        }
      }
    });
    await invoke(services.operation.submitOperation, { operationId: "extension-source-add", connectionId: connection.id, mutation: addMutation });
    expect(add).toHaveBeenCalledWith({ kind: "git", repositoryUrl: "https://example.test/extensions.git", sparsePaths: [".agents/plugins"] }, 4n);

    for (const [operationId, mutation, expected] of [
      ["extension-source-refresh", create(contract.OperationMutationSchema, { payload: { case: "refreshExtensionSource", value: { sourceId: source.id, expectedRevision: { value: 4n } } } }), refresh],
      ["extension-source-remove", create(contract.OperationMutationSchema, { payload: { case: "removeExtensionSource", value: { sourceId: source.id, expectedRevision: { value: 4n } } } }), remove]
    ] as const) {
      await invoke(services.operation.submitOperation, { operationId, connectionId: connection.id, mutation });
      expect(expected).toHaveBeenCalledWith(source.id, 4n);
    }
    expect(reconcile).toHaveBeenCalled();

    const reconcilesBeforeFailure = reconcile.mock.calls.length;
    refresh.mockRejectedValueOnce(new Error("source discovery failed"));
    const failedRefresh = create(contract.OperationMutationSchema, {
      payload: { case: "refreshExtensionSource", value: { sourceId: source.id, expectedRevision: { value: 5n } } }
    });
    await expect(invoke(services.operation.submitOperation, {
      operationId: "extension-source-refresh-failed",
      connectionId: connection.id,
      mutation: failedRefresh
    })).rejects.toThrow("source discovery failed");
    expect(reconcile).toHaveBeenCalledTimes(reconcilesBeforeFailure + 1);
  });
});

function catalog(entry: ExtensionCatalogDescriptor) {
  return { revision: 11n, entries: [entry], recoveredFromCorruption: false };
}

function extensionEntry(overrides: Partial<ExtensionCatalogDescriptor> = {}): ExtensionCatalogDescriptor {
  return {
    id: "extension_0123456789abcdef0123456789abcdef",
    revision: 7n,
    owner: {
      kind: "resource" as const,
      resourceId: "resource-1",
      discoveredRevision: "sha256:owner",
      resourceVersion: 4n
    },
    source: "local" as const,
    installed: true,
    installState: "installed" as const,
    name: "Review extension",
    version: "1.0.0",
    author: "Joko",
    description: "Review changes",
    enabled: true,
    sidebarSupported: true,
    sidebarVisible: false,
    tools: [],
    permissions: [],
    commands: [],
    setup: { state: "not_required" as const, revision: 0n, fields: [] },
    useSupported: false,
    ...overrides
  };
}

function extensionSource(): ExtensionSourceDescriptor {
  return {
    id: "extension_source_0123456789abcdef0123456789abcdef",
    revision: 4n,
    source: { kind: "local", path: "D:\\extensions" },
    sourceIdentity: '["local","D:\\\\extensions"]',
    sourceDisplay: "D:\\extensions",
    name: "community-extensions",
    state: "ready",
    contentRevision: `sha256:${"a".repeat(64)}`,
    entries: [{
      id: "extension_source_entry_0123456789abcdef0123456789abcdef",
      revision: `sha256:${"b".repeat(64)}`,
      contentRevision: `sha256:${"b".repeat(64)}`,
      packageContentRevision: `sha256:${"c".repeat(64)}`,
      resourceId: "resource_market_0123456789abcdef0123456789abcdef",
      packageRelativePath: "packages/review",
      extensionRelativePath: "extensions/index.ts",
      bindingName: "index.ts",
      bindingOrdinal: 0,
      name: "Review",
      packageName: "@sample/review",
      description: "Review changes"
    }],
    declaredEntryCount: 1,
    skippedEntryCount: 0,
    unreadableEntryCount: 0,
    addedAt: 1,
    refreshedAt: 2
  };
}

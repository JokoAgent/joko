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

function replayingHost(
  store: object,
  operations: Map<string, OperationRecord<unknown>>,
  extra: Record<string, unknown> = {}
) {
  return {
    mutate: async (input: {
      readonly operationId: string;
      readonly kind: string;
      readonly body: unknown;
      readonly precondition?: (value: object) => void;
      readonly effect?: () => Promise<void>;
      readonly commit: (value: object) => unknown;
      readonly complete?: (
        commit: (finalize?: (value: object) => void) => {
          readonly replayed: boolean;
          readonly value: unknown;
          readonly operation: OperationRecord<unknown>;
        }
      ) => Promise<{
        readonly replayed: boolean;
        readonly value: unknown;
        readonly operation: OperationRecord<unknown>;
      }>;
    }) => {
      const existing = operations.get(input.operationId);
      if (existing !== undefined) return { replayed: true, value: existing.response, operation: existing };
      input.precondition?.(store);
      await input.effect?.();
      const commit = (finalize?: (value: object) => void) => {
        input.precondition?.(store);
        finalize?.(store);
        const value = input.commit(store);
        const operation = completedRecord(input.operationId, input.kind, input.body, value);
        operations.set(input.operationId, operation);
        return { replayed: false, value, operation };
      };
      return input.complete === undefined ? commit() : input.complete(commit);
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

  it("previews, commits, replays, and uninstalls one exact Source package through the Resource owner", async () => {
    const source = extensionSource();
    const sourceEntry = source.entries[0]!;
    let phase: "source" | "installed" | "removed" = "source";
    const sourceCatalogEntry = (revision: bigint): ExtensionCatalogDescriptor => extensionEntry({
      revision,
      owner: {
        kind: "source",
        sourceId: source.id,
        sourceRevision: source.revision,
        entryId: sourceEntry.id,
        contentRevision: sourceEntry.contentRevision
      },
      source: "market",
      installed: false,
      installState: "available",
      name: sourceEntry.name,
      version: "1.0.0",
      enabled: false,
      sidebarSupported: false,
      sidebarVisible: false
    });
    const resource = {
      id: sourceEntry.resourceId,
      backendId: "pi",
      kind: "package" as const,
      scope: "managed" as const,
      name: "@sample/review",
      version: "1.0.0",
      sourceKind: "extension_source" as const,
      sourceIdentity: "extension-source-package",
      sourceDisplay: source.sourceDisplay,
      canonicalPathFingerprint: `sha256:${"d".repeat(64)}`,
      symbolicLinkDetected: false,
      specialFileDetected: false,
      discoveredRevision: sourceEntry.packageContentRevision,
      packageIdentity: "@sample/review",
      extensionSource: {
        sourceId: source.id,
        sourceRevision: source.revision,
        packageRelativePath: sourceEntry.packageRelativePath,
        packageContentRevision: sourceEntry.packageContentRevision
      },
      resourceDetails: [{
        kind: "extension" as const,
        name: sourceEntry.bindingName,
        compatibility: "supported" as const,
        compatibilityIssues: [] as const,
        detectedApis: ["notify" as const],
        adaptedApis: ["notify" as const],
        unsupportedApis: [] as const
      }],
      runtimeRequirements: [{ packageName: "@earendil-works/pi-coding-agent", range: "^0.84.0", currentVersion: "0.84.2", compatible: true }],
      warnings: ["lifecycle-scripts-disabled" as const],
      disabledLifecycleScripts: ["postinstall"],
      canToggle: true,
      requiresExtensionApproval: false,
      postMutationNotice: true,
      state: "installed" as const,
      enabled: false,
      versionNumber: 1n,
      updatedAt: 4
    };
    const removedResource = { ...resource, state: "removed" as const, versionNumber: 2n };
    const installedCatalogEntry = extensionEntry({
      revision: 8n,
      owner: { kind: "resource", resourceId: resource.id, discoveredRevision: resource.discoveredRevision, resourceVersion: 1n },
      source: "market",
      name: sourceEntry.name,
      version: "1.0.0",
      enabled: false,
      library: { schemaVersion: 1, extensionEntry: "extensions/index.ts" },
      sidebarVisible: false
    });
    let installedRevision = 8n;
    const currentCatalogEntry = (): ExtensionCatalogDescriptor => phase === "installed"
      ? { ...installedCatalogEntry, revision: installedRevision }
      : sourceCatalogEntry(phase === "removed" ? 9n : 7n);
    let failCommittedCatalogRefresh = false;
    const extensionCatalog = {
      reconcile: vi.fn(() => {
        if (failCommittedCatalogRefresh && phase === "installed") {
          failCommittedCatalogRefresh = false;
          throw new Error("catalog persistence unavailable");
        }
        return catalog(currentCatalogEntry());
      }),
      snapshot: vi.fn(() => catalog(currentCatalogEntry())),
      get: vi.fn(() => currentCatalogEntry())
    };
    const preview = {
      action: "install" as const,
      resourceId: resource.id,
      backendId: "pi",
      packageName: "@sample/review",
      availableVersion: "1.0.0",
      sourceReplacement: false,
      preservesEnabled: false,
      resourceDetails: resource.resourceDetails,
      runtimeRequirements: resource.runtimeRequirements,
      warnings: resource.warnings,
      disabledLifecycleScripts: resource.disabledLifecycleScripts,
      canToggle: true
    };
    const assertCurrent = vi.fn();
    const release = vi.fn();
    const withEntry = vi.fn(async (input: unknown, action: (entry: typeof sourceEntry, root: string) => Promise<unknown>) => {
      expect(input).toMatchObject({ sourceId: source.id, sourceRevision: source.revision, entryId: sourceEntry.id, contentRevision: sourceEntry.contentRevision });
      return action(sourceEntry, "D:\\leased-package");
    });
    const acquireEntry = vi.fn(async () => ({ source, entry: sourceEntry, packageRoot: "D:\\leased-package", assertCurrent, release }));
    const extensionSources = { snapshot: () => ({ revision: 4n, sources: [source], recoveredFromCorruption: false }), get: () => source, withEntry, acquireEntry };
    const previewExtensionPackage = vi.fn(async () => preview);
    const prepareExtensionPackage = vi.fn(async () => ({
      preview,
      mutation: { value: resource, revokesRuntimeAuthority: false, fixtureKind: "install" }
    }));
    let backendGeneration = 3;
    let removalDrift: "extension" | "backend" | undefined;
    const prepareRemove = vi.fn(async () => {
      if (removalDrift === "extension") installedRevision += 1n;
      if (removalDrift === "backend") backendGeneration += 1;
      return { value: removedResource, revokesRuntimeAuthority: false, fixtureKind: "remove" };
    });
    const completePreparedMutation = vi.fn(async (prepared: any, completion: (finalize: (store: unknown) => void) => unknown) =>
      completion(() => { phase = prepared.fixtureKind === "remove" ? "removed" : "installed"; }));
    const piResources = {
      list: () => phase === "installed" ? [resource] : phase === "removed" ? [removedResource] : [],
      get: () => phase === "removed" ? removedResource : resource,
      previewExtensionPackage,
      prepareExtensionPackage,
      prepareRemove,
      completePreparedMutation
    };
    const operations = new Map<string, OperationRecord<unknown>>();
    const store = {
      findOperation: (id: string) => operations.get(id),
      getOperation: (id: string) => operations.get(id),
      getBackend: () => ({ descriptor: {
        id: "pi",
        adapterKind: "pi",
        instanceGeneration: backendGeneration,
        capabilities: new Map([["runtime.resources", { key: "runtime.resources", supported: true, options: ["extension", "package"] }]])
      } }),
      appendDiagnostic: vi.fn()
    };
    const fence = Symbol("resource-catalog");
    const fenceBackendResourceCatalogs = vi.fn(() => fence);
    const completeBackendResourceCatalogRefresh = vi.fn();
    const host = replayingHost(store, operations, { fenceBackendResourceCatalogs, completeBackendResourceCatalogRefresh });
    const refreshPiGeneration = vi.fn(async () => undefined);
    const releaseLibraryAuthority = vi.fn(async () => undefined);
    const acquireAuthorityChange = vi.fn(async () => ({ release: releaseLibraryAuthority }));
    const acquireAuthorityChanges = vi.fn(async () => ({ release: releaseLibraryAuthority }));
    const services = createConnectServices(stubApplication({
      store,
      piResources,
      extensionSources,
      extensionCatalog,
      extensionLibraries: { acquireAuthorityChange, acquireAuthorityChanges },
      sessionHost: host,
      piBackendIds: new Set(["pi"]),
      refreshPiGeneration
    }));

    const wirePreview = await invoke<contract.GetExtensionPackagePreviewResponse>(services.extension.getExtensionPackagePreview, {
      extensionId: sourceCatalogEntry(7n).id,
      expectedRevision: { value: 7n },
      backendId: "pi"
    });
    expect(wirePreview.preview).toMatchObject({
      extensionId: sourceCatalogEntry(7n).id,
      extensionRevision: { value: 7n },
      action: contract.ExtensionPackageAction.INSTALL,
      resourceId: resource.id,
      backendId: "pi",
      packageName: "@sample/review",
      compatibilityDetails: [{ kind: contract.ResourceKind.EXTENSION, compatibility: contract.ResourceCompatibility.SUPPORTED }],
      runtimeRequirements: [{ status: contract.ResourceRuntimeRequirementStatus.COMPATIBLE }],
      warnings: [contract.ResourcePackageWarning.LIFECYCLE_SCRIPTS_DISABLED],
      disabledLifecycleScripts: ["postinstall"]
    });

    const adopt = create(contract.OperationMutationSchema, { payload: { case: "adoptExtensionPackage", value: {
      extensionId: sourceCatalogEntry(7n).id,
      expectedRevision: { value: 7n },
      backendId: "pi",
      expectedAction: contract.ExtensionPackageAction.INSTALL
    } } });
    failCommittedCatalogRefresh = true;
    const installed = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "extension-package-install",
      connectionId: connection.id,
      mutation: adopt
    });
    expect(installed.operation?.state).toBe(contract.OperationState.SUCCEEDED);
    expect(installed.operation?.result?.payload.case).toBe("resource");
    expect(phase).toBe("installed");
    expect(prepareExtensionPackage).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: resource.id,
      backendId: "pi",
      sourceId: source.id,
      sourceRevision: source.revision,
      packageRoot: "D:\\leased-package",
      approvedByConnectionId: connection.id,
      expectedAction: "install",
      allowSourceReplacement: false
    }));
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(fenceBackendResourceCatalogs).toHaveBeenCalledWith("pi");
    expect(refreshPiGeneration).toHaveBeenCalledTimes(1);
    expect(acquireAuthorityChange).not.toHaveBeenCalled();
    expect(acquireAuthorityChanges).not.toHaveBeenCalled();
    expect(releaseLibraryAuthority).not.toHaveBeenCalled();
    expect(completeBackendResourceCatalogRefresh).toHaveBeenCalledWith("pi", fence, true);
    expect(store.appendDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: "EXTENSION_CATALOG_REFRESH_FAILED",
      details: { extensionId: sourceCatalogEntry(7n).id }
    }));

    await invoke(services.operation.submitOperation, {
      operationId: "extension-package-install",
      connectionId: connection.id,
      mutation: adopt
    });
    expect(acquireEntry).toHaveBeenCalledTimes(1);
    expect(prepareExtensionPackage).toHaveBeenCalledTimes(1);
    expect(refreshPiGeneration).toHaveBeenCalledTimes(1);
    expect(acquireAuthorityChange).not.toHaveBeenCalled();
    expect(acquireAuthorityChanges).not.toHaveBeenCalled();
    expect(releaseLibraryAuthority).not.toHaveBeenCalled();

    await expect(invoke(services.extension.getExtensionPackagePreview, {
      extensionId: installedCatalogEntry.id,
      expectedRevision: { value: 7n },
      backendId: "pi"
    })).rejects.toMatchObject({ code: Code.Aborted });

    const remove = create(contract.OperationMutationSchema, { payload: { case: "removeExtensionPackage", value: {
      extensionId: installedCatalogEntry.id,
      expectedRevision: { value: 8n }
    } } });
    removalDrift = "extension";
    await expect(invoke(services.operation.submitOperation, {
      operationId: "extension-package-remove-stale-extension",
      connectionId: connection.id,
      mutation: remove
    })).rejects.toMatchObject({ code: Code.Aborted });
    expect(phase).toBe("installed");
    installedRevision = 8n;

    removalDrift = "backend";
    await expect(invoke(services.operation.submitOperation, {
      operationId: "extension-package-remove-stale-backend",
      connectionId: connection.id,
      mutation: remove
    })).rejects.toMatchObject({ code: Code.Aborted });
    expect(phase).toBe("installed");
    removalDrift = undefined;

    await invoke(services.operation.submitOperation, {
      operationId: "extension-package-remove",
      connectionId: connection.id,
      mutation: remove
    });
    expect(prepareRemove).toHaveBeenCalledWith(resource.id);
    expect(phase).toBe("removed");
    expect(currentCatalogEntry()).toMatchObject({ revision: 9n, owner: { kind: "source" } });
    expect(acquireAuthorityChange).not.toHaveBeenCalled();
    expect(acquireAuthorityChanges).toHaveBeenCalledTimes(3);
    expect(acquireAuthorityChanges).toHaveBeenLastCalledWith([installedCatalogEntry.id]);
    expect(releaseLibraryAuthority).toHaveBeenCalledTimes(3);
    expect(releaseLibraryAuthority).toHaveBeenLastCalledWith({
      orphaned: [{ extensionId: installedCatalogEntry.id, name: installedCatalogEntry.name }]
    });
  });

  it("fences every Library surface in a package across generic Resource disable and removal", async () => {
    const resourceId = "resource-package-libraries";
    const first = extensionEntry({
      id: `extension_${"1".repeat(32)}`,
      name: "First Library",
      owner: { kind: "resource", resourceId, discoveredRevision: "sha256:libraries", resourceVersion: 4n },
      library: { schemaVersion: 1, extensionEntry: "extensions/first.ts" }
    });
    const second = extensionEntry({
      id: `extension_${"2".repeat(32)}`,
      name: "Second Library",
      owner: { kind: "resource", resourceId, discoveredRevision: "sha256:libraries", resourceVersion: 4n },
      library: { schemaVersion: 1, extensionEntry: "extensions/second.ts" }
    });
    let enabled = true;
    let removed = false;
    const resource = () => ({
      id: resourceId,
      backendId: "pi",
      kind: "package" as const,
      enabled,
      state: removed ? "removed" as const : "installed" as const,
      versionNumber: removed ? 6n : enabled ? 4n : 5n
    });
    const events: string[] = [];
    const prepareSetEnabled = vi.fn(async () => ({
      value: { ...resource(), enabled: false, versionNumber: 5n },
      revokesRuntimeAuthority: true,
      fixtureKind: "disable"
    }));
    const prepareRemove = vi.fn(async () => ({
      value: { ...resource(), state: "removed" as const, versionNumber: 6n },
      revokesRuntimeAuthority: true,
      fixtureKind: "remove"
    }));
    const completePreparedMutation = vi.fn(async (prepared: any, completion: (finalize: () => void) => unknown) => completion(() => {
      events.push(`commit:${prepared.fixtureKind}`);
      if (prepared.fixtureKind === "disable") enabled = false;
      else removed = true;
    }));
    const release = vi.fn(async (options?: unknown) => {
      events.push(`release:${JSON.stringify(options)}`);
    });
    const acquireAuthorityChanges = vi.fn(async (extensionIds: readonly string[]) => {
      events.push(`acquire:${extensionIds.join(",")}`);
      return { release };
    });
    const operations = new Map<string, OperationRecord<unknown>>();
    const fence = Symbol("resource-catalog");
    const store = {
      findOperation: (id: string) => operations.get(id),
      getOperation: (id: string) => operations.get(id),
      getBackend: () => ({ descriptor: { id: "pi", adapterKind: "pi", instanceGeneration: 3 } }),
      appendDiagnostic: vi.fn()
    };
    const refreshPiGeneration = vi.fn(async () => { events.push("runtime"); });
    const services = createConnectServices(stubApplication({
      store,
      piResources: {
        get: resource,
        list: () => [resource()],
        prepareSetEnabled,
        prepareRemove,
        completePreparedMutation
      },
      extensionCatalog: {
        snapshot: () => ({ revision: 1n, entries: [second, first], recoveredFromCorruption: false })
      },
      extensionLibraries: { acquireAuthorityChanges },
      sessionHost: replayingHost(store, operations, {
        fenceBackendResourceCatalogs: () => fence,
        completeBackendResourceCatalogRefresh: vi.fn()
      }),
      piBackendIds: new Set(["pi"]),
      refreshPiGeneration
    }));

    const disable = create(contract.OperationMutationSchema, { payload: {
      case: "setResourceEnabled",
      value: { resourceId, enabled: false }
    } });
    await invoke(services.operation.submitOperation, {
      operationId: "generic-package-disable",
      connectionId: connection.id,
      mutation: disable
    });
    expect(acquireAuthorityChanges).toHaveBeenLastCalledWith([first.id, second.id]);
    expect(events).toEqual([
      `acquire:${first.id},${second.id}`,
      "commit:disable",
      "runtime",
      "release:{\"orphaned\":[]}"
    ]);

    events.length = 0;
    const remove = create(contract.OperationMutationSchema, { payload: {
      case: "removeResource",
      value: { resourceId }
    } });
    await invoke(services.operation.submitOperation, {
      operationId: "generic-package-remove",
      connectionId: connection.id,
      mutation: remove
    });
    expect(events).toEqual([
      `acquire:${first.id},${second.id}`,
      "commit:remove",
      "runtime",
      `release:${JSON.stringify({ orphaned: [
        { extensionId: first.id, name: first.name },
        { extensionId: second.id, name: second.name }
      ] })}`
    ]);
  });

  it("previews, starts, lists, cancels, and revision-fences local package export jobs", async () => {
    const entry = extensionEntry({
      owner: {
        kind: "resource",
        resourceId: "resource-package",
        discoveredRevision: `sha256:${"a".repeat(64)}`,
        resourceVersion: 5n
      },
      version: "1.2.3"
    });
    let resourceVersion = 5n;
    const resource = () => ({
      id: "resource-package",
      backendId: "pi",
      kind: "package" as const,
      scope: "managed" as const,
      name: "@sample/exportable",
      version: "1.2.3",
      sourceKind: "local" as const,
      sourceIdentity: "local-package",
      sourceDisplay: "Local package",
      canonicalPathFingerprint: `sha256:${"b".repeat(64)}`,
      symbolicLinkDetected: false,
      specialFileDetected: false,
      discoveredRevision: `sha256:${"a".repeat(64)}`,
      resourceDetails: [],
      runtimeRequirements: [],
      warnings: [],
      disabledLifecycleScripts: [],
      canToggle: true,
      requiresExtensionApproval: false,
      postMutationNotice: false,
      state: "installed" as const,
      enabled: true,
      versionNumber: resourceVersion,
      updatedAt: 1,
      packageIdentity: "@sample/exportable"
    });
    const backend = {
      revision: 9n,
      descriptor: { id: "pi", instanceGeneration: 3 }
    };
    const authority = {
      extensionId: entry.id,
      extensionRevision: entry.revision,
      resourceId: resource().id,
      resourceRevision: resourceVersion,
      discoveredRevision: resource().discoveredRevision,
      backendId: "pi",
      backendRevision: 9n,
      backendGeneration: 3,
      packageName: "@sample/exportable",
      packageVersion: "1.2.3"
    };
    const pendingJob = {
      id: "extension-export",
      revision: 1n,
      state: "pending" as const,
      authority,
      archiveFormat: "npm-tar-gzip" as const,
      fileName: "sample-exportable-1.2.3.tgz",
      files: 0,
      uncompressedBytes: 0,
      createdAt: 1,
      updatedAt: 1
    };
    const readyJob = {
      ...pendingJob,
      revision: 4n,
      state: "ready" as const,
      files: 3,
      uncompressedBytes: 123,
      artifact: {
        id: "artifact-package",
        sha256: "c".repeat(64),
        byteLength: 88,
        mimeType: "application/gzip",
        fileName: pendingJob.fileName
      },
      updatedAt: 4,
      completedAt: 4
    };
    const extensionCatalog = {
      reconcile: vi.fn(() => catalog(entry)),
      get: vi.fn(() => entry)
    };
    const piResources = { list: () => [resource()], get: () => resource() };
    const prepareStart = vi.fn(async ({ exportId }: { readonly exportId: string }) => ({ value: { ...pendingJob, id: exportId } }));
    const prepareCancel = vi.fn(async () => ({ value: { ...pendingJob, state: "cancelled" } }));
    const completePreparedMutation = vi.fn(async (_prepared: unknown, completion: (finalize: (store: unknown) => void) => unknown) => completion(() => undefined));
    let finalAuthorityAssertion: (() => void | Promise<void>) | undefined;
    const begin = vi.fn((_: string, assertion: () => void | Promise<void>) => { finalAuthorityAssertion = assertion; });
    const abort = vi.fn();
    const extensionPackagePublisher = {
      recoveredFromCorruption: false,
      preview: vi.fn(() => ({
        ...authority,
        archiveFormat: "npm-tar-gzip",
        fileName: pendingJob.fileName,
        maximumEntries: 10_000,
        maximumUncompressedBytes: 256 * 1024 * 1024,
        localOnly: true
      })),
      list: vi.fn(() => [readyJob]),
      get: vi.fn(() => readyJob),
      prepareStart,
      prepareCancel,
      completePreparedMutation,
      begin,
      abort
    };
    const operations = new Map<string, OperationRecord<unknown>>();
    const store = {
      findOperation: (id: string) => operations.get(id),
      getOperation: (id: string) => operations.get(id),
      getBackend: () => backend
    };
    const services = createConnectServices(stubApplication({
      store,
      piResources,
      extensionCatalog,
      extensionPackagePublisher,
      sessionHost: replayingHost(store, operations)
    }));

    const preview = await invoke<contract.GetExtensionPackageExportPreviewResponse>(
      services.extension.getExtensionPackageExportPreview,
      { extensionId: entry.id, expectedRevision: { value: 7n } }
    );
    expect(preview.preview).toMatchObject({
      archiveFormat: "npm-tar-gzip",
      fileName: pendingJob.fileName,
      localOnly: true,
      authority: {
        extensionId: entry.id,
        resourceId: "resource-package",
        resourceRevision: { value: 5n },
        backendRevision: { value: 9n },
        backendGeneration: 3n,
        packageName: "@sample/exportable",
        packageVersion: "1.2.3"
      }
    });
    const listed = await invoke<contract.ListExtensionPackageExportsResponse>(services.extension.listExtensionPackageExports, {
      extensionId: entry.id,
      page: { pageSize: 10, pageToken: "" }
    });
    expect(listed.exports[0]).toMatchObject({
      exportId: readyJob.id,
      state: contract.ExtensionPackageExportState.READY,
      artifact: { blobId: "artifact-package", byteSize: 88n, mediaType: "application/gzip" }
    });
    const detail = await invoke<contract.GetExtensionPackageExportResponse>(services.extension.getExtensionPackageExport, {
      exportId: readyJob.id
    });
    expect(detail.export?.revision?.value).toBe(4n);

    const startValue = create(contract.StartExtensionPackageExportMutationSchema, {
      extensionId: entry.id,
      expectedExtensionRevision: { value: 7n },
      resourceId: "resource-package",
      expectedResourceRevision: { value: 5n },
      backendId: "pi",
      expectedBackendRevision: { value: 9n },
      expectedBackendGeneration: 3n
    });
    const startMutation = create(contract.OperationMutationSchema, { payload: {
      case: "startExtensionPackageExport",
      value: startValue
    } });
    await invoke(services.operation.submitOperation, {
      operationId: "extension-export",
      connectionId: connection.id,
      mutation: startMutation
    });
    expect(prepareStart).toHaveBeenCalledWith({ exportId: "extension-export", authority });
    expect(begin).toHaveBeenCalledOnce();
    await finalAuthorityAssertion?.();
    await invoke(services.operation.submitOperation, {
      operationId: "extension-export",
      connectionId: connection.id,
      mutation: startMutation
    });
    expect(prepareStart).toHaveBeenCalledOnce();
    expect(begin).toHaveBeenCalledOnce();

    resourceVersion = 6n;
    await expect(async () => {
      await finalAuthorityAssertion?.();
    }).rejects.toThrow(/current|changed/u);
    resourceVersion = 5n;
    const staleStart = create(contract.OperationMutationSchema, { payload: {
      case: "startExtensionPackageExport",
      value: create(contract.StartExtensionPackageExportMutationSchema, {
        ...startValue,
        expectedBackendRevision: create(contract.RevisionSchema, { value: 8n })
      })
    } });
    await expect(invoke(services.operation.submitOperation, {
      operationId: "extension-export-stale",
      connectionId: connection.id,
      mutation: staleStart
    })).rejects.toMatchObject({ code: Code.Aborted });

    const cancelMutation = create(contract.OperationMutationSchema, { payload: {
      case: "cancelExtensionPackageExport",
      value: { exportId: pendingJob.id, expectedRevision: { value: 1n } }
    } });
    await invoke(services.operation.submitOperation, {
      operationId: "extension-export-cancel",
      connectionId: connection.id,
      mutation: cancelMutation
    });
    expect(prepareCancel).toHaveBeenCalledWith(pendingJob.id, 1n);
    expect(abort).toHaveBeenCalledWith(pendingJob.id);
  });

  it("opens, probes, closes, and connection-revokes one exact Resource main-view surface", async () => {
    const discoveredRevision = `sha256:${"a".repeat(64)}`;
    const mainView = {
      html: "ui/review/index.html",
      title: "Review",
      icon: "layout" as const,
      extensionEntry: "extensions/review.ts"
    };
    const entry = extensionEntry({
      owner: { kind: "resource", resourceId: "resource-package", discoveredRevision, resourceVersion: 5n },
      mainView,
      library: { schemaVersion: 1, extensionEntry: "extensions/review.ts" },
      sidebarSupported: true
    });
    const resource = {
      id: "resource-package",
      backendId: "pi",
      kind: "package" as const,
      scope: "managed" as const,
      name: "@sample/review",
      version: "1.0.0",
      sourceKind: "local" as const,
      sourceIdentity: "local-review",
      sourceDisplay: "Review package",
      canonicalPathFingerprint: `sha256:${"b".repeat(64)}`,
      symbolicLinkDetected: false,
      specialFileDetected: false,
      discoveredRevision,
      packageIdentity: "@sample/review",
      resourceDetails: [{
        kind: "extension" as const,
        name: "review.ts",
        entryPath: "extensions/review.ts",
        mainView: { html: mainView.html, title: mainView.title, icon: mainView.icon },
        library: { schemaVersion: 1 },
        compatibility: "supported" as const,
        compatibilityIssues: [] as const,
        detectedApis: [] as const,
        adaptedApis: [] as const,
        unsupportedApis: [] as const
      }],
      runtimeRequirements: [],
      warnings: [],
      disabledLifecycleScripts: [],
      canToggle: true,
      requiresExtensionApproval: false,
      postMutationNotice: false,
      state: "loaded" as const,
      enabled: true,
      versionNumber: 5n,
      updatedAt: 1
    };
    let backendGeneration = 3;
    const backend = () => ({ revision: 9n, descriptor: { id: "pi", instanceGeneration: backendGeneration } });
    const authority = {
      extensionId: entry.id,
      resourceId: resource.id,
      backendId: "pi",
      backendRevision: 9n,
      backendGeneration: 3,
      resourceRevision: 5n,
      discoveredRevision,
      packageName: "@sample/review",
      packageVersion: "1.0.0",
      extensionEntry: "extensions/review.ts",
      mainView: { html: mainView.html, title: mainView.title, icon: mainView.icon },
      library: { schemaVersion: 1 }
    };
    const nativeSurface = {
      id: `extension_surface_${"c".repeat(32)}`,
      extensionId: entry.id,
      authority,
      endpoint: `/v1/extensions/main-views/extension_surface_${"c".repeat(32)}/${"d".repeat(64)}/index.html`,
      title: "Review",
      icon: "layout" as const,
      expiresAt: 1_800_000_060_000
    };
    let finalAuthorityFence: (() => void | Promise<void>) | undefined;
    const open = vi.fn(async (input: { readonly assertAuthorityCurrent: () => void | Promise<void> }) => {
      finalAuthorityFence = input.assertAuthorityCurrent;
      return nativeSurface;
    });
    const getSurface = vi.fn(async () => nativeSurface);
    const closeSurface = vi.fn(async () => true);
    const closeConnection = vi.fn(async () => undefined);
    let revoked: (() => void) | undefined;
    const stopRevocation = vi.fn();
    const fence = vi.fn();
    const services = createConnectServices(stubApplication({
      store: { getBackend: backend },
      connections: {
        authenticate: () => connection,
        fence,
        onRevoked: (_connectionId: string, listener: () => void) => { revoked = listener; return stopRevocation; }
      },
      piResources: { list: () => [resource], get: () => resource },
      extensionCatalog: { reconcile: () => catalog(entry), get: () => entry },
      extensionMainViews: { open, getSurface, closeSurface, closeConnection },
      sessionHost: {}
    }));

    const opened = await invoke<contract.OpenExtensionMainViewResponse>(services.extension.openExtensionMainView, {
      extensionId: entry.id,
      expectedRevision: { value: entry.revision }
    });
    expect(opened.surface).toMatchObject({
      surfaceId: nativeSurface.id,
      extensionId: entry.id,
      endpoint: nativeSurface.endpoint,
      title: "Review",
      icon: contract.ExtensionMainViewIcon.LAYOUT,
      owner: { resourceId: resource.id, resourceVersion: { value: 5n }, discoveredRevision },
      backendId: "pi",
      backendRevision: { value: 9n },
      backendGeneration: 3n
    });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ authority, connectionId: connection.id }));
    await finalAuthorityFence?.();
    expect(fence).toHaveBeenCalledWith(connection);
    backendGeneration += 1;
    await expect(Promise.resolve().then(() => finalAuthorityFence?.())).rejects.toThrow(/authority changed/u);

    const probed = await invoke<contract.GetExtensionMainViewSurfaceResponse>(services.extension.getExtensionMainViewSurface, {
      surfaceId: nativeSurface.id
    });
    expect(probed.surface?.surfaceId).toBe(nativeSurface.id);
    const closed = await invoke<contract.CloseExtensionMainViewResponse>(services.extension.closeExtensionMainView, {
      surfaceId: nativeSurface.id
    });
    expect(closed.closed).toBe(true);
    expect(getSurface).toHaveBeenCalledWith(nativeSurface.id, connection.id);
    expect(closeSurface).toHaveBeenCalledWith(nativeSurface.id, connection.id);
    revoked?.();
    await vi.waitFor(() => expect(closeConnection).toHaveBeenCalledWith(connection.id));
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

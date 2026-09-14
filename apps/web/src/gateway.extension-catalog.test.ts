import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  CredentialKind,
  ExtensionCatalogSource,
  ExtensionInstallState,
  ExtensionLibraryEntryKind,
  ExtensionLibraryLocationKind,
  ExtensionLibraryState,
  ExtensionMainViewIcon,
  ExtensionPackageAction,
  ExtensionPackageExportState,
  ExtensionSourceKind,
  ExtensionSourceState,
  ExtensionSetupState,
  OperationState,
  ResourceCompatibility,
  ResourceKind,
  ResourcePackageWarning,
  ResourceRuntimeRequirementStatus,
  ResourceUiApi
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Extension catalog gateway", () => {
  it("restarts pagination after a revision change and returns one complete exact catalog", async () => {
    const requests: Array<{ readonly method: string; readonly input: any }> = [];
    let listCall = 0;
    const gateway = await mount(async (method, input) => {
      requests.push({ method, input });
      if (method === "getSnapshot") return { snapshot: {} };
      if (method !== "listExtensions") throw new Error(`Unexpected method: ${method}`);
      listCall += 1;
      const secondPage = input.page?.pageToken === "next";
      const retry = listCall > 2;
      return {
        extensions: [protoExtension(secondPage ? 2 : 1)],
        catalogRevision: { value: retry ? 9n : secondPage ? 8n : 7n },
        recoveredFromCorruption: false,
        page: { totalSize: 2n, nextPageToken: secondPage ? "" : "next" }
      };
    });

    const result = await gateway.listExtensions({
      source: "local",
      installed: true,
      query: "review",
      sessionId: "runtime-session"
    });

    expect(result.revision).toBe(9n);
    expect(result.extensions.map((entry) => entry.id)).toEqual([
      "extension_00000000000000000000000000000001",
      "extension_00000000000000000000000000000002"
    ]);
    expect(requests.filter((request) => request.method === "listExtensions")).toHaveLength(4);
    expect(requests.find((request) => request.method === "listExtensions")?.input).toMatchObject({
      source: ExtensionCatalogSource.LOCAL,
      installed: true,
      query: "review",
      sessionId: "runtime-session",
      page: { pageSize: 500, pageToken: "" }
    });
    gateway.disconnect();
  });

  it("keeps every setup mutation revision-fenced and uploads a secret only through its one-shot ticket", async () => {
    const requests: Array<{ readonly method: string; readonly input: any }> = [];
    const uploaded: string[] = [];
    const buffers: Uint8Array[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const bytes = init.body as Uint8Array;
      uploaded.push(new TextDecoder().decode(bytes));
      buffers.push(bytes);
      return new Response(undefined, { status: 204 });
    }));
    const gateway = await mount(async (method, input) => {
      requests.push({ method, input });
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "beginExtensionSetupCredentialUpload") return {
        ticket: {
          ticketId: "credential-ticket-1",
          relativeEndpoint: "/v1/credentials/upload/credential-ticket-1",
          maximumBytes: 1_024n
        }
      };
      if (method === "submitOperation") return {
        operation: {
          operationId: input.operationId,
          connectionId: input.connectionId,
          state: OperationState.SUCCEEDED,
          result: { payload: { case: "acknowledgement", value: { accepted: true } } }
        }
      };
      throw new Error(`Unexpected method: ${method}`);
    });
    const id = "extension_00000000000000000000000000000001";

    await gateway.setExtensionEnabled(id, false, 3n);
    await gateway.setExtensionSidebarVisible(id, true, 4n);
    await gateway.beginExtensionSetup(id, 5n);
    await gateway.submitExtensionSetupInteraction(id, "attempt-1", "region", "east", 6n);
    await gateway.submitExtensionSetupInteraction(id, "attempt-1", "confirm", true, 7n);
    await gateway.saveExtensionSetupCredential(id, "attempt-1", "token", "headerSecret", "extension-test-secret", 8n);
    await gateway.completeExtensionSetup(id, "attempt-1", 9n);
    await gateway.cancelExtensionSetup(id, "attempt-2", 10n);
    await gateway.revokeExtensionSetup(id, 11n);

    const payloads = requests.filter((request) => request.method === "submitOperation")
      .map((request) => request.input.mutation.payload);
    expect(payloads.map((payload) => payload.case)).toEqual([
      "setExtensionEnabled",
      "setExtensionSidebarVisible",
      "beginExtensionSetup",
      "submitExtensionSetupInteraction",
      "submitExtensionSetupInteraction",
      "commitExtensionSetupCredential",
      "completeExtensionSetup",
      "cancelExtensionSetup",
      "revokeExtensionSetup"
    ]);
    expect(payloads.map((payload) => payload.value.expectedRevision.value)).toEqual([3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n]);
    expect(payloads[3]?.value.value).toEqual({ case: "text", value: "east" });
    expect(payloads[4]?.value.value).toEqual({ case: "confirmed", value: true });
    expect(payloads[5]?.value).toMatchObject({ credentialUploadTicketId: "credential-ticket-1" });
    expect(requests.find((request) => request.method === "beginExtensionSetupCredentialUpload")?.input).toMatchObject({
      extensionId: id,
      attemptId: "attempt-1",
      fieldId: "token",
      kind: CredentialKind.HEADER_SECRET
    });
    expect(uploaded).toEqual(["extension-test-secret"]);
    expect(buffers[0]?.every((byte) => byte === 0)).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://orchestrator.example/v1/credentials/upload/credential-ticket-1",
      expect.objectContaining({
        method: "PUT",
        headers: { authorization: "Bearer auth-key", "content-type": "application/octet-stream" }
      })
    );
    expect(JSON.stringify(requests, (_key, value: unknown) => typeof value === "bigint" ? value.toString(10) : value)).not.toContain("extension-test-secret");
    gateway.disconnect();
  });

  it("fails closed when the service returns an unknown catalog enum", async () => {
    const gateway = await mount(async (method) => {
      if (method === "getSnapshot") return { snapshot: {} };
      if (method !== "listExtensions") throw new Error(`Unexpected method: ${method}`);
      return {
        extensions: [{ ...protoExtension(1), installState: 99 }],
        catalogRevision: { value: 1n },
        recoveredFromCorruption: false,
        page: { totalSize: 1n, nextPageToken: "" }
      };
    });

    await expect(gateway.listExtensions()).rejects.toThrow("invalid Extension install state");
    gateway.disconnect();
  });

  it("maps exact package previews and revision-fences adopt and uninstall mutations", async () => {
    const requests: Array<{ readonly method: string; readonly input: any }> = [];
    const source = {
      sourceId: "extension_source_0123456789abcdef0123456789abcdef",
      sourceRevision: { value: 9n },
      entryId: "extension_source_entry_0123456789abcdef0123456789abcdef",
      contentRevision: `sha256:${"a".repeat(64)}`
    };
    const gateway = await mount(async (method, input) => {
      requests.push({ method, input });
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "listExtensions") return {
        extensions: [{
          ...protoExtension(1),
          installState: ExtensionInstallState.UPDATE_AVAILABLE,
          update: { source, availableVersion: "2.0.0", sourceReplacement: false }
        }],
        catalogRevision: { value: 12n },
        recoveredFromCorruption: false,
        page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "getExtensionPackagePreview") return {
        preview: {
          extensionId: "extension_00000000000000000000000000000001",
          extensionRevision: { value: 1n },
          action: ExtensionPackageAction.UPDATE,
          resourceId: "resource-1",
          backendId: "pi",
          packageName: "@sample/review",
          installedVersion: "1.0.0",
          availableVersion: "2.0.0",
          currentResource: { resourceId: "resource-1", resourceRevision: { value: 4n }, name: "@sample/review", sourceDisplay: "Review catalog" },
          sourceReplacement: false,
          preservesEnabled: true,
          compatibilityDetails: [{
            kind: ResourceKind.EXTENSION,
            name: "review",
            compatibility: ResourceCompatibility.PARTIAL,
            detectedApis: [ResourceUiApi.NOTIFY],
            adaptedApis: [ResourceUiApi.NOTIFY]
          }],
          runtimeRequirements: [{
            packageName: "@earendil-works/pi-coding-agent",
            range: "^0.84.0",
            currentVersion: "0.84.4",
            status: ResourceRuntimeRequirementStatus.COMPATIBLE
          }],
          warnings: [ResourcePackageWarning.LIFECYCLE_SCRIPTS_DISABLED],
          disabledLifecycleScripts: ["postinstall"],
          canToggle: true
        }
      };
      if (method === "submitOperation") return {
        operation: {
          operationId: input.operationId,
          connectionId: input.connectionId,
          state: OperationState.SUCCEEDED,
          result: { payload: { case: "acknowledgement", value: { accepted: true } } }
        }
      };
      throw new Error(`Unexpected method: ${method}`);
    });

    const catalog = await gateway.listExtensions();
    expect(catalog.extensions[0]?.update).toEqual({
      source: { kind: "source", sourceId: source.sourceId, sourceRevision: 9n, entryId: source.entryId, contentRevision: source.contentRevision },
      availableVersion: "2.0.0",
      sourceReplacement: false
    });
    const preview = await gateway.getExtensionPackagePreview(catalog.extensions[0]!.id, 1n, "pi");
    expect(preview).toMatchObject({
      action: "update",
      resourceId: "resource-1",
      backendId: "pi",
      installedVersion: "1.0.0",
      availableVersion: "2.0.0",
      preservesEnabled: true,
      currentResource: { resourceId: "resource-1", resourceRevision: 4n },
      compatibilityDetails: [{ kind: "extension", compatibility: "partial", detectedApis: ["notify"] }],
      runtimeRequirements: [{ status: "compatible" }],
      warnings: ["lifecycleScriptsDisabled"],
      disabledLifecycleScripts: ["postinstall"]
    });
    await gateway.adoptExtensionPackage(preview);
    await gateway.removeExtensionPackage(preview.extensionId, 2n);

    expect(requests.find((request) => request.method === "getExtensionPackagePreview")?.input).toMatchObject({
      extensionId: preview.extensionId,
      expectedRevision: { value: 1n },
      backendId: "pi"
    });
    const payloads = requests.filter((request) => request.method === "submitOperation").map((request) => request.input.mutation.payload);
    expect(payloads.map((payload) => payload.case)).toEqual(["adoptExtensionPackage", "removeExtensionPackage"]);
    expect(payloads[0]?.value).toMatchObject({
      extensionId: preview.extensionId,
      expectedRevision: { value: 1n },
      backendId: "pi",
      expectedAction: ExtensionPackageAction.UPDATE,
      expectedCurrentResourceId: "resource-1",
      expectedCurrentResourceRevision: { value: 4n },
      allowSourceReplacement: false
    });
    expect(payloads[1]?.value).toMatchObject({ extensionId: preview.extensionId, expectedRevision: { value: 2n } });
    gateway.disconnect();
  });

  it("opens, probes, and closes only a strict opaque Extension main-view surface", async () => {
    const requests: Array<{ readonly method: string; readonly input: any }> = [];
    const extensionId = "extension_00000000000000000000000000000001";
    const surfaceId = `extension_surface_${"a".repeat(32)}`;
    const surface = {
      surfaceId,
      extensionId,
      owner: {
        resourceId: "resource-1",
        discoveredRevision: `sha256:${"b".repeat(64)}`,
        resourceVersion: { value: 4n }
      },
      endpoint: `/v1/extensions/main-views/${surfaceId}/${"c".repeat(64)}/index.html`,
      title: "Review",
      icon: ExtensionMainViewIcon.LAYOUT,
      expiresAt: { seconds: 1_800_000_000n, nanos: 0 },
      backendId: "pi",
      backendRevision: { value: 9n },
      backendGeneration: 3n
    };
    const gateway = await mount(async (method, input) => {
      requests.push({ method, input });
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "openExtensionMainView") return { surface };
      if (method === "getExtensionMainViewSurface") return { surface };
      if (method === "closeExtensionMainView") return { closed: true };
      throw new Error(`Unexpected method: ${method}`);
    });

    await expect(gateway.openExtensionMainView(extensionId, 7n)).resolves.toMatchObject({
      id: surfaceId,
      extensionId,
      owner: { kind: "resource", resourceId: "resource-1", resourceRevision: 4n },
      endpoint: surface.endpoint,
      title: "Review",
      icon: "layout",
      backendId: "pi",
      backendRevision: 9n,
      backendGeneration: 3
    });
    await expect(gateway.getExtensionMainViewSurface(surfaceId)).resolves.toMatchObject({ id: surfaceId });
    await expect(gateway.closeExtensionMainView(surfaceId)).resolves.toBe(true);
    expect(requests.find((request) => request.method === "openExtensionMainView")?.input)
      .toEqual({ extensionId, expectedRevision: { value: 7n } });

    surface.endpoint = "https://attacker.test/view.html";
    await expect(gateway.getExtensionMainViewSurface(surfaceId)).rejects.toThrow(/invalid Extension main-view surface/u);
    gateway.disconnect();
  });

  it("maps every Extension Library management and sandbox call without exposing a root to the session", async () => {
    const requests: Array<{ readonly method: string; readonly input: any }> = [];
    const extensionId = "extension_00000000000000000000000000000001";
    const location = { kind: ExtensionLibraryLocationKind.CUSTOM, path: "D:\\Libraries\\canvas", generation: { value: 4n } };
    const overview = {
      extensionId,
      name: "Canvas",
      state: ExtensionLibraryState.READY,
      location,
      files: 2,
      bytes: 9n,
      diskFreeBytes: 100n,
      softLimitBytes: 8_589_934_592n,
      softLimitExceeded: false,
      orphaned: false,
      trashCount: 1,
      graceCount: 1
    };
    const trash = {
      trashId: `library_trash_${"a".repeat(32)}`,
      extensionId,
      name: "Canvas",
      deletedAt: { seconds: 1_800_000_000n, nanos: 0 },
      expiresAt: { seconds: 1_802_592_000n, nanos: 0 },
      files: 2,
      bytes: 9n
    };
    const grace = {
      graceId: `library_grace_${"b".repeat(32)}`,
      extensionId,
      name: "Canvas",
      createdAt: { seconds: 1_800_000_000n, nanos: 0 },
      expiresAt: { seconds: 1_801_209_600n, nanos: 0 },
      files: 2,
      bytes: 9n
    };
    const sessionId = `library_session_${"c".repeat(32)}`;
    let invalidOverview = false;
    const gateway = await mount(async (method, input) => {
      requests.push({ method, input });
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "getExtensionLibraryOverview") return { library: { ...overview, state: invalidOverview ? 99 : overview.state } };
      if (method === "validateExtensionLibraryLocation") return { validation: { libraryRoot: location.path, warnings: ["cloud_sync_location"], diskFreeBytes: 100n } };
      if (method === "relocateExtensionLibrary") return { changed: true, migrationId: "migration", location, files: 2, bytes: 9n, warnings: [], graceId: grace.graceId };
      if (method === "rebindExtensionLibrary") return { location, warnings: [] };
      if (method === "unbindExtensionLibrary") return { detachedPath: location.path };
      if (method === "repairExtensionLibraryState") return { recoveredFromPrevious: true, bindings: 1, trash: 1 };
      if (method === "repairExtensionLibraryMetadata") return { library: overview };
      if (method === "trashExtensionLibrary") return { trash };
      if (method === "listExtensionLibraryTrash") return { trash: [trash] };
      if (method === "restoreExtensionLibraryTrash") return { extensionId, location };
      if (method === "purgeExtensionLibraryTrash") return { purged: true };
      if (method === "listExtensionLibraryGrace") return { grace: [grace] };
      if (method === "rollbackExtensionLibrary") return { location, graceId: grace.graceId };
      if (method === "purgeExpiredExtensionLibraries") return { trash: 1, grace: 2 };
      if (method === "openExtensionLibrary") return {
        library: {
          sessionId,
          extensionId,
          expiresAt: { seconds: 1_800_000_000n, nanos: 0 },
          bindingGeneration: { value: 4n },
          limits: {
            maximumReadBytes: 16_777_216n,
            maximumWriteBytes: 16_777_216n,
            maximumStreamBytes: 8_589_934_592n,
            maximumPathCharacters: 512,
            maximumPathSegments: 32,
            maximumListPageSize: 500,
            maximumFiles: 50_000,
            softLimitBytes: 8_589_934_592n,
            diskReserveBytes: 1_073_741_824n
          }
        }
      };
      if (method === "callExtensionLibrary") {
        if (input.call.operation.case === "sqlExecute") return { result: { result: { case: "sqlResult", value: {
          rows: [{ cells: [
            { name: "id", value: { value: { case: "integerValue", value: "9" } } },
            { name: "data", value: { value: { case: "blobValue", value: new Uint8Array([1, 2]) } } }
          ] }],
          changes: "0"
        } } } };
        return { result: { result: { case: "write", value: {
          path: "notes/one.txt", bytes: 3n, sha256: "d".repeat(64)
        } } } };
      }
      if (method === "closeExtensionLibrary") return { closed: true };
      throw new Error(`Unexpected method: ${method}`);
    });

    await expect(gateway.getExtensionLibraryOverview(extensionId, 7n)).resolves.toMatchObject({
      extensionId,
      state: "ready",
      location: { kind: "custom", generation: 4n },
      bytes: 9n
    });
    await expect(gateway.validateExtensionLibraryLocation(extensionId, 7n, "D:\\Libraries")).resolves.toMatchObject({
      libraryRoot: location.path,
      warnings: ["cloud_sync_location"]
    });
    await gateway.relocateExtensionLibrary(extensionId, 7n, { kind: "custom", candidate: "D:\\Libraries" });
    await gateway.rebindExtensionLibrary(extensionId, 7n, "D:\\Libraries");
    await gateway.unbindExtensionLibrary(extensionId, 7n);
    await gateway.repairExtensionLibraryState();
    await gateway.repairExtensionLibraryMetadata(extensionId, 7n);
    await expect(gateway.trashExtensionLibrary(extensionId, 7n, "Canvas")).resolves.toMatchObject({ id: trash.trashId, bytes: 9n });
    await expect(gateway.listExtensionLibraryTrash(extensionId)).resolves.toHaveLength(1);
    await gateway.restoreExtensionLibraryTrash(trash.trashId, "Canvas", { kind: "custom", candidate: "D:\\Libraries" });
    await expect(gateway.purgeExtensionLibraryTrash(trash.trashId, "Canvas")).resolves.toBe(true);
    await expect(gateway.listExtensionLibraryGrace(extensionId)).resolves.toMatchObject([{ id: grace.graceId }]);
    await gateway.rollbackExtensionLibrary(extensionId, 7n, grace.graceId);
    await expect(gateway.purgeExpiredExtensionLibraries()).resolves.toEqual({ trash: 1, grace: 2 });
    const opened = await gateway.openExtensionLibrary(extensionId, 7n);
    expect(opened).toMatchObject({ id: sessionId, bindingGeneration: 4n, limits: { maximumFiles: 50_000 } });
    expect(opened).not.toHaveProperty("path");
    await expect(gateway.callExtensionLibrary(sessionId, {
      kind: "write",
      path: "notes/one.txt",
      content: new Uint8Array([1, 2, 3]),
      ifNotExists: true
    })).resolves.toMatchObject({ kind: "write", path: "notes/one.txt", bytes: 3n });
    await expect(gateway.callExtensionLibrary(sessionId, {
      kind: "sqlExecute",
      handleId: "handle-1",
      statement: {
        sql: "SELECT ?, ?",
        parameters: [{ kind: "integer", value: 9n }, { kind: "blob", value: new Uint8Array([1, 2]) }]
      }
    })).resolves.toMatchObject({
      kind: "sqlResult",
      value: { rows: [{ cells: [
        { name: "id", value: { kind: "integer", value: 9n } },
        { name: "data", value: { kind: "blob", value: new Uint8Array([1, 2]) } }
      ] }] }
    });
    await expect(gateway.closeExtensionLibrary(sessionId)).resolves.toBe(true);

    expect(requests.find((request) => request.method === "relocateExtensionLibrary")?.input).toMatchObject({
      extensionId,
      expectedRevision: { value: 7n },
      destinationKind: ExtensionLibraryLocationKind.CUSTOM,
      candidate: "D:\\Libraries"
    });
    const sqlRequest = requests.filter((request) => request.method === "callExtensionLibrary")[1]?.input;
    expect(sqlRequest.call.operation).toMatchObject({
      case: "sqlExecute",
      value: { statement: { parameters: [
        { value: { case: "integerValue", value: "9" } },
        { value: { case: "blobValue", value: new Uint8Array([1, 2]) } }
      ] } }
    });

    invalidOverview = true;
    await expect(gateway.getExtensionLibraryOverview(extensionId, 7n)).rejects.toThrow(/invalid Extension Library state/u);
    gateway.disconnect();
  });

  it("fails closed when a package preview carries an unknown current-v1 enum", async () => {
    let invalid: "action" | "warning" | "ui" = "action";
    const gateway = await mount(async (method) => {
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "getExtensionPackagePreview") return {
        preview: {
          extensionId: "extension_00000000000000000000000000000001",
          extensionRevision: { value: 1n },
          action: invalid === "action" ? 99 : ExtensionPackageAction.INSTALL,
          resourceId: "resource-1",
          backendId: "pi",
          packageName: "@sample/review",
          compatibilityDetails: invalid === "ui" ? [{
            kind: ResourceKind.EXTENSION,
            name: "review",
            compatibility: ResourceCompatibility.SUPPORTED,
            detectedApis: [99]
          }] : [],
          warnings: invalid === "warning" ? [99] : []
        }
      };
      throw new Error(`Unexpected method: ${method}`);
    });

    await expect(gateway.getExtensionPackagePreview("extension_00000000000000000000000000000001", 1n, "pi"))
      .rejects.toThrow("invalid Extension package action");
    invalid = "warning";
    await expect(gateway.getExtensionPackagePreview("extension_00000000000000000000000000000001", 1n, "pi"))
      .rejects.toThrow("invalid package warning");
    invalid = "ui";
    await expect(gateway.getExtensionPackagePreview("extension_00000000000000000000000000000001", 1n, "pi"))
      .rejects.toThrow("invalid package UI API");
    gateway.disconnect();
  });

  it("maps local package export state and revision-fences start, polling, and cancellation", async () => {
    const requests: Array<{ readonly method: string; readonly input: any }> = [];
    const extensionId = "extension_00000000000000000000000000000001";
    const authority = {
      extensionId,
      extensionRevision: { value: 7n },
      resourceId: "resource-package",
      resourceRevision: { value: 5n },
      discoveredRevision: `sha256:${"b".repeat(64)}`,
      backendId: "pi",
      backendRevision: { value: 9n },
      backendGeneration: 3n,
      packageName: "@sample/exportable",
      packageVersion: "1.2.3"
    };
    let cancelled = false;
    let invalidPreview = false;
    const exportJob = (exportId: string, state: ExtensionPackageExportState) => ({
      exportId,
      revision: { value: state === ExtensionPackageExportState.CANCELLED ? 2n : 1n },
      state,
      authority,
      archiveFormat: "npm-tar-gzip",
      fileName: "sample-exportable-1.2.3.tgz",
      files: state === ExtensionPackageExportState.PENDING ? 0 : 4,
      uncompressedBytes: state === ExtensionPackageExportState.PENDING ? 0n : 5_632n,
      ...(state === ExtensionPackageExportState.READY ? {
        artifact: {
          blobId: "export-artifact",
          fileName: "sample-exportable-1.2.3.tgz",
          mediaType: "application/gzip",
          byteSize: 2_048n,
          sha256Hex: "c".repeat(64)
        }
      } : {}),
      createdAt: { seconds: 1_700_000_000n, nanos: 0 },
      updatedAt: { seconds: 1_700_000_001n, nanos: 0 },
      ...([ExtensionPackageExportState.READY, ExtensionPackageExportState.CANCELLED].includes(state)
        ? { completedAt: { seconds: 1_700_000_001n, nanos: 0 } }
        : {})
    });
    const gateway = await mount(async (method, input) => {
      requests.push({ method, input });
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "getExtensionPackageExportPreview") return {
        preview: {
          authority,
          archiveFormat: "npm-tar-gzip",
          fileName: "sample-exportable-1.2.3.tgz",
          maximumEntries: 10_000,
          maximumUncompressedBytes: 67_108_864n,
          localOnly: !invalidPreview
        },
        recoveredFromCorruption: false
      };
      if (method === "listExtensionPackageExports") return {
        exports: [exportJob("ready-export", ExtensionPackageExportState.READY)],
        recoveredFromCorruption: false,
        page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "submitOperation") {
        if (input.mutation.payload.case === "cancelExtensionPackageExport") cancelled = true;
        return {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "acknowledgement", value: { accepted: true } } }
          }
        };
      }
      if (method === "getExtensionPackageExport") return {
        export: exportJob(input.exportId, cancelled ? ExtensionPackageExportState.CANCELLED : ExtensionPackageExportState.PENDING),
        recoveredFromCorruption: false
      };
      throw new Error(`Unexpected method: ${method}`);
    });

    const preview = await gateway.getExtensionPackageExportPreview(extensionId, 7n);
    expect(preview).toMatchObject({
      extensionId,
      extensionRevision: 7n,
      resourceId: "resource-package",
      resourceRevision: 5n,
      backendRevision: 9n,
      backendGeneration: 3,
      localOnly: true,
      maximumUncompressedBytes: 67_108_864
    });
    const catalog = await gateway.listExtensionPackageExports(extensionId);
    expect(catalog.exports[0]).toMatchObject({
      id: "ready-export",
      state: "ready",
      artifact: { blobId: "export-artifact", byteSize: 2_048, mediaType: "application/gzip" }
    });
    const pending = await gateway.startExtensionPackageExport(preview);
    expect(pending.state).toBe("pending");
    const cancelledJob = await gateway.cancelExtensionPackageExport(pending.id, pending.revision);
    expect(cancelledJob).toMatchObject({ id: pending.id, revision: 2n, state: "cancelled" });

    const payloads = requests.filter((request) => request.method === "submitOperation")
      .map((request) => request.input.mutation.payload);
    expect(payloads[0]).toMatchObject({
      case: "startExtensionPackageExport",
      value: {
        extensionId,
        expectedExtensionRevision: { value: 7n },
        resourceId: "resource-package",
        expectedResourceRevision: { value: 5n },
        backendId: "pi",
        expectedBackendRevision: { value: 9n },
        expectedBackendGeneration: 3n
      }
    });
    expect(payloads[1]).toMatchObject({
      case: "cancelExtensionPackageExport",
      value: { exportId: pending.id, expectedRevision: { value: 1n } }
    });
    invalidPreview = true;
    await expect(gateway.getExtensionPackageExportPreview(extensionId, 7n)).rejects.toThrow("invalid Extension package export preview");
    gateway.disconnect();
  });

  it("maps exact source descriptors and revision-fences every source mutation", async () => {
    const requests: Array<{ readonly method: string; readonly input: any }> = [];
    const gateway = await mount(async (method, input) => {
      requests.push({ method, input });
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "getExtensionSourceGitPreflight") return {
        preflight: { available: true, version: "2.51.0", minimumVersion: "2.25.0" }
      };
      if (method === "listExtensionSources") return {
        sources: [{
          sourceId: "extension_source_0123456789abcdef0123456789abcdef",
          revision: { value: 7n },
          kind: ExtensionSourceKind.GIT,
          location: { kind: { case: "git", value: { repositoryUrl: "https://example.com/extensions.git", ref: "main", sparsePaths: ["packages/review"] } } },
          name: "review-catalog",
          displayName: "Review catalog",
          state: ExtensionSourceState.READY,
          contentRevision: `sha256:${"a".repeat(64)}`,
          discoveredExtensionCount: 2,
          declaredEntryCount: 3,
          skippedEntryCount: 1,
          unreadableEntryCount: 0,
          addedAt: { seconds: 1_700_000_000n, nanos: 0 },
          refreshedAt: { seconds: 1_700_000_100n, nanos: 0 }
        }],
        catalogRevision: { value: 9n },
        recoveredFromCorruption: false,
        page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "submitOperation") return {
        operation: {
          operationId: input.operationId,
          connectionId: input.connectionId,
          state: OperationState.SUCCEEDED,
          result: { payload: { case: "acknowledgement", value: { accepted: true } } }
        }
      };
      throw new Error(`Unexpected method: ${method}`);
    });

    await expect(gateway.getExtensionSourceGitPreflight()).resolves.toEqual({ available: true, version: "2.51.0", minimumVersion: "2.25.0" });
    await expect(gateway.listExtensionSources()).resolves.toMatchObject({
      revision: 9n,
      sources: [{
        id: "extension_source_0123456789abcdef0123456789abcdef",
        revision: 7n,
        kind: "git",
        location: { kind: "git", repositoryUrl: "https://example.com/extensions.git", ref: "main", sparsePaths: ["packages/review"] },
        state: "ready",
        addedAt: 1_700_000_000_000,
        refreshedAt: 1_700_000_100_000
      }]
    });
    await gateway.addExtensionSource({ kind: "git", repositoryUrl: "git@example.com:team/extensions.git", ref: "v1", sparsePaths: ["tools"] }, 9n);
    await gateway.refreshExtensionSource("extension_source_0123456789abcdef0123456789abcdef", 7n);
    await gateway.removeExtensionSource("extension_source_0123456789abcdef0123456789abcdef", 8n);

    const payloads = requests.filter((request) => request.method === "submitOperation").map((request) => request.input.mutation.payload);
    expect(payloads.map((payload) => payload.case)).toEqual(["addExtensionSource", "refreshExtensionSource", "removeExtensionSource"]);
    expect(payloads[0]?.value).toMatchObject({
      source: { kind: { case: "git", value: { repositoryUrl: "git@example.com:team/extensions.git", ref: "v1", sparsePaths: ["tools"] } } },
      expectedCatalogRevision: { value: 9n }
    });
    expect(payloads[1]?.value).toMatchObject({ expectedRevision: { value: 7n } });
    expect(payloads[2]?.value).toMatchObject({ expectedRevision: { value: 8n } });
    gateway.disconnect();
  });
});

async function mount(handler: (method: string, input: any) => Promise<object>): Promise<ReturnType<typeof createOrchestratorGateway>> {
  const transport = {
    unary: vi.fn(async (method: any, _signal: AbortSignal | undefined, _timeout: unknown, _headers: Headers, input: any) =>
      response(method, create(method.output, await handler(method.localName, input)))),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
  const gateway = createOrchestratorGateway(
    { id: "connection", deviceId: "device", name: "Desktop", origin: "https://orchestrator.example", serverId: "server" },
    "auth-key",
    {},
    () => transport
  );
  await gateway.connect();
  return gateway;
}

function protoExtension(index: number): object {
  return {
    extensionId: `extension_${index.toString(16).padStart(32, "0")}`,
    revision: { value: BigInt(index) },
    owner: {
      kind: {
        case: "resource",
        value: {
          resourceId: `resource-${index}`,
          discoveredRevision: `sha256:${index}`,
          resourceVersion: { value: BigInt(index) }
        }
      }
    },
    source: ExtensionCatalogSource.LOCAL,
    installed: true,
    installState: ExtensionInstallState.INSTALLED,
    name: `Review ${index}`,
    description: "Review changes",
    enabled: true,
    sidebarSupported: true,
    sidebarVisible: true,
    mainView: { title: `Review ${index}`, icon: ExtensionMainViewIcon.LAYOUT },
    commands: [{ name: "review", description: "Review changes", sessionId: "runtime-session" }],
    setup: { state: ExtensionSetupState.NOT_REQUIRED, revision: { value: 0n } },
    useSupported: true
  };
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}

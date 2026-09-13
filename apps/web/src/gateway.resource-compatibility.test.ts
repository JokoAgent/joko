import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  ListManagedModelRuntimesResponseSchema,
  ManagedResourceSchema,
  OperationState,
  ResourceCompatibility,
  ResourceCompatibilityDetailSchema,
  ResourceCompatibilityIssue,
  ResourceKind,
  ResourcePackageWarning,
  ResourceRuntimeRequirementSchema,
  ResourceRuntimeRequirementStatus,
  ResourceScope,
  ResourceSourceSchema,
  ResourceState,
  ResourceUiApi,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway, mapSnapshot } from "./gateway.js";

describe("resource compatibility projection", () => {
  it("maps theme, compatibility, runtime, warning, approval, and notice fields without runtime identity branches", () => {
    const projected = mapSnapshot(create(SnapshotSchema, { resources: [managedResource()] }));

    expect(projected.resources).toEqual([expect.objectContaining({
      id: "package-1",
      kind: "theme",
      version: "2.0.0",
      state: "awaitingApproval",
      compatibilityDetails: [{
        kind: "extension",
        name: "entry.ts",
        compatibility: "partial",
        issues: ["terminalLayout", "analysisIncomplete"],
        detectedApis: ["select", "setFooter"],
        adaptedApis: ["select"],
        unsupportedApis: ["setFooter"]
      }],
      runtimeRequirements: [{
        packageName: "@runtime/core",
        range: "^0.8.0",
        currentVersion: "1.1.0",
        status: "incompatible"
      }],
      warnings: ["lifecycleScriptsDisabled"],
      disabledLifecycleScripts: ["prepare"],
      canToggle: false,
      requiresExtensionApproval: true,
      extensionContentFingerprint: "sha256:content-v2",
      postMutationNotice: true
    })]);
  });

  it("returns the typed post-install and post-update resource projection", async () => {
    const submitted: string[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => operationTransport(submitted)
    );
    await gateway.connect();

    const installed = await gateway.installResource("package-1");
    const updated = await gateway.updateResource("package-1");

    expect(submitted).toEqual(["installResource", "updateResource"]);
    expect(installed.postMutationNotice).toBe(true);
    expect(updated.requiresExtensionApproval).toBe(true);
    expect(updated.compatibilityDetails[0]?.unsupportedApis).toEqual(["setFooter"]);
    gateway.disconnect();
  });
});

function managedResource() {
  return create(ManagedResourceSchema, {
    resourceId: "package-1",
    backendId: "runtime-capability",
    targetId: "",
    kind: ResourceKind.THEME,
    name: "Portable package",
    version: "2.0.0",
    source: create(ResourceSourceSchema, {
      scope: ResourceScope.GLOBAL,
      sourceDisplay: "registry:portable-package"
    }),
    state: ResourceState.AWAITING_APPROVAL,
    enabled: false,
    discoveredRevision: "tree:v2",
    compatibilityDetails: [create(ResourceCompatibilityDetailSchema, {
      kind: ResourceKind.EXTENSION,
      name: "entry.ts",
      compatibility: ResourceCompatibility.PARTIAL,
      issues: [ResourceCompatibilityIssue.TUI_LAYOUT, ResourceCompatibilityIssue.ANALYSIS_INCOMPLETE],
      detectedApis: [ResourceUiApi.SELECT, ResourceUiApi.SET_FOOTER],
      adaptedApis: [ResourceUiApi.SELECT],
      unsupportedApis: [ResourceUiApi.SET_FOOTER]
    })],
    runtimeRequirements: [create(ResourceRuntimeRequirementSchema, {
      packageName: "@runtime/core",
      range: "^0.8.0",
      currentVersion: "1.1.0",
      status: ResourceRuntimeRequirementStatus.INCOMPATIBLE
    })],
    warnings: [ResourcePackageWarning.LIFECYCLE_SCRIPTS_DISABLED],
    disabledLifecycleScripts: ["prepare"],
    canToggle: false,
    requiresExtensionApproval: true,
    extensionContentFingerprint: "sha256:content-v2",
    postMutationNotice: true
  });
}

function operationTransport(submitted: string[]): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
        }));
      }
      if (method.localName === "listManagedModelRuntimes") {
        return response(method, create(ListManagedModelRuntimesResponseSchema, {}));
      }
      if (method.localName === "submitOperation") {
        submitted.push(input.mutation.payload.case);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "resource", value: managedResource() } }
          }
        }));
      }
      throw new Error(`Unexpected method: ${method.localName}`);
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}

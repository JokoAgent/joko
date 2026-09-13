import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  CredentialKind,
  ExtensionCatalogSource,
  ExtensionInstallState,
  ExtensionSetupState,
  OperationState
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

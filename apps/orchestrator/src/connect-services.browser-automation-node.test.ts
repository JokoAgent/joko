import { createHash } from "node:crypto";

import { Code } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import {
  BROWSER_AUTOMATION_NODE_CAPABILITIES,
  type BrowserAutomationNodeExecutor
} from "./browser-automation-node.js";
import { createConnectServices } from "./connect-services.js";

const context = {
  requestHeader: new Headers({ authorization: "Bearer service-key" }),
  signal: new AbortController().signal
};

describe("Browser automation node Connect dispatch", () => {
  it("requires a service Device and exposes the exact generation/capability projection", async () => {
    const fixture = application();
    const services = createConnectServices(fixture.application);
    const list = services.browser.listBrowserAutomationNodes as unknown as (request: object, context: unknown) => {
      nodes: readonly { nodeId: string; generation: bigint; capabilities: readonly string[] }[];
    };
    const response = await list({}, context);
    expect(response.nodes).toHaveLength(1);
    expect(response.nodes[0]).toMatchObject({ nodeId: "node-local", generation: 41n });
    expect(response.nodes[0]?.capabilities).toContain("action:status");

    fixture.getDevice.mockReturnValueOnce({ state: "active", kind: "desktop" });
    expect(() => list({}, context)).toThrowError(expect.objectContaining({ code: Code.PermissionDenied }));
  });

  it("rechecks generation and capabilities before dispatch and returns a bounded binary envelope", async () => {
    const bytes = Uint8Array.from(Buffer.from("remote-image"));
    const execute = vi.fn(async () => ({
      ok: true,
      data: { targetId: "page-1" },
      binary: { bytes, mediaType: "image/png" as const }
    }));
    const fixture = application(execute);
    const services = createConnectServices(fixture.application);
    const call = services.browser.executeBrowserAutomationAction as unknown as (
      request: Record<string, unknown>, context: unknown
    ) => Promise<{
      ok: boolean;
      dataJson: string;
      binary?: { data: Uint8Array; byteSize: bigint; sha256Hex: string };
    }>;
    const response = await call({
      nodeId: "node-local",
      expectedGeneration: 41n,
      action: "status",
      argumentsJson: JSON.stringify({ action: "status" }),
      inputArtifacts: []
    }, context);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: "node-local",
      expectedGeneration: 41,
      action: "status",
      arguments: { action: "status" }
    }), context.signal);
    expect(JSON.parse(response.dataJson)).toEqual({ targetId: "page-1" });
    expect(response.binary?.data).toEqual(bytes);
    expect(response.binary?.byteSize).toBe(BigInt(bytes.byteLength));
    expect(response.binary?.sha256Hex).toBe(createHash("sha256").update(bytes).digest("hex"));

    await expect(call({
      nodeId: "node-local",
      expectedGeneration: 40n,
      action: "status",
      argumentsJson: JSON.stringify({ action: "status" }),
      inputArtifacts: []
    }, context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects an action not present in the server-side capability projection", async () => {
    const execute = vi.fn();
    const fixture = application(execute, new Set([...BROWSER_AUTOMATION_NODE_CAPABILITIES].filter((item) => item !== "action:navigate")));
    const services = createConnectServices(fixture.application);
    const call = services.browser.executeBrowserAutomationAction as unknown as (
      request: Record<string, unknown>, context: unknown
    ) => Promise<unknown>;
    await expect(call({
      nodeId: "node-local",
      expectedGeneration: 41n,
      action: "navigate",
      argumentsJson: JSON.stringify({ action: "navigate", url: "https://example.test" }),
      inputArtifacts: []
    }, context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(execute).not.toHaveBeenCalled();
  });
});

function application(
  execute = vi.fn(async () => ({ ok: true, data: {} })),
  capabilities = BROWSER_AUTOMATION_NODE_CAPABILITIES
): {
  readonly application: OrchestratorApplication;
  readonly getDevice: ReturnType<typeof vi.fn>;
} {
  const getDevice = vi.fn(() => ({ state: "active", kind: "service" }));
  const executor = {
    project: () => ({
      id: "node-local",
      displayName: "Local browser",
      available: true,
      generation: 41,
      capabilities
    }),
    execute
  } as unknown as BrowserAutomationNodeExecutor;
  const connection = {
    id: "connection-service",
    deviceId: "device-service",
    name: "Peer service",
    authKeyDigest: "digest",
    state: "active",
    pairedAt: 1,
    revision: 1n
  };
  return {
    getDevice,
    application: {
      config: { publicOrigin: "https://orchestrator.example.test" },
      store: { getDevice },
      connections: { authenticate: vi.fn(() => connection) },
      artifacts: {},
      blobTransfers: {},
      artifactRepository: {},
      workspaces: {},
      workspaceChanges: {},
      sessionHost: {},
      scheduler: {},
      adapters: [],
      browserAutomationNode: executor,
      browserActivity: [],
      close: async () => undefined
    } as unknown as OrchestratorApplication
  };
}

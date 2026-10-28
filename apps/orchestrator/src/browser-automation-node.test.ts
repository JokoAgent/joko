import { createHash } from "node:crypto";

import { create } from "@bufbuild/protobuf";
import {
  BrowserAutomationNodeSchema,
  ExecuteBrowserAutomationActionResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  AuthenticatedBrowserRemoteNodeRouter,
  BROWSER_AUTOMATION_NODE_CAPABILITIES,
  BrowserAutomationNodeExecutor,
  browserAutomationNodeCredentialProviderId,
  formatBrowserAutomationNodeCredential,
  parseBrowserAutomationNodeCredential,
  type BrowserAutomationNodeRpcClient
} from "./browser-automation-node.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { BrowserToolBridgeProvider } from "./browser-tool-bridge.js";
import type { CredentialManager } from "./credential-manager.js";
import type { LanDiscoveryService } from "./lan-discovery.js";

const endpointPublicKey = `ed25519:${"a".repeat(64)}`;
const nodeCredential = (origin = "http://192.168.1.20:4318") => formatBrowserAutomationNodeCredential({
  serverId: "node-peer", origin, endpointPublicKey, authKey: "service-auth-key"
});

describe("BrowserAutomationNodeExecutor", () => {
  it("checks screenshot bytes and canonical base64 before relaying image blocks", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    let image = { type: "image", mimeType: "image/png", data: png.toString("base64") };
    const executor = new BrowserAutomationNodeExecutor({ nodeId: "local", displayName: "Local", generation: 1,
      bridge: { available: true, callTool: vi.fn(async () => ({ content: [image],
        structuredContent: { ok: true, action: "screenshot", data: {} }, isError: false })) } as unknown as BrowserToolBridgeProvider,
      artifacts: artifactStore() as unknown as ArtifactStore });
    const capture = () => executor.execute({ nodeId: "local", expectedGeneration: 1, action: "screenshot", arguments: { action: "screenshot" } });
    await expect(capture()).resolves.toMatchObject({ ok: true, binary: { bytes: new Uint8Array(png), mediaType: "image/png" } });
    for (const invalid of [{ ...image, mimeType: "image/jpeg" }, { ...image, data: "iVBORw0KGgp=" },
      { ...image, data: "iVBORw0KGgo" }, { ...image, data: Buffer.from("not an image").toString("base64") }]) {
      image = invalid;
      await expect(capture()).rejects.toThrow(/image/u);
    }
  });
  it("enforces node generation and dispatches the capability-fenced unified action", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { ok: true, action: "status", data: { running: true } },
      isError: false
    }));
    const executor = new BrowserAutomationNodeExecutor({
      nodeId: "node-local",
      displayName: "Local browser",
      generation: 7,
      bridge: { available: true, callTool } as unknown as BrowserToolBridgeProvider,
      artifacts: artifactStore() as unknown as ArtifactStore
    });

    await expect(executor.execute({
      nodeId: "node-local",
      expectedGeneration: 7,
      action: "status",
      arguments: { action: "status" }
    })).resolves.toEqual({ ok: true, data: { running: true } });
    expect(callTool).toHaveBeenCalledWith("browser", { action: "status" }, undefined);
    await expect(executor.execute({
      nodeId: "node-local", expectedGeneration: 7, action: "setBackend", arguments: { action: "setBackend", backend: "sidebar" }
    })).rejects.toThrow("local Settings");
    expect(callTool).toHaveBeenCalledOnce();
    await expect(executor.execute({
      nodeId: "node-local",
      expectedGeneration: 6,
      action: "status",
      arguments: { action: "status" }
    })).rejects.toThrow("stale");
    await expect(executor.execute({
      nodeId: "node-local",
      expectedGeneration: 7,
      action: "status",
      arguments: { action: "tabs" }
    })).rejects.toThrow("do not match");
  });

  it("verifies and ingests uploaded bytes before replacing remote artifact IDs", async () => {
    const calls: unknown[] = [];
    const bytes = Uint8Array.from(Buffer.from("upload"));
    const artifacts = artifactStore();
    const executor = new BrowserAutomationNodeExecutor({
      nodeId: "node-local",
      displayName: "Local browser",
      generation: 8,
      bridge: {
        available: true,
        callTool: vi.fn(async (_name, arguments_) => {
          calls.push(arguments_);
          return { content: [], structuredContent: { ok: true, action: "upload", data: { uploaded: true } }, isError: false };
        })
      } as unknown as BrowserToolBridgeProvider,
      artifacts: artifacts as unknown as ArtifactStore
    });
    await executor.execute({
      nodeId: "node-local",
      expectedGeneration: 8,
      action: "upload",
      arguments: { action: "upload", targetId: "page-1", paths: ["source-artifact"], selector: "input" },
      inputArtifacts: [{
        artifactId: "source-artifact",
        fileName: "upload.txt",
        mediaType: "text/plain",
        byteSize: bytes.byteLength,
        sha256Hex: createHash("sha256").update(bytes).digest("hex"),
        data: bytes
      }]
    });
    expect(artifacts.ingestBytes).toHaveBeenCalledOnce();
    expect(calls).toEqual([{ action: "upload", targetId: "page-1", paths: ["remote-artifact"], selector: "input" }]);
  });
});

describe("AuthenticatedBrowserRemoteNodeRouter", () => {
  it("rejects a screenshot MIME substitution even when the authenticated byte digest is valid", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const rpc: BrowserAutomationNodeRpcClient = { serverId: async () => "node-peer", list: async () => [node("node-peer", 11)],
      execute: async () => create(ExecuteBrowserAutomationActionResponseSchema, { node: node("node-peer", 11), ok: true,
        binary: { data: png, byteSize: BigInt(png.length), sha256Hex: createHash("sha256").update(png).digest("hex"), mediaType: "image/jpeg" } }) };
    const router = new AuthenticatedBrowserRemoteNodeRouter({ localNodeId: "node-local", localGeneration: 1,
      discovery: discovery() as unknown as LanDiscoveryService, artifacts: artifactStore() as unknown as ArtifactStore,
      credentials: { list: () => [{ credentialReferenceId: "ref", generation: "one", configured: true }], resolve: () => nodeCredential() } as unknown as CredentialManager,
      rpcFactory: () => rpc });
    const route = await router.resolve("node-peer");
    await expect(route?.call({ action: "screenshot", arguments: { action: "screenshot" } })).rejects.toThrow("MIME does not match");
  });
  it("pins the private credential route before identity-probing or sending its service bearer", async () => {
    const order: string[] = [];
    const rpc: BrowserAutomationNodeRpcClient = {
      serverId: vi.fn(async () => { order.push("identity"); return "node-peer"; }),
      list: vi.fn(async (authKey) => {
        order.push(`list:${authKey}`);
        return [node("node-peer", 11)];
      }),
      execute: vi.fn(async (authKey, request) => {
        order.push(`execute:${authKey}:${request.expectedGeneration}`);
        return create(ExecuteBrowserAutomationActionResponseSchema, {
          node: node("node-peer", 11),
          ok: true,
          dataJson: JSON.stringify({ running: true })
        });
      })
    };
    const credentials = {
      list: vi.fn(() => [{
        credentialReferenceId: "credential-ref",
        generation: "credential-generation-one",
        providerId: browserAutomationNodeCredentialProviderId("node-peer"),
        kind: "header_secret",
        configured: true
      }]),
      resolve: vi.fn(() => { order.push("resolve"); return nodeCredential(); })
    };
    const router = new AuthenticatedBrowserRemoteNodeRouter({
      localNodeId: "node-local",
      localGeneration: 5,
      discovery: discovery() as unknown as LanDiscoveryService,
      credentials: credentials as unknown as CredentialManager,
      artifacts: artifactStore() as unknown as ArtifactStore,
      rpcFactory: (origin, pin) => { expect(origin).toBe("http://192.168.1.20:4318"); expect(pin).toBe(endpointPublicKey); return rpc; }
    });

    const route = await router.resolve("node-peer");
    expect(route?.generation).toBe(11);
    expect(order.slice(0, 3)).toEqual(["resolve", "identity", "list:service-auth-key"]);
    await expect(route?.call({ action: "status", arguments: { action: "status" } }))
      .resolves.toEqual({ ok: true, data: { running: true } });
    expect(order).toContain("execute:service-auth-key:11");
  });

  it("rejects a generation change returned by the authenticated remote node", async () => {
    const rpc: BrowserAutomationNodeRpcClient = {
      serverId: async () => "node-peer",
      list: async () => [node("node-peer", 11)],
      execute: async () => create(ExecuteBrowserAutomationActionResponseSchema, {
        node: node("node-peer", 12),
        ok: true,
        dataJson: "{}"
      })
    };
    const router = new AuthenticatedBrowserRemoteNodeRouter({
      localNodeId: "node-local",
      localGeneration: 5,
      discovery: discovery() as unknown as LanDiscoveryService,
      credentials: {
        list: () => [{ credentialReferenceId: "ref", generation: "one", configured: true }],
        resolve: () => nodeCredential()
      } as unknown as CredentialManager,
      artifacts: artifactStore() as unknown as ArtifactStore,
      rpcFactory: () => rpc
    });
    const route = await router.resolve("node-peer");
    await expect(route?.call({ action: "status", arguments: { action: "status" } })).rejects.toThrow("generation changed");
  });

  it("rejects missing pins and bare legacy keys instead of deriving trust from discovery", () => {
    expect(() => parseBrowserAutomationNodeCredential("service-auth-key")).toThrow("complete trusted connection credential");
    expect(() => parseBrowserAutomationNodeCredential(JSON.stringify({ format: 1, serverId: "node-peer", origin: "http://192.168.1.20:4318", authKey: "service-auth-key" }))).toThrow("complete trusted connection credential");
  });

  it("refuses a discovery-origin substitution before invoking any RPC", async () => {
    const rpcFactory = vi.fn();
    const router = new AuthenticatedBrowserRemoteNodeRouter({ localNodeId: "node-local", localGeneration: 1,
      discovery: discovery() as unknown as LanDiscoveryService, artifacts: artifactStore() as unknown as ArtifactStore,
      credentials: { list: () => [{ credentialReferenceId: "ref", generation: "one", configured: true }], resolve: () => nodeCredential("https://trusted.example") } as unknown as CredentialManager,
      rpcFactory });
    await expect(router.resolve("node-peer")).rejects.toThrow("does not match its trusted connection");
    expect(rpcFactory).not.toHaveBeenCalled();
  });

  it("fences a credential replacement while an identity check is awaiting its result", async () => {
    let generation = "one";
    const list = vi.fn(async () => [node("node-peer", 11)]);
    const rpc: BrowserAutomationNodeRpcClient = { serverId: async () => { generation = "two"; return "node-peer"; }, list, execute: vi.fn() };
    const router = new AuthenticatedBrowserRemoteNodeRouter({ localNodeId: "node-local", localGeneration: 1,
      discovery: discovery() as unknown as LanDiscoveryService, artifacts: artifactStore() as unknown as ArtifactStore,
      credentials: { list: () => [{ credentialReferenceId: "ref", generation, configured: true }], resolve: () => nodeCredential() } as unknown as CredentialManager,
      rpcFactory: () => rpc });
    await expect(router.resolve("node-peer")).rejects.toThrow("revoked or replaced");
    expect(list).not.toHaveBeenCalled();
  });
});

function node(id: string, generation: number) {
  return create(BrowserAutomationNodeSchema, {
    nodeId: id,
    displayName: "Peer browser",
    available: true,
    generation: BigInt(generation),
    capabilities: [...BROWSER_AUTOMATION_NODE_CAPABILITIES]
  });
}

function discovery() {
  return {
    list: () => [
      { serverId: "node-local", displayName: "Local", origin: "http://127.0.0.1:4318", version: "1", apiVersion: "joko.v1", pairingEnabled: false, lastSeen: Date.now() },
      { serverId: "node-peer", displayName: "Peer", origin: "http://192.168.1.20:4318", version: "1", apiVersion: "joko.v1", pairingEnabled: false, lastSeen: Date.now() }
    ]
  };
}

function artifactStore() {
  const data = Uint8Array.from(Buffer.from("source"));
  return {
    ingestBytes: vi.fn(async () => ({
      id: "remote-artifact",
      sha256: createHash("sha256").update(data).digest("hex"),
      byteLength: data.byteLength,
      mimeType: "text/plain",
      fileName: "upload.txt",
      storagePath: "private",
      createdAt: 1
    })),
    get: vi.fn(async (id: string) => ({
      id,
      sha256: createHash("sha256").update(data).digest("hex"),
      byteLength: data.byteLength,
      mimeType: "text/plain",
      fileName: "upload.txt",
      storagePath: "private",
      createdAt: 1
    })),
    readBlob: vi.fn(async () => ({ data, mimeType: "text/plain" }))
  };
}

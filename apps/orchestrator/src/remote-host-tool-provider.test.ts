import { join } from "node:path";

import type { AgentAuthConnection } from "@joko/remote-ssh";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeToolCallContext, McpCallResult } from "./mcp-router.js";
import {
  RemoteHostRegistry,
  type ResolvedAgentAuthConnectorPort,
  type ResolvedAgentAuthConnectorRequest
} from "./remote-host-registry.js";
import { RemoteHostToolBridgeProvider } from "./remote-host-tool-provider.js";

const SECRET = "EPHEMERAL_REMOTE_TOOL_CREDENTIAL";
const COMMAND = "PRIVATE_MODEL_AUTHORED_COMMAND";
const open: Array<{ readonly store: OperationalStore; readonly registry: RemoteHostRegistry }> = [];

afterEach(async () => {
  for (const fixture of open.splice(0)) {
    await fixture.registry.close();
    fixture.store.close();
  }
});

describe("RemoteHostToolBridgeProvider", () => {
  it("advertises target-scoped read tools and dynamically omits undeclared execution", () => {
    const fixture = createFixture();
    expect(fixture.provider.tools.map((tool) => tool.name)).toEqual([
      "remote_host_list_hosts",
      "remote_host_status"
    ]);
    expect(fixture.provider.tools.every((tool) => !tool.requiresPermission)).toBe(true);
    expect(fixture.provider.includeForTarget("target-a")).toBe(true);
    expect(fixture.provider.includeForTarget("target-untrusted")).toBe(false);
    expect(fixture.provider.includeForTarget("missing")).toBe(false);
  });

  it("lists and resolves only the authenticated target without credential references", async () => {
    const fixture = createFixture();
    fixture.registry.create({
      targetId: "target-a",
      id: "shared",
      hostname: "shared.example.test",
      user: "maker",
      source: "manual",
      credentialReferenceId: "agent:private-a"
    });
    fixture.registry.create({
      targetId: "target-b",
      id: "shared",
      hostname: "other-target.example.test",
      user: "other",
      source: "manual",
      credentialReferenceId: "agent:private-b"
    });
    fixture.store.createRemoteHost({
      ownerId: "owner-b",
      targetId: "target-a",
      id: "other-owner",
      hostname: "other-owner.example.test",
      user: "other",
      source: "manual"
    });

    const listed = await call(fixture.provider, "remote_host_list_hosts", {});
    expect(resultData(listed)).toEqual({
      hosts: [expect.objectContaining({
        id: "shared",
        hostname: "shared.example.test",
        credentialConfigured: true,
        status: "disconnected"
      })]
    });
    const status = await call(fixture.provider, "remote_host_status", { host: "shared.example.test" });
    expect(resultData(status)).toEqual({
      host: expect.objectContaining({ id: "shared", hostname: "shared.example.test" })
    });
    const projection = safeJson({ listed, status });
    expect(projection).not.toContain("agent:private-a");
    expect(projection).not.toContain("agent:private-b");
    expect(projection).not.toContain("owner-a");
    expect(projection).not.toContain("owner-b");
  });

  it("executes through the permission-gated port, zeroes credentials, then redacts and bounds output", async () => {
    let credentialView: Uint8Array | undefined;
    const execute = vi.fn(async (request: Parameters<NonNullable<AgentAuthConnection["execute"]>>[0]) => ({
      stdout: `${SECRET}\nsk-abcdefghijklmnop\n${"x".repeat(40_000)}\nBearer abcdefghijklmnop`,
      stderr: "",
      exitCode: 0,
      outputCapped: false
    }));
    const connector: ResolvedAgentAuthConnectorPort = {
      capabilities: {
        commandExecution: true,
        processStreaming: false,
        fileTransfer: false,
        tcpForwarding: false
      },
      async connect(request: ResolvedAgentAuthConnectorRequest): Promise<AgentAuthConnection> {
        if (request.authentication.kind !== "private_key") throw new Error("unexpected authentication mode");
        credentialView = request.authentication.privateKey;
        request.onAuthenticating();
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(3, 4, 5) });
        return { close: async () => undefined, execute };
      }
    };
    const resolve = vi.fn(() => SECRET);
    const fixture = createFixture({ connector, resolve });
    fixture.registry.create({
      targetId: "target-a",
      id: "executor",
      hostname: "executor.example.test",
      user: "maker",
      source: "manual",
      credentialReferenceId: "agent:executor"
    });

    expect(fixture.provider.tools.map((tool) => ({ name: tool.name, permission: tool.requiresPermission })))
      .toEqual([
        { name: "remote_host_list_hosts", permission: false },
        { name: "remote_host_status", permission: false },
        { name: "remote_host_execute", permission: true }
      ]);
    const result = await call(fixture.provider, "remote_host_execute", {
      host: "executor",
      command: COMMAND,
      cwd: "/srv/project",
      timeoutMs: 5_000,
      input: "bounded stdin"
    });
    expect(result.isError).toBe(false);
    const data = resultData(result) as Record<string, unknown>;
    expect(data).toMatchObject({
      host: "executor",
      exitCode: 0,
      outputCapped: false,
      stdoutTruncated: true
    });
    expect(String(data["stdout"]).length).toBeLessThanOrEqual(32_000);
    expect(String(data["stdout"])).toContain("[REDACTED]");
    expect(String(data["stdout"])).not.toContain("sk-abcdefghijklmnop");
    expect(String(data["stdout"])).not.toContain("abcdefghijklmnop");
    expect(String(data["stdout"])).not.toContain(SECRET);
    expect(execute).toHaveBeenCalledWith({
      command: COMMAND,
      cwd: "/srv/project",
      timeoutMs: 5_000,
      input: "bounded stdin",
      maxOutputBytes: 512 * 1_024,
      signal: expect.any(AbortSignal)
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(credentialView).toBeDefined();
    expect([...(credentialView ?? [])].every((byte) => byte === 0)).toBe(true);
    expect(safeJson(result)).not.toContain(SECRET);
    expect(safeJson(result)).not.toContain(COMMAND);
    expect(safeJson(fixture.store.listEvents({ limit: 1_000 }))).not.toContain(COMMAND);
  });

  it("fences untrusted, stale, ambiguous, and raw connector failures without disclosure", async () => {
    const connector: ResolvedAgentAuthConnectorPort = {
      capabilities: {
        commandExecution: true,
        processStreaming: false,
        fileTransfer: false,
        tcpForwarding: false
      },
      async connect(request) {
        request.onAuthenticating();
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(7, 8, 9) });
        return {
          close: async () => undefined,
          execute: async () => { throw new Error(`RAW_EXECUTOR ${COMMAND} ${SECRET}`); }
        };
      }
    };
    const fixture = createFixture({ connector, resolve: () => SECRET });
    for (const [id, targetId] of [["one", "target-a"], ["two", "target-a"], ["untrusted", "target-untrusted"]] as const) {
      fixture.registry.create({
        targetId,
        id,
        hostname: id === "untrusted" ? "untrusted.example.test" : "duplicate.example.test",
        user: "maker",
        source: "manual",
        credentialReferenceId: `agent:${id}`
      });
    }
    expect(errorData(await call(fixture.provider, "remote_host_status", {
      host: "duplicate.example.test"
    }))).toMatchObject({ errorCode: "AMBIGUOUS_HOST" });
    expect(errorData(await call(
      fixture.provider,
      "remote_host_list_hosts",
      {},
      { sessionId: "session-untrusted", targetId: "target-untrusted", generation: 7 }
    ))).toMatchObject({ errorCode: "PERMISSION_DENIED" });
    expect(errorData(await call(
      fixture.provider,
      "remote_host_list_hosts",
      {},
      { sessionId: "session-a", targetId: "target-a", generation: 8 }
    ))).toMatchObject({ errorCode: "STALE_SCOPE" });

    const failed = await call(fixture.provider, "remote_host_execute", {
      host: "one",
      command: COMMAND
    });
    expect(errorData(failed)).toMatchObject({ errorCode: "REMOTE_FAILURE" });
    expect(safeJson(failed)).not.toContain("RAW_EXECUTOR");
    expect(safeJson(failed)).not.toContain(COMMAND);
    expect(safeJson(failed)).not.toContain(SECRET);
  });
});

interface Fixture {
  readonly store: OperationalStore;
  readonly registry: RemoteHostRegistry;
  readonly provider: RemoteHostToolBridgeProvider;
}

function createFixture(options: {
  readonly connector?: ResolvedAgentAuthConnectorPort;
  readonly resolve?: (referenceId: string) => string;
} = {}): Fixture {
  const store = new OperationalStore(":memory:");
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  for (const [id, trusted] of [["target-a", true], ["target-b", true], ["target-untrusted", false]] as const) {
    store.upsertTarget({
      id,
      backendId: "pi",
      displayName: id,
      workspaceRoot: join("D:/workspace", id),
      managed: false,
      trusted
    });
  }
  for (const [id, targetId] of [
    ["session-a", "target-a"],
    ["session-b", "target-b"],
    ["session-untrusted", "target-untrusted"]
  ] as const) {
    store.createSession({
      id,
      backendId: "pi",
      targetId,
      title: id,
      binding: { opaqueRef: `${id}.jsonl`, generation: 7 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1_000,
      updatedAt: 1_000
    });
  }
  const registry = new RemoteHostRegistry({
    store,
    ownerId: "owner-a",
    ...(options.resolve === undefined ? {} : { credentials: { resolve: options.resolve } }),
    ...(options.connector === undefined ? {} : { connector: options.connector })
  });
  const provider = new RemoteHostToolBridgeProvider({
    store,
    registry,
    outputRedactor: {
      redactText: (value) => value.split(SECRET).join("[REDACTED]")
    }
  });
  open.push({ store, registry });
  return { store, registry, provider };
}

async function call(
  provider: RemoteHostToolBridgeProvider,
  name: string,
  input: Readonly<Record<string, unknown>>,
  context: BridgeToolCallContext = { sessionId: "session-a", targetId: "target-a", generation: 7 }
): Promise<McpCallResult> {
  return provider.callTool(name, input, undefined, context);
}

function resultData(result: McpCallResult): unknown {
  expect(result.isError).toBe(false);
  return result.structuredContent?.["data"];
}

function errorData(result: McpCallResult): Readonly<Record<string, unknown>> {
  expect(result.isError).toBe(true);
  return result.structuredContent ?? {};
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry
  );
}

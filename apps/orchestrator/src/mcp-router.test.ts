import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { managedSubagentRunRoot, managedSubagentSessionKey } from "@joko/adapter-pi";
import { OperationalStore } from "@joko/store";
import {
  ANDROID_TOOL_NAMES,
  type AndroidToolDescriptor,
  type AndroidToolProvider
} from "@joko/tool-android";
import { describe, expect, it } from "vitest";

import { ANDROID_BRIDGE_PROVIDER_ID, AndroidToolBridgeProvider } from "./android-tool-bridge.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import {
  McpRouter,
  type BridgeToolProvider,
  type McpClientConnection,
  type McpClientFactory,
  type McpClientFactoryInput,
  type McpCallResult,
  type McpRouterOptions,
  type PiNativeAuthLeaseSource,
  type McpToolListPage,
  MCP_BRIDGE_RESPONSE_MAXIMUM_BYTES
} from "./mcp-router.js";
import {
  NativeAuthRecoveryStore,
  recoveryBindingDigest,
  type NativeAuthRecoveryPort,
  type RemoteNativeAuthRunnerAttestation
} from "./native-auth-recovery.js";

class FakeMcpFactory implements McpClientFactory {
  readonly inputs: McpClientFactoryInput[] = [];
  readonly closed: number[] = [];
  readonly listCursors: Array<string | undefined> = [];
  readonly listSignals: AbortSignal[] = [];
  readonly calledTools: string[] = [];
  result: McpCallResult | undefined;
  toolDescription = "Return the fenced generation";
  listToolsHandler: ((cursor: string | undefined, signal: AbortSignal) => Promise<McpToolListPage>) | undefined;

  async connect(input: McpClientFactoryInput): Promise<McpClientConnection> {
    this.inputs.push(input);
    const generation = input.generation;
    const owner = this;
    return {
      async listTools(cursor, signal) {
        if (signal === undefined) throw new Error("MCP discovery signal is required.");
        owner.listCursors.push(cursor);
        owner.listSignals.push(signal);
        if (owner.listToolsHandler !== undefined) return owner.listToolsHandler(cursor, signal);
        return { tools: [{
          name: "echo",
          description: owner.toolDescription,
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
          annotations: { readOnlyHint: true }
        }] };
      },
      async callTool(name, arguments_): Promise<McpCallResult> {
        owner.calledTools.push(name);
        if (owner.result !== undefined) return owner.result;
        return { content: [{ type: "text", text: `${generation}:${String(arguments_["value"] ?? "")}` }], isError: false };
      },
      close: async () => { this.closed.push(generation); }
    };
  }
}

interface FixtureOptions extends Partial<Pick<McpRouterOptions, "now" | "bridgeGrantTtlMs" | "nativeAuthLeaseTtlMs" | "nativeAuth" | "nativeAuthRecovery" | "trustedManagedRunnerScriptSha256" | "toolDiscoveryPolicy">> {
  readonly maximumBlobBytes?: number;
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-mcp-router-"));
  const store = new OperationalStore(join(root, "orchestrator.db"));
  const vault = await CredentialVault.open(join(root, "vault.key"));
  const credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") });
  await credentials.initialize();
  const ticket = credentials.createUploadTicket();
  credentials.upload(ticket.credentialUploadTicketId, "mcp-header-secret-value");
  await credentials.commitUpload({
    credentialUploadTicketId: ticket.credentialUploadTicketId,
    credentialReferenceId: "cred_mcp_header",
    displayName: "MCP header",
    kind: "header_secret"
  });
  const tenantTicket = credentials.createUploadTicket();
  credentials.upload(tenantTicket.credentialUploadTicketId, "mcp-tenant-secret-value");
  await credentials.commitUpload({
    credentialUploadTicketId: tenantTicket.credentialUploadTicketId,
    credentialReferenceId: "cred_mcp_tenant",
    displayName: "MCP tenant header",
    kind: "header_secret"
  });
  const factory = new FakeMcpFactory();
  const artifacts = new ArtifactStore({
    rootDirectory: join(root, "artifacts"),
    repository: new OperationalArtifactRepository(store),
    ingestRoots: [root],
    ...(options.maximumBlobBytes === undefined ? {} : { maximumBlobBytes: options.maximumBlobBytes })
  });
  await artifacts.initialize();
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
  store.upsertTarget({
    id: "target-1",
    backendId: "pi",
    displayName: "Workspace",
    workspaceRoot: "D:/workspace",
    managed: false,
    trusted: true
  });
  store.upsertTarget({
    id: "target-remote",
    backendId: "pi",
    displayName: "Remote Workspace",
    workspaceRoot: "D:/remote-placeholder",
    managed: false,
    trusted: true
  });
  store.createRemoteHost({
    ownerId: "owner-test",
    targetId: "target-remote",
    id: "remote-host",
    hostname: "remote.example.test",
    user: "runner",
    source: "manual"
  });
  store.upsertTarget({
    id: "target-remote",
    backendId: "pi",
    displayName: "Remote Workspace",
    workspaceRoot: "D:/remote-placeholder",
    managed: false,
    trusted: true,
    remoteWorkspace: { hostId: "remote-host", workspaceRoot: "/srv/workspace" }
  });
  for (const generation of [0, 1, 2, 7, 8, 99]) {
    store.createSession({
      id: `session-${generation}`,
      backendId: "pi",
      targetId: "target-1",
      title: `Session ${generation}`,
      binding: { opaqueRef: `session-${generation}.jsonl`, generation },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: generation + 1,
      updatedAt: generation + 1
    });
  }
  store.createSession({
    id: "session-remote",
    backendId: "pi",
    targetId: "target-remote",
    title: "Remote Session",
    binding: { opaqueRef: "remote-session.jsonl", generation: 1 },
    remoteWorkspace: { hostId: "remote-host", workspaceRoot: "/srv/workspace" },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: 100,
    updatedAt: 100
  });
  const router = new McpRouter({
    store,
    credentials,
    clientFactory: factory,
    resultArtifacts: artifacts,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.bridgeGrantTtlMs === undefined ? {} : { bridgeGrantTtlMs: options.bridgeGrantTtlMs }),
    ...(options.nativeAuthLeaseTtlMs === undefined ? {} : { nativeAuthLeaseTtlMs: options.nativeAuthLeaseTtlMs }),
    ...(options.nativeAuth === undefined ? {} : { nativeAuth: options.nativeAuth }),
    ...(options.nativeAuthRecovery === undefined ? {} : { nativeAuthRecovery: options.nativeAuthRecovery }),
    ...(options.trustedManagedRunnerScriptSha256 === undefined
      ? {} : { trustedManagedRunnerScriptSha256: options.trustedManagedRunnerScriptSha256 }),
    ...(options.toolDiscoveryPolicy === undefined ? {} : { toolDiscoveryPolicy: options.toolDiscoveryPolicy })
  });
  await router.initialize();
  return { root, store, credentials, factory, artifacts, router };
}

describe("McpRouter", () => {
  it("leases native auth only to the exact account generation and runner fence", async () => {
    let now = 10_000;
    let accountId = "vault-account-one";
    let authGeneration = "4";
    const initial = {
      type: "oauth",
      access: `lease-access-${randomUUID()}`,
      refresh: `lease-refresh-${randomUUID()}`,
      expires: 99_999
    };
    const persisted: unknown[] = [];
    const nativeAuth: PiNativeAuthLeaseSource = {
      describe: () => ({ accountId, authGeneration, catalogGeneration: 12, authenticated: true }),
      load: ({ providerIds, expectedCatalogGeneration }) => {
        expect(providerIds).toEqual(["native-provider"]);
        expect(expectedCatalogGeneration).toBe(12);
        return { catalogGeneration: 12, credentials: { "native-provider": initial } };
      },
      persist: async (input) => { persisted.push(input); }
    };
    const { store, router } = await fixture({ now: () => now, nativeAuthLeaseTtlMs: 2_000, nativeAuth });
    const bridge = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      expectedPiGeneration: 1,
      nativeAuthLease: {
        endpoint: "http://127.0.0.1:4318/internal/pi-native-auth",
        catalogGeneration: 12,
        providerIds: ["native-provider"],
        authenticatedProviderIds: ["native-provider"]
      }
    });
    const runId = randomUUID();
    const runnerFence = randomUUID();
    const scope = {
      authorization: `Bearer ${bridge.mcpBridge.token}`,
      generation: 1,
      runnerProductGeneration: 1,
      sessionId: "session-1",
      targetId: "target-1",
      providerId: "native-provider",
      catalogGeneration: 12,
      runId,
      runnerFence
    } as const;

    await expect(router.executeNativeAuthLease({ ...scope, action: "acquire" })).resolves.toEqual({
      active: true,
      validForMs: 2_000,
      credential: initial
    });
    await expect(router.executeNativeAuthLease({ ...scope, action: "validate", runnerFence: randomUUID() }))
      .rejects.toThrow(/runner fence/iu);
    now = 11_000;
    await expect(router.executeNativeAuthLease({ ...scope, action: "validate" })).resolves.toEqual({ active: true, validForMs: 2_000 });

    authGeneration = "5";
    await expect(router.executeNativeAuthLease({ ...scope, action: "validate" })).rejects.toThrow(/account or generation changed/iu);
    await expect(router.executeNativeAuthLease({ ...scope, action: "release" })).rejects.toThrow(/expired or revoked/iu);

    const refreshedRun = randomUUID();
    const refreshedFence = randomUUID();
    const refreshedScope = { ...scope, runId: refreshedRun, runnerFence: refreshedFence };
    await router.executeNativeAuthLease({ ...refreshedScope, action: "acquire" });
    const refreshed = { ...initial, access: `changed-${randomUUID()}` };
    await expect(router.executeNativeAuthLease({ ...refreshedScope, action: "release", credential: refreshed }))
      .resolves.toEqual({ active: false });
    expect(persisted).toEqual([{
      providerId: "native-provider",
      credential: refreshed,
      expectedCatalogGeneration: 12,
      expectedAccountId: "vault-account-one"
    }]);

    accountId = "vault-account-two";
    authGeneration = "6";
    const expiredScope = { ...scope, runId: randomUUID(), runnerFence: randomUUID() };
    await router.executeNativeAuthLease({ ...expiredScope, action: "acquire" });
    now = 14_001;
    await expect(router.executeNativeAuthLease({ ...expiredScope, action: "validate" })).rejects.toThrow(/expired or revoked/iu);
    bridge.revoke();
    await expect(router.executeNativeAuthLease({ ...expiredScope, action: "acquire" })).rejects.toThrow(/invalid or expired/iu);
    await router.dispose();
    store.close();
  });

  it("keeps detached same-account leases alive and commits only the first concurrent refresh", async () => {
    let now = 20_000;
    let authGeneration = "9";
    let catalogGeneration = 21;
    let resolvePersistEntered!: () => void;
    let resolvePersist!: () => void;
    const persistEntered = new Promise<void>((resolve) => { resolvePersistEntered = resolve; });
    const persistGate = new Promise<void>((resolve) => { resolvePersist = resolve; });
    const persistCalls: unknown[] = [];
    const initial = {
      type: "oauth",
      access: `parallel-access-${randomUUID()}`,
      refresh: `parallel-refresh-${randomUUID()}`,
      expires: 999_999
    };
    const nativeAuth: PiNativeAuthLeaseSource = {
      describe: () => ({
        accountId: "shared-vault-account",
        authGeneration,
        catalogGeneration,
        authenticated: true
      }),
      load: () => ({ catalogGeneration: 21, credentials: { "native-provider": initial } }),
      persist: async (input) => {
        persistCalls.push(input);
        resolvePersistEntered();
        await persistGate;
        authGeneration = "10";
        catalogGeneration = 22;
        return { catalogGeneration: 22 };
      }
    };
    const { store, router } = await fixture({ now: () => now, nativeAuthLeaseTtlMs: 5_000, nativeAuth });
    const bridge = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      expectedPiGeneration: 1,
      nativeAuthLease: {
        endpoint: "http://127.0.0.1:4318/internal/pi-native-auth",
        catalogGeneration: 21,
        providerIds: ["native-provider"],
        authenticatedProviderIds: ["native-provider"]
      }
    });
    const scope = (runId: string, runnerFence: string) => ({
      authorization: `Bearer ${bridge.mcpBridge.token}`,
      generation: 1,
      runnerProductGeneration: 1,
      sessionId: "session-1",
      targetId: "target-1",
      providerId: "native-provider",
      catalogGeneration: 21,
      runId,
      runnerFence
    } as const);
    const first = scope(randomUUID(), randomUUID());
    const second = scope(randomUUID(), randomUUID());
    const stillRunning = scope(randomUUID(), randomUUID());
    await router.executeNativeAuthLease({ ...first, action: "acquire" });
    await router.executeNativeAuthLease({ ...second, action: "acquire" });
    await router.executeNativeAuthLease({ ...stillRunning, action: "acquire" });

    const firstRelease = router.executeNativeAuthLease({
      ...first,
      action: "release",
      credential: { ...initial, access: `first-refresh-${randomUUID()}` }
    });
    await persistEntered;
    const secondRelease = router.executeNativeAuthLease({
      ...second,
      action: "release",
      credential: { ...initial, access: `second-refresh-${randomUUID()}` }
    });
    await expect(router.executeNativeAuthLease({ ...stillRunning, action: "validate" })).resolves.toEqual({
      active: true,
      validForMs: 5_000
    });
    resolvePersist();
    await expect(firstRelease).resolves.toEqual({ active: false });
    await expect(secondRelease).resolves.toEqual({ active: false });

    // Parent runtime/tool authority can retire while the already-acquired
    // detached child retains only its exact native-auth lease.
    bridge.revoke();
    now = 21_000;
    await expect(router.executeNativeAuthLease({ ...stillRunning, action: "validate" })).resolves.toEqual({
      active: true,
      validForMs: 5_000
    });
    await expect(router.executeNativeAuthLease({ ...stillRunning, action: "release" })).resolves.toEqual({ active: false });
    await expect(router.executeNativeAuthLease({ ...stillRunning, action: "release" })).resolves.toEqual({ active: false });
    expect(persistCalls).toHaveLength(1);

    await router.dispose();
    store.close();
  });

  it("keeps only the exact acquired detached lease across a parent reactivation generation", async () => {
    let now = 30_000;
    const credential = {
      type: "oauth",
      access: `reactivation-access-${randomUUID()}`,
      refresh: `reactivation-refresh-${randomUUID()}`,
      expires: 999_999
    };
    const nativeAuth: PiNativeAuthLeaseSource = {
      describe: () => ({
        accountId: "reactivation-account",
        authGeneration: "17",
        catalogGeneration: 31,
        authenticated: true
      }),
      load: () => ({ catalogGeneration: 31, credentials: { "native-provider": credential } }),
      persist: async () => ({ catalogGeneration: 31 })
    };
    const { store, router } = await fixture({ now: () => now, nativeAuthLeaseTtlMs: 5_000, nativeAuth });
    const bridge = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      expectedPiGeneration: 1,
      nativeAuthLease: {
        endpoint: "http://127.0.0.1:4318/internal/pi-native-auth",
        catalogGeneration: 31,
        providerIds: ["native-provider"],
        authenticatedProviderIds: ["native-provider"]
      }
    });
    const scope = {
      authorization: `Bearer ${bridge.mcpBridge.token}`,
      generation: 1,
      runnerProductGeneration: 1,
      sessionId: "session-1",
      targetId: "target-1",
      providerId: "native-provider",
      catalogGeneration: 31,
      runId: randomUUID(),
      runnerFence: randomUUID()
    } as const;
    await expect(router.executeNativeAuthLease({ ...scope, action: "acquire" })).resolves.toEqual({
      active: true,
      validForMs: 5_000,
      credential
    });

    const stored = store.getSession(scope.sessionId);
    store.updateSession(scope.sessionId, {
      binding: { ...stored.descriptor.binding, generation: 2 }
    }, stored.revision);
    bridge.revoke();
    now = 31_000;

    await expect(router.executeNativeAuthLease({ ...scope, action: "validate" })).resolves.toEqual({
      active: true,
      validForMs: 5_000
    });
    await expect(router.executeNativeAuthLease({ ...scope, action: "validate", runnerFence: randomUUID() }))
      .rejects.toThrow(/runner fence/iu);
    await expect(router.executeNativeAuthLease({ ...scope, action: "validate", generation: 2 }))
      .rejects.toThrow(/runner fence/iu);
    await expect(router.executeNativeAuthLease({
      ...scope,
      action: "acquire",
      generation: 2,
      runId: randomUUID(),
      runnerFence: randomUUID()
    })).rejects.toThrow(/invalid or expired/iu);
    await expect(router.executeNativeAuthLease({ ...scope, action: "release" })).resolves.toEqual({ active: false });
    await expect(router.executeNativeAuthLease({ ...scope, action: "release" })).resolves.toEqual({ active: false });

    await router.dispose();
    store.close();
  });

  it("recovers a live managed native-auth lease after a router restart without restoring Tool authority", async () => {
    let now = 50_000;
    const durable = await createNativeRecoveryRun();
    try {
    const accountId = `restart-account-${randomUUID()}`;
    const credential = {
      type: "oauth",
      access: `restart-access-${randomUUID()}`,
      refresh: `restart-refresh-${randomUUID()}`,
      expires: 999_999
    };
    const nativeAuth: PiNativeAuthLeaseSource = {
      describe: () => ({ accountId, authGeneration: "restart-auth-1", catalogGeneration: 41, authenticated: true }),
      load: () => ({ catalogGeneration: 41, credentials: { "native-provider": credential } }),
      persist: async () => ({ catalogGeneration: 41 })
    };
    const firstRecovery = nativeRecoveryFor(durable, () => now);
    const fixtureValue = await fixture({
      now: () => now,
      nativeAuthLeaseTtlMs: 15_000,
      nativeAuth,
      nativeAuthRecovery: firstRecovery,
      trustedManagedRunnerScriptSha256: durable.runnerScriptSha256
    });
    const { store, credentials, factory, artifacts, router } = fixtureValue;
    const bridge = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      expectedPiGeneration: 1,
      nativeAuthLease: {
        endpoint: "http://127.0.0.1:4318/internal/pi-native-auth",
        catalogGeneration: 41,
        providerIds: ["native-provider"],
        authenticatedProviderIds: ["native-provider"]
      }
    });
    const authorization = `Bearer ${bridge.mcpBridge.token}`;

    // Configuring recovery does not cause an ordinary native-auth lease to
    // create durable authority.
    const ordinaryScope = {
      authorization,
      generation: 1,
      runnerProductGeneration: 1,
      sessionId: "session-1",
      targetId: "target-1",
      providerId: "native-provider",
      catalogGeneration: 41,
      runId: randomUUID(),
      runnerFence: randomUUID()
    } as const;
    await router.executeNativeAuthLease({ ...ordinaryScope, action: "acquire" });
    await router.executeNativeAuthLease({ ...ordinaryScope, action: "release" });
    await expect(readFile(join(durable.stateRoot, "leases.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const scope = {
      authorization,
      generation: 1,
      runnerProductGeneration: 1,
      sessionId: "session-1",
      targetId: "target-1",
      providerId: "native-provider",
      catalogGeneration: 41,
      runId: durable.runId,
      runnerFence: durable.runnerFence
    } as const;
    const acquired = await router.executeNativeAuthLease({
      ...scope,
      action: "acquire",
      recovery: { runnerPid: durable.runnerPid }
    });
    expect(acquired).toMatchObject({ active: true, validForMs: 15_000, credential });
    expect(acquired.recoveryProof).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    let recoveryProof = acquired.recoveryProof!;
    await expect(router.executeNativeAuthLease({
      ...scope,
      action: "acquire",
      recovery: { runnerPid: durable.runnerPid }
    })).resolves.toMatchObject({
      active: true,
      validForMs: 15_000,
      credential,
      recoveryProof
    });

    const storedSession = store.getSession("session-1");
    store.updateSession("session-1", {
      binding: { ...storedSession.descriptor.binding, generation: 2 }
    }, storedSession.revision);

    // This is the service fault boundary: every in-memory grant and detached
    // lease disappears while the runner and its durable lineage stay alive.
    await router.dispose();
    const restarted = new McpRouter({
      store,
      credentials,
      clientFactory: factory,
      resultArtifacts: artifacts,
      now: () => now,
      nativeAuthLeaseTtlMs: 15_000,
      nativeAuth,
      nativeAuthRecovery: nativeRecoveryFor(durable, () => now),
      trustedManagedRunnerScriptSha256: durable.runnerScriptSha256
    });
    await restarted.initialize();
    await expect(restarted.executeBridgeCall({
      authorization,
      requestId: "expired-native-auth-bridge",
      generation: 1,
      sessionId: "session-1",
      targetId: "target-1",
      serverId: "unavailable",
      toolName: "unavailable"
    })).rejects.toThrow(/credential is invalid or expired/iu);

    // The original acquire committed but its response may have been lost.
    // After restart the exact live runner can rotate the durable proof digest
    // and receive the credential again without recovering Tool authority.
    const lostProof = recoveryProof;
    const redelivered = await restarted.executeNativeAuthLease({
      ...scope,
      action: "acquire",
      recovery: { runnerPid: durable.runnerPid }
    });
    expect(redelivered).toMatchObject({ active: true, validForMs: 15_000, credential });
    expect(redelivered.recoveryProof).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(redelivered.recoveryProof).not.toBe(lostProof);
    recoveryProof = redelivered.recoveryProof!;
    await expect(restarted.executeNativeAuthLease({
      ...scope,
      action: "validate",
      recoveryProof: lostProof
    })).rejects.toThrow(/expired or revoked|invalid or expired|product scope/iu);

    now = 51_000;
    await expect(restarted.executeNativeAuthLease({
      ...scope,
      action: "validate",
      recoveryProof
    })).resolves.toEqual({ active: true, validForMs: 15_000 });
    await expect(restarted.executeNativeAuthLease({
      ...scope,
      action: "validate",
      recoveryProof: Buffer.from(randomUUID().replace(/-/gu, "").padEnd(32, "0")).toString("base64url").slice(0, 43)
    })).rejects.toThrow(/expired or revoked|invalid or expired|product scope/iu);
    await expect(restarted.executeNativeAuthLease({
      ...scope,
      action: "release",
      recoveryProof
    })).resolves.toEqual({ active: false });
    await expect(restarted.executeNativeAuthLease({
      ...scope,
      action: "release",
      recoveryProof
    })).resolves.toEqual({ active: false });

    await restarted.dispose();
    const restartedAfterRelease = new McpRouter({
      store,
      credentials,
      clientFactory: factory,
      resultArtifacts: artifacts,
      now: () => now,
      nativeAuthLeaseTtlMs: 15_000,
      nativeAuth,
      nativeAuthRecovery: nativeRecoveryFor(durable, () => now),
      trustedManagedRunnerScriptSha256: durable.runnerScriptSha256
    });
    await restartedAfterRelease.initialize();
    await expect(restartedAfterRelease.executeNativeAuthLease({
      ...scope,
      action: "release",
      recoveryProof
    })).resolves.toEqual({ active: false });

    const catalog = await readFile(join(durable.stateRoot, "leases.json"), "utf8");
    expect(catalog).not.toContain(recoveryProof);
    expect(catalog).not.toContain(accountId);
    expect(catalog).not.toContain(bridge.mcpBridge.token);
    expect(catalog).not.toContain(credential.access);
    expect(catalog).not.toContain(credential.refresh);
    await restartedAfterRelease.dispose();
    store.close();
    } finally {
      await rm(durable.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });

  it("uses a one-shot signed runner reservation across service restarts without an OS process API", async () => {
    let now = 60_000;
    const durable = await createNativeRecoveryRun();
    try {
      const accountId = `signed-restart-account-${randomUUID()}`;
      const credential = {
        type: "oauth",
        access: `signed-restart-access-${randomUUID()}`,
        refresh: `signed-restart-refresh-${randomUUID()}`
      };
      const nativeAuth: PiNativeAuthLeaseSource = {
        describe: () => ({ accountId, authGeneration: "signed-auth-1", catalogGeneration: 43, authenticated: true }),
        load: () => ({ catalogGeneration: 43, credentials: { "native-provider": credential } }),
        persist: async () => ({ catalogGeneration: 43 })
      };
      const first = await fixture({
        now: () => now,
        nativeAuthLeaseTtlMs: 15_000,
        nativeAuth,
        nativeAuthRecovery: nativeRecoveryFor(durable, () => now, false),
        trustedManagedRunnerScriptSha256: durable.runnerScriptSha256
      });
      const bridge = first.router.createPiBridgeSnapshot({
        endpoint: "http://127.0.0.1:4318/internal/mcp",
        expectedPiGeneration: 1,
        nativeAuthLease: {
          endpoint: "http://127.0.0.1:4318/internal/pi-native-auth",
          catalogGeneration: 43,
          providerIds: ["native-provider"],
          authenticatedProviderIds: ["native-provider"]
        }
      });
      const authorization = `Bearer ${bridge.mcpBridge.token}`;
      const launchAuthorization = bridge.mcpBridge.nativeAuthReservationToken;
      if (launchAuthorization === undefined) throw new Error("signed reservation authority fixture is unavailable");
      const scope = {
        generation: 1,
        runnerProductGeneration: 1,
        sessionId: "session-1",
        targetId: "target-1",
        providerId: "native-provider",
        catalogGeneration: 43,
        runId: durable.runId,
        runnerFence: durable.runnerFence
      } as const;
      const keys = generateKeyPairSync("ed25519");
      const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
      const publicKeyDigest = createHash("sha256").update(publicKey).digest("hex");
      const reserveInput = {
        ...scope,
        authorization,
        launchAuthorization,
        publicKey
      } as const;
      await expect(first.router.reserveNativeAuthRunner({
        ...reserveInput,
        launchAuthorization: undefined
      })).rejects.toThrow(/outside this runtime snapshot/iu);
      await expect(first.router.reserveNativeAuthRunner({
        ...reserveInput,
        launchAuthorization: bridge.mcpBridge.token
      })).rejects.toThrow(/outside this runtime snapshot/iu);
      const reserved = await first.router.reserveNativeAuthRunner(reserveInput);
      expect(reserved).toMatchObject({ reserved: true, serviceGeneration: 1, validForMs: 15_000 });
      await bindSignedNativeRecoveryRun(durable, reserved.reservationId, publicKey, publicKeyDigest);

      // The reservation is committed, but no credential response exists yet.
      // The service and ordinary bridge grant disappear, and parent resume
      // advances its current product binding generation.
      const storedSession = first.store.getSession("session-1");
      first.store.updateSession("session-1", {
        binding: { ...storedSession.descriptor.binding, generation: 2 }
      }, storedSession.revision);
      bridge.revoke();
      await first.router.dispose();

      const restarted = new McpRouter({
        store: first.store,
        credentials: first.credentials,
        clientFactory: first.factory,
        resultArtifacts: first.artifacts,
        now: () => now,
        nativeAuthLeaseTtlMs: 15_000,
        nativeAuth,
        nativeAuthRecovery: nativeRecoveryFor(durable, () => now, false),
        trustedManagedRunnerScriptSha256: durable.runnerScriptSha256
      });
      await restarted.initialize();
      await expect(restarted.executeBridgeCall({
        authorization,
        requestId: "expired-restarted-native-auth-bridge",
        generation: 1,
        sessionId: "session-1",
        targetId: "target-1",
        serverId: "unavailable",
        toolName: "unavailable"
      })).rejects.toThrow(/credential is invalid or expired/iu);

      const runner = {
        reservationId: reserved.reservationId,
        privateKey: keys.privateKey,
        runnerPid: durable.runnerPid
      };
      const acquired = await restarted.executeNativeAuthLease({
        ...scope,
        authorization,
        action: "acquire",
        recovery: { runnerPid: durable.runnerPid },
        runnerProof: signedRouterProof(scope, runner, "acquire")
      });
      expect(acquired).toMatchObject({ active: true, validForMs: 15_000, credential });
      const lostProof = acquired.recoveryProof!;

      // Lose the successful acquire response together with the process. The
      // restarted service rotates a fresh raw proof from the durable digest.
      await restarted.dispose();
      const restartedAfterLostResponse = new McpRouter({
        store: first.store,
        credentials: first.credentials,
        clientFactory: first.factory,
        resultArtifacts: first.artifacts,
        now: () => now,
        nativeAuthLeaseTtlMs: 15_000,
        nativeAuth,
        nativeAuthRecovery: nativeRecoveryFor(durable, () => now, false),
        trustedManagedRunnerScriptSha256: durable.runnerScriptSha256
      });
      await restartedAfterLostResponse.initialize();
      const redelivered = await restartedAfterLostResponse.executeNativeAuthLease({
        ...scope,
        authorization,
        action: "acquire",
        recovery: { runnerPid: durable.runnerPid },
        runnerProof: signedRouterProof(scope, runner, "acquire")
      });
      expect(redelivered).toMatchObject({ active: true, validForMs: 15_000, credential });
      const recoveryProof = redelivered.recoveryProof!;
      expect(recoveryProof).not.toBe(lostProof);

      now += 1_000;
      await expect(restartedAfterLostResponse.executeNativeAuthLease({
        ...scope,
        authorization,
        action: "validate",
        recoveryProof,
        runnerProof: signedRouterProof(scope, runner, "validate", recoveryProof)
      })).resolves.toEqual({ active: true, validForMs: 15_000 });
      await restartedAfterLostResponse.revokeNativeAuthSession({
        sessionId: scope.sessionId,
        targetId: "target-remote"
      });
      await expect(restartedAfterLostResponse.executeNativeAuthLease({
        ...scope,
        authorization,
        action: "validate",
        recoveryProof,
        runnerProof: signedRouterProof(scope, runner, "validate", recoveryProof)
      })).resolves.toEqual({ active: true, validForMs: 15_000 });
      await restartedAfterLostResponse.revokeNativeAuthSession({
        sessionId: scope.sessionId,
        targetId: scope.targetId
      });
      await expect(restartedAfterLostResponse.executeNativeAuthLease({
        ...scope,
        authorization,
        action: "validate",
        recoveryProof,
        runnerProof: signedRouterProof(scope, runner, "validate", recoveryProof)
      })).rejects.toThrow(/reservation scope|expired or revoked/iu);

      const catalog = await readFile(join(durable.stateRoot, "leases.json"), "utf8");
      const privateKeyCanary = keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
      for (const canary of [accountId, authorization, bridge.mcpBridge.token, launchAuthorization, lostProof, recoveryProof,
        credential.access, credential.refresh, privateKeyCanary]) {
        expect(catalog).not.toContain(canary);
      }
      expect(JSON.parse(catalog)).toMatchObject({ records: [], transitions: [], reservations: [] });
      await restartedAfterLostResponse.dispose();
      first.store.close();
    } finally {
      await rm(durable.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });

  it("separates the current reservation route generation from the runner product generation", async () => {
    const durable = await createNativeRecoveryRun();
    try {
      const nativeAuth: PiNativeAuthLeaseSource = {
        describe: () => ({ accountId: "generation-account", authGeneration: "generation-auth", catalogGeneration: 47, authenticated: true }),
        load: () => ({ catalogGeneration: 47, credentials: {} }),
        persist: async () => ({ catalogGeneration: 47 })
      };
      const current = await fixture({
        nativeAuth,
        nativeAuthRecovery: nativeRecoveryFor(durable, Date.now, false),
        trustedManagedRunnerScriptSha256: durable.runnerScriptSha256
      });
      const session = current.store.getSession("session-1");
      current.store.updateSession("session-1", {
        binding: { ...session.descriptor.binding, generation: 2 }
      }, session.revision);
      const bridge = current.router.createPiBridgeSnapshot({
        endpoint: "http://127.0.0.1:4318/internal/mcp",
        expectedPiGeneration: 2,
        nativeAuthLease: {
          endpoint: "http://127.0.0.1:4318/internal/pi-native-auth",
          catalogGeneration: 47,
          providerIds: ["native-provider"],
          authenticatedProviderIds: ["native-provider"]
        }
      });
      const publicKey = generateKeyPairSync("ed25519").publicKey
        .export({ format: "der", type: "spki" }).toString("base64url");
      const reservation = await current.router.reserveNativeAuthRunner({
        authorization: `Bearer ${bridge.mcpBridge.token}`,
        launchAuthorization: bridge.mcpBridge.nativeAuthReservationToken,
        generation: 2,
        runnerProductGeneration: 1,
        sessionId: "session-1",
        targetId: "target-1",
        providerId: "native-provider",
        catalogGeneration: 47,
        runId: durable.runId,
        runnerFence: durable.runnerFence,
        publicKey
      });
      expect(reservation.serviceGeneration).toBe(2);
      const catalog = JSON.parse(await readFile(join(durable.stateRoot, "leases.json"), "utf8")) as {
        reservations: Array<Record<string, unknown>>;
      };
      expect(catalog.reservations).toEqual([expect.objectContaining({
        serviceGeneration: 2,
        runnerProductGeneration: 1
      })]);
      expect(JSON.stringify(catalog)).not.toContain(bridge.mcpBridge.nativeAuthReservationToken);
      await current.router.dispose();
      current.store.close();
    } finally {
      await rm(durable.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });

  it("accepts only MAC-attested remote runners across a service bearer rotation", async () => {
    let now = 70_000;
    const durable = await createNativeRecoveryRun();
    try {
      const accountId = `remote-account-${randomUUID()}`;
      const credential = { type: "oauth", access: `remote-access-${randomUUID()}`, refresh: `remote-refresh-${randomUUID()}` };
      const nativeAuth: PiNativeAuthLeaseSource = {
        describe: () => ({ accountId, authGeneration: "remote-auth-1", catalogGeneration: 51, authenticated: true }),
        load: () => ({ catalogGeneration: 51, credentials: { "native-provider": credential } }),
        persist: async () => ({ catalogGeneration: 51 })
      };
      const first = await fixture({
        now: () => now,
        nativeAuthLeaseTtlMs: 15_000,
        nativeAuth,
        nativeAuthRecovery: nativeRecoveryFor(durable, () => now),
        trustedManagedRunnerScriptSha256: durable.runnerScriptSha256
      });
      const firstBridge = first.router.createPiBridgeSnapshot({
        endpoint: "http://127.0.0.1:4318/internal/mcp",
        expectedPiGeneration: 1,
        nativeAuthLease: {
          endpoint: "http://127.0.0.1:4318/internal/pi-native-auth",
          catalogGeneration: 51,
          providerIds: ["native-provider"],
          authenticatedProviderIds: ["native-provider"]
        }
      });
      const firstToken = firstBridge.mcpBridge.token;
      const scope = {
        generation: 1,
        runnerProductGeneration: 1,
        sessionId: "session-remote",
        targetId: "target-remote",
        providerId: "native-provider",
        catalogGeneration: 51,
        runId: durable.runId,
        runnerFence: durable.runnerFence
      } as const;

      // Foreground/parallel children use the ordinary in-memory lease path.
      // A remote target alone must not turn that path into durable recovery or
      // require runner attestation.
      const foregroundScope = {
        ...scope,
        runId: randomUUID(),
        runnerFence: randomUUID()
      } as const;
      await expect(first.router.executeNativeAuthLease({
        ...foregroundScope,
        authorization: `Bearer ${firstToken}`,
        action: "acquire"
      })).resolves.toEqual({ active: true, validForMs: 15_000, credential });
      await expect(first.router.executeNativeAuthLease({
        ...foregroundScope,
        authorization: `Bearer ${firstToken}`,
        action: "validate"
      })).resolves.toEqual({ active: true, validForMs: 15_000 });
      await expect(first.router.executeNativeAuthLease({
        ...foregroundScope,
        authorization: `Bearer ${firstToken}`,
        action: "release"
      })).resolves.toEqual({ active: false });

      // A remote PID that happens to equal a local process is never accepted
      // through the local inspector path.
      await expect(first.router.executeNativeAuthLease({
        ...scope,
        authorization: `Bearer ${firstToken}`,
        action: "acquire",
        recovery: { runnerPid: durable.runnerPid }
      })).rejects.toThrow(/attestation is unavailable/iu);

      const acquired = await first.router.executeNativeAuthLease({
        ...scope,
        authorization: `Bearer ${firstToken}`,
        action: "acquire",
        recovery: { runnerPid: durable.runnerPid },
        remoteRunnerAttestation: remoteAttestation(scope, "acquire", firstToken, durable)
      });
      expect(acquired).toMatchObject({ active: true, validForMs: 15_000, credential });
      const proof = acquired.recoveryProof!;
      await first.router.dispose();

      const restarted = new McpRouter({
        store: first.store,
        credentials: first.credentials,
        clientFactory: first.factory,
        resultArtifacts: first.artifacts,
        now: () => now,
        nativeAuthLeaseTtlMs: 15_000,
        nativeAuth,
        nativeAuthRecovery: nativeRecoveryFor(durable, () => now),
        trustedManagedRunnerScriptSha256: durable.runnerScriptSha256
      });
      await restarted.initialize();
      const secondBridge = restarted.createPiBridgeSnapshot({
        endpoint: "http://127.0.0.1:4318/internal/mcp",
        expectedPiGeneration: 1,
        nativeAuthLease: {
          endpoint: "http://127.0.0.1:4318/internal/pi-native-auth",
          catalogGeneration: 51,
          providerIds: ["native-provider"],
          authenticatedProviderIds: ["native-provider"]
        }
      });
      const secondToken = secondBridge.mcpBridge.token;
      expect(secondToken).not.toBe(firstToken);
      const forged = remoteAttestation(scope, "validate", firstToken, durable);
      await expect(restarted.executeNativeAuthLease({
        ...scope,
        authorization: `Bearer ${secondToken}`,
        action: "validate",
        recoveryProof: proof,
        remoteRunnerAttestation: forged
      })).rejects.toThrow(/attestation is invalid/iu);

      now += 1_000;
      const validateAttestation = remoteAttestation(scope, "validate", secondToken, durable);
      await expect(restarted.executeNativeAuthLease({
        ...scope,
        authorization: `Bearer ${secondToken}`,
        action: "validate",
        recoveryProof: proof,
        remoteRunnerAttestation: validateAttestation
      })).resolves.toEqual({ active: true, validForMs: 15_000 });
      await restarted.dispose();
      const restartedAgain = new McpRouter({
        store: first.store,
        credentials: first.credentials,
        clientFactory: first.factory,
        resultArtifacts: first.artifacts,
        now: () => now,
        nativeAuthLeaseTtlMs: 15_000,
        nativeAuth,
        nativeAuthRecovery: nativeRecoveryFor(durable, () => now),
        trustedManagedRunnerScriptSha256: durable.runnerScriptSha256
      });
      await restartedAgain.initialize();
      await expect(restartedAgain.executeNativeAuthLease({
        ...scope,
        authorization: `Bearer ${secondToken}`,
        action: "validate",
        recoveryProof: proof,
        remoteRunnerAttestation: validateAttestation
      })).rejects.toThrow(/replayed/iu);
      await expect(restartedAgain.executeNativeAuthLease({
        ...scope,
        authorization: `Bearer ${secondToken}`,
        action: "release",
        recoveryProof: proof,
        remoteRunnerAttestation: remoteAttestation(scope, "release", secondToken, durable)
      })).resolves.toEqual({ active: false });

      const catalog = await readFile(join(durable.stateRoot, "leases.json"), "utf8");
      for (const canary of [accountId, firstToken, secondToken, proof, credential.access, credential.refresh]) {
        expect(catalog).not.toContain(canary);
      }
      await restartedAgain.dispose();
      first.store.close();
    } finally {
      await rm(durable.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });

  it("preserves a complete tool description beyond sixteen KiB in the runtime snapshot", async () => {
    const { store, factory, router } = await fixture();
    const description = `description-start-${"x".repeat(16_384)}-description-end`;
    factory.toolDescription = description;

    const descriptor = await router.upsert({
      id: "long-description",
      displayName: "Long description MCP",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/rpc",
      enabled: true,
      credentialBindings: []
    });
    const bridge = router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp" });

    expect(descriptor.tools[0]?.description).toBe(description);
    expect(bridge.mcpBridge.tools.find((tool) => tool.serverId === "long-description")?.description)
      .toBe(description);
    bridge.revoke();
    await router.dispose();
    store.close();
  });

  it("discovers every tools/list page and makes a final-page tool callable from the frozen grant", async () => {
    const { store, factory, router } = await fixture();
    factory.listToolsHandler = async (cursor) => cursor === undefined
      ? { tools: [listedTool("page_one")], nextCursor: "page-2" }
      : cursor === "page-2"
        ? { tools: [listedTool("page_two")], nextCursor: "page-3" }
        : { tools: [listedTool("page_three")] };

    const descriptor = await router.upsert({
      id: "paged",
      displayName: "Paged MCP",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/rpc",
      enabled: true,
      credentialBindings: []
    });
    const bridge = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      expectedPiGeneration: 1
    });
    const result = await router.executeBridgeCall({
      ...bridgeScope(1),
      authorization: `Bearer ${bridge.mcpBridge.token}`,
      generation: 1,
      serverId: "paged",
      toolName: "page_three"
    });

    expect(descriptor).toMatchObject({
      state: "connected",
      tools: [{ name: "page_one" }, { name: "page_two" }, { name: "page_three" }]
    });
    expect(factory.listCursors).toEqual([undefined, "page-2", "page-3"]);
    expect(new Set(factory.listSignals).size).toBe(1);
    expect(factory.calledTools).toEqual(["page_three"]);
    expect(result).toMatchObject({ isError: false });
    bridge.revoke();
    await router.dispose();
    store.close();
  });

  it("fails the complete generation with a typed error when tools/list repeats a cursor", async () => {
    const { store, factory, router } = await fixture();
    factory.listToolsHandler = async (cursor) => ({
      tools: [listedTool(cursor === undefined ? "first" : "second")],
      nextCursor: "repeat"
    });

    const descriptor = await router.upsert({
      id: "cyclic",
      displayName: "Cyclic MCP",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/rpc",
      enabled: true,
      credentialBindings: []
    });
    const bridge = router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp" });

    expect(descriptor).toMatchObject({ state: "error", errorCode: "pagination_cycle", tools: [] });
    expect(factory.listCursors).toEqual([undefined, "repeat"]);
    expect(factory.closed).toContain(descriptor.runtimeGeneration);
    expect(bridge.mcpBridge.tools.some((tool) => tool.serverId === "cyclic")).toBe(false);
    bridge.revoke();
    await router.dispose();
    store.close();
  });

  it("uses one total timeout signal and aborts a stalled second tools/list page", async () => {
    const { store, factory, router } = await fixture({ toolDiscoveryPolicy: { timeoutMs: 25 } });
    factory.listToolsHandler = async (cursor, signal) => {
      if (cursor === undefined) return { tools: [listedTool("first")], nextCursor: "slow" };
      return await new Promise<McpToolListPage>((_resolve, reject) => {
        const abort = (): void => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    };

    const descriptor = await router.upsert({
      id: "slow",
      displayName: "Slow MCP",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/rpc",
      enabled: true,
      credentialBindings: []
    });

    expect(descriptor).toMatchObject({ state: "error", errorCode: "timed_out", tools: [] });
    expect(factory.listCursors).toEqual([undefined, "slow"]);
    expect(new Set(factory.listSignals).size).toBe(1);
    expect(factory.listSignals[0]?.aborted).toBe(true);
    expect(factory.closed).toContain(descriptor.runtimeGeneration);
    await router.dispose();
    store.close();
  });

  it("rejects page, tool, and aggregate JSON budget overflow without publishing a partial catalog", async () => {
    const cases: readonly {
      readonly id: string;
      readonly policy: NonNullable<McpRouterOptions["toolDiscoveryPolicy"]>;
      readonly expectedCode: "page_limit" | "tool_limit" | "catalog_too_large";
      readonly handler: (cursor: string | undefined) => Promise<McpToolListPage>;
    }[] = [{
      id: "pages",
      policy: { maximumPages: 2 },
      expectedCode: "page_limit",
      handler: async (cursor) => ({
        tools: [listedTool(cursor ?? "first")],
        nextCursor: cursor === undefined ? "second" : "third"
      })
    }, {
      id: "tools",
      policy: { maximumTools: 2 },
      expectedCode: "tool_limit",
      handler: async () => ({ tools: [listedTool("one"), listedTool("two"), listedTool("three")] })
    }, {
      id: "bytes",
      policy: { maximumBytes: 600 },
      expectedCode: "catalog_too_large",
      handler: async (cursor) => cursor === undefined
        ? { tools: [listedTool("small")], nextCursor: "large" }
        : { tools: [listedTool("large", "x".repeat(1_000))] }
    }];

    for (const testCase of cases) {
      const { store, factory, router } = await fixture({ toolDiscoveryPolicy: testCase.policy });
      factory.listToolsHandler = testCase.handler;
      const descriptor = await router.upsert({
        id: testCase.id,
        displayName: `${testCase.id} MCP`,
        transport: "streamable_http",
        endpoint: `https://${testCase.id}.example.test/rpc`,
        enabled: true,
        credentialBindings: []
      });
      const bridge = router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp" });
      expect(descriptor).toMatchObject({ state: "error", errorCode: testCase.expectedCode, tools: [] });
      expect(bridge.mcpBridge.tools.some((tool) => tool.serverId === testCase.id)).toBe(false);
      expect(factory.closed).toContain(descriptor.runtimeGeneration);
      bridge.revoke();
      await router.dispose();
      store.close();
    }
  });

  it("resolves header references only at transport creation and never persists the value", async () => {
    const { store, factory, router } = await fixture();
    const descriptor = await router.upsert({
      id: "search",
      displayName: "Search MCP",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/rpc",
      enabled: true,
      credentialBindings: [
        { target: "header", name: "Authorization", credentialReferenceId: "cred_mcp_header" },
        { target: "header", name: "X-Tenant", credentialReferenceId: "cred_mcp_tenant" }
      ]
    });

    expect(descriptor).toMatchObject({ state: "connected", tools: [{ name: "echo" }] });
    expect(descriptor.credentialBindings).toEqual([
      { target: "header", name: "Authorization", credentialReferenceId: "cred_mcp_header", configured: true },
      { target: "header", name: "X-Tenant", credentialReferenceId: "cred_mcp_tenant", configured: true }
    ]);
    expect(descriptor.configuration).toEqual({ case: "streamableHttp", endpoint: "https://mcp.example.test/rpc" });
    expect(factory.inputs[0]?.credentials).toEqual({
      "header:Authorization": "mcp-header-secret-value",
      "header:X-Tenant": "mcp-tenant-secret-value"
    });
    expect(stringify(store.listSettings())).not.toContain("mcp-header-secret-value");
    expect(stringify(store.listSettings())).not.toContain("mcp-tenant-secret-value");
    expect(stringify(router.list())).not.toContain("mcp-header-secret-value");
    expect(stringify(router.list())).not.toContain("mcp-tenant-secret-value");
    await router.dispose();
    store.close();
  });

  it("fences create and edit upserts against the exact saved revision", async () => {
    const { store, router } = await fixture();
    const input = {
      id: "search",
      displayName: "Search MCP",
      transport: "streamable_http" as const,
      endpoint: "https://mcp.example.test/rpc",
      enabled: false,
      credentialBindings: []
    };
    const first = await router.upsert(input, 0n);
    await expect(router.upsert({ ...input, displayName: "Unexpected overwrite" }, 0n)).rejects.toThrow(/concurrently/u);
    const second = await router.upsert({ ...input, displayName: "Edited" }, first.version);
    await expect(router.upsert({ ...input, displayName: "Stale edit" }, first.version)).rejects.toThrow(/concurrently/u);
    expect(router.get("search")).toMatchObject({ id: "search", displayName: "Edited", version: second.version });
    await router.dispose();
    store.close();
  });

  it("pins bridge grants to MCP runtime generations across updates", async () => {
    const { store, router, factory } = await fixture();
    const first = await router.upsert({
      id: "search",
      displayName: "Search MCP",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/rpc",
      enabled: true,
      credentialBindings: []
    });
    const oldBridge = router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp" });
    const second = await router.upsert({
      id: "search",
      displayName: "Search MCP v2",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/v2/rpc",
      enabled: true,
      credentialBindings: []
    }, first.version);
    const newBridge = router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp", expectedPiGeneration: 7 });

    const oldResult = await router.executeBridgeCall({
      ...bridgeScope(99),
      authorization: `Bearer ${oldBridge.mcpBridge.token}`,
      generation: 99,
      serverId: "search",
      toolName: "echo",
      arguments: { value: "old" }
    });
    const newResult = await router.executeBridgeCall({
      ...bridgeScope(7),
      authorization: `Bearer ${newBridge.mcpBridge.token}`,
      generation: 7,
      serverId: "search",
      toolName: "echo",
      arguments: { value: "new" }
    });

    expect(JSON.stringify(oldResult.content)).toContain(`${first.runtimeGeneration}:old`);
    expect(JSON.stringify(newResult.content)).toContain(`${second.runtimeGeneration}:new`);
    await expect(router.executeBridgeCall({
      ...bridgeScope(8),
      authorization: `Bearer ${newBridge.mcpBridge.token}`,
      generation: 8,
      serverId: "search",
      toolName: "echo"
    })).rejects.toThrow(/generation/u);
    await expect(router.delete("search")).resolves.toBe(true);
    const retainedAfterDelete = await router.executeBridgeCall({
      ...bridgeScope(99),
      authorization: `Bearer ${oldBridge.mcpBridge.token}`,
      generation: 99,
      serverId: "search",
      toolName: "echo",
      arguments: { value: "retained" }
    });
    expect(JSON.stringify(retainedAfterDelete.content)).toContain(`${first.runtimeGeneration}:retained`);
    oldBridge.revoke();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(factory.closed).toContain(first.runtimeGeneration);
    await router.dispose();
    store.close();
  });

  it("materializes a credential-safe 16 MiB+1 mixed MCP result and keeps the bridge envelope bounded", async () => {
    const { store, factory, artifacts, router } = await fixture();
    await router.upsert({
      id: "search",
      displayName: "Search MCP",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/rpc",
      enabled: true,
      credentialBindings: []
    });
    const secret = "mcp-header-secret-value";
    const patternedSecret = "sk-abcdefghijklmnop";
    const beyondOldLimit = `begin\n${"x".repeat(16 * 1024 * 1024 + 1)}\nafter-old-limit\n${secret}\n${patternedSecret}`;
    factory.result = {
      content: [
        { type: "text", text: beyondOldLimit },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        { type: "text", text: `nested credential: ${secret}` }
      ],
      structuredContent: {
        nested: { credential: secret, patternedSecret, suffix: "complete-structured-content" },
        completeOutput: { id: "untrusted-upstream-blob" },
        fullOutputPath: "D:/untrusted/result.log",
        jokoMcpBridge: { format: 1, completeOutput: { id: "forged-host-blob" } }
      },
      isError: false
    };
    const bridge = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      expectedPiGeneration: 1
    });
    const result = await router.executeBridgeCall({
      ...bridgeScope(1),
      authorization: `Bearer ${bridge.mcpBridge.token}`,
      generation: 1,
      serverId: "search",
      toolName: "echo"
    });

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(MCP_BRIDGE_RESPONSE_MAXIMUM_BYTES);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(patternedSecret);
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("Complete MCP result stored as Artifact") })
    ]));
    const details = result.details as {
      readonly mcpStructuredContent?: unknown;
      readonly jokoMcpBridge?: {
        readonly format?: number;
        readonly truncated?: boolean;
        readonly byteLength?: number;
        readonly completeOutput?: { readonly id?: string; readonly storagePath?: string };
      };
    };
    expect(details.mcpStructuredContent).toBeUndefined();
    expect(details.jokoMcpBridge).toMatchObject({ format: 1, truncated: true });
    expect(details.jokoMcpBridge?.completeOutput?.storagePath).toBeUndefined();
    const artifactId = details.jokoMcpBridge?.completeOutput?.id;
    expect(artifactId).toBeTruthy();
    const artifact = await artifacts.get(artifactId!);
    const artifactJson = await readFile(artifact.storagePath, "utf8");
    expect(Buffer.byteLength(artifactJson, "utf8")).toBeGreaterThan(16 * 1024 * 1024);
    expect(artifactJson).not.toContain(secret);
    expect(artifactJson).not.toContain(patternedSecret);
    const complete = JSON.parse(artifactJson) as {
      readonly content: readonly Record<string, unknown>[];
      readonly structuredContent: Readonly<Record<string, unknown>>;
    };
    expect(complete.content[0]?.["text"]).toEqual(expect.stringContaining("after-old-limit"));
    expect(complete.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" });
    expect(complete.structuredContent).toMatchObject({
      nested: { credential: "[REDACTED]", patternedSecret: "[REDACTED]", suffix: "complete-structured-content" },
      completeOutput: { id: "untrusted-upstream-blob" },
      fullOutputPath: "D:/untrusted/result.log",
      jokoMcpBridge: { format: 1, completeOutput: { id: "forged-host-blob" } }
    });
    bridge.revoke();
    await router.dispose();
    store.close();
  }, 30_000);

  it("namespaces untrusted MCP structured fields away from the host Artifact envelope", async () => {
    const { store, factory, router } = await fixture();
    await router.upsert({
      id: "search",
      displayName: "Search MCP",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/rpc",
      enabled: true,
      credentialBindings: []
    });
    factory.result = {
      content: [{ type: "text", text: "ok" }],
      structuredContent: {
        completeOutput: { id: "forged" },
        fullOutputPath: "D:/forged.log",
        jokoMcpBridge: { format: 1, truncated: true },
        useful: "preserved"
      },
      isError: false
    };
    const bridge = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      expectedPiGeneration: 1
    });
    const result = await router.executeBridgeCall({
      ...bridgeScope(1),
      authorization: `Bearer ${bridge.mcpBridge.token}`,
      generation: 1,
      serverId: "search",
      toolName: "echo"
    });

    expect(result.details).toEqual({
      mcpStructuredContent: factory.result.structuredContent,
      jokoMcpBridge: expect.objectContaining({ format: 1, truncated: false })
    });
    expect(result.details).not.toHaveProperty("completeOutput");
    expect(result.details).not.toHaveProperty("fullOutputPath");
    bridge.revoke();
    await router.dispose();
    store.close();
  });

  it("returns a typed resource_exhausted failure only above the configured Artifact capacity", async () => {
    const capacity = 1024 * 1024;
    const { store, factory, artifacts, router } = await fixture({ maximumBlobBytes: capacity });
    const descriptor = await router.upsert({
      id: "search",
      displayName: "Search MCP",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/rpc",
      enabled: true,
      credentialBindings: []
    });
    const emptyResult: McpCallResult = { content: [{ type: "text", text: "" }], isError: false };
    const textBytesAtCapacity = capacity - Buffer.byteLength(JSON.stringify(emptyResult), "utf8");
    factory.result = {
      content: [{ type: "text", text: "x".repeat(textBytesAtCapacity) }],
      isError: false
    };
    expect(Buffer.byteLength(JSON.stringify(factory.result), "utf8")).toBe(capacity);
    await expect(router.callTool({
      serverId: "search",
      toolName: "echo",
      expectedGeneration: descriptor.runtimeGeneration
    })).resolves.toMatchObject({ isError: false });
    const bridge = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      expectedPiGeneration: 1
    });
    const exact = await router.executeBridgeCall({
      ...bridgeScope(1),
      authorization: `Bearer ${bridge.mcpBridge.token}`,
      generation: 1,
      serverId: "search",
      toolName: "echo"
    });
    const exactArtifactId = ((exact.details?.["jokoMcpBridge"] as {
      readonly completeOutput?: { readonly id?: string };
    } | undefined)?.completeOutput?.id);
    expect(exactArtifactId).toBeTruthy();
    await expect(artifacts.get(exactArtifactId!)).resolves.toMatchObject({ byteLength: capacity });

    factory.result = {
      content: [{ type: "text", text: "x".repeat(textBytesAtCapacity + 1) }],
      isError: false
    };
    expect(Buffer.byteLength(JSON.stringify(factory.result), "utf8")).toBe(capacity + 1);
    await expect(router.callTool({
      serverId: "search",
      toolName: "echo",
      expectedGeneration: descriptor.runtimeGeneration
    })).rejects.toMatchObject({ code: "resource_exhausted" });
    await expect(router.executeBridgeCall({
      ...bridgeScope(1),
      authorization: `Bearer ${bridge.mcpBridge.token}`,
      generation: 1,
      serverId: "search",
      toolName: "echo"
    })).resolves.toMatchObject({
      content: [],
      isError: true,
      errorCode: "resource_exhausted",
      error: expect.stringContaining("Artifact capacity")
    });
    expect(store.listArtifacts({ limit: 10 })).toHaveLength(1);
    bridge.revoke();
    await router.dispose();
    store.close();
  });

  it("renews the same immutable bridge grant without rotating its token or runtime snapshot", async () => {
    let now = 10_000;
    const { store, router } = await fixture({ now: () => now, bridgeGrantTtlMs: 1_000 });
    await router.upsert({
      id: "search",
      displayName: "Search MCP",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/rpc",
      enabled: true,
      credentialBindings: []
    });
    const bridge = router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp" });
    const token = bridge.mcpBridge.token;
    now = 10_900;
    expect(bridge.renew()).toBe(11_900);
    expect(bridge.mcpBridge.token).toBe(token);
    now = 11_100;
    await expect(router.executeBridgeCall({
      ...bridgeScope(1),
      authorization: `Bearer ${token}`,
      generation: 1,
      serverId: "search",
      toolName: "echo"
    })).resolves.toMatchObject({ isError: false });
    bridge.revoke();
    await router.dispose();
    store.close();
  });

  it("fails closed on unsafe endpoints and invalid bridge credentials", async () => {
    const { store, router } = await fixture();
    await expect(router.upsert({
      id: "unsafe",
      displayName: "Unsafe",
      transport: "streamable_http",
      endpoint: "http://example.com/rpc?token=secret",
      enabled: true,
      credentialBindings: []
    })).rejects.toThrow(/HTTPS|query|unsafe/u);
    const snapshot = router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp" });
    await expect(router.executeBridgeCall({
      ...bridgeScope(1),
      authorization: "Bearer invalid-invalid-invalid-invalid-invalid-invalid",
      generation: 1,
      serverId: "missing",
      toolName: "missing"
    })).rejects.toThrow(/credential/u);
    snapshot.revoke();
    await router.dispose();
    store.close();
  });

  it("pins service-owned bridge tools to their provider generation without persisting them as MCP", async () => {
    const { store, router } = await fixture();
    let generation = 3;
    let available = true;
    const calls: string[] = [];
    const provider: BridgeToolProvider = {
      id: "joko_browser",
      get generation() { return generation; },
      get available() { return available; },
      tools: [{
        serverId: "joko_browser",
        name: "list_tools",
        description: "Discover nested tools",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        requiresPermission: true
      }, {
        serverId: "joko_browser",
        name: "call_tool",
        description: "Call a nested tool",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        requiresPermission: true
      }],
      async callTool(name) {
        calls.push(`${generation}:${name}`);
        return { content: [{ type: "text", text: String(generation) }], isError: false };
      }
    };
    const unregister = router.registerBridgeToolProvider(provider);
    const oldBridge = router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp" });

    expect(oldBridge.mcpBridge.tools.filter((tool) => tool.serverId === "joko_browser").map((tool) => tool.name))
      .toEqual(["call_tool", "list_tools"]);
    expect(oldBridge.mcpBridge.tools.filter((tool) => tool.serverId === "joko_browser")
      .map((tool) => [tool.name, tool.requiresPermission])).toEqual([
        ["call_tool", true],
        ["list_tools", true]
      ]);
    expect(router.list()).toEqual([]);
    expect(stringify(store.listSettings())).not.toContain("joko_browser");
    expect(await router.executeBridgeCall({
      ...bridgeScope(1),
      authorization: `Bearer ${oldBridge.mcpBridge.token}`,
      generation: 1,
      serverId: "joko_browser",
      toolName: "list_tools"
    })).toMatchObject({ isError: false, content: [{ text: "3" }] });
    await expect(router.executeBridgeCall({
      ...bridgeScope(1),
      authorization: `Bearer ${oldBridge.mcpBridge.token}`,
      generation: 1,
      serverId: "joko_browser",
      toolName: "list_pages"
    })).rejects.toThrow(/snapshot/u);

    generation = 4;
    expect(await router.executeBridgeCall({
      ...bridgeScope(1),
      authorization: `Bearer ${oldBridge.mcpBridge.token}`,
      generation: 1,
      serverId: "joko_browser",
      toolName: "list_tools"
    })).toMatchObject({ isError: true });
    const newBridge = router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp" });
    expect(await router.executeBridgeCall({
      ...bridgeScope(2),
      authorization: `Bearer ${newBridge.mcpBridge.token}`,
      generation: 2,
      serverId: "joko_browser",
      toolName: "list_tools"
    })).toMatchObject({ isError: false, content: [{ text: "4" }] });
    available = false;
    expect(router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp" }).mcpBridge.tools).toEqual([]);
    expect(calls).toEqual(["3:list_tools", "4:list_tools"]);
    unregister();
    await expect(router.executeBridgeCall({
      ...bridgeScope(2),
      authorization: `Bearer ${newBridge.mcpBridge.token}`,
      generation: 2,
      serverId: "joko_browser",
      toolName: "list_tools"
    })).rejects.toThrow(/credential/u);
    await router.dispose();
    store.close();
  });

  it("binds Browser grants and stable request/effect identities to one product scope", async () => {
    const { store, router } = await fixture();
    const contexts: Array<Parameters<BridgeToolProvider["callTool"]>[3]> = [];
    const provider: BridgeToolProvider = {
      id: "joko_browser_authority",
      generation: 3,
      available: true,
      policySubject: "browser",
      includeForTarget: (targetId) => targetId === "target-1",
      tools: [{
        serverId: "joko_browser_authority",
        name: "open",
        description: "Open one owned page",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        requiresPermission: true
      }],
      async callTool(_name, _arguments, _signal, context) {
        contexts.push(context);
        return { content: [{ type: "text", text: "ok" }], isError: false };
      }
    };
    router.registerBridgeToolProvider(provider);
    const grant = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      sessionId: "session-1",
      targetId: "target-1",
      expectedPiGeneration: 1
    });
    const call = (arguments_: Readonly<Record<string, unknown>>) => router.executeBridgeCall({
      authorization: `Bearer ${grant.mcpBridge.token}`,
      requestId: "native-call-stable",
      generation: 1,
      sessionId: "session-1",
      targetId: "target-1",
      serverId: provider.id,
      toolName: "open",
      arguments: arguments_
    });

    await call({ value: "credential-canary" });
    await call({ value: "credential-canary" });
    await call({ value: "changed" });
    const recreatedGrant = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      sessionId: "session-1",
      targetId: "target-1",
      expectedPiGeneration: 1
    });
    expect(recreatedGrant.mcpBridge.token).not.toBe(grant.mcpBridge.token);
    await router.executeBridgeCall({
      authorization: `Bearer ${recreatedGrant.mcpBridge.token}`,
      requestId: "native-call-stable",
      generation: 1,
      sessionId: "session-1",
      targetId: "target-1",
      serverId: provider.id,
      toolName: "open",
      arguments: { value: "credential-canary" }
    });

    expect(contexts[0]).toMatchObject({
      sessionId: "session-1",
      targetId: "target-1",
      generation: 1,
      providerGeneration: 3
    });
    expect(contexts[0]?.requestIdentity).toBe(contexts[1]?.requestIdentity);
    expect(contexts[0]?.effectIdentity).toBe(contexts[1]?.effectIdentity);
    expect(contexts[0]?.requestIdentity).toBe(contexts[2]?.requestIdentity);
    expect(contexts[0]?.effectIdentity).not.toBe(contexts[2]?.effectIdentity);
    expect(contexts[0]?.requestIdentity).toBe(contexts[3]?.requestIdentity);
    expect(contexts[0]?.effectIdentity).toBe(contexts[3]?.effectIdentity);
    expect(JSON.stringify(contexts)).not.toContain("credential-canary");
    await expect(router.executeBridgeCall({
      authorization: `Bearer ${grant.mcpBridge.token}`,
      requestId: "native-call-cross-scope",
      generation: 1,
      sessionId: "session-1",
      targetId: "target-remote",
      serverId: provider.id,
      toolName: "open"
    })).rejects.toThrow(/another product scope/u);
    recreatedGrant.revoke();
    grant.revoke();
    await router.dispose();
    store.close();
  });

  it("projects Provider-owned ordinary policy metadata and filters only new grants", async () => {
    const { store, router } = await fixture();
    const provider: BridgeToolProvider = {
      id: "joko_remote_tools",
      generation: 1,
      available: true,
      configurablePolicy: {
        id: "joko-remote-policy",
        displayName: "Remote Host",
        description: "Use configured remote hosts.",
        productDefaultEnabled: true
      },
      tools: [{
        serverId: "joko_remote_tools",
        name: "remote_list",
        description: "List remote hosts",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        requiresPermission: false
      }],
      async callTool() {
        return { content: [{ type: "text", text: "ok" }], isError: false };
      }
    };
    router.registerBridgeToolProvider(provider);

    expect(router.toolPolicyDeclarations()).toEqual([provider.configurablePolicy]);
    const active = router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp" });
    const disabled = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      includeToolPolicy: () => false
    });
    expect(active.mcpBridge.tools.some((tool) => tool.serverId === provider.id)).toBe(true);
    expect(disabled.mcpBridge.tools.some((tool) => tool.serverId === provider.id)).toBe(false);

    active.revoke();
    disabled.revoke();
    await router.dispose();
    store.close();
  });

  it("samples target-scoped Browser access only for new grants while a live Session keeps its frozen generation", async () => {
    const { store, router } = await fixture();
    let enabled = true;
    const calls: string[] = [];
    const provider: BridgeToolProvider = {
      id: "joko_browser",
      generation: 3,
      available: true,
      includeForTarget: (targetId) => targetId === "target-1" && enabled,
      tools: [{
        serverId: "joko_browser",
        name: "list_tools",
        description: "Discover nested tools",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        requiresPermission: true
      }, {
        serverId: "joko_browser",
        name: "call_tool",
        description: "Call a nested tool",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        requiresPermission: true
      }],
      async callTool(name) {
        calls.push(name);
        return { content: [{ type: "text", text: "ok" }], isError: false };
      }
    };
    router.registerBridgeToolProvider(provider);
    const active = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      targetId: "target-1",
      expectedPiGeneration: 7
    });
    expect(active.mcpBridge.tools.filter((tool) => tool.serverId === provider.id).map((tool) => tool.name))
      .toEqual(["call_tool", "list_tools"]);
    expect(active.mcpBridge.tools.filter((tool) => tool.serverId === provider.id)
      .map((tool) => [tool.name, tool.requiresPermission])).toEqual([
        ["call_tool", true],
        ["list_tools", true]
      ]);

    enabled = false;
    const next = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      targetId: "target-1",
      expectedPiGeneration: 8
    });
    expect(next.mcpBridge.tools.filter((tool) => tool.serverId === provider.id)).toEqual([]);
    await expect(router.executeBridgeCall({
      ...bridgeScope(7),
      authorization: `Bearer ${active.mcpBridge.token}`,
      generation: 7,
      serverId: provider.id,
      toolName: "list_tools"
    })).resolves.toMatchObject({ isError: false });
    await expect(router.executeBridgeCall({
      ...bridgeScope(8),
      authorization: `Bearer ${next.mcpBridge.token}`,
      generation: 8,
      serverId: provider.id,
      toolName: "list_tools"
    })).rejects.toThrow(/snapshot/u);
    expect(calls).toEqual(["list_tools"]);
    await router.dispose();
    store.close();
  });

  it("keeps a disabled Android provider callable only through an already-frozen two-tool grant", async () => {
    const { store, router } = await fixture();
    let enabled = true;
    const calls: Array<{ readonly sessionId: string; readonly name: string }> = [];
    const descriptors: readonly AndroidToolDescriptor[] = ANDROID_TOOL_NAMES.map((name, index) => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        readOnlyHint: index < 3,
        destructiveHint: false,
        openWorldHint: false
      }
    }));
    const provider = {
      listTools: () => descriptors,
      callTool: async (sessionId: string, name: string) => {
        calls.push({ sessionId, name });
        return { content: [{ type: "text" as const, text: '{"ok":true}' }] };
      },
      closeSession: () => undefined
    } as unknown as AndroidToolProvider;
    const bridge = new AndroidToolBridgeProvider({
      provider: () => provider,
      enabledForNewSessions: () => enabled
    });
    const unregister = router.registerBridgeToolProvider(bridge);
    const frozen = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      expectedPiGeneration: 1,
      targetId: "target-1"
    });
    expect(frozen.mcpBridge.tools.filter(({ serverId }) => serverId === ANDROID_BRIDGE_PROVIDER_ID)
      .map(({ name }) => name)).toEqual(["call_tool", "list_tools"]);

    enabled = false;
    const next = router.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      expectedPiGeneration: 2,
      targetId: "target-1"
    });
    expect(next.mcpBridge.tools.some(({ serverId }) => serverId === ANDROID_BRIDGE_PROVIDER_ID)).toBe(false);
    expect(await router.executeBridgeCall({
      ...bridgeScope(1),
      authorization: `Bearer ${frozen.mcpBridge.token}`,
      generation: 1,
      serverId: ANDROID_BRIDGE_PROVIDER_ID,
      toolName: "call_tool",
      arguments: { name: "status", args: {} }
    })).toMatchObject({ isError: false, content: [{ text: '{"ok":true}' }] });
    expect(calls).toEqual([{ sessionId: "session-1", name: "status" }]);

    frozen.revoke();
    next.revoke();
    unregister();
    await router.dispose();
    store.close();
  });
});

interface NativeRecoveryRunFixture {
  readonly root: string;
  readonly runRoot: string;
  readonly stateRoot: string;
  readonly runId: string;
  readonly runnerFence: string;
  readonly runnerPid: number;
  readonly runnerScriptSha256: string;
  readonly processIdentity: string;
  readonly runnerScript: string;
  readonly configPath: string;
  readonly trustedNodeExecutable: string;
}

async function createNativeRecoveryRun(): Promise<NativeRecoveryRunFixture> {
  const root = await mkdtemp(join(tmpdir(), "joko-mcp-restart-"));
  const agentHome = join(root, "agent-home");
  const runRoot = managedSubagentRunRoot(agentHome);
  const runId = randomUUID();
  const runnerFence = randomUUID();
  const runnerPid = process.pid;
  const sessionDirectory = join(runRoot, managedSubagentSessionKey("session-1"));
  const runDirectory = join(sessionDirectory, runId);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const runnerScript = join(runDirectory, "joko-managed-subagent-runner.cjs");
  const runnerSource = `"use strict";\n// ${runId}\n`;
  const runnerScriptSha256 = createHash("sha256").update(runnerSource).digest("hex");
  const launchToken = randomUUID();
  const common = {
    format: 1,
    runId,
    launchToken,
    productSessionId: "session-1",
    taskId: `task-${runId}`,
    runnerScript,
    runnerScriptSha256
  };
  await Promise.all([
    writeFile(runnerScript, runnerSource, { encoding: "utf8", mode: 0o600 }),
    writeFile(join(runDirectory, "config.json"), `${JSON.stringify({
      ...common,
      runDir: runDirectory,
      productGeneration: 1,
      nativeAuthRequired: true,
      route: { provider: "native-provider" }
    })}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(join(runDirectory, "status.json"), `${JSON.stringify({
      ...common,
      state: "running",
      runnerPid,
      runnerInstanceId: runnerFence
    })}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(join(runDirectory, "owner.json"), `${JSON.stringify({
      ...common,
      state: "running",
      runnerPid,
      runnerInstanceId: runnerFence
    })}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(join(runDirectory, "runner.claim.json"), `${JSON.stringify({
      ...common,
      runnerPid,
      runnerInstanceId: runnerFence
    })}\n`, { encoding: "utf8", mode: 0o600 })
  ]);
  return {
    root,
    runRoot,
    stateRoot: join(agentHome, "subagent-auth-recovery"),
    runId,
    runnerFence,
    runnerPid,
    runnerScriptSha256,
    processIdentity: "d".repeat(64),
    runnerScript,
    configPath: join(runDirectory, "config.json"),
    trustedNodeExecutable: await realpath(process.execPath)
  };
}

function nativeRecoveryFor(
  fixture: NativeRecoveryRunFixture,
  now: () => number,
  processInspectionAvailable = true
): NativeAuthRecoveryPort {
  return new NativeAuthRecoveryStore({
    runRoot: fixture.runRoot,
    stateRoot: fixture.stateRoot,
    now,
    trustedRunnerScriptSha256: fixture.runnerScriptSha256,
    trustedNodeExecutable: fixture.trustedNodeExecutable,
    inspectRunnerProcess: async (pid) => processInspectionAvailable && pid === fixture.runnerPid ? {
      executablePath: fixture.trustedNodeExecutable,
      argv: [fixture.trustedNodeExecutable, fixture.runnerScript, fixture.configPath],
      processIdentity: fixture.processIdentity
    } : undefined
  });
}

async function bindSignedNativeRecoveryRun(
  fixture: NativeRecoveryRunFixture,
  reservationId: string,
  publicKey: string,
  publicKeyDigest: string
): Promise<void> {
  const directory = join(fixture.runRoot, managedSubagentSessionKey("session-1"), fixture.runId);
  for (const name of ["config.json", "status.json", "owner.json", "runner.claim.json"]) {
    const path = join(directory, name);
    const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({
      ...manifest,
      nativeAuthReservationId: reservationId,
      runnerPublicKeyDigest: publicKeyDigest,
      ...(name === "config.json" ? {
        nativeAuthServiceGeneration: 1,
        runnerPublicKey: publicKey
      } : {})
    })}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function signedRouterProof(
  scope: {
    readonly generation: number;
    readonly runnerProductGeneration: number;
    readonly sessionId: string;
    readonly targetId: string;
    readonly providerId: string;
    readonly catalogGeneration: number;
    readonly runId: string;
    readonly runnerFence: string;
  },
  runner: {
    readonly reservationId: string;
    readonly privateKey: KeyObject;
    readonly runnerPid: number;
  },
  action: "acquire" | "validate" | "release",
  recoveryProof?: string,
  credential?: unknown
) {
  const nonce = randomBytes(32).toString("base64url");
  const credentialDigest = createHash("sha256").update(
    credential === undefined ? "" : JSON.stringify(credential)
  ).digest("hex");
  const message = JSON.stringify([
    "joko.pi-native-auth.runner-proof.v1",
    action,
    runner.reservationId,
    scope.sessionId,
    scope.targetId,
    scope.generation,
    scope.runnerProductGeneration,
    scope.providerId,
    scope.catalogGeneration,
    scope.runId,
    scope.runnerFence,
    runner.runnerPid,
    recoveryProof ?? "",
    credentialDigest,
    nonce
  ]);
  return {
    format: 1 as const,
    reservationId: runner.reservationId,
    runnerPid: runner.runnerPid,
    nonce,
    signature: sign(null, Buffer.from(message, "utf8"), runner.privateKey).toString("base64url")
  };
}

function remoteAttestation(
  scope: {
    readonly generation: number;
    readonly runnerProductGeneration: number;
    readonly sessionId: string;
    readonly targetId: string;
    readonly providerId: string;
    readonly catalogGeneration: number;
    readonly runId: string;
    readonly runnerFence: string;
  },
  action: "acquire" | "validate" | "release",
  bearer: string,
  fixture: NativeRecoveryRunFixture
): RemoteNativeAuthRunnerAttestation {
  const recoveryScope = {
    sessionId: scope.sessionId,
    targetId: scope.targetId,
    serviceGeneration: scope.generation,
    runnerProductGeneration: scope.runnerProductGeneration,
    providerId: scope.providerId,
    catalogGeneration: scope.catalogGeneration,
    runId: scope.runId,
    runnerFence: scope.runnerFence
  } as const;
  const bindingDigest = recoveryBindingDigest(recoveryScope);
  const nonce = createHash("sha256").update(randomUUID()).digest("base64url");
  const issuedAt = Date.now();
  const runRootDigest = "1".repeat(64);
  const configDigest = "2".repeat(64);
  const statusDigest = createHash("sha256").update(randomUUID()).digest("hex");
  const ownerDigest = "3".repeat(64);
  const claimDigest = "4".repeat(64);
  const message = JSON.stringify([
    "joko.pi-native-auth.remote-runner.attestation.v1",
    action,
    scope.sessionId,
    scope.targetId,
    scope.providerId,
    scope.catalogGeneration,
    scope.generation,
    scope.runnerProductGeneration,
    scope.runId,
    scope.runnerFence,
    bindingDigest,
    fixture.runnerPid,
    fixture.processIdentity,
    runRootDigest,
    fixture.runnerScriptSha256,
    configDigest,
    statusDigest,
    ownerDigest,
    claimDigest,
    issuedAt,
    nonce
  ]);
  return {
    format: 1,
    action,
    issuedAt,
    nonce,
    bindingDigest,
    runnerPid: fixture.runnerPid,
    processIdentity: fixture.processIdentity,
    runRootDigest,
    runnerScriptDigest: fixture.runnerScriptSha256,
    configDigest,
    statusDigest,
    ownerDigest,
    claimDigest,
    mac: createHmac("sha256", bearer).update(message, "utf8").digest("base64url")
  };
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
}

function listedTool(name: string, description = name) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  } as const;
}

function bridgeScope(generation: number) {
  return { requestId: randomUUID(), sessionId: `session-${generation}`, targetId: "target-1" } as const;
}

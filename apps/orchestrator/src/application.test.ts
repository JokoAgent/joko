import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexBackendAdapter } from "@joko/adapter-codex";
import { PiBackendAdapter } from "@joko/adapter-pi";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  availableBackendProviderIds,
  composeCodeHostProviders,
  composeSessionContextDefaultsResolver,
  createOrchestratorApplication,
  providerUsageMoneyKind
} from "./application.js";
import { BackendInstanceRegistry } from "./backend-instance-registry.js";
import type { OrchestratorConfig } from "./config.js";
import { ManagedProviderProxy } from "./managed-provider-proxy.js";
import { createInternalServer, createPublicServer } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Orchestrator application composition", () => {
  it("uses a managed Provider catalog only for its declaring Backend and isolates native Provider state", () => {
    const provider = (
      providerId: string,
      authenticationState: "authenticated" | "not_required" | "signed_out"
    ) => ({
      providerId,
      displayName: providerId,
      api: "test",
      authenticationState,
      loginMethods: [],
      supportsLogin: false,
      supportsLogout: false,
      supportsRefresh: true,
      supportsModelRefresh: true
    });
    const managedCatalog = [
      { provider: { id: "managed-authenticated" }, enabled: true, authenticationState: "authenticated" as const },
      { provider: { id: "managed-keyless" }, enabled: true, authenticationState: "not_required" as const },
      { provider: { id: "managed-disabled" }, enabled: false, authenticationState: "authenticated" as const },
      { provider: { id: "managed-signed-out" }, enabled: true, authenticationState: "signed_out" as const },
      { provider: { id: "managed-route-disabled" }, enabled: true, authenticationState: "authenticated" as const }
    ].map((entry) => ({ ...entry, backendId: "managed" }));
    managedCatalog.push({ backendId: "other", provider: { id: "foreign-only" }, enabled: true, authenticationState: "authenticated" });
    const managedBackend = availableBackendProviderIds({
      id: "managed",
      providers: [provider("native-authenticated", "authenticated"), provider("managed-disabled", "authenticated")],
      capabilities: new Map([["provider.managed_catalog", {
        key: "provider.managed_catalog",
        supported: true
      }]])
    }, managedCatalog, (providerId) => providerId !== "managed-route-disabled");
    const signedOutNativeBackend = availableBackendProviderIds({
      id: "native",
      capabilities: new Map(),
      providers: [
        provider("shared-provider", "signed_out")
      ]
    }, managedCatalog);
    const authenticatedNativeBackend = availableBackendProviderIds({
      id: "native",
      capabilities: new Map(),
      providers: [
        provider("shared-provider", "authenticated"),
        provider("local", "not_required"),
        provider("native-route-disabled", "authenticated")
      ]
    }, [{ backendId: "managed", provider: { id: "shared-provider" }, enabled: false, authenticationState: "signed_out" }],
    (providerId) => providerId !== "native-route-disabled");

    expect(managedBackend).toEqual(new Set(["managed-authenticated", "managed-keyless", "native-authenticated"]));
    expect(signedOutNativeBackend).toEqual(new Set());
    expect(authenticatedNativeBackend).toEqual(new Set(["shared-provider", "local"]));
  });

  it("classifies usage money only through the exact Backend's managed Provider catalog", () => {
    const classify = (
      managedCatalog: boolean,
      kind?: "managed" | "api_key" | "oauth" | "subscription" | "local_keyless" | "custom_endpoint"
    ) =>
      providerUsageMoneyKind({
        list: backendId => {
          expect(backendId).toBe("owned-backend");
          return kind === undefined ? [] : [{ backendId, provider: { id: "provider" }, kind } as never];
        }
      }, {
        id: "owned-backend",
        capabilities: managedCatalog
          ? new Map([["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]])
          : new Map()
      }, "provider");

    expect(classify(true, "subscription")).toBe("subscription-value");
    expect(classify(true, "api_key")).toBe("actual-cost");
    expect(classify(true, "managed")).toBe("actual-cost");
    expect(classify(true, "local_keyless")).toBe("reference-value");
    expect(classify(true)).toBe("reference-value");
    // A native Backend can advertise the same Provider/model IDs. It does not
    // inherit metered or subscription provenance from another Backend's catalog.
    expect(classify(false, "api_key")).toBe("reference-value");
    expect(classify(false, "subscription")).toBe("reference-value");
  });

  it("installs the fixed public code-host capability unless composition explicitly overrides it", () => {
    const defaults = composeCodeHostProviders(undefined);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.supports({
      key: "github.com/acme/widgets#42",
      host: "github.com",
      repositoryOwner: "acme",
      repositoryName: "widgets",
      number: 42,
      webUrl: "https://github.com/acme/widgets/pull/42"
    })).toBe(true);
    expect(defaults[0]?.supports({
      key: "github.com.evil.example/acme/widgets#42",
      host: "github.com.evil.example",
      repositoryOwner: "acme",
      repositoryName: "widgets",
      number: 42,
      webUrl: "https://github.com.evil.example/acme/widgets/pull/42"
    })).toBe(false);

    const ownerFencedDefaults = composeCodeHostProviders(undefined, {
      authorize: () => ({ sessionOwnerId: "session-a", referenceKey: "github.com/acme/widgets#42", ownerRevision: "1" }),
      isCurrent: () => true
    });
    expect(ownerFencedDefaults).toHaveLength(2);
    expect(ownerFencedDefaults[0]?.minimumTimeToLiveMs).toBe(60_000);
    expect(ownerFencedDefaults[1]?.minimumTimeToLiveMs).toBe(60 * 60_000);

    const replacement = {
      capability: "code-host.pull-request" as const,
      supports: () => false,
      getPullRequest: async () => ({
        state: "open" as const,
        draft: false,
        title: "Application provider",
        headBranch: "feature/application-provider"
      })
    };
    expect(composeCodeHostProviders([replacement])).toEqual([replacement]);
    expect(composeCodeHostProviders([])).toEqual([]);
  });

  it("dispatches context defaults through capability-neutral Adapter registrations", () => {
    const resolve = composeSessionContextDefaultsResolver([
      {
        adapter: { id: "fixture-alpha" },
        resolve: () => ({ autoCompaction: false, autoRetry: true })
      },
      {
        adapter: { id: "fixture-beta" },
        resolve: ({ targetId }) => ({ autoRetry: targetId === "target-enabled" })
      }
    ]);

    expect(resolve({ sessionId: "session-a", backendId: "fixture-alpha", targetId: "target-a" }))
      .toEqual({ autoCompaction: false, autoRetry: true });
    expect(resolve({ sessionId: "session-b", backendId: "fixture-beta", targetId: "target-enabled" }))
      .toEqual({ autoRetry: true });
    expect(resolve({ sessionId: "session-c", backendId: "fixture-unknown", targetId: "target-a" }))
      .toBeUndefined();
  });

  it("retries exact candidate cleanup when post-provision initialization fails before Host ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-application-initialization-cleanup-"));
    const workspace = join(root, "workspace");
    const dataDirectory = join(root, "data");
    await mkdir(workspace, { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(join(dataDirectory, "workspace-snapshots"), "blocks the snapshot directory");
    const config: OrchestratorConfig = {
      host: "127.0.0.1",
      port: 4218,
      internalPort: 4217,
      publicOrigin: "http://127.0.0.1:4218",
      internalOrigin: "http://127.0.0.1:4217",
      dataDirectory,
      databasePath: join(dataDirectory, "orchestrator.db"),
      allowInsecureLoopback: true,
      allowInsecureLan: false,
      lanDiscoveryEnabled: false,
      codexExecutable: join(root, "missing-codex"),
      piAgentHome: join(dataDirectory, "pi"),
      workspace: { id: "workspace-initialization-cleanup", root: workspace, displayName: "Cleanup", trusted: true },
      artifactDirectory: join(dataDirectory, "artifacts"),
      webDirectory: join(root, "no-web-build"),
      corsOrigins: []
    };
    const probeCandidate = vi.spyOn(CodexBackendAdapter.prototype, "describe")
      .mockRejectedValue(new Error("controlled candidate probe failure"));
    const disposeCandidate = vi.spyOn(CodexBackendAdapter.prototype, "dispose")
      .mockRejectedValue(new Error("controlled candidate dispose failure"));
    const forceDisposeCandidate = vi.spyOn(CodexBackendAdapter.prototype, "forceDispose")
      .mockRejectedValue(new Error("controlled candidate force-dispose failure"));
    const closeProviderProxy = vi.spyOn(ManagedProviderProxy.prototype, "close");

    try {
      await expect(createOrchestratorApplication(config))
        .rejects.toThrow("Orchestrator initialization failed and cleanup remained incomplete.");
      expect(disposeCandidate).toHaveBeenCalledTimes(4);
      expect(forceDisposeCandidate).toHaveBeenCalledTimes(4);
      expect(closeProviderProxy).toHaveBeenCalledOnce();
    } finally {
      probeCandidate.mockRestore();
      disposeCandidate.mockRestore();
      forceDisposeCandidate.mockRestore();
      closeProviderProxy.mockRestore();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 20_000);

  it("retries retained candidate cleanup before closing native Provider dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-application-close-candidate-cleanup-"));
    const workspace = join(root, "workspace");
    const dataDirectory = join(root, "data");
    await mkdir(workspace, { recursive: true });
    const config: OrchestratorConfig = {
      host: "127.0.0.1",
      port: 4268,
      internalPort: 4267,
      publicOrigin: "http://127.0.0.1:4268",
      internalOrigin: "http://127.0.0.1:4267",
      dataDirectory,
      databasePath: join(dataDirectory, "orchestrator.db"),
      allowInsecureLoopback: true,
      allowInsecureLan: false,
      lanDiscoveryEnabled: false,
      codexExecutable: join(root, "missing-codex"),
      piAgentHome: join(dataDirectory, "pi"),
      workspace: { id: "workspace-close-candidate-cleanup", root: workspace, displayName: "Cleanup", trusted: true },
      artifactDirectory: join(dataDirectory, "artifacts"),
      webDirectory: join(root, "no-web-build"),
      corsOrigins: []
    };
    const application = await createOrchestratorApplication(config);
    const retryCandidates = vi.spyOn(BackendInstanceRegistry.prototype, "disposeRetainedCandidateCleanups");
    const closeProviderProxy = vi.spyOn(ManagedProviderProxy.prototype, "close");

    try {
      await application.close();
      expect(retryCandidates).toHaveBeenCalledOnce();
      expect(closeProviderProxy).toHaveBeenCalledOnce();
      expect(retryCandidates.mock.invocationCallOrder[0])
        .toBeLessThan(closeProviderProxy.mock.invocationCallOrder[0]!);
    } finally {
      retryCandidates.mockRestore();
      closeProviderProxy.mockRestore();
      await application.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 20_000);

  it("boots the managed provisioning stack and rotates Pi without moving native sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-application-"));
    const workspace = join(root, "workspace");
    const dataDirectory = join(root, "data");
    await mkdir(workspace, { recursive: true });
    const config: OrchestratorConfig = {
      host: "127.0.0.1",
      port: 4318,
      internalPort: 4317,
      publicOrigin: "http://127.0.0.1:4318",
      internalOrigin: "http://127.0.0.1:4317",
      dataDirectory,
      databasePath: join(dataDirectory, "orchestrator.db"),
      allowInsecureLoopback: true,
      allowInsecureLan: false,
      lanDiscoveryEnabled: false,
      codexExecutable: join(root, "missing-codex"),
      piAgentHome: join(dataDirectory, "pi"),
      workspace: { id: "workspace-test", root: workspace, displayName: "Fixture", trusted: true },
      artifactDirectory: join(dataDirectory, "artifacts"),
      webDirectory: join(root, "no-web-build"),
      corsOrigins: []
    };

    const application = await createOrchestratorApplication(config);
    const durableServerId = application.serverId;
    cleanups.push(async () => {
      await application.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    });

    expect(application.credentials?.list()).toEqual([]);
    expect(application.codeHostProviders).toHaveLength(2);
    expect(application.codeHostProviders?.[0]?.supports({
      key: "github.com/acme/widgets#42",
      host: "github.com",
      repositoryOwner: "acme",
      repositoryName: "widgets",
      number: 42,
      webUrl: "https://github.com/acme/widgets/pull/42"
    })).toBe(true);
    expect(application.codeHostProviders?.[1]?.supports({
      key: "github.com/acme/widgets#42",
      host: "github.com",
      repositoryOwner: "acme",
      repositoryName: "widgets",
      number: 42,
      webUrl: "https://github.com/acme/widgets/pull/42"
    })).toBe(true);
    expect(application.providers?.list().map((item) => item.provider.id)).toEqual(expect.arrayContaining([
      "openai-codex",
      "github-copilot"
    ]));
    expect(application.mcpRouter?.list()).toEqual([]);
    expect(application.mcpRouter?.toolPolicyDeclarations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "joko-contacts-tools", productDefaultEnabled: true })
    ]));
    const contactBridgeTools = application.mcpRouter?.createPiBridgeSnapshot({
      endpoint: "http://127.0.0.1:4317/internal/mcp",
      targetId: "workspace-test"
    }).mcpBridge.tools.filter((tool) => tool.serverId === "joko_contacts");
    expect(contactBridgeTools?.map((tool) => ({ name: tool.name, permission: tool.requiresPermission }))).toEqual([
      { name: "call_sensitive_tool", permission: true },
      { name: "call_tool", permission: false },
      { name: "list_tools", permission: false }
    ]);
    expect(application.partners?.listPartners()).toEqual([]);
    expect(application.partners?.directory().state).toMatchObject({ activeCount: 0, archivedCount: 0, errorCount: 0 });
    expect(application.piResources?.list()).toEqual([]);
    expect(application.skillMarket?.snapshot()).toEqual({ revision: 0n, sources: [], recoveredFromCorruption: false });
    expect(application.skillMarketSync?.listPolicies()).toEqual([]);
    expect(application.skillMarketSync?.listJobs()).toEqual([]);
    expect(application.skillPublication?.list()).toEqual([]);
    expect((await stat(join(dataDirectory, "skill-market"))).isDirectory()).toBe(true);
    expect((await stat(join(dataDirectory, "skill-publications", ".working"))).isDirectory()).toBe(true);
    expect(application.extensionSources?.snapshot()).toEqual({ revision: 0n, sources: [], recoveredFromCorruption: false });
    expect((await stat(join(dataDirectory, "extension-sources"))).isDirectory()).toBe(true);
    expect(application.extensionPackagePublisher?.list()).toEqual([]);
    expect(application.extensionPackagePublisher?.recoveredFromCorruption).toBe(false);
    expect((await stat(join(dataDirectory, "extension-package-exports", ".working"))).isDirectory()).toBe(true);
    const adapter = application.adapters[0];
    expect(adapter).toBeInstanceOf(PiBackendAdapter);
    expect(application.adapters.map((item) => item.id)).toEqual(["pi", "codex", "claude-code"]);
    expect(application.store.listBackends().map((item) => item.descriptor.id)).toEqual(
      expect.arrayContaining(["pi", "codex", "claude-code"])
    );
    expect(application.store.listTargets().map((item) => item.descriptor)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "workspace-test", backendId: "pi" }),
      expect.objectContaining({ id: "workspace-test:codex", backendId: "codex" }),
      expect.objectContaining({ id: "workspace-test:claude-code", backendId: "claude-code" })
    ]));
    expect(application.remoteBackendRuntimeSetup?.supportsTarget("workspace-test:codex")).toBe(true);
    expect(application.remoteBackendRuntimeSetup?.supportsTarget("workspace-test")).toBe(false);
    expect(application.remoteBackendRuntimeSetup?.supportsTarget("workspace-test:claude-code")).toBe(true);
    expect(application.store.getBackend("pi").descriptor).toMatchObject({
      instanceGeneration: 1,
      health: "healthy"
    });
    expect(application.store.getBackend("pi").descriptor.capabilities.get("input.mention")?.options)
      .toContain("session");
    expect(application.store.getBackend("codex").descriptor).toMatchObject({
      instanceGeneration: 1,
      health: "unavailable",
      installationState: "not_installed",
      error: { code: "CODEX_NOT_INSTALLED" }
    });
    expect(application.store.getBackend("claude-code").descriptor).toMatchObject({
      instanceGeneration: 1,
      installationState: "installed"
    });
    expect(application.store.getBackend("claude-code").descriptor.providerRuntimeSupport).toMatchObject({
      protocols: ["anthropic-messages"],
      fields: expect.arrayContaining(["model_limits"])
    });
    const claudeCapabilities = application.store.getBackend("claude-code").descriptor.capabilities;
    expect(claudeCapabilities.get("memory.native")?.supported).toBe(true);
    expect(claudeCapabilities.get("memory.native")?.options).toEqual(["reset_local"]);
    expect(claudeCapabilities.get("workspace.extra_dirs")?.supported).toBe(true);
    expect(claudeCapabilities.get("runtime.resources")).toMatchObject({
      supported: true,
      options: ["skill", "prompt"]
    });
    expect(claudeCapabilities.get("input.mention")?.options).toContain("resource");
    expect(claudeCapabilities.get("session.ai_rename")?.supported).toBe(true);
    expect(claudeCapabilities.get("tool.browser")?.supported).toBe(false);
    expect(claudeCapabilities.get("tool.computer")?.supported).toBe(false);
    expect(claudeCapabilities.get("tool.android")?.supported).toBe(false);
    const firstCodex = application.adapters.find((item) => item.id === "codex");
    await expect(application.restartBackend("codex")).rejects.toThrow("failed validation");
    expect(application.store.getBackend("codex").descriptor.instanceGeneration).toBe(1);
    expect(application.store.getBackendInstanceGenerationAuthority("codex")).toMatchObject({
      currentGeneration: 1,
      highWaterGeneration: 2
    });
    expect(application.adapters.find((item) => item.id === "codex")).toBe(firstCodex);
    expect((await stat(join(config.piAgentHome, "sessions"))).isDirectory()).toBe(true);
    expect(await (adapter as PiBackendAdapter).listNativeSessions()).toEqual([]);

    application.store.setSetting("service", "orchestrator", "settings.pi.pi", {
      autoCompaction: false,
      autoCompactionThresholdPercent: 70,
      autoRetry: false,
      steeringMode: 2,
      followUpMode: 1
    });
    await expect(application.refreshPiGeneration?.()).resolves.toBeUndefined();
    await expect(application.refreshPiGeneration?.()).resolves.toBeUndefined();
    expect(application.store.getBackend("pi").descriptor.capabilities.get("input.mention")?.options)
      .toContain("session");
    const generationRoots = await readdir(join(config.piAgentHome, "generations"), { withFileTypes: true });
    expect(generationRoots.filter((entry) => entry.isDirectory() && entry.name.startsWith("runtime-"))).toHaveLength(1);
    const generationFiles = await readdir(join(config.piAgentHome, "generations"), { recursive: true });
    const generatedSettings = await Promise.all(generationFiles
      .filter((path) => path.endsWith("settings.json"))
      .map((path) => readFile(join(config.piAgentHome, "generations", path), "utf8")));
    expect(generatedSettings).toHaveLength(1);
    expect(generatedSettings.some((body) => {
      const value = JSON.parse(body) as Record<string, unknown>;
      return value["steeringMode"] === "one-at-a-time" && value["followUpMode"] === "all" &&
        (value["compaction"] as Record<string, unknown> | undefined)?.["enabled"] === false &&
        (value["compaction"] as Record<string, unknown> | undefined)?.["reserveTokens"] === 0 &&
        (value["compaction"] as Record<string, unknown> | undefined)?.["thresholdPercent"] === undefined &&
        (value["retry"] as Record<string, unknown> | undefined)?.["enabled"] === false;
    })).toBe(true);
    const generatedModels = await Promise.all(generationFiles
      .filter((path) => path.endsWith("models.json"))
      .map((path) => readFile(join(config.piAgentHome, "generations", path), "utf8")));
    expect(generatedModels.length).toBeGreaterThan(0);
    expect(generatedModels.every((body) => {
      const value = JSON.parse(body) as { providers?: Readonly<Record<string, unknown>> };
      return Object.keys(value.providers ?? {}).length === 0;
    })).toBe(true);
    expect(application.store.listBackends()).toHaveLength(3);
    const backendModels = application.store.getBackend("pi").descriptor.models;
    expect(backendModels).toEqual([]);
    expect(application.store.listTargets()).toHaveLength(3);

    const challenge = application.connections.issuePairing("test owner");
    const paired = application.connections.completePairing({
      challengeId: challenge.id,
      code: challenge.code,
      connectionName: "Test client"
    });
    const ticket = application.credentials!.createUploadTicket({
      kind: "api_key",
      connectionId: paired.connection.id
    });
    const server = await createPublicServer(application);
    const internalServer = await createInternalServer(application);
    server.log.level = "silent";
    internalServer.log.level = "silent";
    cleanups.push(() => server.close());
    cleanups.push(() => internalServer.close());
    expect((await server.inject({ method: "POST", url: "/internal/mcp", payload: {} })).statusCode).toBe(404);
    expect((await internalServer.inject({ method: "POST", url: "/internal/mcp", payload: {} })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: "/internal/pi-native-auth", payload: {} })).statusCode).toBe(404);
    expect((await internalServer.inject({ method: "POST", url: "/internal/pi-native-auth", payload: {} })).statusCode).toBe(400);
    expect((await server.inject({ method: "GET", url: "/healthz", remoteAddress: "203.0.113.10" })).statusCode).toBe(403);
    const desktopPreflight = await server.inject({
      method: "OPTIONS",
      url: "/healthz",
      headers: { origin: "joko://app", "access-control-request-method": "GET" }
    });
    expect(desktopPreflight.statusCode).toBe(204);
    expect(desktopPreflight.headers["access-control-allow-origin"]).toBe("joko://app");
    expect(desktopPreflight.headers["access-control-allow-credentials"]).toBeUndefined();
    const disabledLanCors = await server.inject({
      method: "OPTIONS",
      url: "/healthz",
      headers: { origin: "http://192.168.1.30:4319", "access-control-request-method": "GET" }
    });
    expect(disabledLanCors.headers["access-control-allow-origin"]).toBeUndefined();
    const missingExtensionSurface = await server.inject({
      method: "GET",
      url: `/v1/extensions/main-views/extension_surface_${"a".repeat(32)}/${"b".repeat(64)}/index.html`
    });
    expect(missingExtensionSurface.statusCode).toBe(404);
    expect(missingExtensionSurface.headers["access-control-allow-origin"]).toBe("null");
    expect(missingExtensionSurface.headers["x-frame-options"]).toBeUndefined();
    expect(missingExtensionSurface.headers["content-security-policy"]).toContain("frame-ancestors *");
    expect(missingExtensionSurface.headers["content-security-policy"]).toContain("connect-src 'none'");
    const lanServer = await createPublicServer({
      ...application,
      config: {
        ...config,
        allowInsecureLan: true,
        corsOrigins: []
      }
    });
    lanServer.log.level = "silent";
    cleanups.push(() => lanServer.close());
    expect((await lanServer.inject({ method: "GET", url: "/healthz", remoteAddress: "192.168.1.30" })).statusCode).toBe(200);
    const corsPreflight = await lanServer.inject({
      method: "OPTIONS",
      url: "/healthz",
      remoteAddress: "192.168.1.30",
      headers: {
        origin: "http://192.168.1.30:4319",
        "access-control-request-method": "GET"
      }
    });
    expect(corsPreflight.statusCode).toBe(204);
    expect(corsPreflight.headers["access-control-allow-origin"]).toBe("http://192.168.1.30:4319");
    expect(corsPreflight.headers["access-control-allow-credentials"]).toBeUndefined();
    const rejectedPublicCors = await lanServer.inject({
      method: "OPTIONS",
      url: "/healthz",
      remoteAddress: "192.168.1.30",
      headers: { origin: "http://example.com:4319", "access-control-request-method": "GET" }
    });
    expect(rejectedPublicCors.headers["access-control-allow-origin"]).toBeUndefined();
    const removedLocalPairing = await server.inject({
      method: "POST",
      url: "/v1/local/pairing",
      headers: { "x-joko-local-pairing": "1", "content-type": "application/json" },
      payload: { label: "Desktop recovery", deviceName: "Desktop", deviceKind: "desktop" }
    });
    expect(removedLocalPairing.statusCode).toBe(404);
    const upload = await server.inject({
      method: "PUT",
      url: `/v1/credentials/upload/${ticket.credentialUploadTicketId}`,
      headers: { authorization: `Bearer ${paired.authKey}`, "content-type": "application/octet-stream" },
      payload: Buffer.from("fixture-secret")
    });
    expect(upload.statusCode).toBe(204);
    const credential = await application.credentials!.commitUpload({
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: "cred_fixture_route",
      displayName: "Fixture route credential",
      kind: "api_key",
      connectionId: paired.connection.id
    });
    expect(application.credentials!.resolve(credential.credentialReferenceId)).toBe("fixture-secret");
    const unauthorized = await server.inject({
      method: "PUT",
      url: "/v1/credentials/upload/not-a-ticket",
      headers: { authorization: "Bearer invalid", "content-type": "application/octet-stream" },
      payload: Buffer.from("ignored")
    });
    expect(unauthorized.statusCode).toBe(401);

    const restoredWorkspaceRoot = join(root, "restored-workspace");
    await mkdir(restoredWorkspaceRoot, { recursive: true });
    await application.sessionHost.registerTarget({
      id: "target-restored",
      backendId: "pi",
      displayName: "Restored workspace",
      workspaceRoot: restoredWorkspaceRoot,
      managed: true,
      trusted: false
    }, { workspaceId: "workspace-restored" });
    const defaultTarget = application.store.getTarget(config.workspace.id);
    application.store.upsertTarget({ ...defaultTarget.descriptor, displayName: "Personal project", trusted: false }, {
      ...defaultTarget.metadata as Record<string, unknown>, pinned: true
    });
    const archiveResponse = await server.inject({
      method: "POST", url: "/joko.v1.OperationService/SubmitOperation",
      headers: { authorization: `Bearer ${paired.authKey}`, "content-type": "application/json", "connect-protocol-version": "1" },
      payload: {
        operationId: "hide-configured-project", connectionId: paired.connection.id,
        mutation: { archiveTarget: { targetId: config.workspace.id, archived: true } }
      }
    });
    expect(archiveResponse.statusCode, archiveResponse.body).toBe(200);
    const archivedMetadata = application.store.getTarget(config.workspace.id).metadata;
    expect(archivedMetadata).toMatchObject({ state: "archived", pinned: true });
    await server.close();
    await internalServer.close();
    await lanServer.close();
    await application.close();

    const reopened = await createOrchestratorApplication(config);
    cleanups.push(() => reopened.close());
    expect(reopened.serverId).toBe(durableServerId);
    expect(reopened.partners?.listPartners()).toEqual([]);
    expect(reopened.store.listBackends().map((backend) => ({
      id: backend.descriptor.id,
      generation: backend.descriptor.instanceGeneration
    }))).toEqual(expect.arrayContaining([
      { id: "pi", generation: 2 },
      { id: "codex", generation: 3 },
      { id: "claude-code", generation: 2 }
    ]));
    expect(reopened.workspaces.listRegistrations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "workspace-restored", root: restoredWorkspaceRoot }),
      expect.objectContaining({ id: config.workspace.id, displayName: "Personal project", trusted: false })
    ]));
    expect(reopened.store.getTarget(config.workspace.id)).toMatchObject({
      descriptor: { displayName: "Personal project", trusted: false, workspaceRoot: workspace },
      metadata: archivedMetadata
    });
    const reopenedServer = await createPublicServer(reopened);
    reopenedServer.log.level = "silent";
    cleanups.push(() => reopenedServer.close());
    const restoreResponse = await reopenedServer.inject({
      method: "POST", url: "/joko.v1.OperationService/SubmitOperation",
      headers: { authorization: `Bearer ${paired.authKey}`, "content-type": "application/json", "connect-protocol-version": "1" },
      payload: {
        operationId: "restore-configured-project", connectionId: paired.connection.id,
        mutation: { archiveTarget: { targetId: config.workspace.id, archived: false } }
      }
    });
    expect(restoreResponse.statusCode, restoreResponse.body).toBe(200);
    expect(reopened.store.getTarget(config.workspace.id)).toMatchObject({
      descriptor: { displayName: "Personal project", trusted: false },
      metadata: { state: "active", pinned: true }
    });
    expect(reopened.store.listTargets()).toHaveLength(4);
    await reopenedServer.close();
    await reopened.close();
    const differentRoot = join(root, "different-workspace");
    await mkdir(differentRoot, { recursive: true });
    const probeCandidate = vi.spyOn(CodexBackendAdapter.prototype, "describe")
      .mockRejectedValue(new Error("controlled startup candidate probe failure"));
    const disposeCandidate = vi.spyOn(CodexBackendAdapter.prototype, "dispose")
      .mockRejectedValue(new Error("controlled startup candidate dispose failure"));
    const forceDisposeCandidate = vi.spyOn(CodexBackendAdapter.prototype, "forceDispose")
      .mockRejectedValue(new Error("controlled startup candidate force-dispose failure"));
    const closeProviderProxy = vi.spyOn(ManagedProviderProxy.prototype, "close");
    let startupFailure: unknown;
    let disposeCalls = 0;
    let forceDisposeCalls = 0;
    let proxyCloseCalls = 0;
    try {
      await createOrchestratorApplication({ ...config, workspace: { ...config.workspace, root: differentRoot } });
    } catch (error) {
      startupFailure = error;
    } finally {
      disposeCalls = disposeCandidate.mock.calls.length;
      forceDisposeCalls = forceDisposeCandidate.mock.calls.length;
      proxyCloseCalls = closeProviderProxy.mock.calls.length;
      probeCandidate.mockRestore();
      disposeCandidate.mockRestore();
      forceDisposeCandidate.mockRestore();
      closeProviderProxy.mockRestore();
    }
    expect(startupFailure).toBeInstanceOf(AggregateError);
    expect((startupFailure as AggregateError).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("does not match its persisted Target") })
    ]));
    expect(disposeCalls).toBe(4);
    expect(forceDisposeCalls).toBe(4);
    expect(proxyCloseCalls).toBe(1);
  }, 20_000);

  it("rejects a busy Pi replacement before refreshing or republishing its retained instance", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-application-pi-busy-replacement-"));
    const workspace = join(root, "workspace");
    const dataDirectory = join(root, "data");
    await mkdir(workspace, { recursive: true });
    const config: OrchestratorConfig = {
      host: "127.0.0.1",
      port: 4518,
      internalPort: 4517,
      publicOrigin: "http://127.0.0.1:4518",
      internalOrigin: "http://127.0.0.1:4517",
      dataDirectory,
      databasePath: join(dataDirectory, "orchestrator.db"),
      allowInsecureLoopback: true,
      allowInsecureLan: false,
      lanDiscoveryEnabled: false,
      codexExecutable: join(root, "missing-codex"),
      piAgentHome: join(dataDirectory, "pi"),
      workspace: { id: "workspace-pi-busy-replacement", root: workspace, displayName: "Busy Pi replacement", trusted: true },
      artifactDirectory: join(dataDirectory, "artifacts"),
      webDirectory: join(root, "no-web-build"),
      corsOrigins: []
    };

    const application = await createOrchestratorApplication(config);
    cleanups.push(async () => {
      await application.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    });
    const store = application.store;
    const sessionId = "pi-dispatch-unknown-session";
    const runId = "pi-dispatch-unknown-run";
    const attemptId = "pi-dispatch-unknown-attempt";
    const queueItemId = "pi-dispatch-unknown-queue";
    const operationId = "pi-dispatch-unknown-operation";
    const binding = {
      opaqueRef: join(config.piAgentHome, "sessions", "dispatch-unknown.jsonl"),
      nativeSessionId: "pi-dispatch-unknown-native",
      generation: 7
    };
    store.createSession({
      id: sessionId,
      backendId: "pi",
      targetId: config.workspace.id,
      title: "Dispatch unknown",
      binding,
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    store.createRun({
      id: runId,
      sessionId,
      source: "user",
      state: "queued",
      createdAt: 2
    });
    store.createAttempt({ id: attemptId, runId, ordinal: 1, generation: binding.generation, startedAt: 2 });
    const prompt = { text: "Consumed without a receipt", images: [], files: [], mentions: [], disposition: "prompt" as const };
    store.runOperation({ id: operationId, kind: "prompt", body: prompt }, (transaction) => {
      transaction.enqueueQueueItem({
        id: queueItemId,
        sessionId,
        runId,
        attemptId,
        operationId,
        disposition: "prompt",
        body: prompt,
        createdAt: 2
      });
      return { accepted: true };
    });
    const backendInstanceGeneration = store.getBackend("pi").descriptor.instanceGeneration;
    expect(store.claimNextQueueItem({ sessionId, backendInstanceGeneration })).toMatchObject({
      state: "dispatching",
      attemptId,
      backendInstanceGeneration
    });
    const error = {
      code: "PI_PROCESS_EXITED",
      message: "Pi consumed the prompt before its receipt was lost.",
      phase: "dispatch" as const,
      retryable: true,
      stateMayHaveChanged: true,
      recovery: "Inspect native state before retrying."
    };
    store.updateQueueState({
      queueItemId,
      state: "dispatch_unknown",
      attemptId,
      error,
      traceId: "test:pi-dispatch-unknown:queue"
    });
    store.updateRunState({
      runId,
      state: "dispatch_unknown",
      activeAttemptId: attemptId,
      error,
      traceId: "test:pi-dispatch-unknown:run"
    });
    store.finishAttempt(attemptId, error);

    const pi = application.adapters.find((candidate) => candidate.id === "pi");
    expect(pi).toBeInstanceOf(PiBackendAdapter);
    const currentPi = pi as PiBackendAdapter;
    const updateManagedGeneration = vi.spyOn(currentPi, "updateManagedGeneration");
    const describe = vi.spyOn(currentPi, "describe");
    const backendBefore = store.getBackend("pi");
    const authorityBefore = store.getBackendInstanceGenerationAuthority("pi");
    const sessionBefore = store.getSession(sessionId);

    expect(application.sessionHost.canReplaceBackendInstance("pi")).toBe(false);
    await expect(application.restartBackend("pi")).rejects.toThrow("only after every affected task");

    expect(updateManagedGeneration).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled();
    expect(application.adapters.find((candidate) => candidate.id === "pi")).toBe(currentPi);
    expect(store.getBackend("pi")).toEqual(backendBefore);
    expect(store.getBackendInstanceGenerationAuthority("pi")).toEqual(authorityBefore);
    expect(store.getSession(sessionId)).toEqual(sessionBefore);
    expect(store.getQueueItem(queueItemId).state).toBe("dispatch_unknown");
    expect(store.getRun(runId).descriptor.state).toBe("dispatch_unknown");
  }, 20_000);

  it("refreshes only the retained Pi generation after a candidate probe fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-application-pi-probe-failure-"));
    const workspace = join(root, "workspace");
    const dataDirectory = join(root, "data");
    await mkdir(workspace, { recursive: true });
    const config: OrchestratorConfig = {
      host: "127.0.0.1",
      port: 4618,
      internalPort: 4617,
      publicOrigin: "http://127.0.0.1:4618",
      internalOrigin: "http://127.0.0.1:4617",
      dataDirectory,
      databasePath: join(dataDirectory, "orchestrator.db"),
      allowInsecureLoopback: true,
      allowInsecureLan: false,
      lanDiscoveryEnabled: false,
      codexExecutable: join(root, "missing-codex"),
      piAgentHome: join(dataDirectory, "pi"),
      workspace: { id: "workspace-pi-probe-failure", root: workspace, displayName: "Pi probe failure", trusted: true },
      artifactDirectory: join(dataDirectory, "artifacts"),
      webDirectory: join(root, "no-web-build"),
      corsOrigins: []
    };

    const application = await createOrchestratorApplication(config);
    cleanups.push(async () => {
      await application.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    });
    const providers = application.providers!;
    const credentialExpiry = Date.now() + 2 * 60 * 60_000;
    const initialCredential = {
      type: "oauth" as const,
      access: "retained-probe-access",
      refresh: "retained-probe-refresh",
      expires: credentialExpiry,
      accountId: "retained-probe-account"
    };
    await providers.writeNativeCredential({
      providerId: "openai-codex",
      serializedCredential: JSON.stringify(initialCredential),
      expiresAt: credentialExpiry,
      expectedCatalogGeneration: providers.generation
    });
    await application.refreshPiGeneration?.();
    const model = application.store.getBackend("pi").descriptor.models
      .find((candidate) => candidate.providerId === "openai-codex");
    expect(model).toBeDefined();
    const challenge = application.connections.issuePairing("Pi probe failure owner");
    const paired = application.connections.completePairing({
      challengeId: challenge.id,
      code: challenge.code,
      connectionName: "Pi probe failure test"
    });
    const sessionId = (await application.sessionHost.createSession({
      operationId: "create-pi-probe-failure-idle-session",
      connection: paired.connection,
      targetId: config.workspace.id,
      title: "Idle Pi probe failure",
      providerId: model!.providerId,
      modelId: model!.modelId,
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const binding = application.store.getSession(sessionId).descriptor.binding;
    await writeFile(binding.opaqueRef, `${JSON.stringify({
      type: "session",
      version: 3,
      id: binding.nativeSessionId,
      timestamp: new Date().toISOString(),
      cwd: workspace
    })}\n`);

    const publishedCatalogGeneration = providers.generation;
    expect(await providers.deleteNativeCredential("openai-codex")).toBe(true);
    expect(providers.generation).toBeGreaterThan(publishedCatalogGeneration);
    application.store.setSetting("service", "orchestrator", "settings.pi.pi", {
      autoCompaction: false,
      autoCompactionThresholdPercent: 70,
      autoRetry: false,
      steeringMode: 2,
      followUpMode: 1
    });

    const retainedPi = application.adapters.find((candidate) => candidate.id === "pi");
    expect(retainedPi).toBeInstanceOf(PiBackendAdapter);
    const retainedAdapter = retainedPi as PiBackendAdapter;
    const updateRetainedGeneration = vi.spyOn(retainedAdapter, "updateManagedGeneration");
    const describeRetained = vi.spyOn(retainedAdapter, "describe");
    const closeRetainedSession = vi.spyOn(retainedAdapter, "closeSession");
    const resumeRetainedSession = vi.spyOn(retainedAdapter, "resumeSession");
    const disposeRetained = vi.spyOn(retainedAdapter, "dispose");
    const backendBefore = application.store.getBackend("pi");
    const authorityBefore = application.store.getBackendInstanceGenerationAuthority("pi");
    const sessionBefore = application.store.getSession(sessionId);
    expect(backendBefore.descriptor.authenticationState).toBe("authenticated");
    Object.assign(config, { piExecutable: join(root, "missing-pi-candidate") });
    try {
      await expect(application.restartBackend("pi"))
        .rejects.toThrow("Backend replacement candidate failed validation: pi");
    } finally {
      Reflect.deleteProperty(config, "piExecutable");
    }

    expect(updateRetainedGeneration).toHaveBeenCalledOnce();
    expect(updateRetainedGeneration.mock.calls[0]?.[0]).toMatchObject({
      catalogGeneration: providers.generation,
      settings: {
        compaction: { enabled: false, thresholdPercent: 70 },
        retry: { enabled: false },
        steeringMode: "one-at-a-time",
        followUpMode: "all"
      }
    });
    expect(updateRetainedGeneration.mock.calls[0]?.[0].nativeAuthenticatedProviderIds)
      .not.toContain("openai-codex");
    expect(providers.generation).toBeGreaterThan(publishedCatalogGeneration);
    expect(describeRetained).toHaveBeenCalledOnce();
    expect(closeRetainedSession).not.toHaveBeenCalled();
    expect(resumeRetainedSession).not.toHaveBeenCalled();
    expect(disposeRetained).not.toHaveBeenCalled();
    expect(application.adapters.find((candidate) => candidate.id === "pi")).toBe(retainedAdapter);
    const backendAfter = application.store.getBackend("pi");
    expect(backendAfter.descriptor).toMatchObject({
      instanceGeneration: backendBefore.descriptor.instanceGeneration,
      authenticationState: "signed_out"
    });
    expect(backendAfter.revision).toBeGreaterThan(backendBefore.revision);
    expect(application.store.getBackendInstanceGenerationAuthority("pi")).toMatchObject({
      adapterKind: authorityBefore.adapterKind,
      currentGeneration: authorityBefore.currentGeneration,
      highWaterGeneration: authorityBefore.highWaterGeneration + 1
    });
    expect(application.store.getSession(sessionId)).toEqual(sessionBefore);
    expect(application.sessionHost.isSessionActive(sessionId)).toBe(true);

    const generationFiles = await readdir(join(config.piAgentHome, "generations"), { recursive: true });
    const generationManifests = generationFiles.filter((path) => path.endsWith("joko-generation.json"));
    expect(generationManifests).toHaveLength(2);
    const generations = await Promise.all(generationManifests.map(async (path) =>
      JSON.parse(await readFile(join(config.piAgentHome, "generations", path), "utf8")) as { generation?: number }
    ));
    expect(generations.map((snapshot) => snapshot.generation).sort((left, right) =>
      (left ?? 0) - (right ?? 0)
    )).toEqual([publishedCatalogGeneration, providers.generation]);
    const privateState = JSON.stringify({
      diagnostics: application.store.listDiagnostics(),
      backend: backendAfter,
      events: application.store.listEvents({ sessionId })
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString(10) : value);
    expect(privateState).not.toContain("missing-pi-candidate");
    expect(privateState).not.toContain(initialCredential.access);
    expect(privateState).not.toContain(initialCredential.refresh);
  }, 30_000);

  it("replaces an idle Pi runtime after native auth write-back without stale generation or fence", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-application-pi-replacement-"));
    const workspace = join(root, "workspace");
    const dataDirectory = join(root, "data");
    await mkdir(workspace, { recursive: true });
    const config: OrchestratorConfig = {
      host: "127.0.0.1",
      port: 4418,
      internalPort: 4417,
      publicOrigin: "http://127.0.0.1:4418",
      internalOrigin: "http://127.0.0.1:4417",
      dataDirectory,
      databasePath: join(dataDirectory, "orchestrator.db"),
      allowInsecureLoopback: true,
      allowInsecureLan: false,
      lanDiscoveryEnabled: false,
      codexExecutable: join(root, "missing-codex"),
      piAgentHome: join(dataDirectory, "pi"),
      workspace: { id: "workspace-pi-replacement", root: workspace, displayName: "Pi replacement", trusted: true },
      artifactDirectory: join(dataDirectory, "artifacts"),
      webDirectory: join(root, "no-web-build"),
      corsOrigins: []
    };

    const application = await createOrchestratorApplication(config);
    cleanups.push(async () => {
      await application.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    });
    const providers = application.providers!;
    const initialExpiry = Date.now() + 2 * 60 * 60_000;
    const initialCredential = {
      type: "oauth" as const,
      access: "runtime-access-before-replacement",
      refresh: "runtime-refresh-before-replacement",
      expires: initialExpiry,
      accountId: "replacement-regression-account"
    };
    await providers.writeNativeCredential({
      providerId: "openai-codex",
      serializedCredential: JSON.stringify(initialCredential),
      expiresAt: initialExpiry,
      expectedCatalogGeneration: providers.generation
    });
    await application.refreshPiGeneration?.();

    const model = application.store.getBackend("pi").descriptor.models
      .find((candidate) => candidate.providerId === "openai-codex");
    expect(model).toBeDefined();
    const challenge = application.connections.issuePairing("Pi replacement owner");
    const paired = application.connections.completePairing({
      challengeId: challenge.id,
      code: challenge.code,
      connectionName: "Pi replacement test"
    });
    const firstSessionId = (await application.sessionHost.createSession({
      operationId: "create-pi-replacement-idle-session",
      connection: paired.connection,
      targetId: config.workspace.id,
      title: "Idle Pi replacement",
      providerId: model!.providerId,
      modelId: model!.modelId,
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    expect(application.sessionHost.isSessionActive(firstSessionId)).toBe(true);
    const firstBinding = application.store.getSession(firstSessionId).descriptor.binding;
    await writeFile(firstBinding.opaqueRef, `${JSON.stringify({
      type: "session",
      version: 3,
      id: firstBinding.nativeSessionId,
      timestamp: new Date().toISOString(),
      cwd: workspace
    })}\n`);

    const runtimeAuthFiles = async (): Promise<string[]> => (await readdir(
      join(config.piAgentHome, "generations"),
      { recursive: true }
    ))
      .filter((path) => path.endsWith("auth.json"))
      .map((path) => join(config.piAgentHome, "generations", path));
    const beforeAuthFiles = await runtimeAuthFiles();
    expect(beforeAuthFiles).toHaveLength(1);
    const refreshedExpiry = initialExpiry + 60 * 60_000;
    const refreshedCredential = {
      ...initialCredential,
      access: "runtime-access-after-replacement",
      refresh: "runtime-refresh-after-replacement",
      expires: refreshedExpiry
    };
    await writeFile(beforeAuthFiles[0]!, `${JSON.stringify({ "openai-codex": refreshedCredential })}\n`, {
      mode: 0o600
    });

    const catalogGenerationBeforeReplacement = providers.generation;
    const previousAdapter = application.adapters.find((candidate) => candidate.id === "pi");
    await application.restartBackend("pi");

    expect(providers.generation).toBeGreaterThan(catalogGenerationBeforeReplacement);
    expect(application.store.getBackend("pi").descriptor).toMatchObject({
      instanceGeneration: 2,
      authenticationState: "authenticated"
    });
    expect(application.adapters.find((candidate) => candidate.id === "pi")).not.toBe(previousAdapter);
    expect(application.sessionHost.isSessionActive(firstSessionId)).toBe(true);
    const replacementGenerationFiles = await readdir(join(config.piAgentHome, "generations"), { recursive: true });
    const replacementGenerationManifests = replacementGenerationFiles
      .filter((path) => path.endsWith("joko-generation.json"));
    expect(replacementGenerationManifests).toHaveLength(1);
    expect(JSON.parse(await readFile(
      join(config.piAgentHome, "generations", replacementGenerationManifests[0]!),
      "utf8"
    ))).toMatchObject({ generation: providers.generation });
    const afterAuthFiles = await runtimeAuthFiles();
    expect(afterAuthFiles).toHaveLength(1);
    expect(JSON.parse(await readFile(afterAuthFiles[0]!, "utf8"))).toEqual({
      "openai-codex": refreshedCredential
    });

    await expect(application.sessionHost.createSession({
      operationId: "create-after-pi-replacement-fence",
      connection: paired.connection,
      targetId: config.workspace.id,
      title: "Admission after Pi replacement",
      providerId: model!.providerId,
      modelId: model!.modelId,
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).resolves.toMatchObject({ value: { sessionId: expect.any(String) } });
    const privateState = JSON.stringify({
      diagnostics: application.store.listDiagnostics(),
      events: application.store.listEvents({ sessionId: firstSessionId })
    }, (_key, value: unknown) => typeof value === "bigint" ? value.toString(10) : value);
    expect(privateState).not.toContain(refreshedCredential.access);
    expect(privateState).not.toContain(refreshedCredential.refresh);
  }, 30_000);
});

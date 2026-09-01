import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiBackendAdapter } from "@joko/adapter-pi";
import { afterEach, describe, expect, it } from "vitest";

import {
  availableBackendProviderIds,
  composeCodeHostProviders,
  composeSessionContextDefaultsResolver,
  createOrchestratorApplication,
  providerUsageMoneyKind
} from "./application.js";
import type { OrchestratorConfig } from "./config.js";
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
    ];
    const managedBackend = availableBackendProviderIds({
      capabilities: new Map([["provider.managed_catalog", {
        key: "provider.managed_catalog",
        supported: true
      }]])
    }, managedCatalog, (providerId) => providerId !== "managed-route-disabled");
    const signedOutNativeBackend = availableBackendProviderIds({
      capabilities: new Map(),
      providers: [
        provider("shared-provider", "signed_out")
      ]
    }, managedCatalog);
    const authenticatedNativeBackend = availableBackendProviderIds({
      capabilities: new Map(),
      providers: [
        provider("shared-provider", "authenticated"),
        provider("local", "not_required"),
        provider("native-route-disabled", "authenticated")
      ]
    }, [{ provider: { id: "shared-provider" }, enabled: false, authenticationState: "signed_out" }],
    (providerId) => providerId !== "native-route-disabled");

    expect(managedBackend).toEqual(new Set(["managed-authenticated", "managed-keyless"]));
    expect(signedOutNativeBackend).toEqual(new Set());
    expect(authenticatedNativeBackend).toEqual(new Set(["shared-provider", "local"]));
  });

  it("classifies usage money only through the exact Backend's managed Provider catalog", () => {
    const classify = (
      managedCatalog: boolean,
      kind?: "managed" | "api_key" | "oauth" | "subscription" | "local_keyless" | "custom_endpoint"
    ) =>
      providerUsageMoneyKind({
        list: () => kind === undefined ? [] : [{ provider: { id: "provider" }, kind } as never]
      }, {
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
    expect(application.piResources?.list()).toEqual([]);
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
    expect(application.store.getBackend("pi").descriptor).toMatchObject({
      instanceGeneration: 1,
      health: "healthy"
    });
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
    const claudeCapabilities = application.store.getBackend("claude-code").descriptor.capabilities;
    expect(claudeCapabilities.get("workspace.extra_dirs")?.supported).toBe(true);
    expect(claudeCapabilities.get("session.ai_rename")?.supported).toBe(false);
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
    await server.close();
    await internalServer.close();
    await lanServer.close();
    await application.close();

    const reopened = await createOrchestratorApplication(config);
    cleanups.push(() => reopened.close());
    expect(reopened.serverId).toBe(durableServerId);
    expect(reopened.store.listBackends().map((backend) => ({
      id: backend.descriptor.id,
      generation: backend.descriptor.instanceGeneration
    }))).toEqual(expect.arrayContaining([
      { id: "pi", generation: 2 },
      { id: "codex", generation: 3 },
      { id: "claude-code", generation: 2 }
    ]));
    expect(reopened.workspaces.listRegistrations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "workspace-restored", root: restoredWorkspaceRoot })
    ]));
  }, 20_000);

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

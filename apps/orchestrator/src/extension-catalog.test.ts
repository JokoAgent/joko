import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { registerConnectServices } from "./connect-services.js";
import { ConnectionManager, digestAuthKey } from "./connection-manager.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { ExtensionCatalogManager } from "./extension-catalog.js";
import type { ExtensionSourceDescriptor } from "./extension-source-manager.js";
import type { McpServerDescriptor } from "./mcp-router.js";
import type { PiResourceDescriptor } from "./resource-manager.js";
import { extensionNetworkCredentialReference } from "./extension-cards/network-manifest.js";
import { ExtensionSettingsManager } from "./extension-settings.js";
import { parseExtensionRuntime } from "./extension-surface-manifest.js";
import type { ExtensionMainViewSurface } from "./extension-main-view-manager.js";
import { SessionHost } from "./session-host.js";

const NOW = 1_800_000_000_000;

it("keeps original runtime parameters in the Vault owner, fences ABA writes and clears only the selected secret", async () => {
  const { root, store, credentials, catalog } = await fixture();
  try {
    const vault = await CredentialVault.open(join(root, "vault.key"));
    const runtime = parseExtensionRuntime({ html: "ui/runtime/index.html", tools: [{ name: "read", description: "Read", inputSchema: { type: "object" }, readOnly: true }],
      network: { hosts: ["api.example.com"], secrets: [
        { key: "token", label: "Token", inject: { header: "X-Token", format: "{value}" }, check: { url: "https://api.example.com/check", bodyFormat: '{"value":"{value}"}', validPath: "active", validValue: true } },
        { key: "secondary", label: "Second token", inject: { header: "X-Second", format: "{value}" } }
      ] } });
    const packageResource = resource({ kind: "package", discoveredRevision: `sha256:${"a".repeat(64)}`, resourceDetails: [{
      kind: "extension", name: "Settings", entryPath: "extension.ts", settings: { html: "ui/settings/index.html" }, runtime,
      compatibility: "supported", compatibilityIssues: [], detectedApis: [], adaptedApis: [], unsupportedApis: []
    }] });
    const extension = catalog.reconcile([packageResource], []).entries[0]!;
    const surface: ExtensionMainViewSurface = { id: `extension_surface_${"a".repeat(32)}`, extensionId: extension.id, endpoint: "/private", expiresAt: NOW + 600_000,
      authority: { extensionId: extension.id, resourceId: packageResource.id, resourceRevision: packageResource.versionNumber,
        discoveredRevision: packageResource.discoveredRevision, backendId: "pi", backendRevision: 1n, backendGeneration: 1,
        packageName: "sample-settings", extensionEntry: "extension.ts", mainView: { html: "ui/settings/index.html" }, settings: { html: "ui/settings/index.html" } } };
    const manager = new ExtensionSettingsManager({ store, vault, credentials, catalog, fetch: vi.fn(async () => Response.json({ active: true, secret: "upstream-hidden" })) });
    expect(manager.read(surface)).toEqual({ revision: "0", dataJson: "{}" });
    manager.write(surface, "0", '{"folder":"inbox"}');
    const saved = manager.read(surface);
    expect(saved.dataJson).toBe('{"folder":"inbox"}');
    expect(JSON.stringify(store.findSetting("service", "extension-runtime-kv", extension.id)?.value)).not.toContain("inbox");
    // The existing runtime writes this exact encrypted setting too. Even an ABA
    // parameter value cannot make an older editor revision current again.
    store.setSetting("service", "extension-runtime-kv", extension.id, vault.seal('{"version":1,"data":{"folder":"other"}}', extension.id));
    store.setSetting("service", "extension-runtime-kv", extension.id, vault.seal('{"version":1,"data":{"folder":"inbox"}}', extension.id));
    expect(() => manager.write(surface, saved.revision, '{"folder":"stale"}')).toThrow(/changed/u);
    const candidate = manager.beginCheck(surface, "token", "connection-one");
    credentials.upload(candidate.credentialUploadTicketId, "uninstalled-candidate", "connection-one");
    expect(await manager.check(surface, "token", candidate.credentialUploadTicketId, "connection-one", new AbortController().signal, () => undefined)).toEqual({ valid: true });
    expect(credentials.list()).toHaveLength(0);
    let current = catalog.beginSetup(extension.id, extension.revision);
    for (const [field, secret] of [["network-secret:token", "installed-first"], ["network-secret:secondary", "installed-second"]] as const) {
      const ticket = catalog.beginSetupCredentialUpload({ extensionId: extension.id, attemptId: current.setup.attemptId!, fieldId: field, kind: "header_secret", connectionId: "connection-one" });
      credentials.upload(ticket.credentialUploadTicketId, secret, "connection-one");
      current = await catalog.commitSetupCredential({ extensionId: extension.id, attemptId: current.setup.attemptId!, fieldId: field,
        credentialUploadTicketId: ticket.credentialUploadTicketId, connectionId: "connection-one", expectedRevision: current.revision });
    }
    const network = runtime.network!;
    const installedSecrets = network.secrets ?? [];
    expect(installedSecrets).toHaveLength(2);
    const references = ["token", "secondary"].map(key => extensionNetworkCredentialReference(extension.id, network,
      installedSecrets.find(secret => secret.key === key)!));
    expect(references.filter(reference => credentials.find(reference) !== undefined)).toHaveLength(2);
    expect(credentials.list()).toHaveLength(0);
    current = await catalog.clearSetupCredential(extension.id, "network-secret:token", current.revision, () => undefined);
    expect(references.filter(reference => credentials.find(reference) !== undefined)).toHaveLength(1);
    expect(credentials.find(references[0]!)).toBeUndefined();
    expect(credentials.resolve(references[1]!)).toBe("installed-second");
    expect(credentials.list()).toHaveLength(0);
    expect(current.setup.fields.find(field => field.id === "network-secret:token")?.configured).toBe(false);
    expect(current.setup.fields.find(field => field.id === "network-secret:secondary")?.configured).toBe(true);
    expect(() => manager.write(surface, manager.read(surface).revision, '{"value":"installed-second"}')).toThrow(/credentials/u);
    catalog.reconcile([resource({ ...packageResource, versionNumber: 5n })], []);
    expect(() => manager.read(surface)).toThrow(/installation changed/u);
  } finally { store.close(); }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-extension-catalog-"));
  const store = new OperationalStore(join(root, "orchestrator.db"), { now: () => NOW });
  const credentials = new CredentialManager({
    vault: await CredentialVault.open(join(root, "vault.key")),
    storagePath: join(root, "credentials.json"),
    now: () => NOW
  });
  await credentials.initialize();
  const catalog = new ExtensionCatalogManager({ store, credentials, now: () => NOW });
  catalog.initialize();
  return { root, store, credentials, catalog };
}

it("stops setup revocation after the original device loses authority between credential retirements", async () => {
  const { root, store, credentials, catalog } = await fixture();
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
  const host = new SessionHost(store, artifacts, []);
  try {
    await artifacts.initialize();
    await host.initialize();
    const originalKey = "extension-revoke-original", observerKey = "extension-revoke-observer";
    const original = store.createConnection({ id: "setup-original", name: "Original", authKeyDigest: digestAuthKey(originalKey) });
    store.createConnection({ id: "setup-observer", name: "Observer", authKeyDigest: digestAuthKey(observerKey) });
    const network = { hosts: ["api.example.test"], secrets: ["first", "second"].map(key => ({
      key, label: key, inject: { header: `X-${key}`, format: "{value}" }
    })) };
    const installed = resource({ kind: "package", resourceDetails: [{ ...resource().resourceDetails[0]!, entryPath: "extension.ts",
      runtime: { html: "ui/runtime/index.html", tools: [{ name: "read", description: "Read", inputSchema: { type: "object" }, readOnly: true }], network }
    }] });
    const entry = catalog.reconcile([installed], []).entries[0]!;
    let setup = catalog.beginSetup(entry.id, entry.revision);
    const attemptId = setup.setup.attemptId!;
    for (const field of setup.setup.fields.filter(field => field.kind === "secret")) {
      const ticket = catalog.beginSetupCredentialUpload({ extensionId: entry.id, attemptId, fieldId: field.id,
        kind: "header_secret", connectionId: original.id });
      credentials.upload(ticket.credentialUploadTicketId, `fixture-${field.id}`, original.id);
      setup = await catalog.commitSetupCredential({ extensionId: entry.id, attemptId, fieldId: field.id,
        credentialUploadTicketId: ticket.credentialUploadTicketId, connectionId: original.id, expectedRevision: setup.revision });
    }
    setup = catalog.submitSetupInteraction({ extensionId: entry.id, attemptId, fieldId: "permission-confirmation", value: true, expectedRevision: setup.revision });
    const ready = catalog.completeSetup(entry.id, attemptId, setup.revision);
    expect(ready.setup.state).toBe("ready");
    const [first, second] = network.secrets.map(secret => extensionNetworkCredentialReference(entry.id, network, secret));
    const retire = credentials.retireManagedCredential.bind(credentials);
    let unpause!: () => void, persisted!: () => void;
    const pending = new Promise<void>(resolve => { unpause = resolve; });
    const firstRetired = new Promise<void>(resolve => { persisted = resolve; });
    const calls = vi.spyOn(credentials, "retireManagedCredential").mockImplementation(async (...input) => {
      const result = await retire(...input);
      if (input[0] === first) { persisted(); await pending; }
      return result;
    });
    const application = { config: { publicOrigin: "https://orchestrator.example.test" }, store, adapters: [],
      sessionHost: host, extensionCatalog: catalog, connections: new ConnectionManager(store),
      piResources: { list: () => [installed], get: () => installed }
    } as unknown as OrchestratorApplication;
    const transport = createRouterTransport(router => registerConnectServices(router, application));
    const operations = createClient(contract.OperationService, transport);
    const extensions = createClient(contract.ExtensionService, transport);
    const authorization = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });
    const submitRevoke = (operationId: string, key: string) => operations.submitOperation({ operationId, mutation: {
      payload: { case: "revokeExtensionSetup", value: { extensionId: entry.id, expectedRevision: { value: ready.revision } } }
    } }, authorization(key));
    const started = submitRevoke("setup-revoke-first-device", originalKey);
    try {
      await Promise.race([firstRetired, started.then(() => { throw new Error("Setup revocation finished before the first credential retired."); })]);
      expect(credentials.find(first!)).toBeUndefined();
      expect(credentials.resolve(second!)).toBe("fixture-network-secret:second");
      await expect(operations.submitOperation({ operationId: "setup-revoke-device", mutation: { payload: {
        case: "revokeDevice", value: { deviceId: original.deviceId }
      } } }, authorization(observerKey))).resolves.toMatchObject({ operation: { state: contract.OperationState.SUCCEEDED } });
    } finally { unpause(); }
    await expect(started).resolves.toMatchObject({ operation: { state: contract.OperationState.FAILED } });
    expect(calls.mock.calls.map(([reference]) => reference)).toEqual([first]);
    expect(credentials.resolve(second!)).toBe("fixture-network-secret:second");
    await expect(extensions.getExtension({ extensionId: entry.id }, authorization(observerKey))).resolves.toMatchObject({
      extension: { setup: { fields: expect.arrayContaining([
        expect.objectContaining({ fieldId: "network-secret:first", configured: false }),
        expect.objectContaining({ fieldId: "network-secret:second", configured: true })
      ]) } }
    });
    await expect(submitRevoke("setup-revoke-first-device", originalKey)).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(submitRevoke("setup-revoke-second-device", observerKey)).resolves.toMatchObject({ operation: { state: contract.OperationState.SUCCEEDED } });
    expect(credentials.find(second!)).toBeUndefined();
  } finally { await host.dispose(); store.close(); }
});

it.each(["sidebar", "setup"] as const)("fences a credential clear against a concurrent %s change through the settings operation", async change => {
  const { root, store, credentials, catalog } = await fixture();
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
  const host = new SessionHost(store, artifacts, []);
  try {
    await artifacts.initialize();
    await host.initialize();
    const originalKey = "settings-clear-original", observerKey = "settings-clear-observer";
    const original = store.createConnection({ id: "clear-original", name: "Original", authKeyDigest: digestAuthKey(originalKey) });
    store.createConnection({ id: "clear-observer", name: "Observer", authKeyDigest: digestAuthKey(observerKey) });
    store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy", adapterKind: "fixture", instanceGeneration: 1,
      installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
    const secret = { key: "token", label: "Token", inject: { header: "X-Token", format: "{value}" } };
    const network = { hosts: ["api.example.test"], secrets: [secret] };
    const settings = { html: "ui/settings/index.html" }, extensionEntry = "extension.ts", packageName = "@fixture/settings";
    const runtime = parseExtensionRuntime({ html: "ui/runtime/index.html", tools: [{ name: "read", description: "Read", inputSchema: { type: "object" }, readOnly: true }], network });
    const installed = resource({ kind: "package", packageIdentity: packageName, resourceDetails: [{ ...resource().resourceDetails[0]!,
      entryPath: extensionEntry, mainView: { html: "ui/index.html" }, settings, runtime }] });
    const entry = catalog.reconcile([installed], []).entries[0]!;
    const backend = store.getBackend(installed.backendId);
    const surface: ExtensionMainViewSurface = { id: `extension_surface_${"b".repeat(32)}`, extensionId: entry.id, endpoint: "/private", expiresAt: NOW + 600_000,
      authority: { extensionId: entry.id, resourceId: installed.id, resourceRevision: installed.versionNumber,
        discoveredRevision: installed.discoveredRevision, backendId: installed.backendId, backendRevision: backend.revision,
        backendGeneration: backend.descriptor.instanceGeneration, packageName, packageVersion: installed.version, extensionEntry, mainView: settings, settings } };
    const fieldId = "network-secret:token", attempt = catalog.beginSetup(entry.id, entry.revision);
    const upload = catalog.beginSetupCredentialUpload({ extensionId: entry.id, attemptId: attempt.setup.attemptId!, fieldId, kind: "header_secret", connectionId: original.id });
    credentials.upload(upload.credentialUploadTicketId, "fixture-header-token", original.id);
    const saved = await catalog.commitSetupCredential({ extensionId: entry.id, attemptId: attempt.setup.attemptId!, fieldId,
      credentialUploadTicketId: upload.credentialUploadTicketId, connectionId: original.id, expectedRevision: attempt.revision });
    const reference = extensionNetworkCredentialReference(entry.id, network, secret);
    const generation = credentials.find(reference)?.generation;
    expect(generation).toBeTruthy();
    const retire = credentials.retireManagedCredential.bind(credentials);
    let resume!: () => void, reachedPause!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const atPause = new Promise<void>(resolve => { reachedPause = resolve; });
    const retireCall = vi.spyOn(credentials, "retireManagedCredential").mockImplementation(async (...input) => {
      if (change === "sidebar") {
        const deleted = await retire(...input);
        reachedPause(); await paused;
        return deleted;
      }
      reachedPause(); await paused;
      return retire(...input);
    });
    const vault = await CredentialVault.open(join(root, "vault.key"));
    const application = { config: { publicOrigin: "https://orchestrator.example.test" }, store, adapters: [], sessionHost: host,
      extensionCatalog: catalog, connections: new ConnectionManager(store), piResources: { list: () => [installed], get: () => installed },
      extensionSettings: new ExtensionSettingsManager({ store, vault, credentials, catalog,
        fetch: vi.fn(async () => { throw new Error("Credential clear must stay local."); }) }),
      extensionMainViews: { getSurface: async () => surface, isSurfaceCurrent: (id: string, connection: string) => id === surface.id && connection === original.id }
    } as unknown as OrchestratorApplication;
    const transport = createRouterTransport(router => registerConnectServices(router, application));
    const operations = createClient(contract.OperationService, transport), extensions = createClient(contract.ExtensionService, transport);
    const originalAuth = { headers: { authorization: `Bearer ${originalKey}` } };
    const observerAuth = { headers: { authorization: `Bearer ${observerKey}` } };
    const revision = { extensionId: entry.id, expectedRevision: { value: saved.revision } };
    const clear = { operationId: "settings-clear-secret", mutation: { payload: {
      case: "clearExtensionSetupCredential" as const, value: { ...revision, surfaceId: surface.id, fieldId }
    } } };
    const clearing = operations.submitOperation(clear, originalAuth);
    try {
      await Promise.race([atPause, clearing.then(() => { throw new Error("Clear finished before the Vault interleaving."); })]);
      const payload = change === "sidebar" ? { case: "setExtensionSidebarVisible" as const, value: { ...revision, visible: true } }
        : { case: "beginExtensionSetup" as const, value: revision };
      await expect(operations.submitOperation({ operationId: "settings-concurrent-edit", mutation: { payload } }, observerAuth))
        .resolves.toMatchObject({ operation: { state: contract.OperationState.SUCCEEDED } });
    } finally { resume(); }
    const result = change === "sidebar" ? contract.OperationState.SUCCEEDED : contract.OperationState.FAILED;
    await expect(clearing).resolves.toMatchObject({ operation: { state: result } });
    await expect(operations.getOperation({ operationId: clear.operationId }, originalAuth)).resolves.toMatchObject({ operation: { state: result } });
    await expect(operations.submitOperation(clear, originalAuth)).resolves.toMatchObject({ operation: { state: result } });
    expect(retireCall).toHaveBeenCalledOnce();
    expect(credentials.find(reference)?.generation).toBe(change === "sidebar" ? undefined : generation);
    await expect(extensions.getExtension({ extensionId: entry.id }, observerAuth)).resolves.toMatchObject({ extension: {
      sidebarVisible: change === "sidebar", setup: { fields: expect.arrayContaining([expect.objectContaining({ fieldId, configured: change === "setup" })]) }
    } });
  } finally { await host.dispose(); store.close(); }
});

function resource(overrides: Partial<PiResourceDescriptor> = {}): PiResourceDescriptor {
  return {
    id: "resource-extension-a",
    backendId: "pi",
    kind: "extension",
    scope: "managed",
    name: "Workspace navigator",
    version: "1.2.0",
    sourceKind: "local",
    sourceIdentity: "local:workspace-navigator",
    sourceDisplay: "D:\\extensions\\workspace-navigator",
    canonicalPathFingerprint: "sha256:canonical-path",
    symbolicLinkDetected: false,
    specialFileDetected: false,
    discoveredRevision: "sha256:resource-generation-a",
    resourceDetails: [{
      kind: "extension",
      name: "Workspace navigator",
      compatibility: "supported",
      compatibilityIssues: [],
      detectedApis: ["notify"],
      adaptedApis: ["notify"],
      unsupportedApis: []
    }],
    runtimeRequirements: [],
    warnings: [],
    disabledLifecycleScripts: [],
    canToggle: true,
    requiresExtensionApproval: true,
    extensionContentFingerprint: "sha256:extension-content",
    postMutationNotice: false,
    state: "loaded",
    enabled: true,
    versionNumber: 4n,
    updatedAt: NOW,
    ...overrides
  };
}

function mcp(overrides: Partial<McpServerDescriptor> = {}): McpServerDescriptor {
  return {
    id: "mcp-search",
    displayName: "Research connector",
    transport: "streamable_http",
    endpointDisplay: "https://research.example/mcp",
    enabled: true,
    state: "connected",
    runtimeGeneration: 2,
    tools: [{
      serverId: "mcp-search",
      name: "search",
      description: "Search the connected corpus",
      inputSchema: { type: "object" },
      requiresPermission: true
    }],
    credentialBindings: [{
      target: "header",
      name: "Authorization",
      credentialReferenceId: "cred_extension_research",
      configured: false
    }],
    configuration: { case: "streamableHttp", endpoint: "https://research.example/mcp" },
    version: 3n,
    updatedAt: NOW,
    ...overrides
  };
}

function source(overrides: Partial<ExtensionSourceDescriptor> = {}): ExtensionSourceDescriptor {
  return {
    id: "extension_source_0123456789abcdef0123456789abcdef",
    revision: 3n,
    source: { kind: "git", repositoryUrl: "https://example.test/extensions.git", sparsePaths: [] },
    sourceIdentity: '["git","https://example.test/extensions.git",null,[]]',
    sourceDisplay: "https://example.test/extensions.git",
    name: "community-extensions",
    state: "ready",
    contentRevision: `sha256:${"a".repeat(64)}`,
    entries: [{
      id: "extension_source_entry_0123456789abcdef0123456789abcdef",
      revision: `sha256:${"b".repeat(64)}`,
      contentRevision: `sha256:${"b".repeat(64)}`,
      packageContentRevision: `sha256:${"c".repeat(64)}`,
      resourceId: "resource-extension-a",
      packageRelativePath: "packages/navigation",
      extensionRelativePath: "extensions/navigation.ts",
      bindingName: "Workspace navigator",
      bindingOrdinal: 0,
      name: "Workspace navigator",
      packageName: "@sample/navigation",
      version: "1.2.0",
      author: "Package Author",
      description: "Navigate a workspace"
    }],
    declaredEntryCount: 1,
    skippedEntryCount: 0,
    unreadableEntryCount: 0,
    addedAt: NOW,
    refreshedAt: NOW,
    ...overrides
  };
}

describe("ExtensionCatalogManager", () => {
  it("uses host setup for runtime network secrets and requires fresh approval when destinations expand", async () => {
    const { store, credentials, catalog } = await fixture();
    try {
      const network = { hosts: ["api.example.test"], secrets: [{ key: "key", label: "Account key", inject: { header: "Authorization", format: "Bearer {value}" } }] };
      const runtime = { html: "ui/runtime/index.html", tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" }, readOnly: true }], network };
      const original = resource(), detail = original.resourceDetails[0]!;
      const installed = resource({ kind: "package", resourceDetails: [{ ...detail, entryPath: "extensions/main.ts", runtime }] });
      const entry = catalog.reconcile([installed], []).entries[0]!;
      expect(entry.setup.state).toBe("required"); expect(entry.permissions.some(permission => permission.description.includes("api.example.test"))).toBe(true);
      const attempt = catalog.beginSetup(entry.id, entry.revision), attemptId = attempt.setup.attemptId!;
      const field = attempt.setup.fields.find(field => field.kind === "secret")!;
      const ticket = catalog.beginSetupCredentialUpload({ extensionId: entry.id, attemptId, fieldId: field.id, kind: "api_key", connectionId: "owner" });
      credentials.upload(ticket.credentialUploadTicketId, "host-only-fixture-secret", "owner");
      const committed = await catalog.commitSetupCredential({ extensionId: entry.id, attemptId, fieldId: field.id,
        credentialUploadTicketId: ticket.credentialUploadTicketId, connectionId: "owner", expectedRevision: attempt.revision });
      const confirmed = catalog.submitSetupInteraction({ extensionId: entry.id, attemptId, fieldId: "permission-confirmation", value: true, expectedRevision: committed.revision });
      expect(catalog.completeSetup(entry.id, attemptId, confirmed.revision).setup.state).toBe("ready");
      const reference = extensionNetworkCredentialReference(entry.id, network, network.secrets[0]!);
      expect(credentials.resolve(reference)).toBe("host-only-fixture-secret"); expect(credentials.list()).toEqual([]);
      const changedNetwork = { ...network, hosts: [...network.hosts, "uploads.example.test"] };
      const updated = catalog.reconcile([resource({ ...installed, resourceDetails: [{ ...detail, entryPath: "extensions/main.ts", runtime: { ...runtime, network: changedNetwork } }] })], []).entries[0]!;
      expect(updated.setup.state).toBe("required");
      expect(credentials.find(extensionNetworkCredentialReference(entry.id, changedNetwork, changedNetwork.secrets[0]!))).toBeUndefined();
      expect(JSON.stringify(store.listSettings(), (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("host-only-fixture-secret");
    } finally { store.close(); }
  });
  it("projects installed/local/market detail and exposes Use only for an exact live Resource command", async () => {
    const { store, catalog } = await fixture();
    try {
      const initial = catalog.reconcile([resource()], [mcp()]);
      expect(initial.entries).toHaveLength(2);
      expect(initial.entries.map((entry) => entry.source).sort()).toEqual(["local", "market"]);

      const extension = initial.entries.find((entry) => entry.owner.kind === "resource");
      expect(extension).toMatchObject({
        installed: true,
        installState: "installed",
        enabled: true,
        useSupported: false,
        setup: { state: "not_required" }
      });
      const observed = catalog.snapshot({
        sessionId: "session-a",
        commands: [
          { name: "open-nav", description: "Open navigation", source: "extension", inputMode: "text", loaded: true, resourceId: "other-resource" },
          { name: "open-nav", description: "Open navigation", source: "extension", inputMode: "text", loaded: true, resourceId: "resource-extension-a" }
        ]
      }).entries.find((entry) => entry.id === extension?.id);
      expect(observed?.commands).toEqual([{ name: "open-nav", description: "Open navigation", sessionId: "session-a" }]);
      expect(observed?.useSupported).toBe(true);
    } finally {
      store.close();
    }
  });

  it("projects an exact source-owned available entry and keeps its Extension ID when Resource takes ownership", async () => {
    const { store, catalog } = await fixture();
    try {
      const available = catalog.reconcile([], [], [source()]).entries[0]!;
      expect(available).toMatchObject({
        owner: {
          kind: "source",
          sourceId: "extension_source_0123456789abcdef0123456789abcdef",
          sourceRevision: 3n,
          entryId: "extension_source_entry_0123456789abcdef0123456789abcdef",
          contentRevision: `sha256:${"b".repeat(64)}`
        },
        source: "market",
        installed: false,
        installState: "available",
        enabled: false,
        sidebarSupported: false
      });

      const adopted = catalog.reconcile([resource()], [], [source()]).entries[0]!;
      expect(adopted.id).toBe(available.id);
      expect(adopted).toMatchObject({ owner: { kind: "resource", resourceId: "resource-extension-a" }, installed: true });
      expect(adopted.revision).toBeGreaterThan(available.revision);
    } finally {
      store.close();
    }
  });

  it("projects a declared main view as the only sidebar-capable Extension surface", async () => {
    const { store, catalog } = await fixture();
    const mainView = { html: "ui/navigation/index.html", title: "Navigator", icon: "layout" as const };
    try {
      const sourceEntry = source({ entries: [{ ...source().entries[0]!, mainView }] });
      const available = catalog.reconcile([], [], [sourceEntry]).entries[0]!;
      expect(available).toMatchObject({ installed: false, mainView, sidebarSupported: true, sidebarVisible: false });

      const installedResource = resource({
        resourceDetails: [{
          ...resource().resourceDetails[0]!,
          entryPath: "extensions/navigation.ts",
          mainView
        }]
      });
      const installed = catalog.reconcile([installedResource], [], [sourceEntry]).entries[0]!;
      expect(installed).toMatchObject({ installed: true, enabled: true, mainView, sidebarSupported: true, sidebarVisible: false });
      const visible = catalog.setSidebarVisible(installed.id, true, installed.revision);
      expect(visible.sidebarVisible).toBe(true);
    } finally {
      store.close();
    }
  });

  it("keeps a declared Library capability on the stable Source-to-Resource Extension identity", async () => {
    const { store, catalog } = await fixture();
    const library = { schemaVersion: 1 as const };
    try {
      const sourceEntry = source({ entries: [{ ...source().entries[0]!, library }] });
      const available = catalog.reconcile([], [], [sourceEntry]).entries[0]!;
      expect(available).toMatchObject({ installed: false, library });

      const installedResource = resource({
        resourceDetails: [{
          ...resource().resourceDetails[0]!,
          entryPath: "extensions/navigation.ts",
          library
        }]
      });
      const installed = catalog.reconcile([installedResource], [], [sourceEntry]).entries[0]!;
      expect(installed.id).toBe(available.id);
      expect(installed).toMatchObject({ installed: true, enabled: true, library });
    } finally {
      store.close();
    }
  });

  it("projects exact recommendations across Source-to-Resource ownership and revisions author text changes", async () => {
    const { store, catalog } = await fixture();
    const recommendations = [{
      id: "review-workspace",
      label: "Review workspace",
      prompt: "Review this workspace for correctness.",
      command: "review",
      locales: { "zh-CN": { label: "审查工作区", prompt: "审查此工作区的正确性。" } }
    }, {
      id: "plan-work",
      label: "Plan work",
      prompt: "Create a concrete implementation plan."
    }] as const;
    try {
      const sourceEntry = source({ entries: [{ ...source().entries[0]!, recommendations }] });
      const available = catalog.reconcile([], [], [sourceEntry]).entries[0]!;
      expect(available.recommendations).toEqual(recommendations);

      const installedResource = resource({
        resourceDetails: [{
          ...resource().resourceDetails[0]!,
          entryPath: "extensions/navigation.ts",
          recommendations
        }]
      });
      const installed = catalog.reconcile([installedResource], [], [sourceEntry]).entries[0]!;
      expect(installed.id).toBe(available.id);
      expect(installed.recommendations).toEqual(recommendations);

      const changedRecommendations = [{
        ...recommendations[0],
        prompt: "Review this workspace and propose concrete fixes."
      }] as const;
      const changed = catalog.reconcile([resource({
        resourceDetails: [{
          ...resource().resourceDetails[0]!,
          entryPath: "extensions/navigation.ts",
          recommendations: changedRecommendations
        }]
      })], [], [sourceEntry]).entries[0]!;
      expect(changed.id).toBe(installed.id);
      expect(changed.revision).toBeGreaterThan(installed.revision);
      expect(changed.recommendations).toEqual(changedRecommendations);
    } finally {
      store.close();
    }
  });

  it("projects same-source updates and treats a removed then re-added source as explicit replacement provenance", async () => {
    const { store, catalog } = await fixture();
    try {
      const original = source({
        entries: [{
          ...source().entries[0]!,
          packageContentRevision: `sha256:${"d".repeat(64)}`
        }]
      });
      const installed = resource({
        kind: "package",
        sourceKind: "extension_source",
        sourceIdentity: "extension-source-package",
        sourceDisplay: original.sourceDisplay,
        discoveredRevision: `sha256:${"d".repeat(64)}`,
        packageIdentity: "@sample/navigation",
        extensionSource: {
          sourceId: original.id,
          sourceRevision: original.revision,
          packageRelativePath: "packages/navigation",
          packageContentRevision: `sha256:${"d".repeat(64)}`
        },
        requiresExtensionApproval: false
      });
      const current = catalog.reconcile([installed], [], [original]).entries[0]!;
      expect(current.installState).toBe("installed");
      expect(current.update).toBeUndefined();

      const refreshed = source({
        revision: 4n,
        entries: [{
          ...source().entries[0]!,
          revision: `sha256:${"e".repeat(64)}`,
          contentRevision: `sha256:${"e".repeat(64)}`,
          packageContentRevision: `sha256:${"f".repeat(64)}`,
          version: "2.0.0"
        }]
      });
      const update = catalog.reconcile([installed], [], [refreshed]).entries[0]!;
      expect(update.id).toBe(current.id);
      expect(update.revision).toBeGreaterThan(current.revision);
      expect(update).toMatchObject({
        installState: "update_available",
        update: {
          sourceId: original.id,
          sourceRevision: 4n,
          entryId: refreshed.entries[0]!.id,
          contentRevision: refreshed.entries[0]!.contentRevision,
          availableVersion: "2.0.0",
          sourceReplacement: false
        }
      });

      const removed = catalog.reconcile([installed], [], []).entries[0]!;
      expect(removed.installState).toBe("installed");
      expect(removed.update).toBeUndefined();
      const readded = source({
        id: "extension_source_fedcba9876543210fedcba9876543210",
        revision: 1n,
        entries: [{
          ...original.entries[0]!,
          id: "extension_source_entry_fedcba9876543210fedcba9876543210"
        }]
      });
      const replacement = catalog.reconcile([installed], [], [readded]).entries[0]!;
      expect(replacement).toMatchObject({
        installState: "update_available",
        update: {
          sourceId: readded.id,
          sourceRevision: 1n,
          entryId: readded.entries[0]!.id,
          sourceReplacement: true
        }
      });
    } finally {
      store.close();
    }
  });

  it("advances exact owner revisions and rolls back an unpublished reconcile", async () => {
    const { store, catalog } = await fixture();
    try {
      const initial = catalog.reconcile([resource()], []).entries[0]!;
      const authorityChanged = vi.fn();
      const stop = catalog.onAuthorityChanged(authorityChanged);
      const persistence = vi.spyOn(store, "setSetting");
      persistence.mockImplementationOnce(() => { throw new Error("storage unavailable"); });

      expect(() => catalog.reconcile([resource({ versionNumber: 5n })], [])).toThrow("storage unavailable");
      expect(authorityChanged).not.toHaveBeenCalled();
      expect(catalog.snapshot().entries[0]).toMatchObject({
        revision: initial.revision,
        owner: { kind: "resource", resourceVersion: 4n }
      });

      const advanced = catalog.reconcile([resource({ versionNumber: 5n })], []).entries[0]!;
      expect(advanced.revision).toBeGreaterThan(initial.revision);
      expect(advanced.owner).toMatchObject({ kind: "resource", resourceVersion: 5n });
      expect(authorityChanged).toHaveBeenCalledWith([initial.id]);
      stop();
    } finally {
      store.close();
    }
  });

  it("projects a withdrawn setup confirmation as incomplete and allows confirming the same attempt", async () => {
    const { store, catalog } = await fixture();
    try {
      const runtime = parseExtensionRuntime({ html: "ui/runtime/index.html", tools: [{ name: "read", description: "Read", inputSchema: { type: "object" }, readOnly: true }],
        network: { hosts: ["api.example.test"] } });
      const installed = resource({ kind: "package", resourceDetails: [{ ...resource().resourceDetails[0]!, entryPath: "extension.ts", runtime }] });
      const entry = catalog.reconcile([installed], []).entries[0]!;
      let setup = catalog.beginSetup(entry.id, entry.revision);
      const attemptId = setup.setup.attemptId!;
      expect(setup.setup.fields).toEqual([expect.objectContaining({ id: "permission-confirmation", kind: "confirmation", required: true, configured: false })]);
      const confirm = (value: boolean) => catalog.submitSetupInteraction({ extensionId: entry.id, attemptId,
        fieldId: "permission-confirmation", value, expectedRevision: setup.revision });

      setup = confirm(true);
      expect(setup.setup.fields[0]?.configured).toBe(true);
      setup = confirm(false);
      expect(setup.setup.fields[0]?.configured).toBe(false);
      expect(catalog.snapshot().entries[0]?.setup).toMatchObject({ attemptId, state: "in_progress", fields: [{ configured: false }] });
      expect(() => catalog.completeSetup(entry.id, attemptId, setup.revision)).toThrow(/incomplete/u);

      setup = confirm(true);
      expect(catalog.completeSetup(entry.id, attemptId, setup.revision).setup.state).toBe("ready");
    } finally { store.close(); }
  });

  it("keeps setup secrets in the Credential owner, fences mutations, and preserves authorization across enable changes", async () => {
    const { store, credentials, catalog } = await fixture();
    const secret = "extension-private-token-with-entropy";
    try {
      const entry = catalog.reconcile([], [mcp()]).entries[0]!;
      expect(entry.setup.state).toBe("required");
      const started = catalog.beginSetup(entry.id, entry.revision);
      const attemptId = started.setup.attemptId!;
      const credentialField = started.setup.fields.find((field) => field.kind === "secret")!;
      const confirmationField = started.setup.fields.find((field) => field.kind === "confirmation")!;
      const ticket = catalog.beginSetupCredentialUpload({
        extensionId: entry.id,
        attemptId,
        fieldId: credentialField.id,
        kind: "header_secret",
        connectionId: "connection-a"
      });
      credentials.upload(ticket.credentialUploadTicketId, secret, "connection-a");
      const credentialCommitted = await catalog.commitSetupCredential({
        extensionId: entry.id,
        attemptId,
        fieldId: credentialField.id,
        credentialUploadTicketId: ticket.credentialUploadTicketId,
        connectionId: "connection-a",
        expectedRevision: started.revision
      });
      const confirmed = catalog.submitSetupInteraction({
        extensionId: entry.id,
        attemptId,
        fieldId: confirmationField.id,
        value: true,
        expectedRevision: credentialCommitted.revision
      });
      const ready = catalog.completeSetup(entry.id, attemptId, confirmed.revision);
      expect(ready.setup.state).toBe("ready");
      // A pure tool-provider remains available to the Agent but has no
      // composer entry action until it advertises a runtime command.
      expect(ready.useSupported).toBe(false);
      expect(credentials.list()).toEqual([]);
      expect(credentials.resolve("cred_extension_research")).toBe(secret);
      expect(JSON.stringify(store.listSettings(), (_key, value) => typeof value === "bigint" ? value.toString(10) : value)).not.toContain(secret);

      expect(ready).toMatchObject({ sidebarSupported: false, sidebarVisible: false });
      expect(() => catalog.setSidebarVisible(entry.id, true, ready.revision)).toThrow(/does not advertise/u);
      const disabled = catalog.reconcile([], [mcp({ enabled: false, state: "disabled", version: 4n })]).entries[0]!;
      expect(disabled).toMatchObject({ sidebarVisible: false, enabled: false, useSupported: false, setup: { state: "ready" } });
      expect(disabled.revision).toBeGreaterThan(ready.revision);

      const changedAuthority = catalog.reconcile([], [mcp({
        endpointDisplay: "https://other.example/mcp",
        configuration: { case: "streamableHttp", endpoint: "https://other.example/mcp" },
        version: 5n
      })]).entries[0]!;
      expect(changedAuthority.setup.state).toBe("required");
      expect(changedAuthority.sidebarVisible).toBe(false);
    } finally {
      store.close();
    }
  });

  it("supports cancel, retry, failure and revoke without treating a stale attempt as ready", async () => {
    const { store, catalog } = await fixture();
    try {
      const server = mcp({ credentialBindings: [] });
      const entry = catalog.reconcile([], [server]).entries[0]!;
      const first = catalog.beginSetup(entry.id, entry.revision);
      const firstAttempt = first.setup.attemptId!;
      const cancelled = catalog.cancelSetup(entry.id, firstAttempt, first.revision);
      expect(cancelled.setup.state).toBe("cancelled");

      const retry = catalog.beginSetup(entry.id, cancelled.revision);
      expect(retry.setup.attemptId).not.toBe(firstAttempt);
      const failed = catalog.failSetup(entry.id, retry.setup.attemptId!, "Connection could not be verified");
      expect(failed.setup).toMatchObject({ state: "failed", error: "Connection could not be verified" });
      const finalAttempt = catalog.beginSetup(entry.id, failed.revision);
      const confirmation = finalAttempt.setup.fields.find((field) => field.kind === "confirmation")!;
      const confirmed = catalog.submitSetupInteraction({
        extensionId: entry.id,
        attemptId: finalAttempt.setup.attemptId!,
        fieldId: confirmation.id,
        value: true,
        expectedRevision: finalAttempt.revision
      });
      const ready = catalog.completeSetup(entry.id, finalAttempt.setup.attemptId!, confirmed.revision);
      expect(ready.setup.state).toBe("ready");
      expect(() => catalog.completeSetup(entry.id, firstAttempt, ready.revision)).toThrow(/stale/u);
      await expect(catalog.revokeSetup(entry.id, ready.revision, () => undefined)).resolves.toMatchObject({ setup: { state: "required" } });
    } finally {
      store.close();
    }
  });

  it("resets malformed durable state, reports recovery, and persists a clean catalog", async () => {
    const { store, credentials } = await fixture();
    try {
      store.setSetting("service", "orchestrator", "extension_catalog", {
        format: 1,
        revision: "not-a-revision",
        records: [{ secret: "must-not-be-trusted" }]
      });
      const recovered = new ExtensionCatalogManager({ store, credentials, now: () => NOW });
      recovered.initialize();
      const snapshot = recovered.reconcile([resource()], []);
      expect(snapshot.recoveredFromCorruption).toBe(true);
      expect(snapshot.entries[0]).toMatchObject({ sidebarVisible: false, setup: { state: "not_required" } });

      const restarted = new ExtensionCatalogManager({ store, credentials, now: () => NOW });
      restarted.initialize();
      expect(restarted.reconcile([resource()], []).recoveredFromCorruption).toBe(false);
    } finally {
      store.close();
    }
  });
});

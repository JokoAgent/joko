import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { ExtensionCatalogManager } from "./extension-catalog.js";
import type { ExtensionSourceDescriptor } from "./extension-source-manager.js";
import type { McpServerDescriptor } from "./mcp-router.js";
import type { PiResourceDescriptor } from "./resource-manager.js";

const NOW = 1_800_000_000_000;

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
          { name: "open-nav", description: "Open navigation", source: "extension", loaded: true, resourceId: "other-resource" },
          { name: "open-nav", description: "Open navigation", source: "extension", loaded: true, resourceId: "resource-extension-a" }
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
      const persistence = vi.spyOn(store, "setSetting");
      persistence.mockImplementationOnce(() => { throw new Error("storage unavailable"); });

      expect(() => catalog.reconcile([resource({ versionNumber: 5n })], [])).toThrow("storage unavailable");
      expect(catalog.snapshot().entries[0]).toMatchObject({
        revision: initial.revision,
        owner: { kind: "resource", resourceVersion: 4n }
      });

      const advanced = catalog.reconcile([resource({ versionNumber: 5n })], []).entries[0]!;
      expect(advanced.revision).toBeGreaterThan(initial.revision);
      expect(advanced.owner).toMatchObject({ kind: "resource", resourceVersion: 5n });
    } finally {
      store.close();
    }
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

      const withSidebar = catalog.setSidebarVisible(entry.id, true, ready.revision);
      expect(() => catalog.setSidebarVisible(entry.id, false, ready.revision)).toThrow(/concurrently/u);
      const disabled = catalog.reconcile([], [mcp({ enabled: false, state: "disabled", version: 4n })]).entries[0]!;
      expect(disabled).toMatchObject({ sidebarVisible: true, enabled: false, useSupported: false, setup: { state: "ready" } });
      expect(disabled.revision).toBeGreaterThan(withSidebar.revision);

      const changedAuthority = catalog.reconcile([], [mcp({
        endpointDisplay: "https://other.example/mcp",
        configuration: { case: "streamableHttp", endpoint: "https://other.example/mcp" },
        version: 5n
      })]).entries[0]!;
      expect(changedAuthority.setup.state).toBe("required");
      expect(changedAuthority.sidebarVisible).toBe(true);
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
      await expect(catalog.revokeSetup(entry.id, ready.revision)).resolves.toMatchObject({ setup: { state: "required" } });
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

import { readFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { describe, expect, it } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { DiagnosticsBundleService } from "./diagnostics-bundle.js";

describe("DiagnosticsBundleService", () => {
  it("stores a bounded artifact with exact and pattern-based secret redaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-diagnostics-"));
    const store = new OperationalStore(join(root, "orchestrator.db"));
    const vault = await CredentialVault.open(join(root, "vault.key"));
    const credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") });
    await credentials.initialize();
    const secret = "diagnostic-secret-exact-value";
    const ticket = credentials.createUploadTicket();
    credentials.upload(ticket.credentialUploadTicketId, secret);
    await credentials.commitUpload({
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: "cred_diagnostic_test",
      displayName: "Diagnostic test",
      kind: "api_key"
    });
    store.appendDiagnostic({
      id: "diagnostic-1",
      severity: "error",
      component: "provider",
      code: "PROVIDER_FAILED",
      message: `provider echoed ${secret}`,
      details: {
        arbitraryEcho: secret,
        authorization: "Bearer should-never-survive",
        path: "C:\\Users\\Joseph\\.ssh\\id_ed25519"
      }
    });
    store.setSetting("service", "orchestrator", "public_test_setting", { credentialReferenceId: "cred_diagnostic_test", publicValue: "okay" });
    const artifacts = new ArtifactStore({
      rootDirectory: join(root, "artifacts"),
      repository: new OperationalArtifactRepository(store),
      ingestRoots: [root]
    });
    await artifacts.initialize();
    const service = new DiagnosticsBundleService({
      store,
      artifacts,
      credentials,
      serviceVersion: "0.1.0-test",
      collectors: {
        runtime: () => ({ tokenEcho: secret, safe: true })
      }
    });

    const artifact = await service.create({ level: "verbose", diagnosticIds: ["diagnostic-1"] });
    const body = await readFile(artifact.storagePath, "utf8");
    expect(body).not.toContain(secret);
    expect(body).not.toContain("should-never-survive");
    expect(body).not.toContain("Joseph");
    expect(body).not.toContain("cred_diagnostic_test");
    expect(body).toContain("[REDACTED]");
    expect(artifact.mimeType).toBe("application/json");
    expect(store.listDiagnostics({ component: "diagnostics" })).toHaveLength(1);
    store.close();
  });

  it("omits messages, details, and collector output at minimal level", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-diagnostics-minimal-"));
    const store = new OperationalStore(join(root, "orchestrator.db"));
    const vault = await CredentialVault.open(join(root, "vault.key"));
    const credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") });
    await credentials.initialize();
    store.appendDiagnostic({ severity: "info", component: "test", code: "DETAIL", message: "private detail", details: { private: "value" } });
    const artifacts = new ArtifactStore({
      rootDirectory: join(root, "artifacts"),
      repository: new OperationalArtifactRepository(store),
      ingestRoots: [root]
    });
    await artifacts.initialize();
    const service = new DiagnosticsBundleService({
      store,
      artifacts,
      credentials,
      serviceVersion: "test",
      collectors: { shouldNotRun: () => { throw new Error("collector ran"); } }
    });
    const artifact = await service.create({ level: "minimal" });
    const body = await readFile(artifact.storagePath, "utf8");
    expect(body).not.toContain("private detail");
    expect(body).not.toContain('"collectors"');
    expect(body).toContain("omitted at minimal level");
    store.close();
  });

  it("selects an explicitly requested diagnostic beyond ten thousand newer records", { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-diagnostics-deep-id-"));
    const store = new OperationalStore(join(root, "orchestrator.db"));
    store.transaction((transactionStore) => {
      transactionStore.appendDiagnostic({
        id: "diagnostic-oldest",
        severity: "warning",
        component: "deep-history",
        code: "OLDEST_REQUESTED",
        message: "Explicitly selected old record",
        createdAt: 1
      });
      for (let index = 0; index < 10_000; index += 1) {
        transactionStore.appendDiagnostic({
          id: `diagnostic-newer-${index}`,
          severity: "info",
          component: "deep-history",
          code: "NEWER",
          message: "Newer record",
          createdAt: index + 2
        });
      }
    });
    const vault = await CredentialVault.open(join(root, "vault.key"));
    const credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") });
    await credentials.initialize();
    const artifacts = new ArtifactStore({
      rootDirectory: join(root, "artifacts"),
      repository: new OperationalArtifactRepository(store),
      ingestRoots: [root]
    });
    await artifacts.initialize();
    const service = new DiagnosticsBundleService({
      store,
      artifacts,
      credentials,
      serviceVersion: "test"
    });

    const artifact = await service.create({ level: "standard", diagnosticIds: ["diagnostic-oldest"] });
    const body = await readFile(artifact.storagePath, "utf8");
    expect(body).toContain("OLDEST_REQUESTED");
    expect(body).not.toContain("diagnostic-newer-9999");
    store.close();
  });
});

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { expect, it } from "vitest";
import { ConnectionManager } from "./connection-manager.js";
import type { OrchestratorConfig } from "./config.js";
import { CredentialVault } from "./credential-vault.js";
import { openLinkspanIdentity } from "./linkspan-identity.js";
import { recoverOfflineEndpointIdentity } from "./linkspan-recovery.js";

it("recovers a lost endpoint and invalidates restored backup access without changing node or product records", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-endpoint-recovery-"));
  const databasePath = join(root, "state.db"), keyPath = join(root, "credentials", "linkspan-identity.json");
  const config = { dataDirectory: root, databasePath, host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1" } as OrchestratorConfig;
  let store: OperationalStore | undefined = new OperationalStore(databasePath);
  try {
    store.setSetting("service", "orchestrator", "public.node_identity", { serverId: "restored-node" });
    store.setSetting("session", "preserved-task", "test.product", { retained: true });
    const vault = await CredentialVault.open(join(root, "credentials", "master.key"));
    const previous = await openLinkspanIdentity({ dataDirectory: root, serverId: "restored-node", store, vault });
    const manager = new ConnectionManager(store);
    const used = manager.issuePairing("Original device");
    const paired = manager.completePairing({ challengeId: used.id, code: used.code, connectionName: "Original" });
    const pending = manager.issuePairing("Old pending invitation");
    const originalKeyFile = await readFile(keyPath);
    store.close(); store = undefined;
    await copyFile(databasePath, join(root, "old-backup.db"));
    await rm(keyPath);
    const recovered = await recoverOfflineEndpointIdentity(config);
    expect(recovered.serverId).toBe("restored-node");
    expect(recovered.endpointPublicKey).not.toBe(previous.publicKey);
    const assertRevoked = async (): Promise<void> => {
      store = new OperationalStore(databasePath);
      const current = new ConnectionManager(store);
      expect(() => current.authenticate(`Bearer ${paired.authKey}`)).toThrow(/revoked|invalid/iu);
      expect(() => current.completePairing({ challengeId: pending.id, code: pending.code, connectionName: "Late" })).toThrow();
      expect(store.findSetting("session", "preserved-task", "test.product")?.value).toEqual({ retained: true });
      expect((await openLinkspanIdentity({ dataDirectory: root, serverId: "restored-node", store, vault })).publicKey)
        .toBe(store.findSetting<{ publicKey: string }>("service", "orchestrator", "public.linkspan_identity")?.value.publicKey);
      store.close(); store = undefined;
    };
    await assertRevoked();
    // A complete old backup also contains the old authority/version/key. The
    // independent local action must revoke it again and generate a fresh pin.
    await copyFile(join(root, "old-backup.db"), databasePath);
    await writeFile(keyPath, originalKeyFile);
    const restored = await recoverOfflineEndpointIdentity(config);
    expect(restored.endpointPublicKey).not.toBe(previous.publicKey);
    expect(restored.endpointPublicKey).not.toBe(recovered.endpointPublicKey);
    await assertRevoked();
  } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
});

it("refuses endpoint recovery while the configured service listener is active", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-running-recovery-"));
  const databasePath = join(root, "state.db");
  const store = new OperationalStore(databasePath); store.close();
  const running = createServer();
  await new Promise<void>(resolve => running.listen(0, "127.0.0.1", resolve));
  try {
    const address = running.address();
    if (!address || typeof address === "string") throw new Error("Missing test port.");
    await expect(recoverOfflineEndpointIdentity({ dataDirectory: root, databasePath, host: "127.0.0.1", port: address.port,
      publicOrigin: `http://127.0.0.1:${address.port}` } as OrchestratorConfig)).rejects.toThrow(/Stop this node/u);
  } finally {
    await new Promise<void>(resolve => running.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps access revoked and startup closed if publishing the recovered key fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-key-publish-failure-"));
  const databasePath = join(root, "state.db"), path = join(root, "credentials", "linkspan-identity.json");
  let store: OperationalStore | undefined = new OperationalStore(databasePath);
  try {
    const vault = await CredentialVault.open(join(root, "credentials", "master.key"));
    const previous = await openLinkspanIdentity({ dataDirectory: root, serverId: "recovery-failure", store, vault });
    store.setSetting("service", "orchestrator", "public.node_identity", { serverId: "recovery-failure" });
    const manager = new ConnectionManager(store), issued = manager.issuePairing();
    const paired = manager.completePairing({ challengeId: issued.id, code: issued.code, connectionName: "Previous" });
    await rm(path); await mkdir(path);
    // Offline recovery must acquire the existing Store's exclusive writer lease.
    // A still-open fixture writer would fail before testing key publication.
    store.close(); store = undefined;
    await expect(recoverOfflineEndpointIdentity({ dataDirectory: root, databasePath, host: "127.0.0.1", port: 0,
      publicOrigin: "http://127.0.0.1" } as OrchestratorConfig)).rejects.toMatchObject({ syscall: "rename" });
    store = new OperationalStore(databasePath);
    const current = new ConnectionManager(store);
    expect(store.getConnection(paired.connection.id).state).toBe("revoked");
    expect(store.findSetting<{ publicKey: string }>("service", "orchestrator", "public.linkspan_identity")?.value.publicKey).not.toBe(previous.publicKey);
    expect(() => current.authenticate(`Bearer ${paired.authKey}`)).toThrow(/revoked|invalid/iu);
    await expect(openLinkspanIdentity({ dataDirectory: root, serverId: "recovery-failure", store, vault })).rejects.toThrow(/Restore|recover/u);
  } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
});

import { lstat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import type { OrchestratorApplication } from "./application.js";
import type { OrchestratorConfig } from "./config.js";
import { CredentialVault } from "./credential-vault.js";
import { CredentialManager } from "./credential-manager.js";
import { openLinkspanIdentity } from "./linkspan-identity.js";
import { reserveManagedLinkspanResourceCredentials } from "./linkspan-resource-manager.js";
import { reserveIrohRelayLeaseCredentials } from "./linkspan-iroh-lease.js";

export type OfflineLinkspanContext = Pick<OrchestratorApplication, "config" | "store" | "credentials" | "serverId" | "linkspanIdentity">;

/** Local administration uses the existing Store/Vault without starting tasks,
 * schedules, providers, media, application listeners or a second service. */
export async function withOfflineLinkspanContext<T>(config: OrchestratorConfig, work: (context: OfflineLinkspanContext) => Promise<T>): Promise<T> {
  const reservation = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen({ host: config.host, port: config.port, exclusive: true }, () => { reservation.removeListener("error", reject); resolve(); });
  }).catch(() => { throw new Error("Stop this node's service before managing Linkspan resources, using its original data directory and complete deployment configuration."); });
  let store: OperationalStore | undefined;
  try {
    const database = await lstat(config.databasePath), keyPath = join(config.dataDirectory, "credentials", "master.key"), key = await lstat(keyPath);
    if (!database.isFile() || database.isSymbolicLink() || !key.isFile() || key.isSymbolicLink()) throw new Error("Linkspan administration requires the existing node database and credential master key.");
    store = new OperationalStore(config.databasePath);
    const node = store.findSetting<{ serverId: string }>("service", "orchestrator", "public.node_identity")?.value;
    if (node === undefined || !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(node.serverId)) throw new Error("Initialize the node through its normal service before managing Linkspan resources.");
    const vault = await CredentialVault.open(keyPath);
    const credentials = new CredentialManager({ vault, storagePath: join(config.dataDirectory, "credentials", "records.json") });
    await credentials.initialize();
    const linkspanIdentity = await openLinkspanIdentity({ dataDirectory: config.dataDirectory, serverId: node.serverId, store, vault });
    const context = { config, store, credentials, serverId: node.serverId, linkspanIdentity };
    reserveManagedLinkspanResourceCredentials(context);
    reserveIrohRelayLeaseCredentials(context);
    return await work(context);
  } finally {
    try { store?.close(); } finally { await new Promise<void>(resolve => reservation.close(() => resolve())); }
  }
}

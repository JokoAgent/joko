import { lstat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import type { OrchestratorConfig } from "./config.js";
import { CredentialVault } from "./credential-vault.js";
import { recoverLinkspanIdentity } from "./linkspan-identity.js";

/** The caller must use the node's original data directory and deployment configuration. */
export async function recoverOfflineEndpointIdentity(config: OrchestratorConfig): Promise<{
  readonly origin: string;
  readonly serverId: string;
  readonly endpointPublicKey: string;
}> {
  const database = await lstat(config.databasePath);
  if (!database.isFile() || database.isSymbolicLink()) throw new Error("Endpoint recovery requires the existing node database.");
  // Hold the configured listener while changing authority, so a running service
  // or a competing normal startup cannot retain the old in-memory identity.
  const reservation = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen({ host: config.host, port: config.port, exclusive: true }, () => {
      reservation.removeListener("error", reject); resolve();
    });
  }).catch(() => { throw new Error("Stop this node's service before recovering its endpoint identity."); });
  let store: OperationalStore | undefined;
  try {
    store = new OperationalStore(config.databasePath);
    const identity = store.findSetting<{ serverId: string }>("service", "orchestrator", "public.node_identity")?.value;
    if (!identity || typeof identity.serverId !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(identity.serverId)) {
      throw new Error("Endpoint recovery requires the existing node identity.");
    }
    const masterKeyPath = join(config.dataDirectory, "credentials", "master.key");
    const masterKey = await lstat(masterKeyPath).catch(() => undefined);
    if (!masterKey?.isFile() || masterKey.isSymbolicLink()) {
      throw new Error("Restore the node's credential master key before recovering its endpoint identity.");
    }
    const vault = await CredentialVault.open(masterKeyPath);
    const endpointPublicKey = await recoverLinkspanIdentity({ dataDirectory: config.dataDirectory, serverId: identity.serverId, store, vault });
    return { origin: config.publicOrigin, serverId: identity.serverId, endpointPublicKey };
  } finally {
    try { store?.close(); }
    finally { await new Promise<void>(resolve => reservation.close(() => resolve())); }
  }
}

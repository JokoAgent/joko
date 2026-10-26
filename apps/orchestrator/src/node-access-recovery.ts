import { PartnerNetworkStore, ProviderSharingStore, TaskShareStore, type OperationalStore } from "@joko/store";
import { revokeAllPartnerIdentityGrants } from "./partner-identity-directory.js";

/** Only the stopped service's trusted local recovery may call this authority reset. */
export function revokeAllNodeAccess(store: OperationalStore, serverId: string, at: number) {
  if (!Number.isSafeInteger(at)) throw new RangeError("Node recovery requires an integer timestamp.");
  return store.transaction(() => {
    let connections = 0, pairings = 0, taskShares = 0;
    for (const connection of store.listConnections()) if (connection.state === "active") {
      store.revokeConnection(connection.id, undefined, at); connections++;
    }
    for (const pairing of store.listPairings()) if (pairing.consumedAt === undefined && pairing.expiresAt > at) {
      if (store.cancelPairing(pairing.id, at)) pairings++;
    }
    const tasks = new TaskShareStore(store, () => at);
    for (const share of tasks.list()) if (share.status === "active") { tasks.end(share.shareId); taskShares++; }
    const providers = new ProviderSharingStore(store, () => at).revokeAllAccess();
    const conversations = new PartnerNetworkStore(store, () => at).revokeForeignAccess(serverId);
    const partnerGrants = revokeAllPartnerIdentityGrants(store);
    return { connections, pairings, taskShares, providers, conversations, partnerGrants };
  });
}

import type { OperationalStore } from "@joko/store";

type PairingRecoveryStore = Pick<OperationalStore, "listConnections" | "getDevice">;

/**
 * Pairing history is not authority. Recovery is needed whenever no credential
 * remains usable with an active durable Device, including after the last
 * connection or its parent Device has been revoked.
 */
export function needsLocalPairingRecovery(store: PairingRecoveryStore): boolean {
  return !store.listConnections().some((connection) => {
    if (connection.state !== "active") return false;
    return store.getDevice(connection.deviceId).state === "active";
  });
}

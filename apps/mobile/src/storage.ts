import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import type { MobileStorage, PendingOperation } from "./mobile-client";
import type { PairedCredential } from "./network";

const credentialKey = "joko.mobile.credential.v1";
const automaticEntryKey = "joko.mobile.automatic-entry.v1";
const pendingKey = "joko.mobile.pending.v1";
const selectionKey = "joko.mobile.selection.v1";

export const mobileStorage: MobileStorage = {
  async loadCredential() {
    const saved = await SecureStore.getItemAsync(credentialKey);
    if (!saved) return undefined;
    const parsed: unknown = JSON.parse(saved);
    if (!isCredential(parsed)) throw new Error("The saved mobile pairing is invalid. Remove it in the device's secure storage and pair again.");
    return parsed;
  },
  async saveCredential(credential) {
    await SecureStore.setItemAsync(credentialKey, JSON.stringify(credential), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
    });
  },
  async clearCredential() { await SecureStore.deleteItemAsync(credentialKey); },
  async loadAutomaticEntry() {
    const value = await AsyncStorage.getItem(automaticEntryKey);
    if (value === null || value === "false") return false;
    if (value === "true") return true;
    throw new Error("The saved automatic-entry preference is invalid. Turn it off and choose a Joko node again.");
  },
  async saveAutomaticEntry(enabled) {
    if (enabled) await AsyncStorage.setItem(automaticEntryKey, "true");
    else await AsyncStorage.removeItem(automaticEntryKey);
  },
  async loadPending() {
    const raw = await AsyncStorage.getItem(pendingKey);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error("The local operation receipt index is invalid.");
    return value.filter(isPending).slice(0, 32);
  },
  async savePending(items) { await AsyncStorage.setItem(pendingKey, JSON.stringify(items.slice(-32))); },
  async loadSelection() { return (await AsyncStorage.getItem(selectionKey)) || undefined; },
  async saveSelection(id) {
    if (id) await AsyncStorage.setItem(selectionKey, id);
    else await AsyncStorage.removeItem(selectionKey);
  }
};

function isCredential(value: unknown): value is PairedCredential {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["origin", "serverId", "connectionId", "deviceId", "displayName", "authKey"]
    .every((field) => typeof record[field] === "string" && (record[field] as string).length > 0);
}

function isPending(value: unknown): value is PendingOperation {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.operationId === "string" && typeof record.connectionId === "string"
    && (record.kind === "send" || record.kind === "create")
    && (record.state === "unknown" || record.state === "accepted")
    && (record.sessionId === undefined || typeof record.sessionId === "string");
}

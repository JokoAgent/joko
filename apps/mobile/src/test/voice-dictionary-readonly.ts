import { readVoiceDictionaryReadOnlyView, type VoiceDictionaryReadOnlyView } from "@joko/contracts";
import type { MobileConnectionProfile } from "../connection-storage";
import { MobileVoiceDictionaryReadOnlyCache } from "../mobile-voice-dictionary-readonly-cache";

export const dictionaryStamp = (wall: number, node = "node-a") => `${wall.toString(36).padStart(10, "0")}.0000.${node}`;
export function readOnlyProfile(id = "a"): MobileConnectionProfile {
  return { profileId: `profile-${id}`, origin: `http://127.0.0.1:${id === "a" ? 4001 : 4002}`, serverId: `server-${id}`,
    connectionId: `connection-${id}`, deviceId: `phone-${id}`, displayName: `Node ${id}` };
}
export function readOnlyValue(revision = 2n, options: Partial<VoiceDictionaryReadOnlyView> = {}): VoiceDictionaryReadOnlyView {
  return readVoiceDictionaryReadOnlyView({ revision, syncEnabled: true,
    entries: [{ text: "Joko", frequency: 3, aliases: [{ text: "jo ko", count: 2 }] }],
    stateVector: { "node-a": dictionaryStamp(1) }, ...options });
}
export function memoryReadOnlyCache(now: () => number = () => 1_900_000_000_000) {
  const values = new Map<string, string>();
  const storage = {
    getItem: async (key: string): Promise<string | null> => values.get(key) ?? null,
    setItem: async (key: string, value: string): Promise<void> => { values.set(key, value); },
    removeItem: async (key: string): Promise<void> => { values.delete(key); },
    getAllKeys: async (): Promise<readonly string[]> => [...values.keys()]
  };
  return { values, storage, cache: new MobileVoiceDictionaryReadOnlyCache(storage, now) };
}

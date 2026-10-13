export interface MobileRemoteDesktopPreferenceOwner {
  readonly profileId: string;
  readonly serverId: string;
  readonly controllerDeviceId: string;
}

export interface MobileRemoteDesktopHostMuteIdentity extends MobileRemoteDesktopPreferenceOwner {
  readonly targetDeviceId: string;
}

export interface MobileRemoteDesktopHostMuteStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface MobileRemoteDesktopHostMutePreferences {
  load(identity: MobileRemoteDesktopHostMuteIdentity): Promise<boolean>;
  save(identity: MobileRemoteDesktopHostMuteIdentity, enabled: boolean): Promise<void>;
}

function storageKey(identity: MobileRemoteDesktopHostMuteIdentity): string {
  const fields = [identity.profileId, identity.serverId, identity.controllerDeviceId, identity.targetDeviceId];
  if (fields.some(value => typeof value !== "string" || value.length < 1 || value.length > 256
    || value.trim() !== value || /[\u0000-\u001f]/.test(value))) {
    throw new Error("Invalid Remote Desktop host mute preference identity.");
  }
  return `joko.remote-desktop.host-mute.v1.${encodeURIComponent(JSON.stringify(fields))}`;
}

/** Private device preferences; no credentials or transient route revisions are stored. */
export function createMobileRemoteDesktopHostMutePreferenceStore(
  storage: MobileRemoteDesktopHostMuteStorage
): MobileRemoteDesktopHostMutePreferences {
  const pending = new Map<string, Promise<void>>();
  const enqueue = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const next = (pending.get(key) ?? Promise.resolve()).then(operation);
    const settled = next.then(() => undefined, () => undefined);
    pending.set(key, settled);
    void settled.then(() => { if (pending.get(key) === settled) pending.delete(key); });
    return next;
  };
  return {
    load(identity) {
      const key = storageKey(identity);
      return enqueue(key, async () => {
        const raw = await storage.getItem(key);
        if (raw === null) return false;
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "object" || value === null || Array.isArray(value)
          || Object.keys(value).length !== 2 || !("version" in value) || value.version !== 1
          || !("enabled" in value) || typeof value.enabled !== "boolean") {
          throw new Error("Invalid Remote Desktop host mute preference.");
        }
        return value.enabled;
      });
    },
    save(identity, enabled) {
      if (typeof enabled !== "boolean") throw new Error("Invalid Remote Desktop host mute preference.");
      const key = storageKey(identity);
      return enqueue(key, () => storage.setItem(key, JSON.stringify({ version: 1, enabled })));
    }
  };
}

import type { MobileRemoteDesktopHostMuteStorage, MobileRemoteDesktopPreferenceOwner } from "./mobile-remote-desktop-host-mute-preference";

export interface MobileRemoteDesktopClipboardSyncIdentity extends MobileRemoteDesktopPreferenceOwner {
  readonly targetDeviceId: string;
}
export interface MobileRemoteDesktopClipboardSyncPreferences {
  load(identity: MobileRemoteDesktopClipboardSyncIdentity): Promise<boolean>;
  save(identity: MobileRemoteDesktopClipboardSyncIdentity, enabled: boolean): Promise<void>;
}

export function createMobileRemoteDesktopClipboardSyncPreferenceStore(storage: MobileRemoteDesktopHostMuteStorage): MobileRemoteDesktopClipboardSyncPreferences {
  const pending = new Map<string, Promise<void>>();
  const keyFor = (identity: MobileRemoteDesktopClipboardSyncIdentity): string => {
    const fields = [identity.profileId, identity.serverId, identity.controllerDeviceId, identity.targetDeviceId];
    if (fields.some(value => typeof value !== "string" || !value.length || value.length > 256
      || value.trim() !== value || /[\u0000-\u001f]/.test(value))) throw new Error("Invalid Remote Desktop clipboard sync preference identity.");
    return `joko.remote-desktop.clipboard-sync.v1.${encodeURIComponent(JSON.stringify(fields))}`;
  };
  const enqueue = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const next = (pending.get(key) ?? Promise.resolve()).then(operation);
    const settled = next.then(() => undefined, () => undefined);
    pending.set(key, settled);
    void settled.then(() => { if (pending.get(key) === settled) pending.delete(key); });
    return next;
  };
  return {
    load(identity) {
      const key = keyFor(identity);
      return enqueue(key, async () => {
        const raw = await storage.getItem(key);
        if (raw === null) return false;
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "object" || value === null || Array.isArray(value)
          || Object.keys(value).length !== 2 || !("version" in value) || value.version !== 1
          || !("enabled" in value) || typeof value.enabled !== "boolean") throw new Error("Invalid Remote Desktop clipboard sync preference.");
        return value.enabled;
      });
    },
    save(identity, enabled) {
      if (typeof enabled !== "boolean") throw new Error("Invalid Remote Desktop clipboard sync preference.");
      const key = keyFor(identity);
      return enqueue(key, () => storage.setItem(key, JSON.stringify({ version: 1, enabled })));
    }
  };
}

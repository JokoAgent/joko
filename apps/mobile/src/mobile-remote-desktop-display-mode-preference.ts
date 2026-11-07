import type { MobileRemoteDesktopHostMuteIdentity, MobileRemoteDesktopHostMuteStorage } from "./mobile-remote-desktop-host-mute-preference";

export interface MobileRemoteDesktopDisplayModeIdentity extends MobileRemoteDesktopHostMuteIdentity {
  readonly displayId: string;
}

export interface MobileRemoteDesktopRememberedMode {
  readonly modeId: string;
  readonly width: number;
  readonly height: number;
}

export interface MobileRemoteDesktopDisplayModePreferences {
  load(identity: MobileRemoteDesktopDisplayModeIdentity): Promise<MobileRemoteDesktopRememberedMode | undefined>;
  save(identity: MobileRemoteDesktopDisplayModeIdentity, mode: MobileRemoteDesktopRememberedMode): Promise<void>;
}

function preferenceKey(identity: MobileRemoteDesktopDisplayModeIdentity): string {
  const fields = [identity.profileId, identity.serverId, identity.controllerDeviceId, identity.targetDeviceId, identity.displayId];
  if (fields.some(value => typeof value !== "string" || value.length < 1 || value.length > 256
    || value.trim() !== value || /[\u0000-\u001f]/u.test(value))) throw new Error("Invalid Remote Desktop display preference identity.");
  return `joko.remote-desktop.display-mode.v1.${encodeURIComponent(JSON.stringify(fields))}`;
}

function validMode(value: unknown): value is MobileRemoteDesktopRememberedMode {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "modeId" in value && typeof value.modeId === "string" && /^[0-9]{1,10}$/u.test(value.modeId)
    && "width" in value && "height" in value && [value.width, value.height].every(size =>
      typeof size === "number" && Number.isInteger(size) && size > 0 && size <= 32_768);
}

export function createMobileRemoteDesktopDisplayModePreferenceStore(
  storage: MobileRemoteDesktopHostMuteStorage
): MobileRemoteDesktopDisplayModePreferences {
  let writes = Promise.resolve();
  return {
    async load(identity) {
      await writes;
      const raw = await storage.getItem(preferenceKey(identity));
      if (raw === null) return undefined;
      const value: unknown = JSON.parse(raw);
      if (!validMode(value) || !("version" in value) || value.version !== 1) return undefined;
      return { modeId: value.modeId, width: value.width, height: value.height };
    },
    async save(identity, mode) {
      if (!validMode(mode)) throw new Error("Invalid Remote Desktop display preference.");
      const key = preferenceKey(identity);
      const data = JSON.stringify({ version: 1, modeId: mode.modeId, width: mode.width, height: mode.height });
      const result = writes.then(() => storage.setItem(key, data));
      writes = result.catch(() => undefined);
      await result;
    }
  };
}

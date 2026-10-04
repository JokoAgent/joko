import type { DesktopUpdateAutoRelaunchSettings, DesktopUpdateChannelSettings } from "./channels.js";

export interface DesktopUpdateSettingsObserver {
  readonly isDestroyed: () => boolean;
  readonly webContents: {
    readonly isDestroyed: () => boolean;
    readonly send: (channel: string, settings: DesktopUpdateAutoRelaunchSettings | DesktopUpdateChannelSettings) => void;
  };
}

export function broadcastDesktopUpdateSettings(
  observers: readonly DesktopUpdateSettingsObserver[],
  channel: string,
  settings: DesktopUpdateAutoRelaunchSettings | DesktopUpdateChannelSettings
): void {
  for (const observer of observers) {
    try {
      if (observer.isDestroyed()) continue;
      const contents = observer.webContents;
      if (!contents.isDestroyed()) contents.send(channel, settings);
    } catch {
      // A retired observer cannot reverse a committed device setting.
    }
  }
}

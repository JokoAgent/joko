/** Input Monitoring recovery is explicit or follows a return from macOS Settings. */
export function createDedicatedHardwarePermissionRecovery(options: {
  readonly platform: NodeJS.Platform;
  readonly openSettings: () => Promise<boolean>;
  readonly retry: () => void;
}): {
  readonly openSettings: () => Promise<boolean>;
  readonly applicationFocused: () => void;
  readonly screenUnlocked: () => void;
} {
  let settingsReturnPending = false;
  return {
    openSettings: async () => {
      if (options.platform !== "darwin") return false;
      settingsReturnPending = true;
      try {
        const opened = await options.openSettings();
        if (!opened) settingsReturnPending = false;
        return opened;
      } catch {
        settingsReturnPending = false;
        return false;
      }
    },
    applicationFocused: () => {
      if (!settingsReturnPending) return;
      settingsReturnPending = false;
      options.retry();
    },
    screenUnlocked: () => {
      if (options.platform === "darwin") options.retry();
    }
  };
}

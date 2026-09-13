export interface DesktopPowerSaveBlocker {
  readonly start: (type: "prevent-app-suspension") => number;
  readonly stop: (id: number) => void;
  readonly isStarted: (id: number) => boolean;
}

export interface DesktopKeepAwakeController {
  readonly apply: (enabled: boolean) => void;
  readonly release: () => void;
  readonly isActive: () => boolean;
}

export function createDesktopKeepAwakeController(
  blocker: DesktopPowerSaveBlocker
): DesktopKeepAwakeController {
  let blockerId: number | undefined;

  const isActive = (): boolean => {
    if (blockerId === undefined) return false;
    try {
      return blocker.isStarted(blockerId);
    } catch {
      return false;
    }
  };

  const release = (): void => {
    const id = blockerId;
    blockerId = undefined;
    if (id === undefined) return;
    try {
      if (blocker.isStarted(id)) blocker.stop(id);
    } catch {
      // Process exit will release a native blocker even if its host vanished.
    }
  };

  return Object.freeze({
    apply: (enabled: boolean): void => {
      if (typeof enabled !== "boolean") throw new TypeError("Desktop keep-awake state must be boolean.");
      if (!enabled) {
        release();
        return;
      }
      if (isActive()) return;
      blockerId = undefined;
      const id = blocker.start("prevent-app-suspension");
      if (!Number.isSafeInteger(id) || id < 0) {
        throw new Error("Desktop keep-awake blocker returned an invalid identifier.");
      }
      blockerId = id;
    },
    release,
    isActive
  });
}

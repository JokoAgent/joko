import type { DesktopKeepAwakeSettings } from "./channels.js";
import type { DesktopKeepAwakeController } from "./keep-awake-controller.js";
import type { DesktopKeepAwakeSettingsStore } from "./keep-awake-settings.js";

export interface DesktopKeepAwakeMutationResult {
  readonly settings: DesktopKeepAwakeSettings;
  readonly changed: boolean;
}

export interface DesktopKeepAwakeSettingsCoordinator {
  readonly initialize: () => Promise<DesktopKeepAwakeSettings>;
  readonly get: () => Promise<DesktopKeepAwakeSettings>;
  readonly setEnabled: (enabled: boolean) => Promise<DesktopKeepAwakeMutationResult>;
}

export interface DesktopKeepAwakeBroadcastWindow {
  readonly isDestroyed: () => boolean;
  readonly webContents: {
    readonly isDestroyed: () => boolean;
    readonly send: (channel: string, settings: DesktopKeepAwakeSettings) => void;
  };
}

/** Renderer delivery is an observer effect and cannot reverse a committed setting. */
export function broadcastDesktopKeepAwakeSettings(
  windows: readonly DesktopKeepAwakeBroadcastWindow[],
  channel: string,
  settings: DesktopKeepAwakeSettings
): void {
  for (const window of windows) {
    try {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      window.webContents.send(channel, settings);
    } catch {
      // A renderer reload/crash does not change durable/native authority.
    }
  }
}

/**
 * Serializes the durable preference and its native blocker projection. Reads
 * join the same tail so a renderer never observes a value that is still being
 * applied or compensated.
 */
export function createDesktopKeepAwakeSettingsCoordinator(
  store: DesktopKeepAwakeSettingsStore,
  controller: DesktopKeepAwakeController,
  onChanged: (settings: DesktopKeepAwakeSettings) => void = () => undefined
): DesktopKeepAwakeSettingsCoordinator {
  let operationTail = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const assertNativeProjection = (enabled: boolean): void => {
    if (controller.isActive() !== enabled) {
      throw new Error("Desktop keep-awake native state did not match the durable setting.");
    }
  };

  const initialize = (): Promise<DesktopKeepAwakeSettings> => enqueue(async () => {
    await store.initialize();
    const settings = store.get();
    controller.apply(settings.enabled);
    assertNativeProjection(settings.enabled);
    return settings;
  });

  const get = (): Promise<DesktopKeepAwakeSettings> => enqueue(async () => {
    await store.initialize();
    return store.get();
  });

  const setEnabled = (enabled: boolean): Promise<DesktopKeepAwakeMutationResult> => {
    if (typeof enabled !== "boolean") {
      return Promise.reject(new TypeError("Desktop keep-awake setting must be boolean."));
    }
    return enqueue(async () => {
      await store.initialize();
      const previous = store.get();
      // Reconcile durable authority before deciding whether this is a no-op or
      // beginning a new transition. The OS may have retired a blocker since
      // startup, and a failed native probe must not be mistaken for disabled.
      controller.apply(previous.enabled);
      assertNativeProjection(previous.enabled);

      if (previous.enabled === enabled) {
        return Object.freeze({ settings: previous, changed: false });
      }

      const committed = await store.setEnabled(enabled);
      try {
        controller.apply(committed.enabled);
        assertNativeProjection(committed.enabled);
      } catch (cause) {
        let durableCompensationFailed = false;
        let nativeCompensationFailed = false;
        try {
          await store.setEnabled(previous.enabled);
        } catch {
          durableCompensationFailed = true;
        }
        try {
          controller.apply(previous.enabled);
          assertNativeProjection(previous.enabled);
        } catch {
          nativeCompensationFailed = true;
        }

        // If the old durable value could not be restored, make one final
        // best-effort projection of whichever durable value is now authoritative.
        if (durableCompensationFailed) {
          try {
            const authoritative = store.get();
            controller.apply(authoritative.enabled);
            assertNativeProjection(authoritative.enabled);
          } catch {
            nativeCompensationFailed = true;
          }
        }

        const compensation = durableCompensationFailed || nativeCompensationFailed
          ? "compensation was incomplete; reload the authoritative setting"
          : "the previous durable and native state was restored";
        throw new Error(`Desktop keep-awake native application failed; ${compensation}.`, { cause });
      }

      try {
        onChanged(committed);
      } catch {
        // Observer failure cannot turn a confirmed device mutation into failure.
      }
      return Object.freeze({ settings: committed, changed: true });
    });
  };

  return Object.freeze({ initialize, get, setEnabled });
}

import { useCallback, useSyncExternalStore } from "react";

export interface MobileExpandedBlockStoreOptions {
  readonly maximumEntries?: number;
  readonly onSubscriberError?: (error: unknown) => void;
}

export interface MobileExpandedBlockStore {
  isExpanded(ownerKey: string, blockKey: string, defaultExpanded?: boolean): boolean;
  setExpanded(ownerKey: string, blockKey: string, expanded: boolean, defaultExpanded?: boolean): void;
  subscribe(ownerKey: string, blockKey: string, listener: () => void): () => void;
  reset(): void;
}

function expandedBlockKey(ownerKey: string, blockKey: string): string {
  if (!ownerKey.trim() || !blockKey.trim()) throw new Error("An exact owner and stable block key are required.");
  return JSON.stringify([ownerKey, blockKey]);
}

/** Process-local overrides survive virtualization; each caller explicitly owns its initial presentation. */
export function createMobileExpandedBlockStore(
  options: MobileExpandedBlockStoreOptions = {}
): MobileExpandedBlockStore {
  const maximumEntries = options.maximumEntries ?? 500;
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
    throw new Error("The expanded block memory limit must be a positive safe integer.");
  }
  const overrides = new Map<string, boolean>();
  const subscribers = new Map<string, Set<() => void>>();
  const notify = (key: string): void => {
    for (const listener of [...(subscribers.get(key) ?? [])]) {
      try { listener(); }
      catch (error) {
        try { options.onSubscriberError?.(error); }
        catch { /* A reporting failure must not prevent the remaining consumers from observing state. */ }
      }
    }
  };
  return {
    isExpanded(ownerKey, blockKey, defaultExpanded = false) {
      return overrides.get(expandedBlockKey(ownerKey, blockKey)) ?? defaultExpanded;
    },
    setExpanded(ownerKey, blockKey, next, defaultExpanded = false) {
      const key = expandedBlockKey(ownerKey, blockKey);
      if ((overrides.get(key) ?? defaultExpanded) === next) return;
      if (next !== defaultExpanded) {
        overrides.set(key, next);
        if (overrides.size > maximumEntries) {
          const oldest = overrides.keys().next().value!;
          overrides.delete(oldest);
          notify(oldest);
        }
      } else {
        overrides.delete(key);
      }
      notify(key);
    },
    subscribe(ownerKey, blockKey, listener) {
      const key = expandedBlockKey(ownerKey, blockKey);
      const listeners = subscribers.get(key) ?? new Set<() => void>();
      subscribers.set(key, listeners);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && subscribers.get(key) === listeners) subscribers.delete(key);
      };
    },
    reset() {
      const previous = [...overrides.keys()];
      overrides.clear();
      for (const key of previous) notify(key);
    }
  };
}

export const mobileExpandedBlockStore = createMobileExpandedBlockStore();

export function useMobileExpandedBlock(ownerKey: string, blockKey: string, defaultExpanded = false): [boolean, () => void] {
  const subscribe = useCallback((listener: () => void) => mobileExpandedBlockStore.subscribe(ownerKey, blockKey, listener),
    [ownerKey, blockKey]);
  const snapshot = useCallback(() => mobileExpandedBlockStore.isExpanded(ownerKey, blockKey, defaultExpanded), [ownerKey, blockKey, defaultExpanded]);
  const expanded = useSyncExternalStore(subscribe, snapshot, snapshot);
  const toggle = useCallback(() => {
    mobileExpandedBlockStore.setExpanded(ownerKey, blockKey, !mobileExpandedBlockStore.isExpanded(ownerKey, blockKey, defaultExpanded), defaultExpanded);
  }, [ownerKey, blockKey, defaultExpanded]);
  return [expanded, toggle];
}

import { useCallback, useSyncExternalStore } from "react";

export interface MobileExpandedBlockStoreOptions {
  readonly maximumEntries?: number;
  readonly onSubscriberError?: (error: unknown) => void;
}

export interface MobileExpandedBlockStore {
  isExpanded(ownerKey: string, blockKey: string): boolean;
  setExpanded(ownerKey: string, blockKey: string, expanded: boolean): void;
  subscribe(ownerKey: string, blockKey: string, listener: () => void): () => void;
  reset(): void;
}

function expandedBlockKey(ownerKey: string, blockKey: string): string {
  if (!ownerKey.trim() || !blockKey.trim()) throw new Error("An exact owner and stable block key are required.");
  return JSON.stringify([ownerKey, blockKey]);
}

/** Process-local expansion memory survives virtualization and regrouping; new stores start collapsed. */
export function createMobileExpandedBlockStore(
  options: MobileExpandedBlockStoreOptions = {}
): MobileExpandedBlockStore {
  const maximumEntries = options.maximumEntries ?? 500;
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
    throw new Error("The expanded block memory limit must be a positive safe integer.");
  }
  const expanded = new Set<string>();
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
    isExpanded(ownerKey, blockKey) {
      return expanded.has(expandedBlockKey(ownerKey, blockKey));
    },
    setExpanded(ownerKey, blockKey, next) {
      const key = expandedBlockKey(ownerKey, blockKey);
      if (expanded.has(key) === next) return;
      if (next) {
        expanded.add(key);
        if (expanded.size > maximumEntries) {
          const oldest = expanded.values().next().value!;
          expanded.delete(oldest);
          notify(oldest);
        }
      } else {
        expanded.delete(key);
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
      const previous = [...expanded];
      expanded.clear();
      for (const key of previous) notify(key);
    }
  };
}

export const mobileExpandedBlockStore = createMobileExpandedBlockStore();

export function useMobileExpandedBlock(ownerKey: string, blockKey: string): [boolean, () => void] {
  const subscribe = useCallback((listener: () => void) => mobileExpandedBlockStore.subscribe(ownerKey, blockKey, listener),
    [ownerKey, blockKey]);
  const snapshot = useCallback(() => mobileExpandedBlockStore.isExpanded(ownerKey, blockKey), [ownerKey, blockKey]);
  const expanded = useSyncExternalStore(subscribe, snapshot, snapshot);
  const toggle = useCallback(() => {
    mobileExpandedBlockStore.setExpanded(ownerKey, blockKey, !mobileExpandedBlockStore.isExpanded(ownerKey, blockKey));
  }, [ownerKey, blockKey]);
  return [expanded, toggle];
}

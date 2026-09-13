export type ProviderModelRefreshLifecycleHint =
  | "startup"
  | "system-resume"
  | "screen-unlock"
  | "meaningful-foreground";

export interface ProviderModelRefreshLifecycle {
  syncConnection(input: { readonly connected: boolean; readonly ownerKey?: string }): void;
  request(hint: ProviderModelRefreshLifecycleHint): void;
  settled(): Promise<void>;
}

/**
 * Joins lifecycle hints while a silent refresh is running and retains one hint
 * while disconnected. A newly connected owner always receives a startup pass.
 */
export function createProviderModelRefreshLifecycle(options: {
  readonly refresh: () => Promise<void>;
}): ProviderModelRefreshLifecycle {
  let connected = false;
  let ownerKey: string | undefined;
  let pending = false;
  let flight: { readonly ownerKey: string; readonly promise: Promise<void> } | undefined;

  const drain = (): void => {
    if (!connected || ownerKey === undefined || !pending || flight !== undefined) return;
    pending = false;
    const flightOwnerKey = ownerKey;
    const promise = Promise.resolve()
      .then(options.refresh)
      .catch(() => undefined)
      .finally(() => {
        if (flight?.promise === promise) flight = undefined;
        if (pending) drain();
      });
    flight = { ownerKey: flightOwnerKey, promise };
  };

  return {
    syncConnection(input): void {
      const nextOwnerKey = input.ownerKey?.trim() || undefined;
      const ownerChanged = nextOwnerKey !== undefined && nextOwnerKey !== ownerKey;
      connected = input.connected && nextOwnerKey !== undefined;
      if (ownerChanged) {
        ownerKey = nextOwnerKey;
        pending = true;
      }
      drain();
    },
    request(_hint): void {
      if (flight?.ownerKey === ownerKey) return;
      pending = true;
      drain();
    },
    async settled(): Promise<void> {
      while (flight !== undefined) await flight.promise;
    }
  };
}

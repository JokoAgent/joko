import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { ProviderAccountUsageSnapshot } from "@joko/contracts";
import { mobileProviderUsageSupported, mobileUsageProviderKey, type MobileProviderUsageTransport } from "./mobile-account-usage";

/** A visible surface owns one read per catalog Provider and discards retired responses. */
export function useMobileAccountUsage(transport: MobileProviderUsageTransport | undefined, visible: boolean, providerIds: readonly string[]) {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const providerScope = JSON.stringify([...new Set(providerIds)].sort());
  const binding = JSON.stringify([transport?.ownerKey, visible, providerScope]);
  const [state, setState] = useState<{ readonly binding: string; readonly snapshots: Readonly<Record<string, ProviderAccountUsageSnapshot>>;
    readonly failed: boolean; readonly loading: boolean }>();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const captured = transportRef.current;
    if (!visible || !captured) return;
    const wanted = new Set(JSON.parse(providerScope) as string[]);
    const providers = captured.providers.filter(provider => wanted.has(provider.providerId) && mobileProviderUsageSupported(provider));
    if (providers.length === 0 || providers.length > 256) return;
    let retired = false;
    let pending: AbortController | undefined;
    const current = (): boolean => !retired && transportRef.current?.ownerKey === captured.ownerKey;
    const read = async (): Promise<void> => {
      if (!current() || pending || AppState.currentState !== "active") return;
      const controller = new AbortController();
      pending = controller;
      setState(previous => ({ binding, snapshots: previous?.binding === binding ? previous.snapshots : {}, failed: false, loading: true }));
      const entries = await Promise.allSettled(providers.map(async provider => {
        const snapshot = await captured.read(provider.backendId, provider.providerId, controller.signal);
        if (snapshot && snapshot.providerId !== provider.providerId) throw new Error("The account usage Provider changed.");
        return [mobileUsageProviderKey(provider), snapshot] as const;
      }));
      if (current() && !controller.signal.aborted) {
        setState(previous => {
          const snapshots = { ...(previous?.binding === binding ? previous.snapshots : {}) };
          for (const result of entries) {
            if (result.status !== "fulfilled") continue;
            const [key, snapshot] = result.value;
            if (snapshot) snapshots[key] = snapshot;
            else delete snapshots[key];
          }
          return { binding, snapshots, loading: false, failed: entries.some(result => result.status === "rejected") };
        });
        setNow(Date.now());
      }
      if (pending === controller) pending = undefined;
    };
    void read();
    const polling = setInterval(() => void read(), 30_000);
    const clock = setInterval(() => { if (current() && AppState.currentState === "active") setNow(Date.now()); }, 1000);
    const appState = AppState.addEventListener("change", state => {
      if (state === "active") void read();
      else pending?.abort();
    });
    return () => { retired = true; pending?.abort(); clearInterval(polling); clearInterval(clock); appState.remove(); };
  }, [binding, providerScope, visible]);
  return state?.binding === binding && visible && transport
    ? { ...state, now }
    : { snapshots: {} as Readonly<Record<string, ProviderAccountUsageSnapshot>>, failed: false, loading: visible && !!transport, now };
}

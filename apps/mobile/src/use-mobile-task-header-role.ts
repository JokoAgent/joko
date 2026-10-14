import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import type { MobileTaskHeaderRole } from "./mobile-task-header-role";

export interface MobileTaskHeaderRoleClient {
  readTaskHeaderRole(sourceKey: string, signal: AbortSignal): Promise<MobileTaskHeaderRole>;
}
export function useMobileTaskHeaderRole(client: MobileTaskHeaderRoleClient, sourceKey: string | undefined) {
  const [attempt, setAttempt] = useState(0);
  const [observed, setObserved] = useState<{ readonly key: string; readonly role?: MobileTaskHeaderRole; readonly failed: boolean }>();
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") { setAttempt(value => value + 1); return; }
      current = false; controller.abort(); if (timer !== undefined) clearTimeout(timer); setObserved(undefined);
    });
    if (sourceKey && AppState.currentState === "active") {
      setObserved({ key: sourceKey, failed: false });
      const read = (): void => {
        void client.readTaskHeaderRole(sourceKey, controller.signal).then(role => {
          if (!current || controller.signal.aborted || AppState.currentState !== "active") return;
          setObserved({ key: sourceKey, role, failed: false });
          timer = setTimeout(read, 5_000);
        }).catch(() => {
          if (current && !controller.signal.aborted && AppState.currentState === "active") setObserved({ key: sourceKey, failed: true });
        });
      };
      read();
    } else setObserved(undefined);
    return () => { current = false; controller.abort(); if (timer !== undefined) clearTimeout(timer); subscription.remove(); };
  }, [client, sourceKey, attempt]);
  return { role: observed?.key === sourceKey ? observed?.role : undefined,
    failed: observed?.key === sourceKey && observed?.failed === true, retry };
}

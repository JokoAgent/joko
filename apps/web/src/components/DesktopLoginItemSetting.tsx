import { useEffect, useRef, useState, type JSX } from "react";
import { Button, SwitchControl } from "./ui.js";
import type { Translator } from "./types.js";

/** Read the OS again on focus so changes in System Settings remain authoritative. */
export function DesktopLoginItemSetting({ t }: { readonly t: Translator }): JSX.Element | null {
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  const api = desktop?.loginItem;
  const supported = desktop?.capabilities.includes("window.loginItem") === true;
  const [state, setState] = useState<JokoDesktopLoginItemState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"load" | "save">();
  const [reload, setReload] = useState(0);
  const owner = useRef(0), readGeneration = useRef(0), busy = useRef(false), attempted = useRef(false);
  useEffect(() => {
    const generation = ++owner.current;
    busy.current = false; setPending(false); setState(undefined); setError(undefined);
    if (!supported || !api) return;
    const refresh = (): void => {
      if (busy.current) return;
      const read = ++readGeneration.current;
      void api.get().then(value => {
        if (generation === owner.current && read === readGeneration.current) { setState(value); setError(undefined); }
      }, () => {
        if (generation === owner.current && read === readGeneration.current) setError("load");
      });
    };
    refresh(); window.addEventListener("focus", refresh);
    return () => { owner.current++; readGeneration.current++; window.removeEventListener("focus", refresh); };
  }, [api, supported, reload]);
  const save = async (enabled: boolean): Promise<void> => {
    if (!api || busy.current || state?.available !== true) return;
    const generation = owner.current; readGeneration.current++;
    attempted.current = enabled; busy.current = true; setPending(true); setError(undefined);
    try {
      const next = await api.set(enabled);
      if (generation === owner.current) setState(next);
    } catch {
      if (generation !== owner.current) return;
      setError("save");
      try { const next = await api.get(); if (generation === owner.current) setState(next); }
      catch { /* Keep the acknowledged choice and the explicit retry. */ }
    } finally {
      if (generation === owner.current) { busy.current = false; setPending(false); }
    }
  };
  if (!supported || !api) return null;
  return <div className="setting-row desktop-login-item-setting">
    <div>
      <strong>{t("desktopLogin.title")}</strong>
      <span>{t(state?.unavailableReason === "development" ? "desktopLogin.installedOnly" : "desktopLogin.description")}</span>
      {state === undefined && error === undefined && <span role="status">{t("common.loading")}</span>}
      {pending && <span role="status">{t("common.working")}</span>}
      {state?.requiresApproval && <span role="status">{t("desktopLogin.requiresApproval")}</span>}
      {error && <span role="alert">{t(error === "load" ? "desktopLogin.loadFailed" : "desktopLogin.saveFailed")}</span>}
    </div>
    <div className="composer-send-shortcut-actions">
      <SwitchControl checked={state?.enabled === true || state?.requiresApproval === true}
        disabled={state?.available !== true || pending} aria-label={t("desktopLogin.title")} aria-busy={pending}
        onChange={event => { void save(event.target.checked); }} />
      {error && <Button tone="ghost" disabled={pending} onClick={() => {
        if (error === "load") setReload(value => value + 1); else void save(attempted.current);
      }}>{t("common.retry")}</Button>}
    </div>
  </div>;
}

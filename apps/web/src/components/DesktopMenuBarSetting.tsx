import { useEffect, useRef, useState, type JSX } from "react";
import type { MenubarState } from "@joko/contracts";
import { Button, SwitchControl } from "./ui.js";
import type { Translator } from "./types.js";

export function DesktopMenuBarSetting({ t }: { readonly t: Translator }): JSX.Element | null {
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  const api = desktop?.menuBar;
  const supported = desktop?.capabilities.includes("native.menuBar") === true;
  const [state, setState] = useState<MenubarState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"load" | "save">();
  const [reload, setReload] = useState(0);
  const owner = useRef(0), read = useRef(0), busy = useRef(false), attempted = useRef(false);
  useEffect(() => {
    const generation = ++owner.current;
    setState(undefined); setError(undefined); busy.current = false; setPending(false);
    if (!supported || !api) return;
    const refresh = (): void => {
      if (busy.current) return;
      const request = ++read.current;
      void api.get().then(value => {
        if (generation === owner.current && request === read.current) { setState(value); setError(undefined); }
      }, () => { if (generation === owner.current && request === read.current) setError("load"); });
    };
    const unsubscribe = api.onSettings(settings => {
      if (generation !== owner.current) return;
      setState(current => current ? { ...current, enabled: settings.enabled, settings } : current);
      // Re-read availability as well. A broadcast may arrive before the first
      // read has resolved; it must not leave the setting permanently loading.
      refresh();
    });
    refresh(); window.addEventListener("focus", refresh);
    return () => { owner.current++; read.current++; unsubscribe(); window.removeEventListener("focus", refresh); };
  }, [api, supported, reload]);
  const save = async (enabled: boolean): Promise<void> => {
    if (!api || busy.current || state?.available !== true) return;
    const generation = owner.current; read.current++;
    attempted.current = enabled; busy.current = true; setPending(true); setError(undefined);
    try {
      const next = await api.setEnabled(enabled);
      if (generation === owner.current) setState(next);
    } catch {
      if (generation !== owner.current) return;
      setError("save");
      try { const next = await api.get(); if (generation === owner.current) setState(next); } catch { /* Explicit retry stays available. */ }
    } finally { if (generation === owner.current) { busy.current = false; setPending(false); } }
  };
  if (!supported || !api) return null;
  return <div className="setting-row desktop-menu-bar-setting">
    <div>
      <strong>{t("desktopMenuBar.title")}</strong>
      <span>{t(state?.available === false ? "desktopMenuBar.unavailable" : "desktopMenuBar.description")}</span>
      {(pending || state === undefined && !error) && <span role="status">{t(pending ? "common.working" : "common.loading")}</span>}
      {error && <span role="alert">{t(error === "load" ? "desktopMenuBar.loadFailed" : "desktopMenuBar.saveFailed")}</span>}
      {!error && state?.error === "helper" && <span role="alert">{t("desktopMenuBar.runtimeFailed")}</span>}
    </div>
    <div className="composer-send-shortcut-actions">
      <SwitchControl checked={state?.enabled === true} disabled={state?.available !== true || pending}
        aria-label={t("desktopMenuBar.title")} aria-busy={pending} onChange={event => { void save(event.target.checked); }} />
      {(error || state?.error === "helper") && <Button tone="ghost" disabled={pending} onClick={() => {
        if (error === "load") setReload(value => value + 1); else void save(error === "save" ? attempted.current : true);
      }}>{t("common.retry")}</Button>}
    </div>
  </div>;
}

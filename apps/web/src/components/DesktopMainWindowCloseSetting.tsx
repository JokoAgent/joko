import { useEffect, useRef, useState, type JSX } from "react";
import type { Translator } from "./types.js";
import { Button, SelectControl } from "./ui.js";

/** The preference belongs to the Desktop device, independently of the active service profile. */
export function DesktopMainWindowCloseSetting({ t }: { readonly t: Translator }): JSX.Element | null {
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  const api = desktop?.mainWindowClose;
  const available = desktop?.capabilities.includes("window.mainCloseBehavior") === true &&
    (desktop.platform === "win32" || desktop.platform === "linux");
  const [settings, setSettings] = useState<JokoDesktopMainWindowCloseSettings>();
  const settingsRef = useRef<JokoDesktopMainWindowCloseSettings | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<"load" | "save">();
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const attempted = useRef<JokoDesktopMainWindowCloseSettings["behavior"]>(null);

  useEffect(() => {
    const owner = ++generation.current;
    settingsRef.current = undefined;
    pendingRef.current = false;
    setSettings(undefined);
    setPending(false);
    setError(undefined);
    if (!available || api === undefined) return;
    const accept = (next: JokoDesktopMainWindowCloseSettings): void => {
      if (generation.current !== owner || (settingsRef.current !== undefined && next.revision < settingsRef.current.revision)) return;
      settingsRef.current = next;
      setSettings(next);
      setError((current) => current === "load" ? undefined : current);
    };
    const unsubscribe = api.onChanged(accept);
    void api.get().then(accept, () => {
      if (generation.current === owner && settingsRef.current === undefined) setError("load");
    });
    return () => { generation.current += 1; unsubscribe(); };
  }, [api, available, reload]);

  const save = async (behavior: JokoDesktopMainWindowCloseSettings["behavior"]): Promise<void> => {
    const current = settingsRef.current;
    if (!available || api === undefined || current === undefined || pendingRef.current) return;
    const owner = generation.current;
    attempted.current = behavior;
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    const accept = (next: JokoDesktopMainWindowCloseSettings): void => {
      if (generation.current !== owner || (settingsRef.current !== undefined && next.revision < settingsRef.current.revision)) return;
      settingsRef.current = next;
      setSettings(next);
    };
    try {
      accept(await api.set({ behavior, expectedRevision: current.revision }));
    } catch {
      if (generation.current !== owner) return;
      setError("save");
      // A different window may have committed while this request was pending.
      try { accept(await api.get()); }
      catch { /* Keep the last acknowledged choice and the visible retry. */ }
    } finally {
      if (generation.current === owner) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  };

  if (desktop === undefined) return null;
  return <div className="setting-row desktop-main-window-close-setting">
    <div>
      <strong>{t("desktopClose.title")}</strong>
      <span>{available ? t("desktopClose.description") : t("desktopClose.platformManaged")}</span>
      {available && settings === undefined && error === undefined && <span role="status">{t("common.loading")}</span>}
      {pending && <span role="status">{t("common.working")}</span>}
      {error !== undefined && <span role="alert">{t(error === "load" ? "desktopClose.loadFailed" : "desktopClose.saveFailed")}</span>}
    </div>
    {available && <div className="desktop-main-window-close-setting__actions">
      <SelectControl aria-label={t("desktopClose.title")} aria-busy={pending} disabled={settings === undefined || pending}
        value={settings?.behavior ?? "ask"} onChange={(event) => {
          const value = event.target.value;
          if (value === "ask" || value === "quit" || value === (desktop.platform === "win32" ? "tray" : "minimize")) {
            void save(value === "ask" ? null : value as "tray" | "minimize" | "quit");
          }
        }}>
        <option value="ask">{t("desktopClose.ask")}</option>
        <option value={desktop.platform === "win32" ? "tray" : "minimize"}>{t(desktop.platform === "win32" ? "desktopClose.tray" : "desktopClose.minimize")}</option>
        <option value="quit">{t("desktopClose.quit")}</option>
      </SelectControl>
      {error !== undefined && <Button tone="ghost" disabled={pending} onClick={() => {
        if (error === "load") setReload((value) => value + 1);
        else void save(attempted.current);
      }}>{t("common.retry")}</Button>}
    </div>}
  </div>;
}

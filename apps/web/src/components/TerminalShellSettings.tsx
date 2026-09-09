import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AppController } from "../controller.js";
import type { TerminalCapabilitiesView } from "../model.js";
import { readTerminalShellPreference, subscribeTerminalShellPreference, writeTerminalShellPreference } from "../terminal-preferences.js";
import { Button, SelectControl } from "./ui.js";
import type { Translator } from "./types.js";

export function TerminalShellSettings({ controller, t }: { readonly controller: AppController; readonly t: Translator }) {
  const preference = useSyncExternalStore(subscribeTerminalShellPreference, readTerminalShellPreference);
  const [capabilities, setCapabilities] = useState<TerminalCapabilitiesView>();
  const [error, setError] = useState<string>();
  const latest = useRef(controller);
  latest.current = controller;
  const profile = `${controller.state.activeProfile?.serverId ?? ""}\u0000${controller.state.activeProfile?.id ?? ""}`;
  const connected = controller.state.connectionState === "connected";
  useEffect(() => {
    setCapabilities(undefined);
    setError(undefined);
    if (!connected) return;
    const request = new AbortController();
    void latest.current.getTerminalCapabilities(undefined, request.signal).then((value) => {
      if (!request.signal.aborted) setCapabilities(value);
    }).catch((failure) => { if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => request.abort();
  }, [connected, profile]);
  const save = (value: string): void => {
    try { writeTerminalShellPreference(value); setError(undefined); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const automatic = capabilities?.shells.find((shell) => shell.id === capabilities.defaultShellId)?.label ?? t("terminal.automatic");
  return <section className="settings-card" aria-label={t("terminal.defaultShell")}>
    <header><h3>{t("terminal.defaultShell")}</h3><Button disabled={preference === "auto"} onClick={() => save("auto")}>{t("terminal.resetDefault")}</Button></header>
    <p className="muted">{t("terminal.defaultShellBody")}</p>
    <SelectControl aria-label={t("terminal.defaultShell")} value={preference} disabled={!connected || capabilities?.support !== "supported"} onChange={(event) => save(event.currentTarget.value)}>
      <option value="auto">{t("terminal.autoShell", { shell: automatic })}</option>
      {capabilities?.shells.map((shell) => <option key={shell.id} value={shell.id}>{shell.label}</option>)}
      {preference !== "auto" && !capabilities?.shells.some((shell) => shell.id === preference) && <option value={preference} disabled>{t("terminal.unavailableShell", { shell: preference })}</option>}
    </SelectControl>
    {error !== undefined && <p role="alert" className="inline-error">{error}</p>}
    {capabilities !== undefined && capabilities.support !== "supported" && <p role="status">{capabilities.reason ?? t("terminal.unavailable")}</p>}
  </section>;
}

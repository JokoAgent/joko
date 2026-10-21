import { useEffect, useMemo, useState, type JSX } from "react";
import type { ExtensionNetworkConnectionSlot, ExtensionNetworkState } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { ExtensionCatalogEntryView, ExtensionNetworkApi } from "../model.js";
import type { Translator } from "./types.js";
import { Button, Pill } from "./ui.js";
import "./extension-network.css";

export function ExtensionNetworkSection({ controller, extension, disabled, t, onChanged }: {
  readonly controller: AppController; readonly extension: ExtensionCatalogEntryView; readonly disabled: boolean; readonly t: Translator;
  readonly onChanged: () => Promise<void>;
}): JSX.Element | null {
  const [state, setState] = useState<ExtensionNetworkState>();
  const [error, setError] = useState(false), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const [mutationError, setMutationError] = useState(false);
  const lifetime = useMemo(() => ({ controller: new AbortController(), busy: false }), [controller, extension.id]);
  useEffect(() => {
    if (lifetime.controller.signal.aborted) lifetime.controller = new AbortController();
    setBusy(false);
    return () => lifetime.controller.abort();
  }, [lifetime]);
  useEffect(() => {
    const abort = new AbortController(), signal = AbortSignal.any([lifetime.controller.signal, abort.signal]);
    const api = controller.extensionNetworkApi();
    if (!api) { setError(true); return; }
    void api.get({ extensionId: extension.id }, { signal }).then(result => {
      if (!signal.aborted) { setState(result.state); setError(false); }
    }).catch(() => { if (!signal.aborted) setError(true); });
    return () => abort.abort();
  }, [controller, extension.id, extension.revision, refresh, lifetime]);
  const selected = state?.extensionId === extension.id ? state : undefined;
  const run = async (work: (api: ExtensionNetworkApi, state: ExtensionNetworkState, signal: AbortSignal) => Promise<ExtensionNetworkState>): Promise<boolean> => {
    if (lifetime.busy || disabled || !selected) return false;
    const api = controller.extensionNetworkApi();
    if (!api) { setError(true); return false; }
    const signal = lifetime.controller.signal;
    lifetime.busy = true; setBusy(true); setError(false); setMutationError(false);
    try {
      const next = await work(api, selected, signal); signal.throwIfAborted(); setState(next);
      try { await onChanged(); } catch { if (!signal.aborted) setError(true); }
      return true;
    } catch {
      if (!signal.aborted) { setMutationError(true); setRefresh(value => value + 1); }
      return false;
    } finally { lifetime.busy = false; if (!signal.aborted) setBusy(false); }
  };
  if (!selected?.slots.length && !error && !mutationError) return null;
  return <section className="extension-network" aria-label={t("extensions.network.title")} aria-busy={busy}>
    <header><h3>{t("extensions.network.title")}</h3><p>{t("extensions.network.body")}</p></header>
    {(error || mutationError) && <div className="extension-network__error" role="alert"><p>{t("extensions.network.error")}</p><Button disabled={busy} onClick={() => { setMutationError(false); setRefresh(value => value + 1); }}>{t("common.retry")}</Button></div>}
    {selected?.slots.map(slot => <ConnectionSlot key={`${extension.id}:${slot.key}`} slot={slot} disabled={disabled || busy} t={t}
      save={(host, label, token) => run((api, state, signal) => api.save({ extensionId: state.extensionId, expectedRevision: state.revision, slotKey: slot.key, host, label }, token, signal))}
      change={(id, action) => run(async (api, state, signal) => {
        const result = await api.change({ extensionId: state.extensionId, expectedRevision: state.revision, slotKey: slot.key,
          action: action === "remove" ? { case: "removeConnectionId", value: id } : { case: "defaultConnectionId", value: id } }, { signal });
        if (!result.state) throw new Error("Missing connection state."); return result.state;
      })} />)}
  </section>;
}

function ConnectionSlot({ slot, disabled, t, save, change }: {
  readonly slot: ExtensionNetworkConnectionSlot; readonly disabled: boolean; readonly t: Translator;
  readonly save: (host: string, label: string, token: string) => Promise<boolean>;
  readonly change: (id: string, action: "remove" | "default") => Promise<boolean>;
}): JSX.Element {
  const [host, setHost] = useState(""), [label, setLabel] = useState(""), [token, setToken] = useState("");
  const [editing, setEditing] = useState<string>();
  const atLimit = slot.connections.length >= slot.maximumConnections && !slot.connections.some(row => row.host === host.trim().toLowerCase());
  return <section className="extension-network__slot" aria-label={slot.label}>
    <header><strong>{slot.label}</strong><span>{slot.connections.length} / {slot.maximumConnections}</span></header>
    {slot.hint && <p>{slot.hint}</p>}
    {slot.connections.length === 0 && <p>{t("extensions.network.empty")}</p>}
    {slot.connections.map(row => <div className="extension-network__row" key={row.connectionId}>
      <div><strong>{row.label || row.host}</strong>{row.label && <small>{row.host}</small>}{!row.configured && <small>{t("extensions.network.missingToken")}</small>}</div>
      <div className="extension-network__actions">
        {row.isDefault ? <Pill tone="success">{t("extensions.network.default")}</Pill> : <Button disabled={disabled} onClick={() => { void change(row.connectionId, "default"); }}>{t("extensions.network.makeDefault")}</Button>}
        <Button disabled={disabled} onClick={() => { setEditing(row.host); setHost(row.host); setLabel(row.label ?? ""); setToken(""); }}>{t("extensions.network.update")}</Button>
        <Button tone="ghost" disabled={disabled} onClick={() => { void change(row.connectionId, "remove"); }}>{t("common.remove")}</Button>
      </div>
    </div>)}
    <form className="extension-network__form" onSubmit={event => {
      event.preventDefault(); if (disabled || atLimit) return;
      void save(host.trim(), label.trim(), token).then(saved => { if (saved) { setHost(""); setLabel(""); setToken(""); setEditing(undefined); } });
    }}>
      <label><span>{t("extensions.network.host")}</span><input required type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={253} value={host} readOnly={editing !== undefined} disabled={disabled} placeholder="service.example.com" onChange={event => setHost(event.target.value)} /></label>
      <label><span>{t("extensions.network.label")}</span><input type="text" autoComplete="off" maxLength={64} value={label} disabled={disabled} onChange={event => setLabel(event.target.value)} /></label>
      <label><span>{t("extensions.network.token")}</span><input required type="password" autoComplete="new-password" maxLength={16_384} value={token} disabled={disabled} onChange={event => setToken(event.target.value)} /></label>
      <div className="extension-network__actions">
        {editing && <Button disabled={disabled} onClick={() => { setEditing(undefined); setHost(""); setLabel(""); setToken(""); }}>{t("common.cancel")}</Button>}
        <Button type="submit" tone="primary" disabled={disabled || atLimit || !host.trim() || !token}>{t(editing ? "common.save" : "extensions.network.add")}</Button>
      </div>
      {atLimit && <p>{t("extensions.network.limit")}</p>}
    </form>
  </section>;
}

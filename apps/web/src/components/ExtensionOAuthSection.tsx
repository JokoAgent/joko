import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { ExtensionOAuthSlot, ExtensionOAuthState } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { ExtensionCatalogEntryView, ExtensionOAuthApi } from "../model.js";
import type { Translator } from "./types.js";
import { Button, CheckboxControl, Pill } from "./ui.js";
import "./extension-network.css";

export function ExtensionOAuthSection({ controller, extension, disabled, t, onChanged }: {
  readonly controller: AppController; readonly extension: ExtensionCatalogEntryView; readonly disabled: boolean; readonly t: Translator; readonly onChanged: () => Promise<void>;
}): JSX.Element | null {
  const [state, setState] = useState<ExtensionOAuthState>(), [error, setError] = useState(false), [refresh, setRefresh] = useState(0);
  const [mutationError, setMutationError] = useState(false);
  const [busy, setBusy] = useState(false), [authorizing, setAuthorizing] = useState(false), [canAuthorize, setCanAuthorize] = useState(false);
  const lifetime = useMemo(() => ({ abort: new AbortController(), busy: false }), [controller, extension.id]);
  const operation = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    if (lifetime.abort.signal.aborted) lifetime.abort = new AbortController();
    setBusy(false); setAuthorizing(false); return () => lifetime.abort.abort();
  }, [lifetime]);
  useEffect(() => {
    const abort = new AbortController(), signal = AbortSignal.any([lifetime.abort.signal, abort.signal]), api = controller.extensionOAuthApi();
    setCanAuthorize(api?.canAuthorize === true);
    if (!api) { setError(true); return; }
    void api.get({ extensionId: extension.id }, { signal }).then(result => { if (!signal.aborted) { setState(result.state); setError(false); } })
      .catch(() => { if (!signal.aborted) setError(true); });
    return () => abort.abort();
  }, [controller, extension.id, extension.revision, lifetime, refresh]);
  const selected = state?.extensionId === extension.id ? state : undefined;
  const run = async (authorize: boolean, work: (api: ExtensionOAuthApi, state: ExtensionOAuthState, signal: AbortSignal) => Promise<ExtensionOAuthState>) => {
    if (disabled || lifetime.busy || !selected) return false;
    const api = controller.extensionOAuthApi(); if (!api) { setError(true); return false; }
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, lifetime.abort.signal]); operation.current = abort;
    lifetime.busy = true; setBusy(true); setAuthorizing(authorize); setError(false); setMutationError(false);
    try {
      const next = await work(api, selected, signal); signal.throwIfAborted(); setState(next);
      try { await onChanged(); } catch { if (!lifetime.abort.signal.aborted) setError(true); } return true;
    } catch { if (!lifetime.abort.signal.aborted) { setMutationError(true); setRefresh(value => value + 1); } return false; }
    finally { lifetime.busy = false; operation.current = undefined; if (!lifetime.abort.signal.aborted) { setBusy(false); setAuthorizing(false); } }
  };
  if (!selected?.slots.length && !error && !mutationError) return null;
  return <section className="extension-network" aria-label={t("extensions.oauth.title")} aria-busy={busy}>
    <header><h3>{t("extensions.oauth.title")}</h3><p>{t("extensions.oauth.body")}</p></header>
    {(error || mutationError) && <div className="extension-network__error" role="alert"><p>{t("extensions.oauth.error")}</p><Button disabled={busy} onClick={() => { setMutationError(false); setRefresh(value => value + 1); }}>{t("common.retry")}</Button></div>}
    {authorizing && <div className="extension-network__row" role="status"><div><strong>{t("extensions.oauth.waiting")}</strong><small>{t("extensions.oauth.waitingBody")}</small></div><Button onClick={() => operation.current?.abort()}>{t("common.cancel")}</Button></div>}
    {selected?.slots.map(slot => <OAuthSlot key={`${extension.id}:${slot.key}`} slot={slot} t={t} disabled={disabled || busy} canAuthorize={canAuthorize}
      save={(id, secret) => run(false, (api, state, signal) => api.saveClient({ extensionId: state.extensionId, expectedRevision: state.revision, slotKey: slot.key }, id, secret, signal))}
      connect={scopes => run(true, (api, state, signal) => api.authorize({ extensionId: state.extensionId, expectedRevision: state.revision, slotKey: slot.key, scopes }, signal))}
      change={(kind, id) => run(false, async (api, state, signal) => {
        const result = await api.change({ extensionId: state.extensionId, expectedRevision: state.revision, slotKey: slot.key, action: kind === "clear" ? { case: "clearClient", value: true }
          : kind === "remove" ? { case: "removeAccountId", value: id! } : { case: "defaultAccountId", value: id! } }, { signal });
        if (!result.state) throw new Error("Missing account state."); return result.state;
      })} />)}
  </section>;
}
function OAuthSlot({ slot, t, disabled, canAuthorize, save, connect, change }: {
  readonly slot: ExtensionOAuthSlot; readonly t: Translator; readonly disabled: boolean; readonly canAuthorize: boolean;
  readonly save: (id: string, secret: string) => Promise<boolean>; readonly connect: (scopes: string[]) => Promise<boolean>;
  readonly change: (kind: "clear" | "default" | "remove", id?: string) => Promise<boolean>;
}): JSX.Element {
  const [clientId, setClientId] = useState(""), [secret, setSecret] = useState("");
  const [scopes, setScopes] = useState<string[]>([...slot.scopes]);
  useEffect(() => { setScopes([...slot.scopes]); }, [slot.scopes.join("\0")]);
  return <section className="extension-network__slot" aria-label={slot.label}>
    <header><strong>{slot.label}</strong><span>{slot.accounts.length} / 8</span></header>
    {slot.hint && <p>{slot.hint}</p>}
    <p className="extension-oauth__origins">{slot.authorizeOrigin} · {slot.tokenOrigin}</p>
    {slot.accounts.length === 0 && <p>{t("extensions.oauth.empty")}</p>}
    {slot.accounts.map(account => <div className="extension-network__row" key={account.accountId}>
      <div><strong>{account.label || t("extensions.oauth.account")}</strong>{account.clientChanged ? <small>{t("extensions.oauth.clientChanged")}</small>
        : account.expired ? <small>{t("extensions.oauth.expired")}</small> : account.scopeStale ? <small>{t("extensions.oauth.scopeStale")}: {account.missingScopes.join(", ")}</small> : <small>{t("extensions.oauth.connected")}</small>}</div>
      <div className="extension-network__actions">{account.isDefault ? <Pill tone="success">{t("extensions.network.default")}</Pill>
        : <Button disabled={disabled} onClick={() => { void change("default", account.accountId); }}>{t("extensions.network.makeDefault")}</Button>}
        <Button tone="ghost" disabled={disabled} onClick={() => { void change("remove", account.accountId); }}>{t("common.remove")}</Button></div>
    </div>)}
    <form className="extension-network__form" onSubmit={event => { event.preventDefault(); if (disabled) return;
      void save(clientId.trim(), secret.trim()).then(saved => { if (saved) { setClientId(""); setSecret(""); } }); }}>
      <label><span>{t("extensions.oauth.clientId")}</span><input required autoComplete="off" spellCheck={false} maxLength={200} value={clientId} disabled={disabled} onChange={event => setClientId(event.target.value)} /></label>
      <label><span>{t("extensions.oauth.clientSecret")}</span><input type="password" autoComplete="new-password" maxLength={200} value={secret} disabled={disabled} onChange={event => setSecret(event.target.value)} /></label>
      <div className="extension-network__actions">{slot.clientCustomized && <Button disabled={disabled} onClick={() => { void change("clear"); }}>{t("extensions.oauth.clearClient")}</Button>}
        <Button type="submit" disabled={disabled || !clientId.trim()}>{t("common.save")}</Button></div>
    </form>
    {slot.scopes.length > 0 && <fieldset className="extension-oauth__scopes" disabled={disabled}><legend>{t("extensions.oauth.scopes")}</legend>{slot.scopes.map(scope => <label key={scope}><CheckboxControl checked={scopes.includes(scope)} onChange={event => setScopes(values => event.target.checked ? [...values, scope] : values.filter(value => value !== scope))} /><span>{scope}</span></label>)}</fieldset>}
    {!canAuthorize && <p>{t("extensions.oauth.desktopRequired")}</p>}
    {!slot.clientConfigured && <p>{t("extensions.oauth.clientRequired")}</p>}
    <div className="extension-network__actions"><Button tone="primary" disabled={disabled || !canAuthorize || !slot.clientConfigured || slot.scopes.length > 0 && scopes.length === 0}
      onClick={() => { void connect(scopes.length === slot.scopes.length ? [] : scopes); }}>{t("extensions.oauth.connect")}</Button></div>
  </section>;
}

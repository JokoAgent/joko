import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type { RemoteHostDraft, SshKeyCatalogView, SshKeyView } from "../model.js";
import { sshKeyFailure, sshKeyOutcomeUncertain, type SshKeyFailure } from "../ssh-key-error.js";
import { SshCopyButton, SshKeyMutationDialog, type Dialog, type KeyApi, type Scope } from "./SshKeySettings.js";
import type { Translator } from "./types.js";
import { Button, Pill, SelectControl } from "./ui.js";

/** Node-owned identities inside an unsaved Host. No private material enters its draft. */
export function RemoteHostKeySetup({ api, signal: parentSignal, ownerDocument, draft, disabled, onSelect, onValidityChange, t }: {
  readonly api: KeyApi; readonly signal: AbortSignal; readonly ownerDocument: Document;
  readonly draft: RemoteHostDraft; readonly disabled: boolean;
  readonly onSelect: (key: SshKeyView) => void; readonly onValidityChange: (valid: boolean) => void; readonly t: Translator;
}): JSX.Element {
  const [epoch, setEpoch] = useState(0);
  const scope = useMemo<Scope>(() => ({ api, document: ownerDocument, abort: new AbortController(), read: 0 }), [api, parentSignal, ownerDocument, epoch]);
  const root = useRef<HTMLDivElement>(null);
  const [catalog, setCatalog] = useState<{ scope: Scope; value: SshKeyCatalogView }>();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<SshKeyFailure>();
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [dialog, setDialog] = useState<Dialog>();
  const [feedback, setFeedback] = useState<"sshKeys.generated" | "sshKeys.added" | "sshKeys.generatedAgentUnconfirmed" | "sshKeys.generatedAndAdded">();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const continuation = useRef<{ scope: Scope; key: SshKeyView; origin: Element; trigger: HTMLElement; anchored: boolean } | undefined>(undefined);
  const value = catalog?.scope === scope ? catalog.value : undefined;
  const selected = value?.keys.find(key => key.id === draft.nodeKey?.id && key.sha256Fingerprint === draft.nodeKey.expectedFingerprint);
  const current = (): boolean => !scope.abort.signal.aborted && !parentSignal.aborted && root.current?.isConnected === true && root.current.ownerDocument === ownerDocument && ownerDocument.defaultView?.document === ownerDocument;
  const refresh = async (allowChanges = true): Promise<void> => {
    if (!current()) return;
    const read = ++scope.read; setLoading(true); setFailure(undefined);
    try {
      const next = await api.listSshKeys(scope.abort.signal);
      if (current() && read === scope.read) { setCatalog({ scope, value: next }); setNeedsRefresh(!allowChanges); }
    } catch (cause) { if (current() && read === scope.read) setFailure(sshKeyFailure(cause)); }
    finally { if (current() && read === scope.read) setLoading(false); }
  };
  useLayoutEffect(() => {
    if (scope.abort.signal.aborted) { setEpoch(value => value + 1); return; }
    const retire = (): void => { scope.abort.abort(); setDialog(undefined); onValidityChange(false); };
    const trackFocus = (event: FocusEvent): void => {
      const next = continuation.current;
      if (next?.scope === scope && event.target !== root.current && event.target !== next.origin && event.target !== next.trigger) continuation.current = undefined;
    };
    parentSignal.addEventListener("abort", retire, { once: true });
    ownerDocument.addEventListener("focusin", trackFocus);
    return () => { scope.abort.abort(); parentSignal.removeEventListener("abort", retire); ownerDocument.removeEventListener("focusin", trackFocus); };
  }, [scope]);
  useEffect(() => { void refresh(); }, [scope]);
  const ready = current() && !disabled && !loading && value !== undefined;
  useEffect(() => { onValidityChange(ready && selected !== undefined && dialog === undefined && !needsRefresh); }, [ready, selected, dialog, needsRefresh, onValidityChange]);
  useLayoutEffect(() => {
    const next = continuation.current;
    if (!next) return;
    const focused = ownerDocument.activeElement;
    if (!current() || next.scope !== scope || (next.anchored ? focused !== root.current : focused !== next.origin && focused !== next.trigger && focused !== ownerDocument.body)) { continuation.current = undefined; return; }
    if (loading) { root.current?.focus({ preventScroll: true }); next.anchored = true; return; }
    continuation.current = undefined;
    (value?.keys.some(key => key.id === next.key.id && key.sha256Fingerprint === next.key.sha256Fingerprint) ? buttons.current.get(next.key.id) ?? root.current : root.current)?.focus();
  }, [loading, catalog, dialog, scope]);
  const retainGenerated = (key: SshKeyView): void => {
    if (!current()) return;
    onSelect(key); setFeedback("sshKeys.generated");
    setCatalog(previous => previous?.scope === scope ? { scope, value: { ...previous.value, keys: [...previous.value.keys.filter(item => item.id !== key.id), key] } } : previous);
  };
  return <div ref={root} className="ssh-key-settings settings-form__wide" tabIndex={-1}>
    <p>{t("sshKeys.hostOwnership")}</p>
    <div className="ssh-key-actions"><Button disabled={disabled || loading || parentSignal.aborted} onClick={() => { void refresh(); }}>{t("common.refresh")}</Button>
      <Button disabled={!ready || !value?.generationSupported || needsRefresh} onClick={event => setDialog({ scope, kind: "generate", trigger: event.currentTarget, offerAgentLoad: value?.agentState === "ready" })}>{t("sshKeys.generate")}</Button></div>
    {loading && <p role="status">{t("common.loading")}</p>}
    {failure && <p role="alert">{t(`sshKeys.error.${failure}`)}</p>}
    {feedback && <p role="status">{t(feedback)}</p>}
    {needsRefresh && <p role="status">{t("sshKeys.inspectBeforeRetry")}</p>}
    {value && <><p role="status">{t(`sshKeys.agent.${value.agentState}`)}</p>{value.keys.length === 0 && <p>{t("sshKeys.empty")}</p>}
      <div className="ssh-key-list" role="list">{value.keys.map(key => <div className="ssh-key-row" key={key.id} role="listitem">
        <button ref={element => { if (element) buttons.current.set(key.id, element); else buttons.current.delete(key.id); }} type="button" className="ssh-key-choice" disabled={!ready} aria-disabled={needsRefresh || undefined} aria-pressed={selected === key} onClick={() => { if (current() && ready && !needsRefresh) onSelect(key); }}><span><strong>{key.name}</strong><small>{key.algorithm}</small><code>{key.sha256Fingerprint}</code></span></button>
        {key.inAgent ? <Pill tone="success">{t("sshKeys.inAgent")}</Pill> : <Button disabled={!ready || value.agentState !== "ready" || needsRefresh} onClick={event => setDialog({ scope, kind: "agent", key, trigger: event.currentTarget })}>{t("sshKeys.addToAgent")}</Button>}
      </div>)}</div></>}
    {draft.nodeKey && !selected && !loading && <p role="alert">{t("sshKeys.selectedUnavailable")} <code>{draft.nodeKey.id} · {draft.nodeKey.expectedFingerprint}</code></p>}
    {selected && <><p>{t(selected.inAgent ? "sshKeys.selectedAgentOnly" : "sshKeys.loadBeforeConnect")}</p><DraftKeyRecipe key={JSON.stringify([selected.id, selected.sha256Fingerprint])} scope={scope} selected={selected} draft={draft} disabled={!ready || needsRefresh} t={t} /></>}
    {dialog?.scope === scope && !scope.abort.signal.aborted && <SshKeyMutationDialog dialog={dialog} valid={dialog.key === undefined || value?.keys.some(key => key.id === dialog.key?.id && key.sha256Fingerprint === dialog.key.sha256Fingerprint) === true} t={t}
      onClose={() => setDialog(undefined)} onStart={() => { setNeedsRefresh(true); setFeedback(undefined); setFailure(undefined); }} onGenerated={retainGenerated}
      onFailure={error => { if (current()) setNeedsRefresh(observe(error)); }}
      onSuccess={(result, origin) => {
        if (!current()) return;
        const key = result.key ?? dialog.key;
        if (key && origin) continuation.current = { scope, key, origin, trigger: dialog.trigger, anchored: false };
        setDialog(undefined); setFailure(result.agentFailure);
        setFeedback(dialog.kind === "agent" ? "sshKeys.added" : result.agentFailure ? "sshKeys.generatedAgentUnconfirmed" : result.agentAdded ? "sshKeys.generatedAndAdded" : "sshKeys.generated");
        void refresh(result.agentFailure === undefined || !observe(result.agentFailure));
      }} />}
  </div>;
}

function DraftKeyRecipe({ scope, selected, draft, disabled, t }: { readonly scope: Scope; readonly selected: SshKeyView; readonly draft: RemoteHostDraft; readonly disabled: boolean; readonly t: Translator }): JSX.Element {
  const [shell, setShell] = useState<"posix" | "powershell">("posix");
  const [publicKey, setPublicKey] = useState<string>();
  const [readError, setReadError] = useState<SshKeyFailure>();
  const [command, setCommand] = useState<{ identity: string; value: string }>();
  const [failure, setFailure] = useState<SshKeyFailure>();
  const [pending, setPending] = useState(false);
  const identity = JSON.stringify([selected.id, selected.sha256Fingerprint, draft.hostname, draft.user, draft.port, shell, disabled]);
  const request = useRef<{ abort: AbortController; pending: boolean } | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController(); const signal = AbortSignal.any([abort.signal, scope.abort.signal]);
    void scope.api.readSshPublicKey(selected.id, selected.sha256Fingerprint, signal).then(text => { if (!signal.aborted) setPublicKey(text); }).catch(error => { if (!signal.aborted) setReadError(sshKeyFailure(error)); });
    return () => abort.abort();
  }, [scope, selected.id, selected.sha256Fingerprint]);
  useLayoutEffect(() => {
    const next = { abort: new AbortController(), pending: false }; request.current = next; setPending(false); setFailure(undefined);
    return () => { next.abort.abort(); };
  }, [scope, identity]);
  const endpointReady = draft.hostname.trim() !== "" && draft.user.trim() !== "" && Number.isInteger(draft.port) && draft.port >= 1 && draft.port <= 65535;
  const show = async (): Promise<void> => {
    const owner = request.current;
    if (!owner || owner.pending || disabled || !endpointReady) return;
    const signal = AbortSignal.any([owner.abort.signal, scope.abort.signal]); if (signal.aborted) return;
    owner.pending = true; setPending(true); setFailure(undefined);
    try {
      const text = await scope.api.getSshKeyInstallCommand({ keyId: selected.id, expectedFingerprint: selected.sha256Fingerprint, destination: { kind: "draftHost", hostname: draft.hostname.trim(), user: draft.user.trim(), port: draft.port }, shell }, signal);
      if (!signal.aborted && request.current === owner) setCommand({ identity, value: text });
    } catch (error) { if (!signal.aborted) setFailure(sshKeyFailure(error)); }
    finally { if (!signal.aborted && request.current === owner) { owner.pending = false; setPending(false); } }
  };
  return <div className="ssh-key-detail">
    {readError && <p role="alert">{t(`sshKeys.error.${readError}`)}</p>}
    {publicKey && <><textarea readOnly aria-label={t("sshKeys.publicKey")} value={publicKey} rows={3} /><SshCopyButton scope={scope} text={publicKey} sourceKey={selected.sha256Fingerprint} label={t("sshKeys.copyPublicKey")} t={t} /></>}
    <h3>{t("sshKeys.install")}</h3><p>{t("sshKeys.draftInstallBody")}</p>
    <label className="field"><span>{t("sshKeys.shell")}</span><SelectControl value={shell} disabled={disabled} onChange={event => setShell(event.target.value as typeof shell)}><option value="posix">POSIX</option><option value="powershell">PowerShell</option></SelectControl></label>
    <Button disabled={disabled || !endpointReady || pending} onClick={() => { void show(); }}>{t(pending ? "common.working" : "sshKeys.showCommand")}</Button>
    {failure && <p role="alert">{t(`sshKeys.error.${failure}`)}</p>}
    {command?.identity === identity && !disabled && <><textarea readOnly aria-label={t("sshKeys.installCommand")} value={command.value} rows={4} /><SshCopyButton scope={scope} text={command.value} sourceKey={identity} label={t("sshKeys.copyCommand")} t={t} /></>}
  </div>;
}
function observe(error: SshKeyFailure): boolean { return sshKeyOutcomeUncertain(error) || error === "key_changed" || error === "not_found"; }

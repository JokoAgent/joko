import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Copy, KeyRound, Plus, RefreshCw } from "lucide-react";
import type { AppController } from "../controller.js";
import type { RemoteHostView, SshKeyCatalogView, SshKeyView, TargetView } from "../model.js";
import { writeClipboardText } from "../clipboard-action.js";
import { sshKeyFailure, sshKeyOutcomeUncertain, type SshKeyFailure } from "../ssh-key-error.js";
import type { Translator } from "./types.js";
import { Button, CheckboxControl, Modal, Pill, SelectControl } from "./ui.js";
import { useClipboardAction } from "./use-clipboard-action.js";
import "./ssh-key-settings.css";

export type KeyApi = Pick<AppController, "listSshKeys" | "generateSshKey" | "addSshKeyToAgent" | "readSshPublicKey" | "getSshKeyInstallCommand" | "watchRemoteHosts">;
export interface Scope { readonly abort: AbortController; readonly api: KeyApi; document?: Document; read: number }
export interface Dialog { readonly scope: Scope; readonly kind: "generate" | "agent"; readonly trigger: HTMLButtonElement; readonly key?: SshKeyView; readonly offerAgentLoad?: boolean }
export interface MutationResult { readonly key?: SshKeyView; readonly agentAdded?: boolean; readonly agentFailure?: SshKeyFailure }
interface FocusContinuation { readonly scope: Scope; readonly key: SshKeyView; readonly origin: Element; readonly trigger: HTMLButtonElement; readonly read: number; anchored: boolean }
function needsObservation(failure: SshKeyFailure): boolean {
  return sshKeyOutcomeUncertain(failure) || failure === "key_changed" || failure === "not_found";
}

export function SshKeySettings({ controller, t }: { readonly controller: AppController; readonly t: Translator }): JSX.Element {
  const api = useMemo<KeyApi>(() => ({ listSshKeys: controller.listSshKeys, generateSshKey: controller.generateSshKey,
    addSshKeyToAgent: controller.addSshKeyToAgent, readSshPublicKey: controller.readSshPublicKey,
    getSshKeyInstallCommand: controller.getSshKeyInstallCommand, watchRemoteHosts: controller.watchRemoteHosts }),
  [controller.listSshKeys, controller.generateSshKey, controller.addSshKeyToAgent, controller.readSshPublicKey, controller.getSshKeyInstallCommand, controller.watchRemoteHosts]);
  const profile = JSON.stringify([controller.state.activeProfile?.serverId, controller.state.activeProfile?.id]);
  return <SshKeySettingsOwner key={profile} api={api} connected={controller.state.connectionState === "connected"}
    nodeName={controller.state.activeProfile?.name ?? "Joko"} targets={controller.state.snapshot.targets.filter((target) => !target.archived)} t={t} />;
}

function SshKeySettingsOwner({ api, connected, nodeName, targets, t }: {
  readonly api: KeyApi; readonly connected: boolean; readonly nodeName: string; readonly targets: readonly TargetView[]; readonly t: Translator;
}): JSX.Element {
  const root = useRef<HTMLElement>(null);
  const keyButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusContinuation = useRef<FocusContinuation | undefined>(undefined);
  const [epoch, setEpoch] = useState(0);
  const scope = useMemo<Scope>(() => ({ api, abort: new AbortController(), read: 0 }), [api, connected, epoch]);
  const active = useRef<Scope | undefined>(undefined);
  const [catalog, setCatalog] = useState<{ scope: Scope; value: SshKeyCatalogView }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<SshKeyFailure>();
  const [selectedId, setSelectedId] = useState("");
  const [dialog, setDialog] = useState<Dialog>();
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [feedback, setFeedback] = useState<"generated" | "generatedAndAdded" | "generatedAgentUnconfirmed" | "added">();
  const [agentWarning, setAgentWarning] = useState<SshKeyFailure>();
  const [retired, setRetired] = useState(false);
  const value = catalog?.scope.api === api ? catalog.value : undefined;
  const current = (): boolean => active.current === scope && !scope.abort.signal.aborted && connected
    && root.current?.isConnected === true && root.current.ownerDocument === scope.document && scope.document?.defaultView?.document === scope.document;
  const refresh = async (allowChanges = true): Promise<void> => {
    if (!current()) return;
    const read = ++scope.read;
    setLoading(true); setError(undefined);
    try {
      const next = await api.listSshKeys(scope.abort.signal);
      if (!current() || read !== scope.read) return;
      setCatalog({ scope, value: next }); setNeedsRefresh(!allowChanges);
    } catch (cause) { if (current() && read === scope.read) setError(sshKeyFailure(cause)); }
    finally { if (current() && read === scope.read) setLoading(false); }
  };
  useLayoutEffect(() => {
    if (scope.abort.signal.aborted) { setEpoch((value) => value + 1); return; }
    scope.document = root.current?.ownerDocument; active.current = scope;
    setDialog(undefined); setError(undefined); setFeedback(undefined); setAgentWarning(undefined); setRetired(false);
    const win = scope.document?.defaultView;
    const trackFocus = (event: FocusEvent): void => {
      const continuation = focusContinuation.current;
      if (continuation?.scope === scope && continuation.anchored && event.target !== root.current) focusContinuation.current = undefined;
    };
    const retire = (): void => { scope.abort.abort(); setDialog(undefined); setLoading(false); setRetired(true); };
    const resume = (): void => { if (active.current === scope) setEpoch((value) => value + 1); };
    win?.addEventListener("pagehide", retire); win?.addEventListener("pageshow", resume);
    scope.document?.addEventListener("focusin", trackFocus);
    return () => { scope.abort.abort(); if (active.current === scope) active.current = undefined; win?.removeEventListener("pagehide", retire); win?.removeEventListener("pageshow", resume); scope.document?.removeEventListener("focusin", trackFocus); };
  }, [scope]);
  useEffect(() => { if (connected) void refresh(); else setLoading(false); }, [scope]);
  const selected = value?.keys.find((key) => key.id === selectedId);
  const ready = connected && !retired && !loading && value !== undefined && catalog?.scope === scope;
  useLayoutEffect(() => {
    const continuation = focusContinuation.current;
    const section = root.current;
    if (continuation === undefined) return;
    if (continuation.scope !== scope || !current() || section === null || scope.read !== continuation.read) { focusContinuation.current = undefined; return; }
    const focused = section.ownerDocument.activeElement;
    if (continuation.anchored ? focused !== section : focused !== continuation.origin && focused !== continuation.trigger && focused !== section.ownerDocument.body) {
      focusContinuation.current = undefined; return;
    }
    if (loading) { section.focus({ preventScroll: true }); continuation.anchored = true; return; }
    focusContinuation.current = undefined;
    const observed = ready && value.keys.some((key) => key.id === continuation.key.id && key.sha256Fingerprint === continuation.key.sha256Fingerprint);
    (observed ? keyButtons.current.get(continuation.key.id) ?? section : section).focus();
  }, [scope, loading, catalog, dialog]);
  const changedDialogKey = dialog?.key !== undefined && !value?.keys.some((key) => key.id === dialog.key?.id && key.sha256Fingerprint === dialog.key.sha256Fingerprint);
  const success = (kind: "generated" | "added", result: MutationResult, focusOrigin: Element | undefined): void => {
    if (!current()) return;
    const resultingKey = result.key ?? dialog?.key;
    if (resultingKey !== undefined && dialog !== undefined && focusOrigin !== undefined) {
      focusContinuation.current = { scope, key: resultingKey, origin: focusOrigin, trigger: dialog.trigger, read: scope.read + 1, anchored: false };
    }
    setFeedback(kind === "added" ? kind : result.agentFailure !== undefined ? "generatedAgentUnconfirmed" : result.agentAdded ? "generatedAndAdded" : "generated");
    setAgentWarning(result.agentFailure); setDialog(undefined);
    if (resultingKey !== undefined) setSelectedId(resultingKey.id);
    void refresh(result.agentFailure === undefined || !needsObservation(result.agentFailure));
  };
  return <section ref={root} className="ssh-key-settings" aria-label={t("sshKeys.title")} tabIndex={-1}>
    <header><div><h2>{t("sshKeys.title")}</h2><p>{t("sshKeys.ownership", { name: nodeName })}</p></div><div className="ssh-key-actions">
      <Button disabled={!connected || retired || loading} onClick={() => { void refresh(); }}><RefreshCw aria-hidden="true" />{t("common.refresh")}</Button>
      <Button tone="primary" disabled={!ready || value?.generationSupported !== true || needsRefresh} onClick={(event) => setDialog({ scope, kind: "generate", trigger: event.currentTarget, offerAgentLoad: value?.agentState === "ready" })}><Plus aria-hidden="true" />{t("sshKeys.generate")}</Button>
    </div></header>
    {!connected && <p role="status">{t("sshKeys.disconnected")}</p>}
    {loading && <p role="status">{t("common.loading")}</p>}
    {error !== undefined && <p role="alert">{t(`sshKeys.error.${error}`)}</p>}
    {needsRefresh && <p role="status">{t("sshKeys.inspectBeforeRetry")}</p>}
    {feedback !== undefined && <p role="status">{t(`sshKeys.${feedback}`)}</p>}
    {agentWarning !== undefined && <p role="alert">{t(`sshKeys.error.${agentWarning}`)}</p>}
    {value !== undefined && <>
      <p className="ssh-key-agent-state" role="status">{t(`sshKeys.agent.${value.agentState}`)}</p>
      {!value.generationSupported && <p>{t("sshKeys.generationUnavailable")}</p>}
      {value.keys.length === 0 && <p>{t("sshKeys.empty")}</p>}
      <div className="ssh-key-list" role="list">{value.keys.map((key) => <div className="ssh-key-row" role="listitem" key={key.id}>
        <button ref={(element) => { if (element === null) keyButtons.current.delete(key.id); else keyButtons.current.set(key.id, element); }} type="button" className="ssh-key-choice" aria-pressed={selectedId === key.id} disabled={!ready} onClick={() => setSelectedId(key.id)}>
          <KeyRound aria-hidden="true" /><span><strong>{key.name}</strong><small>{key.algorithm}{key.comment === "" ? "" : ` · ${key.comment}`}</small><code>{key.sha256Fingerprint}</code></span>
        </button>
        <div className="ssh-key-actions">{key.inAgent ? <Pill tone="success">{t("sshKeys.inAgent")}</Pill>
          : <Button disabled={!ready || value.agentState !== "ready" || needsRefresh} onClick={(event) => setDialog({ scope, kind: "agent", key, trigger: event.currentTarget })}>{t("sshKeys.addToAgent")}</Button>}</div>
      </div>)}</div>
      {selected !== undefined && ready && <SshKeyDetails key={JSON.stringify([selected.id, selected.sha256Fingerprint, epoch])} scope={scope} selected={selected} targets={targets} t={t} />}
    </>}
    {dialog?.scope === scope && !scope.abort.signal.aborted && <SshKeyMutationDialog key={dialog.kind + (dialog.key?.sha256Fingerprint ?? "")} dialog={dialog} valid={!changedDialogKey} t={t}
      onClose={() => setDialog(undefined)} onStart={() => { setNeedsRefresh(true); setFeedback(undefined); setAgentWarning(undefined); }}
      onGenerated={(key) => {
        if (!current()) return;
        setSelectedId(key.id); setFeedback("generated");
        setCatalog((previous) => previous?.scope === scope ? { scope, value: { ...previous.value, keys: [...previous.value.keys.filter((item) => item.id !== key.id), key] } } : previous);
      }}
      onFailure={(failure) => { if (current()) setNeedsRefresh(needsObservation(failure)); }}
      onSuccess={(result, focusOrigin) => success(dialog.kind === "generate" ? "generated" : "added", result, focusOrigin)} />}
  </section>;
}

export function SshKeyMutationDialog({ dialog, valid, t, onClose, onStart, onGenerated, onFailure, onSuccess }: {
  readonly dialog: Dialog; readonly valid: boolean; readonly t: Translator; readonly onClose: () => void;
  readonly onStart: () => void; readonly onFailure: (failure: SshKeyFailure) => void; readonly onSuccess: (result: MutationResult, focusOrigin: Element | undefined) => void;
  readonly onGenerated: (key: SshKeyView) => void;
}): JSX.Element {
  const [name, setName] = useState(""); const [comment, setComment] = useState("");
  const [encrypted, setEncrypted] = useState(true); const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState(""); const [pending, setPending] = useState(false);
  const [loadAfterGeneration, setLoadAfterGeneration] = useState(dialog.offerAgentLoad === true);
  const [addingGeneratedKey, setAddingGeneratedKey] = useState(false);
  const [error, setError] = useState<SshKeyFailure>();
  const form = useRef<HTMLFormElement>(null);
  const owner = useRef<{ abort: AbortController; pending: boolean } | undefined>(undefined);
  useLayoutEffect(() => {
    const next = { abort: new AbortController(), pending: false }; owner.current = next;
    const clear = (): void => { next.abort.abort(); setPassphrase(""); setConfirmation(""); };
    dialog.scope.abort.signal.addEventListener("abort", clear);
    return () => { clear(); if (owner.current === next) owner.current = undefined; dialog.scope.abort.signal.removeEventListener("abort", clear); };
  }, [dialog.scope]);
  useLayoutEffect(() => { if (!valid) { owner.current?.abort.abort(); setPassphrase(""); setConfirmation(""); } }, [valid]);
  const generate = dialog.kind === "generate";
  const passphraseValid = !encrypted || passphrase.length > 0 && (!generate || confirmation === passphrase);
  const submit = async (): Promise<void> => {
    const source = owner.current;
    if (!valid || !passphraseValid || source === undefined || source.pending || source.abort.signal.aborted || error !== undefined && needsObservation(error)) return;
    source.pending = true; setPending(true); setError(undefined); onStart();
    let secret = encrypted ? passphrase : undefined;
    setPassphrase(""); setConfirmation("");
    const signal = AbortSignal.any([source.abort.signal, dialog.scope.abort.signal]);
    const current = (): boolean => owner.current === source && !signal.aborted;
    const doc = form.current?.ownerDocument;
    const focusOrigin = doc?.activeElement;
    let focusMoved = focusOrigin == null || form.current?.contains(focusOrigin) !== true;
    const trackFocus = (event: FocusEvent): void => { if (event.target !== focusOrigin) focusMoved = true; };
    doc?.addEventListener("focusin", trackFocus);
    const releaseFocus = (): void => { doc?.removeEventListener("focusin", trackFocus); };
    signal.addEventListener("abort", releaseFocus, { once: true });
    try {
      let result: MutationResult;
      if (generate) {
        const key = await dialog.scope.api.generateSshKey({ name, comment, ...(secret === undefined ? {} : { passphrase: secret }) }, signal);
        if (!current()) return;
        onGenerated(key);
        result = { key };
        if (loadAfterGeneration) {
          setAddingGeneratedKey(true);
          try {
            await dialog.scope.api.addSshKeyToAgent(key.id, key.sha256Fingerprint, secret, signal);
            result = { key, agentAdded: true };
          } catch (cause) {
            // Generation is already confirmed. An agent failure must never
            // turn the form into a retry of that completed file mutation.
            result = { key, agentFailure: sshKeyFailure(cause) };
          }
        }
      } else {
        await dialog.scope.api.addSshKeyToAgent(dialog.key!.id, dialog.key!.sha256Fingerprint, secret, signal);
        result = {};
      }
      if (current()) onSuccess(result, focusMoved ? undefined : focusOrigin ?? undefined);
    } catch (cause) { if (current()) { const failure = sshKeyFailure(cause); setError(failure); onFailure(failure); } }
    finally { secret = undefined; releaseFocus(); signal.removeEventListener("abort", releaseFocus); if (current()) { source.pending = false; setPending(false); } }
  };
  return <Modal open ownerDocument={dialog.scope.document} title={t(generate ? "sshKeys.generate" : "sshKeys.addToAgent")} description={t("sshKeys.passphraseBody")} onClose={onClose} size="medium">
    <form ref={form} className="ssh-key-form" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void submit(); }}>
      {generate ? <><label className="field"><span>{t("sshKeys.name")}</span><input value={name} maxLength={100} placeholder="id_joko_ed25519" disabled={pending} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>{t("sshKeys.comment")}</span><input value={comment} maxLength={240} disabled={pending} onChange={(event) => setComment(event.target.value)} /></label></>
        : <div><strong>{dialog.key!.name}</strong><p className="ssh-key-fingerprint">{dialog.key!.sha256Fingerprint}</p></div>}
      <label className="check-row"><CheckboxControl checked={encrypted} disabled={pending} onChange={(event) => { setEncrypted(event.target.checked); setPassphrase(""); setConfirmation(""); }} /><span>{t(generate ? "sshKeys.encrypt" : "sshKeys.hasPassphrase")}</span></label>
      {encrypted ? <><label className="field"><span>{t("sshKeys.passphrase")}</span><input type="password" autoComplete="new-password" value={passphrase} disabled={pending || !valid} onChange={(event) => setPassphrase(event.target.value)} /></label>
        {generate && <label className="field"><span>{t("sshKeys.confirmPassphrase")}</span><input type="password" autoComplete="new-password" value={confirmation} disabled={pending || !valid} onChange={(event) => setConfirmation(event.target.value)} /></label>}</>
        : <p>{t(generate ? "sshKeys.unencrypted" : "sshKeys.noPassphrase")}</p>}
      {generate && <label className="check-row"><CheckboxControl checked={loadAfterGeneration} disabled={pending || !dialog.offerAgentLoad} onChange={(event) => setLoadAfterGeneration(event.target.checked)} /><span>{t("sshKeys.loadAfterGeneration")}</span></label>}
      {generate && !dialog.offerAgentLoad && <p>{t("sshKeys.loadLater")}</p>}
      {addingGeneratedKey && <p role="status">{t("sshKeys.addingGeneratedKey")}</p>}
      {!valid && <p role="alert">{t("sshKeys.error.key_changed")}</p>}
      {error !== undefined && <p role="alert">{t(`sshKeys.error.${error}`)}</p>}
      {error !== undefined && needsObservation(error) && <p>{t("sshKeys.inspectBeforeRetry")}</p>}
      <div className="ssh-key-actions"><Button onClick={onClose}>{t("common.close")}</Button><Button type="submit" tone="primary" disabled={pending || !valid || !passphraseValid || error !== undefined && needsObservation(error)}>{t(pending ? "common.working" : generate ? "sshKeys.generate" : "sshKeys.addToAgent")}</Button></div>
    </form>
  </Modal>;
}

function SshKeyDetails({ scope, selected, targets, t }: { readonly scope: Scope; readonly selected: SshKeyView; readonly targets: readonly TargetView[]; readonly t: Translator }): JSX.Element {
  const [publicKey, setPublicKey] = useState<string>(); const [readError, setReadError] = useState<SshKeyFailure>();
  const [targetId, setTargetId] = useState(targets[0]?.id ?? ""); const [hostId, setHostId] = useState("");
  const [hosts, setHosts] = useState<{ targetId: string; values: readonly RemoteHostView[]; ready: boolean }>({ targetId, values: [], ready: false });
  const [shell, setShell] = useState<"posix" | "powershell">("posix");
  const [command, setCommand] = useState<{ identity: string; value: string }>(); const [commandError, setCommandError] = useState<SshKeyFailure>();
  const [pending, setPending] = useState(false);
  const commandOwner = useRef<{ abort: AbortController; pending: boolean } | undefined>(undefined);
  const targetExists = targets.some((target) => target.id === targetId);
  const host = hosts.targetId === targetId ? hosts.values.find((value) => value.id === hostId) : undefined;
  const identity = JSON.stringify([selected.id, selected.sha256Fingerprint, targetId, targetExists, hostId, host?.revision.toString(), hosts.ready, shell]);
  const identityRef = useRef(identity); identityRef.current = identity;
  useLayoutEffect(() => {
    const next = { abort: new AbortController(), pending: false }; commandOwner.current = next; setPending(false); setCommandError(undefined);
    return () => { next.abort.abort(); if (commandOwner.current === next) commandOwner.current = undefined; };
  }, [scope, identity]);
  useEffect(() => {
    const abort = new AbortController(); const signal = AbortSignal.any([abort.signal, scope.abort.signal]);
    void scope.api.readSshPublicKey(selected.id, selected.sha256Fingerprint, signal).then((text) => { if (!signal.aborted) setPublicKey(text); })
      .catch((cause) => { if (!signal.aborted) setReadError(sshKeyFailure(cause)); });
    return () => abort.abort();
  }, [scope, selected.id, selected.sha256Fingerprint]);
  useEffect(() => {
    const abort = new AbortController(); const signal = AbortSignal.any([abort.signal, scope.abort.signal]);
    setHosts({ targetId, values: [], ready: false }); setHostId(""); setCommand(undefined); setCommandError(undefined);
    if (targetId !== "" && targetExists) void (async () => {
      try {
        for await (const values of scope.api.watchRemoteHosts(targetId, signal)) {
          if (signal.aborted) return;
          setHosts({ targetId, values, ready: true });
        }
        if (!signal.aborted) setHosts((value) => ({ ...value, ready: false }));
      } catch { if (!signal.aborted) { setHosts((value) => ({ ...value, ready: false })); setCommandError("unknown"); } }
    })();
    return () => abort.abort();
  }, [scope, targetId, targetExists]);
  const createCommand = async (): Promise<void> => {
    const owner = commandOwner.current;
    if (host === undefined || !hosts.ready || owner === undefined || owner.pending || owner.abort.signal.aborted || scope.abort.signal.aborted || !targetExists) return;
    const source = identity; owner.pending = true; setPending(true); setCommandError(undefined);
    const signal = AbortSignal.any([owner.abort.signal, scope.abort.signal]);
    const current = (): boolean => commandOwner.current === owner && !signal.aborted && identityRef.current === source;
    try {
      const text = await scope.api.getSshKeyInstallCommand({ keyId: selected.id, expectedFingerprint: selected.sha256Fingerprint, destination: { kind: "savedHost", targetId, hostId: host.id, expectedRevision: host.revision }, shell }, signal);
      if (current()) setCommand({ identity: source, value: text });
    } catch (cause) { if (current()) setCommandError(sshKeyFailure(cause)); }
    finally { if (current()) { owner.pending = false; setPending(false); } }
  };
  return <div className="ssh-key-detail"><h3>{t("sshKeys.publicKey")}</h3>
    {publicKey === undefined ? <p role={readError === undefined ? "status" : "alert"}>{readError === undefined ? t("common.loading") : t(`sshKeys.error.${readError}`)}</p>
      : <><textarea readOnly aria-label={t("sshKeys.publicKey")} value={publicKey} rows={3} /><SshCopyButton text={publicKey} scope={scope} sourceKey={selected.sha256Fingerprint} label={t("sshKeys.copyPublicKey")} t={t} /></>}
    <h3>{t("sshKeys.install")}</h3><p>{t("sshKeys.installBody")}</p>
    {targets.length === 0 ? <p>{t("sshKeys.noTargets")}</p> : <>
      <div className="ssh-key-install-fields"><label className="field"><span>{t("settings.remoteHosts.target")}</span><SelectControl value={targetId} onChange={(event) => setTargetId(event.target.value)}>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</SelectControl></label>
        <label className="field"><span>{t("sshKeys.host")}</span><SelectControl value={hostId} disabled={!hosts.ready} onChange={(event) => setHostId(event.target.value)}><option value="">{t("sshKeys.chooseHost")}</option>{hosts.values.map((value) => <option key={value.id} value={value.id}>{value.user}@{value.hostname}:{value.port}</option>)}</SelectControl></label>
        <label className="field"><span>{t("sshKeys.shell")}</span><SelectControl value={shell} onChange={(event) => setShell(event.target.value as typeof shell)}><option value="posix">POSIX</option><option value="powershell">PowerShell</option></SelectControl></label>
      </div><Button disabled={host === undefined || !hosts.ready || !targetExists || pending} onClick={() => { void createCommand(); }}>{t(pending ? "common.working" : "sshKeys.showCommand")}</Button>
      {commandError !== undefined && <p role="alert">{t(`sshKeys.error.${commandError}`)}</p>}
      {command?.identity === identity && hosts.ready && targetExists && <><textarea readOnly aria-label={t("sshKeys.installCommand")} value={command.value} rows={4} /><SshCopyButton text={command.value} scope={scope} sourceKey={identity} label={t("sshKeys.copyCommand")} t={t} /></>}
    </>}
  </div>;
}

export function SshCopyButton({ text, scope, sourceKey, label, t }: { readonly text: string; readonly scope: Scope; readonly sourceKey: string; readonly label: string; readonly t: Translator }): JSX.Element {
  const copy = useClipboardAction({ ownerKey: "ssh-key", sourceKey, ownerDocument: scope.document, connectionOwner: scope });
  return <div className="ssh-key-copy"><Button disabled={copy.pending || scope.abort.signal.aborted} onClick={(event) => copy.run(event.currentTarget.ownerDocument, async (context) => {
    scope.abort.signal.throwIfAborted(); await writeClipboardText(text, { ownerDocument: context.ownerDocument, signal: AbortSignal.any([context.signal, scope.abort.signal]) });
  })}><Copy aria-hidden="true" />{copy.state === "copied" ? t("sshKeys.copied") : label}</Button>{copy.state === "failed" && <span role="alert">{t("sshKeys.copyFailed")}</span>}</div>;
}

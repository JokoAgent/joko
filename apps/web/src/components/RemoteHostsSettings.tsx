import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Fingerprint, Link2, Pencil, Plug, PlugZap, RefreshCw, Server, ShieldX, Trash2 } from "lucide-react";

import type { AppController } from "../controller.js";
import type {
  AppSnapshot,
  RemoteHostCapabilitiesView,
  RemoteHostDraft,
  RemoteHostView
} from "../model.js";
import { randomUuid } from "../web-crypto.js";
import type { RunAction, Translator } from "./types.js";
import { Button, ErrorBanner, IconButton, Modal, ModalBackButton, Pill, SelectControl } from "./ui.js";
import { RemoteHostKeySetup } from "./RemoteHostKeySetup.js";
import type { KeyApi } from "./SshKeySettings.js";

const NO_CAPABILITIES: RemoteHostCapabilitiesView = {
  catalog: false,
  management: false,
  connectionControl: false,
  connectionTest: false,
  trustReset: false,
  commandExecution: false,
  processStreaming: false,
  fileTransfer: false,
  tcpForwarding: false
};

type RemoteHostApi = KeyApi & Pick<AppController, "getRemoteHostCapabilities" | "watchRemoteHosts" | "refreshRemoteHostCatalog" | "createRemoteHost" | "updateRemoteHost" | "deleteRemoteHost" | "connectRemoteHost" | "disconnectRemoteHost" | "testRemoteHostConnection" | "clearRemoteHostTrust" | "saveCredential" | "updateTarget">;
interface CatalogScope {
  readonly id: string;
  readonly abort: AbortController;
  readonly pending: Set<string>;
  ownerDocument?: Document;
}
interface CatalogState {
  readonly scope: CatalogScope;
  readonly hosts: readonly RemoteHostView[];
  readonly capabilities: RemoteHostCapabilitiesView;
  readonly capabilitiesReady: boolean;
  readonly streamReady: boolean;
  readonly loading: boolean;
  readonly error?: string;
}
interface HostEditorInstance {
  readonly id: number;
  readonly scope: CatalogScope;
  readonly api: RemoteHostApi;
  readonly targetId: string;
  readonly host?: RemoteHostView;
  readonly returnFocus: HTMLElement;
}
type PerformAction = (key: string, action: () => Promise<unknown>, after?: () => void) => void;

export function RemoteHostsSettings({ controller, snapshot, activeTargetId, showHeading = true, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly activeTargetId?: string;
  readonly runAction: RunAction;
  readonly showHeading?: boolean;
  readonly t: Translator;
}): JSX.Element {
  const targets = useMemo(() => snapshot.targets.filter((target) => !target.archived), [snapshot.targets]);
  const [selectedTargetId, setTargetId] = useState(() => preferredTargetId(targets, activeTargetId));
  const targetId = targets.some(target => target.id === selectedTargetId) ? selectedTargetId : preferredTargetId(targets, activeTargetId);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeScopeRef = useRef<CatalogScope | undefined>(undefined);
  const [occurrence, setOccurrence] = useState(0);
  const [editing, setEditing] = useState<HostEditorInstance>();
  const editorSequence = useRef(0);
  const bindingDrafts = useRef(new WeakMap<RemoteHostApi, Map<string, BindingDraft>>());
  const api = useMemo<RemoteHostApi>(() => ({
    listSshKeys: controller.listSshKeys,
    generateSshKey: controller.generateSshKey,
    addSshKeyToAgent: controller.addSshKeyToAgent,
    readSshPublicKey: controller.readSshPublicKey,
    getSshKeyInstallCommand: controller.getSshKeyInstallCommand,
    getRemoteHostCapabilities: controller.getRemoteHostCapabilities,
    watchRemoteHosts: controller.watchRemoteHosts,
    refreshRemoteHostCatalog: controller.refreshRemoteHostCatalog,
    createRemoteHost: controller.createRemoteHost,
    updateRemoteHost: controller.updateRemoteHost,
    deleteRemoteHost: controller.deleteRemoteHost,
    connectRemoteHost: controller.connectRemoteHost,
    disconnectRemoteHost: controller.disconnectRemoteHost,
    testRemoteHostConnection: controller.testRemoteHostConnection,
    clearRemoteHostTrust: controller.clearRemoteHostTrust,
    saveCredential: controller.saveCredential,
    updateTarget: controller.updateTarget
  }), [controller.listSshKeys, controller.generateSshKey, controller.addSshKeyToAgent, controller.readSshPublicKey, controller.getSshKeyInstallCommand, controller.getRemoteHostCapabilities, controller.watchRemoteHosts, controller.refreshRemoteHostCatalog, controller.createRemoteHost, controller.updateRemoteHost, controller.deleteRemoteHost, controller.connectRemoteHost, controller.disconnectRemoteHost, controller.testRemoteHostConnection, controller.clearRemoteHostTrust, controller.saveCredential, controller.updateTarget]);
  const scope = useMemo<CatalogScope>(() => ({ id: randomUuid(), abort: new AbortController(), pending: new Set() }), [api, targetId, occurrence, controller.state.connectionState, controller.state.route, controller.state.navigationRevision]);
  const emptyCatalog = (): CatalogState => ({ scope, hosts: [], capabilities: NO_CAPABILITIES, capabilitiesReady: false, streamReady: false, loading: targetId !== "" && controller.state.connectionState === "connected" });
  const [catalog, setCatalog] = useState<CatalogState>(emptyCatalog);
  const view = catalog.scope === scope ? catalog : emptyCatalog();
  const { hosts, capabilities, loading, error } = view;
  const ready = view.capabilitiesReady && view.streamReady && !scope.abort.signal.aborted;
  const target = targets.find((candidate) => candidate.id === targetId);
  const isCurrent = (owner: CatalogScope = scope): boolean => activeScopeRef.current === owner && !owner.abort.signal.aborted && rootRef.current?.isConnected === true && rootRef.current.ownerDocument === owner.ownerDocument;
  const tRef = useRef(t); tRef.current = t;
  if (!bindingDrafts.current.has(api)) bindingDrafts.current.set(api, new Map());
  const drafts = bindingDrafts.current.get(api)!;

  useLayoutEffect(() => {
    if (scope.abort.signal.aborted) { setOccurrence(value => value + 1); return; }
    activeScopeRef.current = scope;
    scope.ownerDocument = rootRef.current?.ownerDocument;
    const win = scope.ownerDocument?.defaultView;
    const retire = (): void => {
      scope.abort.abort();
      setCatalog(current => current.scope === scope ? { ...current, streamReady: false, loading: false } : current);
    };
    const resume = (): void => { if (activeScopeRef.current === scope) setOccurrence(value => value + 1); };
    win?.addEventListener("pagehide", retire);
    win?.addEventListener("pageshow", resume);
    return () => {
      scope.abort.abort();
      if (activeScopeRef.current === scope) activeScopeRef.current = undefined;
      win?.removeEventListener("pagehide", retire);
      win?.removeEventListener("pageshow", resume);
    };
  }, [scope]);
  useLayoutEffect(() => {
    if (!scope.abort.signal.aborted && scope.ownerDocument !== undefined && rootRef.current?.ownerDocument !== scope.ownerDocument) {
      scope.abort.abort(); setOccurrence(value => value + 1);
    }
  });
  useEffect(() => {
    setCatalog(emptyCatalog());
    if (targetId === "" || controller.state.connectionState !== "connected" || !isCurrent()) return;
    const update = (patch: Partial<CatalogState>): void => {
      if (isCurrent()) setCatalog(current => current.scope === scope ? { ...current, ...patch } : current);
    };
    const endStream = (): void => {
      if (!isCurrent()) return;
      update({ streamReady: false, loading: false, error: tRef.current("settings.remoteHosts.watchFailed") });
      scope.abort.abort();
    };
    void api.getRemoteHostCapabilities(targetId, scope.abort.signal).then(next => {
      update({ capabilities: next, capabilitiesReady: true });
    }).catch(() => {
      update({ loading: false, error: tRef.current("settings.remoteHosts.loadFailed") });
    });
    void (async () => {
      try {
        for await (const nextHosts of api.watchRemoteHosts(targetId, scope.abort.signal)) {
          if (!isCurrent()) return;
          update({ hosts: nextHosts, streamReady: true, loading: false });
        }
        endStream();
      } catch {
        endStream();
      }
    })();
  }, [scope]);

  const perform: PerformAction = (key, action, after) => {
    if (!isCurrent() || !ready || scope.pending.has(key)) return;
    scope.pending.add(key);
    setCatalog(current => ({ ...current, error: undefined }));
    void (async () => {
      try { await action(); if (isCurrent()) after?.(); }
      catch { if (isCurrent()) setCatalog(current => ({ ...current, error: tRef.current("settings.remoteHosts.actionFailed") })); }
      finally {
        scope.pending.delete(key);
        if (isCurrent()) setCatalog(current => ({ ...current }));
      }
    })();
  };
  const openEditor = (returnFocus: HTMLElement, host?: RemoteHostView): void => {
    if (isCurrent() && ready && capabilities.management) setEditing({ id: ++editorSequence.current, scope, api, targetId, host, returnFocus });
  };
  const editIsCurrent = (): boolean => editing !== undefined && isCurrent(editing.scope);

  return <div ref={rootRef} style={{ display: "contents" }}>
    {targets.length === 0 ? <>{showHeading && <SettingsHeading t={t} />}<section className="settings-card"><p className="muted">{t("settings.remoteHosts.noTargets")}</p></section></> : <>
    {showHeading && <SettingsHeading t={t} actions={<>
      <Button
        disabled={!ready || !capabilities.catalog || scope.pending.has("import")}
        title={!loading && !capabilities.catalog ? t("settings.remoteHosts.catalogUnavailable") : undefined}
        onClick={() => perform("import", () => api.refreshRemoteHostCatalog(targetId))}
      ><RefreshCw aria-hidden="true" />{t("settings.remoteHosts.refresh")}</Button>
      <Button tone="primary" disabled={!ready || !capabilities.management} title={!capabilities.management ? t("settings.remoteHosts.managementUnavailable") : undefined} onClick={(event) => openEditor(event.currentTarget)}>
        {t("settings.remoteHosts.add")}
      </Button>
    </>} />}
    {error !== undefined && <ErrorBanner message={error} onClose={() => setCatalog(current => ({ ...current, error: undefined }))} />}
    {!loading && !ready && <Button onClick={() => setOccurrence(value => value + 1)}>{t("settings.remoteHosts.reconnect")}</Button>}
    <section className="settings-card remote-host-target-card">
      <label className="field">
        <span>{t("settings.remoteHosts.target")}</span>
        <SelectControl value={targetId} onChange={(event) => { scope.abort.abort(); setTargetId(event.target.value); }}>
          {targets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </SelectControl>
      </label>
      {target !== undefined && <RemoteWorkspaceBinding
        key={scope.id}
        api={api}
        target={target}
        hosts={hosts}
        capabilities={capabilities}
        ready={ready}
        busy={scope.pending.has("workspace")}
        perform={perform}
        drafts={drafts}
        t={t}
      />}
    </section>
    {!loading && (!capabilities.catalog || !capabilities.management) && <p className="muted settings-unavailable-hint" role="status">{
      t(!capabilities.management ? "settings.remoteHosts.managementUnavailable" : "settings.remoteHosts.catalogUnavailable")
    }</p>}
    <section className="settings-card settings-list remote-host-list" aria-busy={loading}>
      {hosts.map((host) => <article key={host.id} className="remote-host-row">
        <div className="remote-host-row__identity">
          <Server aria-hidden="true" />
          <span>
            <strong>{host.id}</strong>
            <small>{host.user}@{host.hostname}:{host.port} · {t(`settings.remoteHosts.${host.authentication}`)}</small>
            {host.trust !== undefined && <small className="remote-host-fingerprint"><Fingerprint aria-hidden="true" />{host.trust.algorithm} · {host.trust.sha256Fingerprint}</small>}
            {host.status.failure !== undefined && <small className="remote-host-failure">{host.status.failure.code === "nodeKeyChanged" || host.status.failure.code === "nodeKeyUnavailable" ? t(`settings.remoteHosts.failure.${host.status.failure.code}`) : t("settings.remoteHosts.failure", { code: host.status.failure.code })}</small>}
          </span>
        </div>
        <div className="remote-host-row__actions">
          <Pill tone={host.status.state === "ready" ? "success" : host.status.state === "failed" ? "danger" : host.status.state === "connecting" || host.status.state === "authenticating" ? "warning" : "neutral"}>
            {t(`settings.remoteHosts.status.${host.status.state}`)}
          </Pill>
          {capabilities.connectionTest && <Button
            disabled={!ready || scope.pending.has(host.id) || host.status.state === "connecting" || host.status.state === "authenticating"}
            onClick={() => perform(
              host.id,
              () => api.testRemoteHostConnection(targetId, host.id, host.revision)
            )}
          ><PlugZap aria-hidden="true" />{t("settings.remoteHosts.test")}</Button>}
          {capabilities.connectionControl && <Button
            disabled={!ready || scope.pending.has(host.id) || host.status.state === "connecting" || host.status.state === "authenticating"}
            onClick={() => perform(
              host.id,
              () => host.status.state === "ready"
                ? api.disconnectRemoteHost(targetId, host.id, host.revision)
                : api.connectRemoteHost(targetId, host.id, host.revision)
            )}
          ><Plug aria-hidden="true" />{t(host.status.state === "ready" ? "settings.remoteHosts.disconnect" : "settings.remoteHosts.connect")}</Button>}
          {host.trust !== undefined && capabilities.trustReset && <IconButton
            label={t("settings.remoteHosts.clearTrust")}
            disabled={!ready || scope.pending.has(host.id)}
            onClick={() => perform(
              host.id,
              () => api.clearRemoteHostTrust(targetId, host.id, host.revision)
            )}
          ><ShieldX aria-hidden="true" /></IconButton>}
          {capabilities.management && <IconButton label={t("common.edit")} disabled={!ready || scope.pending.has(host.id)} onClick={(event) => openEditor(event.currentTarget, host)}><Pencil aria-hidden="true" /></IconButton>}
          {capabilities.management && <IconButton
            label={t("common.delete")}
            disabled={!ready || scope.pending.has(host.id) || target?.remoteWorkspace?.hostId === host.id}
            onClick={() => perform(host.id, () => api.deleteRemoteHost(targetId, host.id, host.revision))}
          ><Trash2 aria-hidden="true" /></IconButton>}
        </div>
      </article>)}
      {!loading && hosts.length === 0 && <p className="muted">{t("settings.remoteHosts.empty")}</p>}
    </section>
    </>}
    {editing !== undefined && <RemoteHostEditor
      key={editing.id}
      instance={editing}
      isCurrent={editIsCurrent}
      available={ready && capabilities.management && editIsCurrent()}
      credentials={snapshot.settings.credentials.filter((credential) => credential.kind === "sshPrivateKey")}
      onClose={() => setEditing(undefined)}
      t={t}
    />}
  </div>;
}

function SettingsHeading({ t, actions }: { readonly t: Translator; readonly actions?: JSX.Element }): JSX.Element {
  return <header className={actions === undefined ? "settings-section-heading" : "settings-section-heading settings-section-heading--with-actions"}><div className="settings-section-heading__copy"><h3>{t("settings.remoteHosts.title")}</h3><p>{t("settings.remoteHosts.body")}</p></div>{actions !== undefined && <div className="settings-section-heading__actions">{actions}</div>}</header>;
}

interface BindingDraft {
  readonly baseRevision: bigint;
  readonly hostId: string;
  readonly workspaceRoot: string;
  readonly dirty: boolean;
  readonly submitted?: { readonly kind: "serviceNode" } | { readonly kind: "remote"; readonly hostId: string; readonly workspaceRoot: string };
}

function RemoteWorkspaceBinding({ api, target, hosts, capabilities, ready, busy, perform, drafts, t }: {
  readonly api: RemoteHostApi;
  readonly target: AppSnapshot["targets"][number];
  readonly hosts: readonly RemoteHostView[];
  readonly capabilities: RemoteHostCapabilitiesView;
  readonly ready: boolean;
  readonly busy: boolean;
  readonly perform: PerformAction;
  readonly drafts: Map<string, BindingDraft>;
  readonly t: Translator;
}): JSX.Element {
  const bindable = useMemo(() => hosts.filter((host) => host.status.state === "ready" && host.trust !== undefined), [hosts]);
  const baseline = (): BindingDraft => ({ baseRevision: target.revision, hostId: target.remoteWorkspace?.hostId ?? bindable[0]?.id ?? "", workspaceRoot: target.remoteWorkspace?.workspaceRoot ?? "", dirty: false });
  const [draft, setDraft] = useState<BindingDraft>(() => drafts.get(target.id) ?? baseline());
  const updateDraft = (next: BindingDraft): void => { drafts.set(target.id, next); setDraft(next); };
  const { hostId, workspaceRoot } = draft;
  useEffect(() => {
    const applied = draft.submitted !== undefined && target.revision !== draft.baseRevision && (draft.submitted.kind === "serviceNode"
      ? target.remoteWorkspace === undefined
      : target.remoteWorkspace?.hostId === draft.submitted.hostId && target.remoteWorkspace.workspaceRoot === draft.submitted.workspaceRoot);
    if ((!draft.dirty && target.revision !== draft.baseRevision) || applied) updateDraft(baseline());
    else if (!draft.dirty && draft.hostId === "" && bindable[0] !== undefined) updateDraft({ ...draft, hostId: bindable[0].id });
  }, [target.revision, target.remoteWorkspace?.hostId, target.remoteWorkspace?.workspaceRoot, bindable, draft]);
  const transportsReady = capabilities.processStreaming && capabilities.fileTransfer;
  const conflict = draft.dirty && target.revision !== draft.baseRevision;
  const selectedReady = bindable.some(host => host.id === hostId);
  const submit = (workspaceLocation: NonNullable<BindingDraft["submitted"]>): void => {
    if (busy || conflict) return;
    perform("workspace", () => api.updateTarget(target.id, { workspaceLocation }, draft.baseRevision), () => updateDraft({ ...draft, dirty: true, submitted: workspaceLocation }));
  };
  return <div className="remote-workspace-binding">
    <div className="remote-workspace-binding__heading">
      <span><strong>{t("settings.remoteHosts.workspace")}</strong><small>{target.remoteWorkspace === undefined ? t("settings.remoteHosts.serviceNodeActive") : t("settings.remoteHosts.remoteActive")}</small></span>
      {target.remoteWorkspace !== undefined && <Button disabled={!ready || busy || conflict} onClick={() => submit({ kind: "serviceNode" })}>{t("settings.remoteHosts.useServiceNode")}</Button>}
    </div>
    <div className="remote-workspace-binding__fields">
      <label className="field"><span>{t("settings.remoteHosts.host")}</span><SelectControl disabled={busy} value={hostId} onChange={(event) => updateDraft({ ...draft, hostId: event.target.value, dirty: true, submitted: undefined })}><option value="">{t("settings.remoteHosts.selectHost")}</option>{hostId !== "" && !selectedReady && <option value={hostId} disabled>{hostId} · {t("settings.remoteHosts.hostUnavailable")}</option>}{bindable.map((host) => <option key={host.id} value={host.id}>{host.id}</option>)}</SelectControl></label>
      <label className="field"><span>{t("settings.remoteHosts.workspaceRoot")}</span><input disabled={busy} value={workspaceRoot} onChange={(event) => updateDraft({ ...draft, workspaceRoot: event.target.value, dirty: true, submitted: undefined })} placeholder="/home/user/project" /></label>
      <Button tone="primary" disabled={!ready || busy || conflict || !transportsReady || !selectedReady || workspaceRoot.trim() === ""} onClick={() => submit({ kind: "remote", hostId, workspaceRoot: workspaceRoot.trim() })}><Link2 aria-hidden="true" />{t("settings.remoteHosts.bind")}</Button>
    </div>
    {conflict && <p role="status">{t("settings.remoteHosts.projectChanged")} <Button disabled={busy} onClick={() => updateDraft(baseline())}>{t("settings.remoteHosts.reload")}</Button></p>}
    {!transportsReady && <p className="muted">{t("settings.remoteHosts.transportUnavailable")}</p>}
  </div>;
}

function RemoteHostEditor({ instance, isCurrent, available, credentials, onClose, t }: {
  readonly instance: HostEditorInstance;
  readonly isCurrent: () => boolean;
  readonly available: boolean;
  readonly credentials: AppSnapshot["settings"]["credentials"];
  readonly onClose: () => void;
  readonly t: Translator;
}): JSX.Element {
  const { host, targetId, api } = instance;
  const [draft, setDraft] = useState<RemoteHostDraft>(() => hostDraft(host));
  const [privateKey, setPrivateKey] = useState("");
  const [nodeKeyReady, setNodeKeyReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retired, setRetired] = useState(false);
  const [error, setError] = useState<string>();
  const pendingRef = useRef(false);
  const attemptRef = useRef<AbortController | undefined>(undefined);
  const formRef = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const retire = (): void => {
      attemptRef.current?.abort(); pendingRef.current = false;
      setSaving(false); setPrivateKey(""); setRetired(true);
    };
    if (instance.scope.abort.signal.aborted) retire();
    else instance.scope.abort.signal.addEventListener("abort", retire, { once: true });
    return () => { attemptRef.current?.abort(); instance.scope.abort.signal.removeEventListener("abort", retire); };
  }, [instance]);
  const valid = draft.id.trim() !== "" && draft.hostname.trim() !== "" && draft.user.trim() !== "" &&
    Number.isInteger(draft.port) && draft.port > 0 && draft.port <= 65_535 &&
    (draft.authentication === "systemAgent" || draft.authentication === "nodeKey" && nodeKeyReady || draft.authentication === "privateKey" && (privateKey.trim() !== "" || draft.credentialReferenceId !== undefined));
  const close = (): void => {
    attemptRef.current?.abort();
    if (isCurrent() && instance.returnFocus.isConnected && instance.returnFocus.ownerDocument === formRef.current?.ownerDocument) instance.returnFocus.focus({ preventScroll: true });
    onClose();
  };
  const save = (): void => {
    if (!available || retired || !isCurrent() || pendingRef.current || !valid) return;
    pendingRef.current = true;
    const attempt = new AbortController(); attemptRef.current = attempt;
    const current = (): boolean => !attempt.signal.aborted && attemptRef.current === attempt && isCurrent();
    setSaving(true); setError(undefined);
    void saveRemoteHostDraft({ controller: api, targetId, host, draft, privateKey, context: {
      signal: attempt.signal, isCurrent: current,
      onCredentialSaved: credentialReferenceId => {
        if (current()) { setDraft(value => ({ ...value, credentialReferenceId })); setPrivateKey(""); }
      }
    } }).then(() => { if (current()) close(); }).catch(() => {
      if (current()) setError(t("settings.remoteHosts.saveFailed"));
    }).finally(() => {
      if (attemptRef.current === attempt && !attempt.signal.aborted) { pendingRef.current = false; setSaving(false); }
    });
  };
  const disabled = saving || retired || !available;
  return <Modal open ownerDocument={instance.returnFocus.ownerDocument} restoreFocus={false} dismissOnBackdrop={!saving} title={t(host === undefined ? "settings.remoteHosts.addTitle" : "settings.remoteHosts.editTitle")} description={t("settings.remoteHosts.editorBody")} onClose={close} headerLeading={<ModalBackButton label={t("common.back")} onClick={close} />}>
    <form ref={formRef} className="settings-form remote-host-editor" aria-busy={saving} onSubmit={(event) => { event.preventDefault(); save(); }}>
      {retired && <p role="status">{t("settings.remoteHosts.editorRetired")}</p>}
      {error !== undefined && <ErrorBanner message={error} onClose={() => setError(undefined)} />}
      <fieldset disabled={disabled} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <div className="settings-form__grid">
        <label className="field"><span>{t("settings.remoteHosts.alias")}</span><input required disabled={host !== undefined} value={draft.id} maxLength={128} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} /></label>
        <label className="field"><span>{t("settings.remoteHosts.hostname")}</span><input required value={draft.hostname} maxLength={253} onChange={(event) => setDraft((current) => ({ ...current, hostname: event.target.value }))} /></label>
        <label className="field"><span>{t("settings.remoteHosts.port")}</span><input required type="number" min={1} max={65535} value={draft.port} onChange={(event) => setDraft((current) => ({ ...current, port: Number(event.target.value) }))} /></label>
        <label className="field"><span>{t("settings.remoteHosts.user")}</span><input required value={draft.user} maxLength={128} onChange={(event) => setDraft((current) => ({ ...current, user: event.target.value }))} /></label>
        <label className="field settings-form__wide"><span>{t("settings.remoteHosts.authentication")}</span><SelectControl value={draft.authentication} onChange={(event) => { setPrivateKey(""); setNodeKeyReady(false); setDraft((current) => ({ ...current, authentication: event.target.value as RemoteHostDraft["authentication"], credentialReferenceId: undefined, nodeKey: undefined })); }}><option value="systemAgent">{t("settings.remoteHosts.systemAgent")}</option><option value="nodeKey">{t("settings.remoteHosts.nodeKey")}</option><option value="privateKey">{t("settings.remoteHosts.privateKey")}</option></SelectControl></label>
        {draft.authentication === "nodeKey" && <RemoteHostKeySetup api={api} signal={instance.scope.abort.signal} ownerDocument={instance.returnFocus.ownerDocument} draft={draft} disabled={disabled} onValidityChange={setNodeKeyReady} onSelect={key => setDraft(value => ({ ...value, nodeKey: { id: key.id, expectedFingerprint: key.sha256Fingerprint } }))} t={t} />}
        {draft.authentication === "privateKey" && <>
          <label className="field settings-form__wide"><span>{t("settings.remoteHosts.savedKey")}</span><SelectControl value={draft.credentialReferenceId ?? ""} onChange={(event) => setDraft((current) => ({ ...current, credentialReferenceId: event.target.value || undefined }))}><option value="">{t("settings.remoteHosts.newKey")}</option>{draft.credentialReferenceId !== undefined && !credentials.some(credential => credential.id === draft.credentialReferenceId) && <option value={draft.credentialReferenceId}>{t("settings.remoteHosts.selectedKey")}</option>}{credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.name}</option>)}</SelectControl></label>
          <label className="field settings-form__wide"><span>{t("settings.remoteHosts.privateKeyValue")}</span><textarea value={privateKey} autoComplete="off" spellCheck={false} rows={6} onChange={(event) => setPrivateKey(event.target.value)} placeholder={draft.credentialReferenceId === undefined ? t("settings.remoteHosts.privateKeyRequired") : t("settings.remoteHosts.privateKeyOptional")} /></label>
        </>}
      </div>
      </fieldset>
      <div className="modal__actions"><Button type="submit" tone="primary" disabled={disabled || !valid}>{t("common.save")}</Button></div>
    </form>
  </Modal>;
}

export async function saveRemoteHostDraft(input: {
  readonly controller: Pick<AppController, "saveCredential" | "createRemoteHost" | "updateRemoteHost">;
  readonly targetId: string;
  readonly host?: Pick<RemoteHostView, "id" | "revision">;
  readonly draft: RemoteHostDraft;
  readonly privateKey: string;
  readonly context: {
    readonly signal: AbortSignal;
    readonly isCurrent: () => boolean;
    readonly onCredentialSaved: (referenceId: string) => void;
  };
}): Promise<RemoteHostView> {
  const assertCurrent = (): void => {
    if (input.context.signal.aborted || !input.context.isCurrent()) throw new DOMException("The remote host editor is no longer active.", "AbortError");
  };
  assertCurrent();
  let credentialReferenceId = input.draft.credentialReferenceId;
  if (input.draft.authentication === "privateKey" && input.privateKey.trim() !== "") {
    credentialReferenceId = `ssh-key-${randomUuid()}`;
    await input.controller.saveCredential({
      id: credentialReferenceId,
      name: `${input.draft.id.trim()} SSH key`,
      kind: "sshPrivateKey",
      providerId: "",
      secret: input.privateKey
    }, input.context.signal);
    assertCurrent();
    input.context.onCredentialSaved(credentialReferenceId);
  }
  const draft = {
    ...input.draft,
    nodeKey: input.draft.authentication === "nodeKey" ? input.draft.nodeKey : undefined,
    ...(input.draft.authentication === "privateKey"
      ? { credentialReferenceId }
      : { credentialReferenceId: undefined })
  };
  assertCurrent();
  return input.host === undefined
    ? input.controller.createRemoteHost(input.targetId, draft)
    : input.controller.updateRemoteHost(input.targetId, input.host.id, input.host.revision, draft);
}

function hostDraft(host: RemoteHostView | undefined): RemoteHostDraft {
  return host === undefined
    ? { id: "", hostname: "", port: 22, user: "", authentication: "systemAgent" }
    : {
        id: host.id,
        hostname: host.hostname,
        port: host.port,
        user: host.user,
        authentication: host.authentication,
        ...(host.nodeKey === undefined ? {} : { nodeKey: host.nodeKey }),
        ...(host.credentialReferenceId === undefined ? {} : { credentialReferenceId: host.credentialReferenceId })
      };
}

function preferredTargetId(targets: readonly AppSnapshot["targets"][number][], activeTargetId?: string): string {
  return targets.some((target) => target.id === activeTargetId) ? activeTargetId! : targets[0]?.id ?? "";
}

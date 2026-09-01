import { useEffect, useMemo, useState } from "react";
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

export function RemoteHostsSettings({ controller, snapshot, activeTargetId, runAction, showHeading = true, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly activeTargetId?: string;
  readonly runAction: RunAction;
  readonly showHeading?: boolean;
  readonly t: Translator;
}): JSX.Element {
  const targets = useMemo(() => snapshot.targets.filter((target) => !target.archived), [snapshot.targets]);
  const [targetId, setTargetId] = useState(() => preferredTargetId(targets, activeTargetId));
  const [hosts, setHosts] = useState<readonly RemoteHostView[]>([]);
  const [capabilities, setCapabilities] = useState<RemoteHostCapabilitiesView>(NO_CAPABILITIES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<RemoteHostView | "new">();
  const target = targets.find((candidate) => candidate.id === targetId);

  useEffect(() => {
    if (targets.some((candidate) => candidate.id === targetId)) return;
    setTargetId(preferredTargetId(targets, activeTargetId));
  }, [activeTargetId, targetId, targets]);

  useEffect(() => {
    if (targetId === "") {
      setHosts([]);
      setCapabilities(NO_CAPABILITIES);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError(undefined);
    void Promise.all([
      controller.getRemoteHostCapabilities(targetId, abort.signal),
      controller.listRemoteHosts(targetId, abort.signal)
    ]).then(([nextCapabilities, nextHosts]) => {
      if (abort.signal.aborted) return;
      setCapabilities(nextCapabilities ?? NO_CAPABILITIES);
      setHosts(nextHosts ?? []);
      setLoading(false);
    }).catch(() => {
      if (abort.signal.aborted) return;
      setLoading(false);
      setError(t("settings.remoteHosts.loadFailed"));
    });
    void (async () => {
      try {
        for await (const nextHosts of controller.watchRemoteHosts(targetId, abort.signal)) {
          if (!abort.signal.aborted) setHosts(nextHosts);
        }
      } catch {
        if (!abort.signal.aborted) setError(t("settings.remoteHosts.watchFailed"));
      }
    })();
    return () => abort.abort();
  }, [controller, targetId, t]);

  const replaceHost = (host: RemoteHostView): void => {
    setHosts((current) => [...current.filter((candidate) => candidate.id !== host.id), host]
      .sort((left, right) => left.id.localeCompare(right.id)));
  };
  const performHostAction = (
    key: string,
    action: () => Promise<RemoteHostView>,
    after?: (host: RemoteHostView) => void
  ): void => runAction(key, async () => {
    const host = await action();
    replaceHost(host);
    after?.(host);
  });

  if (targets.length === 0) {
    return <>{showHeading && <SettingsHeading t={t} />}<section className="settings-card"><p className="muted">{t("settings.remoteHosts.noTargets")}</p></section></>;
  }

  return <>
    {showHeading && <SettingsHeading t={t} actions={<>
      <Button
        disabled={!capabilities.catalog || loading}
        title={!loading && !capabilities.catalog ? t("settings.remoteHosts.catalogUnavailable") : undefined}
        onClick={() => runAction(`remote-host-refresh:${targetId}`, async () => {
          setHosts(await controller.refreshRemoteHostCatalog(targetId));
        })}
      ><RefreshCw aria-hidden="true" />{t("settings.remoteHosts.refresh")}</Button>
      <Button tone="primary" disabled={!capabilities.management} title={!capabilities.management ? t("settings.remoteHosts.managementUnavailable") : undefined} onClick={() => setEditing("new")}>
        {t("settings.remoteHosts.add")}
      </Button>
    </>} />}
    {error !== undefined && <ErrorBanner message={error} onClose={() => setError(undefined)} />}
    <section className="settings-card remote-host-target-card">
      <label className="field">
        <span>{t("settings.remoteHosts.target")}</span>
        <SelectControl value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          {targets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </SelectControl>
      </label>
      {target !== undefined && <RemoteWorkspaceBinding
        controller={controller}
        target={target}
        hosts={hosts}
        capabilities={capabilities}
        runAction={runAction}
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
            <small>{host.user}@{host.hostname}:{host.port} · {t(host.authentication === "privateKey" ? "settings.remoteHosts.privateKey" : "settings.remoteHosts.systemAgent")}</small>
            {host.trust !== undefined && <small className="remote-host-fingerprint"><Fingerprint aria-hidden="true" />{host.trust.algorithm} · {host.trust.sha256Fingerprint}</small>}
            {host.status.failure !== undefined && <small className="remote-host-failure">{t("settings.remoteHosts.failure", { code: host.status.failure.code })}</small>}
          </span>
        </div>
        <div className="remote-host-row__actions">
          <Pill tone={host.status.state === "ready" ? "success" : host.status.state === "failed" ? "danger" : host.status.state === "connecting" || host.status.state === "authenticating" ? "warning" : "neutral"}>
            {t(`settings.remoteHosts.status.${host.status.state}`)}
          </Pill>
          {capabilities.connectionTest && <Button
            disabled={host.status.state === "connecting" || host.status.state === "authenticating"}
            onClick={() => performHostAction(
              `remote-host-test:${targetId}:${host.id}`,
              () => controller.testRemoteHostConnection(targetId, host.id, host.revision)
            )}
          ><PlugZap aria-hidden="true" />{t("settings.remoteHosts.test")}</Button>}
          {capabilities.connectionControl && <Button
            disabled={host.status.state === "connecting" || host.status.state === "authenticating"}
            onClick={() => performHostAction(
              `remote-host-connect:${targetId}:${host.id}`,
              () => host.status.state === "ready"
                ? controller.disconnectRemoteHost(targetId, host.id, host.revision)
                : controller.connectRemoteHost(targetId, host.id, host.revision)
            )}
          ><Plug aria-hidden="true" />{t(host.status.state === "ready" ? "settings.remoteHosts.disconnect" : "settings.remoteHosts.connect")}</Button>}
          {host.trust !== undefined && capabilities.trustReset && <IconButton
            label={t("settings.remoteHosts.clearTrust")}
            onClick={() => performHostAction(
              `remote-host-trust:${targetId}:${host.id}`,
              () => controller.clearRemoteHostTrust(targetId, host.id, host.revision)
            )}
          ><ShieldX aria-hidden="true" /></IconButton>}
          {capabilities.management && <IconButton label={t("common.edit")} onClick={() => setEditing(host)}><Pencil aria-hidden="true" /></IconButton>}
          {capabilities.management && <IconButton
            label={t("common.delete")}
            disabled={target?.remoteWorkspace?.hostId === host.id}
            onClick={() => runAction(`remote-host-delete:${targetId}:${host.id}`, async () => {
              await controller.deleteRemoteHost(targetId, host.id, host.revision);
              setHosts((current) => current.filter((candidate) => candidate.id !== host.id));
            })}
          ><Trash2 aria-hidden="true" /></IconButton>}
        </div>
      </article>)}
      {!loading && hosts.length === 0 && <p className="muted">{t("settings.remoteHosts.empty")}</p>}
    </section>
    <RemoteHostEditor
      open={editing !== undefined}
      host={editing === "new" ? undefined : editing}
      targetId={targetId}
      credentials={snapshot.settings.credentials.filter((credential) => credential.kind === "sshPrivateKey")}
      controller={controller}
      onClose={() => setEditing(undefined)}
      onSaved={(host) => { replaceHost(host); setEditing(undefined); }}
      runAction={runAction}
      t={t}
    />
  </>;
}

function SettingsHeading({ t, actions }: { readonly t: Translator; readonly actions?: JSX.Element }): JSX.Element {
  return <header className={actions === undefined ? "settings-section-heading" : "settings-section-heading settings-section-heading--with-actions"}><div className="settings-section-heading__copy"><h3>{t("settings.remoteHosts.title")}</h3><p>{t("settings.remoteHosts.body")}</p></div>{actions !== undefined && <div className="settings-section-heading__actions">{actions}</div>}</header>;
}

function RemoteWorkspaceBinding({ controller, target, hosts, capabilities, runAction, t }: {
  readonly controller: AppController;
  readonly target: AppSnapshot["targets"][number];
  readonly hosts: readonly RemoteHostView[];
  readonly capabilities: RemoteHostCapabilitiesView;
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element {
  const bindable = useMemo(() => hosts.filter((host) => host.status.state === "ready" && host.trust !== undefined), [hosts]);
  const [hostId, setHostId] = useState(target.remoteWorkspace?.hostId ?? "");
  const [workspaceRoot, setWorkspaceRoot] = useState(target.remoteWorkspace?.workspaceRoot ?? "");
  useEffect(() => {
    setHostId(target.remoteWorkspace?.hostId ?? bindable[0]?.id ?? "");
    setWorkspaceRoot(target.remoteWorkspace?.workspaceRoot ?? "");
  }, [bindable, target.id, target.remoteWorkspace?.hostId, target.remoteWorkspace?.workspaceRoot]);
  const transportsReady = capabilities.processStreaming && capabilities.fileTransfer;
  return <div className="remote-workspace-binding">
    <div className="remote-workspace-binding__heading">
      <span><strong>{t("settings.remoteHosts.workspace")}</strong><small>{target.remoteWorkspace === undefined ? t("settings.remoteHosts.serviceNodeActive") : t("settings.remoteHosts.remoteActive")}</small></span>
      {target.remoteWorkspace !== undefined && <Button onClick={() => runAction(`remote-workspace-local:${target.id}`, () => controller.updateTarget(target.id, { workspaceLocation: { kind: "serviceNode" } }))}>{t("settings.remoteHosts.useServiceNode")}</Button>}
    </div>
    <div className="remote-workspace-binding__fields">
      <label className="field"><span>{t("settings.remoteHosts.host")}</span><SelectControl value={hostId} onChange={(event) => setHostId(event.target.value)}><option value="">{t("settings.remoteHosts.selectHost")}</option>{bindable.map((host) => <option key={host.id} value={host.id}>{host.id}</option>)}</SelectControl></label>
      <label className="field"><span>{t("settings.remoteHosts.workspaceRoot")}</span><input value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} placeholder="/home/user/project" /></label>
      <Button tone="primary" disabled={!transportsReady || hostId === "" || workspaceRoot.trim() === ""} onClick={() => runAction(`remote-workspace-bind:${target.id}`, () => controller.updateTarget(target.id, { workspaceLocation: { kind: "remote", hostId, workspaceRoot } }))}><Link2 aria-hidden="true" />{t("settings.remoteHosts.bind")}</Button>
    </div>
    {!transportsReady && <p className="muted">{t("settings.remoteHosts.transportUnavailable")}</p>}
  </div>;
}

function RemoteHostEditor({ open, host, targetId, credentials, controller, onClose, onSaved, runAction, t }: {
  readonly open: boolean;
  readonly host?: RemoteHostView;
  readonly targetId: string;
  readonly credentials: AppSnapshot["settings"]["credentials"];
  readonly controller: AppController;
  readonly onClose: () => void;
  readonly onSaved: (host: RemoteHostView) => void;
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element {
  const initial = hostDraft(host);
  const [draft, setDraft] = useState<RemoteHostDraft>(initial);
  const [privateKey, setPrivateKey] = useState("");
  useEffect(() => { setDraft(hostDraft(host)); setPrivateKey(""); }, [host, open]);
  const valid = draft.id.trim() !== "" && draft.hostname.trim() !== "" && draft.user.trim() !== "" &&
    Number.isInteger(draft.port) && draft.port > 0 && draft.port <= 65_535 &&
    (draft.authentication === "systemAgent" || privateKey.trim() !== "" || draft.credentialReferenceId !== undefined);
  const save = (): void => runAction(`remote-host-save:${targetId}:${draft.id}`, async () => {
    const saved = await saveRemoteHostDraft({ controller, targetId, host, draft, privateKey });
    setPrivateKey("");
    onSaved(saved);
  });
  return <Modal open={open} title={t(host === undefined ? "settings.remoteHosts.addTitle" : "settings.remoteHosts.editTitle")} description={t("settings.remoteHosts.editorBody")} onClose={onClose} headerLeading={<ModalBackButton label={t("common.back")} onClick={onClose} />}>
    <form className="settings-form remote-host-editor" onSubmit={(event) => { event.preventDefault(); if (valid) save(); }}>
      <div className="settings-form__grid">
        <label className="field"><span>{t("settings.remoteHosts.alias")}</span><input required disabled={host !== undefined} value={draft.id} maxLength={128} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} /></label>
        <label className="field"><span>{t("settings.remoteHosts.hostname")}</span><input required value={draft.hostname} maxLength={253} onChange={(event) => setDraft((current) => ({ ...current, hostname: event.target.value }))} /></label>
        <label className="field"><span>{t("settings.remoteHosts.port")}</span><input required type="number" min={1} max={65535} value={draft.port} onChange={(event) => setDraft((current) => ({ ...current, port: Number(event.target.value) }))} /></label>
        <label className="field"><span>{t("settings.remoteHosts.user")}</span><input required value={draft.user} maxLength={128} onChange={(event) => setDraft((current) => ({ ...current, user: event.target.value }))} /></label>
        <label className="field settings-form__wide"><span>{t("settings.remoteHosts.authentication")}</span><SelectControl value={draft.authentication} onChange={(event) => setDraft((current) => ({ ...current, authentication: event.target.value as RemoteHostDraft["authentication"], credentialReferenceId: undefined }))}><option value="systemAgent">{t("settings.remoteHosts.systemAgent")}</option><option value="privateKey">{t("settings.remoteHosts.privateKey")}</option></SelectControl></label>
        {draft.authentication === "privateKey" && <>
          <label className="field settings-form__wide"><span>{t("settings.remoteHosts.savedKey")}</span><SelectControl value={draft.credentialReferenceId ?? ""} onChange={(event) => setDraft((current) => ({ ...current, credentialReferenceId: event.target.value || undefined }))}><option value="">{t("settings.remoteHosts.newKey")}</option>{credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.name}</option>)}</SelectControl></label>
          <label className="field settings-form__wide"><span>{t("settings.remoteHosts.privateKeyValue")}</span><textarea value={privateKey} autoComplete="off" spellCheck={false} rows={6} onChange={(event) => setPrivateKey(event.target.value)} placeholder={draft.credentialReferenceId === undefined ? t("settings.remoteHosts.privateKeyRequired") : t("settings.remoteHosts.privateKeyOptional")} /></label>
        </>}
      </div>
      <div className="modal__actions"><Button type="submit" tone="primary" disabled={!valid}>{t("common.save")}</Button></div>
    </form>
  </Modal>;
}

export async function saveRemoteHostDraft(input: {
  readonly controller: Pick<AppController, "saveCredential" | "createRemoteHost" | "updateRemoteHost">;
  readonly targetId: string;
  readonly host?: Pick<RemoteHostView, "id" | "revision">;
  readonly draft: RemoteHostDraft;
  readonly privateKey: string;
}): Promise<RemoteHostView> {
  let credentialReferenceId = input.draft.credentialReferenceId;
  if (input.draft.authentication === "privateKey" && input.privateKey.trim() !== "") {
    credentialReferenceId = `ssh-key-${randomUuid()}`;
    await input.controller.saveCredential({
      id: credentialReferenceId,
      name: `${input.draft.id.trim()} SSH key`,
      kind: "sshPrivateKey",
      providerId: "",
      environmentName: "",
      secret: input.privateKey
    });
  }
  const draft = {
    ...input.draft,
    ...(input.draft.authentication === "privateKey"
      ? { credentialReferenceId }
      : { credentialReferenceId: undefined })
  };
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
        ...(host.credentialReferenceId === undefined ? {} : { credentialReferenceId: host.credentialReferenceId })
      };
}

function preferredTargetId(targets: readonly AppSnapshot["targets"][number][], activeTargetId?: string): string {
  return targets.some((target) => target.id === activeTargetId) ? activeTargetId! : targets[0]?.id ?? "";
}

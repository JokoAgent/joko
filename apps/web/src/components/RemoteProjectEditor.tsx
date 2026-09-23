import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { AppController } from "../controller.js";
import type { AppSnapshot, RemoteHostDirectoryListingView, RemoteHostView, RemoteTargetDraft, TargetView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, Modal, SelectControl } from "./ui.js";

interface HostOption {
  readonly key: string;
  readonly host: RemoteHostView;
  readonly targetName: string;
  readonly targetRevision: bigint;
}

interface HostCatalog {
  readonly owner: string;
  readonly options: readonly HostOption[];
  readonly loading: boolean;
  readonly error?: string;
}

interface BrowserState {
  readonly owner: string;
  readonly hostKey: string;
  readonly status: "loading" | "ready" | "error";
  readonly requestedPath: string;
  readonly listing?: RemoteHostDirectoryListingView;
  readonly error?: string;
}

interface MissingConfirmation {
  readonly owner: string;
  readonly hostKey: string;
  readonly draftVersion: number;
  readonly draft: RemoteTargetDraft;
}

export function RemoteProjectEditor({ open, controller, snapshot, initialBackendId, eligibleTargetIds,
  saving = false, error, onClose, onSave, onChooseExisting, restoreFocusFallback, t }: {
  readonly open: boolean;
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly initialBackendId?: string;
  readonly eligibleTargetIds: ReadonlySet<string>;
  readonly saving?: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onSave: (draft: RemoteTargetDraft) => void;
  readonly onChooseExisting: (targetId: string) => void;
  readonly restoreFocusFallback: () => HTMLElement | null;
  readonly t: Translator;
}): JSX.Element {
  const owner = remoteProjectOwner(controller);
  const [catalog, setCatalog] = useState<HostCatalog>();
  const [reload, setReload] = useState(0);
  const [selectedHostKey, setSelectedHostKey] = useState<string>();
  const [backendId, setBackendId] = useState("");
  const [mode, setMode] = useState<"existing" | "browse">("existing");
  const [path, setPath] = useState("");
  const [selectedExistingId, setSelectedExistingId] = useState<string>();
  const [browser, setBrowser] = useState<BrowserState>();
  const [inspecting, setInspecting] = useState(false);
  const [inspectionError, setInspectionError] = useState<string>();
  const [missing, setMissing] = useState<MissingConfirmation>();
  const formRef = useRef<HTMLFormElement>(null);
  const catalogAbortRef = useRef<AbortController | undefined>(undefined);
  const browserAbortRef = useRef<AbortController | undefined>(undefined);
  const inspectionAbortRef = useRef<AbortController | undefined>(undefined);
  const draftVersionRef = useRef(0);
  const wasConfirmingMissingRef = useRef(false);
  const backends = snapshot.backends.filter((backend) => backend.health !== "unavailable"
    && backend.capabilities.get("input.text")?.supported === true);
  const visibleCatalog = catalog?.owner === owner ? catalog : undefined;
  const selected = visibleCatalog?.options.find((option) => option.key === selectedHostKey);
  const visibleBrowser = browser !== undefined && browser.owner === owner && browser.hostKey === selectedHostKey ? browser : undefined;
  const visibleMissing = missing !== undefined && missing.owner === owner && missing.hostKey === selectedHostKey
    && missing.draftVersion === draftVersionRef.current ? missing : undefined;
  const busy = saving || inspecting;

  useLayoutEffect(() => {
    if (!open) { wasConfirmingMissingRef.current = false; return; }
    if (visibleMissing !== undefined) {
      wasConfirmingMissingRef.current = true;
      formRef.current?.querySelector<HTMLButtonElement>("[data-remote-project-missing-cancel]")?.focus({ preventScroll: true });
    } else if (wasConfirmingMissingRef.current) {
      wasConfirmingMissingRef.current = false;
      formRef.current?.querySelector<HTMLInputElement>("#remote-project-path")?.focus({ preventScroll: true });
    }
  }, [open, visibleMissing]);

  const isCurrent = (abort: AbortController, expectedOwner: string, hostKey?: string): boolean => {
    const form = formRef.current;
    return open && !abort.signal.aborted && remoteProjectOwner(controller) === expectedOwner
      && form?.isConnected === true && form.ownerDocument.defaultView !== null
      && !form.ownerDocument.defaultView.closed
      && (hostKey === undefined || selectedHostKey === hostKey);
  };
  const currentHost = (option: HostOption): boolean => {
    const target = controller.state.snapshot.targets.find((candidate) => candidate.id === option.host.targetId);
    return controller.state.connectionState === "connected" && target !== undefined
      && target.revision === option.targetRevision && option.host.status.state === "ready"
      && option.host.trust !== undefined;
  };
  const clearInspection = (): void => {
    draftVersionRef.current += 1;
    inspectionAbortRef.current?.abort();
    setInspecting(false);
    setInspectionError(undefined);
    setMissing(undefined);
  };
  const closeBrowser = (): void => {
    browserAbortRef.current?.abort();
    setBrowser(undefined);
  };
  const resetChoice = (): void => {
    clearInspection();
    closeBrowser();
    setPath("");
    setSelectedExistingId(undefined);
  };

  useEffect(() => {
    if (!open) return;
    const preferred = backends.some((backend) => backend.id === initialBackendId) ? initialBackendId : backends[0]?.id;
    setBackendId(preferred ?? "");
    setMode("existing");
    setSelectedHostKey(undefined);
    setCatalog(undefined);
    resetChoice();
  }, [open]);
  useEffect(() => {
    catalogAbortRef.current?.abort();
    browserAbortRef.current?.abort();
    inspectionAbortRef.current?.abort();
    setBrowser(undefined);
    setMissing(undefined);
    if (!open || owner === undefined) return;
    const abort = new AbortController();
    catalogAbortRef.current = abort;
    const sources = snapshot.targets;
    setCatalog({ owner, options: [], loading: true });
    void Promise.allSettled(sources.map(async (target) => {
      const [capabilities, hosts] = await Promise.all([
        controller.getRemoteHostCapabilities(target.id, abort.signal),
        controller.listRemoteHosts(target.id, abort.signal)
      ]);
      return { target, hosts: capabilities.processStreaming && capabilities.fileTransfer ? hosts : [] };
    })).then((results) => {
      if (!isCurrent(abort, owner)) return;
      const options = results.flatMap((result) => result.status === "fulfilled"
        ? result.value.hosts.filter((host) => host.targetId === result.value.target.id
          && host.status.state === "ready" && host.trust !== undefined).map((host) => ({
            key: remoteHostKey(host.targetId, host.id), host,
            targetName: result.value.target.name, targetRevision: result.value.target.revision
          })) : []);
      options.sort((left, right) => `${left.host.id} ${left.targetName}`.localeCompare(`${right.host.id} ${right.targetName}`));
      setCatalog({ owner, options, loading: false,
        error: results.some((result) => result.status === "rejected") ? t("remoteProject.catalogPartial") : undefined });
      setSelectedHostKey((current) => current ?? options[0]?.key);
    });
    return () => { abort.abort(); };
  }, [open, owner, reload]);
  useEffect(() => {
    browserAbortRef.current?.abort();
    inspectionAbortRef.current?.abort();
    setBrowser(undefined);
    setMissing(undefined);
    setInspecting(false);
  }, [owner, selectedHostKey]);
  useEffect(() => () => {
    catalogAbortRef.current?.abort();
    browserAbortRef.current?.abort();
    inspectionAbortRef.current?.abort();
  }, []);

  const selectHost = (key: string): void => {
    if (busy) return;
    resetChoice();
    setMode("existing");
    setSelectedHostKey(key || undefined);
  };
  const browsePath = (requestedPath: string): void => {
    if (owner === undefined || selected === undefined || !currentHost(selected) || busy) return;
    browserAbortRef.current?.abort();
    const abort = new AbortController();
    browserAbortRef.current = abort;
    const hostKey = selected.key;
    setBrowser({ owner, hostKey, requestedPath, status: "loading" });
    void controller.listRemoteHostDirectories(selected.host.targetId, selected.host.id,
      selected.targetRevision, selected.host.revision, requestedPath, abort.signal).then((listing) => {
      if (isCurrent(abort, owner, hostKey) && currentHost(selected)
        && listing.targetId === selected.host.targetId && listing.hostId === selected.host.id
        && listing.targetRevision === selected.targetRevision && listing.hostRevision === selected.host.revision) {
        setPath(listing.path);
        setSelectedExistingId(undefined);
        setBrowser({ owner, hostKey, requestedPath, status: "ready", listing });
      }
    }).catch((cause: unknown) => {
      if (isCurrent(abort, owner, hostKey)) setBrowser({ owner, hostKey, requestedPath, status: "error",
        error: cause instanceof Error ? cause.message : t("error.unexpected") });
    });
  };
  const openBrowse = (): void => {
    if (selected === undefined || busy) return;
    resetChoice();
    setMode("browse");
    browsePath("");
  };
  const existingTargets = selected === undefined ? [] : snapshot.targets.filter((target) => !target.archived
    && target.error === undefined && eligibleTargetIds.has(target.id)
    && target.remoteWorkspace?.hostTargetId === selected.host.targetId
    && target.remoteWorkspace.hostId === selected.host.id);
  const findExisting = (workspacePath: string): TargetView | undefined => existingTargets.find((target) =>
    target.remoteWorkspace?.workspaceRoot === workspacePath);
  const chooseExisting = (target: TargetView): void => {
    const current = controller.state.snapshot.targets.find((candidate) => candidate.id === target.id);
    if (owner !== undefined && selected !== undefined && remoteProjectOwner(controller) === owner && currentHost(selected)
      && current?.revision === target.revision && current.remoteWorkspace?.hostTargetId === selected.host.targetId
      && current.remoteWorkspace.hostId === selected.host.id && eligibleTargetIds.has(current.id)) onChooseExisting(current.id);
  };
  const addProject = (): void => {
    if (owner === undefined || selected === undefined || !currentHost(selected) || busy
      || !backends.some((backend) => backend.id === backendId)) return;
    const workspacePath = path.trim();
    if (!workspacePath.startsWith("/")) return;
    const existing = findExisting(workspacePath);
    if (existing !== undefined) { chooseExisting(existing); return; }
    inspectionAbortRef.current?.abort();
    const abort = new AbortController();
    inspectionAbortRef.current = abort;
    const hostKey = selected.key;
    const draftVersion = draftVersionRef.current;
    setInspecting(true);
    setInspectionError(undefined);
    setMissing(undefined);
    void controller.inspectRemoteHostDirectory(selected.host.targetId, selected.host.id,
      selected.targetRevision, selected.host.revision, workspacePath, abort.signal).then((inspection) => {
      if (!isCurrent(abort, owner, hostKey) || draftVersionRef.current !== draftVersion
        || !currentHost(selected)) return;
      if (inspection.targetId !== selected.host.targetId || inspection.hostId !== selected.host.id
        || inspection.targetRevision !== selected.targetRevision
        || inspection.hostRevision !== selected.host.revision) return;
      const canonicalExisting = findExisting(inspection.path);
      if (canonicalExisting !== undefined) { chooseExisting(canonicalExisting); return; }
      const draft: RemoteTargetDraft = { backendId, name: projectName(inspection.path),
        hostTargetId: selected.host.targetId, hostId: selected.host.id,
        expectedHostTargetRevision: selected.targetRevision, expectedHostRevision: selected.host.revision,
        workspacePath: inspection.path, createIfMissing: !inspection.exists };
      if (inspection.exists) onSave(draft);
      else setMissing({ owner, hostKey, draftVersion, draft });
    }).catch((cause: unknown) => {
      if (isCurrent(abort, owner, hostKey)) setInspectionError(cause instanceof Error ? cause.message : t("error.unexpected"));
    }).finally(() => {
      if (isCurrent(abort, owner, hostKey)) setInspecting(false);
    });
  };
  const handlePathKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      browsePath(path.trim());
    }
  };
  const valid = selected !== undefined && currentHost(selected) && path.trim().startsWith("/")
    && backends.some((backend) => backend.id === backendId);
  return <Modal open={open} title={t("remoteProject.title")} description={t("remoteProject.body")}
    size="large" initialFocus={() => formRef.current?.querySelector<HTMLElement>("[data-select-control='true']") ?? null}
    restoreFocusFallback={restoreFocusFallback}
    onClose={busy ? () => undefined : () => { resetChoice(); onClose(); }}>
    <form ref={formRef} className="settings-form" onSubmit={(event) => {
      event.preventDefault();
      if (valid && visibleMissing === undefined) addProject();
    }}>
      {visibleMissing !== undefined ? <>
        <p role="status">{t("remoteProject.missingBody")}</p>
        <p className="project-editor__browser-location"><strong>{visibleMissing.draft.workspacePath}</strong></p>
        {error !== undefined && <p role="alert" className="project-card__error">{error}</p>}
        <div className="modal__actions">
          <Button data-remote-project-missing-cancel="" disabled={saving} onClick={() => setMissing(undefined)}>{t("common.cancel")}</Button>
          <Button tone="primary" disabled={saving || selected === undefined || !currentHost(selected)} onClick={() => {
            if (owner !== undefined && selected !== undefined && remoteProjectOwner(controller) === owner && currentHost(selected)) onSave(visibleMissing.draft);
          }}>{saving ? t("common.working") : t("remoteProject.createDirectory")}</Button>
        </div>
      </> : <>
        <label className="field"><span>{t("settings.remoteHosts.host")}</span>
          <SelectControl value={selected?.key ?? ""} disabled={busy}
            onChange={(event) => selectHost(event.target.value)}>
            {selected === undefined && <option value="">{visibleCatalog?.loading === false ? t("remoteProject.chooseHost") : t("common.loading")}</option>}
            {visibleCatalog?.options.map((option) => <option key={option.key} value={option.key}>
              {option.host.id} · {option.host.user}@{option.host.hostname} · {option.targetName}
            </option>)}
          </SelectControl>
        </label>
        {visibleCatalog?.error && <p role="alert">{visibleCatalog.error}</p>}
        {visibleCatalog?.loading === false && visibleCatalog.options.length === 0
          && <p role="status">{t("remoteProject.noReadyHosts")}</p>}
        {(visibleCatalog?.error !== undefined || visibleCatalog?.loading === false && visibleCatalog.options.length === 0)
          && <div className="modal__actions"><Button disabled={busy} onClick={() => setReload((value) => value + 1)}>{t("common.retry")}</Button></div>}
        {selected !== undefined && <>
          <div className="remote-project-editor__modes" role="group" aria-label={t("remoteProject.mode")}>
            <Button tone={mode === "existing" ? "primary" : "secondary"} disabled={busy} onClick={() => {
              resetChoice(); setMode("existing");
            }}>{t("remoteProject.existingProjects")}</Button>
            <Button tone={mode === "browse" ? "primary" : "secondary"} disabled={busy} onClick={openBrowse}>{t("remoteProject.browse")}</Button>
          </div>
          {mode === "existing" ? <section className="remote-project-editor__existing" aria-label={t("remoteProject.existingProjects")}>
            {existingTargets.length === 0 ? <div className="project-editor__browser">
              <p role="status">{t("remoteProject.noExistingProjects")}</p>
              <Button disabled={busy} onClick={openBrowse}>{t("remoteProject.browse")}</Button>
            </div> : <ul className="project-editor__browser-list">{existingTargets.map((target) => <li key={target.id}>
              <button type="button" disabled={busy} aria-current={selectedExistingId === target.id ? "true" : undefined}
                onClick={() => { clearInspection(); setSelectedExistingId(target.id); setPath(target.remoteWorkspace!.workspaceRoot); }}
                onDoubleClick={() => chooseExisting(target)}>{target.name} · {target.remoteWorkspace?.workspaceRoot}</button>
            </li>)}</ul>}
          </section> : <div className="project-editor__browser">
            <p>{t("remoteProject.browseBody")}</p>
            <label className="field"><span>{t("settings.remoteHosts.workspaceRoot")}</span>
              <div className="project-editor__path"><input id="remote-project-path" required value={path} disabled={busy}
                placeholder="/home/user/project" onKeyDown={handlePathKey}
                onChange={(event) => { clearInspection(); setSelectedExistingId(undefined); setPath(event.target.value); }} />
                <Button disabled={busy} onClick={() => browsePath(path.trim())}>{t("remoteProject.refresh")}</Button></div>
            </label>
            <div className="project-editor__browser-location"><strong>{visibleBrowser?.listing?.path || visibleBrowser?.requestedPath || t("settings.remoteHosts.browseHome")}</strong></div>
            {visibleBrowser?.status === "loading" ? <p role="status">{t("common.loading")}</p>
              : visibleBrowser?.status === "error" ? <p role="alert">{visibleBrowser.error}</p>
              : <>
                {visibleBrowser?.listing?.directories.length === 0 && <p role="status">{t("settings.remoteHosts.browseEmpty")}</p>}
                <ul className="project-editor__browser-list">{visibleBrowser?.listing?.directories.map((entry) => <li key={entry.path}>
                  <button type="button" aria-current={path === entry.path ? "true" : undefined}
                    onClick={() => { clearInspection(); setSelectedExistingId(undefined); setPath(entry.path); }}
                    onDoubleClick={() => browsePath(entry.path)}>{entry.name}</button>
                </li>)}</ul>
                {visibleBrowser?.listing?.truncated && <p role="status">{t("settings.remoteHosts.browseTruncated")}</p>}
              </>}
            <div className="modal__actions">
              <Button disabled={busy || visibleBrowser?.status === "loading"} onClick={() => browsePath("")}>{t("settings.remoteHosts.browseHome")}</Button>
              <Button disabled={busy || visibleBrowser?.status === "loading" || visibleBrowser?.listing === undefined
                || visibleBrowser.listing.parentPath === visibleBrowser.listing.path}
                onClick={() => browsePath(visibleBrowser!.listing!.parentPath)}>{t("settings.remoteHosts.browseParent")}</Button>
            </div>
          </div>}
          {(error ?? inspectionError) !== undefined && <p role="alert" className="project-card__error">{error ?? inspectionError}</p>}
          <div className="modal__actions"><Button disabled={busy} onClick={() => { resetChoice(); onClose(); }}>{t("common.cancel")}</Button>
            <Button type="submit" tone="primary" disabled={!valid || busy}>{busy ? t("common.working") : t("remoteProject.add")}</Button></div>
        </>}
      </>}
    </form>
  </Modal>;
}

function remoteHostKey(targetId: string, hostId: string): string { return JSON.stringify([targetId, hostId]); }

function projectName(path: string): string { return path.split("/").filter(Boolean).at(-1) ?? path; }

function remoteProjectOwner(controller: AppController): string | undefined {
  const { activeProfile: profile, connectionState, route, snapshot, navigationRevision } = controller.state;
  if (profile === undefined || connectionState !== "connected" || route.kind !== "newSession") return undefined;
  return JSON.stringify([profile.id, profile.serverId, profile.deviceId, profile.origin,
    snapshot.generation.toString(), navigationRevision,
    snapshot.targets.map((target) => [target.id, target.revision.toString(), target.archived])]);
}

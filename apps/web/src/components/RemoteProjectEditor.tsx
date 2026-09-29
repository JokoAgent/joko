import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { AppController } from "../controller.js";
import type {
  AppSnapshot,
  DevicePeerDirectoryListingView,
  DevicePeerRouteIdentityView,
  DevicePeerTargetDraft,
  DevicePeerView,
  RemoteHostDirectoryListingView,
  RemoteHostView,
  RemoteTargetDraft,
  TargetView
} from "../model.js";
import type { Translator } from "./types.js";
import { Button, Modal, SelectControl } from "./ui.js";

interface SshOption {
  readonly kind: "ssh";
  readonly key: string;
  readonly host: RemoteHostView;
  readonly targetName: string;
  readonly targetRevision: bigint;
}

interface DevicePeerOption {
  readonly kind: "devicePeer";
  readonly key: string;
  readonly peer: DevicePeerView;
}

type RemoteOption = SshOption | DevicePeerOption;
export type RemoteProjectDraft = RemoteTargetDraft | DevicePeerTargetDraft;

interface RemoteCatalog {
  readonly owner: string;
  readonly options: readonly RemoteOption[];
  readonly loading: boolean;
  readonly error?: string;
}

interface BrowserState {
  readonly owner: string;
  readonly sourceKey: string;
  readonly status: "loading" | "ready" | "error";
  readonly requestedPath: string;
  readonly listing?: RemoteHostDirectoryListingView | DevicePeerDirectoryListingView;
  readonly error?: string;
}

interface DeviceRecentState {
  readonly owner: string;
  readonly sourceKey: string;
  readonly status: "loading" | "ready" | "error";
  readonly entries: readonly {
    readonly name: string;
    readonly path: string;
    readonly availability: "exists" | "missing";
  }[];
  readonly error?: string;
}

interface ExistingProjectItem {
  readonly key: string;
  readonly name: string;
  readonly path: string;
  readonly availability: "exists" | "missing";
  readonly target?: TargetView;
}

interface MissingConfirmation {
  readonly owner: string;
  readonly sourceKey: string;
  readonly draftVersion: number;
  readonly draft: RemoteProjectDraft;
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
  readonly onSave: (draft: RemoteProjectDraft) => void;
  readonly onChooseExisting: (targetId: string) => void;
  readonly restoreFocusFallback: () => HTMLElement | null;
  readonly t: Translator;
}): JSX.Element {
  const owner = remoteProjectOwner(controller);
  const [catalog, setCatalog] = useState<RemoteCatalog>();
  const [reload, setReload] = useState(0);
  const [recentReload, setRecentReload] = useState(0);
  const [selectedSourceKey, setSelectedSourceKey] = useState<string>();
  const [backendId, setBackendId] = useState("");
  const [mode, setMode] = useState<"existing" | "browse">("existing");
  const [path, setPath] = useState("");
  const [selectedExistingKey, setSelectedExistingKey] = useState<string>();
  const [browser, setBrowser] = useState<BrowserState>();
  const [deviceRecent, setDeviceRecent] = useState<DeviceRecentState>();
  const [inspecting, setInspecting] = useState(false);
  const [inspectionError, setInspectionError] = useState<string>();
  const [missing, setMissing] = useState<MissingConfirmation>();
  const formRef = useRef<HTMLFormElement>(null);
  const catalogAbortRef = useRef<AbortController | undefined>(undefined);
  const recentAbortRef = useRef<AbortController | undefined>(undefined);
  const browserAbortRef = useRef<AbortController | undefined>(undefined);
  const inspectionAbortRef = useRef<AbortController | undefined>(undefined);
  const draftVersionRef = useRef(0);
  const wasConfirmingMissingRef = useRef(false);
  const backends = snapshot.backends.filter((backend) => backend.health !== "unavailable"
    && backend.capabilities.get("input.text")?.supported === true);
  const visibleCatalog = catalog?.owner === owner ? catalog : undefined;
  const selected = visibleCatalog?.options.find((option) => option.key === selectedSourceKey);
  const visibleBrowser = browser !== undefined && browser.owner === owner && browser.sourceKey === selectedSourceKey ? browser : undefined;
  const visibleRecent = deviceRecent !== undefined && deviceRecent.owner === owner
    && deviceRecent.sourceKey === selectedSourceKey ? deviceRecent : undefined;
  const visibleMissing = missing !== undefined && missing.owner === owner && missing.sourceKey === selectedSourceKey
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

  const isCurrent = (abort: AbortController, expectedOwner: string, sourceKey?: string): boolean => {
    const form = formRef.current;
    return open && !abort.signal.aborted && remoteProjectOwner(controller) === expectedOwner
      && form?.isConnected === true && form.ownerDocument.defaultView !== null
      && !form.ownerDocument.defaultView.closed
      && (sourceKey === undefined || selectedSourceKey === sourceKey);
  };
  const currentSource = (option: RemoteOption): boolean => {
    if (controller.state.connectionState !== "connected" || remoteProjectOwner(controller) !== owner) return false;
    if (option.kind === "devicePeer") {
      return catalog?.owner === owner && catalog?.options.some((candidate) => candidate.kind === "devicePeer"
        && candidate.key === option.key && samePeerRoute(candidate.peer.route, option.peer.route)) === true;
    }
    const target = controller.state.snapshot.targets.find((candidate) => candidate.id === option.host.targetId);
    return target !== undefined && target.revision === option.targetRevision
      && option.host.status.state === "ready" && option.host.trust !== undefined;
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
    setSelectedExistingKey(undefined);
  };

  useEffect(() => {
    if (!open) return;
    const preferred = backends.some((backend) => backend.id === initialBackendId) ? initialBackendId : backends[0]?.id;
    setBackendId(preferred ?? "");
    setMode("existing");
    setSelectedSourceKey(undefined);
    setCatalog(undefined);
    setDeviceRecent(undefined);
    resetChoice();
  }, [open]);

  useEffect(() => {
    catalogAbortRef.current?.abort();
    recentAbortRef.current?.abort();
    browserAbortRef.current?.abort();
    inspectionAbortRef.current?.abort();
    setBrowser(undefined);
    setDeviceRecent(undefined);
    setMissing(undefined);
    if (!open || owner === undefined) return;
    const abort = new AbortController();
    catalogAbortRef.current = abort;
    const sources = snapshot.targets;
    setCatalog({ owner, options: [], loading: true });
    const hostCatalog = Promise.allSettled(sources.map(async (target) => {
      const [capabilities, hosts] = await Promise.all([
        controller.getRemoteHostCapabilities(target.id, abort.signal),
        controller.listRemoteHosts(target.id, abort.signal)
      ]);
      return { target, hosts: capabilities.processStreaming && capabilities.fileTransfer ? hosts : [] };
    }));
    const peerCatalog = controller.listDevicePeers(abort.signal).then(
      (peers) => ({ status: "fulfilled" as const, peers }),
      (cause: unknown) => ({ status: "rejected" as const, cause })
    );
    void Promise.all([hostCatalog, peerCatalog]).then(([hostResults, peerResult]) => {
      if (!isCurrent(abort, owner)) return;
      const sshOptions: SshOption[] = hostResults.flatMap((result) => result.status === "fulfilled"
        ? result.value.hosts.filter((host) => host.targetId === result.value.target.id
          && host.status.state === "ready" && host.trust !== undefined).map((host) => ({
            kind: "ssh", key: sshOptionKey(host.targetId, host.id), host,
            targetName: result.value.target.name, targetRevision: result.value.target.revision
          })) : []);
      sshOptions.sort((left, right) => `${left.host.id} ${left.targetName}`.localeCompare(`${right.host.id} ${right.targetName}`));
      const peerOptions: DevicePeerOption[] = peerResult.status === "fulfilled"
        ? peerResult.peers.map((peer) => ({ kind: "devicePeer", key: devicePeerOptionKey(peer.route), peer })) : [];
      const options: RemoteOption[] = [...sshOptions, ...peerOptions];
      setCatalog({ owner, options, loading: false,
        ...((hostResults.some((result) => result.status === "rejected") || peerResult.status === "rejected")
          ? { error: t("remoteProject.catalogPartial") } : {}) });
      setSelectedSourceKey((current) => current === undefined
        ? options[0]?.key
        : options.some((option) => option.key === current) ? current : undefined);
    });
    return () => { abort.abort(); };
  }, [open, owner, reload]);

  useEffect(() => {
    recentAbortRef.current?.abort();
    setDeviceRecent(undefined);
    if (!open || owner === undefined || selected?.kind !== "devicePeer" || !currentSource(selected)) return;
    const abort = new AbortController();
    recentAbortRef.current = abort;
    const sourceKey = selected.key;
    const route = selected.peer.route;
    setDeviceRecent({ owner, sourceKey, status: "loading", entries: [] });
    void controller.listDevicePeerRecentDirectories(route, abort.signal).then((entries) => {
      if (!isCurrent(abort, owner, sourceKey) || !currentSource(selected)) return;
      setDeviceRecent({ owner, sourceKey, status: "ready",
        entries: entries.map((entry) => ({ name: entry.name, path: entry.path, availability: entry.availability })) });
    }).catch((cause: unknown) => {
      if (isCurrent(abort, owner, sourceKey)) setDeviceRecent({ owner, sourceKey, status: "error", entries: [],
        error: cause instanceof Error ? cause.message : t("error.unexpected") });
    });
    return () => { abort.abort(); };
  }, [open, owner, selectedSourceKey, selected?.key, recentReload]);

  useEffect(() => {
    browserAbortRef.current?.abort();
    inspectionAbortRef.current?.abort();
    setBrowser(undefined);
    setMissing(undefined);
    setInspecting(false);
  }, [owner, selectedSourceKey]);
  useEffect(() => () => {
    catalogAbortRef.current?.abort();
    recentAbortRef.current?.abort();
    browserAbortRef.current?.abort();
    inspectionAbortRef.current?.abort();
  }, []);

  const selectSource = (key: string): void => {
    if (busy) return;
    resetChoice();
    setMode("existing");
    setSelectedSourceKey(key || undefined);
  };
  const browsePath = (requestedPath: string): void => {
    if (owner === undefined || selected === undefined || !currentSource(selected) || busy) return;
    browserAbortRef.current?.abort();
    const abort = new AbortController();
    browserAbortRef.current = abort;
    const sourceKey = selected.key;
    setBrowser({ owner, sourceKey, requestedPath, status: "loading" });
    const request = selected.kind === "ssh"
      ? controller.listRemoteHostDirectories(selected.host.targetId, selected.host.id,
        selected.targetRevision, selected.host.revision, requestedPath, abort.signal)
      : controller.listDevicePeerDirectories(selected.peer.route, requestedPath, abort.signal);
    void request.then((listing) => {
      if (!isCurrent(abort, owner, sourceKey) || !currentSource(selected) || !listingMatchesSource(listing, selected)) return;
      setPath(listing.path);
      setSelectedExistingKey(undefined);
      setBrowser({ owner, sourceKey, requestedPath, status: "ready", listing });
    }).catch((cause: unknown) => {
      if (isCurrent(abort, owner, sourceKey)) setBrowser({ owner, sourceKey, requestedPath, status: "error",
        error: cause instanceof Error ? cause.message : t("error.unexpected") });
    });
  };
  const openBrowse = (): void => {
    if (selected === undefined || busy) return;
    resetChoice();
    setMode("browse");
    browsePath("");
  };

  const boundTargets = selected === undefined ? [] : snapshot.targets.filter((target) => {
    if (target.archived || target.error !== undefined || !eligibleTargetIds.has(target.id)) return false;
    if (selected.kind === "ssh") return target.remoteWorkspace?.kind === "ssh"
      && target.remoteWorkspace.hostTargetId === selected.host.targetId
      && target.remoteWorkspace.hostId === selected.host.id;
    return target.remoteWorkspace?.kind === "device_peer"
      && target.remoteWorkspace.controllerDeviceId === controller.state.activeProfile?.deviceId
      && target.remoteWorkspace.targetDeviceId === selected.peer.route.targetDeviceId;
  });
  const findExisting = (workspacePath: string): TargetView | undefined => boundTargets.find((target) =>
    target.remoteWorkspace?.workspaceRoot === workspacePath);
  const existingItems: readonly ExistingProjectItem[] = selected?.kind === "devicePeer"
    ? (visibleRecent?.entries ?? []).map((entry) => {
        const target = findExisting(entry.path);
        return { key: `recent:${entry.path}`, name: target?.name ?? entry.name, path: entry.path,
          availability: entry.availability, ...(target === undefined ? {} : { target }) };
      })
    : boundTargets.map((target) => ({ key: `target:${target.id}`, name: target.name,
        path: target.remoteWorkspace!.workspaceRoot, availability: "exists" as const, target }));
  const chooseExisting = (target: TargetView): void => {
    const current = controller.state.snapshot.targets.find((candidate) => candidate.id === target.id);
    if (owner === undefined || selected === undefined || remoteProjectOwner(controller) !== owner
      || !currentSource(selected) || current?.revision !== target.revision || !eligibleTargetIds.has(current.id)) return;
    const boundToSource = selected.kind === "ssh"
      ? current.remoteWorkspace?.kind === "ssh"
        && current.remoteWorkspace.hostTargetId === selected.host.targetId
        && current.remoteWorkspace.hostId === selected.host.id
      : current.remoteWorkspace?.kind === "device_peer"
        && current.remoteWorkspace.controllerDeviceId === controller.state.activeProfile?.deviceId
        && current.remoteWorkspace.targetDeviceId === selected.peer.route.targetDeviceId;
    if (boundToSource) onChooseExisting(current.id);
  };
  const addProject = (explicitPath?: string): void => {
    if (owner === undefined || selected === undefined || !currentSource(selected) || busy
      || !backends.some((backend) => backend.id === backendId)) return;
    const workspacePath = (explicitPath ?? path).trim();
    if (!validPathForSource(selected, workspacePath)) return;
    const existing = findExisting(workspacePath);
    if (existing !== undefined) { chooseExisting(existing); return; }
    inspectionAbortRef.current?.abort();
    const abort = new AbortController();
    inspectionAbortRef.current = abort;
    const sourceKey = selected.key;
    const draftVersion = draftVersionRef.current;
    setInspecting(true);
    setInspectionError(undefined);
    setMissing(undefined);
    const request = selected.kind === "ssh"
      ? controller.inspectRemoteHostDirectory(selected.host.targetId, selected.host.id,
        selected.targetRevision, selected.host.revision, workspacePath, abort.signal)
      : controller.inspectDevicePeerDirectory(selected.peer.route, workspacePath, abort.signal);
    void request.then((inspection) => {
      if (!isCurrent(abort, owner, sourceKey) || draftVersionRef.current !== draftVersion
        || !currentSource(selected) || !inspectionMatchesSource(inspection, selected)) return;
      const canonicalExisting = findExisting(inspection.path);
      if (canonicalExisting !== undefined) { chooseExisting(canonicalExisting); return; }
      if (selected.kind === "devicePeer" && !("peer" in inspection)) return;
      if (selected.kind === "ssh" && !("hostId" in inspection)) return;
      if ("peer" in inspection && inspection.kind === "file") {
        setInspectionError(t("remoteProject.pathIsFile", { path: inspection.path }));
        return;
      }
      const missingDirectory = "hostId" in inspection ? !inspection.exists : inspection.kind === "missing";
      const draft: RemoteProjectDraft = selected.kind === "ssh"
        ? {
            backendId, name: projectName(inspection.path),
            hostTargetId: selected.host.targetId, hostId: selected.host.id,
            expectedHostTargetRevision: selected.targetRevision, expectedHostRevision: selected.host.revision,
            workspacePath: inspection.path, createIfMissing: missingDirectory
          }
        : {
            backendId, name: projectName(inspection.path), peer: { ...selected.peer.route },
            workspacePath: inspection.path, createIfMissing: missingDirectory
          };
      if (missingDirectory) setMissing({ owner, sourceKey, draftVersion, draft });
      else onSave(draft);
    }).catch((cause: unknown) => {
      if (isCurrent(abort, owner, sourceKey)) setInspectionError(cause instanceof Error ? cause.message : t("error.unexpected"));
    }).finally(() => {
      if (isCurrent(abort, owner, sourceKey)) setInspecting(false);
    });
  };
  const handlePathKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      browsePath(path.trim());
    }
  };
  const valid = selected !== undefined && currentSource(selected) && validPathForSource(selected, path.trim())
    && backends.some((backend) => backend.id === backendId);
  const sourceIsDevice = selected?.kind === "devicePeer";
  const recentLoading = sourceIsDevice && visibleRecent?.status === "loading";
  const recentError = sourceIsDevice && visibleRecent?.status === "error" ? visibleRecent.error : undefined;

  return <Modal open={open} title={t("remoteProject.title")} description={t("remoteProject.body")}
    size="large" initialFocus={() => formRef.current?.querySelector<HTMLElement>("[data-select-control='true']") ?? null}
    restoreFocusFallback={restoreFocusFallback}
    onClose={busy ? () => undefined : () => { resetChoice(); onClose(); }}>
    <form ref={formRef} className="settings-form" onSubmit={(event) => {
      event.preventDefault();
      if (valid && visibleMissing === undefined) addProject();
    }}>
      {visibleMissing !== undefined ? <>
        <p role="status">{t(sourceIsDevice ? "remoteProject.missingDeviceBody" : "remoteProject.missingBody")}</p>
        <p className="project-editor__browser-location"><strong>{visibleMissing.draft.workspacePath}</strong></p>
        {error !== undefined && <p role="alert" className="project-card__error">{error}</p>}
        <div className="modal__actions">
          <Button data-remote-project-missing-cancel="" disabled={saving} onClick={() => setMissing(undefined)}>{t("common.cancel")}</Button>
          <Button tone="primary" disabled={saving || selected === undefined || !currentSource(selected)} onClick={() => {
            if (owner !== undefined && selected !== undefined && remoteProjectOwner(controller) === owner && currentSource(selected)) onSave(visibleMissing.draft);
          }}>{saving ? t("common.working") : t("remoteProject.createDirectory")}</Button>
        </div>
      </> : <>
        <label className="field"><span>{t("remoteProject.target")}</span>
          <SelectControl value={selected?.key ?? ""} disabled={busy}
            onChange={(event) => selectSource(event.target.value)}>
            {selected === undefined && <option value="">{visibleCatalog?.loading === false ? t("remoteProject.chooseTarget") : t("common.loading")}</option>}
            {visibleCatalog?.options.some((option) => option.kind === "ssh") && <optgroup label={t("remoteProject.sshTargets")}>
              {visibleCatalog.options.filter((option): option is SshOption => option.kind === "ssh").map((option) => <option key={option.key} value={option.key}>
                {option.host.id} · {option.host.user}@{option.host.hostname} · {option.targetName}
              </option>)}
            </optgroup>}
            {visibleCatalog?.options.some((option) => option.kind === "devicePeer") && <optgroup label={t("remoteProject.deviceTargets")}>
              {visibleCatalog.options.filter((option): option is DevicePeerOption => option.kind === "devicePeer").map((option) => <option key={option.key} value={option.key}>
                {option.peer.name} · {option.peer.platform}
              </option>)}
            </optgroup>}
          </SelectControl>
        </label>
        {visibleCatalog?.error && <p role="alert">{visibleCatalog.error}</p>}
        {visibleCatalog?.loading === false && visibleCatalog.options.length === 0
          && <p role="status">{t("remoteProject.noReadyTargets")}</p>}
        {(visibleCatalog?.error !== undefined || visibleCatalog?.loading === false && visibleCatalog.options.length === 0)
          && <div className="modal__actions"><Button disabled={busy} onClick={() => setReload((value) => value + 1)}>{t("common.retry")}</Button></div>}
        {selected !== undefined && <>
          <div className="remote-project-editor__modes" role="group" aria-label={t("remoteProject.mode")}>
            <Button tone={mode === "existing" ? "primary" : "secondary"} disabled={busy} onClick={() => {
              resetChoice(); setMode("existing");
            }}>{t(sourceIsDevice ? "remoteProject.recentProjects" : "remoteProject.existingProjects")}</Button>
            <Button tone={mode === "browse" ? "primary" : "secondary"} disabled={busy} onClick={openBrowse}>{t("remoteProject.browse")}</Button>
          </div>
          {mode === "existing" ? <section className="remote-project-editor__existing"
            aria-label={t(sourceIsDevice ? "remoteProject.recentProjects" : "remoteProject.existingProjects")}>
            {recentLoading ? <div className="project-editor__browser"><p role="status">{t("common.loading")}</p></div>
              : recentError !== undefined ? <div className="project-editor__browser"><p role="alert">{recentError}</p>
                <Button disabled={busy} onClick={() => setRecentReload((value) => value + 1)}>{t("common.retry")}</Button></div>
              : existingItems.length === 0 ? <div className="project-editor__browser">
                <p role="status">{t("remoteProject.noExistingProjects")}</p>
                <Button disabled={busy} onClick={openBrowse}>{t("remoteProject.browse")}</Button>
              </div> : <ul className="project-editor__browser-list">{existingItems.map((item) => <li key={item.key}>
                <button type="button" disabled={busy} aria-current={selectedExistingKey === item.key ? "true" : undefined}
                  onClick={() => { clearInspection(); setSelectedExistingKey(item.key); setPath(item.path); }}
                  onDoubleClick={() => item.target === undefined ? addProject(item.path) : chooseExisting(item.target)}>
                  {item.name} · {item.path}{item.availability === "missing" ? ` · ${t("remoteProject.missing")}` : ""}
                </button>
              </li>)}</ul>}
          </section> : <div className="project-editor__browser">
            <p>{t(sourceIsDevice ? "remoteProject.browseDeviceBody" : "remoteProject.browseBody")}</p>
            <label className="field"><span>{t("settings.remoteHosts.workspaceRoot")}</span>
              <div className="project-editor__path"><input id="remote-project-path" required value={path} disabled={busy}
                placeholder={sourceIsDevice ? t("remoteProject.devicePathPlaceholder") : "/home/user/project"} onKeyDown={handlePathKey}
                onChange={(event) => { clearInspection(); setSelectedExistingKey(undefined); setPath(event.target.value); }} />
                <Button disabled={busy} onClick={() => browsePath(path.trim())}>{t("remoteProject.refresh")}</Button></div>
            </label>
            <div className="project-editor__browser-location"><strong>{visibleBrowser?.listing?.path || visibleBrowser?.requestedPath
              || t(sourceIsDevice ? "remoteProject.deviceHome" : "settings.remoteHosts.browseHome")}</strong></div>
            {visibleBrowser?.status === "loading" ? <p role="status">{t("common.loading")}</p>
              : visibleBrowser?.status === "error" ? <p role="alert">{visibleBrowser.error}</p>
              : <>
                {visibleBrowser?.listing?.directories.length === 0 && <p role="status">{t("settings.remoteHosts.browseEmpty")}</p>}
                <ul className="project-editor__browser-list">{visibleBrowser?.listing?.directories.map((entry) => <li key={entry.path}>
                  <button type="button" aria-current={path === entry.path ? "true" : undefined}
                    onClick={() => { clearInspection(); setSelectedExistingKey(undefined); setPath(entry.path); }}
                    onDoubleClick={() => browsePath(entry.path)}>{entry.name}</button>
                </li>)}</ul>
                {visibleBrowser?.listing?.truncated && <p role="status">{t("settings.remoteHosts.browseTruncated")}</p>}
              </>}
            <div className="modal__actions">
              <Button disabled={busy || visibleBrowser?.status === "loading"} onClick={() => browsePath("")}>{t(sourceIsDevice ? "remoteProject.deviceHome" : "settings.remoteHosts.browseHome")}</Button>
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

function sshOptionKey(targetId: string, hostId: string): string { return JSON.stringify(["ssh", targetId, hostId]); }

function devicePeerOptionKey(route: DevicePeerRouteIdentityView): string {
  return JSON.stringify(["devicePeer", route.targetDeviceId, route.relationId, route.targetDeviceRevision.toString(),
    route.relationRevision.toString(), route.routeGeneration.toString()]);
}

function samePeerRoute(left: DevicePeerRouteIdentityView, right: DevicePeerRouteIdentityView): boolean {
  return left.targetDeviceId === right.targetDeviceId && left.relationId === right.relationId
    && left.targetDeviceRevision === right.targetDeviceRevision && left.relationRevision === right.relationRevision
    && left.routeGeneration === right.routeGeneration;
}

function listingMatchesSource(
  listing: RemoteHostDirectoryListingView | DevicePeerDirectoryListingView,
  option: RemoteOption
): boolean {
  return option.kind === "ssh"
    ? "hostId" in listing && listing.targetId === option.host.targetId && listing.hostId === option.host.id
      && listing.targetRevision === option.targetRevision && listing.hostRevision === option.host.revision
    : "peer" in listing && samePeerRoute(listing.peer, option.peer.route);
}

function inspectionMatchesSource(
  inspection: Awaited<ReturnType<AppController["inspectRemoteHostDirectory"]>>
    | Awaited<ReturnType<AppController["inspectDevicePeerDirectory"]>>,
  option: RemoteOption
): boolean {
  return option.kind === "ssh"
    ? "hostId" in inspection && inspection.targetId === option.host.targetId && inspection.hostId === option.host.id
      && inspection.targetRevision === option.targetRevision && inspection.hostRevision === option.host.revision
    : "peer" in inspection && samePeerRoute(inspection.peer, option.peer.route);
}

function validPathForSource(option: RemoteOption, path: string): boolean {
  return option.kind === "ssh" ? path.startsWith("/") : absoluteDevicePath(path);
}

function absoluteDevicePath(path: string): boolean {
  return path.length > 0 && !/[\p{Cc}]/u.test(path)
    && (path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(path));
}

function projectName(path: string): string { return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path; }

function remoteProjectOwner(controller: AppController): string | undefined {
  const { activeProfile: profile, connectionState, route, snapshot, navigationRevision } = controller.state;
  if (profile === undefined || connectionState !== "connected" || route.kind !== "newSession") return undefined;
  return JSON.stringify([profile.id, profile.serverId, profile.deviceId, profile.origin,
    snapshot.generation.toString(), navigationRevision,
    snapshot.targets.map((target) => [target.id, target.revision.toString(), target.archived])]);
}

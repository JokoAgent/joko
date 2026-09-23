import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { AppController } from "../controller.js";
import type { AppSnapshot, ProjectDirectoryListingView, TargetDraft, TargetView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, CheckboxControl, Modal, SelectControl } from "./ui.js";

interface DirectoryBrowserState {
  readonly owner: string;
  readonly requestedPath: string;
  readonly status: "loading" | "ready" | "error";
  readonly listing?: ProjectDirectoryListingView;
  readonly error?: string;
}

export function ProjectEditor({ open, target, initialDirectory, controller, snapshot, t, saving = false, error, onClose, onSave }: {
  readonly open: boolean;
  readonly target?: TargetView;
  readonly initialDirectory?: string;
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly t: Translator;
  readonly saving?: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onSave: (draft: TargetDraft) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<TargetDraft>(() => emptyTargetDraft(snapshot));
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState<string>();
  const [browser, setBrowser] = useState<DirectoryBrowserState>();
  const pickerGenerationRef = useRef(0);
  const browserGenerationRef = useRef(0);
  const browserAbortRef = useRef<AbortController | undefined>(undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const currentRef = useRef({ open, controller });
  currentRef.current = { open, controller };
  const pickerOwner = localProjectPickerOwner(controller);
  const browserOwner = projectBrowserOwner(controller);
  useEffect(() => {
    pickerGenerationRef.current += 1;
    setPicking(false);
    setPickerError(undefined);
    if (!open) return;
    const workspace = snapshot.workspaces.find((candidate) => candidate.id === target?.workspaceId);
    setDraft(target === undefined ? {
      ...emptyTargetDraft(snapshot),
      ...(initialDirectory === undefined ? {} : {
        serverPath: initialDirectory,
        name: projectNameFromDirectory(initialDirectory)
      })
    } : {
      backendId: target.backendId, name: target.name, workspaceKind: workspace?.kind ?? "userProject",
      serverPath: workspace?.serverPath ?? "", createIfMissing: false
    });
  }, [open, target?.id, initialDirectory]);
  useEffect(() => {
    browserGenerationRef.current += 1;
    browserAbortRef.current?.abort();
    setBrowser(undefined);
  }, [open, target?.id, initialDirectory, browserOwner]);
  useEffect(() => {
    if (controller.state.connectionState === "connected") return;
    browserGenerationRef.current += 1;
    browserAbortRef.current?.abort();
    setBrowser((current) => current === undefined ? undefined : {
      ...current, status: "error", listing: undefined, error: t("projects.browseServiceDisconnected")
    });
  }, [controller.state.connectionState]);
  useEffect(() => () => { pickerGenerationRef.current += 1; browserGenerationRef.current += 1; browserAbortRef.current?.abort(); }, []);
  const closeBrowser = (): void => {
    browserGenerationRef.current += 1;
    browserAbortRef.current?.abort();
    setBrowser(undefined);
  };
  const browseServicePath = (path: string): void => {
    const owner = projectBrowserOwner(controller);
    const ownerDocument = formRef.current?.ownerDocument;
    if (owner === undefined || controller.state.connectionState !== "connected"
      || ownerDocument === undefined || !open || saving) return;
    browserAbortRef.current?.abort();
    const abort = new AbortController();
    browserAbortRef.current = abort;
    const generation = ++browserGenerationRef.current;
    setBrowser({ owner, requestedPath: path, status: "loading" });
    const ownsResult = (): boolean => {
      const current = currentRef.current;
      return browserGenerationRef.current === generation && !abort.signal.aborted && current.open
        && current.controller.state.connectionState === "connected"
        && formRef.current?.isConnected === true && formRef.current.ownerDocument === ownerDocument
        && ownerDocument.defaultView !== null && !ownerDocument.defaultView.closed
        && projectBrowserOwner(current.controller) === owner;
    };
    void controller.listProjectDirectories(path, abort.signal).then((listing) => {
      if (ownsResult()) setBrowser({ owner, requestedPath: path, status: "ready", listing });
    }).catch((cause: unknown) => {
      if (ownsResult()) setBrowser({ owner, requestedPath: path, status: "error",
        error: cause instanceof Error ? cause.message : t("error.unexpected") });
    });
  };
  const pickDirectory = async (): Promise<void> => {
    const owner = pickerOwner;
    const picker = window.jokoDesktop?.projects?.pickDirectory;
    if (owner === undefined || picker === undefined || picking || saving) return;
    const generation = ++pickerGenerationRef.current;
    setPicking(true);
    setPickerError(undefined);
    try {
      const result = await picker(owner);
      const current = currentRef.current;
      if (pickerGenerationRef.current !== generation || !current.open
        || !sameProjectPickerOwner(localProjectPickerOwner(current.controller), owner)) return;
      if (!result.cancelled) setDraft((value) => ({ ...value, serverPath: result.path,
        name: value.name.trim() === "" ? projectNameFromDirectory(result.path) : value.name }));
    } catch (cause) {
      const current = currentRef.current;
      if (pickerGenerationRef.current === generation && current.open
        && sameProjectPickerOwner(localProjectPickerOwner(current.controller), owner)) {
        setPickerError(cause instanceof Error ? cause.message : t("error.unexpected"));
      }
    } finally {
      if (pickerGenerationRef.current === generation) setPicking(false);
    }
  };
  const editing = target !== undefined;
  const visibleBrowser = browser?.owner === browserOwner ? browser : undefined;
  const disconnected = controller.state.connectionState !== "connected";
  const valid = draft.name.trim().length > 0 && draft.backendId.length > 0
    && (editing || draft.workspaceKind === "managedDialogue" || draft.serverPath.trim().length > 0);
  return <Modal open={open} title={editing ? t("projects.edit") : t("projects.new")}
    description={editing ? t("projects.editBody") : pickerOwner === undefined ? t("projects.createBody") : t("projects.createLocalBody")} size="large"
    onClose={saving ? () => undefined : () => { closeBrowser(); onClose(); }}>
    <form ref={formRef} className="settings-form" onSubmit={(event) => { event.preventDefault(); if (valid && !saving && visibleBrowser === undefined) onSave(draft); }}>
      {visibleBrowser !== undefined ? <div className="project-editor__browser">
        <p>{t("projects.browseServiceBody")}</p>
        <div className="project-editor__browser-location"><strong>{visibleBrowser.listing?.path || visibleBrowser.requestedPath || t("projects.browseServiceHome")}</strong></div>
        {disconnected ? <p role="alert">{t("projects.browseServiceDisconnected")}</p>
          : visibleBrowser.status === "loading" ? <p role="status">{t("common.loading")}</p>
          : visibleBrowser.status === "error" ? <p role="alert">{visibleBrowser.error}</p>
          : <>
            {visibleBrowser.listing?.directories.length === 0 && <p role="status">{t("projects.browseServiceEmpty")}</p>}
            <ul className="project-editor__browser-list">{visibleBrowser.listing?.directories.map((entry) => <li key={entry.path}>
              <button type="button" onClick={() => browseServicePath(entry.path)}>{entry.name}</button>
            </li>)}</ul>
            {visibleBrowser.listing?.truncated && <p role="status">{t("projects.browseServiceTruncated")}</p>}
          </>}
        <div className="modal__actions">
          <Button onClick={closeBrowser}>{t("common.cancel")}</Button>
          <Button disabled={disconnected || visibleBrowser.status === "loading"} onClick={() => browseServicePath("")}>{t("projects.browseServiceHome")}</Button>
          {visibleBrowser.listing !== undefined && <Button disabled={disconnected || visibleBrowser.status === "loading" || visibleBrowser.listing.parentPath === visibleBrowser.listing.path}
            onClick={() => browseServicePath(visibleBrowser.listing!.parentPath)}>{t("projects.browseServiceParent")}</Button>}
          {visibleBrowser.status === "error" && <Button disabled={disconnected} onClick={() => browseServicePath(visibleBrowser.requestedPath)}>{t("common.retry")}</Button>}
          <Button tone="primary" disabled={disconnected || visibleBrowser.status !== "ready" || visibleBrowser.listing === undefined}
            onClick={() => {
              const path = visibleBrowser.listing?.path;
              if (path === undefined || projectBrowserOwner(currentRef.current.controller) !== visibleBrowser.owner) return;
              setDraft((value) => ({ ...value, serverPath: path,
                name: value.name.trim() === "" ? projectNameFromDirectory(path) : value.name }));
              closeBrowser();
            }}>{t("projects.browseServiceChoose")}</Button>
        </div>
      </div> : <>
      <div className="settings-form__grid">
        <label className="field"><span>{t("projects.name")}</span><input required maxLength={120} value={draft.name} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
        <label className="field"><span>{t("controls.backend")}</span><SelectControl disabled={editing || saving} value={draft.backendId} onChange={(event) => setDraft((current) => ({ ...current, backendId: event.target.value }))}>{snapshot.backends.map((backend) => <option value={backend.id} key={backend.id}>{backend.name}</option>)}</SelectControl></label>
        {!editing && <>
          <label className="field"><span>{t("projects.workspaceType")}</span><SelectControl value={draft.workspaceKind} disabled={saving || picking} onChange={(event) => setDraft((current) => ({ ...current, workspaceKind: event.target.value as TargetDraft["workspaceKind"] }))}><option value="userProject">{t("projects.userProject")}</option><option value="managedDialogue">{t("projects.managed")}</option></SelectControl></label>
          {draft.workspaceKind === "userProject" && <div className="field settings-form__wide"><label htmlFor="project-editor-path">{t("projects.serverPath")}</label><div className="project-editor__path"><input id="project-editor-path" required value={draft.serverPath} disabled={saving || picking} onChange={(event) => setDraft((current) => ({ ...current, serverPath: event.target.value }))} placeholder={t("projects.serverPathPlaceholder")} />{pickerOwner !== undefined ? <Button disabled={saving || picking} onClick={() => { void pickDirectory(); }}>{picking ? t("common.working") : t("projects.browseLocal")}</Button> : <Button disabled={saving || picking || disconnected} onClick={() => browseServicePath(draft.serverPath.trim())}>{t("projects.browseService")}</Button>}</div><small>{pickerOwner === undefined ? t("projects.serverPathBrowseHelp") : t("projects.localPathHelp")}</small></div>}
          <label className="check-row settings-form__wide"><CheckboxControl checked={draft.createIfMissing} disabled={saving || draft.workspaceKind === "managedDialogue"} onChange={(event) => setDraft((current) => ({ ...current, createIfMissing: event.target.checked }))} /><span><strong>{t("projects.createMissing")}</strong><small>{t("projects.createMissingBody")}</small></span></label>
        </>}
      </div>
      {(error ?? pickerError) !== undefined && <p role="alert" className="project-card__error">{error ?? pickerError}</p>}
      <div className="modal__actions"><Button disabled={saving} onClick={() => { closeBrowser(); onClose(); }}>{t("common.cancel")}</Button><Button type="submit" tone="primary" disabled={!valid || saving || picking}>{saving ? t("common.working") : editing ? t("common.save") : t("projects.create")}</Button></div>
      </>}
    </form>
  </Modal>;
}

function projectBrowserOwner(controller: AppController): string | undefined {
  const { activeProfile: profile, route, snapshot, navigationRevision } = controller.state;
  if (profile === undefined) return undefined;
  return `${profile.id}\u0000${profile.serverId}\u0000${profile.deviceId}\u0000${profile.origin}\u0000${snapshot?.generation ?? 0}\u0000${route?.kind ?? ""}\u0000${navigationRevision ?? 0}`;
}

function emptyTargetDraft(snapshot: AppSnapshot): TargetDraft {
  return { backendId: snapshot.backends[0]?.id ?? "", name: "", workspaceKind: "userProject", serverPath: "", createIfMissing: false };
}

function projectNameFromDirectory(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

export type ProjectPickerOwner = { readonly profileId: string; readonly deviceId: string; readonly serverId: string; readonly origin: string };

export function localProjectPickerOwner(controller: AppController): ProjectPickerOwner | undefined {
  const profile = controller.state.activeProfile;
  const status = controller.state.managedOrchestratorStatus;
  if (controller.state.connectionState !== "connected" || profile?.managedLocal !== true || status?.state !== "ready"
    || window.jokoDesktop?.capabilities.includes("projects.directoryPicker") !== true
    || window.jokoDesktop.projects?.pickDirectory === undefined) return undefined;
  const connection = status.connection;
  return profile.id === connection.profileId && profile.deviceId === connection.deviceId
    && profile.serverId === connection.serverId && profile.origin === connection.origin
    ? { profileId: profile.id, deviceId: profile.deviceId, serverId: profile.serverId, origin: profile.origin }
    : undefined;
}

export function sameProjectPickerOwner(left: ProjectPickerOwner | undefined, right: ProjectPickerOwner): boolean {
  return left !== undefined && left.profileId === right.profileId && left.deviceId === right.deviceId
    && left.serverId === right.serverId && left.origin === right.origin;
}

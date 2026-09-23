import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Archive, FolderKanban, FolderPlus, Menu, Pencil, Pin, Plus, ScanSearch, Shield, ShieldAlert, Trash2 } from "lucide-react";
import type { AppController } from "../controller.js";
import type { AppSnapshot, ExtraDirectoryView, SessionView, TargetDraft, TargetView, WorkspaceView } from "../model.js";
import type { WorktreeRemovalPreflightSummary } from "../worktree-removal-preflight.js";
import { sidebarOwnerLayoutFor } from "../sidebar-layout.js";
import { backendSupportsResourceDiscovery } from "../resource-capabilities.js";
import type { RunAction, Translator } from "./types.js";
import { Button, IconButton, Modal, Pill, StatusDot, cx, CheckboxControl, SelectControl } from "./ui.js";
import { WorktreeRemovalWarnings } from "./SessionDialogs.js";

export interface ProjectCreationRequest {
  readonly requestId: number;
  readonly ownerDocument: Document;
  readonly profileId: string;
  readonly serverId: string;
  readonly connectionGeneration: bigint;
  readonly sourceNavigationRevision: number;
}

export function ProjectsPage({ controller, snapshot, focusProjectId, createRequest, onCreateRequestConsumed, t, runAction, onOpenNavigation, prepareSessionRemoval }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly focusProjectId?: string;
  readonly createRequest?: ProjectCreationRequest;
  readonly onCreateRequestConsumed?: (requestId: number) => void;
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onOpenNavigation: () => void;
  readonly prepareSessionRemoval: (sessions: readonly SessionView[]) => Promise<WorktreeRemovalPreflightSummary | undefined>;
}): JSX.Element {
  const [showArchived, setShowArchived] = useState(false);
  const [editor, setEditor] = useState<TargetView | "new">();
  const [trustWorkspace, setTrustWorkspace] = useState<WorkspaceView>();
  const [deleteTarget, setDeleteTarget] = useState<TargetView>();
  const [extraWorkspace, setExtraWorkspace] = useState<WorkspaceView>();
  const [removeExtra, setRemoveExtra] = useState<ExtraDirectoryView>();
  const [archivePendingIds, setArchivePendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const archivePendingRef = useRef(new Set<string>());
  const latestControllerRef = useRef(controller);
  latestControllerRef.current = controller;
  const archiveScopeRef = useRef<object | undefined>(undefined);
  const archiveFocusRef = useRef<{
    readonly scope: object | undefined;
    readonly targetId: string;
    readonly archived: boolean;
    ready: boolean;
    readonly cancel: () => void;
    readonly complete: () => void;
  } | undefined>(undefined);
  const pageRef = useRef<HTMLElement>(null);
  const consumedCreateRequestIdRef = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (createRequest === undefined || consumedCreateRequestIdRef.current === createRequest.requestId) return;
    consumedCreateRequestIdRef.current = createRequest.requestId;
    onCreateRequestConsumed?.(createRequest.requestId);
    const page = pageRef.current;
    const ownerDocument = createRequest.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const profile = controller.state.activeProfile;
    const navigationRevision = controller.state.navigationRevision ?? 0;
    if (page === null || !page.isConnected || page.ownerDocument !== ownerDocument
      || ownerWindow === null || ownerWindow.closed || ownerDocument.visibilityState !== "visible" || !ownerDocument.hasFocus()
      || ownerDocument.body.classList.contains("modal-open") || ownerDocument.body.dataset.appShortcutRecording === "1"
      || ownerDocument.querySelector("[data-gamepad-preview]") !== null
      || controller.state.connectionState !== "connected" || profile?.id !== createRequest.profileId || profile.serverId !== createRequest.serverId
      || snapshot.generation !== createRequest.connectionGeneration || controller.state.snapshot.generation !== createRequest.connectionGeneration
      || navigationRevision < createRequest.sourceNavigationRevision || navigationRevision > createRequest.sourceNavigationRevision + 1) return;
    setEditor("new");
  }, [controller, createRequest, onCreateRequestConsumed, snapshot.generation]);
  useLayoutEffect(() => {
    const scope = {};
    archiveScopeRef.current = scope;
    return () => {
      if (archiveScopeRef.current === scope) archiveScopeRef.current = undefined;
      if (archiveFocusRef.current?.scope === scope) archiveFocusRef.current.cancel();
    };
  }, [controller.state.activeProfile, controller.state.connectionState, snapshot.generation]);
  useLayoutEffect(() => {
    const request = archiveFocusRef.current;
    if (request === undefined) return;
    if (archiveScopeRef.current !== request.scope || showArchived === request.archived) request.cancel();
    else if (request.ready && snapshot.targets.some((target) => target.id === request.targetId && target.archived === request.archived)) request.complete();
  });
  const projectRefs = useRef(new Map<string, HTMLElement>());
  const archiveOperationKey = (targetId: string): string => JSON.stringify([
    controller.state.activeProfile?.serverId, controller.state.activeProfile?.id, targetId
  ]);
  const toggleArchived = (target: TargetView, origin: HTMLButtonElement): void => {
    const operationKey = archiveOperationKey(target.id);
    if (archivePendingRef.current.has(operationKey)) return;
    const profile = controller.state.activeProfile;
    const scope = archiveScopeRef.current;
    archiveFocusRef.current?.cancel();
    const ownerDocument = origin.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    let frame: number | undefined;
    const ownsFocus = (): boolean => ownerDocument.activeElement === origin
      || ownerDocument.activeElement === ownerDocument.body || ownerDocument.activeElement === null;
    const request = {
      scope, targetId: target.id, archived: !target.archived, ready: false,
      cancel: (): void => {
        if (frame !== undefined) ownerWindow?.cancelAnimationFrame(frame);
        ownerDocument.removeEventListener("focusin", onFocus, true);
        ownerDocument.removeEventListener("pointerdown", onPointer, true);
        ownerWindow?.removeEventListener("blur", request.cancel);
        ownerWindow?.removeEventListener("pagehide", request.cancel);
        if (archiveFocusRef.current === request) archiveFocusRef.current = undefined;
      },
      complete: (): void => {
        if (frame !== undefined || ownerWindow === null) return;
        frame = ownerWindow.requestAnimationFrame(() => {
          const shouldRestore = ownsFocus() && ownerDocument.visibilityState !== "hidden";
          request.cancel();
          if (!shouldRestore) return;
          const next = pageRef.current?.querySelector<HTMLButtonElement>(".project-card [data-project-archive-action]:not(:disabled)")
            ?? pageRef.current?.querySelector<HTMLButtonElement>(".projects-toolbar [role='radio'][aria-checked='true']");
          if (next?.isConnected && !next.disabled) next.focus({ preventScroll: true });
        });
      }
    };
    const onFocus = (): void => { if (!ownsFocus()) request.cancel(); };
    const onPointer = (event: globalThis.PointerEvent): void => { if (!(event.target instanceof Node) || !origin.contains(event.target)) request.cancel(); };
    archiveFocusRef.current = request;
    ownerDocument.addEventListener("focusin", onFocus, true);
    ownerDocument.addEventListener("pointerdown", onPointer, true);
    ownerWindow?.addEventListener("blur", request.cancel);
    ownerWindow?.addEventListener("pagehide", request.cancel);
    archivePendingRef.current.add(operationKey);
    setArchivePendingIds(new Set(archivePendingRef.current));
    runAction(`project-archive:${target.id}`, async () => {
      try {
        const desiredArchived = !target.archived;
        const authoritativeTarget = await controller.archiveTarget(target.id, desiredArchived);
        if (authoritativeTarget === undefined || authoritativeTarget.archived !== desiredArchived) {
          request.cancel();
          return;
        }
        request.ready = true;
        const latestController = latestControllerRef.current;
        const latest = latestController.state;
        if (target.archived && scope !== undefined && archiveScopeRef.current === scope
          && profile !== undefined && latest.connectionState === "connected" && latest.activeProfile === profile) {
          const layout = sidebarOwnerLayoutFor(latest.preferences.sidebarOwnerLayouts, profile.serverId);
          if (layout.projectFilter !== "all" && !layout.projectFilter.includes(target.id)) {
            await latestController.setSidebarOwnerLayout({ projectFilter: [...layout.projectFilter, target.id] });
          }
        }
      } catch (error) {
        if (!request.ready) request.cancel();
        throw error;
      } finally {
        archivePendingRef.current.delete(operationKey);
        setArchivePendingIds(new Set(archivePendingRef.current));
      }
    });
  };
  useEffect(() => {
    if (focusProjectId === undefined) return;
    const target = snapshot.targets.find((candidate) => candidate.id === focusProjectId);
    if (target !== undefined && target.archived !== showArchived) {
      setShowArchived(target.archived);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const card = projectRefs.current.get(focusProjectId);
      card?.scrollIntoView({ block: "center", behavior: "smooth" });
      card?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusProjectId, showArchived, snapshot.targets]);
  const targets = snapshot.targets.filter((target) => target.archived === showArchived);
  return <main ref={pageRef} className="route-page projects-page">
    <header className="route-header">{!controller.state.preferences.navigationOpen && <IconButton className="mobile-panel-toggle" label={t("a11y.openNavigation")} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>}<div><p className="eyebrow">{t("projects.eyebrow")}</p><h1>{t("nav.projects")}</h1><p>{t("projects.subtitle")}</p></div><Button tone="primary" onClick={() => setEditor("new")}><FolderPlus aria-hidden="true" />{t("projects.new")}</Button></header>
    <div className="projects-toolbar"><div className="segmented" role="radiogroup" aria-label={t("projects.filter")}><button type="button" role="radio" aria-checked={!showArchived} className={!showArchived ? "segmented__item is-active" : "segmented__item"} onClick={() => setShowArchived(false)}>{t("projects.active")}</button><button type="button" role="radio" aria-checked={showArchived} className={showArchived ? "segmented__item is-active" : "segmented__item"} onClick={() => setShowArchived(true)}>{t("nav.archived")}</button></div></div>
    <section className="project-card-grid">{targets.map((target) => {
      const workspace = snapshot.workspaces.find((candidate) => candidate.id === target.workspaceId);
      const backend = snapshot.backends.find((candidate) => candidate.id === target.backendId);
      const directories = snapshot.extraDirectories.filter((directory) => directory.workspaceId === workspace?.id);
      const taskCount = snapshot.sessions.filter((session) => session.projectId === target.id).length;
      const resourceCount = snapshot.resources.filter((resource) => resource.targetId === target.id).length;
      const resourceDiscoverySupported = backendSupportsResourceDiscovery(backend);
      return <article ref={(node) => { if (node === null) projectRefs.current.delete(target.id); else projectRefs.current.set(target.id, node); }} tabIndex={-1} className={cx("project-card", target.archived && "is-archived", focusProjectId === target.id && "is-focused")} key={target.id}>
        <header><span className="project-card__icon"><FolderKanban aria-hidden="true" /></span><div><h2>{target.name}</h2><p>{workspace?.serverPath || workspace?.name || target.workspaceName}</p></div><StatusDot state={target.error === undefined ? backend?.health ?? "unavailable" : "error"} label={target.error ?? backend?.health ?? "unavailable"} /></header>
        <dl><div><dt>{t("controls.backend")}</dt><dd>{backend?.name ?? target.backendId}</dd></div><div><dt>{t("projects.workspaceType")}</dt><dd>{workspace?.kind === "managedDialogue" ? t("projects.managed") : t("projects.userProject")}</dd></div><div><dt>{t("projects.tasks")}</dt><dd>{taskCount}</dd></div></dl>
        {target.error !== undefined && <p className="project-card__error" role="alert">{target.error}</p>}
        {workspace !== undefined && <section className="project-card__trust"><div><Shield aria-hidden="true" /><span><strong>{workspace.trusted ? t("projects.trusted") : t("projects.untrusted")}</strong><small>{t("projects.trustBody")}</small></span></div><div className="project-card__trust-actions">{workspace.trusted && resourceDiscoverySupported && <Button onClick={() => runAction(`project-resource-scan:${target.id}`, () => controller.discoverProjectResources(target.id))}><ScanSearch aria-hidden="true" />{t("projects.discoverResources")}{resourceCount > 0 ? ` · ${resourceCount}` : ""}</Button>}<Button tone={workspace.trusted ? "ghost" : "primary"} onClick={() => setTrustWorkspace(workspace)}>{workspace.trusted ? t("projects.revokeTrust") : t("projects.reviewTrust")}</Button></div></section>}
        {workspace !== undefined && <section className="project-card__directories"><header><h3>{t("projects.extraDirectories")}</h3><Button tone="ghost" onClick={() => setExtraWorkspace(workspace)}><Plus aria-hidden="true" />{t("common.add")}</Button></header>{directories.length === 0 ? <p className="muted">{t("projects.noExtraDirectories")}</p> : directories.map((directory) => <div key={directory.id}><span><strong>{directory.serverPath}</strong><small>{directory.access === "readWrite" ? t("projects.readWrite") : t("projects.readOnly")} · {directory.trusted ? t("projects.trusted") : t("projects.untrusted")}</small></span><IconButton label={`${t("common.remove")} ${directory.serverPath}`} onClick={() => setRemoveExtra(directory)}><Trash2 aria-hidden="true" /></IconButton></div>)}</section>}
        <footer><Button onClick={() => runAction(`project-pin:${target.id}`, () => controller.updateTarget(target.id, { pinned: !target.pinned }, target.revision))}><Pin aria-hidden="true" />{target.pinned ? t("projects.unpin") : t("projects.pin")}</Button><Button onClick={() => setEditor(target)}><Pencil aria-hidden="true" />{t("common.edit")}</Button><Button data-project-archive-action="" disabled={archivePendingIds.has(archiveOperationKey(target.id))} onClick={(event) => toggleArchived(target, event.currentTarget)}><Archive aria-hidden="true" />{archivePendingIds.has(archiveOperationKey(target.id)) ? t("common.working") : target.archived ? t("projects.restore") : t("session.archive")}</Button><Button tone="ghost" className="project-card__delete" onClick={() => setDeleteTarget(target)}><Trash2 aria-hidden="true" />{t("common.delete")}</Button></footer>
      </article>;
    })}{targets.length === 0 && <div className="project-empty"><FolderKanban aria-hidden="true" /><h2>{showArchived ? t("projects.noArchived") : t("projects.empty")}</h2><p>{t("projects.emptyBody")}</p>{!showArchived && <Button tone="primary" onClick={() => setEditor("new")}>{t("projects.new")}</Button>}</div>}</section>
    <ProjectEditor open={editor !== undefined} target={editor === "new" ? undefined : editor} snapshot={snapshot} t={t} onClose={() => setEditor(undefined)} onSave={(draft) => { const target = editor === "new" ? undefined : editor; setEditor(undefined); runAction(target === undefined ? "project-create" : `project-edit:${target.id}`, async () => { if (target === undefined) await controller.createTarget(draft); else await controller.updateTarget(target.id, { name: draft.name }, target.revision); }); }} />
    <TrustDialog workspace={trustWorkspace} t={t} onClose={() => setTrustWorkspace(undefined)} onConfirm={() => { const workspace = trustWorkspace; setTrustWorkspace(undefined); if (workspace !== undefined) runAction(`workspace-trust:${workspace.id}`, () => controller.setWorkspaceTrust(workspace.id, !workspace.trusted)); }} />
    <DeleteProjectDialog
      target={deleteTarget}
      workspace={snapshot.workspaces.find((workspace) => workspace.id === deleteTarget?.workspaceId)}
      sessions={snapshot.sessions.filter((session) => session.projectId === deleteTarget?.id)}
      prepareSessionRemoval={prepareSessionRemoval}
      t={t}
      onClose={() => setDeleteTarget(undefined)}
      onDelete={(deleteWorkspace, deleteSessions) => {
        const target = deleteTarget;
        const targetSessions = target === undefined
          ? []
          : snapshot.sessions.filter((session) => session.projectId === target.id);
        setDeleteTarget(undefined);
        if (target !== undefined) runAction(
          `project-delete:${target.id}`,
          async () => {
            if (deleteSessions) {
              for (const session of targetSessions) await controller.deleteSession(session.id, false);
            }
            await controller.deleteTarget(target.id, deleteWorkspace);
          }
        );
      }}
    />
    <ExtraDirectoryDialog workspace={extraWorkspace} t={t} onClose={() => setExtraWorkspace(undefined)} onSave={(path, access) => { const workspace = extraWorkspace; setExtraWorkspace(undefined); if (workspace !== undefined) runAction(`extra-directory:${workspace.id}`, () => controller.addExtraDirectory(workspace.id, path, access)); }} />
    <Modal open={removeExtra !== undefined} title={t("projects.removeDirectory")} description={removeExtra?.serverPath} size="small" onClose={() => setRemoveExtra(undefined)}><p>{t("projects.removeDirectoryBody")}</p><div className="modal__actions"><Button onClick={() => setRemoveExtra(undefined)}>{t("common.cancel")}</Button><Button tone="danger" onClick={() => { const directory = removeExtra; setRemoveExtra(undefined); if (directory !== undefined) runAction(`extra-remove:${directory.id}`, () => controller.removeExtraDirectory(directory.id)); }}>{t("common.remove")}</Button></div></Modal>
  </main>;
}

function ProjectEditor({ open, target, snapshot, t, onClose, onSave }: { readonly open: boolean; readonly target?: TargetView; readonly snapshot: AppSnapshot; readonly t: Translator; readonly onClose: () => void; readonly onSave: (draft: TargetDraft) => void }): JSX.Element {
  const [draft, setDraft] = useState<TargetDraft>(() => emptyTargetDraft(snapshot));
  useEffect(() => {
    if (!open) return;
    const workspace = snapshot.workspaces.find((candidate) => candidate.id === target?.workspaceId);
    setDraft(target === undefined ? emptyTargetDraft(snapshot) : { backendId: target.backendId, name: target.name, workspaceKind: workspace?.kind ?? "userProject", serverPath: workspace?.serverPath ?? "", createIfMissing: false });
  }, [open, target?.id]);
  const editing = target !== undefined;
  const valid = draft.name.trim().length > 0 && draft.backendId.length > 0 && (editing || draft.workspaceKind === "managedDialogue" || draft.serverPath.trim().length > 0);
  return <Modal open={open} title={editing ? t("projects.edit") : t("projects.new")} description={editing ? t("projects.editBody") : t("projects.createBody")} size="large" onClose={onClose}><form className="settings-form" onSubmit={(event) => { event.preventDefault(); if (valid) onSave(draft); }}><div className="settings-form__grid"><label className="field"><span>{t("projects.name")}</span><input required maxLength={120} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label><label className="field"><span>{t("controls.backend")}</span><SelectControl disabled={editing} value={draft.backendId} onChange={(event) => setDraft((current) => ({ ...current, backendId: event.target.value }))}>{snapshot.backends.map((backend) => <option value={backend.id} key={backend.id}>{backend.name}</option>)}</SelectControl></label>{!editing && <><label className="field"><span>{t("projects.workspaceType")}</span><SelectControl value={draft.workspaceKind} onChange={(event) => setDraft((current) => ({ ...current, workspaceKind: event.target.value as TargetDraft["workspaceKind"] }))}><option value="userProject">{t("projects.userProject")}</option><option value="managedDialogue">{t("projects.managed")}</option></SelectControl></label>{draft.workspaceKind === "userProject" && <label className="field settings-form__wide"><span>{t("projects.serverPath")}</span><input required value={draft.serverPath} onChange={(event) => setDraft((current) => ({ ...current, serverPath: event.target.value }))} placeholder={t("projects.serverPathPlaceholder")} /><small>{t("projects.serverPathHelp")}</small></label>}<label className="check-row settings-form__wide"><CheckboxControl checked={draft.createIfMissing} disabled={draft.workspaceKind === "managedDialogue"} onChange={(event) => setDraft((current) => ({ ...current, createIfMissing: event.target.checked }))} /><span><strong>{t("projects.createMissing")}</strong><small>{t("projects.createMissingBody")}</small></span></label></>}</div><div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button type="submit" tone="primary" disabled={!valid}>{editing ? t("common.save") : t("projects.create")}</Button></div></form></Modal>;
}

function TrustDialog({ workspace, t, onClose, onConfirm }: { readonly workspace?: WorkspaceView; readonly t: Translator; readonly onClose: () => void; readonly onConfirm: () => void }): JSX.Element {
  const granting = workspace?.trusted === false;
  return <Modal open={workspace !== undefined} title={granting ? t("projects.trustTitle") : t("projects.revokeTrustTitle")} description={workspace?.serverPath} size="small" onClose={onClose}><div className="trust-dialog"><ShieldAlert aria-hidden="true" /><p>{granting ? t("projects.trustWarning") : t("projects.revokeTrustWarning")}</p></div><div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone={granting ? "danger" : "secondary"} onClick={onConfirm}>{granting ? t("projects.trustConfirm") : t("projects.revokeTrust")}</Button></div></Modal>;
}

function DeleteProjectDialog({ target, workspace, sessions, prepareSessionRemoval, t, onClose, onDelete }: {
  readonly target?: TargetView;
  readonly workspace?: WorkspaceView;
  readonly sessions: readonly SessionView[];
  readonly prepareSessionRemoval: (sessions: readonly SessionView[]) => Promise<WorktreeRemovalPreflightSummary | undefined>;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onDelete: (deleteWorkspace: boolean, deleteSessions: boolean) => void;
}): JSX.Element {
  const [confirmation, setConfirmation] = useState("");
  const [deleteWorkspace, setDeleteWorkspace] = useState(false);
  const [deleteSessions, setDeleteSessions] = useState(false);
  const [preflight, setPreflight] = useState<WorktreeRemovalPreflightSummary>();
  const [preflightPending, setPreflightPending] = useState(false);
  const preflightGenerationRef = useRef(0);
  useEffect(() => {
    preflightGenerationRef.current += 1;
    setConfirmation("");
    setDeleteWorkspace(false);
    setDeleteSessions(false);
    setPreflight(undefined);
    setPreflightPending(false);
  }, [target?.id]);
  const confirmed = target !== undefined && confirmation === target.name;
  const loadPreflight = async (): Promise<WorktreeRemovalPreflightSummary | undefined> => {
    const generation = ++preflightGenerationRef.current;
    setPreflightPending(true);
    try {
      const result = await prepareSessionRemoval(sessions);
      if (preflightGenerationRef.current !== generation) return undefined;
      setPreflight(result);
      return result;
    } catch {
      if (preflightGenerationRef.current !== generation) return undefined;
      const result = { clean: 0, dirty: 0, unknown: sessions.length };
      setPreflight(result);
      return result;
    } finally {
      if (preflightGenerationRef.current === generation) setPreflightPending(false);
    }
  };
  const close = (): void => {
    preflightGenerationRef.current += 1;
    onClose();
  };
  const commit = async (): Promise<void> => {
    if (!confirmed) return;
    if (!deleteSessions) {
      onDelete(deleteWorkspace, false);
      return;
    }
    const displayed = preflight;
    if (displayed === undefined) return;
    const refreshed = await loadPreflight();
    if (refreshed === undefined || !sameRemovalSummary(displayed, refreshed)) return;
    onDelete(deleteWorkspace, true);
  };
  return <Modal open={target !== undefined} title={t("projects.deleteTitle", { name: target?.name ?? "" })} description={t("projects.deleteBody")} size="small" onClose={close}><div className="delete-dialog">
    <label className="check-row"><CheckboxControl checked={deleteSessions} onChange={(event) => {
      const checked = event.target.checked;
      setDeleteSessions(checked);
      setPreflight(undefined);
      preflightGenerationRef.current += 1;
      if (checked) void loadPreflight();
    }} /><span><strong>{t("projects.deleteSessions")}</strong><small>{t("projects.deleteSessionsBody")}</small></span></label>
    {deleteSessions && <WorktreeRemovalWarnings disposition="delete" preflight={preflight} t={t} />}
    {workspace?.kind === "managedDialogue" && <label className="check-row"><CheckboxControl checked={deleteWorkspace} onChange={(event) => setDeleteWorkspace(event.target.checked)} /><span><strong>{t("projects.deleteWorkspace")}</strong><small>{t("projects.deleteWorkspaceBody")}</small></span></label>}
    <label className="field"><span>{t("projects.typeName", { name: target?.name ?? "" })}</span><input value={confirmation} autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} /></label>
    <div className="modal__actions"><Button onClick={close}>{t("common.cancel")}</Button><Button tone="danger" aria-busy={preflightPending} disabled={!confirmed || deleteSessions && (preflightPending || preflight === undefined)} onClick={() => { void commit(); }}>{preflightPending ? t("common.working") : t("common.delete")}</Button></div>
  </div></Modal>;
}

function ExtraDirectoryDialog({ workspace, t, onClose, onSave }: { readonly workspace?: WorkspaceView; readonly t: Translator; readonly onClose: () => void; readonly onSave: (path: string, access: ExtraDirectoryView["access"]) => void }): JSX.Element {
  const [path, setPath] = useState("");
  const [access, setAccess] = useState<ExtraDirectoryView["access"]>("readOnly");
  useEffect(() => { setPath(""); setAccess("readOnly"); }, [workspace?.id]);
  return <Modal open={workspace !== undefined} title={t("projects.addDirectory")} description={t("projects.addDirectoryBody")} size="medium" onClose={onClose}><form className="settings-form" onSubmit={(event) => { event.preventDefault(); if (path.trim()) onSave(path.trim(), access); }}><label className="field"><span>{t("projects.serverPath")}</span><input required value={path} onChange={(event) => setPath(event.target.value)} placeholder={t("projects.serverPathPlaceholder")} /><small>{t("projects.serverPathHelp")}</small></label><label className="field"><span>{t("projects.access")}</span><SelectControl value={access} onChange={(event) => setAccess(event.target.value as ExtraDirectoryView["access"])}><option value="readOnly">{t("projects.readOnly")}</option><option value="readWrite">{t("projects.readWrite")}</option></SelectControl></label><div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button type="submit" tone="primary" disabled={path.trim().length === 0}>{t("common.add")}</Button></div></form></Modal>;
}

function emptyTargetDraft(snapshot: AppSnapshot): TargetDraft {
  return { backendId: snapshot.backends[0]?.id ?? "", name: "", workspaceKind: "userProject", serverPath: "", createIfMissing: false };
}

function sameRemovalSummary(left: WorktreeRemovalPreflightSummary, right: WorktreeRemovalPreflightSummary): boolean {
  return left.clean === right.clean && left.dirty === right.dirty && left.unknown === right.unknown;
}

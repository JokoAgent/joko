import { ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, CirclePause, FolderOpen, Lightbulb, Plus, RefreshCcw, Send, Square, SquareArrowOutUpRight, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX } from "react";

import type { AppController } from "../controller.js";
import type { PartnerWorkbenchDetailView, PartnerWorkbenchTaskView, PartnerWorkbenchView, ProjectDirectoryListingView, SessionView, WorkspaceEntryView } from "../model.js";
import { sameWorkbenchOwner } from "../partner-workbench-wire.js";
import type { PartnerConversationView } from "./PartnerConversation.js";
import { localProjectPickerOwner, sameProjectPickerOwner } from "./ProjectEditor.js";
import { ArtifactDownloadButton } from "./ArtifactDownloadButton.js";
import { TimelineMarkdownDocument } from "./TimelineMarkdownDocument.js";
import { Button, IconButton, Pill, Spinner, cx, formatRelativeTime } from "./ui.js";
import type { Translator } from "./types.js";
import "./partner-workbench.css";

export interface PartnerWorkbenchDrafts { readonly messages: Map<string, string> }
type Projection = { readonly key: string; readonly view: PartnerWorkbenchView };
type DocumentPreview = { readonly path: string; readonly text: string; readonly truncated: boolean };
const GROUPS = ["waiting", "running", "todo", "done"] as const;

/** The Inspector keeps this panel mounted while another tab is active. Its
 * requests belong to the document hosting the panel, including detached UI. */
export function PartnerWorkbench({ controller, session, conversation, active, ownerDocument, selectedTaskId, selectedProject,
  onSelectTask, onSelectProject, drafts, t }: {
  readonly controller: AppController;
  readonly session: SessionView;
  readonly conversation: PartnerConversationView;
  readonly active: boolean;
  readonly ownerDocument: Document;
  readonly selectedTaskId?: string;
  readonly selectedProject?: string;
  readonly onSelectTask: (taskId?: string) => void;
  readonly onSelectProject: (project?: string) => void;
  readonly drafts: PartnerWorkbenchDrafts;
  readonly t: Translator;
}): JSX.Element {
  const partner = conversation.partner;
  const key = `${conversation.ownerKey}\u0000${partner?.profileVersion ?? ""}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [documentEpoch, setDocumentEpoch] = useState(0);
  const [projection, setProjection] = useState<Projection>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [directoryListing, setDirectoryListing] = useState<ProjectDirectoryListingView>();
  const [showMoreProjects, setShowMoreProjects] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [detail, setDetail] = useState<{ readonly key: string; readonly value: PartnerWorkbenchDetailView }>();
  const [detailError, setDetailError] = useState<string>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [pinned, setPinned] = useState<{ readonly key: string; readonly task: PartnerWorkbenchTaskView }>();
  const [messageDraft, setMessageDraft] = useState("");
  const [sent, setSent] = useState<string>();
  const [documentPreview, setDocumentPreview] = useState<DocumentPreview>();
  const [referenceDirectory, setReferenceDirectory] = useState<{ readonly path: string; readonly relativePath: string; readonly entries: readonly WorkspaceEntryView[] }>();
  const [pendingHandover, setPendingHandover] = useState<{ readonly project: string; readonly text: string } | undefined>(() => {
    const pending = [...drafts.messages].find(([key]) => key.startsWith("handover:"));
    return pending === undefined ? undefined : { project: pending[0].slice(9), text: pending[1] };
  });
  const [now, setNow] = useState(Date.now);
  const scope = useMemo(() => ({}), [key, ownerDocument, documentEpoch, conversation.connected, active]);
  const scopeRef = useRef<object>(scope);
  scopeRef.current = scope;
  const flights = useRef(new Set<AbortController>());
  const actionFlight = useRef<AbortController | undefined>(undefined);
  const currentRef = useRef({ controller, session, conversation, active, ownerDocument, selectedTaskId });
  currentRef.current = { controller, session, conversation, active, ownerDocument, selectedTaskId };
  const view = projection?.key === key ? projection.view : undefined;
  const editable = active && conversation.editable && view !== undefined && partner !== undefined
    && view.owner.partnerId === partner.id && view.owner.profileVersion === partner.profileVersion
    && view.owner.sessionId === session.id && view.owner.targetId === session.targetId && view.owner.sessionGeneration === session.generation;

  const current = (): boolean => {
    const now = currentRef.current;
    const state = now.controller.state;
    const live = state.snapshot.sessions.find((item) => item.id === now.session.id);
    return scopeRef.current === scope && now.active && now.conversation.connected
      && rootRef.current?.isConnected === true && rootRef.current.ownerDocument === ownerDocument
      && ownerDocument.visibilityState === "visible" && ownerDocument.defaultView !== null && !ownerDocument.defaultView.closed
      && state.connectionState === "connected" && state.route.kind === "session" && state.route.sessionId === session.id
      && live?.generation === session.generation && live.targetId === session.targetId
      && now.conversation.ownerKey === conversation.ownerKey && now.conversation.partner?.profileVersion === partner?.profileVersion;
  };
  const abortAll = (): void => { for (const flight of flights.current) flight.abort(); flights.current.clear(); actionFlight.current = undefined; };
  useEffect(() => {
    const retire = (): void => { scopeRef.current = {}; abortAll(); setBusy(undefined); setLoading(false); setDetailLoading(false); setDocumentEpoch((value) => value + 1); };
    const visibility = (): void => { retire(); if (ownerDocument.visibilityState === "visible") setRefresh((value) => value + 1); };
    const show = (): void => { retire(); setRefresh((value) => value + 1); };
    ownerDocument.addEventListener("visibilitychange", visibility);
    ownerDocument.defaultView?.addEventListener("pagehide", retire);
    ownerDocument.defaultView?.addEventListener("pageshow", show);
    return () => {
      if (scopeRef.current === scope) scopeRef.current = {};
      abortAll();
      ownerDocument.removeEventListener("visibilitychange", visibility);
      ownerDocument.defaultView?.removeEventListener("pagehide", retire);
      ownerDocument.defaultView?.removeEventListener("pageshow", show);
    };
  }, [scope, ownerDocument]);
  useEffect(() => {
    setBusy(undefined); setError(undefined); setDetailError(undefined); setSent(undefined); setDirectoryListing(undefined); setDocumentPreview(undefined); setReferenceDirectory(undefined);
    const pending = [...drafts.messages].find(([key]) => key.startsWith("handover:"));
    setPendingHandover(pending === undefined ? undefined : { project: pending[0].slice(9), text: pending[1] });
  }, [key]);
  useEffect(() => {
    if (!active || !view?.tasks.some((task) => task.state === "running" && task.startedAt !== undefined)) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active, view?.tasks]);

  useEffect(() => {
    if (!active || !conversation.editable || partner === undefined || ownerDocument.visibilityState !== "visible") return;
    const abort = new AbortController(); flights.current.add(abort);
    // Durable task events can arrive in a burst. One bounded read owns the
    // resulting projection; a newer owner retires its response.
    const timer = setTimeout(() => {
      setLoading(true);
      void controller.getPartnerWorkbench(partner.id, abort.signal).then((result) => {
        if (!current() || abort.signal.aborted) return;
        if (result.owner.sessionId !== session.id || result.owner.targetId !== session.targetId
          || result.owner.sessionGeneration !== session.generation || result.owner.profileVersion !== partner.profileVersion) { conversation.refresh(); throw new Error(t("workbench.ownerChanged")); }
        setProjection((previous) => previous?.key === key && previous.view.revision > result.revision ? previous : { key, view: result });
        setError(undefined);
      }).catch((cause: unknown) => { if (current() && !abort.signal.aborted) setError(messageOf(cause, t)); })
        .finally(() => { flights.current.delete(abort); if (current() && !abort.signal.aborted) setLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); abort.abort(); flights.current.delete(abort); };
  }, [scope, conversation.editable, partner?.id, refresh, controller.state.snapshot.cursor]);

  const liveTask = view?.tasks.find((task) => task.id === selectedTaskId) ?? view?.candidates.find((task) => task.id === selectedTaskId);
  const retainedTask = liveTask ?? (pinned?.key === key && pinned.task.id === selectedTaskId ? pinned.task : undefined);
  const selected = retainedTask !== undefined && (retainedTask.project === "" || view?.projects.some((project) => project.path === retainedTask.project)) ? retainedTask : undefined;
  useEffect(() => {
    if (view === undefined) return;
    const insideGrant = (path: string): boolean => view.projects.some((project) => {
      const key = (value: string): string => /^[A-Za-z]:[\\/]|^\\\\/u.test(value) ? value.replaceAll("\\", "/").toLowerCase() : value;
      const root = key(project.path).replace(/\/$/u, ""); const child = key(path);
      return child === root || child.startsWith(`${root}/`);
    });
    if (documentPreview !== undefined && !insideGrant(documentPreview.path)) setDocumentPreview(undefined);
    if (referenceDirectory !== undefined && !insideGrant(referenceDirectory.path)) setReferenceDirectory(undefined);
    if (retainedTask !== undefined && selected === undefined) { setDetail(undefined); setDetailError(t("workbench.projectUnavailable")); }
  }, [view?.revision, view?.projects, selected?.id]);
  useEffect(() => { if (liveTask !== undefined) setPinned({ key, task: liveTask }); }, [key, liveTask]);
  useEffect(() => {
    setMessageDraft(selectedTaskId === undefined ? "" : drafts.messages.get(selectedTaskId) ?? "");
    setDetailError(undefined); setSent(undefined);
  }, [key, selectedTaskId, drafts]);
  useEffect(() => {
    if (!active || !conversation.editable || view === undefined || selectedTaskId === undefined || ownerDocument.visibilityState !== "visible") return;
    const abort = new AbortController(); flights.current.add(abort); setDetailLoading(true);
    void controller.getPartnerWorkbenchDetail(view.owner, selectedTaskId, abort.signal).then((value) => {
      if (current() && !abort.signal.aborted && currentRef.current.selectedTaskId === selectedTaskId) { setDetail({ key, value }); setPinned({ key, task: value.task }); setDetailError(undefined); }
    }).catch((cause: unknown) => {
      if (current() && !abort.signal.aborted && currentRef.current.selectedTaskId === selectedTaskId) setDetailError(messageOf(cause, t));
    }).finally(() => { flights.current.delete(abort); if (current() && !abort.signal.aborted) setDetailLoading(false); });
    return () => { abort.abort(); flights.current.delete(abort); };
  }, [scope, conversation.editable, selectedTaskId, liveTask?.state, liveTask?.updatedAt, view?.revision, refresh]);
  const selectedDetail = selected !== undefined && detail?.key === key && detail.value.task.id === selectedTaskId ? detail.value : undefined;

  const act = async (name: string, effect: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (!editable || actionFlight.current !== undefined || !current() || !ownerDocument.hasFocus()) return;
    const abort = new AbortController(); actionFlight.current = abort; flights.current.add(abort); setBusy(name); setError(undefined); setSent(undefined);
    try { await effect(abort.signal); }
    catch (cause) { if (current() && !abort.signal.aborted) setError(messageOf(cause, t)); }
    finally { flights.current.delete(abort); if (actionFlight.current === abort) actionFlight.current = undefined; if (current() && !abort.signal.aborted) setBusy(undefined); }
  };
  const accept = (result: PartnerWorkbenchView): boolean => {
    if (!current() || view === undefined || !sameWorkbenchOwner(result.owner, view.owner)) return false;
    setProjection((previous) => previous?.key === key && previous.view.revision > result.revision ? previous : { key, view: result }); return true;
  };
  const send = async (text: string): Promise<void> => {
    if (!current() || view === undefined) return;
    await controller.send(session.id, { text, attachments: [], mentions: [], deliveryMode: "prompt" }, { expectedGeneration: view.owner.sessionGeneration });
  };
  const handOver = (path: string): void => { void act("handover", async (signal) => {
    const result = await controller.addPartnerWorkbenchProject(view!.owner, view!.revision, path, signal);
    if (!accept(result)) return;
    const project = result.projects.find((item) => item.path === result.acceptedProject);
    if (project === undefined) throw new Error(t("workbench.projectUnavailable"));
    const text = t("workbench.handoverMessage", { name: project.name, path: project.path });
    drafts.messages.set(`handover:${project.path}`, text); setPendingHandover({ project: project.path, text }); setAdding(false); onSelectProject(project.path);
    await send(text);
    if (current()) { drafts.messages.delete(`handover:${project.path}`); setPendingHandover(undefined); setSent(t("workbench.sent")); setRefresh((value) => value + 1); }
  }); };
  const followUp = (task: PartnerWorkbenchTaskView, text = ""): void => { void act(`follow:${task.id}`, async () => {
    const message = text.trim() === "" ? t("workbench.followUpMessage", { title: task.title, project: task.project })
      : t("workbench.continueMessage", { title: task.title, text: text.trim(), project: task.project });
    drafts.messages.set(task.id, text.trim() || message);
    await send(message);
    if (current()) { drafts.messages.delete(task.id); if (currentRef.current.selectedTaskId === task.id) setMessageDraft(""); setSent(t("workbench.sent")); setRefresh((value) => value + 1); }
  }); };
  const openTask = (task: PartnerWorkbenchTaskView): void => {
    if (task.kind === "automation" && task.scheduleId !== undefined) controller.navigate({ kind: "schedules", scheduleId: task.scheduleId });
    else { setPinned({ key, task }); onSelectTask(task.id); }
  };
  const openReference = (ref: string): void => { void act("reference", async (signal) => {
    const result = await controller.resolvePartnerWorkbenchReference(view!.owner, ref, signal);
    if (!current()) return;
    if (result.kind === "https") await controller.openHttpLink(result.value, { sessionId: session.id, action: { ownerDocument, signal } });
    else if (result.directory) {
      const entries = await controller.listWorkspaceEntries(result.workspaceId!, result.relativePath!);
      await controller.resolvePartnerWorkbenchReference(view!.owner, ref, signal);
      if (current()) setReferenceDirectory({ path: result.value, relativePath: result.relativePath!, entries });
    } else if (/\.(md|mdx|txt)$/iu.test(result.value)) {
      const preview = await controller.readPartnerWorkbenchDocument(view!.owner, result.value, signal);
      if (current()) setDocumentPreview(preview);
    } else {
      const preview = await controller.readWorkspaceFile(result.workspaceId!, result.relativePath!);
      await controller.resolvePartnerWorkbenchReference(view!.owner, ref, signal);
      if (!current()) return;
      if (preview.blobId !== undefined) await controller.openArtifactFile(preview.blobId, preview.name, preview.byteSize ?? 0, { ownerDocument, signal });
      else if (preview.text !== undefined) setDocumentPreview({ path: result.value, text: preview.text, truncated: preview.truncated });
      else throw new Error(t("workbench.fileUnavailable"));
    }
  }); };
  const browse = (path: string): void => { void act("browse", async (signal) => {
    const listing = await controller.listProjectDirectories(path, signal);
    if (current()) setDirectoryListing(listing);
  }); };
  const pickFolder = (): void => { void act("pick", async () => {
    const owner = localProjectPickerOwner(controller);
    const picker = window.jokoDesktop?.projects?.pickDirectory;
    if (owner === undefined || picker === undefined) return;
    const result = await picker(owner);
    if (current() && sameProjectPickerOwner(localProjectPickerOwner(currentRef.current.controller), owner) && !result.cancelled) setPathDraft(result.path);
  }); };
  const stop = (task: PartnerWorkbenchTaskView): void => { void act("stop", async () => {
    const target = controller.state.snapshot.sessions.find((item) => item.id === task.sessionId);
    if (target?.activeRunId === undefined) throw new Error(t("workbench.taskUnavailable"));
    await controller.abort(target.activeRunId);
    if (current()) setRefresh((value) => value + 1);
  }); };
  const status = (task: PartnerWorkbenchTaskView): string => task.judgment !== undefined && !["running", "waiting", "queued"].includes(task.state)
    ? t(`workbench.verdict.${task.judgment.verdict}`) : t(`workbench.state.${task.state}`);
  const stateIcon = (task: PartnerWorkbenchTaskView): JSX.Element => task.state === "running" || task.state === "queued" ? <Spinner />
    : task.judgment?.verdict === "idea" ? <Lightbulb aria-hidden="true" /> : task.state === "done" ? <CheckCircle2 aria-hidden="true" /> : <CirclePause aria-hidden="true" />;
  const elapsed = (task: PartnerWorkbenchTaskView): string => task.state !== "running" || task.startedAt === undefined ? ""
    : ` · ${Math.floor(Math.max(0, now - task.startedAt) / 60_000)}:${String(Math.floor(Math.max(0, now - task.startedAt) / 1_000) % 60).padStart(2, "0")}`;
  const output = (artifact: PartnerWorkbenchDetailView["artifacts"][number]): JSX.Element => <div key={artifact.id} className="partner-workbench__output">
    <ArtifactDownloadButton ownerKey={`${key}:${artifact.id}:open`} connectionOwner={controller.state.activeProfile}
      action={(context) => controller.openArtifactFile(artifact.id, artifact.title, artifact.byteSize, context)} disabled={disabled} label={artifact.title} errorLabel={t("workbench.fileUnavailable")} />
    <ArtifactDownloadButton ownerKey={`${key}:${artifact.id}:download`} connectionOwner={controller.state.activeProfile}
      action={(context) => controller.downloadArtifact(artifact.id, artifact.title, context)} disabled={disabled} iconOnly label={`${t("common.download")}: ${artifact.title}`} errorLabel={t("workbench.fileUnavailable")} />
  </div>;
  const locale = controller.state.effectiveLocale;
  const sourceLabel = (task: PartnerWorkbenchTaskView): string => task.sourceLabel === "Source unavailable" ? t("workbench.sourceUnavailable")
    : task.kind === "item" ? t("workbench.note") : task.kind === "automation" ? t(task.sourceLabel === "Routine" ? "workbench.routine" : "workbench.automation")
      : task.kind === "session" ? t(task.ownedBackground ? "workbench.backgroundTask" : "workbench.task") : task.sourceLabel;
  const frequency = (task: PartnerWorkbenchTaskView): string | undefined => {
    const schedule = controller.state.snapshot.schedules.find((item) => item.id === task.scheduleId);
    const seconds = schedule?.kind === "interval" ? Number(schedule.expression.replace(/s$/u, "")) : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0) return task.scheduleSummary;
    return seconds % 3_600 === 0 ? t("workbench.everyHours", { count: seconds / 3_600 })
      : seconds % 60 === 0 ? t("workbench.everyMinutes", { count: seconds / 60 }) : t("workbench.everySeconds", { count: seconds });
  };
  const disabled = !editable || busy !== undefined;
  const picking = view !== undefined && (view.projects.length === 0 || adding);
  const projectOptions = view?.projectOptions.filter((item) => !item.granted) ?? [];
  const visibleTasks = view?.tasks.filter((task) => (!picking || task.kind === "automation") && (selectedProject === undefined || task.project === "" || task.project === selectedProject)) ?? [];
  const understanding = session.state === "running" && (view?.candidates.some((item) => item.kind === "external" && item.judgment === undefined) ?? false);

  return <div ref={rootRef} className="partner-workbench" aria-label={t("workbench.title")} aria-busy={loading}>
    {error !== undefined && <div className="partner-workbench__error" role="alert"><p>{error}</p><Button disabled={!conversation.editable || busy !== undefined} onClick={() => setRefresh((value) => value + 1)}>{t("common.retry")}</Button></div>}
    {sent !== undefined && <p className="partner-workbench__notice" role="status">{sent}</p>}
    {!conversation.connected && <p role="status" className="muted">{t("workbench.disconnected")}</p>}
    {view === undefined ? <div className="partner-workbench__empty">{loading ? <Spinner /> : <Button disabled={!conversation.editable} onClick={() => setRefresh((value) => value + 1)}>{t("common.retry")}</Button>}<p>{t("workbench.loading")}</p></div>
      : documentPreview !== undefined ? <><header className="partner-workbench__heading"><IconButton label={t("workbench.back")} onClick={() => setDocumentPreview(undefined)}><ArrowLeft aria-hidden="true" /></IconButton><strong title={documentPreview.path}>{fileName(documentPreview.path)}</strong></header>{documentPreview.truncated && <p className="muted">{t("workbench.truncated")}</p>}<pre className="partner-workbench__document">{documentPreview.text}</pre></>
      : referenceDirectory !== undefined ? <><header className="partner-workbench__heading"><IconButton label={t("workbench.back")} onClick={() => setReferenceDirectory(undefined)}><ArrowLeft aria-hidden="true" /></IconButton><strong title={referenceDirectory.path}>{fileName(referenceDirectory.path)}</strong></header><div className="partner-workbench__directory">{referenceDirectory.entries.map((entry) => <Button key={entry.path} disabled={disabled} onClick={() => {
        const suffix = referenceDirectory.relativePath === "" ? entry.path : entry.path.slice(referenceDirectory.relativePath.length + 1);
        openReference(`${referenceDirectory.path.replace(/[\\/]$/u, "")}/${suffix}`);
      }}>{entry.kind === "directory" && <FolderOpen aria-hidden="true" />}{entry.name}</Button>)}</div></>
      : selectedTaskId !== undefined ? <>
        <header className="partner-workbench__heading"><IconButton label={t("workbench.back")} onClick={() => onSelectTask(undefined)}><ArrowLeft aria-hidden="true" /></IconButton><strong>{selected?.title ?? t("workbench.taskUnavailable")}</strong>
          {selected?.state === "running" && selected.sessionId !== undefined && <IconButton label={t("workbench.stop")} disabled={disabled} onClick={() => stop(selected)}><Square aria-hidden="true" /></IconButton>}
          {selected?.sessionId !== undefined && <IconButton label={t("workbench.openTask")} disabled={disabled} onClick={() => controller.navigate({ kind: "session", sessionId: selected.sessionId! })}><SquareArrowOutUpRight aria-hidden="true" /></IconButton>}
        </header>
        {selected !== undefined && <div className="partner-workbench__task-meta">{stateIcon(selected)}<span>{status(selected)}{elapsed(selected)}</span><span>{sourceLabel(selected)}</span></div>}
        <div className="partner-workbench__detail">
          {detailError !== undefined && <div role="alert" className="partner-workbench__error"><p>{detailError}</p><Button disabled={disabled} onClick={() => setRefresh((value) => value + 1)}>{t("common.retry")}</Button></div>}
          {selected?.judgment?.next && <section className="partner-workbench__judgment"><small>{t("workbench.nextStep", { name: partner?.displayName ?? "" })}</small><p>{selected.judgment.next}</p></section>}
          {selected?.judgment?.ref && <Button disabled={disabled} onClick={() => openReference(selected.judgment!.ref!)}><SquareArrowOutUpRight aria-hidden="true" />{selected.judgment.ref}</Button>}
          {selectedDetail === undefined && detailLoading ? <Spinner /> : selectedDetail !== undefined && <>
            {selectedDetail.truncated && <p className="muted">{t("workbench.truncated")}</p>}
            {selectedDetail.transcript.length === 0 && <p className="muted">{t("workbench.noTranscript")}</p>}
            {selectedDetail.transcript.map((item, index) => <div key={`${item.at}:${index}`} className={cx("partner-workbench__message", item.role === "user" && "is-user")}>
              {item.privateMessageOrigin !== undefined && <button type="button" className="partner-workbench__private" disabled={!conversation.editable} onClick={() => conversation.openPrivateThread(item.privateMessageOrigin!.threadId)}>{t("workbench.privateReplyFrom", { name: item.privateMessageOrigin.senderDisplayName })}</button>}
              {item.role === "user" ? item.text : <TimelineMarkdownDocument skipHtml components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>{item.text}</TimelineMarkdownDocument>}
            </div>)}
            {selectedDetail.artifacts.length > 0 && <section><h4>{t("workbench.outputs")}</h4>{selectedDetail.artifacts.map(output)}</section>}
          </>}
        </div>
        {selected !== undefined && <form className="partner-workbench__composer" onSubmit={(event) => { event.preventDefault(); followUp(selected, messageDraft); }}>
          <label className="sr-only" htmlFor={`workbench-draft-${session.id}`}>{t("workbench.direction")}</label>
          <textarea id={`workbench-draft-${session.id}`} value={messageDraft} maxLength={12_000} disabled={disabled} placeholder={t("workbench.directionPlaceholder")}
            onChange={(event) => { setMessageDraft(event.target.value); drafts.messages.set(selectedTaskId, event.target.value); }} />
          <Button type="submit" tone="primary" disabled={disabled || messageDraft.trim() === ""}><Send aria-hidden="true" />{busy?.startsWith("follow:") ? t("common.working") : t("workbench.sendDirection")}</Button>
        </form>}
      </> : <>
        <header className="partner-workbench__heading"><strong>{t("workbench.title")}</strong><IconButton label={t("common.refresh")} disabled={!conversation.editable || loading || busy !== undefined} onClick={() => setRefresh((value) => value + 1)}><RefreshCcw aria-hidden="true" /></IconButton></header>
        {picking ? <section className="partner-workbench__picker">
          <h3>{t("workbench.handOver", { name: partner?.displayName ?? "" })}</h3><p className="muted">{t("workbench.grantHelp", { name: partner?.displayName ?? "" })}</p>
          <div className="partner-workbench__options" role="radiogroup" aria-label={t("workbench.projects")}>
            {(showMoreProjects ? projectOptions : projectOptions.slice(0, 8)).map((option) => <button key={option.path} type="button" role="radio" aria-checked={pathDraft === option.path} disabled={disabled} onClick={() => setPathDraft(option.path)} className={cx("partner-workbench__option", pathDraft === option.path && "is-selected")}><strong>{option.name}</strong><small>{option.path}</small><span>{t("workbench.projectCounts", { tasks: option.taskCount, native: option.nativeCount, automation: option.automationCount })}{option.repository && <Pill>{t("workbench.repository")}</Pill>}</span></button>)}
          </div>
          {projectOptions.length > 8 && <Button disabled={disabled} onClick={() => setShowMoreProjects(!showMoreProjects)}>{showMoreProjects ? t("workbench.lessProjects") : t("workbench.moreProjects")}</Button>}
          <label className="field"><span>{t("workbench.projectPath")}</span><input value={pathDraft} maxLength={32_768} disabled={disabled} placeholder={t("projects.serverPathPlaceholder")} onChange={(event) => setPathDraft(event.target.value)} /></label>
          <div className="partner-workbench__actions">{localProjectPickerOwner(controller) !== undefined ? <Button disabled={disabled} onClick={pickFolder}><FolderOpen aria-hidden="true" />{t("projects.browseLocal")}</Button> : <Button disabled={disabled} onClick={() => browse(pathDraft)}><FolderOpen aria-hidden="true" />{t("projects.browseService")}</Button>}
            {view.projects.length > 0 && <Button disabled={busy !== undefined} onClick={() => setAdding(false)}>{t("common.cancel")}</Button>}
            <Button tone="primary" disabled={disabled || pathDraft.trim() === "" || view.projects.length >= 50} onClick={() => handOver(pathDraft.trim())}>{busy === "handover" ? t("common.working") : t("workbench.handOverAction")}</Button></div>
          {directoryListing !== undefined && <section className="partner-workbench__directory"><strong>{directoryListing.path}</strong><div>{directoryListing.directories.map((entry) => <Button key={entry.path} disabled={disabled} onClick={() => browse(entry.path)}><FolderOpen aria-hidden="true" />{entry.name}</Button>)}</div><div className="partner-workbench__actions"><Button disabled={disabled} onClick={() => browse(directoryListing.parentPath)}>{t("projects.browseServiceParent")}</Button><Button disabled={disabled} onClick={() => { setPathDraft(directoryListing.path); setDirectoryListing(undefined); }}>{t("projects.browseServiceChoose")}</Button></div></section>}
        </section> : <div className="partner-workbench__projects">
          <Button className={selectedProject === undefined ? "is-selected" : ""} onClick={() => onSelectProject(undefined)}>{t("workbench.allProjects")}</Button>
          {view.projects.map((project) => <span className={cx("partner-workbench__project", selectedProject === project.path && "is-selected")} key={project.path}><button type="button" title={project.path} onClick={() => onSelectProject(project.path)}>{project.name}{!project.exists && <span> · {t("workbench.missing")}</span>}</button><IconButton label={t("workbench.removeProject", { name: project.name })} disabled={disabled} onClick={() => { void act("remove", async (signal) => { const result = await controller.removePartnerWorkbenchProject(view.owner, view.revision, project.path, signal); if (accept(result) && selectedProject === project.path) onSelectProject(undefined); }); }}><X aria-hidden="true" /></IconButton></span>)}
          {view.projects.length < 50 && <IconButton label={t("workbench.addProject")} disabled={disabled} onClick={() => { setPathDraft(""); setAdding(true); }}><Plus aria-hidden="true" /></IconButton>}
        </div>}
        {pendingHandover !== undefined && <section className="partner-workbench__judgment"><p>{t("workbench.handoverPending")}</p><p>{pendingHandover.text}</p><Button disabled={disabled} onClick={() => { void act("handover-send", async () => { await send(pendingHandover.text); if (current()) { drafts.messages.delete(`handover:${pendingHandover.project}`); setPendingHandover(undefined); setSent(t("workbench.sent")); } }); }}>{t("common.retry")}</Button></section>}
        {understanding && <p className="partner-workbench__notice"><Spinner />{t("workbench.understanding", { name: partner?.displayName ?? "" })}</p>}
        {GROUPS.map((group) => {
          const tasks = visibleTasks.filter((task) => task.group === group);
          if (tasks.length === 0) return null;
          return <section className="partner-workbench__group" key={group} aria-label={t(`workbench.group.${group}`)}>
            {group === "done" ? <button type="button" className="partner-workbench__group-heading" aria-expanded={doneOpen} onClick={() => setDoneOpen(!doneOpen)}>{doneOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}<h3>{t(`workbench.group.${group}`)}</h3><span>{tasks.length}</span></button> : <div className="partner-workbench__group-heading"><h3>{t(`workbench.group.${group}`)}</h3><span>{tasks.length}</span></div>}
            {(group !== "done" || doneOpen) && tasks.map((task) => <div className="partner-workbench__row" key={task.id}><button type="button" className="partner-workbench__task" onClick={() => openTask(task)}>{stateIcon(task)}<span><strong>{task.title}{task.unread && <span className="partner-workbench__unread" aria-label={t("workbench.unread")} />}</strong><small>{task.judgment?.next ?? task.digest.purpose ?? status(task)}{elapsed(task)}</small><span>{sourceLabel(task)} · {formatRelativeTime(task.updatedAt, locale)}{frequency(task) && ` · ${frequency(task)}`}</span></span></button>{group !== "done" && task.kind !== "automation" && <Button disabled={disabled} onClick={() => followUp(task)}>{busy === `follow:${task.id}` ? <Spinner /> : t("workbench.followUp")}</Button>}</div>)}
          </section>;
        })}
        {!picking && visibleTasks.length === 0 && !understanding && <div className="partner-workbench__empty"><CheckCircle2 aria-hidden="true" /><p>{t("workbench.empty", { name: partner?.displayName ?? "" })}</p></div>}
        {!picking && <section className="partner-workbench__outputs"><h3>{t("workbench.outputs")}</h3>{view.outputs.length === 0 ? <p className="muted">{t("workbench.outputsEmpty")}</p> : view.outputs.map(output)}</section>}
        {view.olderCount > 0 && <p className="partner-workbench__notice">{t("workbench.older", { count: view.olderCount })}</p>}
        {view.unavailableSources.length > 0 && <p className="partner-workbench__notice" role="status">{t("workbench.sourcesUnavailable", { sources: view.unavailableSources.join(", ") })}</p>}
        {view.truncated && <p className="partner-workbench__notice">{t("workbench.bounded")}</p>}
      </>}
  </div>;
}

function messageOf(cause: unknown, t: Translator): string { return cause instanceof Error ? cause.message : t("error.unexpected"); }
function fileName(path: string): string { return path.split(/[\\/]/u).at(-1) ?? path; }

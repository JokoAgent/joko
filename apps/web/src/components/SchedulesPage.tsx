import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { ArrowUpToLine, CalendarClock, Check, CheckCircle2, ChevronDown, ChevronRight, CirclePlus, Clock3, Copy, FolderGit2, FolderMinus, GitBranch, History, Menu, MoreHorizontal, Pause, Pencil, Play, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import type { AppController } from "../controller.js";
import { modelPreferenceOwnerId } from "../model-picker-preferences.js";
import type { BackendView, ExtraDirectoryView, ModelView, SchedulerRuntimeView, ScheduleDraft, ScheduleView, SessionView, TargetView, TargetWorktreeProbeView, WorktreeEligibilityView, WorktreeSourceView } from "../model.js";
import { clampScheduleListWidth, countActiveSchedules, filterSchedules, groupSchedulesByProject, normalizeScheduleStatusFilter, reconcileScheduleHistory, scheduleDisplayStatus, scheduleRuntimeStatus, selectVisibleScheduleId } from "./scheduler-list.js";
import type { ScheduleRuntimeStatus, ScheduleStatusFilter } from "./scheduler-list.js";
import { resolveNewSessionExecutionOptions } from "./new-session-options.js";
import { ModelPicker, type ModelPickerSelection } from "./ModelPicker.js";
import { isValidScheduleTimeZone, scheduleEpochFromLocalDateTime, scheduleLocalDateTimeFromEpoch } from "../schedule-time.js";
import {
  initialScheduleTemplateParameters,
  scheduleTemplateCatalog,
  scheduleTemplateCategories,
  scheduleTemplateDraftPatch,
  type ScheduleTemplateCapability,
  type ScheduleTemplateId
} from "../schedule-templates.js";
import type { RunAction, Translator } from "./types.js";
import { Button, EmptyState, IconButton, Modal, Pill, StatusDot, TipSummary, formatDateTime, formatRelativeTime, CheckboxControl, SelectControl } from "./ui.js";
import { CLIENT_LAYOUT_RESET_EVENT } from "../client-layout-reset.js";
import {
  buildUsageLimitScheduleDraft,
  consumeUsageLimitScheduleIntent
} from "../usage-limit-recovery.js";
import { deleteScheduleWithGeneratedSessions, prepareScheduleDeletion, type GeneratedSessionDisposition, type ScheduleDeletionPreview } from "../schedule-deletion.js";
import { ScheduleDeleteDialog } from "./ScheduleDeleteDialog.js";
import { ScheduleRunHistoryCard } from "./ScheduleRunHistoryCard.js";
import { groupScheduleHistoryRuns } from "./schedule-history-grouping.js";

const SCHEDULE_LIST_WIDTH_KEY = "joko.scheduler.listWidth";
const SCHEDULE_COLLAPSED_GROUPS_KEY = "joko.scheduler.collapsedProjects";
const SCHEDULE_STATUS_FILTER_KEY = "joko.scheduler.statusFilter";
const SCHEDULER_RUNTIME_POLL_MS = 1_500;
const PROJECT_AUTOMATION_NOTICE_MS = 2_000;

interface ProjectAutomationNotice {
  readonly id: number;
  readonly message: string;
  readonly tone: "success" | "warning";
}

export function SchedulesPage({ controller, schedules, sessions, targets, models, backends, extraDirectories, focusScheduleId, locale, t, runAction, onOpenNavigation }: {
  readonly controller: AppController;
  readonly schedules: readonly ScheduleView[];
  readonly sessions: readonly SessionView[];
  readonly targets: readonly TargetView[];
  readonly models: readonly ModelView[];
  readonly backends: readonly BackendView[];
  readonly extraDirectories: readonly ExtraDirectoryView[];
  readonly focusScheduleId?: string;
  readonly locale: string;
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onOpenNavigation: () => void;
}): JSX.Element {
  const [deleteSchedule, setDeleteSchedule] = useState<ScheduleView>();
  const [deleteScheduleDisposition, setDeleteScheduleDisposition] = useState<GeneratedSessionDisposition>("keep");
  const [deleteSchedulePreview, setDeleteSchedulePreview] = useState<ScheduleDeletionPreview>();
  const [deleteSchedulePreviewError, setDeleteSchedulePreviewError] = useState<string>();
  const [deleteScheduleOperationError, setDeleteScheduleOperationError] = useState<string>();
  const [deleteSchedulePending, setDeleteSchedulePending] = useState(false);
  const deleteSchedulePreviewRequestRef = useRef(0);
  const [usageRecoveryDraft, setUsageRecoveryDraft] = useState<ScheduleDraft | undefined>(() => {
    const intent = consumeUsageLimitScheduleIntent();
    if (intent === undefined) return undefined;
    return buildUsageLimitScheduleDraft(
      scheduleDraft(undefined, targets, sessions, models, backends),
      intent,
      sessions.find((session) => session.id === intent.sessionId),
      { name: t("scheduler.usageLimitRecoveryName"), prompt: t("scheduler.usageLimitRecoveryPrompt") }
    );
  });
  const [editor, setEditor] = useState<ScheduleView | "new" | undefined>(() => usageRecoveryDraft === undefined ? undefined : "new");
  const [selectedId, setSelectedId] = useState<string>();
  const [statusFilter, setStatusFilter] = useState<ScheduleStatusFilter>(() => readScheduleStatusFilter());
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => readCollapsedGroups());
  const [listWidth, setListWidth] = useState(() => readScheduleListWidth());
  const [resizeOrigin, setResizeOrigin] = useState<{ readonly clientX: number; readonly width: number }>();
  const pendingRunNowRef = useRef<Set<string>>(new Set());
  const [pendingRunNowIds, setPendingRunNowIds] = useState<ReadonlySet<string>>(() => new Set());
  const [runtime, setRuntime] = useState<SchedulerRuntimeView>();
  const [projectNotice, setProjectNotice] = useState<ProjectAutomationNotice>();
  const projectNoticeSequenceRef = useRef(0);
  const [removeProjectSchedule, setRemoveProjectSchedule] = useState<ScheduleView>();
  const visibleSchedules = useMemo(() => filterSchedules(schedules, statusFilter), [schedules, statusFilter]);
  const groups = useMemo(() => groupSchedulesByProject(visibleSchedules, targets, t("scheduler.otherProject")), [targets, t, visibleSchedules]);
  const selectedSchedule = visibleSchedules.find((schedule) => schedule.id === selectedId);
  const allSchedulesEmpty = schedules.length === 0;
  const openNewSchedule = (): void => {
    setUsageRecoveryDraft(undefined);
    setEditor("new");
  };

  useEffect(() => {
    setSelectedId((current) => selectVisibleScheduleId(visibleSchedules, current));
  }, [visibleSchedules]);
  useEffect(() => {
    if (focusScheduleId === undefined) return;
    const focused = schedules.find((schedule) => schedule.id === focusScheduleId);
    if (focused === undefined) return;
    const focusedFilter = scheduleDisplayStatus(focused) === "paused" ? "paused" : "active";
    if (statusFilter !== "all" && statusFilter !== focusedFilter) setStatusFilter(focusedFilter);
    setSelectedId(focused.id);
  }, [focusScheduleId, schedules, statusFilter]);
  useEffect(() => {
    try { window.localStorage.setItem(SCHEDULE_LIST_WIDTH_KEY, String(listWidth)); } catch { /* Client storage can be unavailable. */ }
  }, [listWidth]);
  useEffect(() => {
    const resetLayout = (): void => {
      setListWidth(300);
      setCollapsedGroups(new Set());
    };
    window.addEventListener(CLIENT_LAYOUT_RESET_EVENT, resetLayout);
    return () => window.removeEventListener(CLIENT_LAYOUT_RESET_EVENT, resetLayout);
  }, []);
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let request: AbortController | undefined;
    const poll = (): void => {
      request = new AbortController();
      void controller.getSchedulerRuntime(request.signal).then((snapshot) => {
        if (!disposed) setRuntime(snapshot);
      }).catch(() => {
        // A transient poll failure must not erase the last authoritative
        // snapshot and make capacity or row status briefly look idle.
      }).finally(() => {
        if (!disposed) timer = window.setTimeout(poll, SCHEDULER_RUNTIME_POLL_MS);
      });
    };
    poll();
    return () => {
      disposed = true;
      request?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [controller]);
  useEffect(() => {
    if (resizeOrigin === undefined) return;
    const move = (event: PointerEvent): void => setListWidth(clampScheduleListWidth(resizeOrigin.width + event.clientX - resizeOrigin.clientX));
    const stop = (): void => setResizeOrigin(undefined);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizeOrigin]);
  useEffect(() => {
    if (projectNotice === undefined) return;
    const timer = window.setTimeout(() => {
      setProjectNotice((current) => current?.id === projectNotice.id ? undefined : current);
    }, PROJECT_AUTOMATION_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [projectNotice]);

  const toggleGroup = (groupId: string): void => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      try { window.localStorage.setItem(SCHEDULE_COLLAPSED_GROUPS_KEY, JSON.stringify([...next])); } catch { /* Client storage can be unavailable. */ }
      return next;
    });
  };

  const runScheduleOnce = useCallback((scheduleId: string): void => {
    if (pendingRunNowRef.current.has(scheduleId)) return;
    pendingRunNowRef.current = new Set(pendingRunNowRef.current).add(scheduleId);
    setPendingRunNowIds(pendingRunNowRef.current);
    runAction(`schedule-run:${scheduleId}`, async () => {
      try {
        await controller.runSchedule(scheduleId);
      } finally {
        const next = new Set(pendingRunNowRef.current);
        next.delete(scheduleId);
        pendingRunNowRef.current = next;
        setPendingRunNowIds(next);
      }
    });
  }, [controller, runAction]);

  const selectSchedule = useCallback((schedule: ScheduleView): void => {
    setSelectedId(schedule.id);
    controller.navigate({ kind: "schedules", scheduleId: schedule.id }, { replace: true });
  }, [controller]);

  const showProjectNotice = useCallback((message: string, tone: ProjectAutomationNotice["tone"] = "success"): void => {
    setProjectNotice({ id: ++projectNoticeSequenceRef.current, message, tone });
  }, []);
  const loadScheduleDeletionPreview = useCallback((schedule: ScheduleView): void => {
    const requestId = ++deleteSchedulePreviewRequestRef.current;
    setDeleteSchedulePreview(undefined);
    setDeleteSchedulePreviewError(undefined);
    void prepareScheduleDeletion(controller, schedule, sessions).then((preview) => {
      if (deleteSchedulePreviewRequestRef.current === requestId) setDeleteSchedulePreview(preview);
    }).catch((error: unknown) => {
      if (deleteSchedulePreviewRequestRef.current === requestId) {
        setDeleteSchedulePreviewError(error instanceof Error ? error.message : t("scheduler.deletePreviewFailed"));
      }
    });
  }, [controller, sessions, t]);
  const requestScheduleDeletion = useCallback((schedule: ScheduleView): void => {
    setDeleteScheduleDisposition("keep");
    setDeleteScheduleOperationError(undefined);
    setDeleteSchedule(schedule);
    loadScheduleDeletionPreview(schedule);
  }, [loadScheduleDeletionPreview]);
  const closeScheduleDeletion = useCallback((): void => {
    if (deleteSchedulePending) return;
    deleteSchedulePreviewRequestRef.current += 1;
    setDeleteSchedule(undefined);
  }, [deleteSchedulePending]);
  const confirmScheduleDeletion = useCallback(async (): Promise<void> => {
    const schedule = deleteSchedule;
    if (schedule === undefined || deleteSchedulePending || deleteSchedulePreview === undefined) return;
    setDeleteSchedulePending(true);
    setDeleteScheduleOperationError(undefined);
    try {
      const result = await deleteScheduleWithGeneratedSessions(controller, schedule, deleteScheduleDisposition, sessions);
      deleteSchedulePreviewRequestRef.current += 1;
      setDeleteSchedule(undefined);
      await controller.refresh();
      if (result.failures.length > 0) {
        showProjectNotice(t(
          deleteScheduleDisposition === "archive" ? "scheduler.deletePartialArchive" : "scheduler.deletePartialDelete",
          { failed: result.failures.length, total: result.generatedSessionIds.length }
        ), "warning");
      } else {
        showProjectNotice(t("scheduler.deleteSucceeded"));
      }
    } catch (error) {
      setDeleteScheduleOperationError(error instanceof Error ? error.message : t("error.unexpected"));
    } finally {
      setDeleteSchedulePending(false);
    }
  }, [controller, deleteSchedule, deleteScheduleDisposition, deleteSchedulePending, deleteSchedulePreview, sessions, showProjectNotice, t]);
  const markAllScheduleHistoryRead = useCallback((): void => {
    runAction("schedule-history-mark-all-read", async () => {
      const attentionFailures: string[] = [];
      for (const session of sessions) {
        const attention = session.automationOrigin === undefined || session.attention?.unread !== true
          ? undefined
          : session.attention;
        if (attention === undefined) continue;
        try {
          if (attention.kind === "error") await controller.acknowledgeSessionError(session.id, attention.subjectCursor);
          else await controller.acknowledgeSessionAttention(session.id, attention.subjectCursor);
        } catch {
          attentionFailures.push(session.id);
        }
      }
      const count = await controller.markAllScheduleRunsRead();
      await controller.refresh();
      showProjectNotice(
        attentionFailures.length === 0
          ? t("scheduler.markedRunsRead", { count })
          : t("scheduler.markAllReadPartial", { count, failed: attentionFailures.length }),
        attentionFailures.length === 0 ? "success" : "warning"
      );
    });
  }, [controller, runAction, sessions, showProjectNotice, t]);
  const runProjectAction = useCallback((key: string, action: () => Promise<void>, successMessage: string): void => {
    setProjectNotice(undefined);
    runAction(key, async () => {
      await action();
      await controller.refresh();
      showProjectNotice(successMessage);
    });
  }, [controller, runAction, showProjectNotice]);
  const promoteSchedule = useCallback((schedule: ScheduleView): void => {
    const target = targets.find((candidate) => candidate.id === schedule.targetId);
    const workspace = controller.state.snapshot.workspaces.find((candidate) => candidate.id === target?.workspaceId);
    if (target === undefined || target.remoteWorkspace !== undefined || workspace?.kind !== "userProject") {
      showProjectNotice(t("scheduler.projectPromoteUnavailable"), "warning");
      return;
    }
    runProjectAction(
      `schedule-promote:${schedule.id}`,
      () => controller.promoteScheduleToProject(schedule.id),
      t("scheduler.projectPromoted")
    );
  }, [controller, runProjectAction, showProjectNotice, t, targets]);
  const cloneProjectSchedule = useCallback((schedule: ScheduleView): void => {
    runProjectAction(
      `schedule-clone-personal:${schedule.id}`,
      () => controller.cloneProjectScheduleToUser(schedule.id, t("scheduler.projectCloneName", { name: schedule.name })),
      t("scheduler.projectCloned")
    );
  }, [controller, runProjectAction, t]);
  const reconcileProjectGroup = useCallback((targetIds: readonly string[], name: string): void => {
    runProjectAction(
      `schedule-project-reconcile:${targetIds.join(":")}`,
      async () => {
        for (const targetId of targetIds) await controller.reconcileProjectAutomations(targetId);
      },
      t("scheduler.projectReconciled", { name })
    );
  }, [controller, runProjectAction, t]);
  const confirmRemoveProjectSchedule = useCallback((keepPersonalCopy: boolean): void => {
    const schedule = removeProjectSchedule;
    if (schedule === undefined) return;
    setRemoveProjectSchedule(undefined);
    runProjectAction(
      `schedule-project-remove:${schedule.id}:${keepPersonalCopy ? "personal" : "project"}`,
      () => controller.removeProjectSchedule(schedule.id, keepPersonalCopy),
      t(keepPersonalCopy ? "scheduler.projectDemoted" : "scheduler.projectRemoved")
    );
  }, [controller, removeProjectSchedule, runProjectAction, t]);

  return (
    <main className="route-page scheduler-page">
      {projectNotice !== undefined && <div className={`schedule-project-notice is-${projectNotice.tone}`} role="status" aria-live="polite">
        {projectNotice.tone === "success" ? <CheckCircle2 aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
        <span>{projectNotice.message}</span>
      </div>}
      <header className="route-header schedule-page-header">
        {!controller.state.preferences.navigationOpen && <IconButton className="mobile-panel-toggle" label={t("a11y.openNavigation")} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>}
        <div className="schedule-page-header__copy"><p className="eyebrow">{t("scheduler.eyebrow")}</p><h1>{t("scheduler.title")}</h1><p>{t("scheduler.subtitle")}</p></div>
        <div className="route-header__actions schedule-page-header__actions">{runtime !== undefined && <Pill tone={runtime.waiting.length > 0 ? "warning" : runtime.inFlight > 0 ? "success" : "neutral"}>{t("scheduler.capacity", { used: runtime.slotsInUse, max: runtime.maxConcurrentRuns })}</Pill>}<Pill tone={countActiveSchedules(schedules) > 0 ? "success" : "neutral"}>{t("scheduler.activeCount", { count: countActiveSchedules(schedules) })}</Pill>{schedules.some((schedule) => schedule.unreadRunCount > 0) && <Button onClick={markAllScheduleHistoryRead}><Check aria-hidden="true" />{t("scheduler.markAllRunsRead")}</Button>}{!allSchedulesEmpty && <Button tone="primary" onClick={openNewSchedule}><CirclePlus aria-hidden="true" />{t("scheduler.new")}</Button>}</div>
      </header>
      {allSchedulesEmpty ? <div className="schedule-detail schedule-detail--empty schedule-onboarding-empty"><EmptyState icon={<CalendarClock />} title={t("scheduler.empty")} body={t("scheduler.emptyBody")} action={<Button tone="primary" onClick={openNewSchedule}><CirclePlus aria-hidden="true" />{t("scheduler.new")}</Button>} /></div> : <div className="schedule-workbench">
        <aside className="schedule-master" style={{ width: listWidth }} aria-label={t("scheduler.taskList")}>
          <div className="schedule-master__toolbar">
            <label className="sr-only" htmlFor="schedule-status-filter">{t("scheduler.statusFilter")}</label>
            <SelectControl id="schedule-status-filter" value={statusFilter} onChange={(event) => {
              const next = normalizeScheduleStatusFilter(event.target.value);
              setStatusFilter(next);
              try { window.localStorage.setItem(SCHEDULE_STATUS_FILTER_KEY, next); } catch { /* Client storage can be unavailable. */ }
            }}>
              <option value="active">{t("scheduler.filterActive")}</option>
              <option value="paused">{t("scheduler.filterPaused")}</option>
              <option value="all">{t("scheduler.filterAll")}</option>
            </SelectControl>
            <span aria-label={t("scheduler.visibleCount", { count: visibleSchedules.length })}>{visibleSchedules.length}</span>
          </div>
          <div className="schedule-master__scroll" role="list" aria-label={t("scheduler.taskList")}>
            {groups.length === 0 && <p className="schedule-master__empty">{t("scheduler.filterEmpty")}</p>}
            {groups.map((group) => {
              const collapsed = collapsedGroups.has(group.key);
              const projectTargetIds = [...new Set(group.schedules
                .filter((schedule) => schedule.source === "project")
                .map((schedule) => schedule.targetId))];
              return <section className="schedule-group" key={group.key}>
                <div className="schedule-group__header">
                  <button type="button" className="schedule-group__toggle" aria-expanded={!collapsed} onClick={() => toggleGroup(group.key)}>
                    {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                    <span>{group.name}</span><small>{group.schedules.length}</small>
                  </button>
                  {!collapsed && projectTargetIds.length > 0 && <IconButton
                    label={`${t("scheduler.projectReconcile")} · ${group.name}`}
                    onClick={() => reconcileProjectGroup(projectTargetIds, group.name)}
                  ><RefreshCw aria-hidden="true" /></IconButton>}
                </div>
                {!collapsed && <div className="schedule-group__rows">
                  {group.schedules.map((schedule) => {
                    const selected = schedule.id === selectedId;
                    const status = scheduleDisplayStatus(schedule);
                    const runPending = pendingRunNowIds.has(schedule.id);
                    const runtimeStatus = scheduleRuntimeStatus(runtime, schedule.id);
                    return <div id={`schedule-row-${schedule.id}`} role="listitem" className={`schedule-master__row${selected ? " is-selected" : ""}${status === "paused" ? " is-paused" : ""}`} key={schedule.id}>
                      <button type="button" className="schedule-master__row-main" aria-current={selected ? "true" : undefined} onClick={() => selectSchedule(schedule)} onDoubleClick={() => setEditor(schedule)}>
                        <StatusDot state={runtimeStatus === undefined ? status === "paused" ? "paused" : schedule.lastRun?.state ?? "idle" : "running"} label={runtimeStatus === undefined ? status === "expired" ? t("scheduler.expired") : status === "active" ? t("common.enabled") : t("scheduler.filterPaused") : scheduleRuntimeLabel(runtimeStatus, runtime, t)} />
                        <span><span className="schedule-master__row-title"><strong>{schedule.name}</strong>{schedule.unreadRunCount > 0 && <span className="schedule-run-unread-count" aria-label={t("scheduler.unreadRunCount", { count: schedule.unreadRunCount })}>{schedule.unreadRunCount}</span>}{schedule.source === "project" && <span className="schedule-source-chip" title={t("scheduler.projectSourceTooltip", { path: schedule.projectConfigPath ?? ".joko/automations/schedules.json" })}><FolderGit2 aria-hidden="true" />{t("scheduler.projectSource")}</span>}</span><small>{runtimeStatus !== undefined ? scheduleRuntimeLabel(runtimeStatus, runtime, t) : runPending ? t("scheduler.runtimeLoading") : status === "expired" ? t("scheduler.once") : schedule.nextRunAt === undefined ? scheduleKind(schedule.kind, t) : t("scheduler.nextRunRelative", { time: formatRelativeTime(schedule.nextRunAt, locale) })}</small></span>
                      </button>
                      <div className="schedule-master__row-actions">
                        <IconButton disabled={runPending} label={`${t("scheduler.runNow")} · ${schedule.name}`} onClick={() => runScheduleOnce(schedule.id)}><Play aria-hidden="true" /></IconButton>
                        <ScheduleRowMenu
                          schedule={schedule}
                          expired={status === "expired"}
                          t={t}
                          onEdit={() => setEditor(schedule)}
                          onToggle={() => runAction(`schedule-toggle:${schedule.id}`, () => controller.setScheduleEnabled(schedule.id, !schedule.enabled))}
                          onPromote={() => promoteSchedule(schedule)}
                          onClone={() => cloneProjectSchedule(schedule)}
                          onRemoveProject={() => setRemoveProjectSchedule(schedule)}
                          onDelete={() => requestScheduleDeletion(schedule)}
                        />
                      </div>
                    </div>;
                  })}
                </div>}
              </section>;
            })}
          </div>
          <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t("scheduler.resizeList")} className="schedule-master__resize" onPointerDown={(event) => { event.preventDefault(); setResizeOrigin({ clientX: event.clientX, width: listWidth }); }} onDoubleClick={() => setListWidth(300)} onKeyDown={(event) => {
            if (event.key === "ArrowLeft") { event.preventDefault(); setListWidth((current) => clampScheduleListWidth(current - 16)); }
            if (event.key === "ArrowRight") { event.preventDefault(); setListWidth((current) => clampScheduleListWidth(current + 16)); }
            if (event.key === "Home") { event.preventDefault(); setListWidth(300); }
          }} />
        </aside>
        {selectedSchedule === undefined ? <div className="schedule-detail schedule-detail--empty"><EmptyState icon={<CalendarClock />} title={t("scheduler.selectTask")} body={t("scheduler.selectTaskBody")} /></div> : <ScheduleDetail controller={controller} schedule={selectedSchedule} sessions={sessions} session={sessions.find((candidate) => candidate.id === selectedSchedule.sessionId)} target={targets.find((candidate) => candidate.id === selectedSchedule.targetId)} runtime={runtime} runtimeStatus={scheduleRuntimeStatus(runtime, selectedSchedule.id)} locale={locale} t={t} runPending={pendingRunNowIds.has(selectedSchedule.id)} onRun={() => runScheduleOnce(selectedSchedule.id)} onToggle={() => runAction(`schedule-toggle:${selectedSchedule.id}`, () => controller.setScheduleEnabled(selectedSchedule.id, !selectedSchedule.enabled))} onEdit={() => setEditor(selectedSchedule)} onDelete={() => requestScheduleDeletion(selectedSchedule)} />}
      </div>}
      <ScheduleEditor controller={controller} open={editor !== undefined} schedule={editor === "new" ? undefined : editor} initialDraft={editor === "new" ? usageRecoveryDraft : undefined} targets={targets} sessions={sessions} models={models} backends={backends} extraDirectories={extraDirectories} t={t} onClose={() => { setEditor(undefined); setUsageRecoveryDraft(undefined); }} onSave={(draft) => {
        const scheduleId = editor === "new" ? undefined : editor?.id;
        const projectOwned = editor !== "new" && editor?.source === "project";
        return runScheduleAction(runAction, scheduleId === undefined ? "schedule-create" : `schedule-update:${scheduleId}`, async () => {
          await controller.saveSchedule(scheduleId, draft);
          if (projectOwned) await controller.refresh();
        }).then(() => {
          setEditor(undefined);
          setUsageRecoveryDraft(undefined);
          if (projectOwned) showProjectNotice(t("scheduler.projectUpdated"));
        });
      }} />
      <ScheduleDeleteDialog schedule={deleteSchedule} disposition={deleteScheduleDisposition} generatedCount={deleteSchedulePreview?.generatedSessionIds.length} inflightCount={deleteSchedulePreview?.inflightCount} previewError={deleteSchedulePreviewError} operationError={deleteScheduleOperationError} pending={deleteSchedulePending} t={t} onDispositionChange={setDeleteScheduleDisposition} onRetryPreview={() => { if (deleteSchedule !== undefined) loadScheduleDeletionPreview(deleteSchedule); }} onClose={closeScheduleDeletion} onConfirm={() => void confirmScheduleDeletion()} />
      <Modal
        open={removeProjectSchedule !== undefined}
        title={t("scheduler.projectRemoveTitle")}
        description={t("scheduler.projectRemoveBody", {
          name: removeProjectSchedule?.name ?? "",
          path: removeProjectSchedule?.projectConfigPath ?? ".joko/automations/schedules.json"
        })}
        size="small"
        onClose={() => setRemoveProjectSchedule(undefined)}
      >
        <div className="modal__actions schedule-project-remove-actions">
          <Button onClick={() => setRemoveProjectSchedule(undefined)}>{t("common.cancel")}</Button>
          <Button onClick={() => confirmRemoveProjectSchedule(true)}><Copy aria-hidden="true" />{t("scheduler.projectDemote")}</Button>
          <Button tone="danger" onClick={() => confirmRemoveProjectSchedule(false)}><FolderMinus aria-hidden="true" />{t("scheduler.projectRemoveConfirm")}</Button>
        </div>
      </Modal>
    </main>
  );
}

function ScheduleRowMenu({ schedule, expired, t, onEdit, onToggle, onPromote, onClone, onRemoveProject, onDelete }: {
  readonly schedule: ScheduleView;
  readonly expired: boolean;
  readonly t: Translator;
  readonly onEdit: () => void;
  readonly onToggle: () => void;
  readonly onPromote: () => void;
  readonly onClone: () => void;
  readonly onRemoveProject: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const triggerRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusEdgeRef = useRef<"first" | "last">("first");
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const items = useCallback((): HTMLButtonElement[] => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])], []);
  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);
  const openAndFocus = useCallback((edge: "first" | "last"): void => {
    focusEdgeRef.current = edge;
    setOpen(true);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const ownerWindow = triggerRef.current?.ownerDocument.defaultView;
    if (ownerWindow === null || ownerWindow === undefined) return;
    const frame = ownerWindow.requestAnimationFrame(() => {
      const available = items();
      (focusEdgeRef.current === "first" ? available[0] : available.at(-1))?.focus({ preventScroll: true });
    });
    return () => ownerWindow.cancelAnimationFrame(frame);
  }, [items, open]);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const ownerDocument = trigger?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (trigger === null || trigger === undefined || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const closeOutside = (event: globalThis.PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && (trigger.contains(target) || menuRef.current?.contains(target) === true)) return;
      setOpen(false);
    };
    const closeForViewportChange = (): void => setOpen(false);
    ownerDocument.addEventListener("pointerdown", closeOutside, true);
    ownerDocument.addEventListener("scroll", closeForViewportChange, true);
    ownerWindow.addEventListener("resize", closeForViewportChange);
    return () => {
      ownerDocument.removeEventListener("pointerdown", closeOutside, true);
      ownerDocument.removeEventListener("scroll", closeForViewportChange, true);
      ownerWindow.removeEventListener("resize", closeForViewportChange);
    };
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const available = items();
    if (available.length === 0) return;
    const currentIndex = available.indexOf(event.target as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") next = available[(currentIndex + 1 + available.length) % available.length];
    else if (event.key === "ArrowUp") next = available[(currentIndex - 1 + available.length) % available.length];
    else if (event.key === "Home") next = available[0];
    else if (event.key === "End") next = available.at(-1);
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const prefix = event.key.toLocaleLowerCase();
      for (let offset = 1; offset <= available.length; offset += 1) {
        const candidate = available[(currentIndex + offset + available.length) % available.length];
        if (candidate?.textContent?.trim().toLocaleLowerCase().startsWith(prefix) === true) {
          next = candidate;
          break;
        }
      }
    }
    if (next === undefined) return;
    event.preventDefault();
    next.focus({ preventScroll: true });
  };
  const run = (action: () => void): void => {
    setOpen(false);
    action();
  };
  const projectOwned = schedule.source === "project";

  return <details className="schedule-row-menu" open={open}>
    <TipSummary
      summaryRef={triggerRef}
      label={`${t("common.more")} · ${schedule.name}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      onClick={(event) => {
        event.preventDefault();
        if (open) close(false); else openAndFocus("first");
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        openAndFocus(event.key === "ArrowDown" ? "first" : "last");
      }}
    ><MoreHorizontal aria-hidden="true" /></TipSummary>
    {open && <div ref={menuRef} id={menuId} role="menu" aria-label={`${t("common.more")} · ${schedule.name}`} onKeyDown={onMenuKeyDown}>
      {!projectOwned && <button type="button" role="menuitem" onClick={() => run(onEdit)}><Pencil aria-hidden="true" />{t("scheduler.edit")}</button>}
      <button type="button" role="menuitem" disabled={expired} onClick={() => run(onToggle)}>{schedule.enabled ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{schedule.enabled ? t("common.disable") : t("common.enable")}</button>
      {!projectOwned && <>
        <hr role="separator" />
        <button type="button" role="menuitem" onClick={() => run(onPromote)}><ArrowUpToLine aria-hidden="true" />{t("scheduler.projectPromote")}</button>
        <hr role="separator" />
        <button type="button" role="menuitem" className="danger-text" onClick={() => run(onDelete)}><Trash2 aria-hidden="true" />{t("common.delete")}</button>
      </>}
      {projectOwned && <>
        <button type="button" role="menuitem" onClick={() => run(onEdit)}><Pencil aria-hidden="true" />{t("scheduler.projectEdit")}</button>
        <button type="button" role="menuitem" onClick={() => run(onClone)}><Copy aria-hidden="true" />{t("scheduler.projectClone")}</button>
        <hr role="separator" />
        <button type="button" role="menuitem" onClick={() => run(onRemoveProject)}><FolderMinus aria-hidden="true" />{t("scheduler.projectRemove")}</button>
      </>}
    </div>}
  </details>;
}

function ScheduleDetail({ controller, schedule, sessions, session, target, runtime, runtimeStatus, locale, t, runPending, onRun, onToggle, onEdit, onDelete }: { readonly controller: AppController; readonly schedule: ScheduleView; readonly sessions: readonly SessionView[]; readonly session?: SessionView; readonly target?: TargetView; readonly runtime?: SchedulerRuntimeView; readonly runtimeStatus?: ScheduleRuntimeStatus; readonly locale: string; readonly t: Translator; readonly runPending: boolean; readonly onRun: () => void; readonly onToggle: () => void; readonly onEdit: () => void; readonly onDelete: () => void }): JSX.Element {
  const [history, setHistory] = useState(schedule.history);
  const [nextPageToken, setNextPageToken] = useState<string>();
  const [totalSize, setTotalSize] = useState(schedule.history.length);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [historyNotice, setHistoryNotice] = useState<string>();
  const [pendingHistoryRunId, setPendingHistoryRunId] = useState<string>();
  const [deleteHistoryRun, setDeleteHistoryRun] = useState<ScheduleView["history"][number]>();
  const [expandedHistorySessionIds, setExpandedHistorySessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const historyRequestRef = useRef(0);
  const recentHistoryRef = useRef(schedule.history);
  recentHistoryRef.current = schedule.history;
  const displayStatus = scheduleDisplayStatus(schedule);
  const historyEntries = useMemo(
    () => groupScheduleHistoryRuns(history, schedule.sessionMode === "persistent" || schedule.sessionMode === "bound"),
    [history, schedule.sessionMode]
  );
  const currentGroupedSessionId = historyEntries.find((entry) => entry.kind === "session")?.sessionId;
  useEffect(() => {
    setHistory(schedule.history);
    setNextPageToken(undefined);
    setTotalSize(schedule.history.length);
    setHistoryError(undefined);
    setHistoryNotice(undefined);
    setDeleteHistoryRun(undefined);
    setExpandedHistorySessionIds(new Set());
    setHistoryLoading(true);
    const requestId = historyRequestRef.current + 1;
    historyRequestRef.current = requestId;
    let current = true;
    void controller.listScheduleRunHistory(schedule.id, "", 20).then((page) => {
      if (!current || historyRequestRef.current !== requestId) return;
      setHistory(reconcileScheduleHistory(page.history, recentHistoryRef.current));
      setNextPageToken(page.nextPageToken);
      setTotalSize(Math.max(page.totalSize, recentHistoryRef.current.length));
    }).catch((cause: unknown) => {
      if (current && historyRequestRef.current === requestId) setHistoryError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (current && historyRequestRef.current === requestId) setHistoryLoading(false);
    });
    return () => { current = false; };
  }, [controller, schedule.id]);
  useEffect(() => {
    setHistory((current) => reconcileScheduleHistory(current, schedule.history));
    setTotalSize((current) => Math.max(current, schedule.history.length));
  }, [schedule.history]);
  const loadHistory = (pageToken = ""): void => {
    setHistoryLoading(true);
    setHistoryError(undefined);
    const requestId = historyRequestRef.current + 1;
    historyRequestRef.current = requestId;
    void controller.listScheduleRunHistory(schedule.id, pageToken, 20).then((page) => {
      if (historyRequestRef.current !== requestId) return;
      setHistory((current) => pageToken.length === 0 ? page.history : dedupeHistory([...current, ...page.history]));
      setNextPageToken(page.nextPageToken);
      setTotalSize(Math.max(page.totalSize, recentHistoryRef.current.length));
    }).catch((cause: unknown) => {
      if (historyRequestRef.current === requestId) setHistoryError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (historyRequestRef.current === requestId) setHistoryLoading(false);
    });
  };
  const markRunRead = (run: ScheduleView["history"][number]): void => {
    if (run.state === "running" || run.state === "skipped" || run.readAt !== undefined || pendingHistoryRunId !== undefined) return;
    setPendingHistoryRunId(run.id);
    setHistoryError(undefined);
    void controller.markScheduleRunRead(schedule.id, run.id).then(() => {
      const readAt = Date.now();
      setHistory((current) => current.map((candidate) => candidate.id === run.id ? { ...candidate, readAt } : candidate));
    }).catch((error: unknown) => {
      setHistoryError(error instanceof Error ? error.message : t("error.unexpected"));
    }).finally(() => setPendingHistoryRunId(undefined));
  };
  const markScheduleHistoryRead = (): void => {
    if (pendingHistoryRunId !== undefined) return;
    setPendingHistoryRunId("*");
    setHistoryError(undefined);
    void controller.markScheduleRunsRead(schedule.id).then((count) => {
      const readAt = Date.now();
      setHistory((current) => current.map((run) => run.state === "running" || run.state === "skipped" || run.readAt !== undefined ? run : { ...run, readAt }));
      setHistoryNotice(t("scheduler.markedRunsRead", { count }));
      void controller.refresh();
    }).catch((error: unknown) => {
      setHistoryError(error instanceof Error ? error.message : t("error.unexpected"));
    }).finally(() => setPendingHistoryRunId(undefined));
  };
  const restartHistoryRun = (run: ScheduleView["history"][number]): void => {
    if (run.sessionId.length > 0 || (run.state !== "aborted" && run.state !== "interrupted") || pendingHistoryRunId !== undefined) return;
    setPendingHistoryRunId(run.id);
    setHistoryError(undefined);
    void controller.restartScheduleRun(schedule.id, run.id).then(() => {
      setHistoryNotice(t("scheduler.runRestarted"));
      loadHistory();
    }).catch((error: unknown) => {
      setHistoryError(error instanceof Error ? error.message : t("error.unexpected"));
    }).finally(() => setPendingHistoryRunId(undefined));
  };
  const confirmDeleteHistoryRun = (): void => {
    const run = deleteHistoryRun;
    if (run === undefined || run.state === "running" || pendingHistoryRunId !== undefined) return;
    setPendingHistoryRunId(run.id);
    setHistoryError(undefined);
    void controller.deleteScheduleRun(schedule.id, run.id).then(() => {
      setHistory((current) => current.filter((candidate) => candidate.id !== run.id));
      setTotalSize((current) => Math.max(0, current - 1));
      setDeleteHistoryRun(undefined);
      setHistoryNotice(t("scheduler.runDeleted"));
    }).catch((error: unknown) => {
      setHistoryError(error instanceof Error ? error.message : t("error.unexpected"));
    }).finally(() => setPendingHistoryRunId(undefined));
  };
  const toggleHistorySession = (sessionId: string): void => {
    setExpandedHistorySessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId);
      return next;
    });
  };
  const renderHistoryRun = (run: ScheduleView["history"][number]): JSX.Element => <ScheduleRunHistoryCard
    run={run}
    sessionAvailable={run.sessionId.length > 0 && sessions.some((candidate) => candidate.id === run.sessionId)}
    locale={locale}
    t={t}
    pending={pendingHistoryRunId === run.id || pendingHistoryRunId === "*"}
    onMarkRead={markRunRead}
    onOpenTask={(candidate) => {
      if (!controller.state.snapshot.sessions.some((current) => current.id === candidate.sessionId)) {
        setHistoryError(t("scheduler.runTaskUnavailable"));
        return;
      }
      markRunRead(candidate);
      controller.navigate({ kind: "session", sessionId: candidate.sessionId });
    }}
    onRestart={restartHistoryRun}
    onDelete={setDeleteHistoryRun}
  />;
  return (
    <article className="schedule-detail">
      <header className="schedule-detail__header">
        <div><h2>{schedule.name}</h2><p>{target?.workspaceName ?? target?.name ?? schedule.targetId} · {session?.name ?? scheduleSessionModeLabel(schedule.sessionMode, t)}</p></div>
        <div className="schedule-detail__actions"><Button tone="primary" disabled={runPending} onClick={onRun}><Play aria-hidden="true" />{t("scheduler.runNow")}</Button><Button onClick={onEdit}><Pencil aria-hidden="true" />{t("scheduler.edit")}</Button><Button disabled={displayStatus === "expired"} onClick={onToggle}>{schedule.enabled ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{schedule.enabled ? t("common.disable") : t("common.enable")}</Button><Button tone="ghost" className="danger-text" onClick={onDelete}><Trash2 aria-hidden="true" />{t("common.delete")}</Button></div>
      </header>
      <dl className="schedule-facts">
        {runtimeStatus !== undefined && <div><dt>{t("scheduler.runtimeStatus")}</dt><dd><Pill tone={runtimeStatus.kind === "capacity" ? "warning" : "success"}>{scheduleRuntimeLabel(runtimeStatus, runtime, t)}</Pill></dd></div>}
        {runtimeStatus?.kind === "run" && <div><dt>{t("scheduler.fireSource")}</dt><dd>{runtimeStatus.run.source === "runNow" ? t("scheduler.sourceRunNow") : t("scheduler.sourceAutomatic")}</dd></div>}
        {runtimeStatus?.kind === "run" && <div><dt>{t("scheduler.lastProgress")}</dt><dd>{formatRelativeTime(runtimeStatus.run.lastProgressAt, locale)}</dd></div>}
        <div><dt>{t("scheduler.type")}</dt><dd><Pill>{scheduleKind(schedule.kind, t)}</Pill></dd></div>
        <div><dt>{t("scheduler.expression")}</dt><dd><code>{schedule.expression || t("scheduler.manual")}</code></dd></div>
        <div><dt>{t("scheduler.timezone")}</dt><dd>{schedule.timezone}</dd></div>
        <div><dt>{t("scheduler.executionMode")}</dt><dd>{schedule.executionMode === "script" ? t("scheduler.executionScript") : t("scheduler.executionAgent")}</dd></div>
        <div><dt>{t("scheduler.sessionMode")}</dt><dd>{scheduleSessionModeLabel(schedule.sessionMode, t)}</dd></div>
        <div><dt>{t("worktree.title")}</dt><dd>{schedule.useWorktree ? t("common.enabled") : t("common.disabled")}</dd></div>
        {schedule.useWorktree && <div><dt>{t("worktree.source")}</dt><dd><code>{schedule.worktreeSourceRef ?? t("worktree.defaultSource")}</code></dd></div>}
        {schedule.useWorktree && <div><dt>{t("worktree.refreshRemote")}</dt><dd>{schedule.refreshWorktreeRemote ? t("common.enabled") : t("common.disabled")}</dd></div>}
        <div><dt>{t("scheduler.nextRun")}</dt><dd>{schedule.nextRunAt === undefined ? displayStatus === "expired" ? t("scheduler.expired") : "—" : <><Clock3 aria-hidden="true" />{formatScheduleDateTime(schedule.nextRunAt, locale, schedule.timezone)} <small>({formatRelativeTime(schedule.nextRunAt, locale)})</small></>}</dd></div>
        <div><dt>{t("scheduler.permission")}</dt><dd>{schedule.permissionMode}</dd></div>
        <div><dt>{t("scheduler.overlap")}</dt><dd>{schedule.overlapPolicy}</dd></div>
        <div><dt>{t("scheduler.notification")}</dt><dd>{schedule.notifyDesktop ? t("common.enabled") : t("common.disabled")}</dd></div>
        {schedule.expireAt !== undefined && <div><dt>{t("scheduler.expiresAt")}</dt><dd>{formatScheduleDateTime(schedule.expireAt, locale, schedule.timezone)}</dd></div>}
      </dl>
      <section className="schedule-detail__input"><h3>{schedule.executionMode === "script" ? t("scheduler.scriptCommand") : t("scheduler.scheduledInput")}</h3>{schedule.executionMode === "script" ? <code>{schedule.script?.command ?? ""}</code> : <p>{schedule.inputText}</p>}</section>
      {schedule.preRunHook !== undefined && <section className="schedule-detail__input"><h3>{t("scheduler.managedPreRunHook")}</h3><code>{schedule.preRunHook.command}</code><small>{schedule.preRunHook.filePath}</small></section>}
      <section className="schedule-history">
        <header><h3><History aria-hidden="true" />{t("scheduler.history")}</h3><div><span>{t("scheduler.historyCount", { shown: history.length, total: totalSize })}</span>{schedule.unreadRunCount > 0 && <Button tone="ghost" disabled={pendingHistoryRunId !== undefined} onClick={markScheduleHistoryRead}><Check aria-hidden="true" />{t("scheduler.markScheduleRunsRead")}</Button>}</div></header>
        {history.length === 0 && !historyLoading && <div className="schedule-history__empty"><History aria-hidden="true" /><p>{t("scheduler.noRuns")}</p></div>}
        {history.length > 0 && <ol>{historyEntries.map((entry) => {
          if (entry.kind === "run") return <li key={entry.key}>{renderHistoryRun(entry.run)}</li>;
          const currentSession = entry.sessionId === currentGroupedSessionId;
          const expanded = expandedHistorySessionIds.has(entry.sessionId);
          const visibleRuns = expanded ? entry.runs : currentSession ? entry.runs.slice(0, 3) : [];
          const hiddenCount = entry.runs.length - visibleRuns.length;
          const canToggle = !currentSession || entry.runs.length > 3;
          return <li key={entry.key} className="schedule-history-session-group">
            <button type="button" className="schedule-history-session-group__toggle" disabled={!canToggle} aria-expanded={expanded || (currentSession && hiddenCount === 0)} onClick={() => toggleHistorySession(entry.sessionId)}>
              <span>{t("scheduler.persistentSessionRuns", { session: entry.sessionId.slice(0, 8), count: entry.runs.length })}</span>
              {canToggle && <><small>{expanded ? t("scheduler.collapseRuns") : currentSession ? t("scheduler.expandRemainingRuns", { count: hiddenCount }) : t("scheduler.expandSessionRuns", { count: entry.runs.length })}</small><ChevronDown className={expanded ? "is-expanded" : undefined} aria-hidden="true" /></>}
            </button>
            {visibleRuns.length > 0 && <ol>{visibleRuns.map((run) => <li key={run.id}>{renderHistoryRun(run)}</li>)}</ol>}
          </li>;
        })}</ol>}
        {historyNotice !== undefined && <p className="schedule-history__notice" role="status">{historyNotice}</p>}
        {historyError !== undefined && <p className="inline-error" role="alert">{historyError}</p>}
        {historyLoading && <p className="schedule-history__loading">{t("common.loading")}</p>}
        {nextPageToken !== undefined && <Button tone="ghost" disabled={historyLoading} onClick={() => loadHistory(nextPageToken)}>{historyLoading ? t("common.loading") : t("scheduler.loadMore")}</Button>}
      </section>
      <Modal open={deleteHistoryRun !== undefined} title={t("scheduler.deleteRunTitle")} description={t("scheduler.deleteRunBody")} size="small" dialogRole="alertdialog" dismissOnBackdrop={pendingHistoryRunId === undefined} onClose={() => { if (pendingHistoryRunId === undefined) setDeleteHistoryRun(undefined); }}>
        <div className="modal__actions"><Button disabled={pendingHistoryRunId !== undefined} onClick={() => setDeleteHistoryRun(undefined)}>{t("common.cancel")}</Button><Button tone="danger" disabled={pendingHistoryRunId !== undefined} onClick={confirmDeleteHistoryRun}><Trash2 aria-hidden="true" />{t("scheduler.deleteRun")}</Button></div>
      </Modal>
    </article>
  );
}

function readScheduleListWidth(): number {
  try { return clampScheduleListWidth(Number(window.localStorage.getItem(SCHEDULE_LIST_WIDTH_KEY) ?? 300)); } catch { return 300; }
}

function readScheduleStatusFilter(): ScheduleStatusFilter {
  try { return normalizeScheduleStatusFilter(window.localStorage.getItem(SCHEDULE_STATUS_FILTER_KEY)); } catch { return "all"; }
}

function readCollapsedGroups(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(SCHEDULE_COLLAPSED_GROUPS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  } catch { return new Set(); }
}

function dedupeHistory(history: ScheduleView["history"]): ScheduleView["history"] {
  return [...new Map(history.map((run) => [run.id, run] as const)).values()];
}

function ScheduleEditor({ controller, open, schedule, initialDraft, targets, sessions, models, backends, extraDirectories, t, onClose, onSave }: { readonly controller: AppController; readonly open: boolean; readonly schedule?: ScheduleView; readonly initialDraft?: ScheduleDraft; readonly targets: readonly TargetView[]; readonly sessions: readonly SessionView[]; readonly models: readonly ModelView[]; readonly backends: readonly BackendView[]; readonly extraDirectories: readonly ExtraDirectoryView[]; readonly t: Translator; readonly onClose: () => void; readonly onSave: (draft: ScheduleDraft) => Promise<void> }): JSX.Element {
  const workspaces = controller.state.snapshot.workspaces;
  const templates = scheduleTemplateCatalog(t);
  const templateCategories = scheduleTemplateCategories(t);
  const [draft, setDraft] = useState<ScheduleDraft>(() => initialDraft ?? scheduleDraft(schedule, targets, sessions, models, backends));
  const [templateId, setTemplateId] = useState<ScheduleTemplateId | "">("");
  const [templateParameters, setTemplateParameters] = useState<Readonly<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [worktreeProbe, setWorktreeProbe] = useState<TargetWorktreeProbeView>();
  const [worktreeSources, setWorktreeSources] = useState<readonly WorktreeSourceView[]>([]);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string>();
  const worktreeProbeSequenceRef = useRef(0);
  const projectOwned = schedule?.source === "project";
  useEffect(() => {
    setDraft(initialDraft ?? scheduleDraft(schedule, targets, sessions, models, backends));
    setTemplateId("");
    setTemplateParameters({});
    setSaving(false);
    setSaveError(undefined);
  }, [initialDraft, open, schedule?.id]);
  useEffect(() => {
    const sequence = ++worktreeProbeSequenceRef.current;
    const target = targets.find((candidate) => candidate.id === draft.targetId);
    const workspace = target === undefined ? undefined : workspaces.find((candidate) => candidate.id === target.workspaceId);
    if (!open || target === undefined || workspace?.kind !== "userProject"
      || draft.executionMode !== "agent" || draft.sessionMode !== "fresh") {
      setWorktreeProbe(undefined);
      setWorktreeSources([]);
      setWorktreeLoading(false);
      setWorktreeError(undefined);
      return;
    }
    const abort = new AbortController();
    setWorktreeProbe(undefined);
    setWorktreeSources([]);
    setWorktreeLoading(true);
    setWorktreeError(undefined);
    void controller.probeTargetWorktree(target.id, abort.signal).then(async (probe) => {
      if (abort.signal.aborted || sequence !== worktreeProbeSequenceRef.current) return;
      setWorktreeProbe(probe);
      if (!probe.canRefreshRemote) {
        setDraft((current) => ({ ...current, refreshWorktreeRemote: false }));
      }
      if (probe.eligibility !== "eligible") return;
      const sources = await controller.listTargetWorktreeSources(target.id, abort.signal);
      if (abort.signal.aborted || sequence !== worktreeProbeSequenceRef.current) return;
      setWorktreeSources(sources);
      setDraft((current) => ({
        ...current,
        worktreeSourceRef: sources.some((source) => source.ref === current.worktreeSourceRef)
          ? current.worktreeSourceRef
          : sources.find((source) => source.current)?.ref ?? sources[0]?.ref
      }));
    }).catch((cause: unknown) => {
      if (abort.signal.aborted || sequence !== worktreeProbeSequenceRef.current) return;
      setWorktreeError(cause instanceof Error ? cause.message : "Could not inspect isolated workspace support.");
    }).finally(() => {
      if (!abort.signal.aborted && sequence === worktreeProbeSequenceRef.current) setWorktreeLoading(false);
    });
    return () => abort.abort();
  }, [controller, draft.executionMode, draft.sessionMode, draft.targetId, open, targets, workspaces]);
  const matchingSessions = useMemo(() => sessions.filter((session) => session.targetId === draft.targetId), [draft.targetId, sessions]);
  const selectedTemplate = templates.find((template) => template.id === templateId);
  const templateReady = selectedTemplate !== undefined && selectedTemplate.parameters.every((parameter) =>
    !parameter.required || (templateParameters[parameter.key]?.trim() ?? parameter.defaultValue?.trim() ?? "") !== ""
  );
  const backend = backends.find((candidate) => candidate.id === draft.backendId);
  const modelKey = `${draft.providerId}\u0000${draft.modelId}`;
  const execution = resolveNewSessionExecutionOptions(backend, models, modelKey);
  const pickerBackendDefaults = controller.state.snapshot.settings.backendSettings.find((settings) => settings.backendId === backend?.id);
  const pickerDefaultModel = pickerBackendDefaults?.model === undefined
    ? execution.availableModels[0]
    : execution.availableModels.find((model) =>
        model.providerId === pickerBackendDefaults.model?.providerId && model.modelId === pickerBackendDefaults.model.modelId);
  const pickerDefaultSelection: ModelPickerSelection | undefined = pickerDefaultModel === undefined ? undefined : {
    backendId: pickerDefaultModel.backendId,
    providerId: pickerDefaultModel.providerId,
    modelId: pickerDefaultModel.modelId,
    ...(pickerBackendDefaults?.model?.effort !== undefined && pickerDefaultModel.efforts.includes(pickerBackendDefaults.model.effort)
      ? { effort: pickerBackendDefaults.model.effort }
      : pickerDefaultModel.efforts[0] === undefined ? {} : { effort: pickerDefaultModel.efforts[0] }),
    fastMode: execution.fastModeSupported && pickerDefaultModel.supportsFast && (pickerBackendDefaults?.model?.fastMode ?? false)
  };
  const targetOptions = targets.filter((target) => !target.archived && (target.id === draft.targetId || scheduleTargetAvailable(target, backends)));
  const selectedTarget = targets.find((target) => target.id === draft.targetId);
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedTarget?.workspaceId);
  const worktreeCompatible = draft.executionMode === "agent" && draft.sessionMode === "fresh"
    && selectedWorkspace?.kind === "userProject";
  const worktreeEligible = worktreeProbe?.eligibility === "eligible";
  const worktreeHardIneligible = worktreeProbe !== undefined
    && worktreeProbe.eligibility !== "eligible" && worktreeProbe.eligibility !== "unavailable";
  const worktreeValid = !draft.useWorktree || (
    worktreeCompatible && !worktreeHardIneligible && (
      !draft.enabled || (worktreeEligible && !worktreeLoading && worktreeError === undefined)
    )
  );
  const selectableExtraDirectories = extraDirectories.filter((directory) => directory.workspaceId === selectedTarget?.workspaceId && directory.trusted);
  const extraDirectoriesSupported = backend?.capabilities.get("workspace.extra_dirs")?.supported === true;
  const validScriptTimeout = draft.scriptTimeoutMs === undefined || (Number.isSafeInteger(draft.scriptTimeoutMs) && draft.scriptTimeoutMs > 0);
  const valid = draft.name.trim().length > 0 && draft.targetId.length > 0 &&
    (draft.executionMode === "script" || draft.sessionMode !== "bound" || draft.sessionId.length > 0) &&
    (draft.executionMode === "script" ? draft.scriptCommand.trim().length > 0 && validScriptTimeout : draft.inputText.trim().length > 0) &&
    worktreeValid &&
    validExpression(draft);
  const updateTarget = (targetId: string): void => {
    const target = targets.find((candidate) => candidate.id === targetId);
    const workspace = workspaces.find((candidate) => candidate.id === target?.workspaceId);
    const session = sessions.find((candidate) => candidate.targetId === targetId);
    const model = session?.model;
    setDraft((current) => ({
      ...current,
      targetId,
      backendId: target?.backendId ?? session?.backendId ?? "",
      sessionId: current.executionMode === "script" ? "" : current.sessionMode === "bound" ? session?.id ?? "" : "",
      providerId: model?.providerId ?? "",
      modelId: model?.modelId ?? "",
      effort: model?.efforts[0],
      fastMode: false,
      extraDirectoryIds: [],
      ...(workspace?.kind === "userProject" ? {} : {
        useWorktree: false,
        worktreeSourceRef: undefined,
        refreshWorktreeRemote: false
      })
    }));
  };
  const timezoneInvalid = draft.timezone.trim().length > 0 && !isValidScheduleTimeZone(draft.timezone);
  const onceEpoch = draft.kind === "once" && !timezoneInvalid
    ? scheduleEpochFromLocalDateTime(draft.expression, draft.timezone)
    : undefined;
  const onceInvalid = draft.kind === "once" && draft.expression.length > 0 && !timezoneInvalid && onceEpoch === undefined;
  const oncePast = draft.kind === "once" && draft.enabled && onceEpoch !== undefined && onceEpoch <= Date.now();
  return <Modal open={open} title={schedule === undefined ? t("scheduler.editorNew") : `${t("scheduler.editorEdit")} · ${schedule.name}`} description={t("scheduler.editorBody")} size="large" onClose={() => { if (!saving) onClose(); }}>
    <form className="schedule-editor" onSubmit={(event) => {
      event.preventDefault();
      if (!valid || saving) return;
      setSaving(true);
      setSaveError(undefined);
      void onSave(draft).catch((cause: unknown) => setSaveError(cause instanceof Error ? cause.message : String(cause))).finally(() => setSaving(false));
    }}>
      {schedule === undefined && <fieldset className="schedule-editor__execution"><legend>{t("scheduler.templateHeading")}</legend>
        <div className="schedule-editor__grid">
          <label className="field"><span>{t("scheduler.templateUseTemplate")}</span><SelectControl value={templateId} onChange={(event) => {
            const id = event.target.value as ScheduleTemplateId | "";
            const template = templates.find((candidate) => candidate.id === id);
            setTemplateId(id);
            setTemplateParameters(template === undefined ? {} : initialScheduleTemplateParameters(template));
          }}>
            <option value="">{t("scheduler.templateBlank")}</option>
            {templateCategories.map((category) => <optgroup label={category.name} key={category.id}>{templates.filter((template) => template.categoryId === category.id).map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}</optgroup>)}
          </SelectControl></label>
          {selectedTemplate?.parameters.map((parameter) => <label className="field" key={parameter.key}><span>{parameter.label}</span><input required={parameter.required} value={templateParameters[parameter.key] ?? ""} placeholder={parameter.placeholder} onChange={(event) => setTemplateParameters((current) => ({ ...current, [parameter.key]: event.target.value }))} /></label>)}
        </div>
        {selectedTemplate !== undefined && <>
          <p className="muted">{selectedTemplate.description}</p>
          <div className="schedule-editor__toggles" aria-label={t("scheduler.templateParameters")}>{selectedTemplate.capabilities.map((capability) => <Pill key={capability}>{scheduleTemplateCapabilityLabel(capability, t)}</Pill>)}</div>
          <Button disabled={!templateReady || saving} onClick={() => {
            if (selectedTemplate === undefined || !templateReady) return;
            const patch = scheduleTemplateDraftPatch(selectedTemplate, templateParameters);
            setDraft((current) => ({ ...current, ...patch }));
          }}>{t("scheduler.templateUseTemplate")}</Button>
        </>}
      </fieldset>}
      <div className="schedule-editor__grid">
        <label className="field"><span>{t("scheduler.name")}</span><input autoFocus required value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
        <label className="field"><span>{t("scheduler.target")}</span><SelectControl required disabled={projectOwned} value={draft.targetId} onChange={(event) => updateTarget(event.target.value)}><option value="">—</option>{targetOptions.map((target) => <option value={target.id} key={target.id}>{target.name}</option>)}</SelectControl></label>
        <label className="field"><span>{t("scheduler.executionMode")}</span><SelectControl value={draft.executionMode} onChange={(event) => setDraft((current) => {
          const executionMode = event.target.value as ScheduleDraft["executionMode"];
          return {
            ...current,
            executionMode,
            ...(executionMode === "script" ? {
              sessionMode: "fresh" as const,
              sessionId: "",
              silentWhenIdle: false,
              useWorktree: false,
              worktreeSourceRef: undefined,
              refreshWorktreeRemote: false
            } : {})
          };
        })}><option value="agent">{t("scheduler.executionAgent")}</option><option value="script">{t("scheduler.executionScript")}</option></SelectControl></label>
        <label className="field"><span>{t("scheduler.sessionMode")}</span><SelectControl disabled={draft.executionMode === "script"} value={draft.sessionMode} onChange={(event) => setDraft((current) => {
          const sessionMode = event.target.value as ScheduleDraft["sessionMode"];
          return {
            ...current,
            sessionMode,
            sessionId: sessionMode === "fresh"
              ? ""
              : sessionMode === "bound"
                ? current.sessionId || matchingSessions[0]?.id || ""
                : current.sessionId,
            ...(sessionMode === "fresh" ? {} : {
              useWorktree: false,
              worktreeSourceRef: undefined,
              refreshWorktreeRemote: false
            })
          };
        })}><option value="fresh">{t("scheduler.sessionFresh")}</option><option value="persistent">{t("scheduler.sessionPersistent")}</option>{!projectOwned && <option value="bound">{t("scheduler.sessionBound")}</option>}</SelectControl></label>
        {draft.executionMode === "agent" && draft.sessionMode === "bound" && <label className="field"><span>{t("scheduler.session")}</span><SelectControl required value={draft.sessionId} onChange={(event) => {
          const session = sessions.find((candidate) => candidate.id === event.target.value);
          setDraft((current) => ({ ...current, sessionId: event.target.value, backendId: session?.backendId ?? current.backendId, providerId: session?.model?.providerId ?? "", modelId: session?.model?.modelId ?? "", effort: session?.effort, fastMode: session?.fastMode ?? false, permissionMode: session?.permissionMode ?? current.permissionMode, planMode: session?.planMode ?? current.planMode }));
        }}><option value="">—</option>{matchingSessions.map((session) => <option value={session.id} key={session.id}>{session.name}</option>)}</SelectControl></label>}
        <label className="field"><span>{t("scheduler.recurrence")}</span><SelectControl value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as ScheduleDraft["kind"], expression: defaultExpression(event.target.value as ScheduleDraft["kind"], current.timezone) }))}><option value="manual">{t("scheduler.manual")}</option><option value="once">{t("scheduler.once")}</option><option value="interval">{t("scheduler.interval")}</option><option value="cron">{t("scheduler.cron")}</option></SelectControl></label>
        {draft.kind !== "manual" && <label className="field"><span>{draft.kind === "once" ? t("scheduler.triggerAt") : draft.kind === "interval" ? t("scheduler.intervalSeconds") : t("scheduler.cronExpression")}</span><input required aria-invalid={onceInvalid || oncePast || undefined} type={draft.kind === "once" ? "datetime-local" : draft.kind === "interval" ? "number" : "text"} min={draft.kind === "interval" ? 1 : undefined} value={draft.expression} onChange={(event) => setDraft((current) => ({ ...current, expression: event.target.value }))} placeholder={draft.kind === "cron" ? "0 9 * * 1-5" : undefined} />{onceInvalid && <small className="inline-error">{t("scheduler.invalidOneShot")}</small>}{oncePast && <small className="inline-error">{t("scheduler.oneShotPast")}</small>}</label>}
        <label className="field"><span>{t("scheduler.timezone")}</span><input required list="schedule-time-zone-options" aria-invalid={timezoneInvalid || undefined} value={draft.timezone} onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))} />{timezoneInvalid && <small className="inline-error">{t("scheduler.invalidTimezone")}</small>}</label>
        <datalist id="schedule-time-zone-options">{scheduleTimeZoneOptions(draft.timezone).map((timezone) => <option value={timezone} key={timezone} />)}</datalist>
      </div>
      {draft.executionMode === "agent" ? <label className="interaction-input"><span>{t("scheduler.scheduledInput")}</span><textarea required rows={5} value={draft.inputText} onChange={(event) => setDraft((current) => ({ ...current, inputText: event.target.value }))} placeholder={t("scheduler.inputPlaceholder")} /></label> : <label className="interaction-input"><span>{t("scheduler.scriptCommand")}</span><textarea required rows={5} spellCheck={false} value={draft.scriptCommand} onChange={(event) => setDraft((current) => ({ ...current, scriptCommand: event.target.value }))} placeholder={t("scheduler.scriptCommandPlaceholder")} /></label>}
      {(worktreeCompatible || draft.useWorktree) && <section className="new-task-worktree" aria-label={t("worktree.title")}>
        <header>
          <span><GitBranch aria-hidden="true" /><strong>{t("worktree.title")}</strong></span>
          <label className="new-task-worktree__toggle"><CheckboxControl checked={draft.useWorktree} disabled={saving || worktreeLoading || (!worktreeEligible && !draft.useWorktree)} onChange={(event) => setDraft((current) => ({ ...current, useWorktree: event.target.checked }))} /><span>{t("worktree.enable")}</span></label>
        </header>
        {worktreeLoading && <p className="muted" role="status">{t("worktree.checking")}</p>}
        {!worktreeCompatible && <p className="muted">{t("worktree.ineligible.unavailable")}</p>}
        {worktreeError !== undefined && <p className="inline-error" role="alert">{worktreeError}</p>}
        {!worktreeLoading && worktreeError === undefined && worktreeProbe !== undefined && worktreeProbe.eligibility !== "eligible" && <p className="muted">{t(worktreeEligibilityMessage(worktreeProbe.eligibility))}</p>}
        {worktreeEligible && <div className="new-task-worktree__options">
          <label><span>{t("worktree.source")}</span><SelectControl value={draft.worktreeSourceRef ?? ""} disabled={saving || worktreeSources.length === 0} onChange={(event) => setDraft((current) => ({ ...current, worktreeSourceRef: event.target.value || undefined }))}>
            {worktreeSources.length === 0 && <option value="">{worktreeProbe?.currentBranch ?? t("worktree.defaultSource")}</option>}
            {worktreeSources.map((source) => <option value={source.ref} key={`${source.ref}\u0000${source.commit}`}>{source.name}{source.current ? ` · ${t("worktree.current")}` : ""}</option>)}
          </SelectControl></label>
          {worktreeProbe?.canRefreshRemote && <label className="new-task-worktree__refresh"><CheckboxControl checked={draft.refreshWorktreeRemote} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, refreshWorktreeRemote: event.target.checked }))} /><span>{t("worktree.refreshRemote")}</span></label>}
        </div>}
      </section>}
      <fieldset className="schedule-editor__execution"><legend>{t("scheduler.execution")}</legend><div className="schedule-editor__grid">
        {draft.executionMode === "agent" && <>
          <div className="field"><span>{t("scheduler.model")}</span><ModelPicker
            className="schedule-editor__model-picker"
            models={execution.modelSwitchSupported
              ? execution.availableModels
              : execution.selectedModel === undefined ? [] : [execution.selectedModel]}
            ownerId={modelPreferenceOwnerId(controller.state.activeProfile?.serverId)}
            value={draft.modelId.length === 0 ? undefined : {
              backendId: draft.backendId,
              providerId: draft.providerId,
              modelId: draft.modelId,
              ...(draft.effort === undefined ? {} : { effort: draft.effort }),
              fastMode: draft.fastMode
            }}
            allowDefault={execution.modelSwitchSupported}
            defaultLabel={t("scheduler.taskDefault")}
            seedDefault={pickerDefaultSelection}
            disabled={!execution.modelSelectable && !(draft.modelId.length > 0 && (execution.effortSupported || execution.fastModeSupported))}
            disabledReason={!execution.modelSelectable && !(draft.modelId.length > 0 && (execution.effortSupported || execution.fastModeSupported)) ? t("common.unavailable") : undefined}
            effortEnabled={execution.effortSupported}
            fastEnabled={execution.fastModeSupported}
            t={t}
            onOpen={() => backend === undefined ? undefined : controller.refreshProviderModels(backend.id, undefined, true).catch(() => undefined)}
            onSelect={(selection) => {
              if (selection === undefined) {
                setDraft((current) => ({ ...current, providerId: "", modelId: "", effort: undefined, fastMode: false }));
                return;
              }
              const model = execution.availableModels.find((candidate) =>
                candidate.providerId === selection.providerId && candidate.modelId === selection.modelId);
              if (model === undefined || !model.available) return;
              setDraft((current) => ({
                ...current,
                providerId: model.providerId,
                modelId: model.modelId,
                effort: execution.effortSupported && selection.effort !== undefined && model.efforts.includes(selection.effort)
                  ? selection.effort
                  : undefined,
                fastMode: execution.fastModeSupported && model.supportsFast && selection.fastMode
              }));
            }}
          /></div>
          <label className="field"><span>{t("scheduler.permission")}</span><SelectControl disabled={!execution.permissionSelectable} value={draft.permissionMode} onChange={(event) => setDraft((current) => ({ ...current, permissionMode: event.target.value as ScheduleDraft["permissionMode"] }))}>{!execution.permissionModes.includes(draft.permissionMode) && <option value={draft.permissionMode}>{permissionModeLabel(draft.permissionMode, t)}</option>}{execution.permissionModes.map((mode) => <option value={mode} key={mode}>{permissionModeLabel(mode, t)}</option>)}</SelectControl></label>
        </>}
        {draft.executionMode === "script" && <label className="field"><span>{t("scheduler.scriptTimeoutSeconds")}</span><input type="number" min={1} step={1} value={draft.scriptTimeoutMs === undefined ? "" : draft.scriptTimeoutMs / 1_000} onChange={(event) => setDraft((current) => ({ ...current, scriptTimeoutMs: event.target.value === "" ? undefined : Number(event.target.value) * 1_000 }))} placeholder={t("scheduler.defaultTimeout")} /></label>}
        <label className="field"><span>{t("scheduler.expiresAt")}</span><input type="datetime-local" value={draft.expireAtExpression} onChange={(event) => setDraft((current) => ({ ...current, expireAtExpression: event.target.value }))} /></label>
        <label className="field"><span>{t("scheduler.overlap")}</span><SelectControl value={draft.overlapPolicy} onChange={(event) => setDraft((current) => ({ ...current, overlapPolicy: event.target.value as ScheduleDraft["overlapPolicy"] }))}><option value="queue">{t("scheduler.queue")}</option><option value="skip">{t("scheduler.skip")}</option></SelectControl></label>
        <label className="field"><span>{t("scheduler.misfire")}</span><SelectControl value={draft.misfirePolicy} onChange={(event) => setDraft((current) => ({ ...current, misfirePolicy: event.target.value as ScheduleDraft["misfirePolicy"] }))}><option value="runOnce">{t("scheduler.runOnce")}</option><option value="skip">{t("scheduler.skip")}</option></SelectControl></label>
      </div>
      <div className="schedule-editor__toggles">
        <label><CheckboxControl checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />{t("common.enabled")}</label>
        <label><CheckboxControl checked={draft.notifyDesktop} onChange={(event) => setDraft((current) => ({ ...current, notifyDesktop: event.target.checked }))} />{t("scheduler.notifyDesktop")}</label>
        {draft.executionMode === "agent" && <label><CheckboxControl checked={draft.silentWhenIdle} onChange={(event) => setDraft((current) => ({ ...current, silentWhenIdle: event.target.checked }))} />{t("scheduler.silentWhenIdle")}</label>}
        {draft.executionMode === "script" && <label><CheckboxControl checked={draft.scriptDispatchSessions} onChange={(event) => setDraft((current) => ({ ...current, scriptDispatchSessions: event.target.checked }))} />{t("scheduler.scriptDispatchSessions")}</label>}
        {draft.executionMode === "agent" && <label><CheckboxControl disabled={!execution.planModeSupported} checked={draft.planMode} onChange={(event) => setDraft((current) => ({ ...current, planMode: event.target.checked }))} />{t("scheduler.planMode")}</label>}
      </div>
      {draft.preRunHook !== undefined && <div className="schedule-editor__managed-hook"><strong>{t("scheduler.managedPreRunHook")}</strong><code>{draft.preRunHook.command}</code><small>{draft.preRunHook.filePath}</small></div>}
      {draft.executionMode === "agent" && extraDirectoriesSupported && selectableExtraDirectories.length > 0 && <div className="schedule-editor__directories"><strong>{t("projects.extraDirectories")}</strong>{selectableExtraDirectories.map((directory) => <label key={directory.id}><CheckboxControl checked={draft.extraDirectoryIds.includes(directory.id)} onChange={(event) => setDraft((current) => ({ ...current, extraDirectoryIds: event.target.checked ? [...new Set([...current.extraDirectoryIds, directory.id])] : current.extraDirectoryIds.filter((id) => id !== directory.id) }))} /><span>{directory.serverPath}<small>{directory.access === "readWrite" ? t("projects.readWrite") : t("projects.readOnly")}</small></span></label>)}</div>}
      </fieldset>
      {saveError !== undefined && <p className="inline-error" role="alert">{saveError}</p>}
      <div className="modal__actions"><Button disabled={saving} onClick={onClose}>{t("common.cancel")}</Button><Button type="submit" tone="primary" disabled={!valid || saving}>{saving ? t("common.loading") : schedule === undefined ? t("scheduler.new") : t("scheduler.saveChanges")}</Button></div>
    </form>
  </Modal>;
}

export function scheduleDraft(schedule: ScheduleView | undefined, targets: readonly TargetView[], sessions: readonly SessionView[], models: readonly ModelView[], backends: readonly BackendView[] = []): ScheduleDraft {
  const availableTarget = targets.find((candidate) => !candidate.archived && (backends.length === 0 || scheduleTargetAvailable(candidate, backends)));
  const target = targets.find((candidate) => candidate.id === schedule?.targetId) ?? availableTarget;
  const session = sessions.find((candidate) => candidate.id === schedule?.sessionId) ?? sessions.find((candidate) => candidate.targetId === target?.id);
  const model = schedule?.model ?? session?.model;
  const backendId = schedule?.backendId ?? target?.backendId ?? session?.backendId ?? "";
  const descriptor = models.find((candidate) => candidate.backendId === backendId && candidate.providerId === model?.providerId && candidate.modelId === model?.modelId);
  const timezone = schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    name: schedule?.name ?? "",
    backendId,
    targetId: schedule?.targetId ?? target?.id ?? "",
    sessionMode: schedule?.sessionMode ?? "fresh",
    sessionId: schedule?.sessionId ?? "",
    enabled: schedule?.enabled ?? true,
    kind: schedule?.kind ?? "manual",
    expression: schedule === undefined ? "" : schedule.kind === "once" ? scheduleLocalDateTimeFromEpoch(Date.parse(schedule.expression), timezone) : schedule.kind === "manual" ? "" : schedule.expression.replace(/s$/, ""),
    timezone,
    inputText: schedule?.inputText ?? "",
    executionMode: schedule?.executionMode ?? "agent",
    scriptCommand: schedule?.script?.command ?? "",
    scriptTimeoutMs: schedule?.script?.timeoutMs,
    scriptDispatchSessions: schedule?.script?.capabilities.includes("sessions.dispatch") ?? false,
    providerId: model?.providerId ?? "",
    modelId: model?.modelId ?? "",
    effort: schedule?.model?.effort ?? session?.effort ?? descriptor?.efforts[0],
    fastMode: schedule?.model?.fastMode ?? session?.fastMode ?? false,
    permissionMode: schedule?.permissionMode ?? session?.permissionMode ?? "ask",
    planMode: schedule?.planMode ?? session?.planMode ?? false,
    useWorktree: schedule?.useWorktree ?? false,
    ...(schedule?.worktreeSourceRef === undefined ? {} : { worktreeSourceRef: schedule.worktreeSourceRef }),
    refreshWorktreeRemote: schedule?.refreshWorktreeRemote ?? false,
    extraDirectoryIds: [...(schedule?.extraDirectoryIds ?? [])],
    silentWhenIdle: schedule?.silentWhenIdle ?? false,
    notifyDesktop: schedule?.notifyDesktop ?? true,
    expireAtExpression: schedule?.expireAt === undefined ? "" : scheduleLocalDateTimeFromEpoch(schedule.expireAt, timezone),
    ...(schedule?.preRunHook === undefined ? {} : { preRunHook: schedule.preRunHook }),
    overlapPolicy: schedule?.overlapPolicy ?? "queue",
    misfirePolicy: schedule?.misfirePolicy ?? "runOnce"
  };
}

function validExpression(draft: ScheduleDraft): boolean {
  if (!isValidScheduleTimeZone(draft.timezone)) return false;
  if (draft.kind === "manual") return true;
  if (draft.kind === "once") {
    const triggerAt = scheduleEpochFromLocalDateTime(draft.expression, draft.timezone);
    return triggerAt !== undefined && (!draft.enabled || triggerAt > Date.now());
  }
  if (draft.kind === "interval") return Number.isInteger(Number(draft.expression)) && Number(draft.expression) > 0;
  return draft.expression.trim().length > 0;
}

function defaultExpression(kind: ScheduleDraft["kind"], timezone: string): string {
  if (kind === "once") return scheduleLocalDateTimeFromEpoch(Date.now() + 3_600_000, timezone);
  if (kind === "interval") return "3600";
  return "";
}

export function scheduleRuntimeLabel(status: ScheduleRuntimeStatus, runtime: SchedulerRuntimeView | undefined, t: Translator): string {
  if (status.kind === "capacity") {
    return t("scheduler.waitingForCapacity", {
      used: runtime?.slotsInUse ?? 0,
      max: runtime?.maxConcurrentRuns ?? 0
    });
  }
  if (status.run.phase === "loading") return t("scheduler.phaseLoading");
  if (status.run.phase === "claiming") return t("scheduler.phaseClaiming");
  if (status.run.phase === "persisting") return t("scheduler.phasePersisting");
  if (status.run.phase === "queued") return t("scheduler.phaseQueued");
  if (status.run.phase === "cancelling") return t("scheduler.phaseCancelling");
  if (status.run.phase === "finalizing") return t("scheduler.phaseFinalizing");
  if (status.run.phase === "stalled") return t("scheduler.phaseStalled");
  if (status.run.phase === "recovering") return t("scheduler.phaseRecovering");
  return t("scheduler.phaseRunning");
}

function scheduleKind(kind: ScheduleView["kind"], t: Translator): string {
  if (kind === "once") return t("scheduler.once");
  if (kind === "cron") return t("scheduler.cron");
  if (kind === "interval") return t("scheduler.interval");
  return t("scheduler.manual");
}

function scheduleSessionModeLabel(mode: ScheduleView["sessionMode"], t: Translator): string {
  if (mode === "persistent") return t("scheduler.sessionPersistent");
  if (mode === "bound") return t("scheduler.sessionBound");
  return t("scheduler.sessionFresh");
}

function worktreeEligibilityMessage(
  value: Exclude<WorktreeEligibilityView, "eligible">
): "worktree.ineligible.notGitRepository" | "worktree.ineligible.alreadyLinked" | "worktree.ineligible.unsafe" | "worktree.ineligible.unavailable" {
  if (value === "notGitRepository") return "worktree.ineligible.notGitRepository";
  if (value === "alreadyLinked") return "worktree.ineligible.alreadyLinked";
  if (value === "unsafe") return "worktree.ineligible.unsafe";
  return "worktree.ineligible.unavailable";
}

function scheduleTemplateCapabilityLabel(capability: ScheduleTemplateCapability, t: Translator): string {
  if (capability === "worktree") return t("scheduler.templateWorktree");
  if (capability === "pullRequest") return t("scheduler.templatePullRequest");
  if (capability === "web") return t("scheduler.templateWeb");
  return t("scheduler.templateCustomizable");
}

function permissionModeLabel(mode: ScheduleDraft["permissionMode"], t: Translator): string {
  if (mode === "auto") return t("permission.auto");
  if (mode === "bypassPermissions") return t("permission.full");
  return t("permission.ask");
}

function scheduleTargetAvailable(target: TargetView, backends: readonly BackendView[]): boolean {
  const backend = backends.find((candidate) => candidate.id === target.backendId);
  return backend !== undefined && backend.health !== "unavailable" && backend.capabilities.get("input.text")?.supported === true;
}

function scheduleTimeZoneOptions(current: string): readonly string[] {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [...new Set([current, local, "UTC", "Asia/Shanghai", "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Tokyo"].filter(Boolean))];
}

function formatScheduleDateTime(value: number, locale: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(value);
  } catch {
    return formatDateTime(value, locale);
  }
}

function runScheduleAction(runAction: RunAction, key: string, action: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      runAction(key, async () => {
        try {
          await action();
          resolve();
        } catch (cause) {
          reject(cause);
          throw cause;
        }
      });
    } catch (cause) {
      reject(cause);
    }
  });
}

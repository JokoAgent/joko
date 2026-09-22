import {
  Archive,
  Bot,
  ChevronRight,
  CircleStop,
  GitMerge,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Send,
  Target,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from "react";

import type { AppController } from "../controller.js";
import type {
  CollaborationGoalTreeView,
  CollaborationGoalView,
  CollaborationQueueEntryView,
  CollaborationWorkerDraftView,
  CollaborationWorkerView,
  Locale,
  ModelView,
  PermissionMode,
  SessionView,
  TargetView
} from "../model.js";
import { Button, CheckboxControl, IconButton, Modal, Pill, Spinner, StatusDot, cx } from "./ui.js";
import type { Translator } from "./types.js";
import "./collaboration-goal-panel.css";

const POLL_INTERVAL_MS = 2_500;

interface GoalDraft {
  readonly title: string;
  readonly objective: string;
  readonly maximumWorkers: string;
}

interface WorkerDraft {
  readonly label: string;
  readonly role: string;
  readonly assignment: string;
  readonly parentWorkerId: string;
  readonly targetId: string;
  readonly modelKey: string;
  readonly effort: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
}

interface WorkerEditDraft {
  readonly workerId: string;
  readonly label: string;
  readonly role: string;
  readonly assignment: string;
}

export function CollaborationGoalPanel({
  controller,
  session,
  models,
  locale,
  ownerKey,
  open,
  readOnly,
  onClose,
  t
}: {
  readonly controller: AppController;
  readonly session: SessionView;
  readonly models: readonly ModelView[];
  readonly locale: Locale;
  readonly ownerKey: string;
  readonly open: boolean;
  readonly readOnly: boolean;
  readonly onClose: () => void;
  readonly t: Translator;
}): JSX.Element | null {
  const latestControllerRef = useRef(controller);
  latestControllerRef.current = controller;
  const panelRef = useRef<HTMLElement | null>(null);
  const ownerRef = useRef(ownerKey);
  ownerRef.current = ownerKey;
  const selectedGoalIdRef = useRef<string | undefined>(undefined);
  const loadRevisionRef = useRef(0);
  const loadAbortRef = useRef<AbortController | undefined>(undefined);
  const loadInFlightRef = useRef(false);
  const goalSelectionAbortRef = useRef<AbortController | undefined>(undefined);
  const actionAbortRef = useRef<AbortController | undefined>(undefined);
  const [goals, setGoals] = useState<readonly CollaborationGoalView[]>([]);
  const [tree, setTree] = useState<CollaborationGoalTreeView>();
  const [selectedGoalId, setSelectedGoalIdState] = useState<string>();
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [pendingAction, setPendingAction] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [actionNotice, setActionNotice] = useState<string>();
  const [goalDraft, setGoalDraft] = useState<GoalDraft>({ title: "", objective: "", maximumWorkers: "" });
  const targets = controller.state.snapshot.targets.filter((candidate) => candidate.trusted && !candidate.archived);
  const [workerDraft, setWorkerDraft] = useState<WorkerDraft>(() => initialWorkerDraft(session, targets, models));
  const [workerEdit, setWorkerEdit] = useState<WorkerEditDraft>();
  const [message, setMessage] = useState("");
  const [editingDispatchId, setEditingDispatchId] = useState<string>();
  const [editedMessage, setEditedMessage] = useState("");
  const [selectedDispatchIds, setSelectedDispatchIds] = useState<ReadonlySet<string>>(() => new Set());
  const [stopConfirmation, setStopConfirmation] = useState<CollaborationGoalView>();

  selectedGoalIdRef.current = selectedGoalId;

  const adoptTree = (next: CollaborationGoalTreeView): void => {
    setTree(next);
    setGoals((current) => upsertGoal(current, next.goal));
    setSelectedGoalIdState(next.goal.id);
    setSelectedWorkerId((current) => current !== undefined && next.workers.some((worker) => worker.id === current)
      ? current
      : next.workers.find((worker) => worker.sessionId === session.id)?.id
        ?? next.focusedWorkerId ?? next.workers.find((worker) => worker.status !== "archived")?.id);
    setSelectedDispatchIds((current) => new Set([...current].filter((id) => next.queue.some((entry) => entry.dispatch.id === id))));
  };

  const load = async (signal: AbortSignal, foreground: boolean): Promise<void> => {
    const revision = ++loadRevisionRef.current;
    const expectedOwner = ownerRef.current;
    if (foreground) {
      setLoading(true);
      setLoadError(undefined);
    }
    try {
      const nextGoals = await latestControllerRef.current.listCollaborationGoals(session.id, true, signal);
      if (signal.aborted || revision !== loadRevisionRef.current || expectedOwner !== ownerRef.current) return;
      setGoals(nextGoals);
      const preferred = nextGoals.find((goal) => goal.id === selectedGoalIdRef.current)
        ?? nextGoals.find((goal) => goal.status === "active")
        ?? [...nextGoals].sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (preferred === undefined) {
        setTree(undefined);
        setSelectedGoalIdState(undefined);
        setSelectedWorkerId(undefined);
        return;
      }
      const nextTree = await latestControllerRef.current.getCollaborationGoal(preferred.id, session.id, signal);
      if (signal.aborted || revision !== loadRevisionRef.current || expectedOwner !== ownerRef.current) return;
      adoptTree(nextTree);
    } catch (error) {
      if (!signal.aborted && revision === loadRevisionRef.current && expectedOwner === ownerRef.current) {
        setLoadError(errorMessage(error, t("collaboration.loadFailed")));
      }
    } finally {
      if (revision === loadRevisionRef.current && expectedOwner === ownerRef.current) setLoading(false);
    }
  };

  const triggerLoad = (foreground: boolean): void => {
    const abort = loadAbortRef.current;
    if (abort === undefined || abort.signal.aborted || loadInFlightRef.current
      || actionAbortRef.current !== undefined) return;
    loadInFlightRef.current = true;
    void load(abort.signal, foreground).finally(() => {
      if (loadAbortRef.current === abort) loadInFlightRef.current = false;
    });
  };

  useEffect(() => {
    loadRevisionRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = undefined;
    loadInFlightRef.current = false;
    goalSelectionAbortRef.current?.abort();
    goalSelectionAbortRef.current = undefined;
    actionAbortRef.current?.abort();
    setGoals([]);
    setTree(undefined);
    setSelectedGoalIdState(undefined);
    setSelectedWorkerId(undefined);
    setSelectedDispatchIds(new Set());
    setLoadError(undefined);
    setActionError(undefined);
    setActionNotice(undefined);
    setPendingAction(undefined);
    setWorkerEdit(undefined);
    setEditingDispatchId(undefined);
    setStopConfirmation(undefined);
    setWorkerDraft(initialWorkerDraft(session, targets, models));
    if (!open) return;
    const abort = new AbortController();
    loadAbortRef.current = abort;
    const ownerDocument = panelRef.current?.ownerDocument ?? document;
    const ownerWindow = ownerDocument.defaultView ?? window;
    panelRef.current?.focus({ preventScroll: true });
    triggerLoad(true);
    const timer = ownerWindow.setInterval(() => {
      if (ownerDocument.visibilityState === "visible") triggerLoad(false);
    }, POLL_INTERVAL_MS);
    return () => {
      loadRevisionRef.current += 1;
      ownerWindow.clearInterval(timer);
      abort.abort();
      if (loadAbortRef.current === abort) {
        loadAbortRef.current = undefined;
        loadInFlightRef.current = false;
      }
      goalSelectionAbortRef.current?.abort();
      goalSelectionAbortRef.current = undefined;
    };
  }, [open, ownerKey]);

  const workerViewer = tree !== undefined && tree.goal.leadSessionId !== session.id;
  const collaborationReadOnly = readOnly || workerViewer;

  const runMutation = async (key: string, action: (signal: AbortSignal) => Promise<CollaborationGoalTreeView>): Promise<boolean> => {
    if (actionAbortRef.current !== undefined || collaborationReadOnly) return false;
    const expectedOwner = ownerRef.current;
    const expectedGoalId = selectedGoalIdRef.current;
    const abort = new AbortController();
    actionAbortRef.current = abort;
    loadRevisionRef.current += 1;
    setPendingAction(key);
    setActionError(undefined);
    setActionNotice(undefined);
    try {
      const next = await action(abort.signal);
      if (abort.signal.aborted || expectedOwner !== ownerRef.current
        || expectedGoalId !== selectedGoalIdRef.current) return false;
      adoptTree(next);
      return true;
    } catch (error) {
      if (!abort.signal.aborted && expectedOwner === ownerRef.current) {
        setActionError(errorMessage(error, t("collaboration.actionFailed")));
      }
      return false;
    } finally {
      if (actionAbortRef.current === abort) actionAbortRef.current = undefined;
      if (expectedOwner === ownerRef.current) setPendingAction(undefined);
    }
  };

  if (!open) return null;
  const selectedWorker = tree?.workers.find((worker) => worker.id === selectedWorkerId);
  const orderedWorkers = tree === undefined ? [] : orderWorkers(tree.workers);
  const selectedQueue = selectedWorker === undefined || tree === undefined ? [] : tree.queue
    .filter((entry) => entry.dispatch.workerId === selectedWorker.id && pendingQueueEntry(entry))
    .sort(compareQueueEntries);
  const mergeable = selectedQueue.filter(canMutateQueueEntry);
  const selectedMergeEntries = mergeable.filter((entry) => selectedDispatchIds.has(entry.dispatch.id));
  const canMerge = tree?.goal.status === "active" && contiguousSelection(mergeable, selectedDispatchIds);
  const goalCanComplete = tree !== undefined && tree.workers.every(workerTerminal)
    && !tree.queue.some(pendingQueueEntry);
  const goalActive = tree?.goal.status === "active";
  const hasActiveGoal = goals.some((goal) => goal.status === "active");
  const workerTargets = targets.length === 0
    ? controller.state.snapshot.targets.filter((candidate) => !candidate.archived)
    : targets;
  const draftTarget = workerTargets.find((candidate) => candidate.id === workerDraft.targetId);
  const draftModels = models.filter((candidate) => candidate.available && candidate.backendId === draftTarget?.backendId);
  const draftModel = modelForKey(draftModels, workerDraft.modelKey);

  const createGoal = (event: FormEvent): void => {
    event.preventDefault();
    const title = goalDraft.title.trim();
    const objective = goalDraft.objective.trim();
    const maximumWorkers = optionalPositiveInteger(goalDraft.maximumWorkers);
    if (title === "" || objective === "" || maximumWorkers === false) return;
    void runMutation("create-goal", (signal) => latestControllerRef.current.createCollaborationGoal(
      session.id,
      session.generation,
      title,
      objective,
      maximumWorkers,
      signal
    )).then((succeeded) => { if (succeeded) setGoalDraft({ title: "", objective: "", maximumWorkers: "" }); });
  };

  const createWorker = (event: FormEvent): void => {
    event.preventDefault();
    if (tree === undefined || !goalActive || draftTarget === undefined) return;
    const label = workerDraft.label.trim();
    const role = workerDraft.role.trim();
    const assignment = workerDraft.assignment.trim();
    if (label === "" || role === "" || assignment === "") return;
    const draft: CollaborationWorkerDraftView = {
      ...(workerDraft.parentWorkerId === "" ? {} : { parentWorkerId: workerDraft.parentWorkerId }),
      label,
      role,
      assignment,
      targetId: draftTarget.id,
      ...(draftModel === undefined ? {} : { providerId: draftModel.providerId, modelId: draftModel.modelId }),
      ...(workerDraft.effort === "" ? {} : { effort: workerDraft.effort }),
      fastMode: draftModel?.supportsFast === true && workerDraft.fastMode,
      permissionMode: workerDraft.permissionMode,
      planMode: workerDraft.planMode
    };
    void runMutation("create-worker", (signal) => latestControllerRef.current.createCollaborationWorker(tree.goal, draft, signal))
      .then((succeeded) => { if (succeeded) setWorkerDraft((current) => ({ ...current, label: "", role: "", assignment: "", parentWorkerId: "" })); });
  };

  return <section
    ref={panelRef}
    className="collaboration-panel"
    aria-label={t("collaboration.title")}
    tabIndex={-1}
    onKeyDown={(event) => {
      if (!event.nativeEvent.isComposing && event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }}
  >
    <header className="collaboration-panel__header">
      <div><strong>{t("collaboration.title")}</strong><span>{t("collaboration.subtitle")}</span></div>
      {tree !== undefined && <Pill tone={goalTone(tree.goal.status)}>{t(`collaboration.goalState.${tree.goal.status}`)}</Pill>}
      <IconButton label={t("common.close")} onClick={onClose}><X aria-hidden="true" /></IconButton>
    </header>

    {collaborationReadOnly && <p className="collaboration-panel__notice"><span>{t(workerViewer ? "collaboration.workerReadOnly" : "collaboration.readOnly")}</span></p>}
    {loadError !== undefined && <div className="collaboration-panel__notice is-error" role="alert"><span>{loadError}</span><Button onClick={() => {
      triggerLoad(true);
    }}>{t("common.retry")}</Button></div>}
    {actionError !== undefined && <div className="collaboration-panel__notice is-error" role="alert"><span>{actionError}</span><IconButton label={t("common.dismiss")} onClick={() => setActionError(undefined)}><X aria-hidden="true" /></IconButton></div>}
    {actionNotice !== undefined && <p className="collaboration-panel__notice" role="status">{actionNotice}</p>}
    {loading && tree === undefined && <div className="collaboration-panel__loading"><Spinner label={t("collaboration.loading")} />{t("collaboration.loading")}</div>}

    {!loading && tree === undefined && loadError === undefined && <form className="collaboration-panel__empty" onSubmit={createGoal}>
      <Bot aria-hidden="true" />
      <div><strong>{t("collaboration.noGoal")}</strong><p>{t("collaboration.noGoalBody")}</p></div>
      <label>{t("collaboration.goalTitle")}<input required maxLength={256} value={goalDraft.title} onChange={(event) => { const value = event.currentTarget.value; setGoalDraft((current) => ({ ...current, title: value })); }} /></label>
      <label className="is-wide">{t("collaboration.goalObjective")}<textarea required maxLength={32_000} rows={3} value={goalDraft.objective} onChange={(event) => { const value = event.currentTarget.value; setGoalDraft((current) => ({ ...current, objective: value })); }} /></label>
      <label>{t("collaboration.maximumWorkers")}<input inputMode="numeric" min={1} max={128} type="number" value={goalDraft.maximumWorkers} onChange={(event) => { const value = event.currentTarget.value; setGoalDraft((current) => ({ ...current, maximumWorkers: value })); }} /><small>{t("collaboration.maximumWorkersHint")}</small></label>
      <Button tone="primary" type="submit" disabled={collaborationReadOnly || pendingAction !== undefined || goalDraft.title.trim() === "" || goalDraft.objective.trim() === ""}><Plus aria-hidden="true" />{t("collaboration.createGoal")}</Button>
    </form>}

    {tree !== undefined && <>
      <div className="collaboration-panel__goal">
        <label>{t("collaboration.goalHistory")}
          <select value={tree.goal.id} onChange={(event) => {
            const goalId = event.currentTarget.value;
            setSelectedGoalIdState(goalId);
            selectedGoalIdRef.current = goalId;
            const revision = ++loadRevisionRef.current;
            const expectedOwner = ownerRef.current;
            goalSelectionAbortRef.current?.abort();
            const abort = new AbortController();
            goalSelectionAbortRef.current = abort;
            setLoading(true);
            setLoadError(undefined);
            void latestControllerRef.current.getCollaborationGoal(goalId, session.id, abort.signal).then((next) => {
              if (!abort.signal.aborted && revision === loadRevisionRef.current && expectedOwner === ownerRef.current) {
                adoptTree(next);
              }
            }).catch((error: unknown) => {
              if (!abort.signal.aborted && revision === loadRevisionRef.current && expectedOwner === ownerRef.current) {
                setLoadError(errorMessage(error, t("collaboration.loadFailed")));
              }
            }).finally(() => {
              if (goalSelectionAbortRef.current === abort) goalSelectionAbortRef.current = undefined;
              if (revision === loadRevisionRef.current && expectedOwner === ownerRef.current) setLoading(false);
            });
          }}>{goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title} · {t(`collaboration.goalState.${goal.status}`)}</option>)}</select>
        </label>
        <div className="collaboration-panel__goal-copy"><strong>{tree.goal.title}</strong><p>{tree.goal.objective}</p><small>{t("collaboration.goalSummary", { count: tree.workers.length, active: tree.workers.filter(workerOccupiesRuntime).length })} · {t("collaboration.updatedAt", { time: formatTime(tree.goal.updatedAt, locale) })}</small></div>
        <div className="collaboration-panel__goal-actions">
          {goalActive && <Button disabled={collaborationReadOnly || pendingAction !== undefined || !goalCanComplete} onClick={() => void runMutation("complete-goal", (signal) => latestControllerRef.current.setCollaborationGoalStatus(tree.goal, "completed", signal))}>{t("collaboration.endGoal")}</Button>}
          {goalActive && <Button tone="danger" disabled={collaborationReadOnly || pendingAction !== undefined} onClick={() => setStopConfirmation(tree.goal)}><CircleStop aria-hidden="true" />{t("collaboration.stopGoal")}</Button>}
          {!goalActive && tree.goal.status !== "archived" && <Button disabled={collaborationReadOnly || pendingAction !== undefined} onClick={() => void runMutation("archive-goal", (signal) => latestControllerRef.current.setCollaborationGoalStatus(tree.goal, "archived", signal))}><Archive aria-hidden="true" />{t("collaboration.archiveGoal")}</Button>}
        </div>
      </div>

      <div className="collaboration-panel__body">
        <section className="collaboration-panel__workers" aria-label={t("collaboration.workers")}>
          <header><strong>{t("collaboration.workers")}</strong>{tree.focusedWorkerId !== undefined && <Button tone="ghost" disabled={collaborationReadOnly || pendingAction !== undefined} onClick={() => void runMutation("clear-focus", (signal) => latestControllerRef.current.focusCollaborationWorker(tree.goal, undefined, signal))}>{t("collaboration.clearFocus")}</Button>}</header>
          {orderedWorkers.length === 0 && <div className="collaboration-panel__worker-empty"><Bot aria-hidden="true" /><strong>{t("collaboration.workerEmpty")}</strong><span>{t("collaboration.workerEmptyBody")}</span></div>}
          <div className="collaboration-panel__worker-list">
            {orderedWorkers.map(({ worker, depth }) => <button
              key={worker.id}
              type="button"
              className={cx("collaboration-worker", selectedWorker?.id === worker.id && "is-selected", worker.focused && "is-focused")}
              style={{ "--worker-depth": Math.min(depth, 4) } as React.CSSProperties}
              onClick={() => { setSelectedWorkerId(worker.id); setWorkerEdit(undefined); setEditingDispatchId(undefined); setSelectedDispatchIds(new Set()); }}
            >
              {depth > 0 && <ChevronRight aria-hidden="true" />}
              <StatusDot state={worker.status === "dispatchUnknown" ? "waiting" : worker.status} label={t(`collaboration.workerState.${worker.status}`)} />
              <span><strong>{worker.label}</strong><small>{worker.role}</small></span>
              {worker.focused && <Pill tone="accent">{t("collaboration.focused")}</Pill>}
              {worker.runtimeReleased && <Pill>{t("collaboration.runtimeReleased")}</Pill>}
            </button>)}
          </div>

          {goalActive && <details className="collaboration-panel__create-worker">
            <summary><Plus aria-hidden="true" />{t("collaboration.addWorker")}</summary>
            <form onSubmit={createWorker}>
              <label>{t("collaboration.workerLabel")}<input required maxLength={64} value={workerDraft.label} onChange={(event) => { const value = event.currentTarget.value; setWorkerDraft((current) => ({ ...current, label: value })); }} /></label>
              <label>{t("collaboration.workerRole")}<input required maxLength={128} value={workerDraft.role} onChange={(event) => { const value = event.currentTarget.value; setWorkerDraft((current) => ({ ...current, role: value })); }} /></label>
              <label className="is-wide">{t("collaboration.workerAssignment")}<textarea required maxLength={32_000} rows={3} value={workerDraft.assignment} onChange={(event) => { const value = event.currentTarget.value; setWorkerDraft((current) => ({ ...current, assignment: value })); }} /></label>
              <label>{t("collaboration.workerParent")}<select value={workerDraft.parentWorkerId} onChange={(event) => { const value = event.currentTarget.value; setWorkerDraft((current) => ({ ...current, parentWorkerId: value })); }}><option value="">{t("collaboration.workerParentLead")}</option>{tree.workers.filter((worker) => worker.status !== "archived").map((worker) => <option key={worker.id} value={worker.id}>{worker.label}</option>)}</select></label>
              <label>{t("subagents.target")}<select value={workerDraft.targetId} onChange={(event) => {
                const targetId = event.currentTarget.value;
                const nextTarget = workerTargets.find((candidate) => candidate.id === targetId);
                const nextModel = models.find((candidate) => candidate.available && candidate.backendId === nextTarget?.backendId);
                setWorkerDraft((current) => ({ ...current, targetId, modelKey: nextModel === undefined ? "" : modelKey(nextModel), effort: "", fastMode: false }));
              }}>{workerTargets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
              <label>{t("controls.model")}<select value={workerDraft.modelKey} onChange={(event) => { const value = event.currentTarget.value; setWorkerDraft((current) => ({ ...current, modelKey: value, effort: "", fastMode: false })); }}><option value="">{t("common.none")}</option>{draftModels.map((candidate) => <option key={modelKey(candidate)} value={modelKey(candidate)}>{candidate.providerName} · {candidate.name}</option>)}</select></label>
              <label>{t("controls.effort")}<select value={workerDraft.effort} onChange={(event) => { const value = event.currentTarget.value; setWorkerDraft((current) => ({ ...current, effort: value })); }}><option value="">{t("common.none")}</option>{draftModel?.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label>
              <label>{t("controls.permission")}<select value={workerDraft.permissionMode} onChange={(event) => { const value = event.currentTarget.value as PermissionMode; setWorkerDraft((current) => ({ ...current, permissionMode: value })); }}><option value="ask">{t("permission.ask")}</option><option value="auto">{t("permission.auto")}</option><option value="bypassPermissions">{t("permission.full")}</option></select></label>
              <label className="collaboration-panel__choice"><CheckboxControl checked={workerDraft.fastMode} disabled={draftModel?.supportsFast !== true} onChange={(event) => { const checked = event.currentTarget.checked; setWorkerDraft((current) => ({ ...current, fastMode: checked })); }} />{t("controls.fast")}</label>
              <label className="collaboration-panel__choice"><CheckboxControl checked={workerDraft.planMode} onChange={(event) => { const checked = event.currentTarget.checked; setWorkerDraft((current) => ({ ...current, planMode: checked })); }} />{t("controls.plan")}</label>
              <Button tone="primary" type="submit" disabled={collaborationReadOnly || pendingAction !== undefined || workerTargets.length === 0}><Plus aria-hidden="true" />{t("collaboration.addWorker")}</Button>
            </form>
          </details>}
        </section>

        <section className="collaboration-panel__detail" aria-live="polite">
          {selectedWorker === undefined ? <div className="collaboration-panel__worker-empty"><Target aria-hidden="true" /><strong>{t("collaboration.workers")}</strong><span>{t("collaboration.workerEmptyBody")}</span></div> : <>
            <header className="collaboration-panel__worker-header">
              <div><strong>{selectedWorker.label}</strong><span>{selectedWorker.role}</span></div>
              <Pill tone={workerTone(selectedWorker.status)}>{t(`collaboration.workerState.${selectedWorker.status}`)}</Pill>
            </header>
            {selectedWorker.softLimitWarning && <p className="collaboration-panel__notice is-warning">{t("collaboration.softLimit")}</p>}
            {selectedWorker.error !== undefined && <p className="collaboration-panel__notice is-error" role="alert">{selectedWorker.error}</p>}
            {workerEdit?.workerId === selectedWorker.id ? <form className="collaboration-panel__worker-edit" onSubmit={(event) => {
              event.preventDefault();
              const edit = workerEdit;
              if (edit.label.trim() === "" || edit.role.trim() === "" || edit.assignment.trim() === "") return;
              void runMutation(`update-worker:${selectedWorker.id}`, (signal) => latestControllerRef.current.updateCollaborationWorker(tree.goal, selectedWorker, {
                label: edit.label.trim(), role: edit.role.trim(), assignment: edit.assignment.trim()
              }, signal)).then((succeeded) => { if (succeeded) setWorkerEdit(undefined); });
            }}>
              <label>{t("collaboration.workerLabel")}<input maxLength={64} value={workerEdit.label} onChange={(event) => { const value = event.currentTarget.value; setWorkerEdit((current) => current === undefined ? current : ({ ...current, label: value })); }} /></label>
              <label>{t("collaboration.workerRole")}<input maxLength={128} value={workerEdit.role} onChange={(event) => { const value = event.currentTarget.value; setWorkerEdit((current) => current === undefined ? current : ({ ...current, role: value })); }} /></label>
              <label className="is-wide">{t("collaboration.workerAssignment")}<textarea maxLength={32_000} rows={3} value={workerEdit.assignment} onChange={(event) => { const value = event.currentTarget.value; setWorkerEdit((current) => current === undefined ? current : ({ ...current, assignment: value })); }} /></label>
              <div><Button type="submit" disabled={collaborationReadOnly || pendingAction !== undefined}><Save aria-hidden="true" />{t("common.save")}</Button><Button onClick={() => setWorkerEdit(undefined)}>{t("common.cancel")}</Button></div>
            </form> : <p className="collaboration-panel__assignment">{selectedWorker.assignment}</p>}
            <dl className="collaboration-panel__route">
              <div><dt>{t("subagents.target")}</dt><dd>{targetName(controller.state.snapshot.targets, selectedWorker.route.targetId)}</dd></div>
              <div><dt>{t("settings.provider")}</dt><dd>{selectedWorker.route.providerId ?? t("common.none")}</dd></div>
              <div><dt>{t("controls.model")}</dt><dd>{selectedWorker.route.modelId ?? t("common.none")}</dd></div>
              <div><dt>{t("controls.effort")}</dt><dd>{selectedWorker.route.effort ?? t("common.none")}</dd></div>
              <div><dt>{t("controls.fast")}</dt><dd>{t(selectedWorker.route.fastMode ? "common.on" : "common.off")}</dd></div>
              <div><dt>{t("controls.permission")}</dt><dd>{permissionLabel(selectedWorker.route.permissionMode, t)}</dd></div>
              <div><dt>{t("controls.plan")}</dt><dd>{t(selectedWorker.route.planMode ? "common.on" : "common.off")}</dd></div>
              <div><dt>{t("collaboration.generation")}</dt><dd>{selectedWorker.sessionGeneration?.toString() ?? "—"}</dd></div>
            </dl>
            <div className="collaboration-panel__worker-actions">
              {selectedWorker.sessionId !== undefined && <Button onClick={() => latestControllerRef.current.navigate({ kind: "session", sessionId: selectedWorker.sessionId! })}><Play aria-hidden="true" />{t("collaboration.workerTask")}</Button>}
              {goalActive && selectedWorker.status !== "archived" && !selectedWorker.focused && <Button disabled={collaborationReadOnly || pendingAction !== undefined} onClick={() => void runMutation(`focus:${selectedWorker.id}`, (signal) => latestControllerRef.current.focusCollaborationWorker(tree.goal, selectedWorker, signal))}><Target aria-hidden="true" />{t("collaboration.focus")}</Button>}
              {goalActive && selectedWorker.status !== "archived" && <Button disabled={collaborationReadOnly || pendingAction !== undefined} onClick={() => setWorkerEdit({ workerId: selectedWorker.id, label: selectedWorker.label, role: selectedWorker.role, assignment: selectedWorker.assignment })}><Pencil aria-hidden="true" />{t("common.edit")}</Button>}
              {goalActive && selectedWorker.runtimeReleased && selectedWorker.status !== "archived" && <Button disabled={collaborationReadOnly || pendingAction !== undefined} onClick={() => void runMutation(`wake:${selectedWorker.id}`, (signal) => latestControllerRef.current.wakeCollaborationWorker(tree.goal, selectedWorker, signal))}><RotateCcw aria-hidden="true" />{t("collaboration.wake")}</Button>}
              {goalActive && !selectedWorker.runtimeReleased && ["idle", "completed", "failed"].includes(selectedWorker.status) && <Button disabled={collaborationReadOnly || pendingAction !== undefined} onClick={() => void runMutation(`release:${selectedWorker.id}`, (signal) => latestControllerRef.current.releaseCollaborationWorker(tree.goal, selectedWorker, signal))}>{t("collaboration.release")}</Button>}
              {goalActive && !["stopped", "archived"].includes(selectedWorker.status) && <Button tone="danger" disabled={collaborationReadOnly || pendingAction !== undefined} onClick={() => void runMutation(`stop:${selectedWorker.id}`, (signal) => latestControllerRef.current.stopCollaborationWorker(tree.goal, selectedWorker, signal))}><CircleStop aria-hidden="true" />{t("common.stop")}</Button>}
              {selectedWorker.status !== "archived" && (selectedWorker.status === "stopped" || (selectedWorker.runtimeReleased && ["idle", "completed", "failed"].includes(selectedWorker.status))) && <Button disabled={collaborationReadOnly || pendingAction !== undefined} onClick={() => void runMutation(`archive:${selectedWorker.id}`, (signal) => latestControllerRef.current.archiveCollaborationWorker(tree.goal, selectedWorker, signal))}><Archive aria-hidden="true" />{t("collaboration.archiveWorker")}</Button>}
            </div>

            {goalActive && selectedWorker.status !== "archived" && !selectedWorker.runtimeReleased && <form className="collaboration-panel__message" onSubmit={(event) => {
              event.preventDefault();
              const nextMessage = message.trim();
              if (nextMessage === "") return;
              void runMutation(`send:${selectedWorker.id}`, (signal) => latestControllerRef.current.sendCollaborationWorkerMessage(tree.goal, selectedWorker, nextMessage, signal)).then((succeeded) => { if (succeeded) setMessage(""); });
            }}>
              <label>{t("collaboration.message")}<textarea maxLength={32_000} rows={3} placeholder={t("collaboration.messagePlaceholder")} value={message} onChange={(event) => setMessage(event.currentTarget.value)} /></label>
              <div><Button tone="primary" type="submit" disabled={collaborationReadOnly || pendingAction !== undefined || message.trim() === ""}><Send aria-hidden="true" />{t("collaboration.send")}</Button><Button tone="danger" disabled={collaborationReadOnly || pendingAction !== undefined || message.trim() === ""} onClick={() => {
                if (actionAbortRef.current !== undefined || collaborationReadOnly) return;
                const nextMessage = message.trim();
                if (nextMessage === "") return;
                const expectedOwner = ownerRef.current;
                const expectedGoalId = selectedGoalIdRef.current;
                const abort = new AbortController();
                actionAbortRef.current = abort;
                loadRevisionRef.current += 1;
                setPendingAction(`interrupt:${selectedWorker.id}`);
                setActionError(undefined);
                void latestControllerRef.current.interruptCollaborationWorker(tree.goal, selectedWorker, nextMessage, abort.signal).then((result) => {
                  if (abort.signal.aborted || expectedOwner !== ownerRef.current
                    || expectedGoalId !== selectedGoalIdRef.current) return;
                  adoptTree(result.tree);
                  setMessage("");
                  setActionNotice(t(`collaboration.interruptOutcome.${result.stopOutcome}`));
                }).catch((error: unknown) => {
                  if (!abort.signal.aborted && expectedOwner === ownerRef.current) setActionError(errorMessage(error, t("collaboration.actionFailed")));
                }).finally(() => {
                  if (actionAbortRef.current === abort) actionAbortRef.current = undefined;
                  if (expectedOwner === ownerRef.current) setPendingAction(undefined);
                });
              }}><CircleStop aria-hidden="true" />{t("collaboration.interrupt")}</Button></div>
            </form>}

            <section className="collaboration-panel__queue" aria-label={t("collaboration.queue")}>
              <header><strong>{t("collaboration.queue")}</strong><Button disabled={collaborationReadOnly || pendingAction !== undefined || !canMerge} onClick={() => void runMutation(`merge:${selectedWorker.id}`, (signal) => latestControllerRef.current.mergeCollaborationDispatches(tree.goal, selectedWorker, selectedMergeEntries, signal)).then((succeeded) => { if (succeeded) setSelectedDispatchIds(new Set()); })}><GitMerge aria-hidden="true" />{t("collaboration.queueMerge")}</Button></header>
              {selectedQueue.length === 0 && <p>{t("collaboration.queueEmpty")}</p>}
              {selectedQueue.map((entry) => {
                const mutable = goalActive && canMutateQueueEntry(entry);
                const editing = editingDispatchId === entry.dispatch.id;
                return <article key={entry.dispatch.id} className={cx("collaboration-queue-item", entry.dispatch.status === "dispatchUnknown" && "is-unknown")}>
                  <CheckboxControl aria-label={t("collaboration.queueSelect")} checked={selectedDispatchIds.has(entry.dispatch.id)} disabled={!mutable || collaborationReadOnly} onChange={(event) => { const checked = event.currentTarget.checked; setSelectedDispatchIds((current) => toggled(current, entry.dispatch.id, checked)); }} />
                  <div>{editing ? <textarea maxLength={32_000} rows={3} value={editedMessage} onChange={(event) => setEditedMessage(event.currentTarget.value)} /> : <p>{entry.dispatch.message}</p>}<small>{queueEntryStateLabel(entry, t)} · {formatTime(entry.dispatch.updatedAt, locale)}</small></div>
                  <div>{editing ? <><IconButton label={t("common.save")} disabled={editedMessage.trim() === "" || pendingAction !== undefined} onClick={() => {
                    if (entry.queueItem === undefined) return;
                    void runMutation(`edit-dispatch:${entry.dispatch.id}`, (signal) => latestControllerRef.current.editCollaborationDispatch(entry.dispatch, entry.queueItem!, editedMessage.trim(), signal)).then((succeeded) => { if (succeeded) setEditingDispatchId(undefined); });
                  }}><Save aria-hidden="true" /></IconButton><IconButton label={t("common.cancel")} onClick={() => setEditingDispatchId(undefined)}><X aria-hidden="true" /></IconButton></> : <>
                    <IconButton label={t("collaboration.queueEdit")} disabled={!mutable || collaborationReadOnly || pendingAction !== undefined} onClick={() => { setEditingDispatchId(entry.dispatch.id); setEditedMessage(entry.dispatch.message); }}><Pencil aria-hidden="true" /></IconButton>
                    <IconButton label={t("collaboration.queueCancel")} disabled={!mutable || collaborationReadOnly || pendingAction !== undefined} onClick={() => {
                      if (entry.queueItem === undefined) return;
                      void runMutation(`cancel-dispatch:${entry.dispatch.id}`, (signal) => latestControllerRef.current.cancelCollaborationDispatch(entry.dispatch, entry.queueItem!, signal));
                    }}><Trash2 aria-hidden="true" /></IconButton>
                  </>}</div>
                </article>;
              })}
              {selectedDispatchIds.size > 0 && !canMerge && <small className="collaboration-panel__merge-hint">{t("collaboration.queueMergeHint")}</small>}
            </section>
          </>}
        </section>
      </div>
    </>}
    {tree !== undefined && !hasActiveGoal && !workerViewer && <form className="collaboration-panel__empty" onSubmit={createGoal}>
      <Bot aria-hidden="true" />
      <div><strong>{t("collaboration.newGoal")}</strong><p>{t("collaboration.noGoalBody")}</p></div>
      <label>{t("collaboration.goalTitle")}<input required maxLength={256} value={goalDraft.title} onChange={(event) => { const value = event.currentTarget.value; setGoalDraft((current) => ({ ...current, title: value })); }} /></label>
      <label className="is-wide">{t("collaboration.goalObjective")}<textarea required maxLength={32_000} rows={3} value={goalDraft.objective} onChange={(event) => { const value = event.currentTarget.value; setGoalDraft((current) => ({ ...current, objective: value })); }} /></label>
      <label>{t("collaboration.maximumWorkers")}<input inputMode="numeric" min={1} max={128} type="number" value={goalDraft.maximumWorkers} onChange={(event) => { const value = event.currentTarget.value; setGoalDraft((current) => ({ ...current, maximumWorkers: value })); }} /><small>{t("collaboration.maximumWorkersHint")}</small></label>
      <Button tone="primary" type="submit" disabled={collaborationReadOnly || pendingAction !== undefined || goalDraft.title.trim() === "" || goalDraft.objective.trim() === ""}><Plus aria-hidden="true" />{t("collaboration.createGoal")}</Button>
    </form>}
    <Modal
      open={stopConfirmation !== undefined}
      title={t("collaboration.stopConfirmTitle")}
      description={t("collaboration.stopConfirmBody", {
        title: stopConfirmation?.title ?? "",
        count: tree?.workers.filter((worker) => worker.status !== "archived").length ?? 0
      })}
      closeLabel={t("common.close")}
      size="small"
      dismissOnBackdrop={pendingAction === undefined}
      onClose={() => { if (pendingAction === undefined) setStopConfirmation(undefined); }}
    >
      <div className="modal__actions">
        <Button disabled={pendingAction !== undefined} onClick={() => setStopConfirmation(undefined)}>{t("common.cancel")}</Button>
        <Button tone="danger" disabled={collaborationReadOnly || pendingAction !== undefined || stopConfirmation === undefined} onClick={() => {
          const goal = stopConfirmation;
          if (goal === undefined) return;
          setStopConfirmation(undefined);
          void runMutation("stop-goal", (signal) => latestControllerRef.current.setCollaborationGoalStatus(goal, "stopped", signal));
        }}><CircleStop aria-hidden="true" />{t("collaboration.stopConfirmAction")}</Button>
      </div>
    </Modal>
    {pendingAction !== undefined && <div className="collaboration-panel__busy" role="status"><Spinner />{t("common.working")}</div>}
  </section>;
}

function initialWorkerDraft(session: SessionView, targets: readonly TargetView[], models: readonly ModelView[]): WorkerDraft {
  const targetId = targets.some((target) => target.id === session.targetId) ? session.targetId : targets[0]?.id ?? session.targetId;
  const model = session.model ?? models.find((candidate) => candidate.available && candidate.backendId === session.backendId);
  return {
    label: "",
    role: "",
    assignment: "",
    parentWorkerId: "",
    targetId,
    modelKey: model === undefined ? "" : modelKey(model),
    effort: session.effort ?? "",
    fastMode: session.fastMode,
    permissionMode: session.permissionMode,
    planMode: session.planMode
  };
}

function orderWorkers(workers: readonly CollaborationWorkerView[]): readonly { readonly worker: CollaborationWorkerView; readonly depth: number }[] {
  const children = new Map<string | undefined, CollaborationWorkerView[]>();
  for (const worker of workers) {
    const bucket = children.get(worker.parentWorkerId) ?? [];
    bucket.push(worker);
    children.set(worker.parentWorkerId, bucket);
  }
  for (const bucket of children.values()) bucket.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const result: { worker: CollaborationWorkerView; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | undefined, depth: number): void => {
    for (const worker of children.get(parentId) ?? []) {
      if (seen.has(worker.id)) continue;
      seen.add(worker.id);
      result.push({ worker, depth });
      visit(worker.id, depth + 1);
    }
  };
  visit(undefined, 0);
  for (const worker of workers) if (!seen.has(worker.id)) result.push({ worker, depth: 0 });
  return result;
}

function upsertGoal(goals: readonly CollaborationGoalView[], goal: CollaborationGoalView): readonly CollaborationGoalView[] {
  return [...goals.filter((candidate) => candidate.id !== goal.id), goal]
    .sort((left, right) => Number(right.status === "active") - Number(left.status === "active") || right.updatedAt - left.updatedAt);
}

function optionalPositiveInteger(value: string): number | undefined | false {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : false;
}

function modelKey(model: Pick<ModelView, "providerId" | "modelId">): string {
  return `${model.providerId}\u0000${model.modelId}`;
}

function modelForKey(models: readonly ModelView[], key: string): ModelView | undefined {
  return models.find((model) => modelKey(model) === key);
}

function targetName(targets: readonly TargetView[], targetId: string): string {
  return targets.find((target) => target.id === targetId)?.name ?? targetId;
}

function permissionLabel(permission: PermissionMode, t: Translator): string {
  if (permission === "ask") return t("permission.ask");
  if (permission === "auto") return t("permission.auto");
  return t("permission.full");
}

function workerOccupiesRuntime(worker: CollaborationWorkerView): boolean {
  return !worker.runtimeReleased && !["stopped", "archived"].includes(worker.status);
}

function workerTerminal(worker: CollaborationWorkerView): boolean {
  return ["completed", "failed", "stopped", "archived"].includes(worker.status);
}

function goalTone(status: CollaborationGoalView["status"]): "neutral" | "success" | "warning" | "danger" | "accent" {
  if (status === "active") return "accent";
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "stopped") return "warning";
  return "neutral";
}

function workerTone(status: CollaborationWorkerView["status"]): "neutral" | "success" | "warning" | "danger" | "accent" {
  if (status === "running" || status === "queued" || status === "provisioning") return "accent";
  if (status === "idle" || status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "stopping" || status === "dispatchUnknown") return "warning";
  return "neutral";
}

function canMutateQueueEntry(entry: CollaborationQueueEntryView): boolean {
  return entry.dispatch.status === "queued" && entry.queueItem?.state === "accepted" && entry.queueItem.editLocked === false;
}

function pendingQueueEntry(entry: CollaborationQueueEntryView): boolean {
  if (entry.dispatch.status === "preparing" || entry.dispatch.status === "dispatchUnknown") return true;
  if (entry.dispatch.status !== "queued" || entry.queueItem === undefined) return false;
  return ["accepted", "dispatching", "acceptedByBackend", "dispatchUnknown"].includes(entry.queueItem.state);
}

function queueEntryStateLabel(entry: CollaborationQueueEntryView, t: Translator): string {
  const state = entry.queueItem?.state;
  if (state === "accepted") return t("collaboration.queueItemState.accepted");
  if (state === "dispatching") return t("collaboration.queueItemState.dispatching");
  if (state === "acceptedByBackend") return t("collaboration.queueItemState.acceptedByBackend");
  if (state === "dispatchUnknown") return t("collaboration.queueItemState.dispatchUnknown");
  return t(`collaboration.queueState.${entry.dispatch.status}`);
}

function compareQueueEntries(left: CollaborationQueueEntryView, right: CollaborationQueueEntryView): number {
  if (left.queueItem !== undefined && right.queueItem !== undefined) return left.queueItem.ordinal - right.queueItem.ordinal;
  return left.dispatch.createdAt - right.dispatch.createdAt || left.dispatch.id.localeCompare(right.dispatch.id);
}

function contiguousSelection(entries: readonly CollaborationQueueEntryView[], selected: ReadonlySet<string>): boolean {
  const indexes = entries.map((entry, index) => selected.has(entry.dispatch.id) ? index : -1).filter((index) => index >= 0);
  return indexes.length >= 2 && indexes.every((index, position) => position === 0 || index === indexes[position - 1]! + 1);
}

function toggled(current: ReadonlySet<string>, value: string, selected: boolean): ReadonlySet<string> {
  const next = new Set(current);
  if (selected) next.add(value); else next.delete(value);
  return next;
}

function formatTime(value: number, locale: Locale): string {
  return new Date(value).toLocaleString(locale === "en-XA" ? "en" : locale, { dateStyle: "medium", timeStyle: "short" });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleStop,
  LoaderCircle,
  SendHorizontal,
  Square
} from "lucide-react";

import type { AppController } from "../controller.js";
import type {
  ErrorView,
  SubagentChildRunView,
  SubagentControlActionView,
  SubagentRunDetailView,
  SubagentRunStateView,
  SubagentRunView,
  SubagentTranscriptEntryView
} from "../model.js";
import { buildSubagentConversation, mergeSubagentTranscript } from "./subagent-conversation.js";
import {
  classifySubagentError,
  collectAllSubagentTranscript,
  currentSubagentChildren,
  filterSubagentTranscript,
  projectSubagentReply,
  resolveCurrentSubagentChild
} from "./subagent-panel-state.js";
import { buildSubagentTree, flattenSubagentTree } from "./subagent-tree.js";
import {
  VirtualSubagentChildList,
  VirtualSubagentChildTabs,
  VirtualSubagentConversation,
  VirtualSubagentRunGroups,
  VirtualSubagentTechnicalDetails
} from "./subagent-virtual-lists.js";
import type { RunAction, Translator } from "./types.js";
import {
  Button,
  IconButton,
  Pill,
  Spinner,
  cx,
  formatDateTime,
  formatRelativeTime
} from "./ui.js";
import { StreamingMarkdown } from "./Timeline.js";
import {
  currentComposerPlatform,
  getComposerSendShortcutLabel,
  resolveComposerEnterIntent
} from "./composer-behavior.js";

const LIVE_REFRESH_MS = 2_000;
const RUN_PAGE_SIZE = 100;
const TRANSCRIPT_PAGE_SIZE = 200;
const MAXIMUM_CONTROL_MESSAGE_LENGTH = 32_000;

type ReadState = "idle" | "loading" | "ready" | "error";
type ComposerAction = Exclude<SubagentControlActionView, "stop">;

const STALE_READ = Symbol("stale delegated read");

export function SubagentsPanel({ controller, sessionId, focusRunId, focusRequestId, locale, t, runAction }: {
  readonly controller: AppController;
  readonly sessionId: string;
  readonly focusRunId?: string;
  readonly focusRequestId?: number;
  readonly locale: string;
  readonly t: Translator;
  readonly runAction: RunAction;
}): JSX.Element {
  const controllerRef = useRef(controller);
  const conversationPanelId = useId();
  controllerRef.current = controller;
  const mountedRef = useRef(true);
  const scopeRef = useRef({ sessionId, selectedRunId: undefined as string | undefined });
  const [runs, setRuns] = useState<readonly SubagentRunView[]>([]);
  const [listState, setListState] = useState<ReadState>("loading");
  const [listError, setListError] = useState<string>();
  const [listNextPageToken, setListNextPageToken] = useState<string>();
  const [listTotalSize, setListTotalSize] = useState(0);
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string>(focusRunId ?? "");
  const [detail, setDetail] = useState<SubagentRunDetailView>();
  const [detailState, setDetailState] = useState<ReadState>("idle");
  const [detailError, setDetailError] = useState<string>();
  const [selectedChildIdentity, setSelectedChildIdentity] = useState("");
  const [transcript, setTranscript] = useState<readonly SubagentTranscriptEntryView[]>([]);
  const [transcriptState, setTranscriptState] = useState<ReadState>("idle");
  const [transcriptError, setTranscriptError] = useState<string>();
  const [transcriptTailComplete, setTranscriptTailComplete] = useState(false);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [composerPending, setComposerPending] = useState(false);
  const [composerError, setComposerError] = useState<string>();
  const [stopPending, setStopPending] = useState(false);
  const [stopError, setStopError] = useState<string>();
  const composerPendingRef = useRef<symbol | undefined>(undefined);
  const stopPendingRef = useRef<symbol | undefined>(undefined);
  const controlEpochRef = useRef(0);
  const listEpochRef = useRef(0);
  const detailEpochRef = useRef(0);
  const transcriptEpochRef = useRef(0);
  const listQueueRef = useRef<Promise<void>>(Promise.resolve());
  const detailQueueRef = useRef<Promise<void>>(Promise.resolve());
  const transcriptQueueRef = useRef<Promise<void>>(Promise.resolve());
  const transcriptTailTokenRef = useRef<string | undefined>(undefined);
  const handledFocusRequestRef = useRef<number | undefined>(undefined);
  const detailBackButtonRef = useRef<HTMLButtonElement>(null);
  const [returnFocusRunId, setReturnFocusRunId] = useState<string>();
  const [runFocusRequestId, setRunFocusRequestId] = useState(0);
  const [toolExpansionByScope, setToolExpansionByScope] = useState<Readonly<Record<string, Readonly<Record<string, boolean>>>>>({});

  scopeRef.current = { sessionId, selectedRunId: selectedRunId || undefined };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listEpochRef.current += 1;
      detailEpochRef.current += 1;
      transcriptEpochRef.current += 1;
      controlEpochRef.current += 1;
    };
  }, []);

  const listScopeIsCurrent = useCallback((epoch: number): boolean => (
    mountedRef.current
    && listEpochRef.current === epoch
    && scopeRef.current.sessionId === sessionId
  ), [sessionId]);

  const loadRuns = useCallback((pageToken = "", append = false, quiet = false): Promise<void> => {
    const epoch = listEpochRef.current;
    if (append) setLoadingMoreRuns(true);
    else if (!quiet) setListState("loading");
    setListError(undefined);
    const execute = async (): Promise<void> => {
      if (!listScopeIsCurrent(epoch)) return;
      try {
        const page = await controllerRef.current.listSubagentRuns(sessionId, undefined, pageToken, RUN_PAGE_SIZE);
        if (!listScopeIsCurrent(epoch)) return;
        setRuns((current) => append || quiet ? mergeSubagentRuns(current, page.runs) : page.runs);
        setListTotalSize(page.totalSize);
        if (!quiet || append) setListNextPageToken(page.nextPageToken);
        setListState("ready");
      } catch (error) {
        if (error === STALE_READ || !listScopeIsCurrent(epoch)) return;
        setListError(messageOf(error));
        setListState("error");
      } finally {
        if (listScopeIsCurrent(epoch) && append) setLoadingMoreRuns(false);
      }
    };
    const queued = listQueueRef.current.then(execute, execute);
    listQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }, [listScopeIsCurrent, sessionId]);

  const detailScopeIsCurrent = useCallback((epoch: number, runId: string): boolean => (
    mountedRef.current
    && detailEpochRef.current === epoch
    && scopeRef.current.sessionId === sessionId
    && scopeRef.current.selectedRunId === runId
  ), [sessionId]);

  const loadDetail = useCallback((runId: string, quiet = false): Promise<SubagentRunDetailView | undefined> => {
    const epoch = detailEpochRef.current;
    if (!quiet) setDetailState("loading");
    setDetailError(undefined);
    let resolved: SubagentRunDetailView | undefined;
    const execute = async (): Promise<void> => {
      if (!detailScopeIsCurrent(epoch, runId)) return;
      try {
        const value = await controllerRef.current.getSubagentRun(sessionId, runId);
        if (!detailScopeIsCurrent(epoch, runId)) return;
        resolved = value;
        setDetail(value);
        setDetailState("ready");
        setRuns((current) => replaceSubagentRun(current, value.run));
      } catch (error) {
        if (!detailScopeIsCurrent(epoch, runId)) return;
        setDetailError(messageOf(error));
        setDetailState("error");
      }
    };
    const queued = detailQueueRef.current.then(execute, execute);
    detailQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued.then(() => resolved);
  }, [detailScopeIsCurrent, sessionId]);

  const transcriptScopeIsCurrent = useCallback((epoch: number, runId: string): boolean => (
    mountedRef.current
    && transcriptEpochRef.current === epoch
    && scopeRef.current.sessionId === sessionId
    && scopeRef.current.selectedRunId === runId
  ), [sessionId]);

  const refreshTranscript = useCallback((runId: string, mode: "full" | "tail", quiet = false): Promise<void> => {
    const epoch = transcriptEpochRef.current;
    if (!quiet || transcript.length === 0) setTranscriptState("loading");
    if (mode === "full") setTranscriptTailComplete(false);
    setTranscriptError(undefined);
    const execute = async (): Promise<void> => {
      if (!transcriptScopeIsCurrent(epoch, runId)) return;
      const loadPage = (pageToken: string) => {
        if (!transcriptScopeIsCurrent(epoch, runId)) throw STALE_READ;
        return controllerRef.current.listSubagentTranscript(sessionId, runId, undefined, pageToken, TRANSCRIPT_PAGE_SIZE);
      };
      try {
        const requestedTail = mode === "tail" ? transcriptTailTokenRef.current : undefined;
        let append = requestedTail !== undefined;
        let page;
        if (append) {
          try {
            page = await collectAllSubagentTranscript(loadPage, requestedTail);
          } catch (error) {
            if (error === STALE_READ || !transcriptScopeIsCurrent(epoch, runId)) throw error;
            append = false;
            setTranscriptTailComplete(false);
            page = await collectAllSubagentTranscript(loadPage);
          }
        } else {
          page = await collectAllSubagentTranscript(loadPage);
        }
        if (!transcriptScopeIsCurrent(epoch, runId)) return;
        setTranscript((current) => append ? mergeSubagentTranscript(current, page.entries) : page.entries);
        transcriptTailTokenRef.current = page.tailPageToken;
        setTranscriptTailComplete(true);
        setTranscriptState("ready");
      } catch (error) {
        if (error === STALE_READ || !transcriptScopeIsCurrent(epoch, runId)) return;
        transcriptTailTokenRef.current = undefined;
        setTranscriptError(messageOf(error));
        setTranscriptState("error");
      }
    };
    const queued = transcriptQueueRef.current.then(execute, execute);
    transcriptQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }, [sessionId, transcript.length, transcriptScopeIsCurrent]);

  useEffect(() => {
    listEpochRef.current += 1;
    detailEpochRef.current += 1;
    transcriptEpochRef.current += 1;
    setRuns([]);
    setListTotalSize(0);
    setListNextPageToken(undefined);
    setLoadingMoreRuns(false);
    setSelectedRunId(focusRunId ?? "");
    setDetail(undefined);
    setDetailState("idle");
    setSelectedChildIdentity("");
    setTranscript([]);
    setTranscriptState("idle");
    setTranscriptTailComplete(false);
    transcriptTailTokenRef.current = undefined;
    setComposerError(undefined);
    composerPendingRef.current = undefined;
    setComposerPending(false);
    setStopError(undefined);
    stopPendingRef.current = undefined;
    setStopPending(false);
    setReturnFocusRunId(undefined);
    setToolExpansionByScope({});
    void loadRuns();
  }, [sessionId]);

  useEffect(() => {
    if (focusRunId === undefined || focusRequestId === undefined || handledFocusRequestRef.current === focusRequestId) return;
    handledFocusRequestRef.current = focusRequestId;
    setSelectedRunId(focusRunId);
  }, [focusRequestId, focusRunId]);

  useEffect(() => {
    detailEpochRef.current += 1;
    transcriptEpochRef.current += 1;
    controlEpochRef.current += 1;
    composerPendingRef.current = undefined;
    stopPendingRef.current = undefined;
    setComposerPending(false);
    setStopPending(false);
    setStopError(undefined);
    setDetail(undefined);
    setDetailError(undefined);
    setSelectedChildIdentity("");
    setTranscript([]);
    setTranscriptError(undefined);
    setTranscriptTailComplete(false);
    transcriptTailTokenRef.current = undefined;
    setComposerError(undefined);
    if (selectedRunId === "") {
      setDetailState("idle");
      setTranscriptState("idle");
      return;
    }
    void loadDetail(selectedRunId).then((value) => {
      if (value?.run.capabilities.viewFullTranscript === true) {
        return refreshTranscript(selectedRunId, "full");
      }
      if (scopeRef.current.selectedRunId === selectedRunId) setTranscriptState("idle");
      return undefined;
    });
  }, [selectedRunId, sessionId]);

  useEffect(() => {
    if (selectedRunId === "") return;
    const frame = window.requestAnimationFrame(() => detailBackButtonRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [selectedRunId]);

  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const runForDetail = detail?.run.id === selectedRunId ? detail.run : selectedRun;
  const hasActiveRun = runs.some((run) => isSubagentActive(run.state))
    || (runForDetail !== undefined && isSubagentActive(runForDetail.state));

  useEffect(() => {
    if (!hasActiveRun) return;
    let cancelled = false;
    let timer: number | undefined;
    const arm = (): void => {
      if (!cancelled) timer = window.setTimeout(() => { void round(); }, LIVE_REFRESH_MS);
    };
    const round = async (): Promise<void> => {
      if (cancelled) return;
      try {
        await loadRuns("", false, true);
        if (cancelled) return;
        if (selectedRunId === "") return;
        if (scopeRef.current.selectedRunId !== selectedRunId) return;
        const value = await loadDetail(selectedRunId, true);
        if (cancelled || scopeRef.current.selectedRunId !== selectedRunId) return;
        if ((value?.run.capabilities.viewFullTranscript ?? runForDetail?.capabilities.viewFullTranscript) === true) {
          await refreshTranscript(selectedRunId, "tail", true);
        }
      } finally {
        arm();
      }
    };
    arm();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [hasActiveRun, loadDetail, loadRuns, refreshTranscript, runForDetail?.capabilities.viewFullTranscript, selectedRunId]);

  const tree = useMemo(() => flattenSubagentTree(buildSubagentTree(runs)), [runs]);
  const currentChildren = useMemo(() => currentSubagentChildren(detail?.children ?? []), [detail?.children]);
  const selectedChild = useMemo(
    () => resolveCurrentSubagentChild(detail?.children ?? [], selectedChildIdentity),
    [detail?.children, selectedChildIdentity]
  );
  const visibleTranscript = useMemo(
    () => filterSubagentTranscript(transcript, selectedChild, detail?.children ?? []),
    [detail?.children, selectedChild, transcript]
  );
  const conversation = useMemo(() => buildSubagentConversation(visibleTranscript), [visibleTranscript]);

  useEffect(() => {
    if (selectedChildIdentity !== "" && selectedChild === undefined && currentChildren.length !== 1) {
      setSelectedChildIdentity("");
    }
  }, [currentChildren.length, selectedChild, selectedChildIdentity]);

  useEffect(() => {
    controlEpochRef.current += 1;
    composerPendingRef.current = undefined;
    stopPendingRef.current = undefined;
    setComposerPending(false);
    setStopPending(false);
    setComposerError(undefined);
    setStopError(undefined);
  }, [selectedChildIdentity]);

  const currentChildIds = useMemo(() => new Set(
    selectedChild === undefined ? currentChildren.map((child) => child.id) : [selectedChild.id]
  ), [currentChildren, selectedChild]);
  const canViewResult = runForDetail?.capabilities.viewReturnedResult === true;
  const durableResultUsesChild = selectedChild?.result !== undefined;
  const durableResult = canViewResult
    ? selectedChild?.result ?? (selectedChild === undefined || currentChildren.length === 1 ? detail?.returnedResult : undefined)
    : undefined;
  const reply = useMemo(
    () => projectSubagentReply(visibleTranscript, currentChildIds, durableResult, transcriptTailComplete),
    [currentChildIds, durableResult, transcriptTailComplete, visibleTranscript]
  );
  const assignment = selectedChild?.assignment ?? runForDetail?.assignment ?? runForDetail?.description;
  const showAssignmentFallback = assignment !== undefined
    && assignment.trim() !== ""
    && !conversation.items.some((item) => item.kind === "parent");
  const displayedState = selectedChild?.state ?? runForDetail?.state;
  const displayedError = selectedChild?.error ?? runForDetail?.error;
  const selectedActive = selectedChild === undefined || isSubagentActive(selectedChild.state);
  const resultTruncated = durableResultUsesChild
    ? selectedChild?.resultTruncated ?? false
    : detail?.returnedResultTruncated ?? false;
  const hasSettledReply = reply.hasReply;
  const defaultComposerAction = composerAction(runForDetail, selectedChild, false, hasSettledReply);
  const modifierComposerAction = composerAction(runForDetail, selectedChild, true, hasSettledReply);
  const sendShortcutPreference = controller.state?.preferences.composerSendShortcut ?? "enter";
  const composerPlatform = currentComposerPlatform();
  const sendShortcutLabel = getComposerSendShortcutLabel(sendShortcutPreference, composerPlatform);
  const draftKey = `${sessionId}:${selectedRunId}:${selectedChildIdentity || selectedChild?.id || "all"}`;
  const draft = drafts[draftKey] ?? "";
  const conversationScopeKey = `${sessionId}:${selectedRunId}:${selectedChildIdentity || "all"}`;
  const toolExpansion = toolExpansionByScope[conversationScopeKey] ?? {};
  const selectedConversationTabIndex = selectedChild === undefined
    ? 0
    : Math.max(0, currentChildren.findIndex((child) => child.id === selectedChild.id) + 1);

  const selectRun = (runId: string): void => {
    setReturnFocusRunId(runId);
    setSelectedRunId(runId);
  };

  const returnToRunList = (): void => {
    setReturnFocusRunId(selectedRunId);
    setRunFocusRequestId((current) => current + 1);
    setSelectedRunId("");
  };

  const setToolExpansion = (itemId: string, expanded: boolean): void => {
    setToolExpansionByScope((current) => ({
      ...current,
      [conversationScopeKey]: { ...current[conversationScopeKey], [itemId]: expanded }
    }));
  };

  const refreshAfterControl = async (runId: string): Promise<void> => {
    await loadRuns("", false, true);
    const value = await loadDetail(runId, true);
    if (value?.run.capabilities.viewFullTranscript === true) await refreshTranscript(runId, "full", true);
  };

  const submitComposer = (action: ComposerAction | undefined): void => {
    const message = draft.trim();
    if (action === undefined || message === "" || runForDetail === undefined || composerPendingRef.current !== undefined) return;
    const operation = Symbol("subagent composer operation");
    const controlEpoch = controlEpochRef.current;
    composerPendingRef.current = operation;
    setComposerPending(true);
    setComposerError(undefined);
    const runId = runForDetail.id;
    const childId = selectedChild?.id;
    const ownsControl = (): boolean => mountedRef.current
      && controlEpochRef.current === controlEpoch
      && scopeRef.current.sessionId === sessionId
      && scopeRef.current.selectedRunId === runId;
    try {
      runAction(`subagent-${action}:${runId}:${childId ?? "all"}`, async () => {
        try {
          await controllerRef.current.controlSubagent(sessionId, runId, action, message, childId);
          if (!ownsControl()) return;
          setDrafts((current) => ({ ...current, [draftKey]: "" }));
          await refreshAfterControl(runId);
        } catch (error) {
          if (ownsControl()) setComposerError(messageOf(error));
        } finally {
          if (mountedRef.current && composerPendingRef.current === operation) {
            composerPendingRef.current = undefined;
            setComposerPending(false);
          }
        }
      });
    } catch (error) {
      if (ownsControl()) setComposerError(messageOf(error));
      if (composerPendingRef.current === operation) {
        composerPendingRef.current = undefined;
        setComposerPending(false);
      }
    }
  };

  const onComposerSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    submitComposer(defaultComposerAction);
  };

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    const intent = resolveComposerEnterIntent({
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing || event.keyCode === 229
    }, sendShortcutPreference, { turnRunning: runForDetail?.state === "running", platform: composerPlatform });
    if (intent === null || intent === "native") return;
    event.preventDefault();
    if (intent === "ignore" || composerPending) return;
    submitComposer(intent === "steer" ? modifierComposerAction ?? defaultComposerAction : defaultComposerAction);
  };

  const submitStop = (target: { readonly runId: string; readonly childId?: string }): void => {
    if (stopPendingRef.current !== undefined) return;
    const operation = Symbol("subagent stop operation");
    const controlEpoch = controlEpochRef.current;
    stopPendingRef.current = operation;
    setStopPending(true);
    setStopError(undefined);
    const ownsControl = (): boolean => mountedRef.current
      && controlEpochRef.current === controlEpoch
      && scopeRef.current.sessionId === sessionId
      && scopeRef.current.selectedRunId === target.runId;
    try {
      runAction(`subagent-stop:${target.runId}:${target.childId ?? "all"}`, async () => {
        try {
          await controllerRef.current.controlSubagent(sessionId, target.runId, "stop", "", target.childId);
          if (!ownsControl()) return;
          await refreshAfterControl(target.runId);
        } catch (error) {
          if (ownsControl()) setStopError(messageOf(error));
        } finally {
          if (mountedRef.current && stopPendingRef.current === operation) {
            stopPendingRef.current = undefined;
            setStopPending(false);
          }
        }
      });
    } catch (error) {
      if (ownsControl()) setStopError(messageOf(error));
      if (stopPendingRef.current === operation) {
        stopPendingRef.current = undefined;
        setStopPending(false);
      }
    }
  };

  const activeRows = tree.filter(({ run }) => isSubagentActive(run.state));
  const finishedRows = tree.filter(({ run }) => !isSubagentActive(run.state));
  const detailTitle = selectedChild?.title ?? runForDetail?.title ?? selectedRun?.title ?? t("subagents.title");
  const detailMetadata = runForDetail === undefined ? [] : [
    selectedChild?.awaitingApproval === true ? t("subagents.awaitingApproval") : subagentStateLabel(displayedState ?? runForDetail.state, t),
    formatSubagentRoute(selectedChild ?? runForDetail) === "—" ? undefined : formatSubagentRoute(selectedChild ?? runForDetail),
    formatSubagentUsage(selectedChild ?? runForDetail, locale, t) === "—" ? undefined : formatSubagentUsage(selectedChild ?? runForDetail, locale, t),
    displayedReadOnly(selectedChild, runForDetail) === undefined ? undefined : t(displayedReadOnly(selectedChild, runForDetail) ? "subagents.readOnly" : "subagents.writeEnabled")
  ].filter((part): part is string => part !== undefined);

  return <div className="subagents-panel">
    {selectedRunId === "" ? <>
      <header className="subagents-panel__header">
        <Bot aria-hidden="true" /><strong>{t("subagents.title")}</strong>
        {listState !== "loading" || runs.length > 0
          ? <span>{t("subagents.count", { shown: runs.length, total: Math.max(runs.length, listTotalSize) })}</span>
          : null}
      </header>
      <div className="subagents-run-list">
        {listState === "loading" && runs.length === 0 && <Spinner label={t("common.loading")} />}
        {listState === "error" && <InlineFailure text={listError ?? t("subagents.loadFailed")} t={t} compact={runs.length > 0} onRetry={() => { void loadRuns(); }} />}
        {listState === "ready" && runs.length === 0 && <div className="subagents-empty"><Bot aria-hidden="true" /><p>{t("subagents.empty")}</p></div>}
        {(activeRows.length > 0 || finishedRows.length > 0) && <VirtualSubagentRunGroups
          activeRows={activeRows}
          finishedRows={finishedRows}
          activeLabel={t("subagents.runningGroup")}
          finishedLabel={t("subagents.finishedGroup")}
          ariaLabel={t("subagents.tree")}
          focusRunId={returnFocusRunId}
          focusRequestId={runFocusRequestId}
          renderRun={({ run, depth }) => <SubagentRunRow run={run} depth={depth} locale={locale} t={t} onSelect={selectRun} />}
        />}
        {listNextPageToken !== undefined && <Button className="subagents-run-list__more" tone="ghost" disabled={loadingMoreRuns} onClick={() => { void loadRuns(listNextPageToken, true); }}>{loadingMoreRuns ? t("common.loading") : t("subagents.loadEarlier")}</Button>}
      </div>
    </> : <main className="subagent-detail">
      <header className="subagent-detail-bar">
        <IconButton buttonRef={detailBackButtonRef} tip="" label={t("common.back")} onClick={returnToRunList}><ArrowLeft aria-hidden="true" /></IconButton>
        <strong role="heading" aria-level={2}>{detailTitle}</strong>
        {runForDetail?.capabilities.stop === true && runForDetail.state === "running" && (selectedChild === undefined || selectedChild.state === "running") && <IconButton
          className="subagent-detail__stop"
          disabled={stopPending}
          label={stopPending ? t("subagents.stopping") : t("common.stop")}
          onClick={() => submitStop({ runId: runForDetail.id, ...(selectedChild === undefined ? {} : { childId: selectedChild.id }) })}
        >{stopPending ? <Spinner label={t("subagents.stopping")} /> : <Square aria-hidden="true" />}</IconButton>}
        {runForDetail !== undefined && <SubagentStateIcon state={runForDetail.state} label={subagentStateLabel(runForDetail.state, t)} />}
      </header>
      <div className="subagent-detail__scroll"><div className="subagent-detail__content">
        {detailState === "loading" && detail === undefined && <Spinner label={t("common.loading")} />}
        {detailState === "error" && runForDetail === undefined && <InlineFailure text={detailError ?? t("subagents.loadFailed")} t={t} onRetry={() => { void loadDetail(selectedRunId); }} />}
        {runForDetail !== undefined && <>
          <p className="subagent-detail__metadata">{detailMetadata.join(" · ")}</p>
          {stopError !== undefined && <p className="subagent-error" role="alert"><AlertTriangle aria-hidden="true" />{t("subagents.stopFailed")} <span>{stopError}</span></p>}
          {currentChildren.length > 1 && <section className="subagent-section" aria-label={t("subagents.children")}>
            <VirtualSubagentChildTabs
              children={currentChildren}
              selectedId={selectedChild?.id ?? ""}
              overviewLabel={t("subagents.overview")}
              ariaLabel={t("subagents.transcriptScope")}
              controlsId={conversationPanelId}
              tabIdPrefix={conversationPanelId}
              onSelect={setSelectedChildIdentity}
              renderChild={(child) => <>
                <SubagentStateIcon state={child.state} label={child.awaitingApproval === true ? t("subagents.awaitingApproval") : subagentStateLabel(child.state, t)} />
                <span>{child.title}</span>
              </>}
            />
            {selectedChild === undefined && <VirtualSubagentChildList
              children={currentChildren}
              ariaLabel={t("subagents.children")}
              onSelect={setSelectedChildIdentity}
              renderChild={(child) => <>
                <SubagentStateIcon state={child.state} label={child.awaitingApproval === true ? t("subagents.awaitingApproval") : subagentStateLabel(child.state, t)} />
                <span><strong>{child.title}</strong><small>{formatChildMetadata(child, locale, t)}</small></span>
                {child.readOnly !== undefined && <Pill tone={child.readOnly ? "neutral" : "warning"}>{t(child.readOnly ? "subagents.readOnly" : "subagents.writeEnabled")}</Pill>}
                {child.awaitingApproval === true && <Pill tone="warning">{t("subagents.awaitingApproval")}</Pill>}
              </>}
            />}
          </section>}
          <section
            id={conversationPanelId}
            className="subagent-section subagent-transcript"
            role={currentChildren.length > 1 ? "tabpanel" : undefined}
            aria-label={currentChildren.length > 1 ? undefined : t("subagents.transcript")}
            aria-labelledby={currentChildren.length > 1 ? `${conversationPanelId}-tab-${selectedConversationTabIndex}` : undefined}
          >
            {showAssignmentFallback && <article className="subagent-message subagent-message--parent subagent-message--fallback"><StreamingMarkdown text={assignment!} streaming={false} t={t} /><time>{formatDateTime(selectedChild?.startedAt ?? runForDetail.startedAt, locale)}</time></article>}
            {runForDetail.capabilities.viewFullTranscript && transcriptState === "loading" && transcript.length === 0 && <Spinner label={t("common.loading")} />}
            {runForDetail.capabilities.viewFullTranscript && transcriptState === "error" && <InlineFailure compact={transcript.length > 0} text={transcriptError ?? t("subagents.transcriptFailed")} t={t} onRetry={() => { void refreshTranscript(runForDetail.id, "full"); }} />}
            {conversation.items.length > 0 && <VirtualSubagentConversation
              key={conversationScopeKey}
              scopeKey={conversationScopeKey}
              items={conversation.items}
              locale={locale}
              t={t}
              toolExpansion={toolExpansion}
              onToolExpansion={setToolExpansion}
            />}
            {reply.showDurableResult && durableResult !== undefined && <article className="subagent-message subagent-message--subagent subagent-message--durable"><StreamingMarkdown text={durableResult} streaming={false} t={t} /><time>{formatDateTime(selectedChild?.endedAt ?? runForDetail.updatedAt, locale)}</time></article>}
            {selectedChild?.awaitingApproval === true
              ? <SubagentNotice tone="waiting" text={t("subagents.awaitingApprovalDetail")} />
              : displayedState === "queued"
                ? <SubagentNotice tone="waiting" text={t("subagents.queuedDetail")} />
                : displayedState === "running"
                  ? <SubagentNotice tone="waiting" text={t("subagents.waitingForReply")} />
                  : !reply.hasReply && displayedError === undefined
                    ? <SubagentNotice tone="error" text={t(displayedState === "failed" ? "subagents.failedNoReply" : displayedState === "stopped" ? "subagents.stoppedNoReply" : "subagents.completedNoReply")} />
                    : null}
            {(resultTruncated || reply.recordTruncated) && <p className="subagent-transcript__truncated"><AlertTriangle aria-hidden="true" />{t(resultTruncated ? "subagents.resultTruncated" : "subagents.transcriptTruncated")}</p>}
            {!runForDetail.capabilities.viewFullTranscript && conversation.items.length === 0 && !reply.showDurableResult && displayedState !== "running" && <p className="subagent-section__empty">{t("subagents.transcriptUnavailable")}</p>}
          </section>
          {displayedError !== undefined && <SubagentErrorNotice error={displayedError} t={t} />}
          {(runForDetail.capabilities.viewActivity || runForDetail.capabilities.viewFullTranscript) && <VirtualSubagentTechnicalDetails
            activity={detail?.activity ?? []}
            system={conversation.system}
            showActivity={runForDetail.capabilities.viewActivity}
            locale={locale}
            t={t}
          />}
        </>}
      </div></div>
      {runForDetail !== undefined && defaultComposerAction !== undefined && <form className="subagent-composer" onSubmit={onComposerSubmit}>
        <div>
          <textarea rows={2} maxLength={MAXIMUM_CONTROL_MESSAGE_LENGTH} value={draft} disabled={composerPending} onChange={(event) => setDrafts((current) => ({ ...current, [draftKey]: event.target.value }))} onKeyDown={onComposerKeyDown} placeholder={t(defaultComposerAction === "resume" ? "subagents.composerResume" : sendShortcutPreference === "enter" && modifierComposerAction === "steer" ? "subagents.composerFollowUpWithSteer" : "subagents.composerFollowUp")} aria-label={t("subagents.sendDirection")} title={t("subagents.sendShortcutTitle", { shortcut: sendShortcutLabel })} />
          <Button type="submit" tone="primary" aria-label={controlActionLabel(defaultComposerAction, t)} disabled={composerPending || draft.trim() === ""}>{composerPending ? <Spinner label={t("common.loading")} /> : <SendHorizontal aria-hidden="true" />}</Button>
        </div>
        <small>{sendShortcutPreference === "enter" && modifierComposerAction === "steer" ? t("subagents.steerShortcut") : t("subagents.sendShortcutHint", { shortcut: sendShortcutLabel })}</small>
        {composerError !== undefined && <p role="alert">{t("subagents.controlFailed")} <span>{composerError}</span></p>}
      </form>}
      {runForDetail?.state === "running" && selectedChild !== undefined && !selectedActive && <p className="subagent-composer__ended">{t("subagents.childEndedControlHint")}</p>}
    </main>}
  </div>;
}

function InlineFailure({ text, t, onRetry, compact = false }: { readonly text: string; readonly t: Translator; readonly onRetry: () => void; readonly compact?: boolean }): JSX.Element {
  return <div className={cx("subagents-failure", compact && "is-compact")} role="alert"><AlertTriangle aria-hidden="true" /><p>{text}</p><Button tone="ghost" onClick={onRetry}>{t("common.retry")}</Button></div>;
}

function SubagentRunRow({ run, depth, locale, t, onSelect }: {
  readonly run: SubagentRunView;
  readonly depth: number;
  readonly locale: string;
  readonly t: Translator;
  readonly onSelect: (runId: string) => void;
}): JSX.Element {
  const metadata = [
    formatSubagentRoute(run) === "—" ? undefined : formatSubagentRoute(run),
    formatSubagentUsage(run, locale, t) === "—" ? undefined : formatSubagentUsage(run, locale, t),
    run.readOnly === undefined ? undefined : t(run.readOnly ? "subagents.readOnly" : "subagents.writeEnabled")
  ].filter((part): part is string => part !== undefined);
  return <button type="button" className="subagents-run-row" onClick={() => onSelect(run.id)} style={{ paddingInlineStart: `${12 + Math.min(depth, 8) * 14}px` }}>
    <span className="subagents-run-row__avatar"><SubagentStateIcon state={run.state} label={subagentStateLabel(run.state, t)} /></span>
    <span className="subagents-run-row__copy"><strong>{run.title}</strong><small className="subagents-run-row__summary">{run.summary ?? run.description ?? subagentStateLabel(run.state, t)}</small>{metadata.length > 0 && <small className="subagents-run-row__metadata">{metadata.join(" · ")}</small>}</span>
    <time>{formatRelativeTime(run.updatedAt, locale)}</time>
  </button>;
}

function SubagentStateIcon({ state, label }: { readonly state: SubagentRunStateView; readonly label: string }): JSX.Element {
  if (state === "completed") return <CheckCircle2 className="subagent-state-icon" aria-label={label} />;
  if (state === "failed") return <AlertCircle className="subagent-state-icon is-error" aria-label={label} />;
  if (state === "stopped") return <CircleStop className="subagent-state-icon" aria-label={label} />;
  return <LoaderCircle className={cx("subagent-state-icon", state === "running" && "spin-slow")} aria-label={label} />;
}

function SubagentNotice({ tone, text }: { readonly tone: "waiting" | "error"; readonly text: string }): JSX.Element {
  return <div className={`subagent-notice subagent-notice--${tone}`} role={tone === "error" ? "alert" : "status"}>{tone === "waiting" ? <Spinner label={text} /> : <AlertCircle aria-hidden="true" />}<span>{text}</span></div>;
}

function SubagentErrorNotice({ error, t }: { readonly error: ErrorView; readonly t: Translator }): JSX.Element {
  const kind = classifySubagentError(error);
  return <div className="subagent-error-notice" data-subagent-error-kind={kind} role="alert">
    <div><AlertCircle aria-hidden="true" /><span>{t(`subagents.error.${kind}`)}</span></div>
    <details><summary>{t("subagents.error.rawDetails")}</summary><pre>{[
      `${t("subagents.error.code")}: ${error.code || "—"}`,
      `${t("subagents.error.phase")}: ${error.phase || "—"}`,
      `${t("subagents.error.severity")}: ${error.severity}`,
      error.message
    ].join("\n")}</pre></details>
  </div>;
}

function mergeSubagentRuns(current: readonly SubagentRunView[], incoming: readonly SubagentRunView[]): readonly SubagentRunView[] {
  const byId = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) {
    const existing = byId.get(run.id);
    if (existing === undefined || run.revision >= existing.revision) byId.set(run.id, run);
  }
  return [...byId.values()];
}

function replaceSubagentRun(current: readonly SubagentRunView[], incoming: SubagentRunView): readonly SubagentRunView[] {
  if (!current.some((run) => run.id === incoming.id)) return current;
  return current.map((run) => run.id === incoming.id && incoming.revision >= run.revision ? incoming : run);
}

function isSubagentActive(state: SubagentRunStateView): boolean {
  return state === "queued" || state === "running";
}

function subagentStateLabel(state: SubagentRunStateView, t: Translator): string {
  if (state === "queued") return t("subagents.stateQueued");
  if (state === "running") return t("subagents.stateRunning");
  if (state === "completed") return t("subagents.stateCompleted");
  if (state === "failed") return t("subagents.stateFailed");
  return t("subagents.stateStopped");
}

function controlActionLabel(action: SubagentControlActionView, t: Translator): string {
  if (action === "stop") return t("common.stop");
  if (action === "steer") return t("subagents.steer");
  if (action === "followUp") return t("subagents.followUp");
  return t("subagents.resume");
}

function composerAction(run: SubagentRunView | undefined, child: SubagentChildRunView | undefined, modifier: boolean, hasSettledReply: boolean): ComposerAction | undefined {
  if (run === undefined) return undefined;
  if (!isSubagentActive(run.state)) return run.capabilities.resume ? "resume" : undefined;
  if (run.state !== "running" || child !== undefined && !isSubagentActive(child.state)) return undefined;
  if (hasSettledReply) return run.capabilities.followUp ? "followUp" : undefined;
  if (modifier && run.capabilities.steer) return "steer";
  if (run.capabilities.followUp) return "followUp";
  return run.capabilities.steer ? "steer" : undefined;
}

function formatSubagentRoute(value: Pick<SubagentRunView, "route"> | Pick<SubagentChildRunView, "route">): string {
  const model = [value.route?.providerId, value.route?.modelId].filter(Boolean).join(" / ");
  return [model, value.route?.thinkingLevel].filter(Boolean).join(" · ") || "—";
}

function formatSubagentUsage(value: Pick<SubagentRunView, "usage"> | Pick<SubagentChildRunView, "usage">, locale: string, t: Translator): string {
  const parts: string[] = [];
  if (value.usage?.totalTokens !== undefined) parts.push(t("subagents.tokens", { count: value.usage.totalTokens.toLocaleString(locale) }));
  if (value.usage?.toolUses !== undefined) parts.push(t("subagents.toolUses", { count: value.usage.toolUses.toLocaleString(locale) }));
  if (value.usage?.durationMs !== undefined) parts.push(formatDuration(value.usage.durationMs));
  if (value.usage?.costUsd !== undefined) parts.push(new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value.usage.costUsd));
  return parts.join(" · ") || "—";
}

function formatChildMetadata(child: SubagentChildRunView, locale: string, t: Translator): string {
  return [
    child.role,
    formatSubagentRoute(child) === "—" ? undefined : formatSubagentRoute(child),
    formatSubagentUsage(child, locale, t) === "—" ? undefined : formatSubagentUsage(child, locale, t),
    child.awaitingApproval === true ? t("subagents.awaitingApproval") : subagentStateLabel(child.state, t)
  ].filter(Boolean).join(" · ");
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function parentContextLabel(value: SubagentRunView["capabilities"]["parentContext"], t: Translator): string {
  if (value === "live") return t("subagents.contextLive");
  if (value === "snapshot") return t("subagents.contextSnapshot");
  if (value === "none") return t("subagents.contextNone");
  return t("common.unknown");
}

function displayedReadOnly(child: SubagentChildRunView | undefined, run: SubagentRunView): boolean | undefined {
  return child?.readOnly ?? run.readOnly;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

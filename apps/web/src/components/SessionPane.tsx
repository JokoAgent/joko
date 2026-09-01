import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  AlertTriangle,
  Bot,
  CircleStop,
  Gauge,
  GitBranch,
  Menu,
  LoaderCircle,
  PanelRight,
  RotateCcw,
  Shield,
  Sparkles
} from "lucide-react";
import type { AppController, AppRoute } from "../controller.js";
import { modelPreferenceOwnerId } from "../model-picker-preferences.js";
import { isRoutableConversationModel } from "../model-capabilities.js";
import type { AttachmentDraft, BackendView, ComposerSelectionQuoteDraft, ErrorView, ExtensionStatusView, ExtensionWidgetView, ExtraDirectoryView, InteractionView, ModelView, PermissionMode, QueueControlView, QueueItemView, ResourceView, RuntimeCommandView, SessionView, SubagentRunDetailView, SubagentRunView, TargetView, TimelineItemView, UsageTokensView, WorkspaceRewindPreviewView, WorkspaceView } from "../model.js";
import { composerDocumentFromEditedEncodedMessage, composerDocumentFromMessage, composerDocumentPlainText, plainTextToComposerDocument } from "../composer-quote-document.js";
import type { RunAction, Translator } from "./types.js";
import { Button, IconButton, Modal, Pill, StatusDot, cx, CheckboxControl } from "./ui.js";
import { Composer, type ComposerHistoryEntry } from "./Composer.js";
import { CompactionStatusIndicator } from "./CompactionStatusIndicator.js";
import { formatTokenCount, resolveDisplayContextWindow } from "./ContextCapacityRing.js";
import { ErrorTailBanner } from "./ErrorTailBanner.js";
import { InteractionDialog } from "./InteractionDialog.js";
import { InteractionPromptHost } from "./InteractionPortal.js";
import { MessageDeleteDialog } from "./MessageDeleteDialog.js";
import { MessageForkDialog } from "./MessageForkDialog.js";
import { MessageRewindDialog, type MessageRewindPreviewState } from "./MessageRewindDialog.js";
import { ModelPicker } from "./ModelPicker.js";
import { PermissionSelector } from "./PermissionSelector.js";
import { PinnedPlanPanel } from "./PinnedPlanPanel.js";
import { RetryStatusIndicator } from "./RetryStatusIndicator.js";
import { SessionRunningStatusBar } from "./SessionRunningStatusBar.js";
import { activeBackgroundTaskIds } from "./running-status.js";
import { collectTimelineSubagentRuns, timelineSubagentDetailResponseIsCurrent } from "./subagent-inline-card.js";
import { RecoveryActionSingleFlight, executableRecoveryActions, nextPermissionMode, recoverySettingsHash, waitForRecoveryDelay, type ExecutableRecoveryAction, type RecoveryActionContext } from "./coding-ui-behavior.js";
import { SessionScopedRequestGuard, type SessionScopedRequest } from "./compact-request-behavior.js";
import { resolveActiveCompaction } from "./compaction-status-behavior.js";
import { hasPendingComposerQueueItems, pauseQueueThenAbort, pauseQueueThenAbortRetry, resolveComposerAttachmentPolicy } from "./composer-behavior.js";
import { ErrorTailLocalProjectionStore, explicitErrorAttentionCursor, resolveErrorTail } from "./error-tail-behavior.js";
import { hidesFromTimelineHistory, resolveActiveRetry, resolveRetryEscapeIntent, type RetryEscapeInput, type RetryEscapeTarget } from "./retry-status-behavior.js";
import { projectRuntimeRecoveryTimeline } from "../runtime-recovery.js";
import { createMessageComposerMention, messageForkBlocked, resolveMessageDeleteTarget, resolveMessageForkTarget, type MessageForkTarget } from "./message-actions.js";
import { restoreMessageAttachmentDrafts, sameMessageAttachments } from "./message-attachment-roundtrip.js";
import { canEditVisibleUserMessage, changeSetForMessageRound, lastVisibleUserMessage, messageDialogueRewindTarget, messageRoundRunId } from "./message-rewind-behavior.js";
import { reconcileShareSelection, shareableTimelineMessages, toggleShareMessageSelection } from "./share-selection-behavior.js";
import { ShareSelectionBar } from "./ShareSelectionBar.js";
import { Timeline, type InlinePlanVisibility } from "./Timeline.js";
import { useAppShortcut } from "../use-app-shortcut.js";
import { randomUuid } from "../web-crypto.js";
import { portableSessionExportSupported } from "../portable-session-ui.js";
import type { SessionProjectNavigationPlacement } from "../session-project-navigation.js";
import { sanitizeExtensionStatusText } from "../extension-ui-presentation.js";
import {
  providerAccountUsageResetAt,
  stageUsageLimitScheduleIntent,
  usageLimitRecoveryHint,
  type UsageLimitRecoveryHint
} from "../usage-limit-recovery.js";
import { SessionHeaderActionsMenu } from "./SessionHeaderActionsMenu.js";
import { codeHostDisplayBranch } from "./CodeHostPullRequestSummary.js";
import { openCodeHostPullRequestExternal } from "../code-host-pull-request.js";
import {
  advertisedPermissionModes,
  permissionChangeSupported,
  planModeSupported
} from "./backend-control-capabilities.js";

// First-stage contracts do not expose a durable dismissal mutation. Keep this bounded and
// client-local so route switches/remounts are stable without pretending to persist remotely.
const errorTailLocalProjection = new ErrorTailLocalProjectionStore();

interface CompactRequestFeedback {
  readonly sessionId: string;
  readonly epoch: number;
  readonly phase: "busy" | "compacted" | "noop" | "failure";
}

interface ActiveShareSelection {
  readonly sessionId: string;
  readonly selectedIds: ReadonlySet<string>;
  readonly anchorId?: string;
}

interface ActiveMessageRewind extends MessageRewindPreviewState {
  readonly sessionId: string;
  readonly itemId: string;
  readonly targetEntryId: string;
}

interface ActiveMessageDelete {
  readonly sessionId: string;
  readonly messageId: string;
  readonly eventId: string;
  readonly item: TimelineItemView;
  readonly busy: boolean;
  readonly error?: string;
}

interface ActiveMessageFork {
  readonly sessionId: string;
  readonly messageId: string;
  readonly target: MessageForkTarget;
}

export type SessionPanePresentation = "standard" | "filesRail";

export function SessionPane({ controller, session, target, backend, reviewReadOnly = false, presentation = "standard", composerAutoFocus = true, models, timeline, timelineHasEarlier, timelineHistoryLoading, timelineHistoryError, onLoadEarlierTimeline, timelineFocusRequest, extensionWidgets, extensionStatuses, queue, queueControl, workspace, extraDirectories, resources, commandRefreshSignal, interaction, remainingInteractions, navigationOpen, inspectorOpen, inspectorAvailable = true, selectionQuoteInsertion, attachmentInsertion, t, runAction, onOpenNavigation, onOpenInspector, onOpenSubagent, onOpenTurnReview, onRename, onPin, onArchive, onDelete, onMoveSessionProject, movingSessionProject = false, onCopyTaskLink, onExportPortableSession, onSplitSession, onOpenSessionWindow }: {
  readonly controller: AppController;
  readonly session: SessionView;
  readonly target?: TargetView;
  readonly backend?: BackendView;
  readonly reviewReadOnly?: boolean;
  readonly presentation?: SessionPanePresentation;
  readonly composerAutoFocus?: boolean;
  readonly models: readonly ModelView[];
  readonly timeline: readonly TimelineItemView[];
  readonly timelineHasEarlier: boolean;
  readonly timelineHistoryLoading: boolean;
  readonly timelineHistoryError?: string;
  readonly onLoadEarlierTimeline: () => Promise<void>;
  readonly timelineFocusRequest?: { readonly itemId: string; readonly requestId: number };
  readonly extensionWidgets: readonly ExtensionWidgetView[];
  readonly extensionStatuses: readonly ExtensionStatusView[];
  readonly queue: readonly QueueItemView[];
  readonly queueControl?: QueueControlView;
  readonly workspace?: WorkspaceView;
  readonly extraDirectories: readonly ExtraDirectoryView[];
  readonly resources: readonly ResourceView[];
  readonly commandRefreshSignal: readonly RuntimeCommandView[];
  readonly interaction?: InteractionView;
  readonly remainingInteractions: number;
  readonly navigationOpen: boolean;
  readonly inspectorOpen: boolean;
  readonly inspectorAvailable?: boolean;
  readonly selectionQuoteInsertion?: { readonly id: number; readonly sessionId: string; readonly quote: ComposerSelectionQuoteDraft };
  readonly attachmentInsertion?: { readonly id: number; readonly sessionId: string; readonly file: File };
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onOpenNavigation: () => void;
  readonly onOpenInspector: () => void;
  readonly onOpenSubagent?: (runId: string) => void;
  readonly onOpenTurnReview?: (changeSetId: string, selectedPath?: string) => void;
  readonly onRename: () => void;
  readonly onPin?: () => void;
  readonly onArchive?: () => void;
  readonly onDelete: () => void;
  readonly onMoveSessionProject?: (placement: SessionProjectNavigationPlacement) => void;
  readonly movingSessionProject?: boolean;
  readonly onCopyTaskLink?: () => void;
  readonly onExportPortableSession?: () => void;
  readonly onSplitSession?: (side: "right" | "bottom") => void;
  readonly onOpenSessionWindow?: () => void;
}): JSX.Element {
  const [permissionToConfirm, setPermissionToConfirm] = useState<PermissionMode>();
  const [rewindPreview, setRewindPreview] = useState<WorkspaceRewindPreviewView>();
  const [dialogueOnlyRewind, setDialogueOnlyRewind] = useState(false);
  const [followLatestSignal, setFollowLatestSignal] = useState(0);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [liveCommands, setLiveCommands] = useState<readonly RuntimeCommandView[]>([]);
  const [errorTailRevision, setErrorTailRevision] = useState(0);
  const [bottomInset, setBottomInset] = useState(0);
  const [composerMessageMentionInsertion, setComposerMessageMentionInsertion] = useState<{ readonly id: number; readonly sessionId: string; readonly mention: NonNullable<ReturnType<typeof createMessageComposerMention>> }>();
  const [composerSelectionQuoteInsertion, setComposerSelectionQuoteInsertion] = useState<{ readonly id: number; readonly sessionId: string; readonly quote: ComposerSelectionQuoteDraft }>();
  const [composerAttachmentInsertion, setComposerAttachmentInsertion] = useState<{ readonly id: number; readonly sessionId: string; readonly file: File }>();
  const [composerDraftReplacement, setComposerDraftReplacement] = useState<{ readonly id: number; readonly sessionId: string; readonly text: string; readonly editorDocument?: import("@tiptap/core").JSONContent; readonly attachments?: readonly AttachmentDraft[] }>();
  const [shareSelection, setShareSelection] = useState<ActiveShareSelection>();
  const [messageRewind, setMessageRewind] = useState<ActiveMessageRewind>();
  const [messageDelete, setMessageDeleteState] = useState<ActiveMessageDelete>();
  const [messageActionResetSignal, setMessageActionResetSignal] = useState(0);
  const [messageFork, setMessageFork] = useState<ActiveMessageFork>();
  const [forkingMessageId, setForkingMessageId] = useState<string>();
  const [backgroundStopping, setBackgroundStopping] = useState(false);
  const [backgroundStopError, setBackgroundStopError] = useState<string>();
  const [timelineSubagentRuns, setTimelineSubagentRuns] = useState<{
    readonly sessionId: string;
    readonly runs: ReadonlyMap<string, SubagentRunView>;
    readonly details: ReadonlyMap<string, SubagentRunDetailView>;
  }>();
  const [errorTailActionFailure, setErrorTailActionFailure] = useState<{ readonly localKey: string; readonly message: string }>();
  const [compactConfirmation, setCompactConfirmationState] = useState<{
    readonly request: SessionScopedRequest;
    readonly usedTokens: number;
    readonly contextWindow: number;
    readonly percent: number;
  }>();
  const [compactFeedback, setCompactFeedback] = useState<CompactRequestFeedback>();
  const [statisticsUsage, setStatisticsUsage] = useState<{
    readonly sessionId: string;
    readonly usage?: UsageTokensView;
  }>();
  const [inlinePlanVisibilityState, setInlinePlanVisibilityState] = useState<{
    readonly sessionId: string;
    readonly value: InlinePlanVisibility | null;
  }>({ sessionId: session.id, value: null });
  const [, setStopRevision] = useState(0);
  const [, setCompactRevision] = useState(0);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const activeSessionIdRef = useRef(session.id);
  activeSessionIdRef.current = session.id;
  const timelineSubagentEpochRef = useRef(0);
  const stoppingRunIdsRef = useRef(new Set<string>());
  const recoveryFlightsRef = useRef(new RecoveryActionSingleFlight());
  const recoveryWaitAbortsRef = useRef(new Map<string, AbortController>());
  const compactGuardRef = useRef(new SessionScopedRequestGuard());
  const messageDeleteGuardRef = useRef(new SessionScopedRequestGuard());
  const paneRef = useRef<HTMLElement>(null);
  const bottomOverlayRef = useRef<HTMLDivElement>(null);
  const composerMessageMentionInsertionIdRef = useRef(0);
  const composerSelectionQuoteInsertionIdRef = useRef(0);
  const composerAttachmentInsertionIdRef = useRef(0);
  const appliedExternalSelectionQuoteInsertionRef = useRef<string | undefined>(undefined);
  const appliedExternalAttachmentInsertionRef = useRef<string | undefined>(undefined);
  const composerDraftReplacementIdRef = useRef(0);
  const shareSelectionBeforeAllRef = useRef<ReadonlySet<string> | undefined>(undefined);
  const messageRewindRequestIdRef = useRef(0);
  const compactConfirmationRef = useRef(compactConfirmation);
  compactConfirmationRef.current = compactConfirmation;
  const messageDeleteRef = useRef(messageDelete);
  messageDeleteRef.current = messageDelete;
  const running = session.state === "running" || session.state === "waiting" || session.state === "retrying";
  const backendModels = models.filter((model) =>
    model.backendId === session.backendId && isRoutableConversationModel(model));
  const backgroundTaskIds = activeBackgroundTaskIds(controller.state.snapshot.backgroundTasks, session.id, running);
  const canStopBackgroundTasks = backend?.capabilities.get("background.tasks.cancel")?.supported === true;
  const navigationProjectName = session.projectId === undefined
    ? t("nav.dialogue")
    : controller.state.snapshot.targets.find((candidate) => candidate.id === session.projectId)?.name
      ?? target?.name
      ?? "Project";
  const activeRetry = useMemo(() => resolveActiveRetry(timeline, session), [session.activeRunId, session.state, timeline]);
  const activeCompaction = useMemo(() => resolveActiveCompaction(timeline, session.compacting), [session.compacting, timeline]);
  const inlinePlanVisibility = inlinePlanVisibilityState.sessionId === session.id ? inlinePlanVisibilityState.value : null;
  const handleInlinePlanVisibilityChange = useCallback((value: InlinePlanVisibility | null): void => {
    setInlinePlanVisibilityState((current) => {
      if (
        current.sessionId === session.id &&
        ((current.value === null && value === null) ||
          (current.value !== null && value !== null && current.value.key === value.key && current.value.visible === value.visible))
      ) return current;
      return { sessionId: session.id, value };
    });
  }, [session.id]);
  const canCompact = !reviewReadOnly && backend?.capabilities.get("context.compact")?.supported === true;
  const canReportSessionUsage = backend?.capabilities.get("context.usage")?.supported === true;
  const effectiveSessionUsage = statisticsUsage?.sessionId === session.id
    ? statisticsUsage.usage
    : session.usage;
  const canAcknowledgeSessionAttention = backend?.capabilities.get("session.attention")?.supported === true;
  const displayBranch = codeHostDisplayBranch(workspace, session.codeHostPullRequests);
  const canExport = !reviewReadOnly && backend?.capabilities.get("session.export")?.supported === true;
  const canClone = !reviewReadOnly && backend?.capabilities.get("session.clone")?.supported === true;
  const canExportPortable = onExportPortableSession !== undefined
    && portableSessionExportSupported(session, controller.state.snapshot);
  const sessionProjectTargets = controller.state.snapshot.targets.filter(
    (candidate) => !candidate.archived && candidate.remoteWorkspace === undefined
  );
  const canAddMessageReference = !reviewReadOnly && backend?.capabilities.get("input.text")?.supported === true;
  const canForkMessage = !reviewReadOnly && backend?.capabilities.get("session.fork")?.supported === true;
  const visionBridgeRouted = controller.state.snapshot.settings.visionBridge.enabled && session.model !== undefined
    && controller.state.snapshot.settings.visionBridge.targetModels.some((candidate) => candidate.backendId === session.backendId && candidate.providerId === session.model?.providerId && candidate.modelId === session.model.modelId);
  const canAddWorkspaceImage = !reviewReadOnly && resolveComposerAttachmentPolicy(backend, session.model?.supportsImages === true || visionBridgeRouted).images;
  const canOpenWorkspaceReferences = workspace !== undefined && backend?.capabilities.get("workspace.files")?.supported === true;
  const loadTimelineWorkspaceAsset = useCallback(async (path: string) => {
    if (!canOpenWorkspaceReferences || workspace === undefined) throw new Error("Workspace file previews are unavailable.");
    const preview = await controllerRef.current.readWorkspaceFile(workspace.id, path);
    if (preview.blobId === undefined || (preview.kind !== "image" && preview.mediaType?.startsWith("image/") !== true)) {
      throw new Error("The workspace target is not an image.");
    }
    return {
      path: preview.path,
      name: preview.name,
      url: await controllerRef.current.getArtifactUrl(preview.blobId),
      ...(preview.mediaType === undefined ? {} : { mediaType: preview.mediaType })
    };
  }, [canOpenWorkspaceReferences, workspace?.id]);
  const addTimelineWorkspaceImage = useCallback((file: File): void => {
    setComposerAttachmentInsertion({ id: ++composerAttachmentInsertionIdRef.current, sessionId: session.id, file });
  }, [session.id]);
  // Freeze reviewer input/settings but still expose Stop for the
  // isolated task that is currently running.
  const canAbort = backend?.capabilities.get("turn.abort")?.supported === true;
  const canAbortRetry = backend?.capabilities.get("context.auto_retry")?.supported === true;
  const canStop = session.state === "retrying" ? canAbortRetry && activeRetry?.source === "auto" : canAbort;
  const canSwitchModel = !reviewReadOnly && backend?.capabilities.get("model.switch")?.supported === true;
  const canSetEffort = !reviewReadOnly && backend?.capabilities.get("model.effort")?.supported === true;
  const canSetFast = !reviewReadOnly && backend?.capabilities.get("model.fast_mode")?.supported === true;
  const allowedPermissions = advertisedPermissionModes(backend);
  const canSetPermission = !reviewReadOnly && permissionChangeSupported(backend);
  const canListRuntimeCommands = !reviewReadOnly && backend?.capabilities.get("runtime.commands")?.supported === true;
  const canSetPlanMode = !reviewReadOnly && planModeSupported(backend);
  const canContactOwner = controller.state.activeProfile !== undefined && controller.state.snapshot.revision > 0n;
  const canListSubagents = backend?.capabilities.get("subagents.list")?.supported === true
    && backend.capabilities.get("subagents.detail")?.supported === true;
  const canStopSubagents = backend?.capabilities.get("subagents.stop")?.supported === true;
  const compactInFlight = compactGuardRef.current.isInFlight(session.id);
  const currentCompactFeedback = compactFeedback !== undefined
    && compactFeedback.sessionId === session.id
    && compactGuardRef.current.isCurrent(session.id, compactFeedback.epoch)
    ? compactFeedback
    : undefined;
  const recoveryContext: RecoveryActionContext = {
    ...(reviewReadOnly || session.retryRunId === undefined ? {} : { retryRunId: session.retryRunId }),
    ...(reviewReadOnly || session.activeRunId === undefined ? {} : { activeRunId: session.activeRunId }),
    canAbort,
    canRefresh: controller.state.connectionState !== "disconnected",
    canContactOwner,
    sessionAvailable: true
  };
  const recoveryPresentationTimeline = useMemo(() => projectRuntimeRecoveryTimeline(timeline), [timeline]);
  const errorTailProjection = useMemo(() => {
    const candidate = resolveErrorTail(session.id, recoveryPresentationTimeline, queue, running, "none", session.attention);
    return candidate === undefined
      ? undefined
      : resolveErrorTail(session.id, recoveryPresentationTimeline, queue, running, errorTailLocalProjection.read(candidate.localKey), session.attention);
  }, [errorTailRevision, queue, recoveryPresentationTimeline, running, session.attention, session.id]);
  const visibleTimeline = useMemo(
    () => recoveryPresentationTimeline.filter((item) => !hidesFromTimelineHistory(item) && !(errorTailProjection?.hideFromTimeline === true && item.id === errorTailProjection.item.id)),
    [errorTailProjection, recoveryPresentationTimeline]
  );
  const derivationOrigin = session.derivationOrigin;
  const derivationSourceSession = derivationOrigin === undefined
    ? undefined
    : controller.state.snapshot.sessions.find((candidate) => candidate.id === derivationOrigin.sourceSessionId);
  const derivationSourceCanOpen = derivationOrigin !== undefined
    && derivationOrigin.sourceSessionAvailable
    && derivationSourceSession !== undefined
    && !derivationSourceSession.archived
    && derivationSourceSession.state !== "closed"
    && (derivationOrigin.sourceMessageId === undefined || derivationOrigin.sourceMessageAvailable);
  const subagentTaskIds = useMemo(() => new Set(visibleTimeline.flatMap((item) => item.background === undefined ? [] : [item.background.id])), [visibleTimeline]);
  const subagentTaskKey = useMemo(() => visibleTimeline.flatMap((item) => item.background === undefined ? [] : [
    [
      item.background.id,
      item.background.state,
      item.background.runId ?? "",
      item.background.updatedAt?.toString() ?? "",
      item.background.endedAt?.toString() ?? "",
      item.background.progressRatio?.toString() ?? "",
      item.background.detail ?? ""
    ].join("\u0000")
  ]).sort().join("\u0001"), [visibleTimeline]);
  const subagentRuns = timelineSubagentRuns?.sessionId === session.id ? timelineSubagentRuns.runs : new Map<string, SubagentRunView>();
  const subagentRunDetails = timelineSubagentRuns?.sessionId === session.id ? timelineSubagentRuns.details : new Map<string, SubagentRunDetailView>();
  useEffect(() => {
    if (!canReportSessionUsage) {
      setStatisticsUsage(undefined);
      return;
    }
    const request = new AbortController();
    const sourceSessionId = session.id;
    void controllerRef.current.getSessionStatistics(sourceSessionId, request.signal).then((statistics) => {
      if (request.signal.aborted || activeSessionIdRef.current !== sourceSessionId) return;
      setStatisticsUsage({
        sessionId: sourceSessionId,
        ...(statistics.usage === undefined ? {} : { usage: statistics.usage })
      });
    }).catch(() => {
      // The live snapshot remains a truthful fallback when statistics refresh is unavailable.
    });
    return () => request.abort();
  }, [
    canReportSessionUsage,
    session.id,
    session.state,
    session.usage?.inputTokens,
    session.usage?.outputTokens,
    session.usage?.cacheReadTokens,
    session.usage?.cacheWriteTokens,
    session.usage?.totalTokens,
    session.usage?.costMicros,
    session.usage?.currencyCode
  ]);
  useEffect(() => {
    let current = true;
    const requestEpoch = ++timelineSubagentEpochRef.current;
    const sourceSessionId = session.id;
    if (!canListSubagents || subagentTaskIds.size === 0) {
      setTimelineSubagentRuns({ sessionId: sourceSessionId, runs: new Map(), details: new Map() });
      return () => { current = false; };
    }
    void collectTimelineSubagentRuns(subagentTaskIds, (pageToken) => controllerRef.current.listSubagentRuns(sourceSessionId, undefined, pageToken, 100)).then((runs) => {
      if (!current || activeSessionIdRef.current !== sourceSessionId || timelineSubagentEpochRef.current !== requestEpoch) return;
      setTimelineSubagentRuns({ sessionId: sourceSessionId, runs, details: new Map() });
      for (const [taskId, run] of runs) {
        void controllerRef.current.getSubagentRun(sourceSessionId, run.id).then((detail) => {
          if (!current) return;
          setTimelineSubagentRuns((currentState) => {
            if (currentState?.sessionId !== sourceSessionId) return currentState;
            const requestedRun = currentState.runs.get(taskId);
            if (!timelineSubagentDetailResponseIsCurrent({
              sourceSessionId,
              requestEpoch,
              activeSessionId: activeSessionIdRef.current,
              activeEpoch: timelineSubagentEpochRef.current,
              requestedRun,
              detail
            })) return currentState;
            const nextRuns = new Map(currentState.runs);
            nextRuns.set(taskId, detail.run);
            const nextDetails = new Map(currentState.details);
            nextDetails.set(taskId, detail);
            return { sessionId: sourceSessionId, runs: nextRuns, details: nextDetails };
          });
        }).catch(() => {
          // The typed list row remains a truthful fallback when richer detail is unavailable.
        });
      }
    }).catch(() => {
      // A generic background card remains truthful when rich delegated-run detail is unavailable.
    });
    return () => { current = false; };
  }, [canListSubagents, session.id, subagentTaskKey]);
  const stopTimelineSubagent = canStopSubagents ? async (runId: string): Promise<void> => {
    const entry = [...subagentRuns].find(([, candidate]) => candidate.id === runId);
    const taskId = entry?.[0];
    const run = entry?.[1];
    if (taskId === undefined || run === undefined || !run.capabilities.stop || run.state !== "running") {
      throw new Error(t("timeline.subagentStopFailed"));
    }
    const sourceSessionId = session.id;
    await controller.controlSubagent(sourceSessionId, runId, "stop");
    const detail = await controller.getSubagentRun(sourceSessionId, runId).catch(() => undefined);
    if (detail !== undefined && activeSessionIdRef.current === sourceSessionId) {
      setTimelineSubagentRuns((currentState) => {
        if (currentState?.sessionId !== sourceSessionId) return currentState;
        const requestedRun = currentState.runs.get(taskId);
        if (requestedRun === undefined || detail.run.id !== requestedRun.id || detail.run.sessionId !== sourceSessionId || detail.run.revision < requestedRun.revision) return currentState;
        const nextRuns = new Map(currentState.runs);
        nextRuns.set(taskId, detail.run);
        const nextDetails = new Map(currentState.details);
        nextDetails.set(taskId, detail);
        return { sessionId: sourceSessionId, runs: nextRuns, details: nextDetails };
      });
    }
  } : undefined;
  const shareableMessages = useMemo(() => shareableTimelineMessages(visibleTimeline), [visibleTimeline]);
  const shareableMessageIds = useMemo(() => shareableMessages.map((item) => item.id), [shareableMessages]);
  const currentShareSelection = shareSelection?.sessionId === session.id ? shareSelection : undefined;
  const queuedMessageWork = queue.some((item) => item.sessionId === session.id && !["completed", "cancelled", "failed"].includes(item.state));
  const messageActionsIdle = session.state === "idle" && !queuedMessageWork;
  const messageRewindSupported = !reviewReadOnly && messageActionsIdle && backend?.capabilities.get("session.rewind")?.supported === true;
  const messageDeleteSupported = !reviewReadOnly && backend?.capabilities.get("session.message_delete")?.supported === true;
  const messageDeleteBlockedReason = messageActionsIdle && activeCompaction === undefined && interaction === undefined
    ? undefined
    : t("timeline.deleteMessageBusy");
  const currentMessageFork = messageFork?.sessionId === session.id ? messageFork : undefined;
  const currentMessageDelete = messageDelete?.sessionId === session.id ? messageDelete : undefined;
  const latestVisibleUserMessage = lastVisibleUserMessage(visibleTimeline);
  const editableMessageId = messageRewindSupported && canEditVisibleUserMessage(latestVisibleUserMessage) ? latestVisibleUserMessage.id : undefined;
  const errorTailActions = errorTailProjection?.bannerVisible === true && errorTailProjection.item.error !== undefined
    ? executableRecoveryActions(errorTailProjection.item.error, recoveryContext)
    : [];
  const accountUsageResetAt = providerAccountUsageResetAt(
    controller.state.snapshot.providers,
    session.model?.providerId
  );
  const errorTailUsageLimitRecovery = errorTailProjection?.bannerVisible === true && errorTailProjection.item.error !== undefined
    ? usageLimitRecoveryHint(errorTailProjection.item.error, Date.now(), accountUsageResetAt)
    : null;
  const stopAllBackgroundTasks = (): void => {
    if (!canStopBackgroundTasks || backgroundStopping || backgroundTaskIds.length === 0) return;
    const taskIds = [...backgroundTaskIds];
    setBackgroundStopping(true);
    setBackgroundStopError(undefined);
    void (async () => {
      let failures = 0;
      for (const taskId of taskIds) {
        try {
          await controller.cancelBackgroundTask(session.id, taskId);
        } catch {
          failures += 1;
        }
      }
      try { await controller.refresh(); } catch { /* Event projection remains authoritative. */ }
      if (failures > 0) setBackgroundStopError(t("runningStatus.stopFailed", { count: failures }));
      setBackgroundStopping(false);
    })();
  };
  const permissionCycleOptions = permissionModesForShortcut(backend, target, controller.state.snapshot.settings.policy.projectTrustRequired);
  const messageHistory = useMemo(() => recoveryPresentationTimeline.flatMap((item): readonly ComposerHistoryEntry[] => {
    if (item.kind !== "user" || !item.text?.trim()) return [];
    const editorDocument = composerDocumentFromMessage(item.text, item.quotesEncoded === true, {
        sessionId: session.id,
        messageId: item.id,
        role: "user",
        ...(item.sourceEventId === undefined ? {} : { sourceEventId: item.sourceEventId })
      }, "history", item.pastedTextRanges);
    return [{ text: composerDocumentPlainText(editorDocument), editorDocument }];
  }).reverse(), [recoveryPresentationTimeline, session.id]);
  const durableCommands = useMemo(
    () => commandRefreshSignal.filter((command) => command.sessionId === session.id),
    [commandRefreshSignal, session.id]
  );

  useEffect(() => {
    let current = true;
    setLiveCommands(durableCommands);
    if (!canListRuntimeCommands) return () => { current = false; };
    void controllerRef.current.listCommands(session.id).then((commands) => {
      if (current) setLiveCommands(commands);
    }).catch(() => {
      // Keep the generation-fenced durable snapshot when a live refresh fails.
    });
    return () => { current = false; };
  }, [canListRuntimeCommands, durableCommands, session.id]);

  useEffect(() => {
    setComposerMessageMentionInsertion(undefined);
    setComposerSelectionQuoteInsertion(undefined);
    setComposerAttachmentInsertion(undefined);
    setComposerDraftReplacement(undefined);
    setMessageFork(undefined);
    setForkingMessageId(undefined);
    setShareSelection(undefined);
    setMessageRewind(undefined);
    setMessageDeleteState(undefined);
    shareSelectionBeforeAllRef.current = undefined;
    messageRewindRequestIdRef.current += 1;
  }, [session.id]);

  useEffect(() => {
    if (selectionQuoteInsertion === undefined || selectionQuoteInsertion.sessionId !== session.id) return;
    const identity = `${selectionQuoteInsertion.sessionId}\u0000${selectionQuoteInsertion.id}`;
    if (appliedExternalSelectionQuoteInsertionRef.current === identity) return;
    appliedExternalSelectionQuoteInsertionRef.current = identity;
    setComposerSelectionQuoteInsertion({
      id: ++composerSelectionQuoteInsertionIdRef.current,
      sessionId: selectionQuoteInsertion.sessionId,
      quote: selectionQuoteInsertion.quote
    });
  }, [selectionQuoteInsertion, session.id]);

  useEffect(() => {
    if (attachmentInsertion === undefined || attachmentInsertion.sessionId !== session.id) return;
    const identity = `${attachmentInsertion.sessionId}\u0000${attachmentInsertion.id}`;
    if (appliedExternalAttachmentInsertionRef.current === identity) return;
    appliedExternalAttachmentInsertionRef.current = identity;
    setComposerAttachmentInsertion({
      id: ++composerAttachmentInsertionIdRef.current,
      sessionId: attachmentInsertion.sessionId,
      file: attachmentInsertion.file
    });
  }, [attachmentInsertion, session.id]);

  useEffect(() => {
    setShareSelection((current) => {
      if (current === undefined || current.sessionId !== session.id) return current;
      if (shareableMessageIds.length === 0) return undefined;
      const next = reconcileShareSelection(shareableMessageIds, current.selectedIds, current.anchorId);
      if (sameIds(current.selectedIds, next.selectedIds) && current.anchorId === next.anchorId) return current;
      return { sessionId: current.sessionId, selectedIds: next.selectedIds, ...(next.anchorId === undefined ? {} : { anchorId: next.anchorId }) };
    });
  }, [session.id, shareableMessageIds]);

  useEffect(() => {
    if (currentShareSelection === undefined) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || isEditableKeyboardTarget(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setShareSelection(undefined);
        shareSelectionBeforeAllRef.current = undefined;
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "a") {
        event.preventDefault();
        toggleAllShareMessages();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [currentShareSelection, shareableMessageIds]);

  useEffect(() => () => {
    for (const abort of recoveryWaitAbortsRef.current.values()) abort.abort();
    recoveryWaitAbortsRef.current.clear();
  }, [session.id]);

  useLayoutEffect(() => {
    const overlay = bottomOverlayRef.current;
    if (overlay === null) return;
    const report = (): void => setBottomInset(Math.ceil(overlay.getBoundingClientRect().height));
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(overlay);
    return () => observer.disconnect();
  }, [session.id]);

  useLayoutEffect(() => {
    compactGuardRef.current.setCurrentSession(session.id);
    messageDeleteGuardRef.current.setCurrentSession(session.id);
    setCompactFeedback((current) => current !== undefined && !compactGuardRef.current.isCurrent(current.sessionId, current.epoch)
      ? undefined
      : current);
    const pending = compactConfirmationRef.current;
    if (pending !== undefined && pending.request.sessionId !== session.id) {
      pending.request.release();
      compactConfirmationRef.current = undefined;
      setCompactConfirmationState(undefined);
      setCompactRevision((current) => current + 1);
    }
    return () => {
      if (compactGuardRef.current.isCurrent(session.id)) compactGuardRef.current.setCurrentSession(null);
      if (messageDeleteGuardRef.current.isCurrent(session.id)) messageDeleteGuardRef.current.setCurrentSession(null);
    };
  }, [session.id]);

  const setPermission = (mode: PermissionMode): void => {
    if (!canSetPermission) return;
    if (mode === session.permissionMode) return;
    if (mode === "bypassPermissions") {
      setPermissionToConfirm(mode);
      return;
    }
    runAction("permission", () => controller.setPermission(session.id, mode));
  };

  useAppShortcut("cycle-permission-mode", controller.state.preferences.appShortcutOverrides, (event) => {
    if (!canSetPermission || document.body.classList.contains("modal-open")) return false;
    const target = event.target instanceof Element ? event.target : null;
    const editor = target?.closest<HTMLElement>("[data-composer-editor='true']");
    if (editor === undefined || editor === null || paneRef.current?.contains(editor) !== true) return false;
    if (editor instanceof HTMLTextAreaElement && (editor.readOnly || editor.disabled)) return false;
    if (editor.getAttribute("contenteditable") === "false" || editor.getAttribute("aria-disabled") === "true") return false;
    const mode = nextPermissionMode(session.permissionMode, permissionCycleOptions);
    if (mode === null) return false;
    setPermission(mode);
    return true;
  });

  const stopRun = (): void => {
    const runId = session.activeRunId;
    if (!canStop || !running || runId === undefined || stoppingRunIdsRef.current.has(runId)) return;
    const sourceSessionId = session.id;
    stoppingRunIdsRef.current.add(runId);
    setStopRevision((current) => current + 1);
    runAction(`stop:${runId}`, async () => {
      try {
        const hasPendingQueueItems = hasPendingComposerQueueItems(queue, sourceSessionId);
        if (session.state === "retrying") {
          await pauseQueueThenAbortRetry(controller, sourceSessionId, runId, hasPendingQueueItems, queueControl?.state === "paused");
        } else {
          await pauseQueueThenAbort(controller, sourceSessionId, runId, hasPendingQueueItems, queueControl?.state === "paused");
        }
      } finally {
        stoppingRunIdsRef.current.delete(runId);
        setStopRevision((current) => current + 1);
      }
    });
  };
  const stopInFlight = session.activeRunId !== undefined && stoppingRunIdsRef.current.has(session.activeRunId);

  const performErrorTailRecovery = async (sourceSessionId: string, error: ErrorView, action: ExecutableRecoveryAction): Promise<void> => {
    if (activeSessionIdRef.current !== sourceSessionId) throw new Error(t("errorTail.staleAction"));
    if (action.kind === "retry") {
      if (error.runId === undefined || error.runId !== controllerRef.current.state.snapshot.sessions.find((candidate) => candidate.id === sourceSessionId)?.retryRunId) throw new Error(t("errorTail.staleAction"));
      await controllerRef.current.retry(error.runId);
    } else if (action.kind === "wait") {
      const recoveryKey = `${sourceSessionId}:${error.runId ?? error.code}:${action.id}`;
      const abort = new AbortController();
      recoveryWaitAbortsRef.current.set(recoveryKey, abort);
      try {
        const ready = await waitForRecoveryDelay(action.retryAfterMs, abort.signal);
        if (!ready || activeSessionIdRef.current !== sourceSessionId || controllerRef.current.state.connectionState === "disconnected") throw new Error(t("errorTail.staleAction"));
        await controllerRef.current.refresh();
      } finally {
        if (recoveryWaitAbortsRef.current.get(recoveryKey) === abort) recoveryWaitAbortsRef.current.delete(recoveryKey);
      }
    } else if (action.kind === "resnapshot") {
      await controllerRef.current.refresh();
    } else if (action.kind === "openSession") {
      controllerRef.current.navigate({ kind: "session", sessionId: sourceSessionId });
      await controllerRef.current.setNavigationOpen(true);
    } else if (action.kind === "openDiagnostics" || action.kind === "reauthenticate") {
      window.location.hash = recoverySettingsHash(action.kind);
      await controllerRef.current.setNavigationOpen(true);
    } else if (action.kind === "contactOwner" && canContactOwner) {
      window.location.hash = recoverySettingsHash(action.kind);
      await controllerRef.current.setNavigationOpen(true);
    } else if (action.kind === "abort" && canAbort && error.runId !== undefined && error.runId === session.activeRunId) {
      await controllerRef.current.abort(error.runId);
    } else {
      throw new Error(t("errorTail.staleAction"));
    }
  };

  const handleErrorTailAction = (error: ErrorView, action: ExecutableRecoveryAction): void => {
    if (errorTailProjection?.bannerVisible !== true || errorTailProjection.item.error !== error) return;
    const localKey = errorTailProjection.localKey;
    const sourceSessionId = session.id;
    if (!errorTailLocalProjection.begin(localKey)) return;
    setErrorTailActionFailure(undefined);
    setErrorTailRevision((current) => current + 1);
    void performErrorTailRecovery(sourceSessionId, error, action).then(() => {
      // A recovery request is not itself a read receipt. Running/queue
      // lifecycle state owns suppression, and only a true running transition
      // clears durable error attention.
      errorTailLocalProjection.fail(localKey);
      setErrorTailRevision((current) => current + 1);
    }).catch((failure: unknown) => {
      errorTailLocalProjection.fail(localKey);
      setErrorTailActionFailure({ localKey, message: failure instanceof Error ? failure.message : String(failure) });
      setErrorTailRevision((current) => current + 1);
    });
  };

  const handleErrorTailDismiss = (): void => {
    if (!canAcknowledgeSessionAttention || errorTailProjection?.bannerVisible !== true) return;
    const localKey = errorTailProjection.localKey;
    const cursor = explicitErrorAttentionCursor(session.attention, errorTailProjection.item);
    if (cursor === undefined || !errorTailLocalProjection.begin(localKey)) return;
    setErrorTailActionFailure(undefined);
    setErrorTailRevision((current) => current + 1);
    void controllerRef.current.acknowledgeSessionError(session.id, cursor).then(() => {
      errorTailLocalProjection.dismiss(localKey);
      setErrorTailRevision((current) => current + 1);
    }).catch((failure: unknown) => {
      errorTailLocalProjection.fail(localKey);
      setErrorTailActionFailure({ localKey, message: failure instanceof Error ? failure.message : String(failure) });
      setErrorTailRevision((current) => current + 1);
    });
  };

  const scheduleUsageLimitRecovery = (hint: UsageLimitRecoveryHint): void => {
    if (errorTailProjection?.bannerVisible !== true || reviewReadOnly) return;
    stageUsageLimitScheduleIntent(session.id, hint);
    controller.navigate({ kind: "schedules" });
    void controller.setNavigationOpen(true);
  };

  const setCompactConfirmation = (value: typeof compactConfirmation): void => {
    compactConfirmationRef.current = value;
    setCompactConfirmationState(value);
  };

  const releaseCompactConfirmation = (): void => {
    const pending = compactConfirmationRef.current;
    if (pending === undefined) return;
    setCompactConfirmation(undefined);
    pending.request.release();
    setCompactRevision((current) => current + 1);
  };

  const requestCompact = (): void => {
    const contextWindow = resolveDisplayContextWindow(session.context?.contextWindow ?? 0, session.model?.contextWindow);
    const usedTokens = Math.min(session.context?.usedTokens ?? 0, contextWindow || Number.POSITIVE_INFINITY);
    if (!canCompact || running || activeCompaction !== undefined || usedTokens <= 0) return;
    const request = compactGuardRef.current.tryBegin(session.id);
    if (request === undefined) return;
    const percent = contextWindow > 0 ? Math.round((usedTokens / contextWindow) * 100) : 0;
    setCompactConfirmation({ request, usedTokens, contextWindow, percent });
    setCompactRevision((current) => current + 1);
  };

  const confirmCompact = (): void => {
    const pending = compactConfirmationRef.current;
    if (pending === undefined) return;
    setCompactConfirmation(undefined);
    const sourceSessionId = pending.request.sessionId;
    const freshSnapshot = controllerRef.current.state.snapshot;
    const freshSession = freshSnapshot.sessions.find((candidate) => candidate.id === sourceSessionId);
    const freshBackend = freshSession === undefined ? undefined : freshSnapshot.backends.find((candidate) => candidate.id === freshSession.backendId);
    const freshTimeline = freshSnapshot.timelineBySession.get(sourceSessionId) ?? [];
    const stale = !compactGuardRef.current.isCurrent(sourceSessionId, pending.request.epoch)
      || freshSession === undefined
      || freshBackend?.capabilities.get("context.compact")?.supported !== true
      || freshSession.state === "running"
      || freshSession.state === "waiting"
      || freshSession.state === "retrying"
      || resolveActiveCompaction(freshTimeline, freshSession.compacting) !== undefined;
    if (stale) {
      pending.request.release();
      setCompactRevision((current) => current + 1);
      return;
    }
    setCompactFeedback({ sessionId: sourceSessionId, epoch: pending.request.epoch, phase: "busy" });
    void (async () => {
      let feedbackSettled = false;
      try {
        const latestSnapshot = controllerRef.current.state.snapshot;
        const latest = latestSnapshot.sessions.find((candidate) => candidate.id === sourceSessionId);
        const latestBackend = latest === undefined ? undefined : latestSnapshot.backends.find((candidate) => candidate.id === latest.backendId);
        const latestTimeline = latestSnapshot.timelineBySession.get(sourceSessionId) ?? [];
        if (
          !compactGuardRef.current.isCurrent(sourceSessionId, pending.request.epoch)
          || latest === undefined
          || latestBackend?.capabilities.get("context.compact")?.supported !== true
          || (latest.context?.usedTokens ?? 0) <= 0
          || latest.state === "running"
          || latest.state === "waiting"
          || latest.state === "retrying"
          || resolveActiveCompaction(latestTimeline, latest.compacting) !== undefined
        ) return;
        const outcome = await controllerRef.current.compact(sourceSessionId);
        if (compactGuardRef.current.isCurrent(sourceSessionId, pending.request.epoch)) {
          feedbackSettled = true;
          setCompactFeedback({
            sessionId: sourceSessionId,
            epoch: pending.request.epoch,
            phase: outcome === "noop" ? "noop" : "compacted"
          });
        }
      } catch {
        if (compactGuardRef.current.isCurrent(sourceSessionId, pending.request.epoch)) {
          feedbackSettled = true;
          setCompactFeedback({
            sessionId: sourceSessionId,
            epoch: pending.request.epoch,
            phase: "failure"
          });
        }
      } finally {
        pending.request.release();
        if (compactGuardRef.current.isCurrent(sourceSessionId, pending.request.epoch)) {
          if (!feedbackSettled) setCompactFeedback((current) => current?.sessionId === sourceSessionId
            && current.epoch === pending.request.epoch
            && current.phase === "busy"
            ? undefined
            : current);
          setCompactRevision((current) => current + 1);
        }
      }
    })();
  };

  const addMessageToComposer = (item: TimelineItemView): void => {
    const mention = createMessageComposerMention(session.id, session.name, item);
    if (!canAddMessageReference || mention === undefined) return;
    setComposerMessageMentionInsertion({
      id: ++composerMessageMentionInsertionIdRef.current,
      sessionId: session.id,
      mention
    });
  };

  const addSelectionToComposer = (quote: ComposerSelectionQuoteDraft): void => {
    if (!canAddMessageReference || quote.sessionId !== session.id) return;
    setComposerSelectionQuoteInsertion({
      id: ++composerSelectionQuoteInsertionIdRef.current,
      sessionId: session.id,
      quote
    });
  };

  const openMessageDelete = (item: TimelineItemView): void => {
    const target = resolveMessageDeleteTarget(item);
    if (!messageDeleteSupported || messageDeleteBlockedReason !== undefined || target === undefined) return;
    const next: ActiveMessageDelete = {
      sessionId: session.id,
      messageId: target.messageId,
      eventId: target.eventId,
      item,
      busy: false
    };
    messageDeleteRef.current = next;
    setMessageDeleteState(next);
  };

  const closeMessageDelete = (): void => {
    if (messageDeleteRef.current?.busy === true) return;
    messageDeleteRef.current = undefined;
    setMessageDeleteState(undefined);
  };

  const confirmMessageDelete = (): void => {
    const pending = messageDeleteRef.current;
    if (pending === undefined || pending.busy) return;
    const request = messageDeleteGuardRef.current.tryBegin(pending.sessionId);
    if (request === undefined) return;
    void (async () => {
      try {
        const latestState = controllerRef.current.state;
        const latestSnapshot = latestState.snapshot;
        const latestSession = latestSnapshot.sessions.find((candidate) => candidate.id === pending.sessionId);
        const latestBackend = latestSession === undefined
          ? undefined
          : latestSnapshot.backends.find((candidate) => candidate.id === latestSession.backendId);
        const latestQueuedWork = latestSnapshot.queue.some((candidate) =>
          candidate.sessionId === pending.sessionId
          && !["completed", "cancelled", "failed"].includes(candidate.state));
        const latestItem = visibleTimeline.find((candidate) =>
          candidate.id === pending.messageId && candidate.sourceEventId === pending.eventId
        );
        const latestTarget = latestItem === undefined ? undefined : resolveMessageDeleteTarget(latestItem);
        const routeCurrent = sessionRouteIsCurrent(latestState.route, pending.sessionId)
          && activeSessionIdRef.current === pending.sessionId;
        if (!routeCurrent || !messageDeleteGuardRef.current.isCurrent(pending.sessionId, request.epoch)) return;
        if (
          latestSession?.state !== "idle"
          || latestSession.compacting === true
          || latestQueuedWork
          || latestSnapshot.interactions.some((candidate) => candidate.sessionId === pending.sessionId)
        ) {
          const blocked = { ...pending, busy: false, error: t("timeline.deleteMessageBusy") };
          messageDeleteRef.current = blocked;
          setMessageDeleteState(blocked);
          return;
        }
        if (
          latestBackend?.capabilities.get("session.message_delete")?.supported !== true
          || latestTarget?.messageId !== pending.messageId
          || latestTarget.eventId !== pending.eventId
        ) {
          const failed = { ...pending, busy: false, error: t("timeline.deleteMessageFailed") };
          messageDeleteRef.current = failed;
          setMessageDeleteState(failed);
          return;
        }
        const inFlight = { ...pending, busy: true, error: undefined };
        messageDeleteRef.current = inFlight;
        setMessageDeleteState(inFlight);
        await controllerRef.current.deleteSessionMessage(pending.sessionId, pending.eventId);
        if (!messageDeleteGuardRef.current.isCurrent(pending.sessionId, request.epoch)) return;
        const current = messageDeleteRef.current;
        if (current?.sessionId !== pending.sessionId || current.eventId !== pending.eventId) return;
        setShareSelection(undefined);
        shareSelectionBeforeAllRef.current = undefined;
        messageRewindRequestIdRef.current += 1;
        setMessageRewind(undefined);
        setMessageActionResetSignal((value) => value + 1);
        window.getSelection()?.removeAllRanges();
        messageDeleteRef.current = undefined;
        setMessageDeleteState(undefined);
      } catch {
        if (!messageDeleteGuardRef.current.isCurrent(pending.sessionId, request.epoch)) return;
        const current = messageDeleteRef.current;
        if (current?.sessionId !== pending.sessionId || current.eventId !== pending.eventId) return;
        const failed = { ...current, busy: false, error: t("timeline.deleteMessageFailed") };
        messageDeleteRef.current = failed;
        setMessageDeleteState(failed);
      } finally {
        request.release();
      }
    })();
  };

  const reportMessageForkFailure = (itemId: string, message: string): void => {
    runAction(`fork-message-blocked:${itemId}`, async () => { throw new Error(message); });
  };

  const forkFromMessage = (item: TimelineItemView): void => {
    const target = resolveMessageForkTarget(item);
    if (!canForkMessage || target === undefined || forkingMessageId !== undefined) return;
    if (messageForkBlocked(visibleTimeline, item, running)) {
      reportMessageForkFailure(item.id, t("timeline.forkBusy"));
      return;
    }
    setMessageFork({ sessionId: session.id, messageId: item.id, target });
  };

  const confirmMessageFork = (): void => {
    const pending = messageFork;
    if (pending === undefined || pending.sessionId !== session.id || forkingMessageId !== undefined) return;
    setMessageFork(undefined);
    const latestState = controllerRef.current.state;
    const latestSnapshot = latestState.snapshot;
    const latestSession = latestSnapshot.sessions.find((candidate) => candidate.id === pending.sessionId);
    const latestBackend = latestSession === undefined
      ? undefined
      : latestSnapshot.backends.find((candidate) => candidate.id === latestSession.backendId);
    const latestTimeline = latestSnapshot.timelineBySession.get(pending.sessionId) ?? [];
    const latestItem = latestTimeline.find((candidate) => candidate.id === pending.messageId);
    const latestTarget = latestItem === undefined ? undefined : resolveMessageForkTarget(latestItem);
    const latestRunning = latestSession?.state === "running" || latestSession?.state === "waiting" || latestSession?.state === "retrying";
    const routeCurrent = sessionRouteIsCurrent(latestState.route, pending.sessionId)
      && activeSessionIdRef.current === pending.sessionId;
    if (!routeCurrent) return;
    if (
      latestBackend?.capabilities.get("session.fork")?.supported !== true
      || latestItem === undefined
      || latestItem.sourceEventId === undefined
      || latestTarget?.entryId !== pending.target.entryId
    ) {
      reportMessageForkFailure(pending.messageId, t("timeline.forkUnavailable"));
      return;
    }
    if (messageForkBlocked(latestTimeline, latestItem, latestRunning)) {
      reportMessageForkFailure(pending.messageId, t("timeline.forkBusy"));
      return;
    }
    const sourceSessionId = pending.sessionId;
    const sourceSessionName = latestSession?.name ?? session.name;
    const sourceEventId = latestItem.sourceEventId;
    setForkingMessageId(pending.messageId);
    runAction(`fork-message:${pending.messageId}`, async () => {
      try {
        const forkedSessionId = await controllerRef.current.forkSession(
          sourceSessionId,
          latestTarget.entryId,
          t("session.branchSuffix", { name: sourceSessionName }),
          { messageId: latestItem.messageId ?? latestItem.id, eventId: sourceEventId }
        );
        if (latestTarget.composerText !== undefined) {
          const editorDocument = composerDocumentFromMessage(latestTarget.composerText, latestItem.quotesEncoded === true, {
               sessionId: sourceSessionId,
               messageId: latestItem.id,
               role: "user",
               ...(latestItem.sourceEventId === undefined ? {} : { sourceEventId: latestItem.sourceEventId })
            }, "edit", latestItem.pastedTextRanges);
          await controllerRef.current.saveDraft(forkedSessionId, {
            text: composerDocumentPlainText(editorDocument),
            editorDocument,
            attachments: [],
            mentions: [],
            deliveryMode: "prompt"
          });
        }
        controllerRef.current.navigate({ kind: "session", sessionId: forkedSessionId });
      } finally {
        setForkingMessageId((current) => current === pending.messageId ? undefined : current);
      }
    });
  };

  const closeShareSelection = (): void => {
    setShareSelection(undefined);
    shareSelectionBeforeAllRef.current = undefined;
  };

  const startShareSelection = (item: TimelineItemView): void => {
    if (!shareableMessageIds.includes(item.id)) return;
    shareSelectionBeforeAllRef.current = undefined;
    setShareSelection({ sessionId: session.id, selectedIds: new Set([item.id]), anchorId: item.id });
  };

  const toggleShareMessage = (itemId: string, extendRange: boolean): void => {
    setShareSelection((current) => {
      if (current === undefined || current.sessionId !== session.id) return current;
      shareSelectionBeforeAllRef.current = undefined;
      const next = toggleShareMessageSelection(shareableMessageIds, current.selectedIds, itemId, extendRange, current.anchorId);
      return { sessionId: current.sessionId, selectedIds: next.selectedIds, ...(next.anchorId === undefined ? {} : { anchorId: next.anchorId }) };
    });
  };

  const toggleAllShareMessages = (): void => {
    setShareSelection((current) => {
      if (current === undefined || current.sessionId !== session.id || shareableMessageIds.length === 0) return current;
      const allSelected = shareableMessageIds.every((id) => current.selectedIds.has(id));
      if (allSelected) {
        const restored = shareSelectionBeforeAllRef.current ?? new Set<string>();
        shareSelectionBeforeAllRef.current = undefined;
        return { sessionId: current.sessionId, selectedIds: new Set(restored), ...(current.anchorId === undefined ? {} : { anchorId: current.anchorId }) };
      }
      shareSelectionBeforeAllRef.current = new Set(current.selectedIds);
      return { sessionId: current.sessionId, selectedIds: new Set(shareableMessageIds), ...(current.anchorId === undefined ? {} : { anchorId: current.anchorId }) };
    });
  };

  const moveEditedMessageToComposer = async (item: TimelineItemView, text: string): Promise<void> => {
    const sourceSessionId = session.id;
    const targetEntryId = messageDialogueRewindTarget(item);
    if (targetEntryId === undefined) throw new Error(t("timeline.rewindUnavailable"));
    const currentBoundary = () => {
      const state = controllerRef.current.state;
      const snapshot = state.snapshot;
      const activeSession = snapshot.sessions.find((candidate) => candidate.id === sourceSessionId);
      const activeBackend = activeSession === undefined ? undefined : snapshot.backends.find((candidate) => candidate.id === activeSession.backendId);
      const activeTimeline = snapshot.timelineBySession.get(sourceSessionId) ?? [];
      const activeUser = lastVisibleUserMessage(activeTimeline.filter((candidate) => !hidesFromTimelineHistory(candidate)));
      const queuedWork = snapshot.queue.some((candidate) => candidate.sessionId === sourceSessionId && !["completed", "cancelled", "failed"].includes(candidate.state));
      if (
        !sessionRouteIsCurrent(state.route, sourceSessionId)
        || activeSession?.state !== "idle"
        || queuedWork
        || activeBackend?.capabilities.get("session.rewind")?.supported !== true
        || activeUser?.id !== item.id
        || !canEditVisibleUserMessage(activeUser)
        || messageDialogueRewindTarget(activeUser) !== targetEntryId
      ) return undefined;
      return { snapshot, session: activeSession, backend: activeBackend, user: activeUser };
    };
    const initialBoundary = currentBoundary();
    if (initialBoundary === undefined || !sameMessageAttachments(initialBoundary.user.attachments, item.attachments)) {
      throw new Error(t("timeline.editStale"));
    }

    const editorDocument = item.quotesEncoded === true
      ? composerDocumentFromEditedEncodedMessage(item.text ?? "", text, {
        sessionId: sourceSessionId,
        messageId: item.id,
        role: "user",
        ...(item.sourceEventId === undefined ? {} : { sourceEventId: item.sourceEventId })
      }, "edit", item.pastedTextRanges)
      : (item.pastedTextRanges?.length ?? 0) > 0 && text === (item.text ?? "")
        ? composerDocumentFromMessage(item.text ?? "", false, {
          sessionId: sourceSessionId,
          messageId: item.id,
          role: "user",
          ...(item.sourceEventId === undefined ? {} : { sourceEventId: item.sourceEventId })
        }, "edit", item.pastedTextRanges)
        : plainTextToComposerDocument(text);
    const imageRouted = initialBoundary.snapshot.settings.visionBridge.enabled && initialBoundary.session.model !== undefined
      && initialBoundary.snapshot.settings.visionBridge.targetModels.some((candidate) => candidate.backendId === initialBoundary.session.backendId && candidate.providerId === initialBoundary.session.model?.providerId && candidate.modelId === initialBoundary.session.model.modelId);
    const attachmentPolicy = resolveComposerAttachmentPolicy(
      initialBoundary.backend,
      initialBoundary.session.model?.supportsImages === true || imageRouted
    );
    let restoredAttachments: readonly AttachmentDraft[];
    try {
      restoredAttachments = await restoreMessageAttachmentDrafts(
        initialBoundary.user.attachments ?? [],
        attachmentPolicy,
        async (artifact) => {
          const response = await fetch(await controllerRef.current.getArtifactUrl(artifact.blobId));
          if (!response.ok) throw new Error("Artifact bytes are unavailable.");
          return response.blob();
        },
        randomUuid
      );
    } catch {
      throw new Error(t("timeline.editAttachmentRestoreFailed"));
    }

    const boundaryAfterLoad = currentBoundary();
    if (boundaryAfterLoad === undefined || !sameMessageAttachments(boundaryAfterLoad.user.attachments, item.attachments)) {
      throw new Error(t("timeline.editStale"));
    }
    const previousDraft = await controllerRef.current.readDraft(sourceSessionId);
    const replacement = {
      id: ++composerDraftReplacementIdRef.current,
      sessionId: sourceSessionId,
      text: composerDocumentPlainText(editorDocument),
      editorDocument,
      attachments: restoredAttachments
    };
    const replacementDraft = {
      text: replacement.text,
      editorDocument,
      attachments: restoredAttachments,
      mentions: [],
      deliveryMode: "prompt" as const,
      ...(previousDraft?.extraDirectoryIds === undefined ? {} : { extraDirectoryIds: previousDraft.extraDirectoryIds })
    };
    const rollbackDraft = previousDraft ?? { text: "", attachments: [], mentions: [], deliveryMode: "prompt" as const };
    await controllerRef.current.saveDraft(sourceSessionId, replacementDraft);
    const boundaryBeforeRewind = currentBoundary();
    if (boundaryBeforeRewind === undefined || !sameMessageAttachments(boundaryBeforeRewind.user.attachments, item.attachments)) {
      await restoreEditedMessageDraft(controllerRef.current, sourceSessionId, rollbackDraft, t);
      throw new Error(t("timeline.editStale"));
    }
    try {
      await controllerRef.current.navigateSessionBranch(sourceSessionId, targetEntryId);
    } catch (error) {
      await restoreEditedMessageDraft(controllerRef.current, sourceSessionId, rollbackDraft, t);
      throw error;
    }
    setComposerDraftReplacement(replacement);
  };

  const previewMessageRewind = (item: TimelineItemView): void => {
    const targetEntryId = messageDialogueRewindTarget(item);
    if (!messageRewindSupported || targetEntryId === undefined) return;
    const requestId = ++messageRewindRequestIdRef.current;
    const runId = messageRoundRunId(visibleTimeline, item.id);
    const filesSupported = workspace !== undefined && backend?.capabilities.get("workspace.rewind")?.supported === true && runId !== undefined;
    setMessageRewind({ sessionId: session.id, itemId: item.id, targetEntryId, loadingFiles: filesSupported });
    if (!filesSupported || workspace === undefined || runId === undefined) return;
    const sourceSessionId = session.id;
    const workspaceId = workspace.id;
    void (async () => {
      try {
        const changeSets = await controllerRef.current.listWorkspaceChangeSets(workspaceId, sourceSessionId);
        const changeSet = changeSetForMessageRound(changeSets, runId);
        if (changeSet === undefined) {
          if (messageRewindRequestIdRef.current === requestId && activeSessionIdRef.current === sourceSessionId) {
            setMessageRewind((current) => current?.sessionId === sourceSessionId && current.itemId === item.id ? { ...current, loadingFiles: false } : current);
          }
          return;
        }
        const preview = await controllerRef.current.previewWorkspaceRewind(workspaceId, changeSet.id);
        if (messageRewindRequestIdRef.current !== requestId || activeSessionIdRef.current !== sourceSessionId) return;
        setMessageRewind((current) => current?.sessionId === sourceSessionId && current.itemId === item.id ? { ...current, loadingFiles: false, preview } : current);
      } catch {
        if (messageRewindRequestIdRef.current !== requestId || activeSessionIdRef.current !== sourceSessionId) return;
        setMessageRewind((current) => current?.sessionId === sourceSessionId && current.itemId === item.id ? { ...current, loadingFiles: false, filePreviewError: t("timeline.rewindFilesUnavailable") } : current);
      }
    })();
  };

  const closeMessageRewind = (): void => {
    messageRewindRequestIdRef.current += 1;
    setMessageRewind(undefined);
  };

  const rewindDialogueOnly = async (): Promise<void> => {
    const rewind = messageRewind;
    if (rewind === undefined || rewind.sessionId !== session.id) throw new Error(t("timeline.rewindUnavailable"));
    const latest = controllerRef.current.state.snapshot;
    const latestSession = latest.sessions.find((candidate) => candidate.id === rewind.sessionId);
    const latestBackend = latestSession === undefined ? undefined : latest.backends.find((candidate) => candidate.id === latestSession.backendId);
    const latestQueuedWork = latest.queue.some((candidate) => candidate.sessionId === rewind.sessionId && !["completed", "cancelled", "failed"].includes(candidate.state));
    if (latestSession?.state !== "idle" || latestQueuedWork || latestBackend?.capabilities.get("session.rewind")?.supported !== true) throw new Error(t("timeline.rewindStale"));
    await controllerRef.current.navigateSessionBranch(rewind.sessionId, rewind.targetEntryId);
  };

  const rewindFilesOnly = async (): Promise<void> => {
    const rewind = messageRewind;
    const preview = rewind?.preview;
    if (rewind === undefined || preview === undefined || workspace === undefined || rewind.sessionId !== session.id || preview.safety === "blocked") throw new Error(t("timeline.rewindFilesUnavailable"));
    await controllerRef.current.executeWorkspaceRewind(workspace.id, preview.id, preview.changeSetId, false);
  };

  const composerControls = (
    <div className="composer__controls" aria-label={t("session.controls")}>
      {canSetPermission && <PermissionSelector
        value={session.permissionMode}
        modes={allowedPermissions}
        onChange={setPermission}
        t={t}
      />}
      {canSetPlanMode && <button className={cx("control-toggle", session.planMode && "is-active")} type="button" aria-pressed={session.planMode} onClick={() => runAction("plan", () => controller.setPlanMode(session.id, !session.planMode))}><Sparkles aria-hidden="true" />{t("controls.plan")}</button>}
      <div className="control-chip" title={t("controls.backend")}><Bot aria-hidden="true" /><span>{backend?.name ?? session.backendId}</span></div>
      {session.model !== undefined && !canSwitchModel && !canSetEffort && !canSetFast && (
        <div className="control-select"><span className="sr-only">{t("controls.model")}</span><strong>{session.model.name}</strong><small>{session.model.providerName}</small></div>
      )}
      {(canSwitchModel || ((canSetEffort || canSetFast) && session.model !== undefined)) && <ModelPicker
        className="control-select"
        models={canSwitchModel ? backendModels : session.model === undefined ? [] : [session.model]}
        ownerId={modelPreferenceOwnerId(controller.state.activeProfile?.serverId)}
        value={session.model === undefined ? undefined : {
          backendId: session.backendId,
          providerId: session.model.providerId,
          modelId: session.model.modelId,
          ...(session.effort === undefined ? {} : { effort: session.effort }),
          fastMode: session.fastMode
        }}
        effortEnabled={canSetEffort}
        fastEnabled={canSetFast}
        useMorphPopover
        onSelectionFocus={() => setComposerFocusRequest((current) => current + 1)}
        t={t}
        onOpen={() => controller.refreshProviderModels(session.backendId, undefined, true).catch(() => undefined)}
        onConnectSource={() => { window.location.hash = "#/settings/providers"; }}
        onSelect={(selection) => {
          if (selection === undefined) return;
          const model = backendModels.find((candidate) =>
            candidate.providerId === selection.providerId && candidate.modelId === selection.modelId);
          if (model === undefined || !model.available) return;
          runAction("model", () => controller.setModel(
            session.id,
            model.providerId,
            model.modelId,
            canSetEffort && selection.effort !== undefined && model.efforts.includes(selection.effort)
              ? selection.effort
              : undefined,
            canSetFast && model.supportsFast && selection.fastMode
          ));
        }}
      />}
    </div>
  );

  return (
    <main ref={paneRef} className={cx("session-pane", presentation === "filesRail" && "session-pane--files-rail")} aria-label={session.name} onKeyDownCapture={(event) => {
      const modalOpen = document.body.classList.contains("modal-open");
      const retryEscapeInput: RetryEscapeInput = {
        key: event.key,
        repeat: event.repeat,
        isComposing: event.nativeEvent.isComposing,
        defaultPrevented: event.defaultPrevented,
        modalOpen,
        target: retryEscapeTarget(event.target)
      };
      const retryEscape = resolveRetryEscapeIntent(retryEscapeInput, {
        sessionState: session.state,
        ...(session.activeRunId === undefined ? {} : { activeRunId: session.activeRunId }),
        ...(activeRetry === undefined ? {} : { retry: activeRetry }),
        canAbortRetry
      });
      if (retryEscape !== null) {
        const sourceSessionId = session.id;
        const latestControllerState = controllerRef.current.state;
        const latestSnapshot = latestControllerState.snapshot;
        const latestSession = latestSnapshot.sessions.find((candidate) => candidate.id === sourceSessionId);
        const latestBackend = latestSession === undefined ? undefined : latestSnapshot.backends.find((candidate) => candidate.id === latestSession.backendId);
        const latestTimeline = latestSnapshot.timelineBySession.get(sourceSessionId) ?? [];
        const latestRetry = latestSession === undefined ? undefined : resolveActiveRetry(latestTimeline, latestSession);
        const routeStillCurrent = sessionRouteIsCurrent(latestControllerState.route, sourceSessionId);
        const freshIntent = latestSession === undefined ? null : resolveRetryEscapeIntent(retryEscapeInput, {
          sessionState: latestSession.state,
          ...(latestSession.activeRunId === undefined ? {} : { activeRunId: latestSession.activeRunId }),
          ...(latestRetry === undefined ? {} : { retry: latestRetry }),
          canAbortRetry: latestBackend?.capabilities.get("context.auto_retry")?.supported === true
        });
        if (
          !routeStillCurrent ||
          activeSessionIdRef.current !== sourceSessionId ||
          latestSession?.activeRunId !== retryEscape.runId ||
          freshIntent?.runId !== retryEscape.runId
        ) return;
        event.preventDefault();
        event.stopPropagation();
        stopRun();
        return;
      }
    }}>
      {presentation !== "filesRail" && <header className="session-header">
        <div className="session-header__leading">
          {!navigationOpen && <IconButton className="mobile-panel-toggle" label={t("a11y.openNavigation")} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>}
          <div className="session-heading">
            <div className="breadcrumbs"><span>{navigationProjectName}</span><span aria-hidden="true">/</span><button type="button" onClick={onRename}>{session.name}</button></div>
            <div className="session-heading__status"><StatusDot state={session.state === "retrying" ? "running" : session.state} label={session.state === "retrying" ? "running" : session.state} /><span>{sessionStateLabel(session.state, t)}</span>{displayBranch !== undefined && <Pill className="session-heading__branch" title={t("codeHost.branchBadge", { branch: displayBranch })} aria-label={t("codeHost.branchBadge", { branch: displayBranch })}><GitBranch aria-hidden="true" />{displayBranch}</Pill>}{session.nativeLeafId !== undefined && <Pill><GitBranch aria-hidden="true" />{shortId(session.nativeLeafId)}</Pill>}</div>
          </div>
        </div>
        <div className="session-header__actions">
          {canStop && running && session.activeRunId !== undefined && <Button tone="danger" disabled={stopInFlight} onClick={stopRun}><CircleStop aria-hidden="true" />{t("controls.abort")}</Button>}
          {!reviewReadOnly && session.state === "error" && session.retryRunId !== undefined && <Button onClick={() => runAction("retry", () => controller.retry(session.retryRunId as string))}><RotateCcw aria-hidden="true" />{t("common.retry")}</Button>}
          <SessionHeaderActionsMenu
            session={session}
            projectTargets={sessionProjectTargets}
            movingProject={movingSessionProject}
            t={t}
            onRename={onRename}
            onPin={onPin ?? (() => runAction(`pin:${session.id}`, () => controller.pinSession(session.id, !session.pinned)))}
            onArchive={onArchive ?? (() => runAction(`archive:${session.id}`, () => controller.archiveSession(session.id, !session.archived)))}
            onDelete={onDelete}
            onMoveSessionProject={onMoveSessionProject}
            onCopyTaskLink={onCopyTaskLink}
            onExportPortableSession={canExportPortable ? onExportPortableSession : undefined}
            onExportHtml={canExport ? () => runAction(`export:${session.id}`, () => controller.exportSession(session.id)) : undefined}
            onClone={canClone ? () => runAction(`clone:${session.id}`, async () => {
              const sourceMessage = latestDerivationSourceMessage(
                controller.state.snapshot.timelineBySession.get(session.id) ?? visibleTimeline
              );
              const sessionId = await controller.cloneSession(
                session.id,
                t("session.cloneSuffix", { name: session.name }),
                sourceMessage
              );
              controller.navigate({ kind: "session", sessionId });
            }) : undefined}
            onSplitSession={onSplitSession}
            onOpenSessionWindow={onOpenSessionWindow}
            onOpenCodeHostPullRequest={(url) => runAction(
              `open-code-host-pull-request:${session.id}`,
              () => openCodeHostPullRequestExternal(controller, session.id, url)
            )}
          />
          {!reviewReadOnly && inspectorAvailable && !inspectorOpen && <IconButton label={t("a11y.openInspector")} onClick={onOpenInspector}><PanelRight aria-hidden="true" /></IconButton>}
        </div>
      </header>}

      {session.worktree?.state === "preserved" && <div className="session-worktree-warning" role="alert"><GitBranch aria-hidden="true" /><span><strong>{t("worktree.preservedTitle")}</strong><small>{t("worktree.preservedDescription", { branch: session.worktree.branch })}</small></span></div>}

      <ExtensionStatuses statuses={extensionStatuses} />

      <Timeline
        key={session.id}
        sessionId={session.id}
        sessionName={session.name}
        items={visibleTimeline}
        sessionActive={running}
        derivationOrigin={derivationOrigin}
        sessionCreatedAt={session.createdAt}
        onOpenDerivationOrigin={!derivationSourceCanOpen || derivationOrigin === undefined ? undefined : () => controller.navigate({
          kind: "session",
          sessionId: derivationOrigin.sourceSessionId,
          ...(derivationOrigin.sourceMessageId === undefined ? {} : { messageId: derivationOrigin.sourceMessageId }),
          ...(derivationOrigin.sourceEventId === undefined ? {} : { messageEventId: derivationOrigin.sourceEventId })
        })}
        messageNavRailEnabled={controller.state.preferences.messageNavRailEnabled}
        streamFadeEnabled={controller.state.preferences.streamFadeEnabled}
        onOpenHttpLink={(url, options) => runAction("open-message-link", () => controller.openHttpLink(url, { ...options, sessionId: session.id }))}
        onLoadWorkspaceAsset={canOpenWorkspaceReferences ? loadTimelineWorkspaceAsset : undefined}
        onWorkspaceImageToComposer={canAddWorkspaceImage ? addTimelineWorkspaceImage : undefined}
        subagentRuns={subagentRuns}
        subagentRunDetails={subagentRunDetails}
        onOpenSubagent={canListSubagents && inspectorAvailable ? onOpenSubagent : undefined}
        onStopSubagent={stopTimelineSubagent}
        hasEarlier={timelineHasEarlier}
        historyLoading={timelineHistoryLoading}
        historyError={timelineHistoryError}
        onLoadEarlier={onLoadEarlierTimeline}
        onInlinePlanVisibilityChange={handleInlinePlanVisibilityChange}
        followLatestSignal={followLatestSignal}
        focusRequest={timelineFocusRequest}
        bottomInset={bottomInset}
        retryRunId={session.retryRunId}
        locale={controller.state.preferences.locale}
        t={t}
        onArtifactUrl={(blobId) => controller.getArtifactUrl(blobId)}
        onArtifactUrlRelease={(blobId) => controller.releaseArtifactUrl(blobId)}
        onArtifactDownload={(blobId, fileName) => runAction(`download:${blobId}`, () => controller.downloadArtifact(blobId, fileName))}
        onOpenGeneratedFile={!canOpenGeneratedFiles(backend, workspace) ? undefined : (workspaceId, relativePath) => {
          if (workspace?.id !== workspaceId) return;
          controller.navigate({ kind: "files", sessionId: session.id, file: relativePath });
        }}
        onOpenTurnReview={!canOpenExactTurnReview(backend, workspace, reviewReadOnly) ? undefined : onOpenTurnReview}
        onReobserveReview={(reviewRunId) => controller.reobserveReview(reviewRunId)}
        onAddMessageToComposer={canAddMessageReference ? addMessageToComposer : undefined}
        onAddSelectionToComposer={canAddMessageReference ? addSelectionToComposer : undefined}
        onForkMessage={canForkMessage ? forkFromMessage : undefined}
        forkingMessageId={forkingMessageId}
        shareSelection={currentShareSelection === undefined ? undefined : { selectedIds: currentShareSelection.selectedIds }}
        onStartShareSelection={startShareSelection}
        onToggleShareMessage={currentShareSelection === undefined ? undefined : toggleShareMessage}
        editableMessageId={editableMessageId}
        onMoveEditedMessageToComposer={moveEditedMessageToComposer}
        onPreviewMessageRewind={messageRewindSupported ? previewMessageRewind : undefined}
        onDeleteMessage={messageDeleteSupported ? openMessageDelete : undefined}
        messageDeleteBlockedReason={messageDeleteSupported ? messageDeleteBlockedReason : undefined}
        messageActionResetSignal={messageActionResetSignal}
        onWorkspaceRewind={reviewReadOnly || !canRewindFromTimeline(backend, workspace) ? undefined : (workspaceId, changeSetId) => runAction(`preview-rewind:${changeSetId}`, async () => {
          if (workspace?.id !== workspaceId) throw new Error("This workspace change no longer belongs to the active task.");
          setDialogueOnlyRewind(false);
          setRewindPreview(await controller.previewWorkspaceRewind(workspaceId, changeSetId));
        })}
        onRetry={reviewReadOnly || session.retryRunId === undefined ? undefined : (error) => { if (error.runId === session.retryRunId) runAction(`retry:${error.runId}`, () => controller.retry(error.runId as string)); }}
        recoveryContext={recoveryContext}
        onRecovery={(error, action) => {
          if (action.kind === "retry" && error.runId === session.retryRunId) {
            runAction(`retry:${error.runId}`, () => controller.retry(error.runId as string));
          } else if (action.kind === "wait") {
            const recoveryKey = `${session.id}:${error.runId ?? error.code}:${action.id}`;
            const abort = new AbortController();
            const work = recoveryFlightsRef.current.run(recoveryKey, async () => {
              recoveryWaitAbortsRef.current.set(recoveryKey, abort);
              try {
                const ready = await waitForRecoveryDelay(action.retryAfterMs, abort.signal);
                if (ready && controllerRef.current.state.connectionState !== "disconnected") await controllerRef.current.refresh();
              } finally {
                if (recoveryWaitAbortsRef.current.get(recoveryKey) === abort) recoveryWaitAbortsRef.current.delete(recoveryKey);
              }
            });
            if (work !== undefined) runAction(`wait-recovery:${recoveryKey}`, () => work);
          } else if (action.kind === "resnapshot") {
            runAction(`resnapshot:${session.id}`, controller.refresh);
          } else if (action.kind === "openSession" || action.kind === "resolveInteraction") {
            controller.navigate({ kind: "session", sessionId: session.id });
            void controller.setNavigationOpen(true);
          } else if (action.kind === "openDiagnostics" || action.kind === "reauthenticate") {
            window.location.hash = recoverySettingsHash(action.kind);
            void controller.setNavigationOpen(true);
          } else if (action.kind === "contactOwner" && canContactOwner) {
            window.location.hash = recoverySettingsHash(action.kind);
            void controller.setNavigationOpen(true);
          } else if (action.kind === "abort" && canAbort && error.runId === session.activeRunId) {
            runAction(`abort:${error.runId}`, () => controller.abort(error.runId as string));
          }
        }}
      />
      <div ref={bottomOverlayRef} className="session-bottom-overlay">
      <ExtensionWidgets widgets={extensionWidgets.filter((widget) => widget.placement === "aboveEditor")} label={t("a11y.extensionWidgets")} />
      <PinnedPlanPanel key={session.id} sessionId={session.id} items={recoveryPresentationTimeline} running={running} visible={interaction === undefined} inlinePlanVisibility={inlinePlanVisibility} t={t} />
      {errorTailProjection?.bannerVisible === true && <ErrorTailBanner
        item={errorTailProjection.item}
        actions={errorTailActions}
        usageLimitRecovery={reviewReadOnly ? undefined : errorTailUsageLimitRecovery ?? undefined}
        actionFailure={errorTailActionFailure?.localKey === errorTailProjection.localKey ? errorTailActionFailure.message : undefined}
        t={t}
        onAction={handleErrorTailAction}
        onScheduleUsageRecovery={reviewReadOnly ? undefined : scheduleUsageLimitRecovery}
        onDismiss={canAcknowledgeSessionAttention ? handleErrorTailDismiss : undefined}
      />}
      {currentCompactFeedback !== undefined && !(currentCompactFeedback.phase === "busy" && activeCompaction !== undefined) && <CompactActionFeedback
        feedback={currentCompactFeedback}
        t={t}
        onDismiss={() => setCompactFeedback((current) => current?.sessionId === currentCompactFeedback.sessionId
          && current.epoch === currentCompactFeedback.epoch
          ? undefined
          : current)}
      />}
      {activeCompaction !== undefined && <CompactionStatusIndicator compaction={activeCompaction} t={t} />}
      {activeRetry !== undefined && <RetryStatusIndicator retry={activeRetry} t={t} />}
      <InteractionPromptHost
        enabled={presentation === "filesRail"}
        hasInteraction={interaction !== undefined}
        placeholder={presentation === "filesRail" ? <div className="interaction-files-rail-placeholder" role="status">{t("interaction.waitForReply")}</div> : undefined}
      >
        <InteractionDialog key={interaction === undefined ? "interaction:none" : `${interaction.sessionId}:${interaction.id}`} controller={controller} interaction={interaction} remaining={remainingInteractions} inline t={t} runAction={runAction} />
      </InteractionPromptHost>
      {currentShareSelection !== undefined && <ShareSelectionBar sessionName={session.name} messages={shareableMessages} selectedIds={currentShareSelection.selectedIds} locale={controller.state.preferences.locale} t={t} onToggleAll={toggleAllShareMessages} onCancel={closeShareSelection} />}
      {interaction === undefined && <div hidden={currentShareSelection !== undefined}><Composer controller={controller} session={session} backend={backend} sessionUsage={effectiveSessionUsage} readOnly={reviewReadOnly} autoFocus={composerAutoFocus && presentation === "standard" && currentShareSelection === undefined} focusRequest={composerFocusRequest} queue={queue} queueControl={queueControl} workspace={workspace} extraDirectories={extraDirectories} resources={resources} commands={canListRuntimeCommands ? liveCommands : []} messageHistory={messageHistory} controls={composerControls} runningStatus={<SessionRunningStatusBar session={session} items={recoveryPresentationTimeline} backgroundTaskIds={backgroundTaskIds} canStopBackgroundTasks={canStopBackgroundTasks} backgroundStopping={backgroundStopping} backgroundStopError={backgroundStopError} suppressed={reviewReadOnly} t={t} onStopBackgroundTasks={stopAllBackgroundTasks} />} messageMentionInsertion={composerMessageMentionInsertion} selectionQuoteInsertion={composerSelectionQuoteInsertion} attachmentInsertion={composerAttachmentInsertion} draftReplacement={composerDraftReplacement} t={t} runAction={runAction} onLocalSend={(sourceSessionId) => { if (activeSessionIdRef.current === sourceSessionId) setFollowLatestSignal((current) => current + 1); }} onStop={canStop ? stopRun : undefined} stopInFlight={stopInFlight} onCompact={canCompact && !running && activeCompaction === undefined && !compactInFlight && (session.context?.usedTokens ?? 0) > 0 ? requestCompact : undefined} /></div>}
      <ExtensionWidgets widgets={extensionWidgets.filter((widget) => widget.placement === "belowEditor")} label={t("a11y.extensionWidgets")} />
      </div>

      <Modal open={canSetPermission && permissionToConfirm !== undefined} title={t("permission.full")} description={t("permission.fullHelp")} size="small" onClose={() => setPermissionToConfirm(undefined)}>
        <div className="risk-confirmation">
          <div className="risk-confirmation__icon"><Shield aria-hidden="true" /></div>
          <p>{t("permission.fullHelp")}</p>
          <div className="modal__actions"><Button onClick={() => setPermissionToConfirm(undefined)}>{t("common.cancel")}</Button><Button tone="danger" onClick={() => { setPermissionToConfirm(undefined); if (canSetPermission) runAction("permission", () => controller.setPermission(session.id, "bypassPermissions")); }}>{t("common.enable")} {t("permission.full")}</Button></div>
        </div>
      </Modal>
      <MessageForkDialog
        key={currentMessageFork === undefined ? "message-fork:none" : `${currentMessageFork.sessionId}:${currentMessageFork.messageId}`}
        open={currentMessageFork !== undefined}
        t={t}
        onClose={() => setMessageFork(undefined)}
        onConfirm={confirmMessageFork}
      />
      <MessageDeleteDialog
        key={currentMessageDelete === undefined ? "message-delete:none" : `${currentMessageDelete.sessionId}:${currentMessageDelete.eventId}`}
        item={currentMessageDelete?.item}
        busy={currentMessageDelete?.busy === true}
        blockedReason={currentMessageDelete === undefined ? undefined : messageDeleteBlockedReason}
        error={currentMessageDelete?.error}
        t={t}
        onClose={closeMessageDelete}
        onConfirm={confirmMessageDelete}
      />
      <Modal
        open={compactConfirmation !== undefined && compactConfirmation.request.sessionId === session.id}
        title={t("session.compactConfirmTitle")}
        description={compactConfirmation === undefined ? undefined : t("session.compactConfirmDescription", {
          used: formatTokenCount(compactConfirmation.usedTokens),
          total: formatTokenCount(compactConfirmation.contextWindow),
          percent: compactConfirmation.percent
        })}
        size="small"
        className="compact-confirmation-modal"
        showClose={false}
        dismissOnBackdrop={false}
        initialFocus={() => paneRef.current?.querySelector<HTMLElement>("[data-compact-cancel='true']") ?? null}
        restoreFocusFallback={() => paneRef.current?.querySelector<HTMLElement>("[data-composer-editor='true']:not(:disabled)") ?? null}
        onClose={releaseCompactConfirmation}
      >
        <div className="modal__actions compact-confirmation__actions">
          <Button data-compact-cancel="true" onClick={releaseCompactConfirmation}>{t("common.cancel")}</Button>
          <Button tone="primary" onClick={confirmCompact}>{t("session.compactConfirmAction")}</Button>
        </div>
      </Modal>
      <MessageRewindDialog
        key={messageRewind === undefined ? "message-rewind:none" : `${messageRewind.sessionId}:${messageRewind.itemId}`}
        open={messageRewind !== undefined && messageRewind.sessionId === session.id}
        state={messageRewind ?? { loadingFiles: false }}
        t={t}
        onClose={closeMessageRewind}
        onDialogueOnly={rewindDialogueOnly}
        onFilesOnly={rewindFilesOnly}
      />
      <Modal open={rewindPreview !== undefined} title={t("workspace.previewTitle")} description={t("workspace.previewDescription")} size="large" onClose={() => setRewindPreview(undefined)}>
        {rewindPreview !== undefined && <div className="rewind-preview timeline-rewind-preview"><Pill tone={rewindPreview.safety === "blocked" ? "danger" : rewindPreview.safety === "requiresConfirmation" ? "warning" : "success"}>{rewindPreview.safety}</Pill><p>{t("workspace.restoreCount", { count: rewindPreview.inversePaths.length })}</p>{rewindPreview.conflicts.length > 0 && <section><strong>{t("workspace.conflicts")}</strong><ul>{rewindPreview.conflicts.map((value) => <li key={value}>{value}</li>)}</ul></section>}{rewindPreview.gaps.length > 0 && <section><strong>{t("workspace.captureGaps")}</strong><ul>{rewindPreview.gaps.map((value) => <li key={value}>{value}</li>)}</ul></section>}{rewindPreview.dialogueOnlyAvailable && <label className="rewind-dialogue-only"><CheckboxControl checked={dialogueOnlyRewind} onChange={(event) => setDialogueOnlyRewind(event.target.checked)} /><span>{t("workspace.dialogueOnly")}</span></label>}<div className="modal__actions"><Button onClick={() => setRewindPreview(undefined)}>{t("common.cancel")}</Button><Button tone={dialogueOnlyRewind ? "secondary" : "danger"} disabled={rewindPreview.safety === "blocked" && !dialogueOnlyRewind} onClick={() => { const preview = rewindPreview; setRewindPreview(undefined); runAction(`rewind:${preview.changeSetId}`, () => controller.executeWorkspaceRewind(workspace?.id ?? "", preview.id, preview.changeSetId, dialogueOnlyRewind)); }}>{dialogueOnlyRewind ? t("workspace.rewindDialogue") : t("workspace.restoreFiles")}</Button></div></div>}
      </Modal>
    </main>
  );
}

async function restoreEditedMessageDraft(
  controller: AppController,
  sessionId: string,
  draft: Parameters<AppController["saveDraft"]>[1],
  t: Translator
): Promise<void> {
  try {
    await controller.saveDraft(sessionId, draft);
  } catch (cause) {
    throw new Error(t("timeline.editDraftRestoreFailed"), { cause });
  }
}

function CompactActionFeedback({ feedback, t, onDismiss }: {
  readonly feedback: CompactRequestFeedback;
  readonly t: Translator;
  readonly onDismiss: () => void;
}): JSX.Element {
  const message = feedback.phase === "busy"
    ? t("session.compactFeedbackBusy")
    : feedback.phase === "compacted"
      ? t("session.compactFeedbackCompacted")
      : feedback.phase === "noop"
        ? t("session.compactFeedbackNoOp")
        : t("session.compactFeedbackFailed");
  const icon = feedback.phase === "busy"
    ? <LoaderCircle aria-hidden="true" />
    : feedback.phase === "failure"
      ? <AlertTriangle aria-hidden="true" />
      : feedback.phase === "noop"
        ? <Gauge aria-hidden="true" />
        : <Sparkles aria-hidden="true" />;
  return (
    <div className="compact-feedback-region">
      <div
        className={cx("compact-action-feedback", `compact-action-feedback--${feedback.phase}`)}
        role={feedback.phase === "failure" ? "alert" : "status"}
        aria-live={feedback.phase === "failure" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {icon}
        <span>{message}</span>
        {feedback.phase !== "busy" && <Button tone="ghost" onClick={onDismiss}>{t("common.dismiss")}</Button>}
      </div>
    </div>
  );
}

export function ExtensionStatuses({ statuses }: { readonly statuses: readonly ExtensionStatusView[] }): JSX.Element | null {
  if (statuses.length === 0) return null;
  return (
    <div className="extension-statuses" role="status" aria-live="polite" aria-atomic="true">
      {statuses.map((status) => {
        const text = sanitizeExtensionStatusText(status.text);
        return (
          <span className="extension-status" key={status.key} data-status-key={status.key} title={text}>
            <span aria-hidden="true" className="extension-status__dot" />
            {text}
          </span>
        );
      })}
    </div>
  );
}

export function ExtensionWidgets({ widgets, label }: { readonly widgets: readonly ExtensionWidgetView[]; readonly label: string }): JSX.Element | null {
  if (widgets.length === 0) return null;
  const maximumVisibleLines = 10;
  return (
    <aside className="extension-widgets" aria-label={label} aria-live="polite">
      {widgets.map((widget) => (
        <section className="extension-widget" key={widget.key} data-widget-key={widget.key} aria-label={widget.key}>
          <div className="extension-widget__content">
            {widget.lines.slice(0, maximumVisibleLines).map((line, index) => <div key={`${widget.key}:${index}`}>{line || "\u00a0"}</div>)}
            {widget.lines.length > maximumVisibleLines && <div className="extension-widget__truncated">... (widget truncated)</div>}
          </div>
        </section>
      ))}
    </aside>
  );
}

function permissionModesForShortcut(backend: BackendView | undefined, target: TargetView | undefined, projectTrustRequired: boolean): readonly PermissionMode[] {
  const modes = advertisedPermissionModes(backend);
  return projectTrustRequired && target?.trusted !== true ? modes.filter((mode) => mode !== "bypassPermissions") : modes;
}

function canRewindFromTimeline(backend: BackendView | undefined, workspace: WorkspaceView | undefined): boolean {
  return workspace !== undefined && backend?.capabilities.get("workspace.rewind")?.supported === true;
}

export function canOpenGeneratedFiles(
  backend: Pick<BackendView, "capabilities"> | undefined,
  workspace: Pick<WorkspaceView, "id"> | undefined
): boolean {
  return workspace !== undefined && backend?.capabilities.get("workspace.generated_files")?.supported === true;
}

export function canOpenExactTurnReview(
  backend: Pick<BackendView, "capabilities"> | undefined,
  workspace: Pick<WorkspaceView, "id"> | undefined,
  reviewReadOnly: boolean
): boolean {
  return !reviewReadOnly && workspace !== undefined && backend?.capabilities.get("workspace.diff.sources")?.supported === true;
}

/** Chat remains the active task while embedded in Files mode. */
export function sessionRouteIsCurrent(route: AppRoute, sessionId: string): boolean {
  if (route.kind === "files") return route.sessionId === sessionId;
  return route.kind === "session" && (route.sessionId === undefined || route.sessionId === sessionId);
}

export function latestDerivationSourceMessage(
  items: readonly TimelineItemView[]
): { readonly messageId: string; readonly eventId: string } | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item !== undefined
      && (item.kind === "user" || item.kind === "assistant")
      && item.streaming !== true
      && item.sourceEventId !== undefined
    ) {
      return { messageId: item.messageId ?? item.id, eventId: item.sourceEventId };
    }
  }
  return undefined;
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']") !== null);
}

function sessionStateLabel(state: SessionView["state"], t: Translator): string {
  if (state === "running") return t("session.running");
  if (state === "waiting") return t("session.waiting");
  if (state === "retrying") return t("session.running");
  if (state === "error") return t("session.error");
  if (state === "closed") return t("session.closed");
  return t("session.idle");
}

function retryEscapeTarget(target: EventTarget | null): RetryEscapeTarget {
  if (!(target instanceof Element)) return "other";
  // Composer owns its richer Escape stack (palette/queue/stop/shell) even when
  // focus is on one of its buttons rather than the editor itself.
  if (target.closest(".composer-stack") !== null) return "composer";
  if (
    target.closest("details[open], [aria-expanded='true']") !== null ||
    Boolean(target.closest(".pinned-plan-card")?.querySelector("[aria-expanded='true']"))
  ) return "disclosure";
  if (
    target.matches("textarea, input, select, [contenteditable='true'], [role='textbox']") ||
    target.closest("[contenteditable='true'], [role='textbox']") !== null
  ) return "editable";
  return "other";
}

function shortId(value: string): string {
  return value.length > 9 ? `${value.slice(0, 7)}…` : value;
}

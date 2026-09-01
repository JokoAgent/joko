import { createContext, isValidElement, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, CSSProperties, JSX, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  ArrowRight,
  Box,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDotDashed,
  Clipboard,
  Download,
  Ellipsis,
  FileDiff,
  FileOutput,
  FileText,
  GitFork,
  Image as ImageIcon,
  ImageOff,
  Images,
  Link2,
  ListChecks,
  MessageSquarePlus,
  Globe2,
  PanelRight,
  Pencil,
  RotateCcw,
  RefreshCw,
  Share,
  Sparkles,
  Terminal,
  Timer,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import type { MessageKey } from "../i18n.js";
import type { ComposerSelectionQuoteDraft, ErrorRecoveryActionView, ErrorView, SessionView, SubagentRunDetailView, SubagentRunView, TimelineItemView } from "../model.js";
import { sessionMessageDeepLink } from "../message-reference.js";
import { parseSelectionQuoteMessage, visibleSelectionQuoteMessageText } from "../selection-quote.js";
import { executableRecoveryActions, type RecoveryActionContext } from "./coding-ui-behavior.js";
import { InlinePlanCard } from "./InlinePlanCard.js";
import { GeneratedFilesCard } from "./GeneratedFilesCard.js";
import { assistantForkBlockedMessageIds, finalAssistantMessageIds, resolveMessageDeleteTarget, resolveMessageForkTarget } from "./message-actions.js";
import { SelectionQuoteButton } from "./SelectionQuoteButton.js";
import { SelectionQuoteChip } from "./SelectionQuoteChip.js";
import { SentPastedTextInline } from "./SentPastedTextInline.js";
import { buildSentPastedTextMessageSegments, projectSentPastedTextMessageBody } from "./sent-pasted-text.js";
import { messageDialogueRewindTarget } from "./message-rewind-behavior.js";
import { ShareMessageImageEmptyError, ShareMessageImageTooLargeError, buildShareMessageImagePng, deliverShareMessageImage, shareMessageImageFilename } from "./share-message-image.js";
import { projectInlinePlanTimeline, projectPinnedPlan } from "./pinned-plan-behavior.js";
import { collectTimelineGalleryImages, moveTimelineGalleryIndex, timelineArtifactGalleryId, timelineMessageAttachmentGalleryId, type TimelineGalleryImage } from "./timeline-image-gallery.js";
import { findTimelineRenderItemIndex, insertTimelineDerivationOrigin, projectTimelineRenderItems, timelineRenderChildIndex, type TimelineRenderItem, type TimelineWorkRenderItem } from "./timeline-render-items.js";
import { TimelineViewportStore, countUnreadTimelineItems, maximumTimelineSequence, repairStreamingMarkdown, resolveTimelineFollowingOnScroll, resolveTimelineResizeScrollTop, shouldLoadEarlierTimeline, streamingMarkdownRenderValue, streamingMarkdownThrottleDelay, timelineJumpBehavior, type TimelineViewportState } from "./timeline-behavior.js";
import type { Translator } from "./types.js";
import { Button, IconButton, Pill, Spinner, Tip, TipSummary, cx, formatBytes, formatDateTime } from "./ui.js";
import { UserMessageEditBox } from "./UserMessageEditBox.js";
import { AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD, mayExceedUserMessageLineThreshold, useUserMessageAutoCollapse } from "./user-message-collapse.js";
import { MessageNavRail } from "./MessageNavRail.js";
import { PrevMessageJumpChip } from "./PrevMessageJumpChip.js";
import { MessageUsageMeta } from "./MessageUsageMeta.js";
import { SubagentInlineCard } from "./SubagentInlineCard.js";
import { deriveMessageNavEntries } from "./message-nav-rail.js";
import { usePreviousUserMessageJump } from "./use-prev-message-jump.js";
import { consumeMessageNavBackfillRound, resetMessageNavBackfillBudget, scheduleMessageNavBackfill, shouldBackfillMessageNav, type MessageNavBackfillBudget } from "./message-nav-backfill.js";
import { TimelineCopyAsImageBlock, timelineMathToLatex, timelineTableToTsv } from "./TimelineCopyAsImageBlock.js";
import { TimelineCodeBlock } from "./TimelineCodeBlock.js";
import { TimelineMermaidBlock } from "./TimelineMermaidBlock.js";
import { TimelineTextAttachmentLightbox } from "./TimelineTextAttachmentLightbox.js";
import { timelineArtifactSupportsTextPreview } from "./timeline-text-attachment.js";
import { TimelineArtifactMedia, timelineArtifactMediaKind } from "./TimelineArtifactMedia.js";
import { useTimelineArtifactUrlCache } from "./timeline-artifact-url-cache.js";
import { timelineErrorCopy } from "../timeline-error-copy.js";
import {
  TIMELINE_HISTORY_NAVIGATION_KEYS,
  TIMELINE_TOUCH_UP_INTENT_THRESHOLD_PX,
  hasNestedTimelineScrollerThatCanMoveUp,
  isEditableTimelineKeyboardTarget,
  shouldUnpinTimelineOnUpIntent,
  shouldUnpinTimelineOnWheel
} from "./timeline-follow-intent.js";
import { ToolPayloadLightbox, ToolPayloadOpenButton } from "./ToolPayloadLightbox.js";
import { WorkspaceImageLightbox } from "./WorkspaceImageLightbox.js";
import type { ToolPayloadSection } from "./tool-payload.js";
import { SentMessageReferenceText, TimelineMarkdownImage, TimelineMarkdownLink, type TimelineReferenceActions, type TimelineWorkspaceAsset } from "./TimelineReferenceContent.js";
import { normalizeTimelineMathDelimiters, remarkStrictTimelineInlineMath } from "./timeline-markdown-math.js";
import {
  commitTimelineWordFadeCandidate,
  createTimelineWordFadeCandidate,
  markTimelineWordFadeSettled,
  rehypeTimelineStreamFade,
  releaseTimelineWordFadeState,
  timelineStreamFadeActive,
  timelineWordFadeState
} from "./timeline-stream-fade.js";
import "./Timeline.stream-fade.css";

const timelineViewports = new TimelineViewportStore();
const workGroupExpansion = new Map<string, boolean>();
const TIMELINE_REMARK_PLUGINS: NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]> = [
  [remarkGfm, { singleTilde: false }],
  remarkCjkFriendly,
  remarkMath,
  remarkStrictTimelineInlineMath
];
const TIMELINE_REHYPE_PLUGINS: NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]> = [
  [rehypeKatex, { strict: "ignore", errorColor: "inherit" }]
];

interface TimelineImageGalleryContextValue {
  readonly open: (imageId: string, trigger: HTMLElement) => void;
}

const TimelineImageGalleryContext = createContext<TimelineImageGalleryContextValue | undefined>(undefined);

interface TimelineSubagentContextValue {
  readonly runs: ReadonlyMap<string, SubagentRunView>;
  readonly details: ReadonlyMap<string, SubagentRunDetailView>;
  readonly onOpen?: (runId: string) => void;
  readonly onStop?: (runId: string) => Promise<void>;
}

const TimelineSubagentContext = createContext<TimelineSubagentContextValue>({ runs: new Map(), details: new Map() });

interface TimelinePersonalizationContextValue {
  readonly streamFadeEnabled: boolean;
  readonly reducedMotion: boolean;
  readonly sessionId: string;
  readonly onOpenHttpLink?: (url: string, options?: { readonly forceExternal?: boolean; readonly forceSidebar?: boolean }) => void;
  readonly onLoadWorkspaceAsset?: (path: string) => Promise<TimelineWorkspaceAsset>;
  readonly onWorkspaceImageToComposer?: (file: File) => void | Promise<void>;
}

const TimelinePersonalizationContext = createContext<TimelinePersonalizationContextValue>({
  streamFadeEnabled: true,
  reducedMotion: false,
  sessionId: ""
});

export interface InlinePlanVisibility {
  readonly key: string;
  readonly visible: boolean;
}

export interface TimelineShareSelection {
  readonly selectedIds: ReadonlySet<string>;
}

export function Timeline({ sessionId, sessionName, items, sessionActive, derivationOrigin, sessionCreatedAt, onOpenDerivationOrigin, messageNavRailEnabled, streamFadeEnabled, onOpenHttpLink, onLoadWorkspaceAsset, onWorkspaceImageToComposer, subagentRuns, subagentRunDetails, onOpenSubagent, onStopSubagent, hasEarlier, historyLoading, historyError, onLoadEarlier, followLatestSignal = 0, focusRequest, bottomInset = 0, retryRunId, locale, t, onRetry, onRecovery, recoveryContext, onArtifactUrl, onArtifactUrlRelease, onArtifactDownload, onWorkspaceRewind, onOpenGeneratedFile, onOpenTurnReview, onReobserveReview, onAddMessageToComposer, onAddSelectionToComposer, onForkMessage, forkingMessageId, shareSelection, onStartShareSelection, onToggleShareMessage, editableMessageId, onMoveEditedMessageToComposer, onPreviewMessageRewind, onDeleteMessage, messageDeleteBlockedReason, messageActionResetSignal, onInlinePlanVisibilityChange }: {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly items: readonly TimelineItemView[];
  readonly sessionActive: boolean;
  readonly derivationOrigin?: NonNullable<SessionView["derivationOrigin"]>;
  readonly sessionCreatedAt?: number;
  readonly onOpenDerivationOrigin?: () => void;
  readonly messageNavRailEnabled: boolean;
  readonly streamFadeEnabled: boolean;
  readonly onOpenHttpLink?: (url: string, options?: { readonly forceExternal?: boolean; readonly forceSidebar?: boolean }) => void;
  readonly onLoadWorkspaceAsset?: (path: string) => Promise<TimelineWorkspaceAsset>;
  readonly onWorkspaceImageToComposer?: (file: File) => void | Promise<void>;
  readonly subagentRuns?: ReadonlyMap<string, SubagentRunView>;
  readonly subagentRunDetails?: ReadonlyMap<string, SubagentRunDetailView>;
  readonly onOpenSubagent?: (runId: string) => void;
  readonly onStopSubagent?: (runId: string) => Promise<void>;
  readonly hasEarlier: boolean;
  readonly historyLoading: boolean;
  readonly historyError?: string;
  readonly onLoadEarlier: () => Promise<void>;
  readonly followLatestSignal?: number;
  readonly focusRequest?: { readonly itemId: string; readonly requestId: number };
  readonly bottomInset?: number;
  readonly retryRunId?: string;
  readonly locale: string;
  readonly t: Translator;
  readonly onRetry?: (error: ErrorView) => void;
  readonly onRecovery?: (error: ErrorView, action: ErrorRecoveryActionView) => void;
  readonly recoveryContext?: RecoveryActionContext;
  readonly onArtifactUrl: (blobId: string) => Promise<string>;
  readonly onArtifactUrlRelease: (blobId: string) => void;
  readonly onArtifactDownload: (blobId: string, fileName: string) => void;
  readonly onWorkspaceRewind?: (workspaceId: string, changeSetId: string) => void;
  readonly onOpenGeneratedFile?: (workspaceId: string, relativePath: string) => void;
  readonly onOpenTurnReview?: (changeSetId: string, relativePath?: string) => void;
  readonly onReobserveReview?: (reviewRunId: string) => Promise<void>;
  readonly onAddMessageToComposer?: (item: TimelineItemView) => void;
  readonly onAddSelectionToComposer?: (quote: ComposerSelectionQuoteDraft) => void;
  readonly onForkMessage?: (item: TimelineItemView) => void;
  readonly forkingMessageId?: string;
  readonly shareSelection?: TimelineShareSelection;
  readonly onStartShareSelection?: (item: TimelineItemView) => void;
  readonly onToggleShareMessage?: (itemId: string, extendRange: boolean) => void;
  readonly editableMessageId?: string;
  readonly onMoveEditedMessageToComposer?: (item: TimelineItemView, text: string) => Promise<void>;
  readonly onPreviewMessageRewind?: (item: TimelineItemView) => void;
  readonly onDeleteMessage?: (item: TimelineItemView) => void;
  readonly messageDeleteBlockedReason?: string;
  readonly messageActionResetSignal?: number;
  readonly onInlinePlanVisibilityChange?: (visibility: InlinePlanVisibility | null) => void;
}): JSX.Element {
  const planTimelineItems = useMemo(() => projectInlinePlanTimeline(items), [items]);
  const currentPlan = useMemo(() => projectPinnedPlan(items), [items]);
  const renderItems = useMemo(
    () => insertTimelineDerivationOrigin(
      projectTimelineRenderItems(planTimelineItems, { sessionActive }),
      derivationOrigin,
      sessionCreatedAt
    ),
    [derivationOrigin, planTimelineItems, sessionActive, sessionCreatedAt]
  );
  const renderIndexByChildId = useMemo(() => timelineRenderChildIndex(renderItems), [renderItems]);
  const assistantMessageActions = useMemo(() => finalAssistantMessageIds(items), [items]);
  const blockedAssistantForks = useMemo(() => assistantForkBlockedMessageIds(items, sessionActive), [items, sessionActive]);
  const galleryImages = useMemo(() => collectTimelineGalleryImages(items), [items]);
  const messageNavEntries = useMemo(() => deriveMessageNavEntries(items), [items]);
  const userMessageIds = useMemo(() => messageNavEntries.map((entry) => entry.id), [messageNavEntries]);
  const messageNavBackfillBudgetRef = useRef<MessageNavBackfillBudget>({ sessionId, rounds: 0 });
  messageNavBackfillBudgetRef.current = resetMessageNavBackfillBudget(messageNavBackfillBudgetRef.current, sessionId);
  const [openGallery, setOpenGallery] = useState<{ readonly imageId: string; readonly trigger: HTMLElement }>();
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const [messageNavRailCoversNavigation, setMessageNavRailCoversNavigation] = useState(false);
  useEffect(() => setEditingMessageId(undefined), [messageActionResetSignal, sessionId]);
  useEffect(() => { if (!messageNavRailEnabled) setMessageNavRailCoversNavigation(false); }, [messageNavRailEnabled]);
  const loadArtifactUrl = useTimelineArtifactUrlCache(sessionId, onArtifactUrl, onArtifactUrlRelease);
  const openGalleryImage = useCallback((imageId: string, trigger: HTMLElement): void => {
    // Modal and lightbox surfaces are mutually exclusive. The lightbox owns the
    // same shortcut/scroll lock while open, so a hidden dialog cannot stack.
    if (document.body.classList.contains("modal-open")) return;
    setOpenGallery({ imageId, trigger });
  }, []);
  const galleryContext = useMemo<TimelineImageGalleryContextValue>(() => ({ open: openGalleryImage }), [openGalleryImage]);
  const restoredViewportRef = useRef<TimelineViewportState | undefined>(undefined);
  if (restoredViewportRef.current === undefined) restoredViewportRef.current = timelineViewports.restore(sessionId, items);
  const restoredViewport = restoredViewportRef.current;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousMessageJump = usePreviousUserMessageJump({ scrollRef, userMessageIds, resetKey: sessionId });
  const [following, setFollowing] = useState(restoredViewport.following);
  const [unreadCount, setUnreadCount] = useState(restoredViewport.unreadCount);
  const [focusedItemId, setFocusedItemId] = useState<string>();
  const [nearHistoryStart, setNearHistoryStart] = useState(true);
  const followingRef = useRef(restoredViewport.following);
  const unreadCountRef = useRef(restoredViewport.unreadCount);
  const knownItemIdsRef = useRef<ReadonlySet<string>>(restoredViewport.knownItemIds);
  const maximumSequenceRef = useRef<bigint | undefined>(restoredViewport.maximumSequence);
  const viewportAnchorRef = useRef<{ readonly itemId: string; readonly offset: number } | undefined>(restoredViewport.anchorItemId === undefined ? undefined : { itemId: restoredViewport.anchorItemId, offset: restoredViewport.anchorOffset });
  const restoreAnchorRef = useRef<{ readonly itemId: string; readonly offset: number } | undefined>(restoredViewport.following || restoredViewport.anchorItemId === undefined ? undefined : { itemId: restoredViewport.anchorItemId, offset: restoredViewport.anchorOffset });
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const followLatestSignalRef = useRef(followLatestSignal);
  const previousScrollTopRef = useRef(0);
  const programmaticScrollUntilRef = useRef(0);
  const touchYRef = useRef<number | undefined>(undefined);
  const handledFocusRequestRef = useRef<number | undefined>(undefined);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loadEarlierInFlightRef = useRef(false);
  const reducedMotion = usePrefersReducedMotion();
  const personalizationContext = useMemo<TimelinePersonalizationContextValue>(() => ({
    streamFadeEnabled,
    reducedMotion,
    sessionId,
    ...(onOpenHttpLink === undefined ? {} : { onOpenHttpLink }),
    ...(onLoadWorkspaceAsset === undefined ? {} : { onLoadWorkspaceAsset }),
    ...(onWorkspaceImageToComposer === undefined ? {} : { onWorkspaceImageToComposer })
  }), [onLoadWorkspaceAsset, onOpenHttpLink, onWorkspaceImageToComposer, reducedMotion, sessionId, streamFadeEnabled]);
  const subagentContext = useMemo<TimelineSubagentContextValue>(() => ({
    runs: subagentRuns ?? new Map(),
    details: subagentRunDetails ?? new Map(),
    ...(onOpenSubagent === undefined ? {} : { onOpen: onOpenSubagent }),
    ...(onStopSubagent === undefined ? {} : { onStop: onStopSubagent })
  }), [onOpenSubagent, onStopSubagent, subagentRunDetails, subagentRuns]);
  const virtualizer = useVirtualizer({
    count: renderItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateRenderHeight(renderItems[index]),
    overscan: 8,
    getItemKey: (index) => renderItems[index]?.key ?? index
  });
  const lastItem = items.at(-1);
  const virtualRows = virtualizer.getVirtualItems();
  const renderedRowsKey = virtualRows.map((row) => row.key).join("\u0000");
  const estimateMessageNavEntryTop = useCallback((itemId: string, contentTop: number): number | null => {
    const renderIndex = renderIndexByChildId.get(itemId);
    if (renderIndex === undefined) return null;
    const measurement = virtualizer.measurementsCache[renderIndex];
    return measurement === undefined ? null : contentTop + measurement.start;
  }, [renderIndexByChildId, virtualizer]);

  useLayoutEffect(() => {
    if (onInlinePlanVisibilityChange === undefined) return;
    if (currentPlan === undefined) {
      onInlinePlanVisibilityChange(null);
      return;
    }
    const inline = planTimelineItems.find((item) => item.inlinePlan?.sourceItemIds.includes(currentPlan.sourceItemId) === true)?.inlinePlan;
    const root = scrollRef.current;
    const card = root === null || inline === undefined
      ? undefined
      : [...root.querySelectorAll<HTMLElement>("[data-inline-plan-key]")]
        .find((candidate) => candidate.dataset.inlinePlanKey === inline.identity);
    if (root === null || card === undefined) {
      onInlinePlanVisibilityChange({ key: currentPlan.identity, visible: false });
      return;
    }

    const reportVisibility = (): void => {
      const cardRect = card.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      onInlinePlanVisibilityChange({
        key: currentPlan.identity,
        visible: cardRect.bottom > rootRect.top && cardRect.top < rootRect.bottom && cardRect.right > rootRect.left && cardRect.left < rootRect.right
      });
    };
    reportVisibility();

    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver(reportVisibility, { root, threshold: 0 });
      observer.observe(card);
      return () => observer.disconnect();
    }

    root.addEventListener("scroll", reportVisibility, { passive: true });
    window.addEventListener("resize", reportVisibility);
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(reportVisibility);
    resizeObserver?.observe(root);
    resizeObserver?.observe(card);
    return () => {
      root.removeEventListener("scroll", reportVisibility);
      window.removeEventListener("resize", reportVisibility);
      resizeObserver?.disconnect();
    };
  }, [currentPlan?.identity, currentPlan?.sourceItemId, onInlinePlanVisibilityChange, planTimelineItems, renderedRowsKey]);

  useEffect(() => {
    setOpenGallery(undefined);
    setEditingMessageId(undefined);
  }, [sessionId]);

  useEffect(() => {
    if (shareSelection !== undefined) {
      setEditingMessageId(undefined);
      return;
    }
    if (editingMessageId !== undefined && !items.some((item) => item.id === editingMessageId)) setEditingMessageId(undefined);
  }, [editingMessageId, items, shareSelection]);

  useEffect(() => {
    if (openGallery === undefined || galleryImages.some((image) => image.id === openGallery.imageId)) return;
    setOpenGallery(undefined);
  }, [galleryImages, openGallery]);

  const captureViewportAnchor = useCallback((): void => {
    const node = scrollRef.current;
    if (node === null) return;
    const viewportTop = node.getBoundingClientRect().top;
    const rows = node.querySelectorAll<HTMLElement>("[data-timeline-item-id]");
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= viewportTop + 0.5) continue;
      const itemId = row.dataset.timelineItemId;
      if (itemId !== undefined) viewportAnchorRef.current = { itemId, offset: rect.top - viewportTop };
      return;
    }
  }, []);

  const requestEarlier = useCallback((): boolean => {
    if (!hasEarlier || historyLoading || loadEarlierInFlightRef.current) return false;
    captureViewportAnchor();
    if (!followingRef.current && viewportAnchorRef.current !== undefined) {
      restoreAnchorRef.current = viewportAnchorRef.current;
    }
    loadEarlierInFlightRef.current = true;
    void onLoadEarlier().catch(() => {
      // The owning shell renders the durable history error and retry action.
    }).finally(() => {
      loadEarlierInFlightRef.current = false;
    });
    return true;
  }, [captureViewportAnchor, hasEarlier, historyLoading, onLoadEarlier]);

  useEffect(() => {
    const budget = messageNavBackfillBudgetRef.current;
    if (!shouldBackfillMessageNav({
      enabled: messageNavRailEnabled,
      entryCount: messageNavEntries.length,
      hasEarlier,
      historyLoading,
      ...(historyError === undefined ? {} : { historyError }),
      rounds: budget.rounds
    })) return;

    const scheduledSessionId = sessionId;
    return scheduleMessageNavBackfill(() => {
      const currentBudget = messageNavBackfillBudgetRef.current;
      if (currentBudget.sessionId !== scheduledSessionId) return;
      if (requestEarlier()) {
        messageNavBackfillBudgetRef.current = consumeMessageNavBackfillRound(currentBudget);
      }
    });
  }, [hasEarlier, historyError, historyLoading, messageNavEntries.length, messageNavRailEnabled, requestEarlier, sessionId]);

  const saveViewport = useCallback((nextFollowing = followingRef.current, nextUnreadCount = unreadCountRef.current): void => {
    const currentItems = itemsRef.current;
    const added = countUnreadTimelineItems(knownItemIdsRef.current, maximumSequenceRef.current, currentItems, nextFollowing);
    knownItemIdsRef.current = new Set(currentItems.map((item) => item.id));
    const currentMaximum = maximumTimelineSequence(currentItems);
    if (currentMaximum !== undefined && (maximumSequenceRef.current === undefined || currentMaximum > maximumSequenceRef.current)) maximumSequenceRef.current = currentMaximum;
    const reconciledUnreadCount = nextFollowing ? 0 : nextUnreadCount + added;
    unreadCountRef.current = reconciledUnreadCount;
    const anchor = restoreAnchorRef.current ?? viewportAnchorRef.current;
    timelineViewports.save(sessionId, {
      ...(anchor === undefined ? {} : { anchorItemId: anchor.itemId }),
      anchorOffset: anchor?.offset ?? 0,
      following: nextFollowing,
      unreadCount: reconciledUnreadCount
    }, currentItems);
  }, [sessionId]);

  const writeScrollTop = useCallback((top: number, behavior: ScrollBehavior = "auto"): void => {
    const node = scrollRef.current;
    if (node === null) return;
    programmaticScrollUntilRef.current = performance.now() + (behavior === "smooth" ? 500 : 50);
    node.scrollTo({ top, behavior });
    previousScrollTopRef.current = node.scrollTop;
    requestAnimationFrame(captureViewportAnchor);
  }, [captureViewportAnchor]);

  const setTimelineFollowing = useCallback((next: boolean): void => {
    followingRef.current = next;
    setFollowing(next);
    if (next) {
      unreadCountRef.current = 0;
      setUnreadCount(0);
    }
    saveViewport(next, next ? 0 : unreadCountRef.current);
  }, [saveViewport]);

  const jumpToMessageNavEntry = useCallback((itemId: string): void => {
    const node = scrollRef.current;
    if (node === null) return;
    const index = findTimelineRenderItemIndex(renderItems, itemId);
    if (index < 0) return;
    restoreAnchorRef.current = undefined;
    setTimelineFollowing(false);
    programmaticScrollUntilRef.current = performance.now() + 650;
    virtualizer.scrollToIndex(index, { align: "start" });
    let attempts = 0;
    const align = (): void => {
      const current = scrollRef.current;
      if (current === null) return;
      const anchor = [...current.querySelectorAll<HTMLElement>("[data-message-client-id]")]
        .find((candidate) => candidate.dataset.messageClientId === itemId);
      if (anchor === undefined && attempts < 2) {
        attempts += 1;
        requestAnimationFrame(align);
        return;
      }
      if (anchor === undefined) return;
      const nextScrollTop = Math.max(0, current.scrollTop + anchor.getBoundingClientRect().top - current.getBoundingClientRect().top - 12);
      writeScrollTop(nextScrollTop, timelineJumpBehavior(reducedMotion));
      viewportAnchorRef.current = { itemId, offset: 12 };
    };
    requestAnimationFrame(align);
  }, [reducedMotion, renderItems, setTimelineFollowing, virtualizer, writeScrollTop]);
  const previousMessageEntry = previousMessageJump.displayId === null
    ? undefined
    : messageNavEntries.find((entry) => entry.id === previousMessageJump.displayId);
  const jumpToPreviousMessage = useCallback((): void => {
    const id = previousMessageJump.displayId;
    if (id === null) return;
    previousMessageJump.suppressAfterClick();
    jumpToMessageNavEntry(id);
  }, [jumpToMessageNavEntry, previousMessageJump.displayId, previousMessageJump.suppressAfterClick]);

  const pinToLatest = useCallback((behavior: ScrollBehavior = "auto"): void => {
    const node = scrollRef.current;
    if (node === null) return;
    writeScrollTop(resolveTimelineResizeScrollTop({
      following: true,
      currentScrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      anchorOffsetDelta: 0
    }), behavior);
  }, [writeScrollTop]);

  useLayoutEffect(() => {
    if (!following || items.length === 0) return;
    pinToLatest();
  }, [following, items.length, lastItem?.id, pinToLatest]);

  useLayoutEffect(() => {
    if (followLatestSignalRef.current === followLatestSignal) return;
    followLatestSignalRef.current = followLatestSignal;
    restoreAnchorRef.current = undefined;
    setTimelineFollowing(true);
    if (items.length > 0) pinToLatest();
  }, [followLatestSignal, items.length, pinToLatest, setTimelineFollowing]);

  useEffect(() => {
    saveViewport(followingRef.current, unreadCountRef.current);
    setUnreadCount(unreadCountRef.current);
  }, [items, saveViewport]);

  useLayoutEffect(() => {
    const desired = restoreAnchorRef.current;
    const node = scrollRef.current;
    if (desired === undefined || node === null || items.length === 0) return;
    const index = findTimelineRenderItemIndex(renderItems, desired.itemId);
    if (index < 0) {
      restoreAnchorRef.current = undefined;
      return;
    }
    const row = [...node.querySelectorAll<HTMLElement>("[data-timeline-item-id]")].find((candidate) => timelineRowContains(candidate, desired.itemId));
    if (row === undefined) {
      programmaticScrollUntilRef.current = performance.now() + 100;
      virtualizer.scrollToIndex(index, { align: "start" });
      return;
    }
    const currentOffset = row.getBoundingClientRect().top - node.getBoundingClientRect().top;
    const nextScrollTop = Math.max(0, node.scrollTop + currentOffset - desired.offset);
    restoreAnchorRef.current = undefined;
    viewportAnchorRef.current = desired;
    if (Math.abs(nextScrollTop - node.scrollTop) >= 0.5) writeScrollTop(nextScrollTop);
    else captureViewportAnchor();
  }, [captureViewportAnchor, items, renderItems, renderedRowsKey, virtualizer, writeScrollTop]);

  useLayoutEffect(() => {
    if (focusRequest === undefined || handledFocusRequestRef.current === focusRequest.requestId) return;
    const index = findTimelineRenderItemIndex(renderItems, focusRequest.itemId);
    if (index < 0) return;
    const node = scrollRef.current;
    if (node === null) return;
    const row = [...node.querySelectorAll<HTMLElement>("[data-timeline-item-id]")]
      .find((candidate) => timelineRowContains(candidate, focusRequest.itemId));
    if (row === undefined) {
      programmaticScrollUntilRef.current = performance.now() + 100;
      virtualizer.scrollToIndex(index, { align: "center" });
      return;
    }
    handledFocusRequestRef.current = focusRequest.requestId;
    restoreAnchorRef.current = undefined;
    setTimelineFollowing(false);
    const rowRect = row.getBoundingClientRect();
    const viewportRect = node.getBoundingClientRect();
    const nextScrollTop = Math.max(
      0,
      node.scrollTop + rowRect.top - viewportRect.top - Math.max(0, (node.clientHeight - rowRect.height) / 2)
    );
    writeScrollTop(nextScrollTop, timelineJumpBehavior(reducedMotion));
    viewportAnchorRef.current = { itemId: focusRequest.itemId, offset: rowRect.top - viewportRect.top };
    setFocusedItemId(focusRequest.itemId);
    row.focus({ preventScroll: true });
    if (focusTimerRef.current !== undefined) clearTimeout(focusTimerRef.current);
    focusTimerRef.current = setTimeout(() => {
      focusTimerRef.current = undefined;
      setFocusedItemId((current) => current === focusRequest.itemId ? undefined : current);
    }, 2_400);
  }, [focusRequest, items, reducedMotion, renderItems, renderedRowsKey, setTimelineFollowing, virtualizer, writeScrollTop]);

  useEffect(() => {
    const content = contentRef.current;
    if (content === null || typeof ResizeObserver === "undefined") return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const node = scrollRef.current;
        if (node === null) return;
        const anchor = viewportAnchorRef.current;
        let anchorOffsetDelta = 0;
        if (!followingRef.current && anchor !== undefined) {
          const viewportTop = node.getBoundingClientRect().top;
          for (const row of node.querySelectorAll<HTMLElement>("[data-timeline-item-id]")) {
            if (row.dataset.timelineItemId !== anchor.itemId) continue;
            anchorOffsetDelta = row.getBoundingClientRect().top - viewportTop - anchor.offset;
            break;
          }
        }
        const nextScrollTop = resolveTimelineResizeScrollTop({
          following: followingRef.current,
          currentScrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          anchorOffsetDelta
        });
        if (Math.abs(nextScrollTop - node.scrollTop) >= 0.5) writeScrollTop(nextScrollTop);
        else {
          captureViewportAnchor();
          saveViewport();
        }
      });
    });
    observer.observe(content);
    for (const row of content.querySelectorAll<HTMLElement>("[data-timeline-item-id]")) observer.observe(row);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [captureViewportAnchor, renderedRowsKey, saveViewport, writeScrollTop]);

  useEffect(() => () => {
    captureViewportAnchor();
    saveViewport();
    if (focusTimerRef.current !== undefined) clearTimeout(focusTimerRef.current);
  }, [captureViewportAnchor, saveViewport]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node === null || historyError !== undefined) return;
    if (!shouldLoadEarlierTimeline({ scrollTop: node.scrollTop, hasEarlier, loading: historyLoading })) return;
    if (node.scrollHeight > node.clientHeight + 56) return;
    requestEarlier();
  }, [hasEarlier, historyError, historyLoading, items.length, requestEarlier]);

  useEffect(() => {
    if (!historyLoading && (historyError !== undefined || !hasEarlier)) restoreAnchorRef.current = undefined;
  }, [hasEarlier, historyError, historyLoading]);

  const onScroll = (): void => {
    const node = scrollRef.current;
    if (node === null) return;
    const currentScrollTop = node.scrollTop;
    const nextNearHistoryStart = currentScrollTop <= 56;
    setNearHistoryStart((current) => current === nextNearHistoryStart ? current : nextNearHistoryStart);
    const scrollDelta = currentScrollTop - previousScrollTopRef.current;
    previousScrollTopRef.current = currentScrollTop;
    if (performance.now() < programmaticScrollUntilRef.current) {
      captureViewportAnchor();
      saveViewport();
      return;
    }
    const nextFollowing = resolveTimelineFollowingOnScroll({
      wasFollowing: followingRef.current,
      distanceFromEnd: node.scrollHeight - currentScrollTop - node.clientHeight,
      scrollDelta
    });
    if (nextFollowing !== followingRef.current) setTimelineFollowing(nextFollowing);
    captureViewportAnchor();
    saveViewport(nextFollowing, nextFollowing ? 0 : unreadCountRef.current);
    if (historyError === undefined && shouldLoadEarlierTimeline({ scrollTop: currentScrollTop, hasEarlier, loading: historyLoading })) requestEarlier();
  };

  const stopFollowingForUpIntent = (node: HTMLElement): void => {
    if (followingRef.current && shouldUnpinTimelineOnUpIntent(node)) setTimelineFollowing(false);
  };

  const handleTimelineWheelIntent = (deltaY: number, deltaX = 0, target: EventTarget | null = null): void => {
    if (deltaY >= 0) return;
    const node = scrollRef.current;
    if (node === null || hasNestedTimelineScrollerThatCanMoveUp(node, target)) return;
    if (followingRef.current && shouldUnpinTimelineOnWheel({ deltaX, deltaY, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight })) setTimelineFollowing(false);
    if (historyError === undefined && shouldLoadEarlierTimeline({ scrollTop: node.scrollTop, hasEarlier, loading: historyLoading })) requestEarlier();
  };

  if (items.length === 0) {
    return (
      <div className="timeline-shell" style={{ "--timeline-bottom-inset": `${Math.max(0, bottomInset)}px` } as CSSProperties}>
        <div ref={scrollRef} className="timeline timeline--empty" data-selection-quote-context="" aria-busy={historyLoading || undefined} aria-label={t("timeline.label")} tabIndex={0}>
          {derivationOrigin !== undefined && <SessionDerivationMarker origin={derivationOrigin} onOpen={onOpenDerivationOrigin} t={t} />}
          <div className="timeline-welcome">
            <div className="timeline-welcome__mark">{historyError === undefined ? <Sparkles aria-hidden="true" /> : <AlertCircle aria-hidden="true" />}</div>
            {historyLoading ? (
              <><Spinner label={t("timeline.loadingEarlier")} /><h2>{t("timeline.loadingEarlier")}</h2></>
            ) : historyError !== undefined ? (
              <><h2>{t("timeline.historyUnavailable")}</h2><p>{historyError}</p><Button tone="secondary" onClick={requestEarlier}><RotateCcw aria-hidden="true" />{t("common.retry")}</Button></>
            ) : (
              <><h2>{t("session.noMessages")}</h2><p>{t("timeline.welcome")}</p>{hasEarlier && <Button tone="ghost" onClick={requestEarlier}>{t("timeline.loadEarlier")}</Button>}</>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <TimelineSubagentContext.Provider value={subagentContext}>
    <TimelineImageGalleryContext.Provider value={galleryContext}>
    <TimelinePersonalizationContext.Provider value={personalizationContext}>
    <div className="timeline-shell" style={{ "--timeline-bottom-inset": `${Math.max(0, bottomInset)}px` } as CSSProperties}>
      {(historyLoading || historyError !== undefined || nearHistoryStart && hasEarlier) && (
        <div className={cx("timeline-history", historyError !== undefined && "timeline-history--error")} role={historyError === undefined ? "status" : "alert"}>
          {historyLoading ? (
            <><Spinner label={t("timeline.loadingEarlier")} /><span>{t("timeline.loadingEarlier")}</span></>
          ) : historyError !== undefined ? (
            <><AlertCircle aria-hidden="true" /><span title={historyError}>{t("timeline.historyUnavailable")}</span><Button tone="ghost" onClick={requestEarlier}><RotateCcw aria-hidden="true" />{t("common.retry")}</Button></>
          ) : (
            <Button tone="ghost" onClick={requestEarlier}>{t("timeline.loadEarlier")}</Button>
          )}
        </div>
      )}
      <div
        ref={scrollRef}
        className="timeline"
        data-timeline-session-id={sessionId}
        data-selection-quote-context=""
        onScroll={onScroll}
        onWheel={(event) => handleTimelineWheelIntent(event.deltaY, event.deltaX, event.target)}
        onKeyDown={(event) => {
          if (event.defaultPrevented || !TIMELINE_HISTORY_NAVIGATION_KEYS.has(event.key) || isEditableTimelineKeyboardTarget(event.target)) return;
          stopFollowingForUpIntent(event.currentTarget);
          if (historyError === undefined && shouldLoadEarlierTimeline({ scrollTop: event.currentTarget.scrollTop, hasEarlier, loading: historyLoading })) requestEarlier();
        }}
        onTouchStart={(event) => { touchYRef.current = event.touches[0]?.clientY; }}
        onTouchMove={(event) => {
          const currentY = event.touches[0]?.clientY;
          if (currentY !== undefined && touchYRef.current !== undefined && currentY > touchYRef.current + TIMELINE_TOUCH_UP_INTENT_THRESHOLD_PX) {
            touchYRef.current = currentY;
            if (hasNestedTimelineScrollerThatCanMoveUp(event.currentTarget, event.target)) return;
            stopFollowingForUpIntent(event.currentTarget);
            if (historyError === undefined && shouldLoadEarlierTimeline({ scrollTop: event.currentTarget.scrollTop, hasEarlier, loading: historyLoading })) requestEarlier();
          }
        }}
        onTouchEnd={() => { touchYRef.current = undefined; }}
        onTouchCancel={() => { touchYRef.current = undefined; }}
        aria-label={t("timeline.label")}
        tabIndex={0}
      >
        <div ref={contentRef} className="timeline__virtual" style={{ height: `${virtualizer.getTotalSize() + Math.max(0, bottomInset)}px` }}>
          {virtualRows.map((virtualRow) => {
            const renderItem = renderItems[virtualRow.index];
            if (renderItem === undefined) return null;
            const focused = focusedItemId !== undefined && renderItem.childIds.includes(focusedItemId);
            return (
              <div
                key={renderItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                data-timeline-item-id={renderItem.key}
                data-timeline-item-ids={renderItem.childIds.join(" ")}
                className={cx("timeline__row", focused && "is-search-focus")}
                tabIndex={focused ? -1 : undefined}
                aria-current={focused ? "true" : undefined}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderItem.historyGapBefore !== undefined && <div className="timeline-history-gap" role="separator"><span>{t("timeline.historyGap")}</span></div>}
                {renderItem.type === "item"
                  ? <TimelineBlock sessionId={sessionId} sessionName={sessionName} item={renderItem.item} planAnimated={sessionActive} retryRunId={retryRunId} locale={locale} reducedMotion={reducedMotion} t={t} onRetry={onRetry} onRecovery={onRecovery} recoveryContext={recoveryContext} onArtifactUrl={loadArtifactUrl} onArtifactDownload={onArtifactDownload} onWorkspaceRewind={onWorkspaceRewind} onOpenGeneratedFile={onOpenGeneratedFile} onOpenTurnReview={onOpenTurnReview} onReobserveReview={onReobserveReview} onAddMessageToComposer={onAddMessageToComposer} onForkMessage={onForkMessage} forkingMessageId={forkingMessageId} shareSelection={shareSelection} onStartShareSelection={onStartShareSelection} onToggleShareMessage={onToggleShareMessage} editingMessageId={editingMessageId} editableMessageId={editableMessageId} onEditMessage={(item) => setEditingMessageId(item.id)} onCancelEditMessage={() => setEditingMessageId(undefined)} onMoveEditedMessageToComposer={onMoveEditedMessageToComposer === undefined ? undefined : async (item, text) => { await onMoveEditedMessageToComposer(item, text); setEditingMessageId(undefined); }} onPreviewMessageRewind={onPreviewMessageRewind} onDeleteMessage={onDeleteMessage} messageDeleteBlockedReason={messageDeleteBlockedReason} showMessageActions={renderItem.item.kind !== "assistant" || (assistantMessageActions.has(renderItem.item.id) && !blockedAssistantForks.has(renderItem.item.id))} />
                  : renderItem.type === "work"
                    ? <WorkGroupBlock sessionId={sessionId} sessionName={sessionName} work={renderItem} retryRunId={retryRunId} locale={locale} reducedMotion={reducedMotion} t={t} onRetry={onRetry} onRecovery={onRecovery} recoveryContext={recoveryContext} onArtifactUrl={loadArtifactUrl} onArtifactDownload={onArtifactDownload} onWorkspaceRewind={onWorkspaceRewind} />
                    : <SessionDerivationMarker origin={renderItem.origin} onOpen={onOpenDerivationOrigin} t={t} />}
              </div>
            );
          })}
        </div>
      </div>
      {messageNavRailEnabled && <MessageNavRail entries={messageNavEntries} scrollRef={scrollRef} contentRef={contentRef} bottomOffset={bottomInset} resetKey={sessionId} estimateEntryTop={estimateMessageNavEntryTop} onWheelIntent={handleTimelineWheelIntent} onCoverageChange={setMessageNavRailCoversNavigation} onJump={jumpToMessageNavEntry} t={t} />}
      {previousMessageEntry !== undefined && !messageNavRailCoversNavigation && <PrevMessageJumpChip preview={previousMessageEntry.preview} label={t("timeline.jumpPreviousQuestion", { preview: previousMessageEntry.preview })} onClick={jumpToPreviousMessage} />}
      {onAddSelectionToComposer !== undefined && shareSelection === undefined && <SelectionQuoteButton key={sessionId} sessionId={sessionId} containerRef={scrollRef} label={t("timeline.addToChat")} onCommit={onAddSelectionToComposer} />}
      {!following && (
        <Button className="jump-latest" tone="secondary" aria-label={unreadCount > 0 ? `${t("timeline.jumpLatest")} (${unreadCount})` : t("timeline.jumpLatest")} onClick={() => { setTimelineFollowing(true); pinToLatest(timelineJumpBehavior(reducedMotion)); }}>
          <ChevronDown aria-hidden="true" />{t("timeline.jumpLatest")}{unreadCount > 0 && <span className="jump-latest__count">{unreadCount}</span>}
        </Button>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">{lastItem?.streaming ? t("a11y.newActivity") : ""}</div>
    </div>
    {openGallery !== undefined && galleryImages.length > 0 && <TimelineImageLightbox key={openGallery.imageId} images={galleryImages} startImageId={openGallery.imageId} returnFocus={openGallery.trigger} t={t} loadUrl={loadArtifactUrl} onDownload={onArtifactDownload} {...(onWorkspaceImageToComposer === undefined ? {} : { onSendToChat: onWorkspaceImageToComposer })} onClose={() => setOpenGallery(undefined)} />}
    </TimelinePersonalizationContext.Provider>
    </TimelineImageGalleryContext.Provider>
    </TimelineSubagentContext.Provider>
  );
}

export function SessionDerivationMarker({ origin, onOpen, t }: {
  readonly origin: NonNullable<SessionView["derivationOrigin"]>;
  readonly onOpen?: () => void;
  readonly t: Translator;
}): JSX.Element {
  const label = origin.kind === "fork" ? t("timeline.forkOrigin") : t("timeline.cloneOrigin");
  return (
    <div className="timeline-derivation-origin" role="note" aria-label={label} data-origin-kind={origin.kind}>
      <span className="timeline-derivation-origin__line" aria-hidden="true" />
      {onOpen === undefined
        ? <span className="timeline-derivation-origin__unavailable"><GitFork aria-hidden="true" /><span>{label}</span><small>{t("timeline.originUnavailable")}</small></span>
        : <button type="button" aria-label={t("timeline.openOrigin")} onClick={onOpen}><GitFork aria-hidden="true" /><span>{label}</span></button>}
      <span className="timeline-derivation-origin__line" aria-hidden="true" />
    </div>
  );
}

function WorkGroupBlock({ sessionId, sessionName, work, retryRunId, locale, reducedMotion, t, onRetry, onRecovery, recoveryContext, onArtifactUrl, onArtifactDownload, onWorkspaceRewind }: { readonly sessionId: string; readonly sessionName: string; readonly work: TimelineWorkRenderItem; readonly retryRunId?: string; readonly locale: string; readonly reducedMotion: boolean; readonly t: Translator; readonly onRetry?: (error: ErrorView) => void; readonly onRecovery?: (error: ErrorView, action: ErrorRecoveryActionView) => void; readonly recoveryContext?: RecoveryActionContext; readonly onArtifactUrl: (blobId: string) => Promise<string>; readonly onArtifactDownload: (blobId: string, fileName: string) => void; readonly onWorkspaceRewind?: (workspaceId: string, changeSetId: string) => void }): JSX.Element {
  const expansionKey = `${sessionId}\u0000${work.key}`;
  const [expanded, setExpanded] = useState(() => workGroupExpansion.get(expansionKey) ?? false);
  const visibleChildren = expanded ? work.children : work.visibleChildren;
  const displayed = visibleChildren.length > 0;
  const toggleExpanded = (): void => {
    const next = !expanded;
    setExpanded(next);
    rememberWorkGroupExpansion(expansionKey, next);
  };
  return (
    <section className={cx("work-group", work.running && "work-group--running", displayed && "is-open")}>
      <button className="work-group__header" type="button" aria-expanded={displayed} onClick={toggleExpanded}>
        <CircleDotDashed aria-hidden="true" />
        <span className="work-group__heading"><strong>{work.running ? t("timeline.working") : t("timeline.workSummary")}</strong><small>{t("timeline.workSteps", { count: work.children.length })}</small></span>
        {work.running && <span className="thinking-pulse" aria-hidden="true" />}
        <ChevronDown className={cx("details-chevron", expanded && "is-expanded")} aria-hidden="true" />
      </button>
      {displayed && (
        <div className="work-group__children">
          {!expanded && work.hiddenChildCount > 0 && <button type="button" className="work-group__hidden" onClick={toggleExpanded}>{t("timeline.workHidden", { count: work.hiddenChildCount })}</button>}
          {visibleChildren.map((child) => (
            <div className="work-group__item" data-work-child-id={child.id} key={child.id}>
              <TimelineBlock sessionId={sessionId} sessionName={sessionName} item={child} retryRunId={retryRunId} locale={locale} reducedMotion={reducedMotion} t={t} onRetry={onRetry} onRecovery={onRecovery} recoveryContext={recoveryContext} onArtifactUrl={onArtifactUrl} onArtifactDownload={onArtifactDownload} onWorkspaceRewind={onWorkspaceRewind} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TimelineBlock({ sessionId, sessionName, item, planAnimated = false, retryRunId, locale, reducedMotion, t, onRetry, onRecovery, recoveryContext, onArtifactUrl, onArtifactDownload, onWorkspaceRewind, onOpenGeneratedFile, onOpenTurnReview, onReobserveReview, onAddMessageToComposer, onForkMessage, forkingMessageId, shareSelection, onStartShareSelection, onToggleShareMessage, editingMessageId, editableMessageId, onEditMessage, onCancelEditMessage, onMoveEditedMessageToComposer, onPreviewMessageRewind, onDeleteMessage, messageDeleteBlockedReason, showMessageActions = true }: { readonly sessionId: string; readonly sessionName: string; readonly item: TimelineItemView; readonly planAnimated?: boolean; readonly retryRunId?: string; readonly locale: string; readonly reducedMotion: boolean; readonly t: Translator; readonly onRetry?: (error: ErrorView) => void; readonly onRecovery?: (error: ErrorView, action: ErrorRecoveryActionView) => void; readonly recoveryContext?: RecoveryActionContext; readonly onArtifactUrl: (blobId: string) => Promise<string>; readonly onArtifactDownload: (blobId: string, fileName: string) => void; readonly onWorkspaceRewind?: (workspaceId: string, changeSetId: string) => void; readonly onOpenGeneratedFile?: (workspaceId: string, relativePath: string) => void; readonly onOpenTurnReview?: (changeSetId: string, relativePath?: string) => void; readonly onReobserveReview?: (reviewRunId: string) => Promise<void>; readonly onAddMessageToComposer?: (item: TimelineItemView) => void; readonly onForkMessage?: (item: TimelineItemView) => void; readonly forkingMessageId?: string; readonly shareSelection?: TimelineShareSelection; readonly onStartShareSelection?: (item: TimelineItemView) => void; readonly onToggleShareMessage?: (itemId: string, extendRange: boolean) => void; readonly editingMessageId?: string; readonly editableMessageId?: string; readonly onEditMessage?: (item: TimelineItemView) => void; readonly onCancelEditMessage?: () => void; readonly onMoveEditedMessageToComposer?: (item: TimelineItemView, text: string) => Promise<void>; readonly onPreviewMessageRewind?: (item: TimelineItemView) => void; readonly onDeleteMessage?: (item: TimelineItemView) => void; readonly messageDeleteBlockedReason?: string; readonly showMessageActions?: boolean }): JSX.Element {
  if (item.inlinePlan !== undefined) return <InlinePlanCard plan={item.inlinePlan} animated={planAnimated} t={t} />;
  switch (item.kind) {
    case "user": return <MessageBlock sessionId={sessionId} sessionName={sessionName} item={item} role="user" locale={locale} reducedMotion={reducedMotion} t={t} onArtifactUrl={onArtifactUrl} onArtifactDownload={onArtifactDownload} onAddMessageToComposer={onAddMessageToComposer} onForkMessage={onForkMessage} forking={forkingMessageId === item.id} shareSelection={shareSelection} onStartShareSelection={onStartShareSelection} onToggleShareMessage={onToggleShareMessage} editing={editingMessageId === item.id} editable={editableMessageId === item.id} onEdit={onEditMessage} onCancelEdit={onCancelEditMessage} onMoveEditedMessageToComposer={onMoveEditedMessageToComposer} onPreviewMessageRewind={onPreviewMessageRewind} onDeleteMessage={onDeleteMessage} messageDeleteBlockedReason={messageDeleteBlockedReason} showActions={showMessageActions} />;
    case "assistant": return <MessageBlock sessionId={sessionId} sessionName={sessionName} item={item} role="assistant" locale={locale} reducedMotion={reducedMotion} t={t} onArtifactUrl={onArtifactUrl} onArtifactDownload={onArtifactDownload} onAddMessageToComposer={onAddMessageToComposer} onForkMessage={onForkMessage} forking={forkingMessageId === item.id} shareSelection={shareSelection} onStartShareSelection={onStartShareSelection} onToggleShareMessage={onToggleShareMessage} editing={false} editable={false} onPreviewMessageRewind={onPreviewMessageRewind} onDeleteMessage={onDeleteMessage} messageDeleteBlockedReason={messageDeleteBlockedReason} showActions={showMessageActions} />;
    case "thinking": return <ThinkingBlock item={item} locale={locale} t={t} />;
    case "tool": return <ToolBlock item={item} locale={locale} t={t} onArtifactUrl={onArtifactUrl} onArtifactDownload={onArtifactDownload} />;
    case "toolResult": return <ToolBlock item={item} locale={locale} t={t} onArtifactUrl={onArtifactUrl} onArtifactDownload={onArtifactDownload} />;
    case "image": return <ArtifactBlock item={item} icon={<ImageIcon />} locale={locale} t={t} onArtifactUrl={onArtifactUrl} onArtifactDownload={onArtifactDownload} />;
    case "artifact": return <ArtifactBlock item={item} icon={<FileOutput />} locale={locale} t={t} onArtifactUrl={onArtifactUrl} onArtifactDownload={onArtifactDownload} />;
    case "diff": return <DiffBlock item={item} locale={locale} t={t} onArtifactDownload={onArtifactDownload} onWorkspaceRewind={onWorkspaceRewind} onOpenGeneratedFile={onOpenGeneratedFile} onOpenTurnReview={onOpenTurnReview} />;
    case "error": return <ErrorBlock item={item} locale={locale} t={t} onRetry={item.error?.runId === retryRunId ? onRetry : undefined} onRecovery={onRecovery} recoveryContext={recoveryContext} />;
    case "compaction": {
      const copy = compactionTimelineCopy(item, locale, t);
      return <NoticeBlock item={item} icon={<Brain />} title={copy.title} detail={copy.detail} locale={locale} />;
    }
    case "contextRebuild": return <ContextRebuildCard item={item} t={t} />;
    case "runtimeRecovery": return <RuntimeRecoveryBlock item={item} t={t} />;
    case "interaction": return item.interaction?.kind === "question" && item.interaction.state === "resolved"
      ? <InteractionAnswerBlock item={item} t={t} />
      : <NoticeBlock item={item} icon={<ListChecks />} title={item.interaction?.state === "pending" ? t("timeline.inputRequired") : t("timeline.inputClosed")} locale={locale} accent />;
    case "background": return <BackgroundBlock item={item} locale={locale} t={t} />;
    case "review": return <ReviewCard item={item} t={t} onReobserveReview={onReobserveReview} />;
    case "status": return <StatusBlock item={item} locale={locale} />;
  }
}

const REVIEW_FAILURE_KEY: Record<NonNullable<NonNullable<TimelineItemView["review"]>["failureCode"]>, MessageKey> = {
  "no-visible-result": "review.noResult",
  "reviewer-closed": "review.failure.reviewerClosed",
  "cancelled-before-start": "review.failure.cancelledBeforeStart",
  interrupted: "review.failure.interrupted",
  "source-workspace-changed": "review.failure.sourceWorkspaceChanged",
  "source-conversation-changed": "review.failure.sourceConversationChanged",
  "source-files-changed": "review.failure.sourceFilesChanged",
  "artifact-changed": "review.failure.artifactChanged",
  "artifact-unavailable": "review.failure.artifactUnavailable",
  "provider-failed": "review.failure.providerFailed"
};

export function ReviewCard({ item, t, onReobserveReview }: { readonly item: TimelineItemView; readonly t: Translator; readonly onReobserveReview?: (reviewRunId: string) => Promise<void> }): JSX.Element {
  const [reobserving, setReobserving] = useState(false);
  const [reobserveFailed, setReobserveFailed] = useState(false);
  const reobserveFlightRef = useRef(false);
  const review = item.review;
  if (review === undefined) return <></>;
  const failure = review.failureCode === undefined
    ? t("review.noResult")
    : t(REVIEW_FAILURE_KEY[review.failureCode]);
  const canReobserve = review.state !== "running"
    && review.freshness !== "current"
    && onReobserveReview !== undefined;
  const reobserve = async (): Promise<void> => {
    if (!canReobserve || reobserveFlightRef.current) return;
    reobserveFlightRef.current = true;
    setReobserving(true);
    setReobserveFailed(false);
    try {
      await onReobserveReview(review.id);
    } catch {
      // Keep the last durable freshness and conclusion visible. A failed
      // observation must never be presented as current client-side.
      setReobserveFailed(true);
    } finally {
      reobserveFlightRef.current = false;
      setReobserving(false);
    }
  };
  return <article
    className="review-run-card"
    data-review-run-id={review.id}
    data-state={review.state}
    data-freshness={review.freshness}
  >
    <div className="review-run-card__header">
      {review.state === "running"
        ? <Spinner label={t("review.running")} />
        : review.state === "completed"
          ? <Check aria-hidden="true" />
          : <X aria-hidden="true" />}
      <strong>{t(review.state === "running" ? "review.running" : review.state === "completed" ? "review.completed" : "review.failed")}</strong>
      {review.freshness === "stale" && <span className="review-run-card__freshness">{t("review.stale")}</span>}
      {review.freshness === "unavailable" && <span className="review-run-card__freshness">{t("review.freshnessUnavailable")}</span>}
      {canReobserve && <button type="button" disabled={reobserving} aria-busy={reobserving} onClick={() => { void reobserve(); }}><RotateCcw aria-hidden="true" />{t(reobserving ? "review.reobserving" : "review.reobserve")}</button>}
      {review.reviewerSessionId !== undefined && <button type="button" onClick={() => {
        window.location.hash = reviewTaskHash(review.reviewerSessionId ?? "");
      }}>{t("review.openTask")}<ArrowRight aria-hidden="true" /></button>}
    </div>
    {review.state === "running" && <p className="review-run-card__hint">{t("review.readOnlyHint")}</p>}
    {review.freshness === "stale" && <p className="review-run-card__stale">{t("review.staleHint")}</p>}
    {reobserveFailed && <p className="review-run-card__reobserve-error" role="alert">{t("review.reobserveFailed")}</p>}
    {review.state === "failed" && <p className="review-run-card__failure">{failure}</p>}
    {review.state === "completed" && review.result !== undefined && <div className="review-run-card__result markdown">
      <StreamingMarkdown text={review.result} streaming={false} t={t} />
    </div>}
  </article>;
}

export function reviewTaskHash(reviewerSessionId: string): string {
  return `#/tasks/${encodeURIComponent(reviewerSessionId)}`;
}

export function CollapsibleUserMessageContent({ measureText, automation = false, children, t }: {
  readonly measureText: string;
  readonly automation?: boolean;
  readonly children: ReactNode;
  readonly t: Translator;
}): JSX.Element {
  const threshold = automation ? AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD : undefined;
  const measurementEnabled = mayExceedUserMessageLineThreshold(measureText, threshold);
  const { mirrorRef, shouldCollapse } = useUserMessageAutoCollapse(measureText, measurementEnabled, threshold);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const collapsed = shouldCollapse && !expanded;

  return (
    <>
      <div id={contentId} className={cx("message-user__content", automation && "is-automation", collapsed && "is-collapsed")}>{children}</div>
      {measurementEnabled && <div ref={mirrorRef} className="message-user__collapse-mirror" aria-hidden="true">{measureText}</div>}
      {shouldCollapse && (
        <button
          type="button"
          className="message-user__collapse-toggle"
          aria-controls={contentId}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {t(expanded ? "timeline.collapseLongMessage" : "timeline.expandLongMessage")}
          {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </button>
      )}
    </>
  );
}

export function AutomationOriginBadge({ automationOrigin, t }: {
  readonly automationOrigin: NonNullable<TimelineItemView["automationOrigin"]>;
  readonly t: Translator;
}): JSX.Element {
  const label = automationOrigin.scheduleName === undefined
    ? t("timeline.automationSent")
    : t("timeline.automationSentNamed", { name: automationOrigin.scheduleName });
  return <button
    type="button"
    className="message-user__automation-origin"
    title={t("timeline.automationViewTask")}
    onClick={() => { window.location.hash = `#/schedules?focus=${encodeURIComponent(automationOrigin.scheduleId)}`; }}
  ><Timer aria-hidden="true" /><span>{label}</span></button>;
}

function MessageBlock({ sessionId, sessionName, item, role, locale, reducedMotion, t, onArtifactUrl, onArtifactDownload, onAddMessageToComposer, onForkMessage, forking, shareSelection, onStartShareSelection, onToggleShareMessage, editing, editable, onEdit, onCancelEdit, onMoveEditedMessageToComposer, onPreviewMessageRewind, onDeleteMessage, messageDeleteBlockedReason, showActions }: { readonly sessionId: string; readonly sessionName: string; readonly item: TimelineItemView; readonly role: "user" | "assistant"; readonly locale: string; readonly reducedMotion: boolean; readonly t: Translator; readonly onArtifactUrl: (blobId: string) => Promise<string>; readonly onArtifactDownload: (blobId: string, fileName: string) => void; readonly onAddMessageToComposer?: (item: TimelineItemView) => void; readonly onForkMessage?: (item: TimelineItemView) => void; readonly forking: boolean; readonly shareSelection?: TimelineShareSelection; readonly onStartShareSelection?: (item: TimelineItemView) => void; readonly onToggleShareMessage?: (itemId: string, extendRange: boolean) => void; readonly editing: boolean; readonly editable: boolean; readonly onEdit?: (item: TimelineItemView) => void; readonly onCancelEdit?: () => void; readonly onMoveEditedMessageToComposer?: (item: TimelineItemView, text: string) => Promise<void>; readonly onPreviewMessageRewind?: (item: TimelineItemView) => void; readonly onDeleteMessage?: (item: TimelineItemView) => void; readonly messageDeleteBlockedReason?: string; readonly showActions: boolean }): JSX.Element {
  const personalization = useContext(TimelinePersonalizationContext);
  const referenceActions = useMemo<TimelineReferenceActions>(() => ({
    sessionId,
    ...(personalization.onOpenHttpLink === undefined ? {} : { onOpenHttpLink: personalization.onOpenHttpLink }),
    ...(personalization.onLoadWorkspaceAsset === undefined ? {} : { onLoadWorkspaceAsset: personalization.onLoadWorkspaceAsset }),
    ...(personalization.onWorkspaceImageToComposer === undefined ? {} : { onWorkspaceImageToComposer: personalization.onWorkspaceImageToComposer })
  }), [personalization.onLoadWorkspaceAsset, personalization.onOpenHttpLink, personalization.onWorkspaceImageToComposer, sessionId]);
  const text = item.text ?? "";
  const quotedUserMessage = role === "user"
    ? parseSelectionQuoteMessage(text, item.quotesEncoded === true)
    : { segments: [{ kind: "text" as const, text }], quotes: [], body: text };
  const actionText = role === "user" ? visibleSelectionQuoteMessageText(text, item.quotesEncoded === true) : text;
  const hasPastedTextRanges = role === "user" && (item.pastedTextRanges?.length ?? 0) > 0;
  const pastedTextSegments = useMemo(() => hasPastedTextRanges
    ? buildSentPastedTextMessageSegments(text, item.quotesEncoded === true, item.pastedTextRanges)
    : [], [hasPastedTextRanges, item.pastedTextRanges, item.quotesEncoded, text]);
  const userMeasureText = hasPastedTextRanges
    ? projectSentPastedTextMessageBody(text, item.quotesEncoded === true, item.pastedTextRanges)
    : quotedUserMessage.body;
  const roleLabel = role === "user" ? t("timeline.you") : t("timeline.agent");
  const selectionActive = shareSelection !== undefined;
  const shareable = item.streaming !== true && (text.trim().length > 0 || (item.attachments?.length ?? 0) > 0);
  const selectionControl = selectionActive && shareable && onToggleShareMessage !== undefined
    ? <MessageSelectionControl item={item} selected={shareSelection.selectedIds.has(item.id)} roleLabel={roleLabel} t={t} onToggle={onToggleShareMessage} />
    : null;
  const attachments = (item.attachments?.length ?? 0) > 0
    ? <div className="message-attachments" aria-label={t("timeline.attachments")}>{item.attachments?.map((attachment, index) => <MessageAttachment artifact={attachment} galleryId={timelineMessageAttachmentGalleryId(item.id, attachment.id, index)} t={t} onArtifactUrl={onArtifactUrl} onArtifactDownload={onArtifactDownload} key={`${attachment.id}:${index}`} />)}</div>
    : null;
  let pastedTextSegmentIndex = 0;
  const userMessageSegments = quotedUserMessage.segments.map((segment, index) => {
    if (segment.kind === "quote") return <SelectionQuoteChip quote={segment.quote} key={`${item.id}:quote:${index}`} />;
    const projected = pastedTextSegments[pastedTextSegmentIndex];
    pastedTextSegmentIndex += 1;
    return projected === undefined
      ? <SentMessageReferenceText text={segment.text} actions={referenceActions} key={`${item.id}:text:${index}`} />
      : <SentPastedTextInline segment={projected} t={t} key={`${item.id}:text:${index}`} />;
  });
  if (role === "user") {
    if (editing && onCancelEdit !== undefined && onMoveEditedMessageToComposer !== undefined) {
      return <article className="message-user message-user--editing" data-user-msg-id={item.id} data-message-client-id={item.id} aria-label={roleLabel}><div className="message-user__stack">{item.automationOrigin !== undefined && <AutomationOriginBadge automationOrigin={item.automationOrigin} t={t} />}<UserMessageEditBox initialText={quotedUserMessage.body} t={t} onCancel={onCancelEdit} onMoveToComposer={(value) => onMoveEditedMessageToComposer(item, value)} /></div></article>;
    }
    return (
      <article className={cx("message-user", selectionActive && "is-share-selecting")} data-user-msg-id={item.id} data-message-client-id={item.id} data-selection-quote-message-id={item.id} data-selection-quote-source-event-id={item.sourceEventId} data-selection-quote-role="user" aria-label={roleLabel}>
        {selectionControl}
        <div className="message-user__stack">
          {item.automationOrigin !== undefined && <AutomationOriginBadge automationOrigin={item.automationOrigin} t={t} />}
          {attachments}
          {quotedUserMessage.segments.length > 0 && (
            <div className="message-user__bubble message-user__bubble--quoted">
              <CollapsibleUserMessageContent measureText={userMeasureText} automation={item.automationOrigin !== undefined} t={t}>
                {userMessageSegments}
              </CollapsibleUserMessageContent>
            </div>
          )}
          {!selectionActive && showActions && <MessageActions sessionId={sessionId} sessionName={sessionName} item={item} text={actionText} align="right" locale={locale} t={t} onAddMessageToComposer={onAddMessageToComposer} onFork={onForkMessage} forking={forking} onStartShareSelection={onStartShareSelection} editable={editable} onEdit={onEdit} onPreviewMessageRewind={onPreviewMessageRewind} onDeleteMessage={onDeleteMessage} messageDeleteBlockedReason={messageDeleteBlockedReason} />}
        </div>
      </article>
    );
  }
  const assistantContent = <>
    <div className="markdown message-assistant__body"><StreamingMarkdown text={text} streaming={item.streaming === true} streamFadeKey={`${sessionId}:${item.id}`} t={t} />{item.streaming && <span className={cx("streaming-cursor", reducedMotion && "streaming-cursor--reduced-motion")} aria-label={t("timeline.streaming")} />}</div>
    {attachments}
    {!selectionActive && !item.streaming && showActions && <MessageActions sessionId={sessionId} sessionName={sessionName} item={item} text={text} align="left" locale={locale} t={t} onAddMessageToComposer={onAddMessageToComposer} onFork={onForkMessage} forking={forking} onStartShareSelection={onStartShareSelection} editable={false} onPreviewMessageRewind={onPreviewMessageRewind} onDeleteMessage={onDeleteMessage} messageDeleteBlockedReason={messageDeleteBlockedReason} />}
  </>;
  return (
    <article className={cx("message-assistant", selectionActive && "is-share-selecting")} data-message-client-id={item.id} data-selection-quote-message-id={item.id} data-selection-quote-source-event-id={item.sourceEventId} data-selection-quote-role="assistant" aria-label={roleLabel}>
      {selectionControl}
      {selectionActive ? <div className="message-assistant__selection-stack">{assistantContent}</div> : assistantContent}
    </article>
  );
}

function MessageSelectionControl({ item, selected, roleLabel, t, onToggle }: { readonly item: TimelineItemView; readonly selected: boolean; readonly roleLabel: string; readonly t: Translator; readonly onToggle: (itemId: string, extendRange: boolean) => void }): JSX.Element {
  return <button type="button" className={cx("message-share-choice", selected && "is-selected")} role="checkbox" aria-checked={selected} aria-label={t("timeline.shareSelectionToggle", { role: roleLabel })} onClick={(event) => onToggle(item.id, event.shiftKey)}><span aria-hidden="true">{selected && <Check />}</span></button>;
}

function MessageActions({ sessionId, sessionName, item, text, align, locale, t, onAddMessageToComposer, onFork, forking, onStartShareSelection, editable, onEdit, onPreviewMessageRewind, onDeleteMessage, messageDeleteBlockedReason }: { readonly sessionId: string; readonly sessionName: string; readonly item: TimelineItemView; readonly text: string; readonly align: "left" | "right"; readonly locale: string; readonly t: Translator; readonly onAddMessageToComposer?: (item: TimelineItemView) => void; readonly onFork?: (item: TimelineItemView) => void; readonly forking: boolean; readonly onStartShareSelection?: (item: TimelineItemView) => void; readonly editable: boolean; readonly onEdit?: (item: TimelineItemView) => void; readonly onPreviewMessageRewind?: (item: TimelineItemView) => void; readonly onDeleteMessage?: (item: TimelineItemView) => void; readonly messageDeleteBlockedReason?: string }): JSX.Element {
  const deepLink = sessionMessageDeepLink(sessionId, item.id, item.sourceEventId, window.location.href);
  const forkable = onFork !== undefined && resolveMessageForkTarget(item) !== undefined;
  const [sharing, setSharing] = useState(false);
  const [shareFeedback, setShareFeedback] = useState<{ readonly kind: "success" | "error"; readonly text: string }>();
  const shareFeedbackTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (shareFeedbackTimerRef.current !== undefined) window.clearTimeout(shareFeedbackTimerRef.current); }, []);
  const reportShareFeedback = (kind: "success" | "error", value: string): void => {
    if (shareFeedbackTimerRef.current !== undefined) window.clearTimeout(shareFeedbackTimerRef.current);
    setShareFeedback({ kind, text: value });
    shareFeedbackTimerRef.current = window.setTimeout(() => setShareFeedback(undefined), kind === "error" ? 5_000 : 2_400);
  };
  const shareable = text.trim().length > 0 || (item.attachments?.length ?? 0) > 0;
  const shareMessage = async (): Promise<void> => {
    if (!shareable || sharing) return;
    setSharing(true);
    setShareFeedback(undefined);
    try {
      const blob = await buildShareMessageImagePng({
        sessionName,
        role: align === "right" ? "user" : "assistant",
        roleLabel: align === "right" ? t("timeline.you") : t("timeline.agent"),
        text,
        attachmentNames: item.attachments?.map((attachment) => attachment.fileName || attachment.title),
        attachmentsLabel: t("timeline.attachments"),
        createdAtLabel: formatDateTime(item.createdAt, locale)
      });
      const delivery = await deliverShareMessageImage(blob, shareMessageImageFilename(sessionName, item.createdAt), sessionName);
      if (delivery === "shared") reportShareFeedback("success", t("timeline.shareShared"));
      if (delivery === "downloaded") reportShareFeedback("success", t("timeline.shareDownloaded"));
    } catch (error) {
      reportShareFeedback("error", error instanceof ShareMessageImageTooLargeError
        ? t("timeline.shareTooLarge")
        : error instanceof ShareMessageImageEmptyError
          ? t("timeline.shareEmpty")
          : t("timeline.shareFailed"));
    } finally {
      setSharing(false);
    }
  };
  const time = <time key="time" dateTime={new Date(item.createdAt).toISOString()}>{formatDateTime(item.createdAt, locale)}</time>;
  const usage = align === "left" ? <MessageUsageMeta key="usage" usage={item.usage} t={t} /> : null;
  const copy = <CopyButton key="copy" text={text} label={t("timeline.copy")} />;
  const share = shareable
    ? <IconButton key="share" className="copy-button" disabled={sharing} disabledReason={sharing ? t("timeline.shareGenerating") : undefined} label={sharing ? t("timeline.shareGenerating") : t("timeline.shareAsImage")} onClick={() => { void shareMessage(); }}>{sharing ? <Spinner label={t("timeline.shareGenerating")} /> : <Share aria-hidden="true" />}</IconButton>
    : null;
  const fork = forkable
    ? <IconButton key="fork" className="copy-button" disabled={forking} disabledReason={forking ? t("timeline.forkFromHere") : undefined} label={t("timeline.forkFromHere")} onClick={() => onFork?.(item)}>{forking ? <Spinner label={t("timeline.forkFromHere")} /> : <GitFork aria-hidden="true" />}</IconButton>
    : null;
  const edit = editable && onEdit !== undefined
    ? <IconButton key="edit" className="copy-button" label={t("timeline.editMessage")} onClick={() => onEdit(item)}><Pencil aria-hidden="true" /></IconButton>
    : null;
  const more = <MessageMoreMenu key="more" item={item} deepLink={deepLink} align={align} t={t} onAddMessageToComposer={onAddMessageToComposer} onStartShareSelection={onStartShareSelection} onPreviewMessageRewind={onPreviewMessageRewind} onDeleteMessage={onDeleteMessage} messageDeleteBlockedReason={messageDeleteBlockedReason} />;
  return <div className={cx("message-actions", `message-actions--${align}`, shareFeedback !== undefined && "has-feedback")}>{align === "left" ? <>{copy}{share}{fork}{more}{time}{usage}</> : <>{time}{copy}{share}{edit}{fork}{more}</>}{shareFeedback !== undefined && <span className={cx("message-share-feedback", shareFeedback.kind === "error" && "is-error")} role={shareFeedback.kind === "error" ? "alert" : "status"}>{shareFeedback.text}</span>}</div>;
}

function MessageMoreMenu({ item, deepLink, align, t, onAddMessageToComposer, onStartShareSelection, onPreviewMessageRewind, onDeleteMessage, messageDeleteBlockedReason }: { readonly item: TimelineItemView; readonly deepLink: string; readonly align: "left" | "right"; readonly t: Translator; readonly onAddMessageToComposer?: (item: TimelineItemView) => void; readonly onStartShareSelection?: (item: TimelineItemView) => void; readonly onPreviewMessageRewind?: (item: TimelineItemView) => void; readonly onDeleteMessage?: (item: TimelineItemView) => void; readonly messageDeleteBlockedReason?: string }): JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const rewindable = onPreviewMessageRewind !== undefined && messageDialogueRewindTarget(item) !== undefined;
  const deletable = onDeleteMessage !== undefined && resolveMessageDeleteTarget(item) !== undefined;
  const close = (): void => { detailsRef.current?.removeAttribute("open"); };
  return (
    <details
      ref={detailsRef}
      className="message-action-menu"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        close();
        detailsRef.current?.querySelector<HTMLElement>("summary")?.focus();
      }}
    >
      <TipSummary label={t("timeline.moreActions")}><Ellipsis aria-hidden="true" /></TipSummary>
      <div className={cx("message-action-menu__popover", align === "right" && "message-action-menu__popover--right")} role="menu">
        {onAddMessageToComposer !== undefined && <button type="button" role="menuitem" onClick={() => { onAddMessageToComposer(item); close(); }}><MessageSquarePlus aria-hidden="true" />{t("timeline.addToChat")}</button>}
        {onStartShareSelection !== undefined && <button type="button" role="menuitem" onClick={() => { onStartShareSelection(item); close(); }}><Images aria-hidden="true" />{t("timeline.shareSelectionEntry")}</button>}
        <button type="button" role="menuitem" onClick={() => { void navigator.clipboard.writeText(deepLink); close(); }}><Link2 aria-hidden="true" />{t("timeline.copyLink")}</button>
        {rewindable && <button type="button" role="menuitem" onClick={() => { onPreviewMessageRewind(item); close(); }}><RotateCcw aria-hidden="true" />{t("timeline.rewindMessage")}</button>}
        {deletable && <><span className="message-action-menu__separator" role="separator" />{messageDeleteBlockedReason === undefined
          ? <button type="button" role="menuitem" className="danger-text" aria-label={t("timeline.deleteMessage")} onClick={() => { onDeleteMessage?.(item); close(); }}><Trash2 aria-hidden="true" />{t("timeline.deleteMessage")}</button>
          : <Tip text={messageDeleteBlockedReason} focusable><button type="button" role="menuitem" className="danger-text" disabled aria-label={messageDeleteBlockedReason}><Trash2 aria-hidden="true" />{t("timeline.deleteMessage")}</button></Tip>}</>}
      </div>
    </details>
  );
}

export function MessageAttachment({ artifact, galleryId, t, onArtifactUrl, onArtifactDownload }: { readonly artifact: NonNullable<TimelineItemView["attachments"]>[number]; readonly galleryId?: string; readonly t: Translator; readonly onArtifactUrl: (blobId: string) => Promise<string>; readonly onArtifactDownload: (blobId: string, fileName: string) => void }): JSX.Element {
  const gallery = useContext(TimelineImageGalleryContext);
  const { sessionId } = useContext(TimelinePersonalizationContext);
  const [textPreviewTrigger, setTextPreviewTrigger] = useState<HTMLElement>();
  const mediaKind = timelineArtifactMediaKind(artifact.mediaType);
  const [image, markImageFailed] = useArtifactImageUrl(artifact.blobId, mediaKind === undefined && artifact.kind === "image", onArtifactUrl);
  const textPreviewSupported = timelineArtifactSupportsTextPreview(artifact);
  const imagePreview = mediaKind !== undefined
    ? <TimelineArtifactMedia artifact={artifact} playbackOwnerKey={sessionId} loadUrl={onArtifactUrl} t={t} className="message-attachment__media" />
    : artifact.kind !== "image"
    ? textPreviewSupported
      ? <IconButton className="message-attachment__preview message-attachment__preview--text" label={`${t("workspace.preview")}: ${artifact.fileName}`} tip={t("workspace.preview")} onClick={(event) => setTextPreviewTrigger(event.currentTarget)}><FileText aria-hidden="true" /></IconButton>
      : <span className="message-attachment__icon" aria-hidden="true"><FileOutput /></span>
    : image.status === "ready" && gallery !== undefined && galleryId !== undefined
      ? <button className="message-attachment__preview" type="button" data-gallery-image-id={galleryId} aria-label={t("timeline.openImage", { name: artifact.title })} onClick={(event) => gallery.open(galleryId, event.currentTarget)}><img src={image.url} alt={artifact.title} loading="lazy" onError={markImageFailed} /></button>
      : <span className={cx("message-attachment__icon", image.status === "error" && "image-preview--failed")} aria-hidden="true">{image.status === "error" ? <ImageOff /> : <ImageIcon />}</span>;
  return <>
    <article className={cx("message-attachment", mediaKind !== undefined && "message-attachment--media")}>{imagePreview}<span className="message-attachment__copy"><strong>{artifact.title}</strong><small>{artifact.fileName} · {formatBytes(artifact.byteSize)}</small>{mediaKind === undefined && image.status === "error" && <small className="image-preview__failure-label">{t("timeline.imageUnavailable")}</small>}</span><IconButton label={t("timeline.downloadArtifact", { name: artifact.fileName })} onClick={() => onArtifactDownload(artifact.blobId, artifact.fileName)}><Download aria-hidden="true" /></IconButton></article>
    {textPreviewTrigger !== undefined && <TimelineTextAttachmentLightbox
      artifact={artifact}
      labels={{
        preview: t("workspace.preview"),
        loading: t("workspace.loadingPreview"),
        unavailable: t("workspace.filePreviewUnavailable"),
        tooLarge: t("workspace.previewTruncated"),
        copy: t("timeline.copy"),
        copied: t("timeline.blockCopied"),
        copyFailed: t("timeline.blockCopyFailed"),
        download: t("workspace.downloadFile"),
        close: t("common.close")
      }}
      returnFocus={textPreviewTrigger}
      loadUrl={onArtifactUrl}
      onDownload={onArtifactDownload}
      onClose={() => setTextPreviewTrigger(undefined)}
    />}
  </>;
}

type ArtifactImageLoadState =
  | { readonly status: "loading"; readonly blobId: string }
  | { readonly status: "ready"; readonly blobId: string; readonly url: string }
  | { readonly status: "error"; readonly blobId: string };

function useArtifactImageUrl(blobId: string, enabled: boolean, onArtifactUrl: (blobId: string) => Promise<string>): readonly [ArtifactImageLoadState, () => void] {
  const [state, setState] = useState<ArtifactImageLoadState>({ status: "loading", blobId });
  const onArtifactUrlRef = useRef(onArtifactUrl);
  onArtifactUrlRef.current = onArtifactUrl;
  useEffect(() => {
    let active = true;
    setState({ status: "loading", blobId });
    if (enabled) {
      void onArtifactUrlRef.current(blobId)
        .then((url) => { if (active) setState({ status: "ready", blobId, url }); })
        .catch(() => { if (active) setState({ status: "error", blobId }); });
    }
    return () => { active = false; };
  }, [blobId, enabled]);
  const markFailed = useCallback(() => setState({ status: "error", blobId }), [blobId]);
  return [state.blobId === blobId ? state : { status: "loading", blobId }, markFailed];
}

function ThinkingBlock({ item, locale, t }: { readonly item: TimelineItemView; readonly locale: string; readonly t: Translator }): JSX.Element {
  return (
    <details className="thinking-block" open={item.streaming || !item.collapsed}>
      <summary><Brain aria-hidden="true" /><strong>{item.title ?? t("timeline.thinking")}</strong>{item.streaming && <span className="thinking-pulse" />}<time>{formatDateTime(item.createdAt, locale)}</time><ChevronDown className="details-chevron" aria-hidden="true" /></summary>
      <div className="thinking-block__content"><StreamingMarkdown text={item.text ?? ""} streaming={item.streaming === true} t={t} /></div>
    </details>
  );
}

export function StreamingMarkdown({ text, streaming, streamFadeKey, t }: { readonly text: string; readonly streaming: boolean; readonly streamFadeKey?: string; readonly t: Translator }): JSX.Element {
  const personalization = useContext(TimelinePersonalizationContext);
  const throttled = useStreamingMarkdownText(text, streaming);
  const source = streaming ? throttled : text;
  const rendered = useMemo(() => streaming ? repairStreamingMarkdown(source) : source, [source, streaming]);
  const fade = timelineStreamFadeActive(streaming, personalization.streamFadeEnabled, personalization.reducedMotion);
  const fadeState = useMemo(() => fade ? timelineWordFadeState(streamFadeKey) : undefined, [fade, streamFadeKey]);
  const candidate = useMemo(() => fadeState === undefined ? undefined : createTimelineWordFadeCandidate(fadeState), [fadeState, rendered]);
  useLayoutEffect(() => {
    if (fadeState !== undefined && candidate !== undefined) commitTimelineWordFadeCandidate(fadeState, candidate);
  }, [candidate, fadeState]);
  useEffect(() => {
    if (!fade) releaseTimelineWordFadeState(streamFadeKey);
  }, [fade, streamFadeKey]);
  const settleWord = useCallback((event: { readonly animationName: string; readonly currentTarget: { readonly dataset: DOMStringMap } }) => {
    if (fadeState !== undefined) markTimelineWordFadeSettled(fadeState, event);
  }, [fadeState]);
  return <ParsedMarkdown
    text={rendered}
    t={t}
    wordFade={candidate}
    onWordFadeSettled={settleWord}
  />;
}

const ParsedMarkdown = memo(function ParsedMarkdown({ text, t, wordFade, onWordFadeSettled }: {
  readonly text: string;
  readonly t: Translator;
  readonly wordFade?: ReturnType<typeof createTimelineWordFadeCandidate>;
  readonly onWordFadeSettled: (event: { readonly animationName: string; readonly currentTarget: { readonly dataset: DOMStringMap } }) => void;
}): JSX.Element {
  const personalization = useContext(TimelinePersonalizationContext);
  const referenceActions = useMemo<TimelineReferenceActions>(() => ({
    sessionId: personalization.sessionId,
    ...(personalization.onOpenHttpLink === undefined ? {} : { onOpenHttpLink: personalization.onOpenHttpLink }),
    ...(personalization.onLoadWorkspaceAsset === undefined ? {} : { onLoadWorkspaceAsset: personalization.onLoadWorkspaceAsset }),
    ...(personalization.onWorkspaceImageToComposer === undefined ? {} : { onWorkspaceImageToComposer: personalization.onWorkspaceImageToComposer })
  }), [personalization.onLoadWorkspaceAsset, personalization.onOpenHttpLink, personalization.onWorkspaceImageToComposer, personalization.sessionId]);
  const [linkMenu, setLinkMenu] = useState<{ readonly url: string; readonly x: number; readonly y: number }>();
  const [linkFeedback, setLinkFeedback] = useState<string>();
  const linkMenuRef = useRef<HTMLDivElement>(null);
  const linkFeedbackTimerRef = useRef<number | undefined>(undefined);
  const openLinkMenu = useCallback((url: string, x: number, y: number): void => {
    setLinkMenu({
      url,
      x: Math.max(8, Math.min(x, window.innerWidth - 224)),
      y: Math.max(8, Math.min(y, window.innerHeight - 132))
    });
  }, []);
  useEffect(() => {
    if (linkMenu === undefined) return;
    linkMenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus();
    const close = (event: PointerEvent): void => {
      if (!linkMenuRef.current?.contains(event.target as Node)) setLinkMenu(undefined);
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setLinkMenu(undefined);
      }
    };
    const dismiss = (): void => setLinkMenu(undefined);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [linkMenu]);
  useEffect(() => () => {
    if (linkFeedbackTimerRef.current !== undefined) window.clearTimeout(linkFeedbackTimerRef.current);
  }, []);
  const reportLinkFeedback = (message: string): void => {
    if (linkFeedbackTimerRef.current !== undefined) window.clearTimeout(linkFeedbackTimerRef.current);
    setLinkFeedback(message);
    linkFeedbackTimerRef.current = window.setTimeout(() => setLinkFeedback(undefined), 1_400);
  };
  const components = useMemo(
    () => safeMarkdownComponents(t, referenceActions, onWordFadeSettled, openLinkMenu),
    [onWordFadeSettled, openLinkMenu, referenceActions, t]
  );
  const normalized = useMemo(() => normalizeTimelineMathDelimiters(text), [text]);
  const rehypePlugins = useMemo(() => wordFade === undefined
    ? TIMELINE_REHYPE_PLUGINS
    : [...TIMELINE_REHYPE_PLUGINS, [rehypeTimelineStreamFade, wordFade]] as NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>, [wordFade]);
  return <>
    <ReactMarkdown remarkPlugins={TIMELINE_REMARK_PLUGINS} rehypePlugins={rehypePlugins} components={components} skipHtml>{normalized}</ReactMarkdown>
    {linkMenu !== undefined && createPortal(<div
      ref={linkMenuRef}
      className="timeline-link-menu"
      role="menu"
      aria-label={t("timeline.linkOpenMenu")}
      style={{ left: linkMenu.x, top: linkMenu.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button type="button" role="menuitem" onClick={() => { referenceActions.onOpenHttpLink?.(linkMenu.url, { forceSidebar: true }); setLinkMenu(undefined); }}><PanelRight aria-hidden="true" />{t("timeline.openInSidebarBrowser")}</button>
      <button type="button" role="menuitem" onClick={() => { referenceActions.onOpenHttpLink?.(linkMenu.url, { forceExternal: true }); setLinkMenu(undefined); }}><Globe2 aria-hidden="true" />{t("timeline.openInDefaultBrowser")}</button>
      <span role="separator" />
      <button type="button" role="menuitem" onClick={() => {
        const url = linkMenu.url;
        setLinkMenu(undefined);
        void navigator.clipboard.writeText(url).then(
          () => reportLinkFeedback(t("timeline.linkCopied")),
          () => reportLinkFeedback(t("timeline.linkCopyFailed"))
        );
      }}><Link2 aria-hidden="true" />{t("timeline.copyUrl")}</button>
    </div>, document.body)}
    {linkFeedback !== undefined && createPortal(<div className="timeline-link-feedback" role="status" aria-live="polite">{linkFeedback}</div>, document.body)}
  </>;
});

function useStreamingMarkdownText(value: string, streaming: boolean, intervalMs = 100): string {
  const [throttled, setThrottled] = useState(value);
  const latestRef = useRef(value);
  const lastEmissionRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    latestRef.current = value;
    if (!streaming) {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
      setThrottled(value);
      return;
    }

    const now = performance.now();
    const delay = streamingMarkdownThrottleDelay(now, lastEmissionRef.current, intervalMs);
    if (delay === 0) {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
      lastEmissionRef.current = now;
      setThrottled(value);
    } else if (timerRef.current === undefined) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        lastEmissionRef.current = performance.now();
        setThrottled(latestRef.current);
      }, delay);
    }
  }, [intervalMs, streaming, value]);

  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  }, []);

  return streamingMarkdownRenderValue(value, throttled, streaming);
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (query === undefined) return;
    const update = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function ToolBlock({ item, locale, t, onArtifactUrl, onArtifactDownload }: { readonly item: TimelineItemView; readonly locale: string; readonly t: Translator; readonly onArtifactUrl: (blobId: string) => Promise<string>; readonly onArtifactDownload: (blobId: string, fileName: string) => void }): JSX.Element {
  const [payloadPreview, setPayloadPreview] = useState<{ readonly sectionId: ToolPayloadSection["id"]; readonly trigger: HTMLButtonElement }>();
  const tool = item.tool;
  if (tool === undefined) return <NoticeBlock item={item} icon={<Wrench />} title={item.title ?? t("timeline.tool")} locale={locale} />;
  const open = tool.state === "running" || tool.state === "waiting" || tool.state === "failed";
  const payloadSections: readonly ToolPayloadSection[] = [
    ...(tool.input === "" ? [] : [{ id: "input" as const, label: t("common.input"), text: tool.input }]),
    ...(tool.output === undefined ? [] : [{ id: "output" as const, label: t("common.output"), text: tool.output }])
  ];
  return (
    <details className={cx("tool-block", `tool-block--${tool.state}`)} open={open}>
      <summary>
        <span className="tool-block__icon"><ToolIcon name={tool.name} /></span>
        <span className="tool-block__heading"><strong>{tool.name}</strong><small>{toolStateLabel(tool.state, t)}</small></span>
        <Pill tone={tool.isError || tool.state === "failed" ? "danger" : tool.state === "succeeded" ? "success" : "neutral"}>{tool.state}</Pill>
        <time>{formatDateTime(item.createdAt, locale)}</time>
        <ChevronDown className="details-chevron" aria-hidden="true" />
      </summary>
      <div className="tool-block__detail">
        {tool.input !== "" && <section><div className="tool-block__payload-heading"><h4>{t("common.input")}</h4><ToolPayloadOpenButton label={`${t("timeline.toolPayloadOpen")} · ${t("common.input")}`} onClick={(trigger) => setPayloadPreview({ sectionId: "input", trigger })} /></div><WindowedText text={tool.input} label={`${tool.name} ${t("common.input")}`} /></section>}
        {tool.output !== undefined && <section><div className="tool-block__payload-heading"><h4>{t("common.output")}</h4><ToolPayloadOpenButton label={`${t("timeline.toolPayloadOpen")} · ${t("common.output")}`} onClick={(trigger) => setPayloadPreview({ sectionId: "output", trigger })} /></div><WindowedText text={tool.output} label={`${tool.name} ${t("common.output")}`} /></section>}
        {(item.attachments?.length ?? 0) > 0 && <div className="message-attachments" aria-label={t("timeline.attachments")}>{item.attachments?.map((attachment, index) => <MessageAttachment artifact={attachment} galleryId={timelineMessageAttachmentGalleryId(item.id, attachment.id, index)} t={t} onArtifactUrl={onArtifactUrl} onArtifactDownload={onArtifactDownload} key={`${attachment.id}:${index}`} />)}</div>}
      </div>
      {payloadPreview !== undefined && <ToolPayloadLightbox title={tool.name} sections={payloadSections} initialSectionId={payloadPreview.sectionId} returnFocus={payloadPreview.trigger} labels={{ close: t("common.close"), copy: t("timeline.toolPayloadCopy"), copied: t("timeline.toolPayloadCopied"), copyFailed: t("timeline.toolPayloadCopyFailed"), selectAll: t("timeline.toolPayloadSelectAll"), allFiles: t("timeline.toolPayloadAllFiles"), chooseFile: t("timeline.toolPayloadChooseFile") }} onClose={() => setPayloadPreview(undefined)} />}
    </details>
  );
}

export function ArtifactBlock({ item, icon, locale, t, onArtifactUrl, onArtifactDownload }: { readonly item: TimelineItemView; readonly icon: JSX.Element; readonly locale: string; readonly t: Translator; readonly onArtifactUrl: (blobId: string) => Promise<string>; readonly onArtifactDownload: (blobId: string, fileName: string) => void }): JSX.Element {
  const artifact = item.artifact;
  const gallery = useContext(TimelineImageGalleryContext);
  const { sessionId } = useContext(TimelinePersonalizationContext);
  const mediaKind = artifact === undefined ? undefined : timelineArtifactMediaKind(artifact.mediaType);
  const [image, markImageFailed] = useArtifactImageUrl(artifact?.blobId ?? "", mediaKind === undefined && item.kind === "image" && artifact !== undefined, onArtifactUrl);
  const galleryId = artifact === undefined ? undefined : timelineArtifactGalleryId(item.id, artifact.id);
  return (
    <article className="artifact-block">
      {mediaKind !== undefined && artifact !== undefined && <TimelineArtifactMedia artifact={artifact} playbackOwnerKey={sessionId} loadUrl={onArtifactUrl} t={t} className="artifact-block__media" />}
      {mediaKind === undefined && item.kind === "image" && artifact !== undefined && (image.status === "ready" && gallery !== undefined && galleryId !== undefined
        ? <button className="artifact-block__image" type="button" data-gallery-image-id={galleryId} aria-label={t("timeline.openImage", { name: artifact.title })} onClick={(event) => gallery.open(galleryId, event.currentTarget)}><img src={image.url} alt={artifact.title ?? item.title ?? t("timeline.image")} loading="lazy" onError={markImageFailed} /></button>
        : <div className={cx("artifact-block__image-placeholder", image.status === "error" && "image-preview--failed")} role={image.status === "error" ? "status" : undefined}>{image.status === "error" ? <><ImageOff aria-hidden="true" /><span>{t("timeline.imageUnavailable")}</span></> : <Spinner label={t("common.loading")} />}</div>)}
      <div className="artifact-block__row">
        <span className="artifact-block__icon" aria-hidden="true">{icon}</span>
        <div><strong>{artifact?.title ?? item.title ?? t("timeline.artifact")}</strong><span>{artifact === undefined ? item.text : `${artifact.fileName} · ${formatBytes(artifact.byteSize)}`}</span></div>
        <time>{formatDateTime(item.createdAt, locale)}</time>
        {artifact !== undefined && <IconButton label={t("timeline.downloadArtifact", { name: artifact.fileName })} onClick={() => onArtifactDownload(artifact.blobId, artifact.fileName)}><Download aria-hidden="true" /></IconButton>}
      </div>
    </article>
  );
}

function TimelineImageLightbox({ images, startImageId, returnFocus, t, loadUrl, onDownload, onSendToChat, onClose }: { readonly images: readonly TimelineGalleryImage[]; readonly startImageId: string; readonly returnFocus: HTMLElement; readonly t: Translator; readonly loadUrl: (blobId: string) => Promise<string>; readonly onDownload: (blobId: string, fileName: string) => void; readonly onSendToChat?: (file: File) => void | Promise<void>; readonly onClose: () => void }): JSX.Element {
  const startIndex = Math.max(0, images.findIndex((image) => image.id === startImageId));
  const [index, setIndex] = useState(startIndex);
  const current = images[index] ?? images[0];
  const [image, markImageFailed] = useArtifactImageUrl(current?.blobId ?? "", current !== undefined, loadUrl);
  const showPrevious = (): void => setIndex((currentIndex) => moveTimelineGalleryIndex(currentIndex, images.length, -1));
  const showNext = (): void => setIndex((currentIndex) => moveTimelineGalleryIndex(currentIndex, images.length, 1));

  if (current === undefined) return <></>;
  return <WorkspaceImageLightbox
    src={image.status === "ready" ? image.url : ""}
    status={image.status}
    name={current.fileName}
    labels={{
      close: t("common.close"),
      copy: t("workspace.imageCopy"),
      copied: t("workspace.imageCopied"),
      copyFailed: t("workspace.imageCopyFailed"),
      saveAs: t("workspace.imageSaveAs"),
      saveFailed: t("workspace.imageSaveFailed"),
      annotate: t("workspace.imageAnnotate"),
      discardAnnotation: t("workspace.imageDiscardAnnotation"),
      undoAnnotation: t("workspace.imageUndoAnnotation"),
      sendToChat: t("workspace.imageSendToChat"),
      sendFailed: t("workspace.imageSendFailed"),
      previousImage: t("timeline.previousImage"),
      nextImage: t("timeline.nextImage"),
      zoomIn: t("timeline.zoomIn"),
      zoomOut: t("timeline.zoomOut"),
      fitImage: t("timeline.fitImage"),
      actualSize: t("timeline.actualSize"),
      loading: t("common.loading"),
      unavailable: t("timeline.imageUnavailable")
    }}
    gallery={{ index, total: images.length, onPrevious: showPrevious, onNext: showNext }}
    showZoomControls
    returnFocus={returnFocus}
    onClose={onClose}
    onDownload={() => onDownload(current.blobId, current.fileName)}
    onImageError={markImageFailed}
    {...(onSendToChat === undefined ? {} : { onSendToChat })}
  />;
}

function DiffBlock({ item, locale, t, onArtifactDownload, onWorkspaceRewind, onOpenGeneratedFile, onOpenTurnReview }: { readonly item: TimelineItemView; readonly locale: string; readonly t: Translator; readonly onArtifactDownload: (blobId: string, fileName: string) => void; readonly onWorkspaceRewind?: (workspaceId: string, changeSetId: string) => void; readonly onOpenGeneratedFile?: (workspaceId: string, relativePath: string) => void; readonly onOpenTurnReview?: (changeSetId: string, relativePath?: string) => void }): JSX.Element {
  const diff = item.workspaceDiff;
  const changeSetId = diff?.changeSetId;
  const canOpenExactReview = changeSetId !== undefined && onOpenTurnReview !== undefined;
  return (
    <>
    {diff !== undefined && diff.workspaceId.length > 0 && onOpenGeneratedFile !== undefined && <GeneratedFilesCard files={diff.generatedFiles} t={t} onOpenFile={(relativePath) => onOpenGeneratedFile(diff.workspaceId, relativePath)} />}
    <details className="diff-block" open={diff?.files.some((file) => file.status === "conflicted") === true}>
      <summary><FileDiff aria-hidden="true" /><strong>{item.title ?? t("timeline.workspaceChanges")}</strong>{diff !== undefined && <Pill tone={diff.truncated ? "warning" : "neutral"}>{diff.files.length}</Pill>}<time>{formatDateTime(item.createdAt, locale)}</time><ChevronDown className="details-chevron" aria-hidden="true" /></summary>
      {diff === undefined ? <pre className="diff-content">{item.text ?? t("timeline.noTextDiff")}</pre> : <div className="timeline-workspace-diff">
        {canOpenExactReview && <div className="timeline-workspace-diff__actions"><Button tone="secondary" onClick={() => onOpenTurnReview(changeSetId)}><FileDiff aria-hidden="true" />{t("timeline.reviewChanges")}</Button></div>}
        {diff.files.map((file) => <section className="timeline-diff-file" key={`${file.oldPath ?? ""}:${file.path}`}><header>{canOpenExactReview ? <button className="timeline-diff-file__review" type="button" title={file.path} onClick={() => onOpenTurnReview(changeSetId, file.path)}><strong>{file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}</strong></button> : <strong>{file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}</strong>}{file.status !== undefined && <Pill tone={file.status === "conflicted" ? "danger" : "neutral"}>{file.status}</Pill>}{file.fullDiffBlobId !== undefined && <IconButton label={t("timeline.downloadArtifact", { name: `${file.path}.diff` })} onClick={() => onArtifactDownload(file.fullDiffBlobId as string, `${file.path}.diff`)}><Download aria-hidden="true" /></IconButton>}</header>{file.binary ? <p className="muted">{t("timeline.binaryDiff")}</p> : file.hunks.length === 0 ? <pre>{file.text || t("timeline.noTextDiff")}</pre> : file.hunks.map((hunk, index) => <div className="timeline-diff-hunk" key={`${hunk.oldStart}:${hunk.newStart}:${index}`}><code className="timeline-diff-hunk__heading">@@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@ {hunk.heading}</code><pre>{hunk.lines.map((line, lineIndex) => <span className={`diff-line diff-line--${line.kind}`} key={`${line.oldLine}:${line.newLine}:${lineIndex}`}><span>{line.oldLine || ""}</span><span>{line.newLine || ""}</span><code>{line.kind === "added" ? "+" : line.kind === "removed" ? "-" : line.kind === "noNewline" ? "\\" : " "}{line.text}</code></span>)}</pre></div>)}</section>)}
        {diff.truncated && <p className="inline-warning"><AlertCircle aria-hidden="true" />{t("timeline.diffTruncated")}{diff.completeDiffBlobId !== undefined && <Button tone="ghost" onClick={() => onArtifactDownload(diff.completeDiffBlobId as string, "workspace.diff")}>{t("common.download")}</Button>}</p>}
        {diff.gaps.length > 0 && <ul className="timeline-diff-gaps">{diff.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>}
        {diff.changeSetId !== undefined && diff.workspaceId.length > 0 && onWorkspaceRewind !== undefined && <Button onClick={() => onWorkspaceRewind(diff.workspaceId, diff.changeSetId as string)}><RotateCcw aria-hidden="true" />{t("timeline.previewRewind")}</Button>}
      </div>}
    </details>
    </>
  );
}

export function ErrorBlock({ item, locale, onRetry, onRecovery, recoveryContext, t }: { readonly item: TimelineItemView; readonly locale: string; readonly onRetry?: (error: ErrorView) => void; readonly onRecovery?: (error: ErrorView, action: ErrorRecoveryActionView) => void; readonly recoveryContext?: RecoveryActionContext; readonly t?: Translator }): JSX.Element {
  const error = item.error;
  const actions = error === undefined || recoveryContext === undefined ? [] : executableRecoveryActions(error, recoveryContext);
  const typedRetry = actions.some((action) => action.kind === "retry");
  const friendlyCopy = error === undefined ? undefined : timelineErrorCopy(error.code);
  const [rawOpen, setRawOpen] = useState(false);
  const title = friendlyCopy === undefined
    ? item.title ?? t?.("timeline.error") ?? "Error"
    : t?.(friendlyCopy.titleKey) ?? friendlyCopy.titleFallback;
  const message = friendlyCopy === undefined
    ? item.text ?? t?.("timeline.errorUnknownMessage") ?? "The task could not continue because of an unexpected problem."
    : t?.(friendlyCopy.messageKey) ?? friendlyCopy.messageFallback;
  const recoveryHint = friendlyCopy === undefined
    ? undefined
    : t?.(friendlyCopy.recoveryKey) ?? friendlyCopy.recoveryFallback;
  return (
    <article className={cx("timeline-error", error !== undefined && `timeline-error--${error.severity}`)} role="alert">
      <AlertCircle aria-hidden="true" />
      <div><header><strong>{title}</strong><time>{formatDateTime(item.createdAt, locale)}</time></header><p className="timeline-error__message">{message}</p>{recoveryHint !== undefined && <p className="timeline-error__recovery">{recoveryHint}</p>}{error !== undefined && <details className="timeline-error__raw" onToggle={(event) => setRawOpen(event.currentTarget.open)}><summary>{rawOpen ? t?.("timeline.hideRawError") ?? "Hide raw error" : t?.("timeline.showRawError") ?? "Show raw error"}</summary><code>{error.code}</code><pre>{error.message}</pre></details>}{error !== undefined && <small>{t?.("timeline.phase", { phase: error.phase, severity: error.severity }) ?? `${error.phase} · ${error.severity}`}</small>}</div>
      {error !== undefined && onRecovery !== undefined && actions.length > 0 && <div className="timeline-error__actions">{actions.map((action) => <Button key={action.id} tone="secondary" onClick={() => onRecovery(error, action)}><RotateCcw aria-hidden="true" />{action.label || recoveryActionLabel(action.kind, t)}</Button>)}</div>}
      {!typedRetry && error?.retryable === true && onRetry !== undefined && <Button tone="secondary" onClick={() => onRetry(error)}><RotateCcw aria-hidden="true" />{t?.("common.retry") ?? "Retry"}</Button>}
    </article>
  );
}

function recoveryActionLabel(kind: ErrorRecoveryActionView["kind"], t?: Translator): string {
  if (kind === "wait") return t?.("recovery.wait") ?? "Wait and refresh";
  if (kind === "retry") return t?.("common.retry") ?? "Retry";
  if (kind === "resnapshot") return t?.("common.refresh") ?? "Refresh";
  if (kind === "openSession") return t?.("interaction.openTask") ?? "Open task";
  if (kind === "openDiagnostics") return t?.("nav.tools") ?? "Open diagnostics";
  if (kind === "reauthenticate") return t?.("common.settings") ?? "Open settings";
  if (kind === "contactOwner") return t?.("recovery.contactOwner") ?? "Open connection settings";
  if (kind === "abort") return t?.("common.stop") ?? "Stop";
  return t?.("common.continue") ?? "Continue";
}

export function compactionTimelineCopy(item: TimelineItemView, locale: string, t: Translator): { readonly title: string; readonly detail?: string } {
  const title = item.compaction?.state === "started"
    ? t("timeline.compactionStarted")
    : item.compaction?.state === "completed"
      ? t("timeline.compactionCompleted")
      : item.compaction?.state === "noOp"
        ? t("timeline.compactionNoOp")
        : item.compaction?.state === "aborted"
          ? t("timeline.compactionAborted")
          : item.compaction?.state === "failed"
            ? t("timeline.compactionFailed")
            : t("timeline.compactionUpdated");
  if (item.text !== undefined) return { title, detail: item.text };
  const before = item.compaction?.tokensBefore;
  const after = item.compaction?.tokensAfter;
  if (before !== undefined && after !== undefined) return {
    title,
    detail: t("timeline.compactionTokens", { before: before.toLocaleString(locale), after: after.toLocaleString(locale) })
  };
  if (before !== undefined) return { title, detail: t("timeline.compactionTokensBefore", { before: before.toLocaleString(locale) }) };
  if (after !== undefined) return { title, detail: t("timeline.compactionTokensAfter", { after: after.toLocaleString(locale) }) };
  return { title };
}

const SAFE_CONTEXT_HANDOFF_HEADER = "[JOKO SAFE CONTEXT HANDOFF]";

export function contextRebuildTimelineCopy(
  item: TimelineItemView,
  t: Translator
): { readonly label: string; readonly handoffTitle: string } {
  const rebuild = item.contextRebuild;
  const label = rebuild?.reason === "promptTimeout"
    ? t("timeline.contextRebuildLabelTimeout")
    : t("timeline.contextRebuildLabelOverflow");
  const handoffTitle = rebuild?.handoff.trimStart().startsWith(SAFE_CONTEXT_HANDOFF_HEADER)
    ? t("timeline.contextRebuildHandoffTitleEnglishSource")
    : t("timeline.contextRebuildHandoffTitle");
  return { label, handoffTitle };
}

export function ContextRebuildCard({ item, t }: { readonly item: TimelineItemView; readonly t: Translator }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const handoff = item.contextRebuild?.handoff ?? "";
  const copy = contextRebuildTimelineCopy(item, t);
  return (
    <div className="context-rebuild-card" role="separator" aria-label={copy.label}>
      <div className="context-rebuild-card__separator">
        <span className="context-rebuild-card__line" aria-hidden="true" />
        <button
          type="button"
          className="context-rebuild-card__trigger"
          onClick={() => { if (handoff.length > 0) setExpanded((value) => !value); }}
          aria-expanded={expanded}
          aria-controls={handoff.length > 0 ? panelId : undefined}
          title={handoff.length > 0 ? t("timeline.contextRebuildToggleHint") : undefined}
        >
          <RefreshCw aria-hidden="true" />
          <span>{copy.label}</span>
          {handoff.length > 0 && <ChevronRight className={cx("context-rebuild-card__chevron", expanded && "is-expanded")} aria-hidden="true" />}
        </button>
        <span className="context-rebuild-card__line" aria-hidden="true" />
      </div>
      {expanded && handoff.length > 0 && (
        <div id={panelId} className="context-rebuild-card__handoff">
          <strong>{copy.handoffTitle}</strong>
          <pre>{handoff}</pre>
        </div>
      )}
    </div>
  );
}

export function summarizeRuntimeRecoveryError(detail?: string): string | undefined {
  if (detail === undefined) return undefined;
  const compact = detail
    .replace(/^\s*API Error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length === 0) return undefined;
  const firstSentence = compact.split(/(?<=[.。!?！？])\s/)[0] ?? compact;
  return firstSentence.length > 72 ? `${firstSentence.slice(0, 71)}…` : firstSentence;
}

export function RuntimeRecoveryBlock({ item, t }: { readonly item: TimelineItemView; readonly t: Translator }): JSX.Element {
  const recovery = item.runtimeRecovery;
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  if (recovery === undefined) return <></>;
  const live = recovery.state === "waiting" || recovery.state === "running";
  const succeeded = recovery.state === "succeeded";
  const failed = recovery.state === "failed" || recovery.state === "exhausted";
  const label = live
    ? t("timeline.runtimeRecoveryPending", { attempt: recovery.attempt, total: recovery.maximumAttempts })
    : succeeded
      ? t("timeline.runtimeRecoverySucceeded")
      : failed
        ? t("timeline.runtimeRecoveryFailed")
        : t("timeline.runtimeRecoveryNeutral");
  const summary = summarizeRuntimeRecoveryError(recovery.error.message);
  const canExpand = recovery.error.message.length > 0 || recovery.attempt > 0 || recovery.sessionTotal > 0;
  return (
    <div className="runtime-recovery-row" data-state={recovery.state}>
      <button
        type="button"
        className="runtime-recovery-row__trigger"
        onClick={canExpand ? () => setExpanded((value) => !value) : undefined}
        aria-expanded={canExpand ? expanded : undefined}
        aria-controls={canExpand ? panelId : undefined}
        disabled={!canExpand}
      >
        <span className="runtime-recovery-row__state" aria-hidden="true">
          {live
            ? <Spinner label={label} />
            : succeeded
              ? <Check />
              : failed
                ? <X />
                : <RefreshCw />}
        </span>
        <span className="runtime-recovery-row__label">{label}</span>
        {summary !== undefined && <span className="runtime-recovery-row__summary" title={summary}>{summary}</span>}
        <span className="runtime-recovery-row__spacer" />
        <span className="runtime-recovery-row__chevron" aria-hidden="true">
          {canExpand ? (expanded ? <ChevronDown /> : <ChevronRight />) : null}
        </span>
      </button>
      {canExpand && expanded && (
        <div id={panelId} className="runtime-recovery-row__details">
          {recovery.error.message.length > 0 && <>
            <div className="runtime-recovery-row__detail-label">{t("timeline.runtimeRecoveryReason")}</div>
            <pre>{recovery.error.message}</pre>
          </>}
          <div className="runtime-recovery-row__meta">
            <span>{t("timeline.runtimeRecoveryAttempt", { attempt: recovery.attempt, total: recovery.maximumAttempts })}</span>
            <span>{t("timeline.runtimeRecoverySessionTotal", { count: recovery.sessionTotal })}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function NoticeBlock({ item, icon, title, detail, locale, accent = false }: { readonly item: TimelineItemView; readonly icon: JSX.Element; readonly title: string; readonly detail?: string; readonly locale: string; readonly accent?: boolean }): JSX.Element {
  const body = detail ?? item.text;
  return <article className={cx("notice-block", accent && "notice-block--accent")}><span aria-hidden="true">{icon}</span><div><strong>{title}</strong>{body !== undefined && <p>{body}</p>}</div><time>{formatDateTime(item.createdAt, locale)}</time></article>;
}

function InteractionAnswerBlock({ item, t }: { readonly item: TimelineItemView; readonly t: Translator }): JSX.Element {
  const interaction = item.interaction;
  if (interaction === undefined) return <></>;
  const questions = interaction.questions.length > 0
    ? interaction.questions
    : [{ id: interaction.id, question: interaction.prompt }];
  return (
    <article className="interaction-answer" aria-label={interaction.title}>
      {questions.map((question, index) => {
        const values = question.answer?.kind === "text"
          ? question.answer.values
          : question.answer?.kind === "boolean"
            ? [question.answer.value ? t("common.yes") : t("common.no")]
            : [];
        return (
          <section key={question.id} className={cx(index > 0 && "interaction-answer__pair--divided")}>
            {question.question !== "" && <div className="interaction-answer__line"><span aria-hidden="true">Q</span><p>{question.question}</p></div>}
            <div className="interaction-answer__line interaction-answer__line--answer"><span aria-hidden="true"><Check /></span><div>{question.answer?.kind === "sensitive"
              ? <em>{t("timeline.secureAnswer")}</em>
              : values.length === 0
                ? <em>{t("timeline.skippedAnswer")}</em>
                : values.map((value, valueIndex) => <p key={valueIndex}>{value}</p>)}</div></div>
          </section>
        );
      })}
    </article>
  );
}

function BackgroundBlock({ item, locale, t }: { readonly item: TimelineItemView; readonly locale: string; readonly t: Translator }): JSX.Element {
  const task = item.background;
  const subagents = useContext(TimelineSubagentContext);
  const run = task === undefined ? undefined : subagents.runs.get(task.id);
  const detail = task === undefined ? undefined : subagents.details.get(task.id);
  if (task !== undefined && run !== undefined) return <SubagentInlineCard task={task} run={run} detail={detail} t={t} onOpen={subagents.onOpen} onStop={subagents.onStop} />;
  return (
    <article className="background-block">
      <CircleDotDashed className={task?.state === "running" ? "spin-slow" : ""} aria-hidden="true" />
      <div><strong>{task?.title ?? item.title ?? t("timeline.background")}</strong><p>{task?.detail ?? item.text}</p></div>
      {task !== undefined && <Pill tone={task.state === "failed" ? "danger" : task.state === "completed" ? "success" : "neutral"}>{task.state}</Pill>}
      <time>{formatDateTime(item.createdAt, locale)}</time>
    </article>
  );
}

function StatusBlock({ item, locale }: { readonly item: TimelineItemView; readonly locale: string }): JSX.Element {
  return <div className="status-block" role="status"><CircleDotDashed className={item.streaming ? "spin-slow" : ""} aria-hidden="true" /><span>{item.title ?? item.text ?? "…"}</span><time>{formatDateTime(item.createdAt, locale)}</time></div>;
}

function CopyButton({ text, label }: { readonly text: string; readonly label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return <IconButton className="copy-button" label={label} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }); }}>{copied ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}</IconButton>;
}

export { sessionMessageDeepLink };

function ToolIcon({ name }: { readonly name: string }): JSX.Element {
  const normalized = name.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("shell") || normalized.includes("command")) return <Terminal aria-hidden="true" />;
  if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("file")) return <FileOutput aria-hidden="true" />;
  if (normalized.includes("task") || normalized.includes("agent")) return <Box aria-hidden="true" />;
  return <Wrench aria-hidden="true" />;
}

function toolStateLabel(state: NonNullable<TimelineItemView["tool"]>["state"], t: Translator): string {
  switch (state) {
    case "requested": return t("timeline.requested");
    case "waiting": return t("timeline.waitingPermission");
    case "running": return t("timeline.running");
    case "succeeded": return t("timeline.completed");
    case "failed": return t("timeline.failed");
    case "aborted": return t("timeline.aborted");
  }
}

export function WindowedText({ text, label }: { readonly text: string; readonly label: string }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => windowedTextRows(text), [text]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 18,
    overscan: 8
  });
  if (text.length <= 16_384) return <pre>{text}</pre>;
  return (
    <div ref={scrollRef} className="windowed-output" role="region" aria-label={label} tabIndex={0}>
      <div className="windowed-output__virtual" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((row) => <pre key={row.key} ref={virtualizer.measureElement} data-index={row.index} style={{ transform: `translateY(${row.start}px)` }}>{rows[row.index]}</pre>)}
      </div>
    </div>
  );
}

export function windowedTextRows(value: string): readonly string[] {
  const rows: string[] = [];
  for (const line of value.split("\n")) {
    if (line.length === 0) rows.push(" ");
    else for (let offset = 0; offset < line.length; offset += 320) rows.push(line.slice(offset, offset + 320));
  }
  return rows.length === 0 ? [""] : rows;
}

function estimateRenderHeight(item: TimelineRenderItem | undefined): number {
  if (item?.type === "derivationOrigin") return 54;
  if (item?.type === "work") {
    if (!item.running) return 54;
    return 54 + item.visibleChildren.reduce((height, child) => height + Math.min(128, estimateHeight(child)), 0);
  }
  return estimateHeight(item?.item);
}

function estimateHeight(item: TimelineItemView | undefined): number {
  if (item === undefined) return 80;
  if (item.kind === "user" || item.kind === "assistant") return Math.min(420, 92 + (item.text?.length ?? 0) * 0.25);
  if (item.kind === "tool" || item.kind === "toolResult") return 112;
  if (item.kind === "image") return 300;
  return 76;
}

function timelineRowContains(row: HTMLElement, itemId: string): boolean {
  if (row.dataset.timelineItemId === itemId) return true;
  return row.dataset.timelineItemIds?.split(" ").includes(itemId) === true;
}

function rememberWorkGroupExpansion(key: string, expanded: boolean): void {
  if (workGroupExpansion.has(key)) workGroupExpansion.delete(key);
  workGroupExpansion.set(key, expanded);
  while (workGroupExpansion.size > 512) {
    const oldest = workGroupExpansion.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    workGroupExpansion.delete(oldest);
  }
}

function safeMarkdownComponents(
  t: Translator,
  referenceActions: TimelineReferenceActions,
  onWordFadeSettled?: (event: { readonly animationName: string; readonly currentTarget: { readonly dataset: DOMStringMap } }) => void,
  onOpenHttpLinkMenu?: (url: string, x: number, y: number) => void
): Components {
  return {
    pre: ({ children, node: _node, ...props }) => {
      const first = Array.isArray(children) ? children[0] : children;
      if (isValidElement(first)) {
        const className = (first.props as { readonly className?: string }).className;
        if (className?.split(/\s+/u).includes("language-mermaid") === true) {
          return <TimelineMermaidBlock source={timelineMarkdownNodeText((first.props as { readonly children?: ReactNode }).children).replace(/\n$/u, "")} t={t} />;
        }
        return <TimelineCodeBlock source={timelineMarkdownNodeText((first.props as { readonly children?: ReactNode }).children)} codeClassName={className} t={t} />;
      }
      return <pre {...props}>{children}</pre>;
    },
    table: ({ children, node: _node, ...props }) => <TimelineCopyAsImageBlock className="timeline-copy-block--table" contentClassName="timeline-copy-block__scroll" extractPlainText={timelineTableToTsv} t={t}>
      <table {...props}>{children}</table>
    </TimelineCopyAsImageBlock>,
    span: ({ children, className, node: _node, ...props }) => {
      const wordFadeKey = (props as Record<string, unknown>)["data-wf-key"];
      const content = <span
        className={className}
        {...props}
        onAnimationEnd={typeof wordFadeKey === "string" && onWordFadeSettled !== undefined
          ? (event) => onWordFadeSettled(event)
          : undefined}
      >{children}</span>;
      return className?.split(/\s+/u).includes("katex-display") === true
        ? <TimelineCopyAsImageBlock className="timeline-copy-block--math" extractPlainText={timelineMathToLatex} t={t}>{content}</TimelineCopyAsImageBlock>
        : content;
    },
    a: ({ children, href, node: _node, ...props }) => {
      return <TimelineMarkdownLink href={href} actions={referenceActions} onOpenHttpLinkMenu={onOpenHttpLinkMenu} anchorProps={props}>{children}</TimelineMarkdownLink>;
    },
    img: ({ src, alt }) => <TimelineMarkdownImage src={src} alt={alt} actions={referenceActions} t={t} onOpenHttpLinkMenu={onOpenHttpLinkMenu} />
  };
}

function timelineMarkdownNodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return String(node);
  if (Array.isArray(node)) return node.map(timelineMarkdownNodeText).join("");
  return isValidElement(node) ? timelineMarkdownNodeText((node.props as { readonly children?: ReactNode }).children) : "";
}

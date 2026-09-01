import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, JSX, KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlignJustify,
  AlertTriangle,
  Bot,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Columns2,
  File,
  FileCode2,
  FileDiff,
  FileSearch,
  FileText,
  FoldVertical,
  Folder,
  FolderOpen,
  Gauge,
  GitBranch,
  GitCommitHorizontal,
  Globe2,
  Image as ImageIcon,
  ListTodo,
  ListTree,
  Maximize2,
  Minimize2,
  Minus,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  Plus,
  RefreshCcw,
  Search,
  ShieldAlert,
  SquareArrowOutUpRight,
  Square,
  Terminal,
  Undo2,
  Upload,
  UnfoldVertical,
  WrapText,
  Wrench,
  X
} from "lucide-react";
import type { AppController, BrowserInspectorFocusRequest } from "../controller.js";
import { useLiveBrowserTakeover, withLiveBrowserTakeover } from "../browser-takeover-expiry.js";
import { browserPageKey } from "../browser-page-key.js";
import type { AppSnapshot, BackendView, BackgroundTaskHistoryView, BrowserView, ComposerFileSelectionQuoteDraft, ComposerSelectionQuoteDraft, NativeSessionTreeNodeView, NativeSessionTreeView, QueueItemView, ResourceView, RuntimeToolCatalogView, SessionView, TimelineItemView, WorkspaceChangeSetView, WorkspaceDiffHunkView, WorkspaceDiffImageView, WorkspaceDiffView, WorkspaceEntryView, WorkspaceFileDiffView, WorkspaceFilePreviewView, WorkspaceGitPushResultView, WorkspaceRewindPreviewView, WorkspaceSearchMatchView, WorkspaceSearchPageView, WorkspaceView } from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { INSPECTOR_DEFAULT_RATIO, INSPECTOR_MIN_WIDTH, SESSION_MAIN_MIN_WIDTH, inspectorPointerWidth, inspectorRatioForWidth, inspectorResizeDeltaForKey, inspectorWidthForRatio, normalizeInspectorRatio, type InspectorSide } from "./inspector-resize.js";
import {
  activateInspectorTab,
  addInspectorTab,
  closeInspectorTab,
  closeOtherInspectorTabs,
  closeVisibleInspectorTabs,
  createInitialInspectorTabBucket,
  cycleInspectorTabId,
  moveVisibleInspectorTab,
  parseInspectorTabBuckets,
  projectInspectorTabBucket,
  reorderVisibleInspectorTabs,
  serializeInspectorTabBuckets,
  type InspectorTabBucket,
  type InspectorTabBuckets,
  type InspectorTabKind,
  type InspectorTabState
} from "./inspector-tabs.js";
import { AuthenticatedImage, Button, IconButton, Modal, Pill, Spinner, StatusDot, cx, formatRelativeTime, CheckboxControl, SelectControl } from "./ui.js";
import { currentAppShortcutPlatform } from "../app-shortcuts.js";
import { useAppShortcut } from "../use-app-shortcut.js";
import { isSessionApplicationWindow } from "../session-window-navigation.js";
import { CLIENT_LAYOUT_RESET_EVENT } from "../client-layout-reset.js";
import { installCurrentWindowActivationClickGuard } from "../window-activation-click.js";
import { formatCompactUsageTokens, resolveSessionUsageDisplay } from "./session-usage.js";
import { StreamingMarkdown, WindowedText } from "./Timeline.js";
import { SelectionQuoteButton } from "./SelectionQuoteButton.js";
import { WorkspaceFileEditorPane, type WorkspaceFileEditorPaneHandle } from "./WorkspaceFileEditorPane.js";
import { isWorkspaceFileStaleError } from "./workspace-file-editor.js";
import { BackgroundTasksPanel } from "./BackgroundTasksPanel.js";
import { SubagentsPanel } from "./SubagentsPanel.js";
import { InspectorTabErrorBoundary } from "./InspectorTabErrorBoundary.js";
import { BrowserCanvas } from "./ToolsPage.js";
import { BrowserLostPageCard, BrowserPageRail } from "./BrowserPageRail.js";
import { resolveComposerAttachmentPolicy } from "./composer-behavior.js";
import { WorkspaceTextEditor, type WorkspaceEditorSelection, type WorkspaceTextEditorHandle } from "./WorkspaceTextEditor.js";
import { buildReviewDiffTree, buildReviewSplitRows, filterReviewFileJumpResults, filterReviewFiles, flattenReviewDiffTree, inlineWordDiff, isPreviewableReviewImageDiff, isReviewMarkdownPath, isSafeReviewRef, moveReviewFileJumpSelection, reviewFileKey, type InlineWordSegment, type ReviewDiffTreeFlatNode, type ReviewDiffTreeNode, type ReviewSplitRow } from "./review-diff.js";
import { latestTurnChangeSets, loadReviewSourceDiff } from "./review-data.js";
import { reviewSourceCapabilities, type ReviewSourceDescriptor } from "./review-source.js";
import { reviewGitWriteBlock } from "./review-write-gate.js";
import { selectedTurnReviewFile, type InspectorTurnReviewRequest } from "./inspector-review-focus.js";
import { useInspectorTreeNavigation } from "./inspector-tree-navigation.js";
import {
  getExpandedReviewFileKeys,
  getReviewDiffExpansionAction,
  getReviewDiffsExpanded,
  seedReviewDiffsExpanded,
  setReviewDiffsExpanded,
  shouldShowReviewFileTree,
  shouldVirtualizeReviewDiffRows,
  shouldVirtualizeReviewFileList
} from "./review-diff-expansion.js";
import {
  detachedInspectorHostAlive,
  initializeDetachedInspectorHost,
  inspectorDetachAvailable,
  openDetachedInspectorWindow,
  syncDetachedInspectorDocument,
  type DetachedInspectorHost
} from "./inspector-detach.js";

const INSPECTOR_RATIO_KEY = "joko.session.inspectorRatio";
const INSPECTOR_TABS_KEY = "joko.session.inspectorTabs.v1";
const INSPECTOR_SIDE_KEY = "joko.session.inspectorSide";
const INSPECTOR_WORKSPACE_SEARCH_PAGE_SIZE = 500;
const INSPECTOR_WORKSPACE_SEARCH_MAX_PAGES = 10_000;

type InspectorMenu = "add" | "more";

export function Inspector({ controller, snapshot, session, workspace, timeline, open, subagentFocusRequest, turnReviewFocusRequest, browserFocusRequest, t, runAction, onClose, onDetachedChange, onSelectionQuote }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly session: SessionView;
  readonly workspace?: WorkspaceView;
  readonly timeline: readonly TimelineItemView[];
  readonly open: boolean;
  readonly subagentFocusRequest?: { readonly sessionId: string; readonly runId: string; readonly requestId: number };
  readonly turnReviewFocusRequest?: InspectorTurnReviewRequest;
  readonly browserFocusRequest?: BrowserInspectorFocusRequest;
  readonly t: Translator;
  readonly runAction: RunAction;
  readonly onClose: () => void;
  readonly onDetachedChange?: (detached: boolean) => void;
  readonly onSelectionQuote: (sessionId: string, quote: ComposerFileSelectionQuoteDraft) => void;
}): JSX.Element {
  const [tabBuckets, setTabBuckets] = useState<InspectorTabBuckets>(readInspectorTabBuckets);
  const [panelSide, setPanelSide] = useState<InspectorSide>(readInspectorSide);
  const [maximized, setMaximized] = useState(false);
  const [menu, setMenu] = useState<InspectorMenu>();
  const addMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const moreMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuPopoverRef = useRef<HTMLDivElement>(null);
  const [draggedTabId, setDraggedTabId] = useState<string>();
  const [detachedHost, setDetachedHost] = useState<DetachedInspectorHost>();
  const detachedHostRef = useRef<DetachedInspectorHost | undefined>(undefined);
  const onDetachedChangeRef = useRef(onDetachedChange);
  onDetachedChangeRef.current = onDetachedChange;
  const inspectorRef = useRef<HTMLElement>(null);
  const lastMainWindowInteractionRef = useRef(false);
  const lastDetachedWindowInteractionRef = useRef(false);
  const ratioRef = useRef(readInspectorRatio());
  const [inspectorWidth, setInspectorWidth] = useState(INSPECTOR_MIN_WIDTH);
  const [inspectorMaximum, setInspectorMaximum] = useState(INSPECTOR_MIN_WIDTH);
  const [resizeOrigin, setResizeOrigin] = useState<{ readonly anchor: number; readonly available: number; readonly side: InspectorSide }>();
  const [runtimeToolCatalog, setRuntimeToolCatalog] = useState<RuntimeToolCatalogView>();
  const [runtimeToolState, setRuntimeToolState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [runtimeToolError, setRuntimeToolError] = useState<string>();
  const [runtimeToolRefresh, setRuntimeToolRefresh] = useState(0);
  const [backgroundHistory, setBackgroundHistory] = useState<readonly BackgroundTaskHistoryView[]>([]);
  const [backgroundHistoryState, setBackgroundHistoryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [backgroundHistoryError, setBackgroundHistoryError] = useState<string>();
  const [backgroundHistoryRefresh, setBackgroundHistoryRefresh] = useState(0);
  const inspectorControllerRef = useRef(controller);
  inspectorControllerRef.current = controller;
  const inspectorMinimum = Math.min(INSPECTOR_MIN_WIDTH, inspectorMaximum);
  const sessionQueue = snapshot.queue.filter((item) => item.sessionId === session.id);
  const tasks = timeline.flatMap((item) => item.background === undefined ? [] : [item.background]);
  const toolItems = timeline.filter((item) => item.tool !== undefined);
  const backend = snapshot.backends.find((candidate) => candidate.id === session.backendId);
  const canFiles = backend?.capabilities.get("workspace.files")?.supported === true;
  const canWriteFiles = backend?.capabilities.get("workspace.files.write")?.supported === true;
  const canTree = backend?.capabilities.get("session.tree")?.supported === true;
  const canBackgroundTasks = backend?.capabilities.get("background.tasks")?.supported === true;
  const canCancelBackgroundTasks = backend?.capabilities.get("background.tasks.cancel")?.supported === true;
  const canSubagents = backend?.capabilities.get("subagents.list")?.supported === true
    && backend.capabilities.get("subagents.detail")?.supported === true;
  const canRuntimeTools = backend?.capabilities.get("runtime.tools")?.supported === true;
  const canUserShell = backend?.capabilities.get("runtime.user_shell")?.supported === true;
  const canDiff = backend?.capabilities.get("workspace.diff.sources")?.supported === true;
  const canDiffImagePreview = backend?.capabilities.get("workspace.diff.image_preview")?.supported === true;
  const canStageDiff = backend?.capabilities.get("workspace.diff.stage")?.supported === true;
  const canUnstageDiff = backend?.capabilities.get("workspace.diff.unstage")?.supported === true;
  const canRevertDiff = backend?.capabilities.get("workspace.diff.revert")?.supported === true;
  const canCommitDiff = backend?.capabilities.get("workspace.diff.commit")?.supported === true;
  const canPushDiff = backend?.capabilities.get("workspace.diff.push")?.supported === true;
  const canRewind = backend?.capabilities.get("workspace.rewind")?.supported === true;
  const gitWriteBlock = workspace === undefined
    ? undefined
    : reviewGitWriteBlock(snapshot.sessions, snapshot.queue, workspace.targetId);
  const gitWriteDisabledReason = workspace?.detachedHead === true
    ? t("workspace.reviewWriteBlockedDetached")
    : workspace !== undefined && workspace.head === undefined
      ? t("workspace.reviewWriteBlockedUnborn")
      : workspace !== undefined && flattenEntries(workspace.entries).some((entry) => entry.status === "conflicted")
        ? t("workspace.reviewWriteBlockedUnmerged")
        : workspace?.operationInProgress === true
          ? t("workspace.reviewWriteBlockedInProgress")
          : gitWriteBlock === "agent-running"
            ? t("workspace.reviewWriteBlockedAgent")
            : gitWriteBlock === "queued-work"
              ? t("workspace.reviewWriteBlockedQueue")
              : undefined;
  const canBrowser = snapshot.browsers.length > 0 || snapshot.settings.browsers.length > 0;
  const bridgeRouted = snapshot.settings.visionBridge.enabled && session.model !== undefined
    && snapshot.settings.visionBridge.targetModels.some((target) => target.backendId === session.backendId && target.providerId === session.model?.providerId && target.modelId === session.model.modelId);
  const browserCommentSessions = resolveComposerAttachmentPolicy(
    backend,
    session.model?.supportsImages === true || bridgeRouted
  ).images ? [session] : [];
  const canDetach = !isSessionApplicationWindow(window.location) && inspectorDetachAvailable(window.jokoDesktop);
  const activeDetachedHost = detachedInspectorHostAlive(detachedHost) ? detachedHost : undefined;
  const detached = activeDetachedHost !== undefined;
  const availableKinds = useMemo(() => new Set<InspectorTabKind>([
    "context",
    ...(canTree ? ["branches" as const] : []),
    ...(canFiles ? ["files" as const] : []),
    ...(canDiff || canRewind ? ["changes" as const] : []),
    ...(canBackgroundTasks ? ["background" as const] : []),
    ...(canSubagents ? ["subagents" as const] : []),
    ...(canUserShell ? ["terminal" as const] : []),
    "tools",
    ...(canBrowser ? ["browser" as const] : [])
  ]), [canBackgroundTasks, canBrowser, canDiff, canFiles, canRewind, canSubagents, canTree, canUserShell]);
  const storedBucket = tabBuckets[session.id] ?? createInitialInspectorTabBucket();
  const bucket = useMemo(() => projectInspectorTabBucket(storedBucket, availableKinds), [availableKinds, storedBucket]);
  const activeTab = bucket.tabs.find((tab) => tab.id === bucket.activeTabId);
  const visibleTabIds = useMemo(() => new Set(bucket.tabs.map((tab) => tab.id)), [bucket.tabs]);
  const addableKinds = inspectorTabKindsInMenuOrder().filter((kind) => availableKinds.has(kind) && !bucket.tabs.some((tab) => tab.kind === kind));

  useEffect(() => {
    setRuntimeToolCatalog(undefined);
    setRuntimeToolState("idle");
    setRuntimeToolError(undefined);
  }, [session.id]);

  useEffect(() => {
    if (!open || activeTab?.kind !== "tools" || !canRuntimeTools) return;
    let cancelled = false;
    setRuntimeToolState("loading");
    setRuntimeToolError(undefined);
    void inspectorControllerRef.current.listRuntimeTools(session.id).then((catalog) => {
      if (cancelled) return;
      setRuntimeToolCatalog(catalog);
      setRuntimeToolState("ready");
    }).catch((error: unknown) => {
      if (cancelled) return;
      setRuntimeToolCatalog(undefined);
      setRuntimeToolError(messageOf(error));
      setRuntimeToolState("error");
    });
    return () => { cancelled = true; };
  }, [activeTab?.kind, canRuntimeTools, open, runtimeToolRefresh, session.id]);

  useEffect(() => {
    setBackgroundHistory([]);
    setBackgroundHistoryState("idle");
    setBackgroundHistoryError(undefined);
  }, [session.id]);

  useEffect(() => {
    if (!open || activeTab?.kind !== "background" || !canBackgroundTasks) return;
    let cancelled = false;
    setBackgroundHistoryState("loading");
    setBackgroundHistoryError(undefined);
    void inspectorControllerRef.current.listBackgroundTasks(session.id).then((tasks) => {
      if (cancelled) return;
      setBackgroundHistory(tasks);
      setBackgroundHistoryState("ready");
    }).catch((error: unknown) => {
      if (cancelled) return;
      setBackgroundHistoryError(messageOf(error));
      setBackgroundHistoryState("error");
    });
    return () => { cancelled = true; };
  }, [activeTab?.kind, backgroundHistoryRefresh, canBackgroundTasks, open, session.id]);

  const setSessionBucket = useCallback((next: InspectorTabBucket): void => {
    setTabBuckets((current) => ({ ...current, [session.id]: next }));
  }, [session.id]);

  useEffect(() => {
    if (!canSubagents || subagentFocusRequest === undefined || subagentFocusRequest.sessionId !== session.id) return;
    setTabBuckets((current) => {
      const currentBucket = current[session.id] ?? createInitialInspectorTabBucket();
      return { ...current, [session.id]: addInspectorTab(currentBucket, "subagents") };
    });
  }, [canSubagents, session.id, subagentFocusRequest?.requestId]);

  useEffect(() => {
    if (!canDiff || turnReviewFocusRequest === undefined || turnReviewFocusRequest.sessionId !== session.id) return;
    setTabBuckets((current) => {
      const currentBucket = current[session.id] ?? createInitialInspectorTabBucket();
      return { ...current, [session.id]: addInspectorTab(currentBucket, "changes") };
    });
  }, [canDiff, session.id, turnReviewFocusRequest?.requestId]);

  useEffect(() => {
    if (!canBrowser || browserFocusRequest === undefined || browserFocusRequest.sessionId !== session.id) return;
    setTabBuckets((current) => {
      const currentBucket = current[session.id] ?? createInitialInspectorTabBucket();
      return { ...current, [session.id]: addInspectorTab(currentBucket, "browser") };
    });
  }, [browserFocusRequest?.requestId, canBrowser, session.id]);

  useEffect(() => {
    try { window.localStorage.setItem(INSPECTOR_TABS_KEY, serializeInspectorTabBuckets(tabBuckets)); } catch { /* Client storage can be unavailable. */ }
  }, [tabBuckets]);

  const clearDetachedHost = useCallback((): void => {
    if (detachedHostRef.current === undefined) return;
    detachedHostRef.current = undefined;
    setDetachedHost(undefined);
    onDetachedChangeRef.current?.(false);
  }, []);

  useEffect(() => {
    const desktop = window.jokoDesktop;
    if (desktop === undefined || !inspectorDetachAvailable(desktop)) return;
    return desktop.inspectorWindow.onClosed(clearDetachedHost);
  }, [clearDetachedHost]);

  useEffect(() => {
    return () => {
      const host = detachedHostRef.current;
      detachedHostRef.current = undefined;
      onDetachedChangeRef.current?.(false);
      if (host !== undefined && !host.window.closed) {
        void host.window.jokoInspectorDesktop?.window.close().catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (open || activeDetachedHost === undefined) return;
    void activeDetachedHost.window.jokoInspectorDesktop?.window.close().catch(clearDetachedHost);
  }, [activeDetachedHost, clearDetachedHost, detached, open]);

  useEffect(() => {
    if (activeDetachedHost === undefined) return;
    const closed = (): void => clearDetachedHost();
    activeDetachedHost.window.addEventListener("pagehide", closed, { once: true });
    return () => activeDetachedHost.window.removeEventListener("pagehide", closed);
  }, [activeDetachedHost, clearDetachedHost]);

  useEffect(() => {
    if (activeDetachedHost === undefined) return;
    return installCurrentWindowActivationClickGuard(activeDetachedHost.window);
  }, [activeDetachedHost]);

  useLayoutEffect(() => {
    if (activeDetachedHost === undefined) return;
    syncDetachedInspectorDocument(activeDetachedHost.window, document);
    activeDetachedHost.window.document.title = t("inspector.windowTitle");
  });

  useEffect(() => {
    try { window.localStorage.setItem(INSPECTOR_SIDE_KEY, panelSide); } catch { /* Client storage can be unavailable. */ }
  }, [panelSide]);

  useEffect(() => {
    setMenu(undefined);
    setDraggedTabId(undefined);
  }, [session.id]);

  useEffect(() => {
    if (open) return;
    setMaximized(false);
    setMenu(undefined);
  }, [open]);

  useEffect(() => {
    if (bucket.activeTabId === undefined || bucket.activeTabId === storedBucket.activeTabId) return;
    setSessionBucket(activateInspectorTab(storedBucket, bucket.activeTabId));
  }, [bucket.activeTabId, setSessionBucket, storedBucket]);

  useEffect(() => {
    if (menu === undefined) return;
    const ownerDocument = activeDetachedHost?.window.document ?? document;
    const ownerElement = ownerDocument.defaultView?.Element;
    const ownerHTMLElement = ownerDocument.defaultView?.HTMLElement;
    const trigger = menu === "add" ? addMenuTriggerRef.current : moreMenuTriggerRef.current;
    const enabledItems = (): HTMLButtonElement[] => {
      const popover = menuPopoverRef.current;
      if (popover === null || ownerHTMLElement === undefined) return [];
      return [...popover.querySelectorAll('[role="menuitem"]')]
        .filter((candidate): candidate is HTMLButtonElement => candidate instanceof ownerHTMLElement && candidate.tagName === "BUTTON" && !candidate.hasAttribute("disabled"));
    };
    const restoreTriggerFocus = (): void => queueMicrotask(() => trigger?.focus());
    queueMicrotask(() => enabledItems()[0]?.focus());
    const closeOnOutsidePointer = (event: MouseEvent): void => {
      const target = event.target;
      if (ownerElement !== undefined && target instanceof ownerElement && target.closest(".inspector-menu") !== null) return;
      setMenu(undefined);
    };
    const handleMenuKeyboard = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(undefined);
        restoreTriggerFocus();
        return;
      }
      if (event.key === "Tab") {
        setMenu(undefined);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const popover = menuPopoverRef.current;
      if (ownerElement === undefined || !(event.target instanceof ownerElement) || popover?.contains(event.target) !== true) return;
      const items = enabledItems();
      if (items.length === 0) return;
      event.preventDefault();
      const currentIndex = items.findIndex((item) => item === ownerDocument.activeElement);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (currentIndex + 1 + items.length) % items.length
            : (currentIndex - 1 + items.length) % items.length;
      items[nextIndex]?.focus();
    };
    ownerDocument.addEventListener("mousedown", closeOnOutsidePointer, true);
    ownerDocument.addEventListener("keydown", handleMenuKeyboard, true);
    return () => {
      ownerDocument.removeEventListener("mousedown", closeOnOutsidePointer, true);
      ownerDocument.removeEventListener("keydown", handleMenuKeyboard, true);
    };
  }, [activeDetachedHost, menu]);

  useEffect(() => trackInspectorShortcutTerritory(window, lastMainWindowInteractionRef), []);
  useEffect(() => activeDetachedHost === undefined
    ? undefined
    : trackInspectorShortcutTerritory(activeDetachedHost.window, lastDetachedWindowInteractionRef), [activeDetachedHost]);

  const applyWidth = useCallback((ratio: number): void => {
    const available = inspectorAvailableWidth(inspectorRef.current);
    const width = inspectorWidthForRatio(available, ratio);
    ratioRef.current = inspectorRatioForWidth(available, width);
    document.documentElement.style.setProperty("--inspector-width", `${width}px`);
    setInspectorWidth(width);
    setInspectorMaximum(Math.max(0, available - SESSION_MAIN_MIN_WIDTH));
  }, []);

  useEffect(() => {
    const resetLayout = (): void => {
      ratioRef.current = INSPECTOR_DEFAULT_RATIO;
      setPanelSide("right");
      setMaximized(false);
      applyWidth(INSPECTOR_DEFAULT_RATIO);
    };
    window.addEventListener(CLIENT_LAYOUT_RESET_EVENT, resetLayout);
    return () => window.removeEventListener(CLIENT_LAYOUT_RESET_EVENT, resetLayout);
  }, [applyWidth]);

  useLayoutEffect(() => {
    if (detached) return;
    const resize = (): void => applyWidth(ratioRef.current);
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [applyWidth, detached]);

  useEffect(() => {
    if (resizeOrigin === undefined) return;
    const move = (event: PointerEvent): void => {
      const desiredWidth = inspectorPointerWidth(resizeOrigin.anchor, event.clientX, resizeOrigin.side);
      const width = inspectorWidthForRatio(resizeOrigin.available, desiredWidth / resizeOrigin.available);
      const ratio = inspectorRatioForWidth(resizeOrigin.available, width);
      ratioRef.current = ratio;
      document.documentElement.style.setProperty("--inspector-width", `${width}px`);
      setInspectorWidth(width);
    };
    const stop = (): void => {
      try { window.localStorage.setItem(INSPECTOR_RATIO_KEY, String(ratioRef.current)); } catch { /* Client storage can be unavailable. */ }
      setResizeOrigin(undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizeOrigin]);

  const resizeByKeyboard = (nextWidth: number): void => {
    const available = inspectorAvailableWidth(inspectorRef.current);
    const ratio = inspectorRatioForWidth(available, nextWidth);
    applyWidth(ratio);
    try { window.localStorage.setItem(INSPECTOR_RATIO_KEY, String(ratioRef.current)); } catch { /* Client storage can be unavailable. */ }
  };

  const closeTab = (tabId: string): void => {
    const next = closeInspectorTab(storedBucket, tabId);
    const visibleNext = projectInspectorTabBucket(next, availableKinds);
    setSessionBucket(next);
    if (visibleNext.tabs.length === 0) {
      setMaximized(false);
      onClose();
    } else if (visibleNext.activeTabId !== undefined) {
      focusInspectorTab(visibleNext.activeTabId);
    }
  };

  const closeOtherTabs = (tabId: string): void => {
    setSessionBucket(closeOtherInspectorTabs(storedBucket, tabId, visibleTabIds));
    setMenu(undefined);
  };

  const closeAllTabs = (): void => {
    setSessionBucket(closeVisibleInspectorTabs(storedBucket, visibleTabIds));
    setMenu(undefined);
    setMaximized(false);
    onClose();
  };

  const focusInspectorTab = (tabId: string): void => {
    queueMicrotask(() => {
      const ownerDocument = inspectorRef.current?.ownerDocument;
      const candidate = ownerDocument?.getElementById(`inspector-tab-${tabId}`);
      const buttonConstructor = ownerDocument?.defaultView?.HTMLButtonElement;
      if (buttonConstructor !== undefined && candidate instanceof buttonConstructor && inspectorRef.current?.contains(candidate) === true) candidate.focus();
    });
  };

  const activateTab = (tabId: string, focus = false): void => {
    setSessionBucket(activateInspectorTab(storedBucket, tabId));
    if (focus) focusInspectorTab(tabId);
  };

  const cycleTabsFromShortcut = (direction: -1 | 1): boolean => {
    if (document.body.classList.contains("modal-open")) return false;
    // Consume these application shortcuts while the right-side shell
    // exists even when it is collapsed or has only one tab.
    if (!open || bucket.tabs.length < 2) return true;
    const nextId = cycleInspectorTabId(bucket.tabs, bucket.activeTabId, direction);
    if (nextId !== undefined) activateTab(nextId);
    return true;
  };

  const closeFromShortcut = (
    ownerWindow: Window,
    lastInteractionRef: { readonly current: boolean },
    event: KeyboardEvent
  ): boolean => {
    const ownerDocument = ownerWindow.document;
    if (ownerDocument.body.classList.contains("modal-open")) return false;
    const target = eventElementInWindow(ownerWindow, event.target);
    const activeElement = ownerDocument.activeElement;
    const userInInspector = target?.closest(".inspector") != null
      || activeElement !== null && activeElement !== ownerDocument.body && activeElement.closest(".inspector") !== null
      || (activeElement === ownerDocument.body && lastInteractionRef.current);
    if (open && userInInspector && bucket.activeTabId !== undefined) {
      closeTab(bucket.activeTabId);
      return true;
    }
    if (currentAppShortcutPlatform() !== "darwin") return false;
    if (ownerWindow === activeDetachedHost?.window) {
      const api = activeDetachedHost.window.jokoInspectorDesktop;
      if (api === undefined) return false;
      void api.window.close().catch(() => undefined);
      return true;
    }
    const desktop = window.jokoDesktop;
    if (desktop === undefined) return false;
    void desktop.window.close().catch(() => undefined);
    return true;
  };

  const shortcutOverrides = controller.state.preferences.appShortcutOverrides;
  useAppShortcut("right-tab-prev", shortcutOverrides, () => cycleTabsFromShortcut(-1), { stopImmediate: true });
  useAppShortcut("right-tab-next", shortcutOverrides, () => cycleTabsFromShortcut(1), { stopImmediate: true });
  useAppShortcut("right-tab-prev", shortcutOverrides, () => cycleTabsFromShortcut(-1), {
    enabled: activeDetachedHost !== undefined,
    stopImmediate: true,
    target: activeDetachedHost?.window ?? null
  });
  useAppShortcut("right-tab-next", shortcutOverrides, () => cycleTabsFromShortcut(1), {
    enabled: activeDetachedHost !== undefined,
    stopImmediate: true,
    target: activeDetachedHost?.window ?? null
  });
  useAppShortcut("close-tab-or-window", shortcutOverrides, (event) => closeFromShortcut(window, lastMainWindowInteractionRef, event), {
    enabled: open && activeDetachedHost === undefined
  });
  useAppShortcut("close-tab-or-window", shortcutOverrides, (event) => activeDetachedHost === undefined
    ? false
    : closeFromShortcut(activeDetachedHost.window, lastDetachedWindowInteractionRef, event), {
    enabled: activeDetachedHost !== undefined,
    target: activeDetachedHost?.window ?? null
  });

  const handleTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      setSessionBucket(moveVisibleInspectorTab(storedBucket, bucket.tabs, tabId, event.key === "ArrowLeft" ? -1 : 1));
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const nextId = cycleInspectorTabId(bucket.tabs, tabId, event.key === "ArrowLeft" ? -1 : 1);
      if (nextId !== undefined) activateTab(nextId, true);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const nextId = event.key === "Home" ? bucket.tabs[0]?.id : bucket.tabs.at(-1)?.id;
      if (nextId !== undefined) activateTab(nextId, true);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      closeTab(tabId);
    }
  };

  const dropTab = (event: ReactDragEvent<HTMLDivElement>, targetTabId: string): void => {
    event.preventDefault();
    if (draggedTabId === undefined || draggedTabId === targetTabId) return;
    const orderedIds = bucket.tabs.map((tab) => tab.id).filter((id) => id !== draggedTabId);
    const targetIndex = orderedIds.indexOf(targetTabId);
    if (targetIndex < 0) return;
    const afterTarget = event.clientX >= event.currentTarget.getBoundingClientRect().left + event.currentTarget.clientWidth / 2;
    orderedIds.splice(targetIndex + (afterTarget ? 1 : 0), 0, draggedTabId);
    setSessionBucket(reorderVisibleInspectorTabs(storedBucket, orderedIds));
    setDraggedTabId(undefined);
  };

  const detachInspector = (): void => {
    runAction("inspector-detach", async () => {
      if (!canDetach || detachedHostRef.current !== undefined) return;
      const child = openDetachedInspectorWindow();
      if (child === null) throw new Error(t("inspector.detachUnavailable"));
      let host: DetachedInspectorHost;
      try {
        host = initializeDetachedInspectorHost(child, document, t("inspector.windowTitle"));
      } catch (error) {
        void child.jokoInspectorDesktop?.window.close().catch(() => child.close());
        throw error;
      }
      detachedHostRef.current = host;
      setDetachedHost(host);
      setMaximized(false);
      setMenu(undefined);
      onDetachedChangeRef.current?.(true);
      try {
        // A visible main-window animation frame is the commit boundary for the
        // portal. Only then let Electron reveal the initially hidden child.
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        if (detachedHostRef.current !== host) return;
        await host.window.jokoInspectorDesktop?.window.ready();
      } catch (error) {
        clearDetachedHost();
        void host.window.jokoInspectorDesktop?.window.close().catch(() => host.window.close());
        throw error;
      }
    });
  };

  const reattachInspector = (): void => {
    const host = detachedHostRef.current;
    if (host === undefined) return;
    runAction("inspector-reattach", async () => {
      const api = host.window.jokoInspectorDesktop;
      if (api === undefined) {
        clearDetachedHost();
        return;
      }
      await api.window.close();
    });
  };

  const closeInspector = (): void => {
    setMaximized(false);
    setMenu(undefined);
    onClose();
  };

  const inspector = (
    <aside ref={inspectorRef} className={cx("inspector", open && "is-open", panelSide === "left" && "is-left", maximized && "is-maximized", detached && "is-detached")} aria-label={t("a11y.openInspector")} aria-hidden={!open} inert={!open}>
      {!detached && <div
        className="inspector__resize"
        role="separator"
        tabIndex={open && !maximized ? 0 : -1}
        aria-label={t("a11y.resizeInspector")}
        aria-orientation="vertical"
        aria-valuemin={inspectorMinimum}
        aria-valuemax={inspectorMaximum}
        aria-valuenow={inspectorWidth}
        onPointerDown={(event) => {
          if (maximized || event.button !== 0) return;
          event.preventDefault();
          const bounds = inspectorRef.current?.getBoundingClientRect();
          if (bounds === undefined) return;
          setResizeOrigin({ anchor: panelSide === "right" ? bounds.right : bounds.left, available: inspectorAvailableWidth(inspectorRef.current), side: panelSide });
        }}
        onDoubleClick={() => resizeByKeyboard(inspectorWidthForRatio(inspectorAvailableWidth(inspectorRef.current), INSPECTOR_DEFAULT_RATIO))}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resizeByKeyboard(inspectorWidth + inspectorResizeDeltaForKey(panelSide, event.key, event.shiftKey)); }
          if (event.key === "Home") { event.preventDefault(); resizeByKeyboard(inspectorWidthForRatio(inspectorAvailableWidth(inspectorRef.current), INSPECTOR_DEFAULT_RATIO)); }
          if (event.key === "End") { event.preventDefault(); resizeByKeyboard(inspectorMaximum); }
        }}
      />}
      <header className="inspector__header" data-panel-drag-handle="">
        <div className="inspector-tabs" role="tablist" aria-label={t("a11y.inspectorTabs")}>
          {bucket.tabs.map((tab) => <InspectorTabPill
            key={tab.id}
            tab={tab}
            active={tab.id === bucket.activeTabId}
            label={inspectorTabLabel(tab.kind, t)}
            closeLabel={t("inspector.closeNamedTab", { name: inspectorTabLabel(tab.kind, t) })}
            onActivate={() => activateTab(tab.id)}
            onClose={() => closeTab(tab.id)}
            onKeyDown={(event) => handleTabKey(event, tab.id)}
            onDragStart={(event) => {
              setDraggedTabId(tab.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", tab.id);
            }}
            onDragEnd={() => setDraggedTabId(undefined)}
            onDrop={(event) => dropTab(event, tab.id)}
          />)}
        </div>
        <div className="inspector-menu">
          <IconButton buttonRef={addMenuTriggerRef} label={t("inspector.addTab")} aria-haspopup="menu" aria-expanded={menu === "add"} disabled={addableKinds.length === 0} onClick={() => setMenu((current) => current === "add" ? undefined : "add")}><Plus aria-hidden="true" /></IconButton>
          {menu === "add" && <div ref={menuPopoverRef} className="inspector-menu__popover" role="menu" aria-label={t("inspector.addTab")}>
            {addableKinds.map((kind) => <button key={kind} type="button" role="menuitem" onClick={() => { setSessionBucket(addInspectorTab(storedBucket, kind)); setMenu(undefined); }}>{inspectorTabIcon(kind)}<span>{inspectorTabLabel(kind, t)}</span></button>)}
          </div>}
        </div>
        <div className="inspector-menu">
          <IconButton buttonRef={moreMenuTriggerRef} label={t("a11y.inspectorTabActions")} aria-haspopup="menu" aria-expanded={menu === "more"} onClick={() => setMenu((current) => current === "more" ? undefined : "more")}><MoreHorizontal aria-hidden="true" /></IconButton>
          {menu === "more" && <div ref={menuPopoverRef} className="inspector-menu__popover inspector-menu__popover--right" role="menu" aria-label={t("a11y.inspectorTabActions")}>
            {!detached && <button type="button" role="menuitem" onClick={() => { setPanelSide(panelSide === "right" ? "left" : "right"); setMenu(undefined); }}>{panelSide === "right" ? <PanelLeft aria-hidden="true" /> : <PanelRight aria-hidden="true" />}<span>{panelSide === "right" ? t("inspector.moveLeft") : t("inspector.moveRight")}</span></button>}
            {!detached && <button type="button" role="menuitem" onClick={() => { setMaximized((current) => !current); setMenu(undefined); }}>{maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}<span>{maximized ? t("inspector.restore") : t("inspector.maximize")}</span></button>}
            {canDetach && !detached && <button type="button" role="menuitem" onClick={detachInspector}><SquareArrowOutUpRight aria-hidden="true" /><span>{t("inspector.detach")}</span></button>}
            {activeTab !== undefined && <>{!detached && <span className="inspector-menu__separator" role="separator" />}<button type="button" role="menuitem" onClick={() => { closeTab(activeTab.id); setMenu(undefined); }}><X aria-hidden="true" /><span>{t("inspector.closeTab")}</span></button><button type="button" role="menuitem" disabled={bucket.tabs.length <= 1} onClick={() => closeOtherTabs(activeTab.id)}><X aria-hidden="true" /><span>{t("inspector.closeOtherTabs")}</span></button><button type="button" role="menuitem" onClick={closeAllTabs}><X aria-hidden="true" /><span>{t("inspector.closeAllTabs")}</span></button></>}
          </div>}
        </div>
        {!detached && <IconButton label={maximized ? t("inspector.restore") : t("inspector.maximize")} onClick={() => setMaximized((current) => !current)}>{maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</IconButton>}
        {!detached && <IconButton label={t("a11y.closeInspector")} onClick={closeInspector}><PanelRightClose className={panelSide === "left" ? "is-mirrored" : undefined} aria-hidden="true" /></IconButton>}
      </header>
      <div className="inspector__body">
        {bucket.tabs.length === 0 && <div className="inspector-empty"><Gauge aria-hidden="true" /><h2>{t("inspector.emptyTitle")}</h2><p>{t("inspector.emptyBody")}</p>{addableKinds.length > 0 && <Button onClick={() => setMenu("add")}><Plus aria-hidden="true" />{t("inspector.addTab")}</Button>}</div>}
        {bucket.tabs.map((tab) => <div id={`inspector-panel-${tab.id}`} key={`${session.id}:${tab.id}`} className={cx("inspector-tab-panel", tab.id === bucket.activeTabId && "is-active")} data-tab-kind={tab.kind} role="tabpanel" aria-labelledby={`inspector-tab-${tab.id}`} aria-hidden={tab.id !== bucket.activeTabId} hidden={tab.id !== bucket.activeTabId} tabIndex={0}><InspectorTabErrorBoundary resetKey={`${session.id}:${tab.id}:${tab.kind}`} t={t}>
          {tab.kind === "context" && <ContextPanel controller={controller} backend={backend} session={session} queue={sessionQueue} tasks={tasks} t={t} runAction={runAction} />}
          {tab.kind === "branches" && canTree && <BranchesPanel controller={controller} backend={backend} session={session} t={t} runAction={runAction} />}
          {tab.kind === "files" && canFiles && <FilesPanel controller={controller} workspace={workspace} sessionId={session.id} canWrite={canWriteFiles} t={t} onSelectionQuote={onSelectionQuote} />}
          {tab.kind === "changes" && (canDiff || canRewind) && <ChangesPanel controller={controller} session={session} workspace={workspace} {...(turnReviewFocusRequest === undefined ? {} : { focusRequest: turnReviewFocusRequest })} canDiff={canDiff} canDiffImagePreview={canDiffImagePreview} canStageDiff={canStageDiff} canUnstageDiff={canUnstageDiff} canRevertDiff={canRevertDiff} canCommitDiff={canCommitDiff} canPushDiff={canPushDiff} canRewind={canRewind} gitWriteDisabledReason={gitWriteDisabledReason} t={t} runAction={runAction} />}
          {tab.kind === "background" && canBackgroundTasks && <BackgroundTasksPanel
            timeline={timeline}
            history={backgroundHistory}
            historyState={backgroundHistoryState}
            historyError={backgroundHistoryError}
            onRefresh={() => setBackgroundHistoryRefresh((value) => value + 1)}
            canCancel={canCancelBackgroundTasks}
            onCancel={(backgroundTaskId) => controller.cancelBackgroundTask(session.id, backgroundTaskId)}
            locale={controller.state.preferences.locale}
            t={t}
          />}
          {tab.kind === "subagents" && canSubagents && <SubagentsPanel controller={controller} sessionId={session.id} focusRunId={subagentFocusRequest?.sessionId === session.id ? subagentFocusRequest.runId : undefined} focusRequestId={subagentFocusRequest?.sessionId === session.id ? subagentFocusRequest.requestId : undefined} locale={controller.state.preferences.locale} t={t} runAction={runAction} />}
          {tab.kind === "terminal" && canUserShell && <InspectorShellPanel controller={controller} session={session} timeline={timeline} t={t} runAction={runAction} />}
          {tab.kind === "tools" && <ToolPanel
            toolItems={toolItems}
            resources={snapshot.resources}
            runtimeSupported={canRuntimeTools}
            runtimeCatalog={runtimeToolCatalog}
            runtimeState={runtimeToolState}
            runtimeError={runtimeToolError}
            onRefreshRuntime={() => setRuntimeToolRefresh((value) => value + 1)}
            locale={controller.state.preferences.locale}
            t={t}
          />}
          {tab.kind === "browser" && canBrowser && <BrowserPanel controller={controller} browsers={snapshot.browsers} browserSettings={snapshot.settings.browsers} session={session} commentSessions={browserCommentSessions} locale={controller.state.preferences.locale} focusRequest={browserFocusRequest?.sessionId === session.id ? browserFocusRequest : undefined} t={t} runAction={runAction} />}
        </InspectorTabErrorBoundary></div>)}
      </div>
    </aside>
  );

  if (activeDetachedHost === undefined) return inspector;
  return createPortal(
    <div className="inspector-window-shell">
      <header className="inspector-window-titlebar">
        <PanelRight aria-hidden="true" />
        <span>{t("inspector.windowLabel")}</span>
        <IconButton label={t("inspector.mergeBack")} onClick={reattachInspector}><PanelRight aria-hidden="true" /></IconButton>
      </header>
      {inspector}
      <InspectorWindowControls host={activeDetachedHost} t={t} onClose={reattachInspector} />
    </div>,
    activeDetachedHost.root
  );
}

function InspectorWindowControls({ host, t, onClose }: {
  readonly host: DetachedInspectorHost;
  readonly t: Translator;
  readonly onClose: () => void;
}): JSX.Element | null {
  const api = host.window.jokoInspectorDesktop;
  if (api === undefined || api.platform === "darwin") return null;
  return <div className="inspector-window-controls" role="group" aria-label={t("desktop.windowControls")}>
    <IconButton label={t("desktop.minimize")} onClick={() => { void api.window.minimize().catch(() => undefined); }}><Minus aria-hidden="true" /></IconButton>
    <IconButton label={t("desktop.maximizeOrRestore")} onClick={() => { void api.window.toggleMaximize().catch(() => undefined); }}><Square aria-hidden="true" /></IconButton>
    <IconButton className="inspector-window-controls__close" label={t("desktop.close")} onClick={onClose}><X aria-hidden="true" /></IconButton>
  </div>;
}

function InspectorTabPill({ tab, active, label, closeLabel, onActivate, onClose, onKeyDown, onDragStart, onDragEnd, onDrop }: {
  readonly tab: InspectorTabState;
  readonly active: boolean;
  readonly label: string;
  readonly closeLabel: string;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void;
  readonly onDragEnd: () => void;
  readonly onDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
}): JSX.Element {
  return <div className={cx("inspector-tab", active && "is-active")} draggable onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={onDrop} onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(); } }}>
    <button id={`inspector-tab-${tab.id}`} type="button" role="tab" aria-selected={active} aria-controls={`inspector-panel-${tab.id}`} tabIndex={active ? 0 : -1} title={label} onClick={onActivate} onKeyDown={onKeyDown}>{inspectorTabIcon(tab.kind)}<span>{label}</span></button>
    <IconButton className="inspector-tab__close" label={closeLabel} onClick={(event) => { event.stopPropagation(); onClose(); }}><X aria-hidden="true" /></IconButton>
  </div>;
}

function inspectorTabKindsInMenuOrder(): readonly InspectorTabKind[] {
  return ["context", "files", "changes", "branches", "background", "subagents", "browser", "terminal", "tools"];
}

function inspectorTabLabel(kind: InspectorTabKind, t: Translator): string {
  switch (kind) {
    case "context": return t("context.title");
    case "branches": return t("session.branch");
    case "files": return t("workspace.files");
    case "changes": return t("workspace.diff");
    case "background": return t("background.title");
    case "subagents": return t("subagents.title");
    case "terminal": return t("composer.shell");
    case "tools": return t("nav.tools");
    case "browser": return t("tools.browser");
  }
}

function inspectorTabIcon(kind: InspectorTabKind): JSX.Element {
  switch (kind) {
    case "context": return <Gauge aria-hidden="true" />;
    case "branches": return <GitBranch aria-hidden="true" />;
    case "files": return <Folder aria-hidden="true" />;
    case "changes": return <FileDiff aria-hidden="true" />;
    case "background": return <ListTodo aria-hidden="true" />;
    case "subagents": return <Bot aria-hidden="true" />;
    case "terminal": return <Terminal aria-hidden="true" />;
    case "tools": return <Wrench aria-hidden="true" />;
    case "browser": return <Globe2 aria-hidden="true" />;
  }
}

function readInspectorTabBuckets(): InspectorTabBuckets {
  try { return parseInspectorTabBuckets(window.localStorage.getItem(INSPECTOR_TABS_KEY)); } catch { return {}; }
}

function readInspectorSide(): InspectorSide {
  try { return window.localStorage.getItem(INSPECTOR_SIDE_KEY) === "left" ? "left" : "right"; } catch { return "right"; }
}

function trackInspectorShortcutTerritory(
  ownerWindow: Window,
  lastInteractionRef: { current: boolean }
): () => void {
  const mark = (event: Event): void => {
    const target = eventElementInWindow(ownerWindow, event.target);
    lastInteractionRef.current = target?.closest(".inspector") != null;
  };
  ownerWindow.addEventListener("pointerdown", mark, true);
  ownerWindow.addEventListener("wheel", mark, { capture: true, passive: true });
  return () => {
    ownerWindow.removeEventListener("pointerdown", mark, true);
    ownerWindow.removeEventListener("wheel", mark, true);
  };
}

function eventElementInWindow(ownerWindow: Window, target: EventTarget | null): Element | null {
  const ElementConstructor = (ownerWindow as Window & typeof globalThis).Element;
  return typeof ElementConstructor === "function" && target instanceof ElementConstructor ? target : null;
}

function ContextPanel({ controller, backend, session, queue, tasks, t, runAction }: { readonly controller: AppController; readonly backend?: BackendView; readonly session: SessionView; readonly queue: readonly QueueItemView[]; readonly tasks: readonly NonNullable<TimelineItemView["background"]>[]; readonly t: Translator; readonly runAction: RunAction }): JSX.Element {
  const context = session.context;
  const capacityPercent = context === undefined || context.contextWindow === 0 ? 0 : Math.min(100, context.usedTokens / context.contextWindow * 100);
  const usageSupported = backend?.capabilities.get("context.usage")?.supported === true;
  const usage = resolveSessionUsageDisplay(session.usage, usageSupported, controller.state.preferences.locale);
  return (
    <div className="inspector-panel">
      <section className="inspector-section">
        <header><h2>{t("context.title")}</h2>{context !== undefined && <Pill tone={capacityPercent > 88 ? "danger" : capacityPercent > 70 ? "warning" : "neutral"}>{capacityPercent.toFixed(0)}%</Pill>}</header>
        {context === undefined ? <p className="muted">{t("context.unavailable")}</p> : (
          <>
            <div className="context-meter"><span style={{ width: `${capacityPercent}%` }} /></div>
            <div className="context-numbers"><strong>{formatTokens(context.usedTokens)}</strong><span>/ {formatTokens(context.contextWindow)} {t("context.tokens")}</span></div>
            {(context.autoRetry !== undefined || context.autoCompact !== undefined) && <div className="context-flags">{context.autoRetry !== undefined && <span><StatusDot state={context.autoRetry ? "healthy" : "muted"} label={context.autoRetry ? t("context.on") : t("context.off")} />{t("context.autoRetry")}</span>}{context.autoCompact !== undefined && <span><StatusDot state={context.autoCompact ? "healthy" : "muted"} label={context.autoCompact ? t("context.on") : t("context.off")} />{t("context.autoCompact")}</span>}</div>}
          </>
        )}
        <div className="inspector-actions">{backend?.capabilities.get("session.export")?.supported === true && <Button onClick={() => runAction("export", () => controller.exportSession(session.id))}><SquareArrowOutUpRight aria-hidden="true" />{t("session.export")}</Button>}</div>
      </section>

      <section className="inspector-section">
        <header><h2>{t("sessionUsage.title")}</h2>{usage !== undefined && <Pill>{usage.totalTokensText}</Pill>}</header>
        {!usageSupported ? <p className="muted">{t("sessionUsage.unsupported")}</p> : usage === undefined ? <p className="muted">{t("sessionUsage.unavailable")}</p> : (
          <dl className="metric-grid">
            <div><dt>{t("sessionUsage.totalLabel")}</dt><dd>{formatCompactUsageTokens(usage.totalTokens)}</dd></div>
            <div><dt>{t("context.input")}</dt><dd>{formatCompactUsageTokens(usage.inputTokens)}</dd></div>
            <div><dt>{t("context.output")}</dt><dd>{formatCompactUsageTokens(usage.outputTokens)}</dd></div>
            <div><dt>{t("context.cacheRead")}</dt><dd>{formatCompactUsageTokens(usage.cacheReadTokens)}</dd></div>
            <div><dt>{t("context.cacheWrite")}</dt><dd>{formatCompactUsageTokens(usage.cacheWriteTokens)}</dd></div>
            <div><dt>{t("context.cost")}</dt><dd>{usage.costText ?? t("sessionUsage.costUnavailableShort")}</dd></div>
          </dl>
        )}
      </section>

      <section className="inspector-section">
        <header><h2>{t("context.queue")}</h2><span className="section-count">{queue.length}</span></header>
        {queue.length === 0 ? <p className="muted">{t("context.noQueue")}</p> : <ul className="compact-list">{queue.map((item) => <li key={item.id}><StatusDot state={item.state} label={item.state} /><div><strong>{item.mode}</strong><span>{item.text}</span></div><small>{item.state}</small></li>)}</ul>}
      </section>

      <section className="inspector-section">
        <header><h2>{t("context.background")}</h2><span className="section-count">{tasks.length}</span></header>
        {tasks.length === 0 ? <p className="muted">{t("context.noBackground")}</p> : <ul className="compact-list">{tasks.map((task) => <li key={task.id}><StatusDot state={task.state} label={task.state} /><div><strong>{task.title}</strong><span>{task.detail}</span></div><small>{task.state}</small></li>)}</ul>}
      </section>
    </div>
  );
}

export function BranchesPanel({ controller, backend, session, t, runAction }: { readonly controller: AppController; readonly backend?: BackendView; readonly session: SessionView; readonly t: Translator; readonly runAction: RunAction }): JSX.Element {
  const [tree, setTree] = useState<NativeSessionTreeView>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [summarize, setSummarize] = useState(false);
  const [summaryFocus, setSummaryFocus] = useState("");
  const treeNavigation = useInspectorTreeNavigation();
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const busy = session.state === "running" || session.state === "waiting" || session.state === "retrying";
  const canFork = backend?.capabilities.get("session.fork")?.supported === true;
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setTree(await controllerRef.current.getSessionTree(session.id));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [session.id]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="inspector-panel">
      <section className="inspector-section">
        <header><h2>{t("session.branch")}</h2><Button tone="ghost" onClick={() => void load()}><RefreshCcw aria-hidden="true" />{t("common.refresh")}</Button></header>
        <p className="muted">{t("session.branchHelp")}</p>
        {busy && <div className="rewind-card"><AlertTriangle aria-hidden="true" /><div><strong>{t("session.branchBusy")}</strong><p>{t("session.branchBusyHelp")}</p></div></div>}
        {loading && <Spinner label={t("session.branchLoad")} />}
        {error !== undefined && <p className="inline-error" role="alert">{error}</p>}
        {!loading && tree !== undefined && tree.roots.length === 0 && <p className="muted">{t("session.branchEmpty")}</p>}
        {tree !== undefined && <div ref={treeNavigation.ref} className="native-tree" role="tree" aria-label={t("session.branch")} onFocusCapture={treeNavigation.onFocusCapture} onKeyDown={treeNavigation.onKeyDown}>{tree.roots.map((node) => <NativeTreeNode key={node.id} node={node} level={1} activeLeafId={tree.activeLeafId} busy={busy} canFork={canFork} t={t} onNavigate={(entryId) => runAction(`branch:${entryId}`, async () => { await controller.navigateSessionBranch(session.id, entryId, { summarize, ...(summarize && summaryFocus.trim() ? { customInstructions: summaryFocus.trim() } : {}) }); await load(); })} onFork={(entryId) => runAction(`fork:${entryId}`, async () => { const sessionId = await controller.forkSession(session.id, entryId, t("session.branchSuffix", { name: session.name })); controller.navigate({ kind: "session", sessionId }); })} />)}</div>}
        <div className="branch-navigation-options">
          <label>
            <CheckboxControl checked={summarize} onChange={(event) => setSummarize(event.currentTarget.checked)} />
            <span>{t("session.branchSummarize")}</span>
          </label>
          {summarize && <input type="text" value={summaryFocus} maxLength={4_000} placeholder={t("session.branchSummaryFocus")} aria-label={t("session.branchSummaryFocus")} onChange={(event) => setSummaryFocus(event.currentTarget.value.slice(0, 4_000))} />}
          <p>{busy ? t("session.branchBusyHelp") : t("session.branchFilesWarning")}</p>
        </div>
      </section>
    </div>
  );
}

function NativeTreeNode({ node, level, activeLeafId, busy, canFork, t, onNavigate, onFork }: { readonly node: NativeSessionTreeNodeView; readonly level: number; readonly activeLeafId?: string; readonly busy: boolean; readonly canFork: boolean; readonly t: Translator; readonly onNavigate: (entryId: string) => void; readonly onFork: (entryId: string) => void }): JSX.Element {
  const [open, setOpen] = useState(node.active || node.children.some((child) => containsActiveTreeNode(child)));
  const active = node.active || node.id === activeLeafId;
  return (
    <div className={cx("native-tree__node", active && "is-active")} role="treeitem" tabIndex={-1} data-inspector-tree-key={node.id} aria-level={level} aria-current={active ? "true" : undefined} aria-disabled={busy || active || undefined} aria-expanded={node.children.length > 0 ? open : undefined}>
      <div className="native-tree__row">
        {node.children.length > 0 ? <IconButton className="native-tree__toggle" tabIndex={-1} data-inspector-tree-toggle="" label={open ? t("common.close") : t("common.open")} onClick={() => setOpen((value) => !value)}>{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</IconButton> : <span className="tree-spacer" />}
        <GitBranch aria-hidden="true" />
        <button className="native-tree__content" type="button" tabIndex={-1} data-inspector-tree-primary="" disabled={busy || active} onClick={() => onNavigate(node.id)}><strong>{node.summary || node.text || node.kind}</strong><span>{node.role || node.kind} · {shortValue(node.id)}</span></button>
        {active && <Pill tone="accent">{t("common.active")}</Pill>}
        {canForkNativeTreeNode(canFork, node) && <button className="native-tree__fork" type="button" data-inspector-tree-secondary-action="" disabled={busy} onClick={() => onFork(node.id)}>{t("session.fork")}</button>}
      </div>
      {open && node.children.length > 0 && <div role="group">{node.children.map((child) => <NativeTreeNode key={child.id} node={child} level={level + 1} activeLeafId={activeLeafId} busy={busy} canFork={canFork} t={t} onNavigate={onNavigate} onFork={onFork} />)}</div>}
    </div>
  );
}

function readInspectorRatio(): number {
  try { return normalizeInspectorRatio(window.localStorage.getItem(INSPECTOR_RATIO_KEY)); } catch { return INSPECTOR_DEFAULT_RATIO; }
}

function inspectorAvailableWidth(inspector: HTMLElement | null): number {
  const app = inspector?.closest<HTMLElement>(".app");
  if (app === undefined || app === null) return window.innerWidth;
  const columns = window.getComputedStyle(app).gridTemplateColumns.split(/\s+/u);
  const navigationWidth = app.classList.contains("has-navigation") ? Number.parseFloat(columns[0] ?? "0") : 0;
  return Math.max(0, app.clientWidth - (Number.isFinite(navigationWidth) ? navigationWidth : 0));
}

export function canForkNativeTreeNode(
  forkCapabilitySupported: boolean,
  node: Pick<NativeSessionTreeNodeView, "role">
): boolean {
  return forkCapabilitySupported && node.role === "user";
}

export function containsActiveTreeNode(node: NativeSessionTreeNodeView): boolean {
  const stack = [node];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (current.active) return true;
    if (!Array.isArray(current.children)) continue;
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      stack.push(current.children[index]!);
    }
  }
  return false;
}

export function FilesPanel({ controller, workspace, sessionId, canWrite, t, onSelectionQuote }: {
  readonly controller: AppController;
  readonly workspace?: WorkspaceView;
  readonly sessionId: string;
  readonly canWrite: boolean;
  readonly t: Translator;
  readonly onSelectionQuote: (sessionId: string, quote: ComposerFileSelectionQuoteDraft) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [pendingPath, setPendingPath] = useState<string>();
  const [preview, setPreview] = useState<WorkspaceFilePreviewView>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const [searchMatches, setSearchMatches] = useState<readonly WorkspaceSearchMatchView[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [searchTotalMatches, setSearchTotalMatches] = useState(0);
  const [searchTotalFiles, setSearchTotalFiles] = useState(0);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchRetry, setSearchRetry] = useState(0);
  const [rootEntries, setRootEntries] = useState<readonly WorkspaceEntryView[]>(workspace?.entries ?? []);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string>();
  const [rootRetry, setRootRetry] = useState(0);
  const [editorDirty, setEditorDirty] = useState(false);
  const [switching, setSwitching] = useState(false);
  const treeNavigation = useInspectorTreeNavigation();
  const editorRef = useRef<WorkspaceFileEditorPaneHandle>(null);
  const previewRequestEpochRef = useRef(0);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const selected = findEntry(rootEntries, selectedPath);
  const selectedPreview = preview?.path === selectedPath ? preview : undefined;
  const commitSelectionQuote = useCallback((quote: ComposerFileSelectionQuoteDraft): void => {
    onSelectionQuote(sessionId, quote);
  }, [onSelectionQuote, sessionId]);

  useEffect(() => {
    setSelectedPath(undefined);
    setPendingPath(undefined);
    setPreview(undefined);
    setPreviewError(undefined);
    setEditorDirty(false);
    previewRequestEpochRef.current += 1;
  }, [sessionId, workspace?.id]);

  useEffect(() => {
    setRootEntries(workspace?.entries ?? []);
    setRootError(undefined);
    if (workspace === undefined) {
      setRootLoading(false);
      return;
    }
    let current = true;
    setRootLoading(true);
    void controllerRef.current.listWorkspaceEntries(workspace.id, "").then((entries) => {
      if (current) setRootEntries(entries);
    }).catch((error: unknown) => {
      if (current) setRootError(messageOf(error));
    }).finally(() => {
      if (current) setRootLoading(false);
    });
    return () => { current = false; };
  }, [rootRetry, workspace?.id, workspace?.revision]);

  const commitSelectedPath = useCallback((path: string): void => {
    setPendingPath(undefined);
    setSelectedPath(path);
    setPreview((current) => current?.path === path ? current : undefined);
    setPreviewError(undefined);
    setEditorDirty(false);
  }, []);

  const requestSelectedPath = useCallback((path: string): void => {
    if (path === selectedPath) return;
    if (editorDirty && editorRef.current?.isDirty() === true) {
      setPendingPath(path);
      return;
    }
    commitSelectedPath(path);
  }, [commitSelectedPath, editorDirty, selectedPath]);

  useEffect(() => {
    setPreviewError(undefined);
    if (workspace === undefined || selectedPath === undefined) return;
    let current = true;
    const requestEpoch = ++previewRequestEpochRef.current;
    setPreviewLoading(true);
    void controllerRef.current.readWorkspaceFile(workspace.id, selectedPath).then((next) => {
      if (current && previewRequestEpochRef.current === requestEpoch) setPreview(next);
    }).catch((error: unknown) => {
      if (current && previewRequestEpochRef.current === requestEpoch) setPreviewError(messageOf(error));
    }).finally(() => {
      if (current && previewRequestEpochRef.current === requestEpoch) setPreviewLoading(false);
    });
    return () => { current = false; };
  }, [selectedPath, workspace?.id, workspace?.revision]);

  useEffect(() => {
    setSearchMatches([]);
    setSearchError(undefined);
    setSearchTotalMatches(0);
    setSearchTotalFiles(0);
    setSearchTruncated(false);
    if (workspace === undefined || query.trim().length < 2) return;
    let current = true;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      void collectCompleteWorkspaceSearch((pageToken) => controllerRef.current.searchWorkspacePage(workspace.id, {
        query: query.trim(),
        caseSensitive: false,
        regularExpression: false,
        pageSize: INSPECTOR_WORKSPACE_SEARCH_PAGE_SIZE,
        ...(pageToken === undefined ? {} : { pageToken })
      }, abort.signal)).then((result) => {
        if (!current) return;
        setSearchMatches(result.matches);
        setSearchTotalMatches(result.totalMatches);
        setSearchTotalFiles(result.totalFiles);
        setSearchTruncated(result.truncated);
      }).catch((error: unknown) => {
        if (current && !abort.signal.aborted) setSearchError(messageOf(error));
      }).finally(() => {
        if (current) setSearching(false);
      });
    }, 250);
    return () => { current = false; abort.abort(); window.clearTimeout(timer); };
  }, [query, searchRetry, workspace?.id]);

  if (workspace === undefined) return <PanelEmpty text={t("workspace.noWorkspace")} />;
  return (
    <div className="inspector-panel inspector-panel--files">
      <section className="workspace-summary">
        <div><strong>{workspace.name}</strong><span>{workspace.branch ?? t("workspace.noBranch")}</span></div>
        <Pill tone={workspace.dirty ? "warning" : "success"}>{workspace.dirty ? t("workspace.dirty") : t("workspace.clean")}</Pill>
      </section>
      <label className="panel-search"><Search aria-hidden="true" /><span className="sr-only">{t("workspace.search")}</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("workspace.search")} /></label>
      {query.trim().length >= 2 ? <div className="workspace-search-results" aria-live="polite">
        {searching && <Spinner label={t("workspace.searching")} />}
        {searchError !== undefined && <div className="inline-error" role="alert"><p>{t("workspace.searchFailed")} {searchError}</p><Button tone="ghost" onClick={() => setSearchRetry((value) => value + 1)}>{t("common.retry")}</Button></div>}
        {searchError === undefined && !searching && searchMatches.length === 0 && <p className="muted">{t("workspace.noMatches")}</p>}
        {searchError === undefined && searchMatches.length > 0 && <p className="workspace-search-results__summary">{t("workspace.searchSummary", { matches: searchTotalMatches, files: searchTotalFiles })}</p>}
        {searchError === undefined && searchTruncated && <p className="workspace-search-results__truncated"><AlertTriangle aria-hidden="true" />{t("workspace.searchTruncated", { matches: searchMatches.length })}</p>}
        {searchMatches.map((match, index) => <button type="button" key={`${match.path}:${match.line}:${match.range.startByte}:${index}`} onClick={() => requestSelectedPath(match.path)}><strong>{match.path}</strong><span>{match.preview}</span></button>)}
      </div> : <div ref={treeNavigation.ref} className="file-tree" role="tree" aria-label={t("workspace.files")} onFocusCapture={treeNavigation.onFocusCapture} onKeyDown={treeNavigation.onKeyDown}>
        {rootLoading && rootEntries.length === 0 && <Spinner label={t("workspace.loadingFiles")} />}
        {rootError !== undefined && <div className="inline-error" role="alert"><p>{t("workspace.filesLoadFailed")} {rootError}</p><Button tone="ghost" onClick={() => setRootRetry((value) => value + 1)}>{t("common.retry")}</Button></div>}
        {!rootLoading && rootError === undefined && rootEntries.length === 0 && <p className="muted">{t("workspace.emptyFiles")}</p>}
        <FileTree controller={controller} workspaceId={workspace.id} entries={rootEntries} selectedPath={selectedPath} onSelect={requestSelectedPath} level={1} t={t} />
      </div>}
      <section className="file-preview-card">
        <header><h3>{t("workspace.preview")}</h3>{selected?.generated === true && <Pill tone="accent">{t("common.generated")}</Pill>}</header>
        {selectedPath === undefined ? <p className="muted">{t("workspace.noSelection")}</p> : <>
          <div className="file-preview-card__name"><FileCode2 aria-hidden="true" /><div><strong>{selectedPreview?.name ?? selected?.name ?? selectedPath.split("/").at(-1)}</strong><span>{selectedPath}</span></div></div>
          {selected?.status !== undefined && <Pill tone={selected.status === "conflicted" ? "danger" : "warning"}>{selected.status}</Pill>}
          {previewLoading && <Spinner label={t("workspace.loadingPreview")} />}
          {previewError !== undefined && <p className="inline-error" role="alert">{previewError}</p>}
          {selectedPreview?.kind === "text" && selectedPreview.text !== undefined && (canWrite && !selectedPreview.truncated && selectedPreview.revision !== undefined
            ? <WorkspaceFileEditorPane
                ref={editorRef}
                key={selectedPreview.path}
                file={{ path: selectedPreview.path, text: selectedPreview.text, revision: selectedPreview.revision, languageId: selectedPreview.language }}
                labels={{
                  editor: t("workspace.editor"),
                  unsaved: t("workspace.unsaved"),
                  saving: t("workspace.saving"),
                  save: t("workspace.save"),
                  saveFailed: t("workspace.saveFailed"),
                  externalChange: t("workspace.externalChange"),
                  reloadDisk: t("workspace.reloadDisk"),
                  keepEditing: t("workspace.keepEditing"),
                  overwriteDisk: t("workspace.overwriteDisk"),
                  insertTable: t("workspace.insertTable"),
                  addRowAbove: t("workspace.tableAddRowAbove"),
                  addRowBelow: t("workspace.tableAddRowBelow"),
                  deleteRow: t("workspace.tableDeleteRow"),
                  addColumnLeft: t("workspace.tableAddColumnLeft"),
                  addColumnRight: t("workspace.tableAddColumnRight"),
                  deleteColumn: t("workspace.tableDeleteColumn"),
                  deleteTable: t("workspace.tableDeleteTable"),
                  mermaidZoom: t("workspace.mermaidZoom"),
                  mermaidCopy: t("workspace.mermaidCopy"),
                  mermaidCopied: t("workspace.mermaidCopied"),
                  mermaidCopyFailed: t("workspace.mermaidCopyFailed"),
                  mermaidEditSource: t("workspace.mermaidEditSource"),
                  mermaidRenderFailed: t("workspace.mermaidRenderFailed")
                }}
                onDirtyChange={setEditorDirty}
                selectionQuoteSessionId={sessionId}
                selectionQuoteLabel={t("timeline.addToChat")}
                onSelectionQuote={commitSelectionQuote}
                onSave={async (draft) => {
                  const writeEpoch = ++previewRequestEpochRef.current;
                  try {
                    const result = await controllerRef.current.writeWorkspaceTextFile(workspace.id, draft);
                    if (result.path !== draft.path) throw new Error("Joko service returned a different saved workspace file.");
                    setPreview((current) => current?.path !== draft.path
                      ? current
                      : { ...current, text: draft.text, revision: result.revision, truncated: false });
                    return { revision: result.revision };
                  } catch (error) {
                    if (isWorkspaceFileStaleError(error)) {
                      const refreshEpoch = ++previewRequestEpochRef.current;
                      try {
                        const latest = await controllerRef.current.readWorkspaceFile(workspace.id, draft.path);
                        if (previewRequestEpochRef.current === refreshEpoch) {
                          setPreview((current) => current?.path === draft.path && latest.path === draft.path ? latest : current);
                        }
                      } catch {
                        // Preserve the authoritative stale-write error. A later
                        // watcher refresh can still supply the conflict snapshot.
                      }
                    }
                    throw error;
                  } finally {
                    if (previewRequestEpochRef.current === writeEpoch) setPreviewLoading(false);
                  }
                }}
              />
            : <ReadOnlyWorkspaceFilePreview
                key={`${sessionId}:${selectedPreview.path}`}
                sessionId={sessionId}
                path={selectedPreview.path}
                languageId={selectedPreview.language}
                text={selectedPreview.text}
                editorLabel={t("workspace.editor")}
                quoteLabel={t("timeline.addToChat")}
                onSelectionQuote={commitSelectionQuote}
              />)}
          {selectedPreview?.kind === "image" && selectedPreview.blobId !== undefined && <AuthenticatedImage blobId={selectedPreview.blobId} getUrl={controller.getArtifactUrl} alt={selectedPreview.name} unavailableLabel={t("browser.screenshotUnavailable")} loadingLabel={t("workspace.loadingPreview")} />}
          {(selectedPreview?.kind === "binary" || selectedPreview?.kind === "blob") && <p className="muted">{selectedPreview.summary || selectedPreview.mediaType || t("workspace.binary")}</p>}
          {selectedPreview?.truncated === true && <Pill tone="warning">{t("workspace.previewTruncated")}</Pill>}
        </>}
      </section>
      <Modal
        open={pendingPath !== undefined}
        title={t("workspace.unsavedTitle")}
        description={t("workspace.unsavedSwitch", { path: selectedPath ?? "" })}
        size="small"
        showClose={false}
        dismissOnBackdrop={false}
        onClose={() => setPendingPath(undefined)}
      >
        <div className="modal__actions">
          <Button disabled={switching} onClick={() => setPendingPath(undefined)}>{t("common.cancel")}</Button>
          <Button disabled={switching} onClick={() => {
            const next = pendingPath;
            editorRef.current?.discardLocalChanges();
            if (next !== undefined) commitSelectedPath(next);
          }}>{t("workspace.discardAndSwitch")}</Button>
          <Button tone="primary" disabled={switching} onClick={() => {
            const next = pendingPath;
            if (next === undefined) return;
            setSwitching(true);
            void editorRef.current?.save().then((saved) => {
              if (saved) commitSelectedPath(next);
            }).finally(() => setSwitching(false));
          }}>{switching ? <Spinner label={t("workspace.saving")} /> : null}{t("workspace.saveAndSwitch")}</Button>
        </div>
      </Modal>
    </div>
  );
}

function ReadOnlyWorkspaceFilePreview({ sessionId, path, languageId, text, editorLabel, quoteLabel, onSelectionQuote }: {
  readonly sessionId: string;
  readonly path: string;
  readonly languageId?: string;
  readonly text: string;
  readonly editorLabel: string;
  readonly quoteLabel: string;
  readonly onSelectionQuote: (quote: ComposerFileSelectionQuoteDraft) => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<WorkspaceTextEditorHandle>(null);
  const quoteSelectionRef = useRef<WorkspaceEditorSelection | undefined>(undefined);
  const getQuoteText = useCallback((): string | null => {
    const selection = editorRef.current?.getSelection();
    quoteSelectionRef.current = selection;
    return selection?.text ?? null;
  }, []);
  const getQuoteMetadata = useCallback(() => {
    const selection = quoteSelectionRef.current ?? editorRef.current?.getSelection();
    quoteSelectionRef.current = undefined;
    return selection === undefined
      ? null
      : { startLine: selection.startLine, endLine: selection.endLine };
  }, []);
  const commitSelectionQuote = useCallback((quote: ComposerSelectionQuoteDraft): void => {
    if (quote.kind === "file") onSelectionQuote(quote);
  }, [onSelectionQuote]);
  return <div
    ref={containerRef}
    className="workspace-file-editor-pane workspace-file-editor-pane--read-only"
    data-selection-quote-context=""
    data-joko-selection-quote-context=""
  >
    <WorkspaceTextEditor ref={editorRef} path={path} languageId={languageId} value={text} readOnly ariaLabel={editorLabel} />
    <SelectionQuoteButton
      sessionId={sessionId}
      containerRef={containerRef}
      sourcePath={path}
      getQuoteText={getQuoteText}
      getQuoteMetadata={getQuoteMetadata}
      label={quoteLabel}
      onCommit={commitSelectionQuote}
    />
  </div>;
}

function FileTree({ controller, workspaceId, entries, selectedPath, onSelect, level, t }: { readonly controller: AppController; readonly workspaceId: string; readonly entries: readonly WorkspaceEntryView[]; readonly selectedPath?: string; readonly onSelect: (path: string) => void; readonly level: number; readonly t: Translator }): JSX.Element {
  return <>{entries.map((entry) => <FileTreeNode key={`${workspaceId}:${entry.path}`} controller={controller} workspaceId={workspaceId} entry={entry} selectedPath={selectedPath} onSelect={onSelect} level={level} t={t} />)}</>;
}

export function FileTreeNode({ controller, workspaceId, entry, selectedPath, onSelect, level, t }: { readonly controller: AppController; readonly workspaceId: string; readonly entry: WorkspaceEntryView; readonly selectedPath?: string; readonly onSelect: (path: string) => void; readonly level: number; readonly t: Translator }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState(entry.children);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const requestEpochRef = useRef(0);
  useEffect(() => () => { requestEpochRef.current += 1; }, []);
  if (entry.kind === "directory") {
    const loadChildren = (): void => {
      if (loading) return;
      const requestEpoch = ++requestEpochRef.current;
      setLoading(true);
      setLoadError(undefined);
      void controller.listWorkspaceEntries(workspaceId, entry.path).then((next) => {
        if (requestEpochRef.current === requestEpoch) setChildren(next);
      }).catch((error: unknown) => {
        if (requestEpochRef.current === requestEpoch) setLoadError(messageOf(error));
      }).finally(() => {
        if (requestEpochRef.current === requestEpoch) setLoading(false);
      });
    };
    const toggle = (): void => {
      const nextOpen = !open;
      setOpen(nextOpen);
      if (!nextOpen || children !== undefined || loading) return;
      loadChildren();
    };
    return <div role="treeitem" tabIndex={-1} data-inspector-tree-key={entry.path} aria-label={entry.name} aria-expanded={open} aria-level={level}><button className="file-tree__row" type="button" tabIndex={-1} data-inspector-tree-primary="" data-inspector-tree-toggle="" onClick={toggle}>{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{open ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}<span>{entry.name}</span>{loading && <Spinner label={t("workspace.loadingEntry", { name: entry.name })} />}</button>{open && <div role="group">
      {loadError !== undefined && <div className="inline-error" role="alert"><p>{t("workspace.filesLoadFailed")} {loadError}</p><Button tone="ghost" onClick={loadChildren}>{t("common.retry")}</Button></div>}
      {!loading && loadError === undefined && children?.length === 0 && <p className="muted">{t("workspace.emptyDirectory")}</p>}
      <FileTree controller={controller} workspaceId={workspaceId} entries={children ?? []} selectedPath={selectedPath} onSelect={onSelect} level={level + 1} t={t} />
    </div>}</div>;
  }
  return <div role="treeitem" tabIndex={-1} data-inspector-tree-key={entry.path} aria-label={entry.name} aria-level={level} aria-selected={selectedPath === entry.path}><button className={cx("file-tree__row", selectedPath === entry.path && "is-active")} type="button" tabIndex={-1} data-inspector-tree-primary="" onClick={() => onSelect(entry.path)}><span className="tree-spacer" /><File aria-hidden="true" /><span>{entry.name}</span>{entry.status !== undefined && <i className={`file-status file-status--${entry.status}`} aria-label={entry.status} />}</button></div>;
}

function ChangesPanel({ controller, session, workspace, focusRequest, canDiff, canDiffImagePreview, canStageDiff, canUnstageDiff, canRevertDiff, canCommitDiff, canPushDiff, canRewind, gitWriteDisabledReason, t, runAction }: {
  readonly controller: AppController;
  readonly session: SessionView;
  readonly workspace?: WorkspaceView;
  readonly focusRequest?: InspectorTurnReviewRequest;
  readonly canDiff: boolean;
  readonly canDiffImagePreview: boolean;
  readonly canStageDiff: boolean;
  readonly canUnstageDiff: boolean;
  readonly canRevertDiff: boolean;
  readonly canCommitDiff: boolean;
  readonly canPushDiff: boolean;
  readonly canRewind: boolean;
  readonly gitWriteDisabledReason?: string;
  readonly t: Translator;
  readonly runAction: RunAction;
}): JSX.Element {
  const [diff, setDiff] = useState<WorkspaceDiffView>();
  const [changeSets, setChangeSets] = useState<readonly WorkspaceChangeSetView[]>([]);
  const [preview, setPreview] = useState<WorkspaceRewindPreviewView>();
  const [dialogueOnly, setDialogueOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [sourceKind, setSourceKind] = useState<ReviewSourceDescriptor["kind"]>("unstaged");
  const [commitRef, setCommitRef] = useState("");
  const [branchRef, setBranchRef] = useState("");
  const [turnSetId, setTurnSetId] = useState("");
  const [changeSetsLoaded, setChangeSetsLoaded] = useState(false);
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");
  const [wordWrap, setWordWrap] = useState(false);
  const [wordDiff, setWordDiff] = useState(true);
  const [hideWhitespace, setHideWhitespace] = useState(false);
  const [fileTreeVisible, setFileTreeVisible] = useState(false);
  const [selectedFileKey, setSelectedFileKey] = useState<string>();
  const [diffsExpanded, setDiffsExpandedState] = useState(() => {
    seedReviewDiffsExpanded(session.id, true);
    return getReviewDiffsExpanded(session.id, true);
  });
  const [diffExpansionOverrides, setDiffExpansionOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [pendingHunkKey, setPendingHunkKey] = useState<string>();
  const [revertConfirmation, setRevertConfirmation] = useState<{ readonly file: WorkspaceFileDiffView; readonly target: "file" | "hunk"; readonly hunkIndex?: number }>();
  const [imagePreview, setImagePreview] = useState<{ readonly key: string; readonly loading: boolean; readonly value?: WorkspaceDiffImageView; readonly error?: string }>();
  const [commitMessage, setCommitMessage] = useState("");
  const [includeUnstaged, setIncludeUnstaged] = useState(false);
  const [remote, setRemote] = useState("origin");
  const [remoteRef, setRemoteRef] = useState("");
  const [pendingGitWrite, setPendingGitWrite] = useState<"commit" | "commitPush" | "push">();
  const [forceConfirmation, setForceConfirmation] = useState<WorkspaceGitPushResultView>();
  const [operationNotice, setOperationNotice] = useState<string>();
  const [markdownPreview, setMarkdownPreview] = useState<{
    readonly key: string;
    readonly text?: string;
    readonly error?: string;
    readonly truncated?: boolean;
    readonly loading: boolean;
  }>();
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const expansionAction = getReviewDiffExpansionAction(
    diff?.files.map(reviewFileKey) ?? [],
    diffsExpanded,
    diffExpansionOverrides
  );
  const sourceDescriptor = useMemo<ReviewSourceDescriptor>(() => {
    if (sourceKind === "commit") return { kind: "commit", commitOid: commitRef.trim() || null };
    if (sourceKind === "branch") return { kind: "branch", baseRef: branchRef.trim() || null };
    if (sourceKind === "turn-set") return { kind: "turn-set", targetSessionId: session.id, changeSetIds: turnSetId === "" ? [] : [turnSetId] };
    return { kind: sourceKind };
  }, [branchRef, commitRef, session.id, sourceKind, turnSetId]);
  const sourceCapabilities = reviewSourceCapabilities(sourceDescriptor);

  useEffect(() => {
    if (focusRequest?.sessionId !== session.id) return;
    setDiff(undefined);
    setError(undefined);
    setSourceKind("turn-set");
    setTurnSetId(focusRequest.changeSetId);
    setFileTreeVisible(true);
  }, [focusRequest?.requestId, focusRequest?.sessionId, session.id]);

  useEffect(() => {
    seedReviewDiffsExpanded(session.id, true);
    setDiffsExpandedState(getReviewDiffsExpanded(session.id, true));
    setDiffExpansionOverrides(new Map());
  }, [session.id]);

  useEffect(() => {
    if (focusRequest?.sessionId !== session.id || sourceKind !== "turn-set" || turnSetId !== focusRequest.changeSetId || diff === undefined) return;
    const selected = selectedTurnReviewFile(diff.files, focusRequest.selectedPath);
    if (selected !== undefined) setSelectedFileKey(reviewFileKey(selected));
  }, [diff, focusRequest?.requestId, focusRequest?.selectedPath, focusRequest?.sessionId, session.id, sourceKind, turnSetId]);

  useEffect(() => {
    setRemoteRef(workspace?.branch === undefined ? "" : `refs/heads/${workspace.branch}`);
  }, [workspace?.branch, workspace?.id]);

  useEffect(() => {
    setDiff(undefined);
    if (!canDiff || workspace === undefined) return;
    if (sourceKind === "commit" && commitRef.trim() === "") return;
    if ((sourceKind === "last-turn" || sourceKind === "turn-set") && !changeSetsLoaded) return;
    if (sourceKind === "turn-set" && turnSetId === "") return;
    let current = true;
    setDiffLoading(true);
    setError(undefined);
    void loadReviewSourceDiff(controllerRef.current, workspace.id, sourceDescriptor, changeSets, hideWhitespace).then((next) => {
      if (!current) return;
      setDiff(next);
      setSelectedFileKey((selected) => next.files.some((file) => reviewFileKey(file) === selected) ? selected : reviewFileKey(next.files[0] ?? { source: "unspecified", path: "" }));
    }).catch((cause: unknown) => { if (current) setError(messageOf(cause)); }).finally(() => { if (current) setDiffLoading(false); });
    return () => { current = false; };
  }, [canDiff, changeSets, changeSetsLoaded, commitRef, branchRef, hideWhitespace, sourceDescriptor, sourceKind, turnSetId, workspace?.id]);

  useEffect(() => {
    setMarkdownPreview(undefined);
    setImagePreview(undefined);
  }, [diff?.repositoryRevision, sourceKind]);

  useEffect(() => {
    const blobIds = [imagePreview?.value?.oldImage.blobId, imagePreview?.value?.newImage.blobId]
      .filter((value): value is string => value !== undefined);
    return () => { for (const blobId of blobIds) controllerRef.current.releaseArtifactUrl(blobId); };
  }, [imagePreview?.value?.newImage.blobId, imagePreview?.value?.oldImage.blobId]);

  useEffect(() => {
    setChangeSets([]);
    setChangeSetsLoaded(false);
    if ((!canRewind && !canDiff) || workspace === undefined) return;
    let current = true;
    void controllerRef.current.listWorkspaceChangeSets(workspace.id, session.id).then((next) => {
      if (!current) return;
      setChangeSets(next);
      const requested = focusRequest?.sessionId === session.id ? focusRequest.changeSetId : undefined;
      setTurnSetId((selected) => requested !== undefined
        ? next.some((changeSet) => changeSet.id === requested) ? requested : ""
        : selected !== "" && next.some((changeSet) => changeSet.id === selected)
          ? selected
          : latestTurnChangeSets(next).at(-1)?.id ?? next[0]?.id ?? "");
      if (requested !== undefined && !next.some((changeSet) => changeSet.id === requested)) setError(t("workspace.reviewTurnUnavailable"));
      setChangeSetsLoaded(true);
    }).catch((cause: unknown) => {
      if (current) {
        setError(messageOf(cause));
        setChangeSetsLoaded(true);
      }
    });
    return () => { current = false; };
  }, [canDiff, canRewind, focusRequest?.changeSetId, focusRequest?.requestId, focusRequest?.sessionId, session.id, t, workspace?.id]);

  if (workspace === undefined) return <PanelEmpty text={t("workspace.noWorkspace")} />;
  const changed = flattenEntries(workspace.entries).filter((entry) => entry.status !== undefined);
  const sourceReady = sourceKind === "commit"
    ? isSafeReviewRef(commitRef.trim(), true)
    : sourceKind === "branch"
      ? branchRef.trim() === "" || isSafeReviewRef(branchRef.trim(), false)
      : sourceKind !== "turn-set" || turnSetId !== "";
  const expandedFileKeys = getExpandedReviewFileKeys(
    diff?.files.map(reviewFileKey) ?? [],
    diffsExpanded,
    diffExpansionOverrides
  );
  const setFileExpanded = (key: string, expanded: boolean): void => {
    setDiffExpansionOverrides((current) => {
      const next = new Map(current);
      if (expanded === diffsExpanded) next.delete(key);
      else next.set(key, expanded);
      return next;
    });
  };
  const toggleAllDiffs = (): void => {
    if (expansionAction === "disabled") return;
    const nextExpanded = expansionAction === "expand";
    setDiffExpansionOverrides(new Map());
    setDiffsExpandedState(nextExpanded);
    setReviewDiffsExpanded(session.id, nextExpanded);
  };
  const openPreview = (changeSet: WorkspaceChangeSetView): void => {
    setLoading(true);
    setError(undefined);
    void controller.previewWorkspaceRewind(workspace.id, changeSet.id).then((next) => {
      setPreview(next);
      setDialogueOnly(next.safety === "blocked" && next.dialogueOnlyAvailable);
    }).catch((cause: unknown) => setError(messageOf(cause))).finally(() => setLoading(false));
  };
  const canExecute = preview !== undefined && (preview.safety !== "blocked" || (preview.dialogueOnlyAvailable && dialogueOnly));
  const reloadCurrentDiff = async (): Promise<void> => {
    const next = await loadReviewSourceDiff(controller, workspace.id, sourceDescriptor, changeSets, hideWhitespace);
    setDiff(next);
    setSelectedFileKey((selected) => next.files.some((file) => reviewFileKey(file) === selected) ? selected : reviewFileKey(next.files[0] ?? { source: "unspecified", path: "" }));
  };
  const mutateDiff = (file: WorkspaceFileDiffView, target: "file" | "hunk", hunkIndex: number | undefined, action: "stage" | "unstage" | "revert", confirmed = false): void => {
    if (gitWriteDisabledReason !== undefined) return;
    const source = file.source;
    if (diff === undefined || (source !== "staged" && source !== "unstaged")) return;
    if (action === "revert" && !confirmed) {
      setRevertConfirmation({ file, target, ...(hunkIndex === undefined ? {} : { hunkIndex }) });
      return;
    }
    const key = `${action}:${target}:${reviewFileKey(file)}:${hunkIndex ?? "all"}`;
    setPendingHunkKey(key);
    setError(undefined);
    setOperationNotice(undefined);
    runAction(`review:${key}`, async () => {
      try {
        await controller.applyWorkspaceDiffHunk(workspace.id, {
          action,
          source,
          target,
          path: file.path,
          ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
          ...(hunkIndex === undefined ? {} : { hunkIndex }),
          expectedRepositoryRevision: diff.repositoryRevision,
          ignoreWhitespace: hideWhitespace,
          confirmRevert: action === "revert" && confirmed
        });
        await reloadCurrentDiff();
        setOperationNotice(t("workspace.reviewMutationComplete"));
      } catch (cause) {
        setError(messageOf(cause));
        throw cause;
      } finally {
        setPendingHunkKey((current) => current === key ? undefined : current);
      }
    });
  };
  const loadMarkdownPreview = (file: WorkspaceFileDiffView): void => {
    if (diff === undefined) return;
    const key = `${diff.repositoryRevision}:${reviewFileKey(file)}`;
    if (markdownPreview?.key === key && (markdownPreview.loading || markdownPreview.text !== undefined)) return;
    setMarkdownPreview({ key, loading: true });
    void controller.readWorkspaceDiffFile(workspace.id, file, diff).then((result) => {
      setMarkdownPreview({ key, loading: false, text: result.text ?? "", truncated: result.truncated });
    }).catch((cause: unknown) => setMarkdownPreview({ key, loading: false, error: messageOf(cause) }));
  };
  const loadImagePreview = (file: WorkspaceFileDiffView): void => {
    if (diff === undefined || !canDiffImagePreview || !sourceCapabilities.canRichPreview) return;
    const key = `${diff.repositoryRevision}:${reviewFileKey(file)}`;
    if (imagePreview?.key === key && (imagePreview.loading || imagePreview.value !== undefined)) return;
    setImagePreview({ key, loading: true });
    void controller.readWorkspaceDiffImage(workspace.id, file, diff).then((value) => {
      setImagePreview({ key, loading: false, value });
    }).catch((cause: unknown) => setImagePreview({ key, loading: false, error: messageOf(cause) }));
  };
  const currentMutationFence = (): Promise<WorkspaceDiffView> => controller.getWorkspaceDiff(workspace.id, { source: "unstaged" });
  const executePush = async (confirmation?: WorkspaceGitPushResultView): Promise<void> => {
    const selectedRemote = (confirmation?.remote ?? remote).trim();
    const selectedRemoteRef = (confirmation?.remoteRef ?? remoteRef).trim();
    if (selectedRemote === "" || selectedRemoteRef === "") throw new Error(t("workspace.reviewPushTargetRequired"));
    const fence = await currentMutationFence();
    if (fence.headRevision === undefined || fence.headRevision === "") throw new Error(t("workspace.reviewPushHeadRequired"));
    const result = await controller.pushWorkspaceBranch(workspace.id, {
      remote: selectedRemote,
      remoteRef: selectedRemoteRef,
      expectedRepositoryRevision: fence.repositoryRevision,
      expectedHeadRevision: fence.headRevision,
      confirmForceWithLease: confirmation !== undefined,
      ...(confirmation?.remoteOid === undefined ? {} : { expectedRemoteOid: confirmation.remoteOid })
    });
    if (result.outcome === "needsForce") {
      setForceConfirmation(result);
      return;
    }
    setForceConfirmation(undefined);
    setOperationNotice(t("workspace.reviewPushComplete"));
    await reloadCurrentDiff();
  };
  const requestPush = (confirmation?: WorkspaceGitPushResultView): void => {
    if (gitWriteDisabledReason !== undefined) return;
    setPendingGitWrite("push");
    setError(undefined);
    setOperationNotice(undefined);
    runAction(confirmation === undefined ? "review:push" : "review:force-with-lease", async () => {
      try {
        await executePush(confirmation);
      } catch (cause) {
        setError(isLeaseExpiredReviewError(cause) ? t("workspace.reviewPushLeaseExpired") : messageOf(cause));
        throw cause;
      } finally {
        setPendingGitWrite(undefined);
      }
    });
  };
  const requestCommit = (pushAfterCommit: boolean): void => {
    if (gitWriteDisabledReason !== undefined) return;
    const message = commitMessage.trim();
    if (message === "") return;
    setPendingGitWrite(pushAfterCommit ? "commitPush" : "commit");
    setError(undefined);
    setOperationNotice(undefined);
    runAction(pushAfterCommit ? "review:commit-push" : "review:commit", async () => {
      let committed = false;
      try {
        const fence = await currentMutationFence();
        await controller.commitWorkspaceDiff(workspace.id, {
          message,
          includeUnstaged,
          expectedRepositoryRevision: fence.repositoryRevision
        });
        committed = true;
        setCommitMessage("");
        setOperationNotice(t("workspace.reviewCommitComplete"));
        await reloadCurrentDiff();
        if (pushAfterCommit) await executePush();
      } catch (cause) {
        setError(committed ? `${t("workspace.reviewCommitComplete")} ${messageOf(cause)}` : messageOf(cause));
        throw cause;
      } finally {
        setPendingGitWrite(undefined);
      }
    });
  };
  return (
    <>
      <div className="inspector-panel">
        {error !== undefined && <p className="inline-error" role="alert">{error}</p>}
        {operationNotice !== undefined && <p className="review-operation-notice" role="status">{operationNotice}</p>}
        {canDiff && <section className="inspector-section">
          <header><h2>{t("workspace.diff")}</h2><span className="section-count">{diff?.files.length ?? changed.length}</span></header>
          <div className="git-head"><GitBranch aria-hidden="true" /><div><strong>{workspace.branch ?? t("workspace.detached")}</strong><span>{workspace.head === undefined ? t("workspace.noHead") : workspace.head.slice(0, 10)}</span></div></div>
          <div className="review-source-controls">
            <label><span>{t("workspace.reviewSource")}</span><SelectControl aria-label={t("workspace.reviewSource")} value={sourceKind} onChange={(event) => {
              setDiff(undefined);
              setError(undefined);
              setSourceKind(event.target.value as ReviewSourceDescriptor["kind"]);
            }}>
              <option value="unstaged">{t("workspace.reviewSourceUnstaged")}</option>
              <option value="staged">{t("workspace.reviewSourceStaged")}</option>
              <option value="commit">{t("workspace.reviewSourceCommit")}</option>
              <option value="branch">{t("workspace.reviewSourceBranch")}</option>
              <option value="last-turn">{t("workspace.reviewSourceLastTurn")}</option>
              <option value="turn-set">{t("workspace.reviewSourceTurnSet")}</option>
            </SelectControl></label>
            {sourceKind === "commit" && <label><span>{t("workspace.reviewCommitRef")}</span><input value={commitRef} onChange={(event) => setCommitRef(event.target.value)} placeholder="HEAD" aria-invalid={commitRef.length > 0 && !isSafeReviewRef(commitRef.trim(), true)} /></label>}
            {sourceKind === "branch" && <label><span>{t("workspace.reviewBase")}</span><input value={branchRef} onChange={(event) => setBranchRef(event.target.value)} placeholder={t("workspace.reviewBasePlaceholder")} aria-invalid={branchRef.length > 0 && !isSafeReviewRef(branchRef.trim(), false)} /></label>}
            {sourceKind === "turn-set" && <label><span>{t("workspace.reviewTurnSet")}</span><SelectControl value={turnSetId} onChange={(event) => setTurnSetId(event.target.value)} disabled={!changeSetsLoaded || changeSets.length === 0}>{[...changeSets].sort((left, right) => right.capturedAt - left.capturedAt).map((changeSet) => <option value={changeSet.id} key={changeSet.id}>{shortValue(changeSet.turnId || changeSet.id)} · {changeSet.changeCount}</option>)}</SelectControl></label>}
          </div>
          {(sourceKind === "commit" || sourceKind === "branch") && diff !== undefined && <div className="review-comparison-meta" role="status"><Pill tone="accent">{sourceKind === "commit" ? t("workspace.reviewSourceCommit") : branchRef.trim() === "" ? t("workspace.reviewDefaultBaseResolved") : t("workspace.reviewComparison")}</Pill><code>{sourceKind === "branch" && diff.resolvedBaseRef !== undefined ? `${diff.resolvedBaseRef} (${diff.sourceRevision?.slice(0, 10)})` : diff.mergeBaseRevision?.slice(0, 10) ?? diff.baseRevision?.slice(0, 10)} → {diff.headRevision?.slice(0, 10)}</code></div>}
          {diff?.branchBaseWarning !== undefined && <p className="review-source-warning" role="status"><AlertTriangle aria-hidden="true" />{t("workspace.reviewBaseMissingWarning", { requested: diff.branchBaseWarning.requestedBaseRef, resolved: diff.branchBaseWarning.resolvedBaseRef })}</p>}
          <div className="review-toolbar" role="toolbar" aria-label={t("workspace.reviewOptions")}>
            <button type="button" className={viewMode === "unified" ? "is-active" : ""} aria-pressed={viewMode === "unified"} onClick={() => setViewMode("unified")}><AlignJustify aria-hidden="true" />{t("workspace.reviewUnified")}</button>
            <button type="button" className={viewMode === "split" ? "is-active" : ""} aria-pressed={viewMode === "split"} onClick={() => setViewMode("split")}><Columns2 aria-hidden="true" />{t("workspace.reviewSplit")}</button>
            <button type="button" className={wordDiff ? "is-active" : ""} aria-pressed={wordDiff} onClick={() => setWordDiff((current) => !current)}>{t("workspace.reviewWordDiff")}</button>
            <button type="button" className={wordWrap ? "is-active" : ""} aria-pressed={wordWrap} onClick={() => setWordWrap((current) => !current)}><WrapText aria-hidden="true" />{t("workspace.reviewWrap")}</button>
            <button type="button" className={hideWhitespace ? "is-active" : ""} aria-pressed={hideWhitespace} onClick={() => { setDiff(undefined); setHideWhitespace((current) => !current); }}>{t("workspace.reviewHideWhitespace")}</button>
            <button type="button" className={fileTreeVisible ? "is-active" : ""} aria-pressed={fileTreeVisible} onClick={() => setFileTreeVisible((current) => !current)}><ListTree aria-hidden="true" />{t("workspace.reviewFileTree")}</button>
            <button type="button" disabled={expansionAction === "disabled"} aria-label={expansionAction === "collapse" ? t("workspace.reviewCollapseAll") : t("workspace.reviewExpandAll")} onClick={toggleAllDiffs}>{expansionAction === "collapse" ? <FoldVertical aria-hidden="true" /> : <UnfoldVertical aria-hidden="true" />}{expansionAction === "collapse" ? t("workspace.reviewCollapseAll") : t("workspace.reviewExpandAll")}</button>
          </div>
          {diffLoading && <Spinner label={t("workspace.reviewLoadingDiff")} />}
          {!diffLoading && !sourceReady && <p className="muted">{t("workspace.reviewSourceRequired")}</p>}
          {!diffLoading && sourceReady && (diff === undefined && changed.length === 0 ? <div className="clean-state"><CheckCircle2 aria-hidden="true" /><span>{t("workspace.clean")}</span></div> : <WorkspaceDiffPreview
            diff={diff}
            fallback={changed}
            t={t}
            viewMode={viewMode}
            wordWrap={wordWrap}
            wordDiff={wordDiff}
            fileTreeVisible={fileTreeVisible}
            selectedFileKey={selectedFileKey}
            onSelectFile={setSelectedFileKey}
            expandedFileKeys={expandedFileKeys}
            onFileExpandedChange={setFileExpanded}
            canStage={gitWriteDisabledReason === undefined && canStageDiff && sourceKind === "unstaged"}
            canUnstage={gitWriteDisabledReason === undefined && canUnstageDiff && sourceKind === "staged"}
            canRevert={gitWriteDisabledReason === undefined && canRevertDiff && sourceKind === "unstaged" && sourceCapabilities.canDiscard}
            pendingHunkKey={pendingHunkKey}
            onDiffAction={mutateDiff}
            markdownPreview={markdownPreview}
            onLoadMarkdown={loadMarkdownPreview}
            canImagePreview={canDiffImagePreview && sourceCapabilities.canRichPreview}
            imagePreview={imagePreview}
            onLoadImage={loadImagePreview}
            getArtifactUrl={controller.getArtifactUrl}
          />)}
          {(canCommitDiff || canPushDiff) && sourceCapabilities.canCommit && <section className="review-write-panel" aria-label={t("workspace.reviewWriteActions")}>
            <header><GitCommitHorizontal aria-hidden="true" /><strong>{t("workspace.reviewCommitAndPush")}</strong></header>
            {gitWriteDisabledReason !== undefined && <p className="review-write-disabled" role="status"><AlertTriangle aria-hidden="true" />{gitWriteDisabledReason}</p>}
            {canCommitDiff && <textarea rows={3} value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder={t("workspace.reviewCommitPlaceholder")} maxLength={65_536} />}
            {canCommitDiff && <label className="review-checkbox"><CheckboxControl checked={includeUnstaged} onChange={(event) => setIncludeUnstaged(event.target.checked)} /><span>{t("workspace.reviewIncludeUnstaged")}</span></label>}
            {canPushDiff && <div className="review-push-target"><label><span>{t("workspace.reviewRemote")}</span><input value={remote} onChange={(event) => setRemote(event.target.value)} autoComplete="off" /></label><label><span>{t("workspace.reviewRemoteRef")}</span><input value={remoteRef} onChange={(event) => setRemoteRef(event.target.value)} autoComplete="off" /></label></div>}
            <div className="review-write-actions">
              {canCommitDiff && <Button disabled={gitWriteDisabledReason !== undefined || pendingGitWrite !== undefined || commitMessage.trim() === ""} onClick={() => requestCommit(false)}><Check aria-hidden="true" />{t("workspace.reviewCommit")}</Button>}
              {canCommitDiff && canPushDiff && <Button tone="primary" disabled={gitWriteDisabledReason !== undefined || pendingGitWrite !== undefined || commitMessage.trim() === "" || remote.trim() === "" || remoteRef.trim() === ""} onClick={() => requestCommit(true)}><Upload aria-hidden="true" />{t("workspace.reviewCommitAndPush")}</Button>}
              {canPushDiff && <Button disabled={gitWriteDisabledReason !== undefined || pendingGitWrite !== undefined || remote.trim() === "" || remoteRef.trim() === ""} onClick={() => requestPush()}><Upload aria-hidden="true" />{t("workspace.reviewPush")}</Button>}
              {pendingGitWrite !== undefined && <Spinner label={t("workspace.reviewWritePending")} />}
            </div>
          </section>}
        </section>}
        {canRewind && <section className="inspector-section">
          <header><h2>{t("workspace.rewind")}</h2><span className="section-count">{changeSets.length}</span></header>
          <div className="rewind-card"><ShieldAlert aria-hidden="true" /><div><strong>{t("workspace.previewRestore")}</strong><p>{t("workspace.rewindWarning")}</p></div></div>
          {loading && <Spinner label={t("common.loading")} />}
          {changeSets.length === 0 ? <p className="muted">{t("workspace.noChangeSets")}</p> : <ul className="change-set-list">{[...changeSets].sort((left, right) => right.capturedAt - left.capturedAt).map((changeSet) => <li key={changeSet.id}><div><strong>{t("workspace.changeCount", { count: changeSet.changeCount })}</strong><span>{formatRelativeTime(changeSet.capturedAt, controller.state.preferences.locale)} · {shortValue(changeSet.runId)}</span></div><Button onClick={() => openPreview(changeSet)}>{t("workspace.previewAction")}</Button></li>)}</ul>}
        </section>}
      </div>
      <Modal open={preview !== undefined} title={t("workspace.previewTitle")} description={t("workspace.previewDescription")} closeLabel={t("common.close")} size="large" onClose={() => setPreview(undefined)}>
        {preview !== undefined && <div className="rewind-preview">
          <Pill tone={preview.safety === "safe" ? "success" : preview.safety === "requiresConfirmation" ? "warning" : "danger"}>{preview.safety}</Pill>
          <p>{t("workspace.restoreCount", { count: preview.inversePaths.length })}</p>
          {preview.conflicts.length > 0 && <section><strong>{t("workspace.conflicts")}</strong><ul>{preview.conflicts.map((conflict) => <li key={conflict}>{conflict}</li>)}</ul></section>}
          {preview.gaps.length > 0 && <section><strong>{t("workspace.captureGaps")}</strong><ul>{preview.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></section>}
          {preview.diff !== undefined && <WorkspaceDiffPreview diff={preview.diff} fallback={[]} t={t} expandedFileKeys={getExpandedReviewFileKeys(preview.diff.files.map(reviewFileKey), diffsExpanded, diffExpansionOverrides)} onFileExpandedChange={setFileExpanded} />}
          {preview.dialogueOnlyAvailable && <label className="rewind-dialogue-only"><CheckboxControl checked={dialogueOnly} onChange={(event) => setDialogueOnly(event.target.checked)} /><span>{t("workspace.dialogueOnly")}</span></label>}
          <div className="modal__actions"><Button onClick={() => setPreview(undefined)}>{t("common.cancel")}</Button><Button tone={dialogueOnly ? "secondary" : "danger"} disabled={!canExecute} onClick={() => {
            const selectedPreview = preview;
            setPreview(undefined);
            runAction(`rewind:${selectedPreview.changeSetId}`, () => controller.executeWorkspaceRewind(workspace.id, selectedPreview.id, selectedPreview.changeSetId, dialogueOnly));
          }}>{dialogueOnly ? t("workspace.rewindDialogue") : t("workspace.restoreFiles")}</Button></div>
        </div>}
      </Modal>
      <Modal open={revertConfirmation !== undefined} title={t("workspace.reviewRevertTitle")} description={t("workspace.reviewRevertDescription")} closeLabel={t("common.close")} onClose={() => setRevertConfirmation(undefined)}>
        {revertConfirmation !== undefined && <div className="review-revert-confirm"><p><strong>{revertConfirmation.file.path}</strong></p><p>{t("workspace.reviewRevertWarning")}</p><div className="modal__actions"><Button onClick={() => setRevertConfirmation(undefined)}>{t("common.cancel")}</Button><Button tone="danger" disabled={gitWriteDisabledReason !== undefined} onClick={() => { const selected = revertConfirmation; setRevertConfirmation(undefined); mutateDiff(selected.file, selected.target, selected.hunkIndex, "revert", true); }}>{t("workspace.reviewRevert")}</Button></div></div>}
      </Modal>
      <Modal open={forceConfirmation !== undefined} title={t("workspace.reviewPushForceTitle")} description={t("workspace.reviewPushForceDescription")} closeLabel={t("common.close")} onClose={() => setForceConfirmation(undefined)}>
        {forceConfirmation !== undefined && <div className="review-force-confirm">
          <dl><div><dt>{t("workspace.reviewRemoteRef")}</dt><dd><code>{forceConfirmation.remoteRef}</code></dd></div><div><dt>{t("workspace.reviewRemoteOid")}</dt><dd><code>{forceConfirmation.remoteOid}</code></dd></div><div><dt>{t("workspace.reviewAheadBehind")}</dt><dd>↑{forceConfirmation.ahead} ↓{forceConfirmation.behind}</dd></div></dl>
          <p>{t("workspace.reviewPushForceWarning")}</p>
          <div className="modal__actions"><Button onClick={() => setForceConfirmation(undefined)}>{t("common.cancel")}</Button><Button tone="danger" disabled={gitWriteDisabledReason !== undefined || pendingGitWrite !== undefined} onClick={() => { const selected = forceConfirmation; setForceConfirmation(undefined); requestPush(selected); }}>{t("workspace.reviewPushForceConfirm")}</Button></div>
        </div>}
      </Modal>
    </>
  );
}

export async function collectCompleteWorkspaceSearch(
  loadPage: (pageToken?: string) => Promise<WorkspaceSearchPageView>
): Promise<WorkspaceSearchPageView> {
  const matches: WorkspaceSearchMatchView[] = [];
  const consumedTokens = new Set<string>();
  let pageToken: string | undefined;
  let revision: string | undefined;
  let totalMatches = 0;
  let totalFiles = 0;
  let truncated = false;
  for (let pageIndex = 0; pageIndex < INSPECTOR_WORKSPACE_SEARCH_MAX_PAGES; pageIndex += 1) {
    const page = await loadPage(pageToken);
    if (revision === undefined) revision = page.revision;
    else if (page.revision !== revision) throw new Error("Workspace search results changed while pages were loading.");
    matches.push(...page.matches);
    totalMatches = Math.max(totalMatches, page.totalMatches, matches.length);
    totalFiles = Math.max(totalFiles, page.totalFiles);
    truncated = truncated || page.truncated;
    const nextPageToken = page.nextPageToken;
    if (nextPageToken === undefined) return { matches, truncated, totalMatches, totalFiles, revision };
    if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
      throw new Error("Workspace search returned a cyclic page token.");
    }
    consumedTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  throw new Error("Workspace search exceeded the supported page count.");
}

export function WorkspaceDiffPreview({ diff, fallback, ...props }: {
  readonly diff?: WorkspaceDiffView;
  readonly fallback: readonly WorkspaceEntryView[];
  readonly t: Translator;
  readonly viewMode?: "unified" | "split";
  readonly wordWrap?: boolean;
  readonly wordDiff?: boolean;
  readonly fileTreeVisible?: boolean;
  readonly selectedFileKey?: string;
  readonly onSelectFile?: (key: string) => void;
  readonly expandedFileKeys: ReadonlySet<string>;
  readonly onFileExpandedChange: (key: string, expanded: boolean) => void;
  readonly canStage?: boolean;
  readonly canUnstage?: boolean;
  readonly canRevert?: boolean;
  readonly pendingHunkKey?: string;
  readonly onDiffAction?: (file: WorkspaceFileDiffView, target: "file" | "hunk", hunkIndex: number | undefined, action: "stage" | "unstage" | "revert") => void;
  readonly markdownPreview?: { readonly key: string; readonly text?: string; readonly error?: string; readonly truncated?: boolean; readonly loading: boolean };
  readonly onLoadMarkdown?: (file: WorkspaceFileDiffView) => void;
  readonly canImagePreview?: boolean;
  readonly imagePreview?: { readonly key: string; readonly loading: boolean; readonly value?: WorkspaceDiffImageView; readonly error?: string };
  readonly onLoadImage?: (file: WorkspaceFileDiffView) => void;
  readonly getArtifactUrl?: (blobId: string) => Promise<string>;
}): JSX.Element {
  if (diff === undefined) return <ul className="change-list">{fallback.map((entry) => <li key={entry.path}><FileDiff aria-hidden="true" /><div><strong>{entry.name}</strong><span>{entry.path}</span></div><Pill tone={entry.status === "conflicted" ? "danger" : "warning"}>{entry.status}</Pill></li>)}</ul>;
  if (diff.files.length === 0) return <div className="clean-state"><CheckCircle2 aria-hidden="true" /><span>{props.t("workspace.noDiff")}</span></div>;
  return <StructuredWorkspaceDiffPreview diff={diff} {...props} />;
}

function StructuredWorkspaceDiffPreview({ diff, t, viewMode = "unified", wordWrap = false, wordDiff = true, fileTreeVisible = false, selectedFileKey, onSelectFile, expandedFileKeys, onFileExpandedChange, canStage = false, canUnstage = false, canRevert = false, pendingHunkKey, onDiffAction, markdownPreview, onLoadMarkdown, canImagePreview = false, imagePreview, onLoadImage, getArtifactUrl }: {
  readonly diff: WorkspaceDiffView;
  readonly t: Translator;
  readonly viewMode?: "unified" | "split";
  readonly wordWrap?: boolean;
  readonly wordDiff?: boolean;
  readonly fileTreeVisible?: boolean;
  readonly selectedFileKey?: string;
  readonly onSelectFile?: (key: string) => void;
  readonly expandedFileKeys: ReadonlySet<string>;
  readonly onFileExpandedChange: (key: string, expanded: boolean) => void;
  readonly canStage?: boolean;
  readonly canUnstage?: boolean;
  readonly canRevert?: boolean;
  readonly pendingHunkKey?: string;
  readonly onDiffAction?: (file: WorkspaceFileDiffView, target: "file" | "hunk", hunkIndex: number | undefined, action: "stage" | "unstage" | "revert") => void;
  readonly markdownPreview?: { readonly key: string; readonly text?: string; readonly error?: string; readonly truncated?: boolean; readonly loading: boolean };
  readonly onLoadMarkdown?: (file: WorkspaceFileDiffView) => void;
  readonly canImagePreview?: boolean;
  readonly imagePreview?: { readonly key: string; readonly loading: boolean; readonly value?: WorkspaceDiffImageView; readonly error?: string };
  readonly onLoadImage?: (file: WorkspaceFileDiffView) => void;
  readonly getArtifactUrl?: (blobId: string) => Promise<string>;
}): JSX.Element {
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const [containerWidth, setContainerWidth] = useState(0);
  const selected = diff.files.find((file) => reviewFileKey(file) === selectedFileKey) ?? diff.files[0]!;
  const selectedKey = reviewFileKey(selected);
  const virtualized = shouldVirtualizeReviewFileList(diff.files.length);
  const showFileTree = shouldShowReviewFileTree(fileTreeVisible, containerWidth, diff.files.length);
  const fileVirtualizer = useVirtualizer({
    count: diff.files.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => expandedFileKeys.has(reviewFileKey(diff.files[index]!)) ? 360 : 45,
    overscan: 8,
    getItemKey: (index) => reviewFileKey(diff.files[index]!)
  });

  useLayoutEffect(() => {
    const element = layoutRef.current;
    if (element === null) return;
    const update = (): void => setContainerWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    fileVirtualizer.measure();
  }, [expandedFileKeys, fileVirtualizer]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const syncSelectedFileFromScroll = (): void => {
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      const list = listRef.current;
      if (list === null) return;
      const listTop = list.getBoundingClientRect().top;
      const rows = [...list.querySelectorAll<HTMLElement>("[data-review-file-key]")];
      const active = rows.reduce<HTMLElement | undefined>((nearest, row) => {
        if (nearest === undefined) return row;
        const distance = Math.abs(row.getBoundingClientRect().top - listTop);
        const nearestDistance = Math.abs(nearest.getBoundingClientRect().top - listTop);
        return distance < nearestDistance ? row : nearest;
      }, undefined);
      const key = active?.dataset.reviewFileKey;
      if (key !== undefined && key !== selectedFileKey) onSelectFile?.(key);
    });
  };

  const scrollToFile = (key: string): void => {
    const index = diff.files.findIndex((file) => reviewFileKey(file) === key);
    if (index < 0) return;
    onSelectFile?.(key);
    if (!expandedFileKeys.has(key)) onFileExpandedChange(key, true);
    if (virtualized) fileVirtualizer.scrollToIndex(index, { align: "start" });
    requestAnimationFrame(() => {
      const list = listRef.current;
      const row = [...(list?.querySelectorAll<HTMLElement>("[data-review-file-key]") ?? [])]
        .find((candidate) => candidate.dataset.reviewFileKey === key);
      if (list === null || row === undefined) return;
      list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    });
  };

  const renderFile = (file: WorkspaceFileDiffView): JSX.Element => {
    const key = reviewFileKey(file);
    return <WorkspaceReviewFile
      file={file}
      t={t}
      viewMode={viewMode}
      wordWrap={wordWrap}
      wordDiff={wordDiff}
      expanded={expandedFileKeys.has(key)}
      onExpandedChange={(expanded) => onFileExpandedChange(key, expanded)}
      canStage={canStage}
      canUnstage={canUnstage}
      canRevert={canRevert}
      pendingHunkKey={pendingHunkKey}
      onDiffAction={onDiffAction}
      markdownPreview={markdownPreview}
      onLoadMarkdown={onLoadMarkdown}
      canImagePreview={canImagePreview}
      imagePreview={imagePreview}
      onLoadImage={onLoadImage}
      getArtifactUrl={getArtifactUrl}
    />;
  };

  return <div className="workspace-review-stack">
    <ReviewFileJump files={diff.files} selectedKey={selectedKey} onSelect={scrollToFile} t={t} />
    <div ref={layoutRef} className={cx("workspace-review-layout", showFileTree && "has-tree")}>
      <div ref={listRef} className={cx("workspace-diff-preview", virtualized && "is-virtualized")} role="list" data-virtualized-file-list={virtualized ? "true" : undefined} onScroll={syncSelectedFileFromScroll}>
        {virtualized
          ? <div className="workspace-diff-virtual-space" style={{ height: fileVirtualizer.getTotalSize() }}>{fileVirtualizer.getVirtualItems().map((item) => {
            const file = diff.files[item.index];
            if (file === undefined) return null;
            const key = reviewFileKey(file);
            return <div className="workspace-review-row is-virtual" role="listitem" data-review-file-key={key} data-index={item.index} key={item.key} ref={fileVirtualizer.measureElement} style={{ transform: `translateY(${item.start}px)` }}>{renderFile(file)}</div>;
          })}</div>
          : diff.files.map((file) => {
            const key = reviewFileKey(file);
            return <div className="workspace-review-row" role="listitem" data-review-file-key={key} key={key}>{renderFile(file)}</div>;
          })}
      </div>
      {showFileTree && <nav className="review-file-tree" aria-label={t("workspace.reviewFileTree")}><ReviewFileTree files={diff.files} selectedKey={selectedKey} onSelect={scrollToFile} t={t} /></nav>}
    </div>
    {diff.truncated && <Pill tone="warning">{t("workspace.diffTruncated")}</Pill>}
  </div>;
}

export function ReviewFileTree({ files, selectedKey, onSelect, t }: {
  readonly files: readonly WorkspaceFileDiffView[];
  readonly selectedKey: string;
  readonly onSelect: (key: string) => void;
  readonly t: Translator;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [collapsedDirectories, setCollapsedDirectories] = useState<ReadonlySet<string>>(() => new Set());
  const matchedFiles = useMemo(() => filterReviewFiles(files, query), [files, query]);
  const nodes = useMemo(() => buildReviewDiffTree(matchedFiles), [matchedFiles]);
  const effectiveCollapsed = query.trim() === "" ? collapsedDirectories : new Set<string>();
  const flatNodes = useMemo(() => flattenReviewDiffTree(nodes, effectiveCollapsed), [effectiveCollapsed, nodes]);
  const virtualized = shouldVirtualizeReviewFileList(matchedFiles.length);
  const treeVirtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 28,
    overscan: 10,
    getItemKey: (index) => reviewTreeNodeKey(flatNodes[index]?.node)
  });
  const navigationByIndex = useMemo(() => {
    const ancestors: number[] = [];
    return flatNodes.map((entry, index) => {
      ancestors.length = entry.depth;
      const parentIndex = entry.depth > 0 ? ancestors[entry.depth - 1] : undefined;
      ancestors[entry.depth] = index;
      const firstChildIndex = flatNodes[index + 1]?.depth === entry.depth + 1 ? index + 1 : undefined;
      return { parentIndex, firstChildIndex };
    });
  }, [flatNodes]);
  const treeNavigation = useInspectorTreeNavigation({
    treeRef: listRef,
    itemCount: flatNodes.length,
    onRequestItem: (index) => {
      if (virtualized) treeVirtualizer.scrollToIndex(index, { align: "auto" });
    }
  });

  useEffect(() => {
    const activeIndex = flatNodes.findIndex(({ node }) => node.kind === "file" && node.key === selectedKey);
    if (activeIndex < 0) return;
    if (virtualized) {
      treeVirtualizer.scrollToIndex(activeIndex, { align: "auto" });
      return;
    }
    requestAnimationFrame(() => {
      const list = listRef.current;
      const row = [...(list?.querySelectorAll<HTMLElement>("[data-review-tree-key]") ?? [])]
        .find((candidate) => candidate.dataset.reviewTreeKey === selectedKey);
      row?.scrollIntoView({ block: "nearest" });
    });
  }, [flatNodes, selectedKey, treeVirtualizer, virtualized]);

  const toggleDirectory = (path: string): void => {
    setCollapsedDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const renderNode = ({ node, depth }: ReviewDiffTreeFlatNode, index: number): JSX.Element => {
    const key = reviewTreeNodeKey(node);
    const navigation = navigationByIndex[index];
    if (node.kind === "directory") {
      const collapsed = effectiveCollapsed.has(node.path);
      return <button type="button" role="treeitem" tabIndex={-1} aria-level={depth + 1} aria-expanded={!collapsed} data-inspector-tree-key={key} data-inspector-tree-index={index} data-inspector-tree-parent-index={navigation?.parentIndex} data-inspector-tree-first-child-index={navigation?.firstChildIndex} data-inspector-tree-toggle="" data-review-tree-key={key} style={{ paddingLeft: depth * 12 + 4 }} onClick={() => toggleDirectory(node.path)}>{collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}{collapsed ? <Folder aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}<span>{node.name}</span></button>;
    }
    return <button type="button" role="treeitem" tabIndex={-1} aria-level={depth + 1} aria-selected={node.key === selectedKey} className={node.key === selectedKey ? "is-active" : ""} data-inspector-tree-key={node.key} data-inspector-tree-index={index} data-inspector-tree-parent-index={navigation?.parentIndex} data-review-tree-key={node.key} style={{ paddingLeft: depth * 12 + 4 }} onClick={() => onSelect(node.key)}><span className="review-tree-chevron-space" /><File aria-hidden="true" /><span>{node.name}</span><i className={`review-source-dot review-source-dot--${node.file.source}`} aria-hidden="true" /></button>;
  };

  return <>
    <label className="review-file-tree__search"><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("workspace.reviewFilterFiles")} aria-label={t("workspace.reviewFilterFiles")} /></label>
    <div ref={treeNavigation.ref} className="review-file-tree__list" role="tree" data-virtualized-file-tree={virtualized ? "true" : undefined} onFocusCapture={treeNavigation.onFocusCapture} onKeyDown={treeNavigation.onKeyDown}>
      {flatNodes.length === 0
        ? <p className="muted">{t("workspace.reviewNoMatchingFiles")}</p>
        : virtualized
          ? <div className="review-file-tree__virtual-space" style={{ height: treeVirtualizer.getTotalSize() }}>{treeVirtualizer.getVirtualItems().map((item) => {
            const entry = flatNodes[item.index];
            if (entry === undefined) return null;
            return <div className="review-file-tree__virtual-row" data-index={item.index} key={item.key} ref={treeVirtualizer.measureElement} style={{ transform: `translateY(${item.start}px)` }}>{renderNode(entry, item.index)}</div>;
          })}</div>
          : flatNodes.map((entry, index) => <div key={reviewTreeNodeKey(entry.node)}>{renderNode(entry, index)}</div>)}
    </div>
  </>;
}

function reviewTreeNodeKey(node: ReviewDiffTreeNode | undefined): string {
  if (node === undefined) return "missing";
  return node.kind === "directory" ? `directory:${node.path}` : node.key;
}

function ReviewFileJump({ files, selectedKey, onSelect, t }: {
  readonly files: readonly WorkspaceFileDiffView[];
  readonly selectedKey: string;
  readonly onSelect: (key: string) => void;
  readonly t: Translator;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { results, overflowCount } = useMemo(() => filterReviewFileJumpResults(files, query), [files, query]);

  useEffect(() => {
    setSelectedIndex(results.length > 0 ? 0 : -1);
  }, [query, results.length]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const choose = (index: number): void => {
    const result = results[index];
    if (result === undefined) return;
    onSelect(result.key);
    setOpen(false);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => moveReviewFileJumpSelection(current, event.key === "ArrowDown" ? 1 : -1, results.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(selectedIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  return <div ref={rootRef} className="review-file-jump">
    <button type="button" disabled={files.length === 0} aria-expanded={open} aria-label={t("workspace.reviewJumpToFile")} onClick={() => { setQuery(""); setOpen((current) => !current); }}><FileSearch aria-hidden="true" />{t("workspace.reviewJumpToFile")}</button>
    {open && <div className="review-file-jump__popover" onKeyDown={handleKeyDown}>
      <label><Search aria-hidden="true" /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("workspace.reviewFilterFiles")} aria-label={t("workspace.reviewFilterFiles")} /></label>
      <div className="review-file-jump__results" role="listbox" aria-label={t("workspace.reviewJumpToFile")}>
        {results.length === 0 ? <p>{t("workspace.reviewNoMatchingFiles")}</p> : results.map((result, index) => <button type="button" role="option" aria-selected={index === selectedIndex} className={cx(index === selectedIndex && "is-active", result.key === selectedKey && "is-current")} key={result.key} onMouseEnter={() => setSelectedIndex(index)} onClick={() => choose(index)}><strong>{result.fileName}</strong>{result.directory !== "" && <span>{result.directory}</span>}</button>)}
        {overflowCount > 0 && <p>{t("workspace.reviewMoreMatchingFiles", { count: overflowCount })}</p>}
      </div>
    </div>}
  </div>;
}

function WorkspaceReviewFile({ file, t, viewMode, wordWrap, wordDiff, expanded, onExpandedChange, canStage, canUnstage, canRevert, pendingHunkKey, onDiffAction, markdownPreview, onLoadMarkdown, canImagePreview, imagePreview, onLoadImage, getArtifactUrl }: {
  readonly file: WorkspaceFileDiffView;
  readonly t: Translator;
  readonly viewMode: "unified" | "split";
  readonly wordWrap: boolean;
  readonly wordDiff: boolean;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly canStage: boolean;
  readonly canUnstage: boolean;
  readonly canRevert: boolean;
  readonly pendingHunkKey?: string;
  readonly onDiffAction?: (file: WorkspaceFileDiffView, target: "file" | "hunk", hunkIndex: number | undefined, action: "stage" | "unstage" | "revert") => void;
  readonly markdownPreview?: { readonly key: string; readonly text?: string; readonly error?: string; readonly truncated?: boolean; readonly loading: boolean };
  readonly onLoadMarkdown?: (file: WorkspaceFileDiffView) => void;
  readonly canImagePreview: boolean;
  readonly imagePreview?: { readonly key: string; readonly loading: boolean; readonly value?: WorkspaceDiffImageView; readonly error?: string };
  readonly onLoadImage?: (file: WorkspaceFileDiffView) => void;
  readonly getArtifactUrl?: (blobId: string) => Promise<string>;
}): JSX.Element {
  const additions = file.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.kind === "added").length, 0);
  const deletions = file.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.kind === "removed").length, 0);
  const markdownKeySuffix = `:${reviewFileKey(file)}`;
  const activeMarkdown = markdownPreview?.key.endsWith(markdownKeySuffix) === true ? markdownPreview : undefined;
  const activeImage = imagePreview?.key.endsWith(markdownKeySuffix) === true ? imagePreview : undefined;
  const sourceLabel = file.source === "staged"
    ? t("workspace.diffStaged")
    : file.source === "unstaged"
      ? t("workspace.diffUnstaged")
      : file.source === "commit"
        ? t("workspace.reviewSourceCommit")
        : file.source === "branch"
          ? t("workspace.reviewComparison")
          : file.source === "turnSet" ? t("workspace.reviewSourceTurnSet") : t("common.source");
  const stageable = file.source === "unstaged" && canStage;
  const unstageable = file.source === "staged" && canUnstage;
  const revertable = file.source === "unstaged" && canRevert;
  return <details className="workspace-review-file" open={expanded}>
    <summary aria-expanded={expanded} onClick={(event) => { event.preventDefault(); onExpandedChange(!expanded); }}><FileDiff aria-hidden="true" /><strong>{file.oldPath === undefined || file.oldPath === file.path ? file.path : `${file.oldPath} → ${file.path}`}</strong><span className="review-diff-stats"><i>+{additions}</i><b>−{deletions}</b></span>{file.source !== "unspecified" && <Pill tone={file.source === "staged" ? "success" : file.source === "branch" || file.source === "commit" ? "accent" : "warning"}>{sourceLabel}</Pill>}<Pill tone={file.status === "conflicted" ? "danger" : "warning"}>{file.status ?? "changed"}</Pill></summary>
    {(stageable || unstageable || revertable || (isReviewMarkdownPath(file.path) && file.status !== "deleted" && !file.binary && onLoadMarkdown !== undefined) || (canImagePreview && isPreviewableReviewImageDiff(file) && onLoadImage !== undefined)) && <div className="review-file-preview-actions">
      {stageable && <Button tone="ghost" disabled={pendingHunkKey !== undefined} onClick={() => onDiffAction?.(file, "file", undefined, "stage")}><Plus aria-hidden="true" />{t("workspace.reviewStageFile")}</Button>}
      {unstageable && <Button tone="ghost" disabled={pendingHunkKey !== undefined} onClick={() => onDiffAction?.(file, "file", undefined, "unstage")}><Minus aria-hidden="true" />{t("workspace.reviewUnstageFile")}</Button>}
      {revertable && <Button tone="danger" disabled={pendingHunkKey !== undefined} onClick={() => onDiffAction?.(file, "file", undefined, "revert")}><Undo2 aria-hidden="true" />{t("workspace.reviewRevertFile")}</Button>}
      {isReviewMarkdownPath(file.path) && file.status !== "deleted" && !file.binary && onLoadMarkdown !== undefined && <Button tone="ghost" onClick={() => onLoadMarkdown(file)}><FileText aria-hidden="true" />{activeMarkdown?.text === undefined ? t("workspace.reviewMarkdownPreview") : t("workspace.reviewRefreshPreview")}</Button>}
      {canImagePreview && isPreviewableReviewImageDiff(file) && onLoadImage !== undefined && <Button tone="ghost" onClick={() => onLoadImage(file)}><ImageIcon aria-hidden="true" />{activeImage?.value === undefined ? t("workspace.reviewImagePreview") : t("workspace.reviewRefreshPreview")}</Button>}
    </div>}
    {activeMarkdown?.loading === true && <Spinner label={t("workspace.loadingPreview")} />}
    {activeMarkdown?.error !== undefined && <p className="inline-error" role="alert">{activeMarkdown.error}</p>}
    {activeMarkdown?.text !== undefined && <section className="review-markdown-preview" aria-label={t("workspace.reviewMarkdownPreview")}><StreamingMarkdown text={activeMarkdown.text} streaming={false} t={t} />{activeMarkdown.truncated === true && <Pill tone="warning">{t("workspace.previewTruncated")}</Pill>}</section>}
    {activeImage?.loading === true && <Spinner label={t("workspace.loadingPreview")} />}
    {activeImage?.error !== undefined && <p className="inline-error" role="alert">{activeImage.error}</p>}
    {activeImage?.value !== undefined && getArtifactUrl !== undefined && <ReviewImageDiffPreview value={activeImage.value} getArtifactUrl={getArtifactUrl} t={t} />}
    {file.binary ? activeImage?.value === undefined && <p className="muted review-binary-notice">{t("workspace.binary")}</p> : file.hunks.length === 0 ? <p className="muted review-binary-notice">{t("timeline.noTextDiff")}</p> : <ReviewFileHunks file={file} t={t} viewMode={viewMode} wordWrap={wordWrap} wordDiff={wordDiff} stageable={stageable} unstageable={unstageable} revertable={revertable} pending={pendingHunkKey !== undefined} onDiffAction={onDiffAction} />}
  </details>;
}

type ReviewVirtualRow =
  | { readonly kind: "header"; readonly key: string; readonly hunk: WorkspaceDiffHunkView; readonly hunkIndex: number }
  | { readonly kind: "unified"; readonly key: string; readonly line: WorkspaceDiffHunkView["lines"][number]; readonly segments?: readonly InlineWordSegment[] }
  | { readonly kind: "split"; readonly key: string; readonly row: ReviewSplitRow };

function ReviewFileHunks({ file, t, viewMode, wordWrap, wordDiff, stageable, unstageable, revertable, pending, onDiffAction }: {
  readonly file: WorkspaceFileDiffView;
  readonly t: Translator;
  readonly viewMode: "unified" | "split";
  readonly wordWrap: boolean;
  readonly wordDiff: boolean;
  readonly stageable: boolean;
  readonly unstageable: boolean;
  readonly revertable: boolean;
  readonly pending: boolean;
  readonly onDiffAction?: (file: WorkspaceFileDiffView, target: "file" | "hunk", hunkIndex: number | undefined, action: "stage" | "unstage" | "revert") => void;
}): JSX.Element {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const rendered = useMemo(() => {
    const rows: ReviewVirtualRow[] = [];
    let lineCount = 0;
    file.hunks.forEach((hunk, hunkIndex) => {
      rows.push({ kind: "header", key: `header:${hunkIndex}:${hunk.oldStart}:${hunk.newStart}`, hunk, hunkIndex });
      if (viewMode === "split") {
        for (const row of buildReviewSplitRows(hunk)) {
          rows.push({ kind: "split", key: `split:${hunkIndex}:${row.key}`, row });
          lineCount += 1;
        }
        return;
      }
      const inline = wordDiff ? inlineSegmentsForHunk(hunk) : new Map<number, readonly InlineWordSegment[]>();
      hunk.lines.forEach((line, lineIndex) => {
        rows.push({ kind: "unified", key: `line:${hunkIndex}:${lineIndex}:${line.oldLine}:${line.newLine}`, line, segments: inline.get(lineIndex) });
        lineCount += 1;
      });
    });
    return { rows, lineCount };
  }, [file.hunks, viewMode, wordDiff]);
  const virtualized = shouldVirtualizeReviewDiffRows(rendered.lineCount);
  const virtualizer = useVirtualizer({
    count: rendered.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => rendered.rows[index]?.kind === "header" ? 28 : 20,
    overscan: 24,
    getItemKey: (index) => rendered.rows[index]?.key ?? index
  });

  useEffect(() => {
    if (parentRef.current !== null) parentRef.current.scrollLeft = 0;
  }, [viewMode, wordWrap]);

  const hunkHeader = (hunk: WorkspaceDiffHunkView, hunkIndex: number): JSX.Element => <ReviewHunkHeader
    file={file}
    hunk={hunk}
    hunkIndex={hunkIndex}
    t={t}
    stageable={stageable}
    unstageable={unstageable}
    revertable={revertable}
    pending={pending}
    onDiffAction={onDiffAction}
  />;

  if (!virtualized) return <div className={cx("review-hunks", wordWrap && "is-wrapped", `is-${viewMode}`)}>{file.hunks.map((hunk, hunkIndex) => <section className="review-hunk" key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}>
    {hunkHeader(hunk, hunkIndex)}
    {viewMode === "split" ? <ReviewSplitHunk hunk={hunk} wordWrap={wordWrap} wordDiff={wordDiff} /> : <ReviewUnifiedHunk hunk={hunk} wordWrap={wordWrap} wordDiff={wordDiff} />}
  </section>)}</div>;

  const renderVirtualRow = (row: ReviewVirtualRow): JSX.Element => {
    if (row.kind === "header") return <section className="review-hunk review-hunk--virtual-header">{hunkHeader(row.hunk, row.hunkIndex)}</section>;
    if (row.kind === "split") {
      const pair = wordDiff && row.row.left?.kind === "removed" && row.row.right?.kind === "added"
        ? inlineWordDiff(row.row.left.text, row.row.right.text)
        : undefined;
      return <div className="review-split-row"><ReviewSplitCell line={row.row.left} side="left" wordWrap={wordWrap} segments={pair?.before} /><ReviewSplitCell line={row.row.right} side="right" wordWrap={wordWrap} segments={pair?.after} /></div>;
    }
    return <div className={`review-diff-line review-diff-line--${row.line.kind}`}><span>{row.line.oldLine || ""}</span><span>{row.line.newLine || ""}</span><i aria-hidden="true">{diffLineCharacter(row.line.kind)}</i><code className={wordWrap ? "is-wrapped" : undefined}><ReviewLineContent text={row.line.text} segments={row.segments} /></code></div>;
  };

  return <div ref={parentRef} className={cx("review-hunks", "review-hunks--virtual", wordWrap && "is-wrapped", `is-${viewMode}`)} data-virtualized-diff="true">
    <div className={cx("review-diff-table", `review-diff-table--${viewMode}`, "review-diff-virtual-space")} style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const row = rendered.rows[item.index];
        if (row === undefined) return null;
        return <div className="review-diff-virtual-row" data-index={item.index} key={item.key} ref={virtualizer.measureElement} style={{ transform: `translateY(${item.start}px)` }}>{renderVirtualRow(row)}</div>;
      })}
    </div>
  </div>;
}

function ReviewHunkHeader({ file, hunk, hunkIndex, t, stageable, unstageable, revertable, pending, onDiffAction }: {
  readonly file: WorkspaceFileDiffView;
  readonly hunk: WorkspaceDiffHunkView;
  readonly hunkIndex: number;
  readonly t: Translator;
  readonly stageable: boolean;
  readonly unstageable: boolean;
  readonly revertable: boolean;
  readonly pending: boolean;
  readonly onDiffAction?: (file: WorkspaceFileDiffView, target: "file" | "hunk", hunkIndex: number | undefined, action: "stage" | "unstage" | "revert") => void;
}): JSX.Element {
  return <header><code>@@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@ {hunk.heading}</code><div className="review-hunk-actions">
    {stageable && <button type="button" disabled={pending} onClick={() => onDiffAction?.(file, "hunk", hunkIndex, "stage")}><Plus aria-hidden="true" />{t("workspace.reviewStageHunk")}</button>}
    {unstageable && <button type="button" disabled={pending} onClick={() => onDiffAction?.(file, "hunk", hunkIndex, "unstage")}><Minus aria-hidden="true" />{t("workspace.reviewUnstageHunk")}</button>}
    {revertable && <button className="is-danger" type="button" disabled={pending} onClick={() => onDiffAction?.(file, "hunk", hunkIndex, "revert")}><Undo2 aria-hidden="true" />{t("workspace.reviewRevertHunk")}</button>}
  </div></header>;
}

function ReviewImageDiffPreview({ value, getArtifactUrl, t }: {
  readonly value: WorkspaceDiffImageView;
  readonly getArtifactUrl: (blobId: string) => Promise<string>;
  readonly t: Translator;
}): JSX.Element {
  return <section className="review-image-preview" aria-label={t("workspace.reviewImagePreview")}>
    <ReviewImageSide label={t("workspace.reviewImageBefore")} side={value.oldImage} getArtifactUrl={getArtifactUrl} t={t} />
    <ReviewImageSide label={t("workspace.reviewImageAfter")} side={value.newImage} getArtifactUrl={getArtifactUrl} t={t} />
  </section>;
}

function ReviewImageSide({ label, side, getArtifactUrl, t }: {
  readonly label: string;
  readonly side: WorkspaceDiffImageView["oldImage"];
  readonly getArtifactUrl: (blobId: string) => Promise<string>;
  readonly t: Translator;
}): JSX.Element {
  return <figure><figcaption>{label}</figcaption>{side.tooLarge
    ? <p className="muted">{t("workspace.reviewImageTooLarge")}</p>
    : !side.present
      ? <p className="muted">{t("workspace.reviewImageMissing")}</p>
      : side.blobId === undefined
        ? <p className="muted">{t("workspace.reviewImageUnavailable")}</p>
        : <AuthenticatedImage blobId={side.blobId} getUrl={getArtifactUrl} alt={side.alt || label} unavailableLabel={t("workspace.reviewImageUnavailable")} loadingLabel={t("workspace.loadingPreview")} />}</figure>;
}

function ReviewUnifiedHunk({ hunk, wordWrap, wordDiff }: { readonly hunk: WorkspaceDiffHunkView; readonly wordWrap: boolean; readonly wordDiff: boolean }): JSX.Element {
  const inline = wordDiff ? inlineSegmentsForHunk(hunk) : new Map<number, readonly InlineWordSegment[]>();
  return <div className="review-diff-table review-diff-table--unified">{hunk.lines.map((line, index) => <div className={`review-diff-line review-diff-line--${line.kind}`} key={`${line.oldLine}:${line.newLine}:${index}`}><span>{line.oldLine || ""}</span><span>{line.newLine || ""}</span><i aria-hidden="true">{diffLineCharacter(line.kind)}</i><code className={wordWrap ? "is-wrapped" : undefined}><ReviewLineContent text={line.text} segments={inline.get(index)} /></code></div>)}</div>;
}

function ReviewSplitHunk({ hunk, wordWrap, wordDiff }: { readonly hunk: WorkspaceDiffHunkView; readonly wordWrap: boolean; readonly wordDiff: boolean }): JSX.Element {
  return <div className="review-diff-table review-diff-table--split">{buildReviewSplitRows(hunk).map((row) => {
    const pair = wordDiff && row.left?.kind === "removed" && row.right?.kind === "added" ? inlineWordDiff(row.left.text, row.right.text) : undefined;
    return <div className="review-split-row" key={row.key}><ReviewSplitCell line={row.left} side="left" wordWrap={wordWrap} segments={pair?.before} /><ReviewSplitCell line={row.right} side="right" wordWrap={wordWrap} segments={pair?.after} /></div>;
  })}</div>;
}

function ReviewSplitCell({ line, side, wordWrap, segments }: { readonly line?: WorkspaceDiffHunkView["lines"][number]; readonly side: "left" | "right"; readonly wordWrap: boolean; readonly segments?: readonly InlineWordSegment[] }): JSX.Element {
  return <div className={cx("review-split-cell", line === undefined ? "is-empty" : `review-diff-line--${line.kind}`)}><span>{line === undefined ? "" : side === "left" ? line.oldLine || "" : line.newLine || ""}</span><i aria-hidden="true">{line === undefined ? "" : diffLineCharacter(line.kind)}</i><code className={wordWrap ? "is-wrapped" : undefined}>{line !== undefined && <ReviewLineContent text={line.text} segments={segments} />}</code></div>;
}

function ReviewLineContent({ text, segments }: { readonly text: string; readonly segments?: readonly InlineWordSegment[] }): JSX.Element {
  if (segments === undefined || segments.length === 0) return <>{text}</>;
  return <>{segments.map((segment, index) => <span className={segment.changed ? "inline-word-change" : undefined} key={`${index}:${segment.text}`}>{segment.text}</span>)}</>;
}

function inlineSegmentsForHunk(hunk: WorkspaceDiffHunkView): ReadonlyMap<number, readonly InlineWordSegment[]> {
  const result = new Map<number, readonly InlineWordSegment[]>();
  let index = 0;
  while (index < hunk.lines.length) {
    if (hunk.lines[index]!.kind !== "removed") { index += 1; continue; }
    const removed: number[] = [];
    const added: number[] = [];
    while (index < hunk.lines.length && hunk.lines[index]!.kind === "removed") { removed.push(index); index += 1; }
    while (index < hunk.lines.length && hunk.lines[index]!.kind === "added") { added.push(index); index += 1; }
    for (let pairIndex = 0; pairIndex < Math.min(removed.length, added.length); pairIndex += 1) {
      const leftIndex = removed[pairIndex]!;
      const rightIndex = added[pairIndex]!;
      const pair = inlineWordDiff(hunk.lines[leftIndex]!.text, hunk.lines[rightIndex]!.text);
      result.set(leftIndex, pair.before);
      result.set(rightIndex, pair.after);
    }
  }
  return result;
}

function diffLineCharacter(kind: WorkspaceDiffHunkView["lines"][number]["kind"]): string {
  if (kind === "added") return "+";
  if (kind === "removed") return "−";
  if (kind === "noNewline") return "\\";
  return "";
}

export function InspectorShellPanel({ controller, session, timeline, t, runAction }: {
  readonly controller: AppController;
  readonly session: SessionView;
  readonly timeline: readonly TimelineItemView[];
  readonly t: Translator;
  readonly runAction: RunAction;
}): JSX.Element {
  const [command, setCommand] = useState("");
  const [excludeFromContext, setExcludeFromContext] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const ownerRef = useRef({ sessionId: session.id });
  if (ownerRef.current.sessionId !== session.id) ownerRef.current = { sessionId: session.id };
  const shellItems = useMemo(() => timeline.filter(isUserShellTimelineItem), [timeline]);
  const activeShell = [...shellItems].reverse().find((item) =>
    item.tool?.state === "requested" || item.tool?.state === "waiting" || item.tool?.state === "running");
  const running = submitting || activeShell !== undefined;

  useEffect(() => {
    setCommand("");
    setSubmitting(false);
    setStopping(false);
  }, [session.id]);

  const submit = (): void => {
    const value = command.trim();
    if (value === "" || running) return;
    const owner = ownerRef.current;
    setSubmitting(true);
    runAction(`user-shell:${session.id}`, async () => {
      try {
        await controller.executeUserShell(session.id, value, excludeFromContext);
        if (ownerRef.current === owner) setCommand("");
      } finally {
        if (ownerRef.current === owner) setSubmitting(false);
      }
    });
  };

  const abort = (): void => {
    if (!running || stopping) return;
    const owner = ownerRef.current;
    setStopping(true);
    runAction(`user-shell-abort:${session.id}`, async () => {
      try {
        await controller.abortUserShell(session.id);
      } finally {
        if (ownerRef.current === owner) setStopping(false);
      }
    });
  };

  return <div className="inspector-panel inspector-shell-panel">
    <section className="inspector-section inspector-shell-panel__composer">
      <header><h2>{t("composer.shell")}</h2><Pill tone={running ? "accent" : "neutral"}>{running ? t("common.working") : session.state}</Pill></header>
      <p className="muted">{t("composer.shellHelp")}</p>
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea
          value={command}
          aria-label={t("composer.shellPlaceholder")}
          placeholder={t("composer.shellPlaceholder")}
          spellCheck={false}
          disabled={running}
          onChange={(event) => setCommand(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
        <div className="inspector-shell-panel__actions">
          <label><CheckboxControl checked={excludeFromContext} disabled={running} onChange={(event) => setExcludeFromContext(event.currentTarget.checked)} />{t("composer.shellExclude")}</label>
          {running
            ? <Button type="button" disabled={stopping} onClick={abort}><Square aria-hidden="true" />{t("composer.shellAbort")}</Button>
            : <Button type="submit" tone="primary" disabled={command.trim() === ""}><Terminal aria-hidden="true" />{t("composer.shellEnter")}</Button>}
        </div>
      </form>
    </section>
    <section className="inspector-section">
      <header><h2>{t("tools.runTools")}</h2><span className="section-count">{shellItems.length}</span></header>
      {shellItems.length === 0
        ? <p className="muted">{t("tools.noTimelineActivity")}</p>
        : <div className="tool-inspector-list">{[...shellItems].reverse().map((item) => <details key={item.id} open={item.tool?.state === "running" || item.tool?.state === "failed"}>
          <summary><StatusDot state={item.tool?.state ?? "muted"} label={item.tool?.state ?? t("timeline.tool")} /><strong>{item.tool?.input || item.tool?.name}</strong><Pill tone={item.tool?.state === "failed" ? "danger" : item.tool?.state === "succeeded" ? "success" : item.tool?.state === "running" ? "accent" : "neutral"}>{item.tool?.state}</Pill><ChevronDown className="details-chevron" aria-hidden="true" /></summary>
          {item.tool?.input !== "" && <section><h3>{t("common.input")}</h3><WindowedText text={item.tool?.input ?? ""} label={`${t("composer.shell")} ${t("common.input")}`} /></section>}
          {item.tool?.output !== undefined && <section><h3>{t("common.output")}</h3><WindowedText text={item.tool.output} label={`${t("composer.shell")} ${t("common.output")}`} /></section>}
        </details>)}</div>}
    </section>
  </div>;
}

function isUserShellTimelineItem(item: TimelineItemView): boolean {
  return (item.kind === "tool" || item.kind === "toolResult") && item.tool?.name.toLocaleLowerCase() === "shell";
}

function ToolPanel({ toolItems, resources, runtimeSupported, runtimeCatalog, runtimeState, runtimeError, onRefreshRuntime, locale, t }: {
  readonly toolItems: readonly TimelineItemView[];
  readonly resources: readonly ResourceView[];
  readonly runtimeSupported: boolean;
  readonly runtimeCatalog?: RuntimeToolCatalogView;
  readonly runtimeState: "idle" | "loading" | "ready" | "error";
  readonly runtimeError?: string;
  readonly onRefreshRuntime: () => void;
  readonly locale: string;
  readonly t: Translator;
}): JSX.Element {
  return (
    <div className="inspector-panel">
      {runtimeSupported && <section className="inspector-section runtime-tool-catalog"><header><h2>{t("tools.runtimeCatalog")}</h2>{runtimeCatalog !== undefined && <span className="runtime-tool-catalog__observation">{t("tools.runtimeObserved", { generation: runtimeCatalog.runtimeGeneration.toString(), time: formatRelativeTime(runtimeCatalog.observedAt, locale) })}</span>}<span className="section-count">{runtimeCatalog?.tools.length ?? 0}</span><IconButton label={t("tools.refreshRuntimeCatalog")} disabled={runtimeState === "loading"} onClick={onRefreshRuntime}><RefreshCcw aria-hidden="true" /></IconButton></header>
        {runtimeState === "loading" && <Spinner label={t("tools.loadingRuntimeCatalog")} />}
        {runtimeState === "error" && <div className="runtime-tool-catalog__error" role="alert"><p>{t("tools.runtimeCatalogError")}</p>{runtimeError !== undefined && <small>{runtimeError}</small>}<Button onClick={onRefreshRuntime}><RefreshCcw aria-hidden="true" />{t("common.retry")}</Button></div>}
        {runtimeState === "ready" && runtimeCatalog?.tools.length === 0 && <p className="muted">{t("tools.noRuntimeTools")}</p>}
        {runtimeCatalog !== undefined && runtimeState === "ready" && runtimeCatalog.tools.length > 0 && <div className="tool-inspector-list runtime-tool-list">{runtimeCatalog.tools.map((tool) => <details key={tool.name}><summary><StatusDot state={tool.active ? "succeeded" : "muted"} label={tool.active ? t("tools.runtimeActive") : t("tools.runtimeInactive")} /><strong>{tool.name}</strong><Pill tone={tool.active ? "success" : "neutral"}>{tool.active ? t("tools.runtimeActive") : t("tools.runtimeInactive")}</Pill><ChevronDown className="details-chevron" aria-hidden="true" /></summary><section>
          {tool.description !== "" && <p>{tool.description}</p>}
          <dl className="runtime-tool-list__source"><div><dt>{t("tools.runtimeSource")}</dt><dd>{tool.source.name} · {tool.source.scope} · {tool.source.origin}</dd></div><div><dt>{t("tools.runtimePath")}</dt><dd><code>{tool.source.path}</code></dd></div>{tool.source.baseDirectory !== undefined && <div><dt>{t("tools.runtimeBaseDirectory")}</dt><dd><code>{tool.source.baseDirectory}</code></dd></div>}</dl>
          <h3>{t("tools.runtimeInputSchema")}</h3>
          {tool.fields.length === 0 ? <p className="muted">{t("tools.runtimeNoFields")}</p> : <ul className="runtime-tool-field-list">{tool.fields.map((field) => <li key={field.path}><code>{field.path}</code><span>{field.type}</span>{field.required && <Pill>{t("tools.runtimeRequired")}</Pill>}{field.secret && <Pill tone="warning">{t("tools.runtimeSecret")}</Pill>}{field.description !== "" && <small>{field.description}</small>}</li>)}</ul>}
          {tool.allowsAdditionalFields && <p className="muted">{t("tools.runtimeAdditionalFields")}</p>}
          {tool.promptGuidelines.length > 0 && <><h3>{t("tools.runtimeGuidelines")}</h3><ul className="runtime-tool-guidelines">{tool.promptGuidelines.map((guideline, index) => <li key={`${tool.name}:${index}`}>{guideline}</li>)}</ul></>}
        </section></details>)}</div>}
      </section>}
      <section className="inspector-section"><header><h2>{t("tools.runTools")}</h2><span className="section-count">{toolItems.length}</span></header>{toolItems.length === 0 ? <p className="muted">{t("tools.noTimelineActivity")}</p> : <div className="tool-inspector-list">{[...toolItems].reverse().map((item) => <details key={item.id} open={item.tool?.state === "running" || item.tool?.state === "failed"}><summary><StatusDot state={item.tool?.state ?? "muted"} label={item.tool?.state ?? t("timeline.tool")} /><strong>{item.tool?.name}</strong><Pill tone={item.tool?.state === "failed" ? "danger" : item.tool?.state === "succeeded" ? "success" : "neutral"}>{item.tool?.state}</Pill><ChevronDown className="details-chevron" aria-hidden="true" /></summary>{item.tool?.input !== "" && <section><h3>{t("common.input")}</h3><WindowedText text={item.tool?.input ?? ""} label={`${item.tool?.name ?? t("timeline.tool")} ${t("common.input")}`} /></section>}{item.tool?.output !== undefined && <section><h3>{t("common.output")}</h3><WindowedText text={item.tool.output} label={`${item.tool.name} ${t("common.output")}`} /></section>}</details>)}</div>}</section>
      <section className="inspector-section"><header><h2>{t("tools.resources")}</h2><span className="section-count">{resources.length}</span></header>{resources.length === 0 ? <p className="muted">{t("tools.noDiscoveredResources")}</p> : <ul className="resource-mini-list">{resources.map((resource) => <li key={resource.id}><Braces aria-hidden="true" /><div><strong>{resource.name}</strong><span>{resource.kind} · {resource.scope}</span></div><Pill tone={resource.state === "loaded" ? "success" : resource.state === "error" ? "danger" : "neutral"}>{resource.state}</Pill></li>)}</ul>}</section>
    </div>
  );
}

export function BrowserPanel({ controller, browsers, browserSettings, session, commentSessions, locale, focusRequest, t, runAction }: {
  readonly controller: AppController;
  readonly browsers: readonly BrowserView[];
  readonly browserSettings: AppSnapshot["settings"]["browsers"];
  readonly session: SessionView;
  readonly commentSessions: readonly SessionView[];
  readonly locale: string;
  readonly focusRequest?: BrowserInspectorFocusRequest;
  readonly t: Translator;
  readonly runAction: RunAction;
}): JSX.Element {
  const [selectedBrowserId, setSelectedBrowserId] = useState(focusRequest?.browserId);
  const [selectedPageId, setSelectedPageId] = useState<string>();
  const [captured, setCaptured] = useState<Readonly<Record<string, string>>>({});
  const scopedBrowsers = useMemo(() => browsers.map((browser) => {
    const pages = browser.pages.filter((page) => page.sessionId === session.id);
    const { activePageId, ...provider } = browser;
    return {
      ...provider,
      pages,
      ...(activePageId !== undefined && pages.some((page) => page.id === activePageId)
        ? { activePageId }
        : {})
    };
  }), [browsers, session.id]);
  const pageSessions = useMemo(() => [session], [session]);
  const source = scopedBrowsers.find((browser) => browser.id === selectedBrowserId) ?? scopedBrowsers[0];
  const liveTakeover = useLiveBrowserTakeover(source?.takeover);
  const capturedRef = useRef(captured);
  const controllerRef = useRef(controller);
  capturedRef.current = captured;
  controllerRef.current = controller;
  useEffect(() => () => {
    for (const blobId of Object.values(capturedRef.current)) controllerRef.current.releaseArtifactUrl(blobId);
  }, []);
  useEffect(() => {
    if (focusRequest === undefined) return;
    setSelectedBrowserId(focusRequest.browserId);
    setSelectedPageId(focusRequest.pageId);
  }, [focusRequest?.requestId]);
  useEffect(() => {
    if (browsers.length === 0 || browsers.some((browser) => browser.id === selectedBrowserId)) return;
    if (focusRequest?.browserId === selectedBrowserId) return;
    setSelectedBrowserId(browsers[0]?.id);
    setSelectedPageId(undefined);
  }, [browsers, focusRequest?.browserId, selectedBrowserId]);
  if (source === undefined) return <PanelEmpty text={t("tools.noBrowser")} />;
  const browser = withLiveBrowserTakeover(source, liveTakeover);
  const selected = browser.pages.find((page) => page.id === selectedPageId)
    ?? browser.pages.find((page) => page.id === browser.activePageId)
    ?? browser.pages[0];
  const storeCapture = (browserId: string, pageId: string, blobId: string): void => {
    setCaptured((current) => {
      const key = browserPageKey(browserId, pageId);
      const previous = current[key];
      if (previous !== undefined && previous !== blobId) controller.releaseArtifactUrl(previous);
      return { ...current, [key]: blobId };
    });
  };
  const capture = (browserId: string, pageId: string): void => {
    runAction(`browser-capture:${browserPageKey(browserId, pageId)}`, async () => {
      storeCapture(browserId, pageId, await controller.captureBrowserScreenshot(browserId, pageId, false));
    });
  };
  return (
    <div className="inspector-panel">
      {browsers.length > 1 && <label className="browser-provider-switcher"><span>{t("settings.provider")}</span><SelectControl aria-label={t("settings.provider")} value={browser.id} onChange={(event) => {
        setSelectedBrowserId(event.currentTarget.value);
        setSelectedPageId(undefined);
      }}>{browsers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</SelectControl></label>}
      <section className="browser-provider-card"><header><div><StatusDot state={browser.state} label={browser.state} /><strong>{browser.name}</strong></div><Pill>{browser.state}</Pill>{browser.takeover !== undefined && <Pill tone={browser.takeover.state === "active" ? "accent" : "warning"}>{t("browser.takeoverState", { state: browser.takeover.state })}</Pill>}</header><div className="browser-provider-card__actions"><Button onClick={() => runAction(`browser-recover:${browser.id}`, () => controller.restartBrowser(browser.id))}><RefreshCcw aria-hidden="true" />{t("browser.recover")}</Button>{browser.takeover?.state === "active" && browser.takeover.connectionId === controller.state.activeProfile?.id && <Button tone="primary" onClick={() => runAction(`browser-release:${browser.id}`, () => controller.endBrowserTakeover(browser.id))}>{t("browser.release")}</Button>}</div></section>
      <div className="inspector-browser-layout">
        <BrowserPageRail browser={browser} selectedPageId={selected?.id} sessions={pageSessions} controller={controller} t={t} runAction={runAction} onSelect={(selection) => setSelectedPageId(selection?.pageId)} />
        {selected?.recoverable === true
          ? <BrowserLostPageCard page={selected} t={t} />
          : <BrowserCanvas
            browser={browser}
            page={selected}
            allowUploads={browserSettings.find((settings) => settings.browserProviderId === browser.id)?.allowUploads === true}
            screenshotBlobId={selected === undefined ? undefined : captured[browserPageKey(browser.id, selected.id)] ?? selected.screenshotBlobId}
            sessions={commentSessions}
            locale={locale}
            t={t}
            controller={controller}
            runAction={runAction}
            onCapture={capture}
            onStoreCapture={storeCapture}
            onUpload={(browserId, pageId, file) => {
              runAction(`browser-upload:${browserPageKey(browserId, pageId)}`, () => controller.uploadBrowserFile(browserId, pageId, file));
            }}
            onAction={async (browserId, pageId, action) => {
              storeCapture(browserId, pageId, await controller.performBrowserTakeoverAction(browserId, pageId, action));
            }}
          />}
      </div>
    </div>
  );
}

function PanelEmpty({ text }: { readonly text: string }): JSX.Element {
  return <div className="panel-empty"><CircleDot aria-hidden="true" /><p>{text}</p></div>;
}

function findEntry(entries: readonly WorkspaceEntryView[], path?: string): WorkspaceEntryView | undefined {
  if (path === undefined) return undefined;
  for (const entry of entries) {
    if (entry.path === path) return entry;
    const nested = findEntry(entry.children ?? [], path);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function entryMatches(entry: WorkspaceEntryView, query: string): boolean {
  return query === "" || `${entry.name} ${entry.path}`.toLowerCase().includes(query) || (entry.children?.some((child) => entryMatches(child, query)) ?? false);
}

function flattenEntries(entries: readonly WorkspaceEntryView[]): WorkspaceEntryView[] {
  return entries.flatMap((entry) => [entry, ...flattenEntries(entry.children ?? [])]);
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function shortValue(value: string): string {
  return value.length > 9 ? `${value.slice(0, 7)}…` : value || "unknown";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected workspace error";
}

function isLeaseExpiredReviewError(error: unknown): boolean {
  return /lease|remote branch changed|stale remote/iu.test(messageOf(error));
}

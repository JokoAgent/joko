import { Fragment } from "react";
import type { JSX, KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlignJustify,
  Archive,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleDot,
  Clock,
  Coins,
  Copy,
  Ellipsis,
  ExternalLink,
  FileOutput,
  Filter,
  FolderOpen,
  FolderKanban,
  Folders,
  GitBranch,
  GitPullRequest,
  LayoutGrid,
  LayoutList,
  Laptop,
  LoaderCircle,
  MessageSquare,
  Info,
  PanelRight,
  Pause,
  Pin,
  Play,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
  Rows2,
  Trash2,
  Undo2,
  Wallet,
  Wrench,
  X
} from "lucide-react";
import type { AppRoute } from "../controller.js";
import type { AppSnapshot, ConnectionProfile, FederatedSessionMessageSearchMatchView, MachineCacheView, MachinePresenceView, MachineSessionCacheView, ScheduleView, SessionMessageSearchFiltersView, SessionMessageSearchMatchView, SessionView, TargetView } from "../model.js";
import { selectedRemoteMachineCaches, type MachineSelection } from "../machine-federation.js";
import type { NavigationMode } from "../navigation-layout.js";
import {
  cancelSessionWindowDragPreviewForSession,
  finishSessionWindowDragPreview,
  startSessionWindowDragPreview
} from "../session-window-drag-preview.js";
import { sessionTaskLink } from "../session-window-navigation.js";
import type { SessionProjectNavigationPlacement } from "../session-project-navigation.js";
import { portableSessionExportSupported } from "../portable-session-ui.js";
import { sidebarSessionListView } from "../sidebar-session-list.js";
import {
  groupSidebarScheduleSessions,
  sidebarScheduleEntryActivityAt,
  sidebarScheduleEntrySessions,
  type SidebarScheduleSessionEntry,
  type SidebarScheduleSessionGroup
} from "../sidebar-schedule-groups.js";
import {
  advanceSidebarViewedPriority,
  createSidebarDoneAttentionVisibilityState,
  createSidebarViewedPriorityState,
  filterSidebarSessions,
  holdSidebarViewedPriorityRank,
  manualSidebarOrderAfterVisibleReorder,
  normalizeManualSidebarOrder,
  promoteNewPinnedSidebarIds,
  reconcileSidebarDoneAttentionVisibility,
  sameSidebarOrder,
  sidebarGroupIndicatorState,
  sidebarContentFilterCount,
  sidebarLastActivityCutoff,
  sidebarOwnerLayoutFor,
  sidebarSessionIndicatorState,
  sortSidebarSessions,
  sortSidebarTargets,
  toggleSidebarProjectFilter,
  toggleSidebarSessionInfoField,
  visibleSidebarAttention,
  type SidebarDisplayPreferences,
  type SidebarLayout,
  type SidebarOwnerLayout,
  type SidebarOwnerLayouts,
  type SidebarPriorityContext,
  type SidebarRightStatus,
  type SidebarSessionInfoField,
  SIDEBAR_DIALOGUE_FILTER_ID
} from "../sidebar-layout.js";
import { workspaceSelectedFileStore } from "../workspace-selected-file.js";
import { type FuzzyTextMatch, type SidebarFuzzyMatch } from "./coding-ui-behavior.js";
import {
  ALL_CONVERSATION_SEARCH_FILTERS,
  CONVERSATION_SEARCH_RESULT_LIMIT,
  conversationSearchHighlightRanges,
  flattenConversationSearchOptions,
  moveConversationSearchSelection,
  projectConversationSearchResults,
  resolveConversationSearchActivation,
  type ConversationSearchLastActivityFilter,
  type ConversationSearchOption,
  type ConversationSearchResult,
  type ConversationSearchSort,
  type ConversationSearchStatusFilter
} from "./conversation-search.js";
import type { Translator } from "./types.js";
import { SidebarFrame } from "./SidebarFrame.js";
import { sidebarSessionInfoPieces } from "./sidebar-session-info.js";
import { SortableList } from "./SortableList.js";
import { Button, IconButton, Modal, TipSummary, cx, formatRelativeTime, CheckboxControl, SelectControl } from "./ui.js";
import "./sidebar-organizer.css";
import { SESSION_SPLIT_DRAG_TYPE } from "./SessionSplitView.js";
import { SESSION_LINK_DRAG_MIME } from "./composer-internal-drop.js";
import { MachineSwitcherMenu } from "./MachineSwitcherMenu.js";
import { scheduleDisplayStatus } from "./scheduler-list.js";
import { ScheduleDeleteDialog } from "./ScheduleDeleteDialog.js";
import type { GeneratedSessionDisposition, ScheduleDeletionPreview } from "../schedule-deletion.js";
import { CodeHostPullRequestSidebarBadge, codeHostPullRequestTooltip } from "./CodeHostPullRequestSummary.js";
import { dialogueBackends } from "./new-session-options.js";
import { SidebarHoverCard, type SidebarHoverCardTriggerProps } from "./SidebarHoverCard.js";

export const CONVERSATION_KEYWORD_DEBOUNCE_MS = 250;
export const CONVERSATION_HYBRID_DEBOUNCE_MS = 900;
const MESSAGE_SEARCH_DAY_MS = 24 * 60 * 60 * 1_000;
const SESSION_ACTION_MENU_WIDTH = 180;
const SESSION_ACTION_MENU_ESTIMATED_HEIGHT = 326;
const SESSION_ACTION_MENU_OFFSET = 4;
const SESSION_ACTION_MENU_VIEWPORT_MARGIN = 8;
const SESSION_PROJECT_MENU_WIDTH = 224;
const SESSION_PROJECT_MENU_ESTIMATED_HEIGHT = 280;
const EMPTY_SESSION_ID_SET: ReadonlySet<string> = new Set();
const SIDEBAR_LIST_MENU_WIDTH = 248;
const SIDEBAR_LIST_MENU_ESTIMATED_HEIGHT = 470;
const SIDEBAR_LIST_MENU_OFFSET = 7;
const SIDEBAR_RAIL_PANEL_CLOSE_GRACE_MS = 120;
const SIDEBAR_RAIL_PANEL_KEEPALIVE_SELECTOR = ".sidebar-rail-panel, [data-sidebar-rail-trigger], .sidebar-project-actions-menu, .session-menu-popover, .session-project-menu-popover, [role='dialog'], [role='alertdialog']";
const MESSAGE_SEARCH_ACTIVITY_DAYS: Readonly<Record<Exclude<ConversationSearchLastActivityFilter, "all">, number>> = {
  "1d": 1,
  "3d": 3,
  "7d": 7,
  "30d": 30
};

interface RemoteMachineSearchOptionBase {
  readonly key: string;
  readonly profileId: string;
  readonly machineName: string;
  readonly presence: MachinePresenceView;
  readonly session: MachineSessionCacheView;
  readonly source: "live" | "cache";
  readonly reachable: boolean;
}

export interface RemoteMachineSessionSearchOption extends RemoteMachineSearchOptionBase {
  readonly kind: "remoteSession";
  readonly titleMatched: boolean;
  readonly hits: readonly SessionMessageSearchMatchView[];
}

export interface RemoteMachineMessageSearchOption extends RemoteMachineSearchOptionBase {
  readonly kind: "remoteMessage";
  readonly source: "live";
  readonly reachable: true;
  readonly match: SessionMessageSearchMatchView;
}

export interface RemoteMachineExpandSearchOption extends RemoteMachineSearchOptionBase {
  readonly kind: "remoteExpand";
  readonly source: "live";
  readonly reachable: true;
  readonly hiddenHitCount: number;
}

export type RemoteMachineSearchOption = RemoteMachineSessionSearchOption | RemoteMachineMessageSearchOption | RemoteMachineExpandSearchOption;

export interface RemoteMachineSearchResult extends RemoteMachineSearchOptionBase {
  readonly titleMatched: boolean;
  readonly hits: readonly SessionMessageSearchMatchView[];
  readonly relevance: number;
  readonly score: number;
  readonly activityAt?: number;
}

export type FederatedSidebarSearchGroup =
  | { readonly kind: "local"; readonly key: string; readonly result: ConversationSearchResult }
  | { readonly kind: "remote"; readonly key: string; readonly result: RemoteMachineSearchResult };

type SidebarSearchOption = ConversationSearchOption | RemoteMachineSearchOption;
const SIDEBAR_MAIN_VIEW_OPTIONS = [
  { value: "text", label: "nav.viewText", Icon: AlignJustify },
  { value: "list", label: "nav.viewList", Icon: LayoutList }
] as const;
const SIDEBAR_PINNED_VIEW_OPTIONS = [
  ...SIDEBAR_MAIN_VIEW_OPTIONS,
  { value: "card", label: "nav.viewCard", Icon: LayoutGrid }
] as const;
const SIDEBAR_PINNED_PROJECT_PREFIX = "project:";
const SIDEBAR_PINNED_REMOTE_SESSION_PREFIX = "remote:";
type SidebarPinnedEntry =
  | { readonly kind: "session"; readonly id: string; readonly session: SessionView }
  | { readonly kind: "remoteSession"; readonly id: string; readonly cache: MachineCacheView; readonly session: MachineSessionCacheView }
  | { readonly kind: "project"; readonly id: string; readonly target: TargetView; readonly sessions: readonly SessionView[] };
type SidebarPinnedSessionEntry = Exclude<SidebarPinnedEntry, { readonly kind: "project" }>;
type SidebarRailPanelSection = "projects" | "dialogues";
type SidebarRailProjectEntry =
  | { readonly kind: "local"; readonly id: string; readonly name: string; readonly target: TargetView; readonly sessions: readonly SessionView[] }
  | { readonly kind: "remote"; readonly id: string; readonly name: string; readonly cache: MachineCacheView; readonly sessions: readonly MachineSessionCacheView[] };
interface SidebarRailPanelAnchor {
  readonly right: number;
  readonly top: number;
}
interface SidebarRailPanelState {
  readonly section: SidebarRailPanelSection;
  readonly anchor: SidebarRailPanelAnchor;
  readonly trigger: HTMLButtonElement;
  readonly openedViaKeyboard: boolean;
  readonly projectId?: string;
  readonly projectAnchor?: SidebarRailPanelAnchor;
  readonly projectOpenedViaKeyboard?: boolean;
}
interface SidebarRailPreviewState {
  readonly entry: SidebarPinnedSessionEntry;
  readonly anchor: SidebarRailPanelAnchor;
}
interface SidebarProjectActions {
  readonly allSessions: readonly SessionView[];
  readonly onEditTarget: (target: TargetView) => void;
  readonly onNewTaskInTarget?: (target: TargetView) => void;
  readonly onRenameTarget?: (target: TargetView, name: string) => void;
  readonly onPinTarget: (target: TargetView) => void;
  readonly onSearchTarget: (target: TargetView) => void;
  readonly onCopyTargetLink?: (target: TargetView) => void;
  readonly onRemoveTarget?: (target: TargetView) => void;
  readonly onSetTargetSessionsArchived?: (target: TargetView, sessions: readonly SessionView[], archived: boolean) => void;
}
const SIDEBAR_SESSION_INFO_OPTIONS = [
  { value: "time", label: "nav.sessionInfoTime", Icon: Clock },
  { value: "pr", label: "nav.sessionInfoPullRequest", Icon: GitPullRequest },
  { value: "worktree", label: "nav.sessionInfoWorktree", Icon: Folders },
  { value: "tokens", label: "nav.sessionInfoTokens", Icon: Coins },
  { value: "cost", label: "nav.sessionInfoCost", Icon: Wallet }
] as const;
export interface SidebarProps {
  readonly snapshot: AppSnapshot;
  readonly activeSessionId?: string;
  readonly route: AppRoute;
  readonly locale: string;
  readonly messageSearchSort: ConversationSearchSort;
  readonly sidebarOwnerId: string;
  readonly sidebarDisplayPreferences: SidebarDisplayPreferences;
  readonly sidebarOwnerLayouts: SidebarOwnerLayouts;
  readonly open: boolean;
  readonly mode: NavigationMode;
  readonly width: number;
  readonly searchInputRef: RefObject<HTMLInputElement | null>;
  readonly t: Translator;
  readonly probeRuntimeActivity: () => Promise<boolean>;
  readonly onNavigate: (route: AppRoute) => void;
  readonly onNewTask: () => void;
  readonly onNewTaskInTarget?: (target: TargetView) => void;
  readonly onNewDialogue?: (backendId: string) => void;
  readonly onRename: (session: SessionView, name: string) => void;
  readonly onPin: (session: SessionView) => void;
  readonly onPinTarget: (target: TargetView) => void;
  readonly onRenameTarget?: (target: TargetView, name: string) => void;
  readonly onRemoveTarget?: (target: TargetView) => void;
  readonly onSetTargetSessionsArchived?: (target: TargetView, sessions: readonly SessionView[], archived: boolean) => void;
  readonly onCopyTargetLink?: (target: TargetView) => void;
  readonly onArchive: (session: SessionView) => void;
  readonly onDelete: (session: SessionView) => void;
  readonly onRunSchedule?: (schedule: ScheduleView) => Promise<void>;
  readonly onToggleSchedule?: (schedule: ScheduleView) => Promise<void>;
  readonly onPreviewScheduleDeletion?: (schedule: ScheduleView) => Promise<ScheduleDeletionPreview>;
  readonly onDeleteSchedule?: (schedule: ScheduleView, disposition: GeneratedSessionDisposition) => Promise<void>;
  readonly onBulkArchive?: (sessions: readonly SessionView[]) => void;
  readonly onBulkDelete?: (sessions: readonly SessionView[]) => void;
  readonly onCopyTaskLink?: (session: SessionView) => void;
  readonly onExportPortableSession?: (session: SessionView) => void;
  readonly onSplitSession?: (session: SessionView, side: "right" | "bottom") => void;
  readonly onOpenSessionWindow?: (session: SessionView) => void;
  readonly movingSessionProjectIds?: ReadonlySet<string>;
  readonly onMoveSessionProject?: (session: SessionView, placement: SessionProjectNavigationPlacement) => void;
  readonly onSearchMessages: (
    query: string,
    semanticMode: "keyword" | "hybrid",
    filters: SessionMessageSearchFiltersView,
    signal: AbortSignal
  ) => Promise<readonly SessionMessageSearchMatchView[]>;
  readonly onSearchRemoteMessages?: (
    query: string,
    semanticMode: "keyword" | "hybrid",
    filters: SessionMessageSearchFiltersView,
    signal: AbortSignal
  ) => Promise<readonly FederatedSessionMessageSearchMatchView[]>;
  readonly onMessageSearchSortChange: (sort: ConversationSearchSort) => void;
  readonly onSidebarDisplayPreferencesChange: (patch: Partial<SidebarDisplayPreferences>) => void;
  readonly onSidebarOwnerLayoutChange: (patch: Partial<SidebarOwnerLayout>) => void;
  readonly onOpenMessageMatch: (match: SessionMessageSearchMatchView) => void;
  readonly onClose: () => void;
  readonly onHide: () => void;
  readonly onCollapse: () => void;
  readonly onExpand: () => void;
  readonly onResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onResizePointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onResizePointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onResizePointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onResizeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onResetWidth: () => void;
  readonly onDisconnect: () => void;
  readonly machineControl?: {
    readonly profiles: readonly ConnectionProfile[];
    readonly activeProfile: ConnectionProfile;
    readonly presenceByProfile: Readonly<Record<string, MachinePresenceView>>;
    readonly caches: readonly MachineCacheView[];
    readonly selection: MachineSelection;
    readonly onSelectionChange: (selection: MachineSelection) => void;
    readonly onRefresh: () => void;
    readonly onSwitch: (profile: ConnectionProfile) => void;
    readonly onRepair?: (profile: ConnectionProfile) => void;
    readonly onOpenCachedSession: (profileId: string, sessionId: string) => void;
    readonly onOpenMessageMatch: (profileId: string, match: SessionMessageSearchMatchView) => void;
  };
}

interface DeleteScheduleRequest {
  readonly schedule: ScheduleView;
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const { snapshot, route, activeSessionId, t } = props;
  const navigateAndClose = (nextRoute: AppRoute): void => {
    props.onNavigate(nextRoute);
    props.onClose();
  };
  const createTaskAndClose = (): void => {
    props.onNewTask();
    props.onClose();
  };
  const [query, setQuery] = useState("");
  const ownerLayout = sidebarOwnerLayoutFor(props.sidebarOwnerLayouts, props.sidebarOwnerId);
  const sidebarLayout = useMemo<SidebarLayout>(() => ({
    ...props.sidebarDisplayPreferences,
    ...ownerLayout
  }), [ownerLayout, props.sidebarDisplayPreferences]);
  const showArchived = sidebarLayout.status === "archived";
  const [messageMatches, setMessageMatches] = useState<readonly SessionMessageSearchMatchView[]>([]);
  const [remoteMessageMatches, setRemoteMessageMatches] = useState<readonly FederatedSessionMessageSearchMatchView[]>([]);
  const [messageSearchLoading, setMessageSearchLoading] = useState(false);
  const [remoteMessageSearchLoading, setRemoteMessageSearchLoading] = useState(false);
  const [messageSearchError, setMessageSearchError] = useState<string>();
  const [remoteMessageSearchError, setRemoteMessageSearchError] = useState<string>();
  const [messageSearchStatus, setMessageSearchStatus] = useState<ConversationSearchStatusFilter>("all");
  const [messageSearchBackendId, setMessageSearchBackendId] = useState<string | "all">("all");
  const [messageSearchLastActivity, setMessageSearchLastActivity] = useState<ConversationSearchLastActivityFilter>("all");
  const [messageSearchTargetIds, setMessageSearchTargetIds] = useState<readonly string[] | "all">("all");
  const [activeSearchOption, setActiveSearchOption] = useState(-1);
  const [expandedSearchSessions, setExpandedSearchSessions] = useState<ReadonlySet<string>>(() => new Set());
  const messageSearchGenerationRef = useRef(0);
  const semanticSearchStartedGenerationRef = useRef(0);
  const keywordSearchSucceededGenerationRef = useRef(0);
  const remoteMessageSearchGenerationRef = useRef(0);
  const remoteSemanticSearchStartedGenerationRef = useRef(0);
  const remoteKeywordSearchSucceededGenerationRef = useRef(0);
  const remoteKeywordMatchesRef = useRef<{
    readonly generation: number;
    readonly matches: readonly FederatedSessionMessageSearchMatchView[];
  } | undefined>(undefined);
  const searchFilterRef = useRef<HTMLDetailsElement>(null);
  const sessionListRef = useRef<HTMLElement>(null);
  const [listSettingsContextMenuRequest, setListSettingsContextMenuRequest] = useState<SidebarListContextMenuRequest>();
  const [selectedSessionIds, setSelectedSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [deleteSchedule, setDeleteSchedule] = useState<DeleteScheduleRequest>();
  const [deleteScheduleDisposition, setDeleteScheduleDisposition] = useState<GeneratedSessionDisposition>("keep");
  const [deleteSchedulePending, setDeleteSchedulePending] = useState(false);
  const [deleteScheduleGeneratedCount, setDeleteScheduleGeneratedCount] = useState<number>();
  const [deleteScheduleInflightCount, setDeleteScheduleInflightCount] = useState<number>();
  const [deleteSchedulePreviewError, setDeleteSchedulePreviewError] = useState<string>();
  const [deleteScheduleOperationError, setDeleteScheduleOperationError] = useState<string>();
  const deleteSchedulePreviewGenerationRef = useRef(0);
  const [collapsedDeviceSections, setCollapsedDeviceSections] = useState<ReadonlySet<string>>(() => new Set());
  const [scheduleGroupFoldIntent, setScheduleGroupFoldIntent] = useState<{ readonly revision: number; readonly collapsed: boolean }>();
  const [railPanel, setRailPanel] = useState<SidebarRailPanelState>();
  const [railPreview, setRailPreview] = useState<SidebarRailPreviewState>();
  const [, setScheduleGroupExpansionRevision] = useState(0);
  const railCloseTimerRef = useRef<number | undefined>(undefined);
  const railProjectCloseTimerRef = useRef<number | undefined>(undefined);
  const railKeyboardReturnRef = useRef<HTMLButtonElement | undefined>(undefined);
  const selectionAnchorRef = useRef<string | undefined>(undefined);
  const searchMessagesRef = useRef(props.onSearchMessages);
  searchMessagesRef.current = props.onSearchMessages;
  const searchRemoteMessagesRef = useRef(props.onSearchRemoteMessages);
  searchRemoteMessagesRef.current = props.onSearchRemoteMessages;
  const collapsedTargets = useMemo(() => new Set(sidebarLayout.collapsedProjectIds), [sidebarLayout.collapsedProjectIds]);
  const targetNamesById = useMemo(() => new Map(snapshot.targets.map((target) => [target.id, target.name])), [snapshot.targets]);
  const backendNamesById = useMemo(() => new Map(snapshot.backends.map((backend) => [backend.id, backend.name])), [snapshot.backends]);
  const workspacePathsByTargetId = useMemo(() => new Map(snapshot.workspaces.map((workspace) => [workspace.targetId, workspace.serverPath])), [snapshot.workspaces]);
  const projectNameFor = useCallback((session: SessionView): string => session.projectId === undefined
    ? t("nav.dialogue")
    : targetNamesById.get(session.projectId) ?? t("session.noProjectsAvailable"), [t, targetNamesById]);
  const environmentNameFor = useCallback((session: SessionView): string => backendNamesById.get(session.backendId) ?? session.backendId, [backendNamesById]);
  const workspacePathFor = useCallback((target: TargetView): string => target.remoteWorkspace?.workspaceRoot
    ?? workspacePathsByTargetId.get(target.id)
    ?? target.workspaceName, [workspacePathsByTargetId]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const currentSearchProfileId = props.machineControl?.activeProfile.id ?? "local";
  const currentMachineIncluded = props.machineControl === undefined
    || props.machineControl.selection === "all"
    || props.machineControl.selection.includes(props.machineControl.activeProfile.id);
  const sessions = useMemo(() => currentMachineIncluded
    ? sessionsForSidebarStatus(snapshot.sessions, sidebarLayout.status)
    : [], [currentMachineIncluded, sidebarLayout.status, snapshot.sessions]);
  const remoteMachineCaches = useMemo(() => props.machineControl === undefined ? [] : selectedRemoteMachineCaches(
    props.machineControl.caches,
    props.machineControl.activeProfile.id,
    props.machineControl.selection,
    props.machineControl.profiles
  ), [props.machineControl]);
  const selectedRemoteProfiles = useMemo(() => props.machineControl === undefined
    ? []
    : props.machineControl.profiles.filter((profile) => profile.id !== props.machineControl!.activeProfile.id
      && (props.machineControl!.selection === "all" || props.machineControl!.selection.includes(profile.id))), [props.machineControl]);
  const remoteLastActivityCutoff = sidebarLastActivityCutoff(sidebarLayout.lastActivity, Date.now());
  const remoteContentIdentityFilterActive = sidebarLayout.backendId !== "all" || sidebarLayout.projectFilter !== "all";
  const remoteMachineSessionCount = remoteMachineCaches.reduce((count, cache) => count + cache.sessions.filter((session) =>
    !session.pinned && remoteSessionMatchesSidebarStatus(session, sidebarLayout.status)
      && !remoteContentIdentityFilterActive
      && (remoteLastActivityCutoff === undefined || session.lastActivityAt >= remoteLastActivityCutoff)
  ).length, 0);
  const remoteMessageSearchScopeKey = selectedRemoteProfiles.map((profile) =>
    `${profile.id}\u0000${profile.serverId}\u0000${props.machineControl?.presenceByProfile[profile.id] ?? "offline"}`
  ).join("\u0001");
  const activeSession = activeSessionId === undefined
    ? undefined
    : snapshot.sessions.find((candidate) => candidate.id === activeSessionId);
  const [attentionClockRevision, setAttentionClockRevision] = useState(0);
  const priorityOwnerRef = useRef(props.sidebarOwnerId);
  const priorityStateRef = useRef(createSidebarViewedPriorityState());
  const attentionVisibilityStateRef = useRef(createSidebarDoneAttentionVisibilityState());
  if (priorityOwnerRef.current !== props.sidebarOwnerId) {
    priorityOwnerRef.current = props.sidebarOwnerId;
    priorityStateRef.current = createSidebarViewedPriorityState();
    attentionVisibilityStateRef.current = createSidebarDoneAttentionVisibilityState();
  }
  const attentionVisibility = reconcileSidebarDoneAttentionVisibility(
    attentionVisibilityStateRef.current,
    snapshot.sessions,
    sidebarMonotonicNowMs()
  );
  const priorityCaptureContext = {
    visibleDoneAttentionKeys: attentionVisibility.visibleAttentionKeys
  } satisfies Pick<SidebarPriorityContext, "visibleDoneAttentionKeys">;
  advanceSidebarViewedPriority(priorityStateRef.current, activeSession, Date.now(), priorityCaptureContext);
  const priorityContext: SidebarPriorityContext = {
    viewedSessionId: activeSession?.id,
    visibleDoneAttentionKeys: attentionVisibility.visibleAttentionKeys,
    heldPriorityRanks: priorityStateRef.current.heldPriorityRanks,
    recentlyViewedAtMs: priorityStateRef.current.recentlyViewedAtMs
  };
  const callbacks = sessionCallbacks(props, (session, modifiers) => {
    if (modifiers !== undefined && (modifiers.metaKey || modifiers.ctrlKey || modifiers.shiftKey)) {
      const visibleIds = visibleSidebarSessionIds(sessionListRef.current);
      if (modifiers.shiftKey) {
        const anchor = selectionAnchorRef.current !== undefined && visibleIds.includes(selectionAnchorRef.current)
          ? selectionAnchorRef.current
          : session.id;
        const anchorIndex = visibleIds.indexOf(anchor);
        const targetIndex = visibleIds.indexOf(session.id);
        const range = anchorIndex < 0 || targetIndex < 0
          ? [session.id]
          : visibleIds.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
        setSelectedSessionIds((current) => {
          const next = modifiers.metaKey || modifiers.ctrlKey ? new Set(current) : new Set<string>();
          for (const sessionId of range) next.add(sessionId);
          return next;
        });
        selectionAnchorRef.current ??= session.id;
        return false;
      }
      setSelectedSessionIds((current) => {
        const next = new Set(current);
        if (next.has(session.id)) next.delete(session.id);
        else next.add(session.id);
        return next;
      });
      selectionAnchorRef.current = session.id;
      return false;
    }
    if (selectedSessionIds.size > 0) setSelectedSessionIds(new Set());
    selectionAnchorRef.current = session.id;
    holdSidebarViewedPriorityRank(priorityStateRef.current, session, priorityCaptureContext);
    return true;
  }, selectedSessionIds);
  const browsableTargetIds = useMemo(() => new Set(snapshot.targets
    .filter((target) => snapshot.workspaces.some((workspace) => workspace.id === target.workspaceId)
      && snapshot.backends.find((backend) => backend.id === target.backendId)?.capabilities.get("workspace.files")?.supported === true)
    .map((target) => target.id)), [snapshot.backends, snapshot.targets, snapshot.workspaces]);
  const messageSearchActiveFilterCount = Number(messageSearchStatus !== "all")
    + Number(messageSearchBackendId !== "all")
    + Number(messageSearchLastActivity !== "all")
    + Number(messageSearchTargetIds !== "all");
  const messageSearchFilterAria = t("nav.searchFilterAria", {
    sort: t(props.messageSearchSort === "relevance"
      ? "nav.searchSortRelevance"
      : props.messageSearchSort === "activityDesc"
        ? "nav.searchSortNewest"
        : "nav.searchSortOldest"),
    status: t(messageSearchStatus === "active"
      ? "nav.searchStatusActive"
      : messageSearchStatus === "archived"
        ? "nav.searchStatusArchived"
        : "nav.searchStatusAll"),
    agent: messageSearchBackendId === "all"
      ? t("nav.searchAgentAll")
      : snapshot.backends.find((backend) => backend.id === messageSearchBackendId)?.name ?? messageSearchBackendId,
    lastActivity: t(messageSearchLastActivity === "1d"
      ? "nav.searchLastActivity1d"
      : messageSearchLastActivity === "3d"
        ? "nav.searchLastActivity3d"
        : messageSearchLastActivity === "7d"
          ? "nav.searchLastActivity7d"
          : messageSearchLastActivity === "30d"
            ? "nav.searchLastActivity30d"
            : "nav.searchLastActivityAll"),
    projects: messageSearchTargetIds === "all"
      ? t("nav.searchProjectsAll")
      : t("nav.searchProjectsSelected", { count: messageSearchTargetIds.length })
  });
  const localSearchCandidates = useMemo(() => normalizedQuery === "" ? [] : projectConversationSearchResults(
    currentMachineIncluded ? snapshot.sessions : [],
    snapshot.targets,
    messageMatches,
    query.trim(),
    { kind: "owner" },
    props.messageSearchSort,
    Number.MAX_SAFE_INTEGER,
    {
      ...ALL_CONVERSATION_SEARCH_FILTERS,
      status: messageSearchStatus,
      backendId: messageSearchBackendId,
      lastActivity: messageSearchLastActivity,
      targetIds: messageSearchTargetIds
    }
  ), [currentMachineIncluded, messageMatches, messageSearchBackendId, messageSearchLastActivity, messageSearchStatus, messageSearchTargetIds, normalizedQuery, props.messageSearchSort, query, snapshot.sessions, snapshot.targets]);
  const remoteSearchCandidates = useMemo(() => projectRemoteMachineSearchResults(
    remoteMachineCaches,
    props.machineControl?.presenceByProfile ?? {},
    query.trim(),
    {
      status: messageSearchStatus,
      lastActivity: messageSearchLastActivity,
      backendFilterActive: messageSearchBackendId !== "all",
      projectFilterActive: messageSearchTargetIds !== "all",
      sort: props.messageSearchSort,
      messageMatches: remoteMessageMatches,
      profiles: selectedRemoteProfiles
    }
  ), [messageSearchBackendId, messageSearchLastActivity, messageSearchStatus, messageSearchTargetIds, props.machineControl?.presenceByProfile, props.messageSearchSort, query, remoteMachineCaches, remoteMessageMatches, selectedRemoteProfiles]);
  const federatedSearchGroups = useMemo(() => projectFederatedSidebarSearchGroups(
    currentSearchProfileId,
    messageSearchLoading || messageSearchError !== undefined ? [] : localSearchCandidates,
    remoteSearchCandidates,
    props.messageSearchSort,
    CONVERSATION_SEARCH_RESULT_LIMIT
  ), [currentSearchProfileId, localSearchCandidates, messageSearchError, messageSearchLoading, props.messageSearchSort, remoteSearchCandidates]);
  const searchResults = useMemo(() => federatedSearchGroups.flatMap((group) => group.kind === "local" ? [group.result] : []), [federatedSearchGroups]);
  const remoteSearchResults = useMemo(() => federatedSearchGroups.flatMap((group) => group.kind === "remote" ? [group.result] : []), [federatedSearchGroups]);
  const expandedLocalSearchSessions = useMemo(() => new Set(searchResults
    .filter((result) => expandedSearchSessions.has(federatedSessionSearchKey(currentSearchProfileId, result.session.id)))
    .map((result) => result.session.id)), [currentSearchProfileId, expandedSearchSessions, searchResults]);
  const searchOptions = useMemo(
    () => flattenConversationSearchOptions(searchResults, expandedLocalSearchSessions),
    [expandedLocalSearchSessions, searchResults]
  );
  const remoteSearchOptions = useMemo(() => flattenRemoteMachineSearchOptions(remoteSearchResults, expandedSearchSessions), [expandedSearchSessions, remoteSearchResults]);
  const allSearchOptions = useMemo<readonly SidebarSearchOption[]>(
    () => [...searchOptions, ...remoteSearchOptions],
    [remoteSearchOptions, searchOptions]
  );
  const pinnedProjectTargets = useMemo(() => currentMachineIncluded ? snapshot.targets.filter((target) =>
    target.pinned && !target.archived && snapshot.sessions.some((session) => session.projectId === target.id)
  ) : [], [currentMachineIncluded, snapshot.sessions, snapshot.targets]);
  const pinnedProjectIds = useMemo(() => new Set(pinnedProjectTargets.map((target) => target.id)), [pinnedProjectTargets]);
  const pinnedSessions = useMemo(() => currentMachineIncluded ? sortSidebarSessions(
    snapshot.sessions.filter((session) => session.pinned),
    "recency"
  ) : [], [currentMachineIncluded, snapshot.sessions]);
  const pinnedSessionEntries = useMemo<readonly SidebarPinnedEntry[]>(() => [
    ...pinnedSessions.map((session) => ({ kind: "session" as const, id: session.id, session })),
    ...remoteMachineCaches.flatMap((cache) => cache.sessions
      .filter((session) => session.pinned)
      .map((session) => ({
        kind: "remoteSession" as const,
        id: `${SIDEBAR_PINNED_REMOTE_SESSION_PREFIX}${cache.profileId}:${session.id}`,
        cache,
        session
      })))
  ].sort((left, right) => {
    const leftActivity = left.kind === "session" ? left.session.updatedAt : left.kind === "remoteSession" ? left.session.lastActivityAt : 0;
    const rightActivity = right.kind === "session" ? right.session.updatedAt : right.kind === "remoteSession" ? right.session.lastActivityAt : 0;
    return rightActivity - leftActivity || left.id.localeCompare(right.id);
  }), [pinnedSessions, remoteMachineCaches]);
  const allPinnedIds = useMemo(() => [
    ...pinnedSessionEntries.map((entry) => entry.id),
    ...pinnedProjectTargets.map((target) => `${SIDEBAR_PINNED_PROJECT_PREFIX}${target.id}`)
  ], [pinnedProjectTargets, pinnedSessionEntries]);
  const pinnedOrder = useMemo(() => normalizeManualSidebarOrder(
    sidebarLayout.manualPinnedOrder,
    allPinnedIds
  ), [allPinnedIds, sidebarLayout.manualPinnedOrder]);
  const pinnedRank = useMemo(() => new Map(pinnedOrder.map((id, index) => [id, index])), [pinnedOrder]);
  const pinnedEntries = useMemo<readonly SidebarPinnedEntry[]>(() => [
    ...pinnedSessionEntries,
    ...pinnedProjectTargets.map((target) => ({
      kind: "project" as const,
      id: `${SIDEBAR_PINNED_PROJECT_PREFIX}${target.id}`,
      target,
      sessions: sortSidebarSessions(snapshot.sessions.filter((session) => session.projectId === target.id && !session.pinned), sidebarLayout.sortBy, priorityContext)
    }))
  ].sort((left, right) => (pinnedRank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (pinnedRank.get(right.id) ?? Number.MAX_SAFE_INTEGER)), [pinnedProjectTargets, pinnedRank, pinnedSessionEntries, priorityContext, sidebarLayout.sortBy, snapshot.sessions]);
  const recent = sortSidebarSessions(filterSidebarSessions(
    sessions.filter((session) => !session.pinned && (session.projectId === undefined || !pinnedProjectIds.has(session.projectId))),
    sidebarLayout,
    Date.now()
  ), sidebarLayout.sortBy, priorityContext);
  const railPinnedEntries = pinnedEntries.filter((entry): entry is SidebarPinnedSessionEntry => entry.kind !== "project");
  const activeContentFilterCount = sidebarContentFilterCount(sidebarLayout);
  const allTargetsInBaselineOrder = sortSidebarTargets(
    snapshot.targets,
    snapshot.sessions,
    sidebarLayout.sortBy,
    "activity",
    [],
    priorityContext
  );
  const allTargetIds = allTargetsInBaselineOrder
    .filter((target) => snapshot.sessions.some((session) => session.projectId === target.id))
    .map((target) => target.id);
  const orderedTargets = sortSidebarTargets(
    snapshot.targets,
    recent,
    sidebarLayout.sortBy,
    sidebarLayout.projectOrder,
    normalizeManualSidebarOrder(sidebarLayout.manualProjectOrder, allTargetIds),
    priorityContext
  );
  const railLocalPanelSessions = sortSidebarSessions(filterSidebarSessions(
    sessions.filter((session) => !session.pinned),
    sidebarLayout,
    Date.now()
  ), sidebarLayout.sortBy, priorityContext);
  const railLocalProjectEntries = orderedTargets.flatMap<SidebarRailProjectEntry>((target) => {
    if (target.archived) return [];
    const targetSessions = railLocalPanelSessions.filter((session) => session.projectId === target.id);
    const pinnedProjectReachable = target.pinned && snapshot.sessions.some((session) => session.projectId === target.id);
    if (targetSessions.length === 0 && !pinnedProjectReachable) return [];
    return [{ kind: "local", id: target.id, name: target.name, target, sessions: targetSessions }];
  });
  const railRemotePanelEntries = remoteMachineCaches.flatMap((cache) => cache.sessions
    .filter((session) => !session.pinned && remoteSessionMatchesSidebarStatus(session, sidebarLayout.status)
      && !remoteContentIdentityFilterActive
      && (remoteLastActivityCutoff === undefined || session.lastActivityAt >= remoteLastActivityCutoff))
    .map((session) => ({ cache, session })));
  const railRemoteProjectEntries = useMemo<readonly SidebarRailProjectEntry[]>(() => {
    const grouped = new Map<string, { readonly cache: MachineCacheView; readonly name: string; readonly sessions: MachineSessionCacheView[] }>();
    for (const { cache, session } of railRemotePanelEntries) {
      if (session.targetName === undefined) continue;
      const id = `${cache.profileId}\u0000${session.targetName}`;
      const current = grouped.get(id);
      if (current === undefined) grouped.set(id, { cache, name: `${session.targetName} · ${cache.name}`, sessions: [session] });
      else current.sessions.push(session);
    }
    return [...grouped.entries()].map(([id, group]) => ({
      kind: "remote" as const,
      id: `remote-project:${id}`,
      name: group.name,
      cache: group.cache,
      sessions: group.sessions.sort((left, right) => right.lastActivityAt - left.lastActivityAt || left.id.localeCompare(right.id))
    })).sort((left, right) => {
      const leftActivity = left.kind === "remote" ? left.sessions[0]?.lastActivityAt ?? 0 : 0;
      const rightActivity = right.kind === "remote" ? right.sessions[0]?.lastActivityAt ?? 0 : 0;
      return rightActivity - leftActivity || left.name.localeCompare(right.name);
    });
  }, [railRemotePanelEntries]);
  const railProjectEntries = [...railLocalProjectEntries, ...railRemoteProjectEntries];
  const railDialogueSessions = railLocalPanelSessions.filter((session) => session.projectId === undefined);
  const railRemoteDialogueEntries = railRemotePanelEntries
    .filter(({ session }) => session.targetName === undefined)
    .sort((left, right) => right.session.lastActivityAt - left.session.lastActivityAt
      || left.cache.profileId.localeCompare(right.cache.profileId)
      || left.session.id.localeCompare(right.session.id));
  const visibleProjectGroupIds = orderedTargets
    .filter((target) => recent.some((session) => session.projectId === target.id))
    .map((target) => target.id);
  const visibleDialogueGrouped = sidebarLayout.groupBy === "project"
    && sidebarLayout.groupDialogue
    && recent.some((session) => session.projectId === undefined);
  const visibleScheduleGroupKeys = groupSidebarScheduleSessions(recent, snapshot.schedules)
    .flatMap((entry) => entry.kind === "scheduleGroup" ? [entry.group.key] : []);
  const expandedScheduleGroupKeys = readExpandedScheduleGroups(props.sidebarOwnerId);
  const hasVisibleProjectOrDialogueGroups = sidebarLayout.groupBy === "project"
    && (visibleProjectGroupIds.length > 0 || visibleDialogueGrouped);
  const hasVisibleAutomationGroups = visibleScheduleGroupKeys.length > 0;
  const hasVisibleLocalGroupLayer = hasVisibleProjectOrDialogueGroups || hasVisibleAutomationGroups;
  const allVisibleGroupsCollapsed = hasVisibleLocalGroupLayer
    && (!hasVisibleProjectOrDialogueGroups || (visibleProjectGroupIds.every((targetId) => collapsedTargets.has(targetId))
      && (!visibleDialogueGrouped || sidebarLayout.collapsedDialogue)))
    && visibleScheduleGroupKeys.every((key) => !expandedScheduleGroupKeys.has(key));
  const visibleRemoteDeviceIds = remoteMachineCaches
    .filter((cache) => cache.sessions.some((session) =>
      !session.pinned && remoteSessionMatchesSidebarStatus(session, sidebarLayout.status)
        && !remoteContentIdentityFilterActive
        && (remoteLastActivityCutoff === undefined || session.lastActivityAt >= remoteLastActivityCutoff)))
    .map((cache) => cache.profileId);
  const localDeviceId = props.machineControl?.activeProfile.id;
  const deviceLayerActive = sidebarLayout.groupDevice
    && remoteMachineCaches.length > 0
    && (recent.length > 0 || visibleRemoteDeviceIds.length > 0);
  const visibleDeviceIds = deviceLayerActive
    ? [...(recent.length > 0 && localDeviceId !== undefined ? [localDeviceId] : []), ...visibleRemoteDeviceIds]
    : [];
  const allVisibleDevicesCollapsed = deviceLayerActive
    && visibleDeviceIds.every((profileId) => collapsedDeviceSections.has(profileId));
  const foldAction: "collapseGroups" | "collapseDevices" | "expandAll" | undefined = hasVisibleLocalGroupLayer && !allVisibleGroupsCollapsed
    ? "collapseGroups"
    : deviceLayerActive && !allVisibleDevicesCollapsed
      ? "collapseDevices"
      : hasVisibleLocalGroupLayer || deviceLayerActive
        ? "expandAll"
        : undefined;
  const toggleAllVisibleGroups = (): void => {
    if (foldAction === "collapseGroups") {
      if (hasVisibleProjectOrDialogueGroups) {
        props.onSidebarOwnerLayoutChange({ collapsedProjectIds: visibleProjectGroupIds, collapsedDialogue: visibleDialogueGrouped });
      }
      if (hasVisibleAutomationGroups) {
        setScheduleGroupFoldIntent((current) => ({ revision: (current?.revision ?? 0) + 1, collapsed: true }));
      }
      return;
    }
    if (foldAction === "collapseDevices") {
      setCollapsedDeviceSections(new Set(visibleDeviceIds));
      return;
    }
    if (foldAction === "expandAll") {
      props.onSidebarOwnerLayoutChange({ collapsedProjectIds: [], collapsedDialogue: false });
      setCollapsedDeviceSections(new Set());
      if (hasVisibleAutomationGroups) {
        setScheduleGroupFoldIntent((current) => ({ revision: (current?.revision ?? 0) + 1, collapsed: false }));
      }
    }
  };
  const toggleDeviceSection = (profileId: string): void => setCollapsedDeviceSections((current) => {
    const next = new Set(current);
    if (next.has(profileId)) next.delete(profileId);
    else next.add(profileId);
    return next;
  });
  const reducedMotion = useReducedMotionPreference();
  const previousPinnedOwnerRef = useRef(props.sidebarOwnerId);
  const previousPinnedIdsRef = useRef<ReadonlySet<string>>(new Set(allPinnedIds));
  const activeTarget = activeSession === undefined
    ? undefined
    : snapshot.targets.find((candidate) => candidate.id === activeSession.targetId);
  const searchPopupOpen = normalizedQuery !== "";
  const selectedSessions = useMemo(
    () => snapshot.sessions.filter((session) => selectedSessionIds.has(session.id)),
    [selectedSessionIds, snapshot.sessions]
  );
  const activeSearchDescendant = activeSearchOption >= 0 && allSearchOptions[activeSearchOption] !== undefined
    ? searchOptionId(activeSearchOption)
    : undefined;

  useEffect(() => {
    if (sidebarLayout.projectFilter === "all") return;
    const activeProjectIds = new Set(snapshot.targets.map((target) => target.id));
    if (snapshot.sessions.some((session) => session.projectId === undefined)) {
      activeProjectIds.add(SIDEBAR_DIALOGUE_FILTER_ID);
    }
    const next = sidebarLayout.projectFilter.filter((projectId) => activeProjectIds.has(projectId));
    if (next.length === sidebarLayout.projectFilter.length) return;
    props.onSidebarOwnerLayoutChange({ projectFilter: next.length === 0 ? "all" : next });
  }, [sidebarLayout.projectFilter, snapshot.sessions, snapshot.targets]);

  useEffect(() => {
    if (sidebarLayout.backendId === "all"
      || snapshot.backends.some((backend) => backend.id === sidebarLayout.backendId)) return;
    props.onSidebarDisplayPreferencesChange({ backendId: "all" });
  }, [sidebarLayout.backendId, snapshot.backends]);

  useEffect(() => {
    const delayMs = attentionVisibility.nextRevealDelayMs;
    if (delayMs === undefined) return;
    const timer = setTimeout(() => setAttentionClockRevision((current) => current + 1), delayMs);
    return () => clearTimeout(timer);
  }, [attentionClockRevision, attentionVisibility.nextRevealDelayMs, snapshot.sessions]);

  useEffect(() => {
    const generation = ++messageSearchGenerationRef.current;
    semanticSearchStartedGenerationRef.current = 0;
    keywordSearchSucceededGenerationRef.current = 0;
    setMessageSearchError(undefined);
    if (normalizedQuery === "" || !currentMachineIncluded) {
      setMessageMatches([]);
      setMessageSearchLoading(false);
      return;
    }
    setMessageMatches([]);
    setMessageSearchLoading(true);
    const abort = new AbortController();
    const searchFilters: SessionMessageSearchFiltersView = {
      ...(messageSearchTargetIds === "all" ? {} : { targetIds: messageSearchTargetIds }),
      ...(messageSearchBackendId === "all" ? {} : { backendIds: [messageSearchBackendId] }),
      ...(messageSearchStatus === "all" ? {} : { sessionStatus: messageSearchStatus }),
      ...(messageSearchLastActivity === "all"
        ? {}
        : {
            sessionActivityFrom: Date.now()
              - MESSAGE_SEARCH_ACTIVITY_DAYS[messageSearchLastActivity] * MESSAGE_SEARCH_DAY_MS
          })
    };
    const keywordTimer = setTimeout(() => {
      void searchMessagesRef.current(query.trim(), "keyword", searchFilters, abort.signal).then((matches) => {
        if (messageSearchGenerationRef.current !== generation) return;
        keywordSearchSucceededGenerationRef.current = generation;
        if (semanticSearchStartedGenerationRef.current === generation) {
          // Once hybrid owns the local refresh, a late keyword page only
          // proves the fast stage succeeded; keep the current local
          // page and uses keyword solely for remote fanout in this race.
          setMessageSearchLoading(false);
          setMessageSearchError(undefined);
          return;
        }
        setMessageMatches(matches);
        setMessageSearchLoading(false);
        setMessageSearchError(undefined);
      }).catch((error: unknown) => {
        if (messageSearchWasAborted(abort.signal, error)) return;
        if (messageSearchGenerationRef.current !== generation) return;
        if (semanticSearchStartedGenerationRef.current === generation) return;
        setMessageMatches([]);
        setMessageSearchLoading(false);
        setMessageSearchError(t("nav.messageSearchFailed"));
      });
    }, CONVERSATION_KEYWORD_DEBOUNCE_MS);
    const hybridTimer = setTimeout(() => {
      semanticSearchStartedGenerationRef.current = generation;
      void searchMessagesRef.current(query.trim(), "hybrid", searchFilters, abort.signal).then((matches) => {
        if (messageSearchGenerationRef.current !== generation) return;
        setMessageMatches(matches);
        setMessageSearchLoading(false);
        setMessageSearchError(undefined);
      }).catch((error: unknown) => {
        if (messageSearchWasAborted(abort.signal, error)) return;
        if (messageSearchGenerationRef.current !== generation) return;
        semanticSearchStartedGenerationRef.current = 0;
        // Keep an already-visible keyword page when semantic refresh
        // fails. Only surface an error if neither stage produced results.
        if (keywordSearchSucceededGenerationRef.current === generation) return;
        setMessageMatches([]);
        setMessageSearchLoading(false);
        setMessageSearchError(t("nav.messageSearchFailed"));
      });
    }, CONVERSATION_HYBRID_DEBOUNCE_MS);
    return () => {
      clearTimeout(keywordTimer);
      clearTimeout(hybridTimer);
      abort.abort(new DOMException("Superseded search", "AbortError"));
      if (messageSearchGenerationRef.current === generation) messageSearchGenerationRef.current += 1;
    };
  }, [currentMachineIncluded, messageSearchBackendId, messageSearchLastActivity, messageSearchStatus, messageSearchTargetIds, normalizedQuery, query, t]);

  useEffect(() => {
    const generation = ++remoteMessageSearchGenerationRef.current;
    remoteSemanticSearchStartedGenerationRef.current = 0;
    remoteKeywordSearchSucceededGenerationRef.current = 0;
    remoteKeywordMatchesRef.current = undefined;
    setRemoteMessageSearchError(undefined);
    const searchRemoteMessages = searchRemoteMessagesRef.current;
    if (normalizedQuery === "" || searchRemoteMessages === undefined) {
      setRemoteMessageMatches([]);
      setRemoteMessageSearchLoading(false);
      return;
    }
    setRemoteMessageMatches([]);
    setRemoteMessageSearchLoading(true);
    const abort = new AbortController();
    const searchFilters: SessionMessageSearchFiltersView = {
      ...(messageSearchTargetIds === "all" ? {} : { targetIds: messageSearchTargetIds }),
      ...(messageSearchBackendId === "all" ? {} : { backendIds: [messageSearchBackendId] }),
      ...(messageSearchStatus === "all" ? {} : { sessionStatus: messageSearchStatus }),
      ...(messageSearchLastActivity === "all"
        ? {}
        : {
            sessionActivityFrom: Date.now()
              - MESSAGE_SEARCH_ACTIVITY_DAYS[messageSearchLastActivity] * MESSAGE_SEARCH_DAY_MS
          })
    };
    const keywordTimer = setTimeout(() => {
      void searchRemoteMessages(query.trim(), "keyword", searchFilters, abort.signal).then((matches) => {
        if (remoteMessageSearchGenerationRef.current !== generation) return;
        remoteKeywordSearchSucceededGenerationRef.current = generation;
        remoteKeywordMatchesRef.current = { generation, matches };
        if (remoteSemanticSearchStartedGenerationRef.current === generation) {
          setRemoteMessageSearchLoading(false);
          setRemoteMessageSearchError(undefined);
          return;
        }
        setRemoteMessageMatches(matches);
        setRemoteMessageSearchLoading(false);
        setRemoteMessageSearchError(undefined);
      }).catch((error: unknown) => {
        if (messageSearchWasAborted(abort.signal, error)) return;
        if (remoteMessageSearchGenerationRef.current !== generation) return;
        if (remoteSemanticSearchStartedGenerationRef.current === generation) return;
        setRemoteMessageMatches([]);
        setRemoteMessageSearchLoading(false);
        setRemoteMessageSearchError(t("nav.remoteMessageSearchFailed"));
      });
    }, CONVERSATION_KEYWORD_DEBOUNCE_MS);
    const hybridTimer = setTimeout(() => {
      remoteSemanticSearchStartedGenerationRef.current = generation;
      void searchRemoteMessages(query.trim(), "hybrid", searchFilters, abort.signal).then((matches) => {
        if (remoteMessageSearchGenerationRef.current !== generation) return;
        setRemoteMessageMatches(matches);
        setRemoteMessageSearchLoading(false);
        setRemoteMessageSearchError(undefined);
      }).catch((error: unknown) => {
        if (messageSearchWasAborted(abort.signal, error)) return;
        if (remoteMessageSearchGenerationRef.current !== generation) return;
        remoteSemanticSearchStartedGenerationRef.current = 0;
        const keywordPage = remoteKeywordMatchesRef.current;
        if (remoteKeywordSearchSucceededGenerationRef.current === generation && keywordPage?.generation === generation) {
          setRemoteMessageMatches(keywordPage.matches);
          setRemoteMessageSearchLoading(false);
          setRemoteMessageSearchError(undefined);
          return;
        }
        setRemoteMessageMatches([]);
        setRemoteMessageSearchLoading(false);
        setRemoteMessageSearchError(t("nav.remoteMessageSearchFailed"));
      });
    }, CONVERSATION_HYBRID_DEBOUNCE_MS);
    return () => {
      clearTimeout(keywordTimer);
      clearTimeout(hybridTimer);
      abort.abort(new DOMException("Superseded search", "AbortError"));
      if (remoteMessageSearchGenerationRef.current === generation) remoteMessageSearchGenerationRef.current += 1;
    };
  }, [messageSearchBackendId, messageSearchLastActivity, messageSearchStatus, messageSearchTargetIds, normalizedQuery, query, remoteMessageSearchScopeKey, t]);

  useEffect(() => {
    setActiveSearchOption((current) => allSearchOptions.length === 0 ? -1 : current < 0 || current >= allSearchOptions.length ? 0 : current);
  }, [allSearchOptions.length]);

  useEffect(() => {
    setExpandedSearchSessions(new Set());
  }, [messageSearchBackendId, messageSearchLastActivity, messageSearchStatus, messageSearchTargetIds, normalizedQuery, props.messageSearchSort]);

  useEffect(() => {
    if (activeSearchOption < 0) return;
    document.getElementById(searchOptionId(activeSearchOption))?.scrollIntoView({ block: "nearest" });
  }, [activeSearchOption]);

  useEffect(() => {
    const closeSidebarMenus = (event: MouseEvent): void => {
      const menu = searchFilterRef.current;
      if (menu?.open === true && !menu.contains(event.target as Node)) menu.open = false;
    };
    document.addEventListener("mousedown", closeSidebarMenus, true);
    return () => document.removeEventListener("mousedown", closeSidebarMenus, true);
  }, []);

  useEffect(() => {
    const ownerChanged = previousPinnedOwnerRef.current !== props.sidebarOwnerId;
    const previousPinnedIds = ownerChanged ? new Set(allPinnedIds) : previousPinnedIdsRef.current;
    const newlyPinnedIds = ownerChanged ? [] : allPinnedIds.filter((id) => !previousPinnedIds.has(id));
    previousPinnedOwnerRef.current = props.sidebarOwnerId;
    previousPinnedIdsRef.current = new Set(allPinnedIds);
    const nextPinnedOrder = newlyPinnedIds.length > 0
      ? promoteNewPinnedSidebarIds(sidebarLayout.manualPinnedOrder, allPinnedIds, newlyPinnedIds)
      : normalizeManualSidebarOrder(sidebarLayout.manualPinnedOrder, allPinnedIds);
    const nextProjectOrder = normalizeManualSidebarOrder(sidebarLayout.manualProjectOrder, allTargetIds);
    const activeTargets = new Set(allTargetIds);
    const nextCollapsed = sidebarLayout.collapsedProjectIds.filter((id) => activeTargets.has(id));
    const patch: {
      manualPinnedOrder?: readonly string[];
      manualProjectOrder?: readonly string[];
      collapsedProjectIds?: readonly string[];
    } = {};
    if ((newlyPinnedIds.length > 0 || sidebarLayout.manualPinnedOrder.length > 0)
      && !sameSidebarOrder(nextPinnedOrder, sidebarLayout.manualPinnedOrder)) {
      patch.manualPinnedOrder = nextPinnedOrder;
    }
    if ((sidebarLayout.projectOrder === "custom" || sidebarLayout.manualProjectOrder.length > 0)
      && !sameSidebarOrder(nextProjectOrder, sidebarLayout.manualProjectOrder)) {
      patch.manualProjectOrder = nextProjectOrder;
    }
    if (!sameSidebarOrder(nextCollapsed, sidebarLayout.collapsedProjectIds)) {
      patch.collapsedProjectIds = nextCollapsed;
    }
    if (Object.keys(patch).length > 0) props.onSidebarOwnerLayoutChange(patch);
  }, [allPinnedIds, allTargetIds, props.onSidebarOwnerLayoutChange, props.sidebarOwnerId, sidebarLayout]);

  useEffect(() => {
    if (messageSearchBackendId !== "all" && !snapshot.backends.some((backend) => backend.id === messageSearchBackendId)) {
      setMessageSearchBackendId("all");
    }
    if (messageSearchTargetIds !== "all") {
      const available = new Set(snapshot.targets.map((target) => target.id));
      const next = messageSearchTargetIds.filter((targetId) => available.has(targetId));
      if (next.length !== messageSearchTargetIds.length) setMessageSearchTargetIds(next.length === 0 ? "all" : next);
    }
  }, [messageSearchBackendId, messageSearchTargetIds, snapshot.backends, snapshot.targets]);

  useLayoutEffect(() => {
    const visible = new Set(visibleSidebarSessionIds(sessionListRef.current));
    if (searchPopupOpen) visible.clear();
    setSelectedSessionIds((current) => {
      const next = new Set([...current].filter((sessionId) => visible.has(sessionId)));
      return sameStringSet(current, next) ? current : next;
    });
    if (selectionAnchorRef.current !== undefined && !visible.has(selectionAnchorRef.current)) {
      selectionAnchorRef.current = undefined;
    }
  }, [searchPopupOpen, sessions, sidebarLayout.collapsedDialogue, sidebarLayout.collapsedProjectIds]);

  const activateSearchOption = (option: SidebarSearchOption | undefined): void => {
    if (option === undefined) return;
    if (option.kind === "remoteMessage") {
      props.machineControl?.onOpenMessageMatch(option.profileId, option.match);
      props.onClose();
      return;
    }
    if (option.kind === "remoteExpand") {
      setExpandedSearchSessions((current) => new Set(current).add(federatedSessionSearchKey(option.profileId, option.session.id)));
      return;
    }
    if (option.kind === "remoteSession") {
      const firstHit = option.hits[0];
      if (firstHit !== undefined) {
        props.machineControl?.onOpenMessageMatch(option.profileId, firstHit);
        props.onClose();
        return;
      }
      props.machineControl?.onOpenCachedSession(option.profileId, option.session.id);
      props.onClose();
      return;
    }
    const activation = resolveConversationSearchActivation(option);
    if (activation.kind === "expand") {
      setExpandedSearchSessions((current) => new Set(current).add(federatedSessionSearchKey(currentSearchProfileId, activation.sessionId)));
      return;
    }
    if (activation.kind === "message") {
      props.onOpenMessageMatch(activation.hit);
      props.onClose();
      return;
    }
    callbacks.onSelect(activation.session);
  };

  const clearSearch = (): void => {
    messageSearchGenerationRef.current += 1;
    remoteMessageSearchGenerationRef.current += 1;
    remoteKeywordMatchesRef.current = undefined;
    setQuery("");
    setMessageMatches([]);
    setRemoteMessageMatches([]);
    setMessageSearchError(undefined);
    setRemoteMessageSearchError(undefined);
    setMessageSearchLoading(false);
    setRemoteMessageSearchLoading(false);
    setActiveSearchOption(-1);
  };

  const resetMessageSearchFilters = (): void => {
    setMessageSearchStatus("all");
    setMessageSearchBackendId("all");
    setMessageSearchLastActivity("all");
    setMessageSearchTargetIds("all");
  };

  const toggleMessageSearchTarget = (targetId: string): void => {
    setMessageSearchTargetIds((current) => {
      if (current === "all") return [targetId];
      if (!current.includes(targetId)) return [...current, targetId];
      const next = current.filter((candidate) => candidate !== targetId);
      return next.length === 0 ? "all" : next;
    });
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.key === "Process") return;
    const direction = event.key === "ArrowDown" ? "next"
      : event.key === "ArrowUp" ? "previous"
        : event.key === "Home" && (event.metaKey || event.ctrlKey) ? "first"
          : event.key === "End" && (event.metaKey || event.ctrlKey) ? "last"
            : undefined;
    if (direction !== undefined) {
      event.preventDefault();
      setActiveSearchOption((current) => moveConversationSearchSelection(current, allSearchOptions.length, direction));
      return;
    }
    if (event.key === "Enter" && !event.repeat) {
      const selected = allSearchOptions[activeSearchOption] ?? allSearchOptions[0];
      if (selected !== undefined) {
        event.preventDefault();
        activateSearchOption(selected);
      }
      return;
    }
    if (event.key === "Escape" && !event.repeat) {
      event.preventDefault();
      if (searchFilterRef.current?.open === true) {
        searchFilterRef.current.open = false;
        return;
      }
      clearSearch();
    }
  };

  const toggleTarget = (targetId: string): void => {
    const next = new Set(sidebarLayout.collapsedProjectIds);
    if (next.has(targetId)) next.delete(targetId);
    else next.add(targetId);
    props.onSidebarOwnerLayoutChange({ collapsedProjectIds: [...next] });
  };

  const toggleDialogue = (): void => {
    props.onSidebarOwnerLayoutChange({ collapsedDialogue: !sidebarLayout.collapsedDialogue });
  };

  const reorderPinned = (visibleNewOrder: readonly string[]): void => {
    props.onSidebarOwnerLayoutChange({
      manualPinnedOrder: manualSidebarOrderAfterVisibleReorder(
        sidebarLayout.manualPinnedOrder,
        allPinnedIds,
        visibleNewOrder
      )
    });
  };

  const reorderProjects = (visibleNewOrder: readonly string[]): void => {
    props.onSidebarOwnerLayoutChange({
      manualProjectOrder: manualSidebarOrderAfterVisibleReorder(
        sidebarLayout.manualProjectOrder,
        allTargetIds,
        visibleNewOrder
      )
    });
  };

  const setProjectOrder = (projectOrder: SidebarLayout["projectOrder"]): void => {
    if (projectOrder === "activity") {
      props.onSidebarDisplayPreferencesChange({ projectOrder });
      return;
    }
    const visibleProjectIds = orderedTargets
      .filter((target) => recent.some((session) => session.projectId === target.id))
      .map((target) => target.id);
    props.onSidebarDisplayPreferencesChange({ projectOrder });
    props.onSidebarOwnerLayoutChange({
      manualProjectOrder: sidebarLayout.manualProjectOrder.length > 0
        ? normalizeManualSidebarOrder(sidebarLayout.manualProjectOrder, allTargetIds)
        : manualSidebarOrderAfterVisibleReorder([], allTargetIds, visibleProjectIds)
    });
  };

  const loadDeleteSchedulePreview = (schedule: ScheduleView): void => {
    const generation = ++deleteSchedulePreviewGenerationRef.current;
    setDeleteScheduleGeneratedCount(undefined);
    setDeleteScheduleInflightCount(undefined);
    setDeleteSchedulePreviewError(undefined);
    if (props.onPreviewScheduleDeletion === undefined) {
      setDeleteSchedulePreviewError(t("scheduler.deletePreviewFailed"));
      return;
    }
    void props.onPreviewScheduleDeletion(schedule).then((preview) => {
      if (deleteSchedulePreviewGenerationRef.current !== generation) return;
      setDeleteScheduleGeneratedCount(preview.generatedSessionIds.length);
      setDeleteScheduleInflightCount(preview.inflightCount);
    }).catch((error: unknown) => {
      if (deleteSchedulePreviewGenerationRef.current !== generation) return;
      setDeleteSchedulePreviewError(error instanceof Error ? error.message : t("scheduler.deletePreviewFailed"));
    });
  };
  const requestDeleteSchedule = (schedule: ScheduleView): void => {
    setDeleteScheduleDisposition("keep");
    setDeleteScheduleOperationError(undefined);
    setDeleteSchedule({ schedule });
    loadDeleteSchedulePreview(schedule);
  };
  const closeDeleteSchedule = (): void => {
    if (deleteSchedulePending) return;
    deleteSchedulePreviewGenerationRef.current += 1;
    setDeleteSchedule(undefined);
  };
  const confirmDeleteSchedule = async (): Promise<void> => {
    const request = deleteSchedule;
    if (request === undefined || deleteSchedulePending || props.onDeleteSchedule === undefined) return;
    if (deleteScheduleGeneratedCount === undefined || deleteSchedulePreviewError !== undefined) return;
    setDeleteSchedulePending(true);
    setDeleteScheduleOperationError(undefined);
    try {
      await props.onDeleteSchedule(request.schedule, deleteScheduleDisposition);
      deleteSchedulePreviewGenerationRef.current += 1;
      setDeleteSchedule(undefined);
    } catch (error) {
      setDeleteScheduleOperationError(error instanceof Error ? error.message : t("error.unexpected"));
    } finally {
      setDeleteSchedulePending(false);
    }
  };

  const cancelRailClose = useCallback((): void => {
    if (railCloseTimerRef.current !== undefined) window.clearTimeout(railCloseTimerRef.current);
    railCloseTimerRef.current = undefined;
  }, []);
  const cancelRailProjectClose = useCallback((): void => {
    if (railProjectCloseTimerRef.current !== undefined) window.clearTimeout(railProjectCloseTimerRef.current);
    railProjectCloseTimerRef.current = undefined;
  }, []);
  const closeRailPanels = useCallback((restoreKeyboardFocus = false): void => {
    cancelRailClose();
    cancelRailProjectClose();
    setRailPanel(undefined);
    setRailPreview(undefined);
    if (!restoreKeyboardFocus) {
      railKeyboardReturnRef.current = undefined;
      return;
    }
    const returnTarget = railKeyboardReturnRef.current;
    railKeyboardReturnRef.current = undefined;
    window.requestAnimationFrame(() => {
      if (returnTarget?.isConnected === true && returnTarget.getClientRects().length > 0) returnTarget.focus({ preventScroll: true });
    });
  }, [cancelRailClose, cancelRailProjectClose]);
  const openRailSection = useCallback((section: SidebarRailPanelSection, trigger: HTMLButtonElement, openedViaKeyboard: boolean): void => {
    cancelRailClose();
    cancelRailProjectClose();
    setRailPreview(undefined);
    if (openedViaKeyboard) railKeyboardReturnRef.current = trigger;
    const rect = trigger.getBoundingClientRect();
    setRailPanel({
      section,
      anchor: { right: rect.right, top: rect.top },
      trigger,
      openedViaKeyboard
    });
  }, [cancelRailClose, cancelRailProjectClose]);
  const scheduleRailClose = useCallback((): void => {
    if (railPanel?.openedViaKeyboard === true) return;
    cancelRailClose();
    railCloseTimerRef.current = window.setTimeout(() => closeRailPanels(), SIDEBAR_RAIL_PANEL_CLOSE_GRACE_MS);
  }, [cancelRailClose, closeRailPanels, railPanel?.openedViaKeyboard]);
  const openRailProject = useCallback((projectId: string, trigger: HTMLElement, openedViaKeyboard: boolean): void => {
    cancelRailClose();
    cancelRailProjectClose();
    const rect = trigger.getBoundingClientRect();
    setRailPanel((current) => current?.section !== "projects" ? current : {
      ...current,
      projectId,
      projectAnchor: { right: rect.right, top: rect.top },
      projectOpenedViaKeyboard: openedViaKeyboard
    });
  }, [cancelRailClose, cancelRailProjectClose]);
  const scheduleRailProjectClose = useCallback((): void => {
    if (railPanel?.openedViaKeyboard === true || railPanel?.projectOpenedViaKeyboard === true) return;
    cancelRailProjectClose();
    railProjectCloseTimerRef.current = window.setTimeout(() => setRailPanel((current) => current === undefined ? current : {
      ...current,
      projectId: undefined,
      projectAnchor: undefined,
      projectOpenedViaKeyboard: undefined
    }), SIDEBAR_RAIL_PANEL_CLOSE_GRACE_MS);
  }, [cancelRailProjectClose, railPanel?.openedViaKeyboard, railPanel?.projectOpenedViaKeyboard]);

  useEffect(() => () => {
    if (railCloseTimerRef.current !== undefined) window.clearTimeout(railCloseTimerRef.current);
    if (railProjectCloseTimerRef.current !== undefined) window.clearTimeout(railProjectCloseTimerRef.current);
  }, []);
  useEffect(() => {
    if (props.mode === "rail" && props.open) return;
    cancelRailClose();
    cancelRailProjectClose();
    setRailPanel(undefined);
    setRailPreview(undefined);
    railKeyboardReturnRef.current = undefined;
  }, [cancelRailClose, cancelRailProjectClose, props.mode, props.open]);
  useEffect(() => {
    if (railPanel === undefined) return;
    const ownerDocument = railPanel.trigger.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow === null) return;
    const onPointerDown = (event: globalThis.MouseEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(SIDEBAR_RAIL_PANEL_KEEPALIVE_SELECTOR) !== null) return;
      closeRailPanels();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const activeElement = ownerDocument.activeElement;
      if (activeElement instanceof Element && activeElement.closest(".session-row__rename-input, .session-menu-popover, .session-project-menu-popover") !== null) return;
      event.preventDefault();
      closeRailPanels(true);
    };
    ownerDocument.addEventListener("mousedown", onPointerDown, true);
    ownerWindow.addEventListener("keydown", onKeyDown);
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting)) closeRailPanels();
    });
    observer?.observe(railPanel.trigger);
    return () => {
      ownerDocument.removeEventListener("mousedown", onPointerDown, true);
      ownerWindow.removeEventListener("keydown", onKeyDown);
      observer?.disconnect();
    };
  }, [closeRailPanels, railPanel]);
  useLayoutEffect(() => {
    if (railPanel?.openedViaKeyboard !== true) return;
    const level = railPanel.projectOpenedViaKeyboard === true && railPanel.projectId !== undefined ? "2" : "1";
    const frame = window.requestAnimationFrame(() => document
      .querySelector<HTMLElement>(`.sidebar-rail-panel[data-sidebar-rail-panel-level='${level}'] button, .sidebar-rail-panel[data-sidebar-rail-panel-level='${level}'] [tabindex]:not([tabindex='-1'])`)
      ?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [railPanel?.openedViaKeyboard, railPanel?.projectId, railPanel?.projectOpenedViaKeyboard, railPanel?.section]);

  const openRailProjectEntry = railPanel?.projectId === undefined
    ? undefined
    : railProjectEntries.find((entry) => entry.id === railPanel.projectId);
  const railProjectsIndicator = strongestSidebarRightStatus([
    ...railLocalProjectEntries.flatMap((entry) => entry.kind === "local"
      ? entry.sessions.map((session) => sidebarSessionIndicatorState(session, priorityContext))
      : []),
    ...railRemoteProjectEntries.flatMap((entry) => entry.kind === "remote"
      ? entry.sessions.map(remoteCachedStatus)
      : [])
  ]);
  const railDialoguesIndicator = strongestSidebarRightStatus([
    ...railDialogueSessions.map((session) => sidebarSessionIndicatorState(session, priorityContext)),
    ...railRemoteDialogueEntries.map(({ session }) => remoteCachedStatus(session))
  ]);
  const railDialogueBackend = dialogueBackends(snapshot.backends, snapshot.settings.backendSettings)[0];
  const projectActions: SidebarProjectActions = {
    allSessions: snapshot.sessions,
    onEditTarget: (target) => navigateAndClose({ kind: "projects", projectId: target.id }),
    onNewTaskInTarget: props.onNewTaskInTarget,
    onRenameTarget: props.onRenameTarget,
    onPinTarget: props.onPinTarget,
    onSearchTarget: (target) => {
      closeRailPanels();
      setMessageSearchTargetIds([target.id]);
      props.onExpand();
      window.requestAnimationFrame(() => props.searchInputRef.current?.focus({ preventScroll: true }));
    },
    onCopyTargetLink: props.onCopyTargetLink,
    onRemoveTarget: props.onRemoveTarget,
    onSetTargetSessionsArchived: props.onSetTargetSessionsArchived
  };

  const localMainContent = <div className={cx("sidebar-main-view", `sidebar-view--${sidebarLayout.mainViewMode}`)}>
    <SessionCollectionSection
      title={t(sidebarLayout.status === "archived" ? "nav.archived" : "nav.unpinned")}
      sessions={recent}
      automationSchedules={snapshot.schedules}
      scheduleGroupOwnerId={props.sidebarOwnerId}
      scheduleGroupFoldIntent={scheduleGroupFoldIntent}
      onScheduleGroupExpansionChange={() => setScheduleGroupExpansionRevision((revision) => revision + 1)}
      targets={orderedTargets}
      groupBy={sidebarLayout.groupBy}
      groupDialogue={sidebarLayout.groupDialogue}
      projectOrder={sidebarLayout.projectOrder}
      activeSessionId={activeSessionId}
      locale={props.locale}
      collapsedTargets={collapsedTargets}
      collapsedDialogue={sidebarLayout.collapsedDialogue}
      browsableTargetIds={browsableTargetIds}
      t={t}
      onToggleTarget={toggleTarget}
      onToggleDialogue={toggleDialogue}
      projectActions={projectActions}
      workspacePathFor={workspacePathFor}
      onReorderTargets={reorderProjects}
      reducedMotion={reducedMotion}
      priorityContext={priorityContext}
      sessionInfoFields={sidebarLayout.sessionInfoFields}
      projectNameFor={projectNameFor}
      environmentNameFor={environmentNameFor}
      sessionProfileId={props.machineControl?.activeProfile.id}
      onOpenSchedule={(schedule) => navigateAndClose({ kind: "schedules", scheduleId: schedule.id })}
      onRunSchedule={props.onRunSchedule}
      onToggleSchedule={props.onToggleSchedule}
      onDeleteSchedule={requestDeleteSchedule}
      {...callbacks}
    />
  </div>;

  return <><SidebarFrame
    server={snapshot.server}
    probeRuntimeActivity={props.probeRuntimeActivity}
    open={props.open}
    mode={props.mode}
    width={props.width}
    t={t}
    onHome={() => navigateAndClose({ kind: "session" })}
    onNewTask={createTaskAndClose}
    onSearch={() => {
      props.onExpand();
      requestAnimationFrame(() => props.searchInputRef.current?.focus());
    }}
    onCloseDrawer={props.onClose}
    onHide={props.onHide}
    onCollapse={props.onCollapse}
    onExpand={props.onExpand}
    onResizePointerDown={props.onResizePointerDown}
    onResizePointerMove={props.onResizePointerMove}
    onResizePointerUp={props.onResizePointerUp}
    onResizePointerCancel={props.onResizePointerCancel}
    onResizeKeyDown={props.onResizeKeyDown}
    onResetWidth={props.onResetWidth}
    onDisconnect={props.onDisconnect}
    expandedBody={<>
        {props.machineControl !== undefined && <MachineSwitcherMenu
          {...props.machineControl}
          locale={props.locale}
          t={t}
        />}
        <div className="sidebar__primary">
        <div className="sidebar-search">
          <Search aria-hidden="true" />
          <label className="sr-only" htmlFor="conversation-search-input">{t("nav.searchTasks")}</label>
          <input
            id="conversation-search-input"
            ref={props.searchInputRef}
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={searchPopupOpen}
            aria-controls={searchPopupOpen ? "conversation-search-results" : undefined}
            aria-activedescendant={activeSearchDescendant}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t("nav.searchTasks")}
          />
          {query !== "" && <IconButton className="conversation-search__clear" label={t("nav.clearSearch")} onClick={() => { clearSearch(); props.searchInputRef.current?.focus(); }}><X aria-hidden="true" /></IconButton>}
          <details ref={searchFilterRef} className="conversation-search-filter" onKeyDown={(event) => {
            if (event.key !== "Escape" || event.repeat) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.open = false;
            props.searchInputRef.current?.focus();
            }}>
            <TipSummary label={messageSearchFilterAria} tip={t("nav.searchFilter")}>
              <SlidersHorizontal aria-hidden="true" />
              {messageSearchActiveFilterCount > 0 && <span className="conversation-search-filter__dot" aria-hidden="true" />}
            </TipSummary>
            <div className="conversation-search-filter__menu" role="group" aria-label={t("nav.searchFilter")}>
              <div className="conversation-search-filter__header">
                <strong>{t("nav.searchFilter")}</strong>
                {messageSearchActiveFilterCount > 0 && <button type="button" onClick={resetMessageSearchFilters}>{t("nav.searchFilterReset")}</button>}
              </div>
              <label>
                <span>{t("nav.searchSort")}</span>
                <SelectControl value={props.messageSearchSort} onChange={(event) => props.onMessageSearchSortChange(event.target.value as ConversationSearchSort)}>
                  <option value="relevance">{t("nav.searchSortRelevance")}</option>
                  <option value="activityDesc">{t("nav.searchSortNewest")}</option>
                  <option value="activityAsc">{t("nav.searchSortOldest")}</option>
                </SelectControl>
              </label>
              <label>
                <span>{t("nav.searchStatus")}</span>
                <SelectControl value={messageSearchStatus} onChange={(event) => setMessageSearchStatus(event.target.value as ConversationSearchStatusFilter)}>
                  <option value="active">{t("nav.searchStatusActive")}</option>
                  <option value="archived">{t("nav.searchStatusArchived")}</option>
                  <option value="all">{t("nav.searchStatusAll")}</option>
                </SelectControl>
              </label>
              <fieldset className="conversation-search-filter__projects">
                <legend>{t("nav.searchProjects")}</legend>
                <div className="conversation-search-filter__project-list">
                  <label>
                    <CheckboxControl checked={messageSearchTargetIds === "all"} onChange={() => setMessageSearchTargetIds("all")} />
                    <span>{t("nav.searchProjectsAll")}</span>
                  </label>
                  {snapshot.targets.map((target) => <label key={target.id}>
                    <CheckboxControl
                      checked={messageSearchTargetIds !== "all" && messageSearchTargetIds.includes(target.id)}
                      onChange={() => toggleMessageSearchTarget(target.id)}
                    />
                    <span title={target.name}>{target.name}</span>
                    <small>{snapshot.sessions.filter((session) => session.targetId === target.id).length}</small>
                  </label>)}
                </div>
              </fieldset>
              <label>
                <span>{t("nav.searchAgent")}</span>
                <SelectControl value={messageSearchBackendId} onChange={(event) => setMessageSearchBackendId(event.target.value)}>
                  <option value="all">{t("nav.searchAgentAll")}</option>
                  {snapshot.backends.map((backend) => <option key={backend.id} value={backend.id}>{backend.name}</option>)}
                </SelectControl>
              </label>
              <label>
                <span>{t("nav.searchLastActivity")}</span>
                <SelectControl value={messageSearchLastActivity} onChange={(event) => setMessageSearchLastActivity(event.target.value as ConversationSearchLastActivityFilter)}>
                  <option value="1d">{t("nav.searchLastActivity1d")}</option>
                  <option value="3d">{t("nav.searchLastActivity3d")}</option>
                  <option value="7d">{t("nav.searchLastActivity7d")}</option>
                  <option value="30d">{t("nav.searchLastActivity30d")}</option>
                  <option value="all">{t("nav.searchLastActivityAll")}</option>
                </SelectControl>
              </label>
            </div>
          </details>
        </div>
        </div>

        <nav ref={sessionListRef} className="sidebar__sessions" aria-label={t("a11y.sessions")} onContextMenu={(event) => {
          if (searchPopupOpen || !(event.target instanceof Element) || event.target.closest("button, a, input, select, textarea, summary, [role='button'], [role='menu']") !== null) return;
          event.preventDefault();
          setListSettingsContextMenuRequest({ x: event.clientX, y: event.clientY });
        }}>
        {!searchPopupOpen && selectedSessions.length > 0 && <div className="sidebar-bulk-actions" role="status">
          <span><strong>{selectedSessions.length}</strong> {t("projects.tasks")}</span>
          <IconButton label={t("session.archive")} disabled={!selectedSessions.some((session) => !session.archived)} disabledReason={t("session.archive")} onClick={() => { const batch = selectedSessions; setSelectedSessionIds(new Set()); selectionAnchorRef.current = undefined; props.onBulkArchive?.(batch); }}><Archive aria-hidden="true" /></IconButton>
          <IconButton label={t("session.delete")} onClick={() => { const batch = selectedSessions; setSelectedSessionIds(new Set()); selectionAnchorRef.current = undefined; props.onBulkDelete?.(batch); }}><Trash2 aria-hidden="true" /></IconButton>
          <IconButton label={t("common.dismiss")} onClick={() => { setSelectedSessionIds(new Set()); selectionAnchorRef.current = undefined; }}><X aria-hidden="true" /></IconButton>
        </div>}
        {!searchPopupOpen && <SidebarListSettings
          layout={sidebarLayout}
          targets={snapshot.targets}
          backends={snapshot.backends}
          sessions={snapshot.sessions}
          activeContentFilterCount={activeContentFilterCount}
          deviceGroupingAvailable={remoteMachineCaches.length > 0}
          foldAction={foldAction}
          contextMenuRequest={listSettingsContextMenuRequest}
          t={t}
          onContextMenuRequestHandled={() => setListSettingsContextMenuRequest(undefined)}
          onStatusChange={(status) => props.onSidebarDisplayPreferencesChange({ status })}
          onGroupByChange={(groupBy) => props.onSidebarDisplayPreferencesChange({ groupBy })}
          onGroupDialogueChange={(groupDialogue) => props.onSidebarDisplayPreferencesChange({ groupDialogue })}
          onGroupDeviceChange={(groupDevice) => props.onSidebarDisplayPreferencesChange({ groupDevice })}
          onSortByChange={(sortBy) => props.onSidebarDisplayPreferencesChange({ sortBy })}
          onProjectOrderChange={setProjectOrder}
          onMainViewModeChange={(mainViewMode) => props.onSidebarDisplayPreferencesChange({ mainViewMode })}
          onProjectFilterToggle={(projectId) => props.onSidebarOwnerLayoutChange({
            projectFilter: toggleSidebarProjectFilter(sidebarLayout.projectFilter, projectId)
          })}
          onProjectFilterReset={() => props.onSidebarOwnerLayoutChange({ projectFilter: "all" })}
          onBackendChange={(backendId) => props.onSidebarDisplayPreferencesChange({ backendId })}
          onLastActivityChange={(lastActivity) => props.onSidebarDisplayPreferencesChange({ lastActivity })}
          onResetContentFilters={() => {
            props.onSidebarDisplayPreferencesChange({ status: "active", backendId: "all", lastActivity: "all" });
            props.onSidebarOwnerLayoutChange({ projectFilter: "all" });
          }}
          onToggleAllGroups={toggleAllVisibleGroups}
          onSessionInfoFieldToggle={(field) => props.onSidebarDisplayPreferencesChange({
            sessionInfoFields: toggleSidebarSessionInfoField(sidebarLayout.sessionInfoFields, field)
          })}
        />}
        {searchPopupOpen ? (
          <div id="conversation-search-results" className="conversation-search-popup" role="listbox" aria-label={t("nav.searchResults")}>
            {!messageSearchLoading && messageSearchError === undefined && <SearchResults
              results={searchResults}
              query={query.trim()}
              activeSessionId={activeSessionId}
              activeOptionIndex={activeSearchOption}
              expandedSessionIds={expandedSearchSessions}
              profileId={currentSearchProfileId}
              locale={props.locale}
              t={t}
              onActivate={(option) => activateSearchOption(option)}
              onActiveOptionChange={setActiveSearchOption}
            />}
            {remoteSearchOptions.length > 0 && <RemoteMachineSearchResults
              options={remoteSearchOptions}
              optionOffset={searchOptions.length}
              activeOptionIndex={activeSearchOption}
              query={query.trim()}
              locale={props.locale}
              t={t}
              onActivate={(option) => activateSearchOption(option)}
              onActiveOptionChange={setActiveSearchOption}
            />}
            {(messageSearchLoading || remoteMessageSearchLoading) && <p className="sidebar-search__status" role="status"><span className="conversation-search__spinner" aria-hidden="true" />{t("nav.searchingMessages")}</p>}
            {messageSearchError !== undefined && <p className="sidebar-search__status sidebar-search__status--error" role="alert">{messageSearchError}</p>}
            {remoteMessageSearchError !== undefined && <p className="sidebar-search__status sidebar-search__status--error" role="alert">{remoteMessageSearchError}</p>}
            {!messageSearchLoading && !remoteMessageSearchLoading && messageSearchError === undefined && remoteMessageSearchError === undefined && searchResults.length === 0 && remoteSearchOptions.length === 0 && <p className="sidebar__empty">{t("nav.noMatchingTasks")}</p>}
          </div>
        ) : (
          <>
            {pinnedEntries.length > 0 && <PinnedSessionSection
              viewMode={sidebarLayout.pinnedViewMode}
              title={t("nav.pinned")}
              entries={pinnedEntries}
              targets={snapshot.targets}
              activeSessionId={activeSessionId}
              locale={props.locale}
              t={t}
              onReorder={reorderPinned}
              onViewModeChange={(pinnedViewMode) => props.onSidebarDisplayPreferencesChange({ pinnedViewMode })}
              projectActions={projectActions}
              workspacePathFor={workspacePathFor}
              remotePresenceByProfile={props.machineControl?.presenceByProfile ?? {}}
              onOpenRemote={(profileId, sessionId) => {
                props.machineControl?.onOpenCachedSession(profileId, sessionId);
                props.onClose();
              }}
              collapsedTargets={collapsedTargets}
              onToggleTarget={toggleTarget}
              browsableTargetIds={browsableTargetIds}
              automationSchedules={snapshot.schedules}
              scheduleGroupOwnerId={props.sidebarOwnerId}
              scheduleGroupFoldIntent={scheduleGroupFoldIntent}
              onScheduleGroupExpansionChange={() => setScheduleGroupExpansionRevision((revision) => revision + 1)}
              onOpenSchedule={(schedule) => navigateAndClose({ kind: "schedules", scheduleId: schedule.id })}
              onRunSchedule={props.onRunSchedule}
              onToggleSchedule={props.onToggleSchedule}
              onDeleteSchedule={requestDeleteSchedule}
              reducedMotion={reducedMotion}
              priorityContext={priorityContext}
              sessionInfoFields={sidebarLayout.sessionInfoFields}
              projectNameFor={projectNameFor}
              environmentNameFor={environmentNameFor}
              sessionProfileId={props.machineControl?.activeProfile.id}
              {...callbacks}
            />}
            {deviceLayerActive && recent.length > 0 && localDeviceId !== undefined
              ? <SidebarDeviceSection
                  profileId={localDeviceId}
                  name={props.machineControl?.activeProfile.name ?? t("machine.current")}
                  presence="current"
                  collapsed={collapsedDeviceSections.has(localDeviceId)}
                  t={t}
                  onToggle={() => toggleDeviceSection(localDeviceId)}
                >{localMainContent}</SidebarDeviceSection>
              : localMainContent}
          </>
        )}
        {!searchPopupOpen && props.machineControl !== undefined && remoteMachineCaches.length > 0 && <RemoteMachineSessionSections
          caches={remoteMachineCaches}
          presenceByProfile={props.machineControl.presenceByProfile}
          status={sidebarLayout.status}
          grouped={sidebarLayout.groupDevice}
          collapsedProfileIds={collapsedDeviceSections}
          contentFiltersActive={sidebarLayout.backendId !== "all" || sidebarLayout.projectFilter !== "all"}
          lastActivity={sidebarLayout.lastActivity}
          locale={props.locale}
          t={t}
          onToggleProfile={toggleDeviceSection}
          onOpen={(profileId, sessionId) => {
            props.machineControl?.onOpenCachedSession(profileId, sessionId);
            props.onClose();
          }}
        />}
        {!searchPopupOpen && pinnedEntries.length === 0 && recent.length === 0 && remoteMachineSessionCount === 0 && <p className="sidebar__empty">{t("session.emptyBody")}</p>}
        </nav>

        <nav className="sidebar__utility" aria-label={t("a11y.productNavigation")}>
        <button type="button" className={cx(route.kind === "projects" && "is-active")} onClick={() => navigateAndClose({ kind: "projects" })}><FolderKanban aria-hidden="true" /><span>{t("nav.projects")}</span><span className="nav-count">{snapshot.targets.filter((target) => !target.archived).length}</span></button>
        <button type="button" className={cx(route.kind === "schedules" && "is-active")} onClick={() => navigateAndClose({ kind: "schedules" })}><CalendarClock aria-hidden="true" /><span>{t("nav.schedules")}</span><span className="nav-count">{snapshot.schedules.filter((schedule) => schedule.enabled).length}</span></button>
        <button type="button" className={cx(route.kind === "tools" && "is-active")} onClick={() => navigateAndClose({ kind: "tools" })}><Wrench aria-hidden="true" /><span>{t("nav.tools")}</span>{snapshot.diagnostics.length > 0 && <span className="notification-dot" />}</button>
        <button type="button" className={cx(route.kind === "settings" && "is-active")} onClick={() => navigateAndClose({ kind: "settings" })}><Settings aria-hidden="true" /><span>{t("nav.settings")}</span></button>
        <button type="button" className={cx("archive-toggle", showArchived && "is-active")} onClick={() => props.onSidebarDisplayPreferencesChange({ status: showArchived ? "active" : "archived" })}><Archive aria-hidden="true" /><span>{t("nav.archived")}</span></button>
        </nav>

      </>}
    railBody={<>
        <nav className="sidebar__rail-sessions" aria-label={t("a11y.sessions")}>
          <SortableList
            items={railPinnedEntries}
            getId={(entry) => entry.id}
            onReorder={reorderPinned}
            renderItem={(entry) => {
              const local = entry.kind === "session";
              const title = entry.session.name;
              const active = local && entry.session.id === activeSessionId;
              const indicator = local
                ? sidebarSessionIndicatorState(entry.session, priorityContext)
                : remoteCachedStatus(entry.session);
              const stateLabel = indicator === undefined
                ? sessionStateLabel(entry.session.state, t)
                : sidebarRightStatusLabel(indicator, t);
              const machineLabel = local ? "" : ` · ${entry.cache.name}`;
              return <button
                type="button"
                className={cx("sidebar__rail-pinned-tile", active && "is-active", !local && "is-remote")}
                data-session-id={entry.session.id}
                data-machine-profile={local ? undefined : entry.cache.profileId}
                aria-label={`${title}${machineLabel} · ${stateLabel}`}
                aria-current={active ? "page" : undefined}
                onPointerEnter={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setRailPreview({ entry, anchor: { right: rect.right, top: rect.top } });
                }}
                onPointerLeave={() => setRailPreview(undefined)}
                onClick={() => {
                  setRailPreview(undefined);
                  closeRailPanels();
                  if (entry.kind === "session") callbacks.onSelect(entry.session);
                  else {
                    props.machineControl?.onOpenCachedSession(entry.cache.profileId, entry.session.id);
                    props.onClose();
                  }
                }}
              >
                <span className="sidebar__rail-pinned-icon">
                  <SidebarRightStatusIndicator status={indicator} active={active} className="sidebar-right-status--rail" t={t} />
                  {local ? <MessageSquare aria-hidden="true" /> : <Laptop aria-hidden="true" />}
                </span>
                <span className="sidebar__rail-pinned-label">{sidebarRailPinnedLabel(title)}</span>
              </button>;
            }}
            reducedMotion={reducedMotion}
            filter="input, textarea, select, a, [data-no-drag]"
            className="sidebar__rail-pinned"
            rowClassName="sidebar__rail-pinned-row"
            role="list"
            ariaLabel={t("nav.pinned")}
          />
          {railPinnedEntries.length > 0 && <div className="sidebar__rail-section-divider" aria-hidden="true" />}
          <div className="sidebar__rail-aggregates">
            <IconButton
              className={cx("sidebar__rail-aggregate", railPanel?.section === "projects" && "is-open")}
              data-sidebar-rail-trigger="projects"
              label={t("nav.projects")}
              tip={railPanel?.section === "projects" ? "" : t("nav.projects")}
              aria-haspopup="menu"
              aria-expanded={railPanel?.section === "projects"}
              onPointerEnter={(event) => {
                if (railPanel?.section === "projects") cancelRailClose();
                else openRailSection("projects", event.currentTarget, false);
              }}
              onPointerLeave={scheduleRailClose}
              onClick={(event) => openRailSection("projects", event.currentTarget, event.detail === 0)}
            ><SidebarRightStatusIndicator status={railProjectsIndicator} active={false} className="sidebar-right-status--rail" t={t} /><FolderKanban aria-hidden="true" /></IconButton>
            <IconButton
              className={cx("sidebar__rail-aggregate", railPanel?.section === "dialogues" && "is-open")}
              data-sidebar-rail-trigger="dialogues"
              label={t("newTask.dialogues")}
              tip={railPanel?.section === "dialogues" ? "" : t("newTask.dialogues")}
              aria-haspopup="menu"
              aria-expanded={railPanel?.section === "dialogues"}
              onPointerEnter={(event) => {
                if (railPanel?.section === "dialogues") cancelRailClose();
                else openRailSection("dialogues", event.currentTarget, false);
              }}
              onPointerLeave={scheduleRailClose}
              onClick={(event) => openRailSection("dialogues", event.currentTarget, event.detail === 0)}
            ><SidebarRightStatusIndicator status={railDialoguesIndicator} active={false} className="sidebar-right-status--rail" t={t} /><MessageSquare aria-hidden="true" /></IconButton>
          </div>
        </nav>
        <nav className="sidebar__rail-utility" aria-label={t("a11y.productNavigation")}>
          {activeSession !== undefined && activeTarget !== undefined && browsableTargetIds.has(activeTarget.id) && <IconButton
            label={t("workspace.browseFiles", { name: activeTarget.name })}
            onClick={() => callbacks.onBrowseFiles(activeSession)}
          ><FolderOpen aria-hidden="true" /></IconButton>}
          <IconButton className={cx(route.kind === "schedules" && "is-active")} label={t("nav.schedules")} onClick={() => navigateAndClose({ kind: "schedules" })}><CalendarClock aria-hidden="true" /></IconButton>
          <IconButton className={cx(route.kind === "tools" && "is-active")} label={t("nav.tools")} onClick={() => navigateAndClose({ kind: "tools" })}><Wrench aria-hidden="true" />{snapshot.diagnostics.length > 0 && <span className="notification-dot" />}</IconButton>
          <IconButton className={cx(route.kind === "settings" && "is-active")} label={t("nav.settings")} onClick={() => navigateAndClose({ kind: "settings" })}><Settings aria-hidden="true" /></IconButton>
          <IconButton className={cx(showArchived && "is-active")} label={t("nav.archived")} onClick={() => props.onSidebarDisplayPreferencesChange({ status: showArchived ? "active" : "archived" })}><Archive aria-hidden="true" /></IconButton>
        </nav>
      </>}
  />
    {railPreview !== undefined && <SidebarRailPreviewCard preview={railPreview} locale={props.locale} t={t} />}
    {railPanel !== undefined && <SidebarRailPanelShell
      anchor={railPanel.anchor}
      level={1}
      onPointerEnter={cancelRailClose}
      onPointerLeave={scheduleRailClose}
    >
      <div className="sidebar-rail-panel__header">
        <strong>{t(railPanel.section === "projects" ? "nav.projects" : "newTask.dialogues")}</strong>
        <small>{railPanel.section === "projects"
          ? railProjectEntries.length
          : railDialogueSessions.length + railRemoteDialogueEntries.length}</small>
        {railPanel.section === "dialogues" && railDialogueBackend !== undefined && props.onNewDialogue !== undefined && <IconButton
          label={t("newTask.dialogue")}
          onClick={() => {
            closeRailPanels();
            props.onNewDialogue?.(railDialogueBackend.id);
          }}
        ><SquarePen aria-hidden="true" /></IconButton>}
      </div>
      <div className="sidebar-rail-panel__scroll">
        {railPanel.section === "projects" ? railProjectEntries.map((entry) => {
          const indicator = entry.kind === "local"
            ? sidebarGroupIndicatorState(entry.sessions, priorityContext)
            : strongestSidebarRightStatus(entry.sessions.map(remoteCachedStatus));
          const active = entry.kind === "local" && entry.sessions.some((session) => session.id === activeSessionId);
          if (entry.kind === "local") return <SidebarRailLocalProjectRow
            entry={entry}
            open={railPanel.projectId === entry.id}
            active={active}
            indicator={indicator}
            activeSessionId={activeSessionId}
            browsableTargetIds={browsableTargetIds}
            workspacePath={workspacePathFor(entry.target)}
            t={t}
            actions={projectActions}
            onBrowseFiles={callbacks.onBrowseFiles}
            onOpen={openRailProject}
            onPointerLeave={scheduleRailProjectClose}
            key={entry.id}
          />;
          return <div className={cx("sidebar-rail-project", railPanel.projectId === entry.id && "is-open", active && "is-active")} key={entry.id}>
            <button
              type="button"
              role="menuitem"
              className="sidebar-rail-project__main"
              aria-haspopup="menu"
              aria-expanded={railPanel.projectId === entry.id}
              onPointerEnter={(event) => openRailProject(entry.id, event.currentTarget, false)}
              onPointerLeave={scheduleRailProjectClose}
              onClick={(event) => openRailProject(entry.id, event.currentTarget, event.detail === 0)}
            >
              <FolderKanban aria-hidden="true" />
              <span title={entry.name}>{entry.name}</span>
              <SidebarRightStatusIndicator status={indicator} active={active} t={t} />
              <small>{entry.sessions.length}</small>
              <ChevronRight aria-hidden="true" />
            </button>
          </div>;
        }) : <>
          <CollapsibleSessionRows
            sessions={railDialogueSessions}
            activeSessionId={activeSessionId}
            locale={props.locale}
            noDrag
            t={t}
            priorityContext={priorityContext}
            automationSchedules={snapshot.schedules}
            scheduleGroupOwnerId={`${props.sidebarOwnerId}:rail-dialogues`}
            scheduleGroupFoldIntent={scheduleGroupFoldIntent}
            onScheduleGroupExpansionChange={() => setScheduleGroupExpansionRevision((revision) => revision + 1)}
            onOpenSchedule={(schedule) => navigateAndClose({ kind: "schedules", scheduleId: schedule.id })}
            onRunSchedule={props.onRunSchedule}
            onToggleSchedule={props.onToggleSchedule}
            onDeleteSchedule={requestDeleteSchedule}
            sessionInfoFields={sidebarLayout.sessionInfoFields}
            projectNameFor={projectNameFor}
            environmentNameFor={environmentNameFor}
            sessionProfileId={props.machineControl?.activeProfile.id}
            {...callbacks}
          />
          {railRemoteDialogueEntries.length > 0 && <ul className="sidebar-session-entry-list">{railRemoteDialogueEntries.map(({ cache, session }) => <RemoteMachineSessionRow
            cache={cache}
            session={session}
            presence={props.machineControl?.presenceByProfile[cache.profileId] ?? "offline"}
            locale={props.locale}
            t={t}
            onOpen={(profileId, sessionId) => props.machineControl?.onOpenCachedSession(profileId, sessionId)}
            key={`${cache.profileId}:${session.id}`}
          />)}</ul>}
          {railDialogueSessions.length === 0 && railRemoteDialogueEntries.length === 0 && <p className="sidebar-rail-panel__empty">{t("session.emptyBody")}</p>}
        </>}
      </div>
    </SidebarRailPanelShell>}
    {railPanel?.projectAnchor !== undefined && openRailProjectEntry !== undefined && <SidebarRailPanelShell
      anchor={railPanel.projectAnchor}
      level={2}
      onPointerEnter={() => {
        cancelRailClose();
        cancelRailProjectClose();
      }}
      onPointerLeave={() => {
        scheduleRailProjectClose();
        scheduleRailClose();
      }}
    >
      <div className="sidebar-rail-panel__header">
        <strong title={openRailProjectEntry.name}>{openRailProjectEntry.name}</strong>
        <small>{openRailProjectEntry.sessions.length}</small>
        {openRailProjectEntry.kind === "local" && props.onNewTaskInTarget !== undefined && <IconButton
          label={t("workspace.createSession")}
          onClick={() => {
            closeRailPanels();
            props.onNewTaskInTarget?.(openRailProjectEntry.target);
          }}
        ><SquarePen aria-hidden="true" /></IconButton>}
        {openRailProjectEntry.kind === "local" && (() => {
          const browsableSession = openRailProjectEntry.sessions.find((session) => session.id === activeSessionId)
            ?? openRailProjectEntry.sessions[0];
          return browsableSession !== undefined && browsableTargetIds.has(openRailProjectEntry.target.id) ? <IconButton
            label={t("workspace.browseFiles", { name: openRailProjectEntry.name })}
            onClick={() => callbacks.onBrowseFiles(browsableSession)}
          ><FolderOpen aria-hidden="true" /></IconButton> : null;
        })()}
      </div>
      <div className="sidebar-rail-panel__scroll">
        {openRailProjectEntry.kind === "local" ? <CollapsibleSessionRows
          key={openRailProjectEntry.id}
          sessions={openRailProjectEntry.sessions}
          activeSessionId={activeSessionId}
          locale={props.locale}
          noDrag
          t={t}
          priorityContext={priorityContext}
          automationSchedules={snapshot.schedules}
          scheduleGroupOwnerId={`${props.sidebarOwnerId}:rail-project:${openRailProjectEntry.id}`}
          scheduleGroupFoldIntent={scheduleGroupFoldIntent}
          onScheduleGroupExpansionChange={() => setScheduleGroupExpansionRevision((revision) => revision + 1)}
          onOpenSchedule={(schedule) => navigateAndClose({ kind: "schedules", scheduleId: schedule.id })}
          onRunSchedule={props.onRunSchedule}
          onToggleSchedule={props.onToggleSchedule}
          onDeleteSchedule={requestDeleteSchedule}
          sessionInfoFields={sidebarLayout.sessionInfoFields}
          projectNameFor={projectNameFor}
          environmentNameFor={environmentNameFor}
          sessionProfileId={props.machineControl?.activeProfile.id}
          {...callbacks}
        /> : <ul className="sidebar-session-entry-list">{openRailProjectEntry.sessions.map((session) => <RemoteMachineSessionRow
          cache={openRailProjectEntry.cache}
          session={session}
          presence={props.machineControl?.presenceByProfile[openRailProjectEntry.cache.profileId] ?? "offline"}
          locale={props.locale}
          t={t}
          onOpen={(profileId, sessionId) => props.machineControl?.onOpenCachedSession(profileId, sessionId)}
          key={`${openRailProjectEntry.cache.profileId}:${session.id}`}
        />)}</ul>}
        {openRailProjectEntry.sessions.length === 0 && <p className="sidebar-rail-panel__empty">{t("session.emptyBody")}</p>}
      </div>
    </SidebarRailPanelShell>}
    <ScheduleDeleteDialog
      schedule={deleteSchedule?.schedule}
      disposition={deleteScheduleDisposition}
      generatedCount={deleteScheduleGeneratedCount}
      inflightCount={deleteScheduleInflightCount}
      previewError={deleteSchedulePreviewError}
      operationError={deleteScheduleOperationError}
      pending={deleteSchedulePending}
      t={t}
      onDispositionChange={setDeleteScheduleDisposition}
      onRetryPreview={() => { if (deleteSchedule !== undefined) loadDeleteSchedulePreview(deleteSchedule.schedule); }}
      onClose={closeDeleteSchedule}
      onConfirm={() => void confirmDeleteSchedule()}
    />
  </>;
}

function SidebarRailPanelShell({ anchor, level, onPointerEnter, onPointerLeave, children }: {
  readonly anchor: SidebarRailPanelAnchor;
  readonly level: 1 | 2;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly left: number; readonly top: number }>();
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const ownerWindow = panel?.ownerDocument.defaultView;
    if (panel === null || panel === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const desiredLeft = anchor.right + (level === 1 ? 12 : 8);
    const desiredTop = anchor.top - 6;
    setPosition({
      left: Math.max(8, Math.min(desiredLeft, ownerWindow.innerWidth - panel.offsetWidth - 8)),
      top: Math.max(8, Math.min(desiredTop, ownerWindow.innerHeight - panel.offsetHeight - 8))
    });
  }, [anchor.right, anchor.top, level]);
  return createPortal(<div
    ref={panelRef}
    role="menu"
    className="sidebar-rail-panel"
    data-sidebar-rail-panel-level={level}
    style={{
      left: position?.left ?? anchor.right + (level === 1 ? 12 : 8),
      top: position?.top ?? anchor.top - 6,
      visibility: position === undefined ? "hidden" : undefined
    }}
    onPointerEnter={onPointerEnter}
    onPointerLeave={(event) => {
      const next = event.relatedTarget instanceof Element ? event.relatedTarget : null;
      if (level === 1 && next !== null && next.closest(SIDEBAR_RAIL_PANEL_KEEPALIVE_SELECTOR) !== null) return;
      if (level === 2 && next !== null && next.closest(".sidebar-rail-panel[data-sidebar-rail-panel-level='2'], .session-menu-popover, .session-project-menu-popover, [role='dialog'], [role='alertdialog']") !== null) return;
      onPointerLeave();
    }}
  >{children}</div>, document.body);
}

function SidebarRailPreviewCard({ preview, locale, t }: {
  readonly preview: SidebarRailPreviewState;
  readonly locale: string;
  readonly t: Translator;
}): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | undefined>(undefined);
  const { entry } = preview;
  const { session } = entry;
  const indicator = entry.kind === "remoteSession" ? remoteCachedStatus(entry.session) : undefined;
  const status = indicator === undefined ? sessionStateLabel(session.state, t) : sidebarRightStatusLabel(indicator, t);
  const summary = entry.kind === "session" ? entry.session.summary : undefined;
  const updatedAt = entry.kind === "session" ? entry.session.updatedAt : entry.session.lastActivityAt;
  useLayoutEffect(() => {
    const card = cardRef.current;
    const ownerWindow = card?.ownerDocument.defaultView;
    if (card === null || card === undefined || ownerWindow === null || ownerWindow === undefined) return;
    setTop(Math.max(8, Math.min(preview.anchor.top - 4, ownerWindow.innerHeight - card.offsetHeight - 8)));
  }, [preview.anchor.top]);
  return createPortal(<div
    ref={cardRef}
    role="tooltip"
    className="sidebar-rail-preview"
    style={{ left: preview.anchor.right + 10, top: top ?? preview.anchor.top - 4, visibility: top === undefined ? "hidden" : undefined }}
  >
    <strong>{session.name}</strong>
    {summary !== undefined && summary.trim() !== "" && <p>{summary}</p>}
    <small>{entry.kind === "session" ? status : `${entry.cache.name} · ${status}`} · {formatRelativeTime(updatedAt, locale)}</small>
  </div>, document.body);
}

function sidebarRailPinnedLabel(title: string): string {
  const trimmed = title.trim();
  const latinWord = /^[A-Za-z0-9][A-Za-z0-9.-]*/u.exec(trimmed)?.[0];
  if (latinWord !== undefined && latinWord.length >= 2) return latinWord.slice(0, 7);
  return trimmed.slice(0, 4);
}

function strongestSidebarRightStatus(statuses: readonly (SidebarRightStatus | undefined)[]): SidebarRightStatus | undefined {
  const rank: Readonly<Record<SidebarRightStatus, number>> = { error: 0, awaiting: 1, running: 2, done: 3 };
  return statuses.filter((status): status is SidebarRightStatus => status !== undefined)
    .sort((left, right) => rank[left] - rank[right])[0];
}

function messageSearchWasAborted(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

export function sessionsForArchiveView(sessions: readonly SessionView[], showArchived: boolean): readonly SessionView[] {
  return sessionsForSidebarStatus(sessions, showArchived ? "archived" : "active");
}

export function sessionsForSidebarStatus(sessions: readonly SessionView[], status: SidebarLayout["status"]): readonly SessionView[] {
  return status === "all" ? sessions : sessions.filter((session) => session.archived === (status === "archived"));
}

interface RemoteMachineSearchFilters {
  readonly status: ConversationSearchStatusFilter;
  readonly lastActivity: ConversationSearchLastActivityFilter;
  readonly backendFilterActive: boolean;
  readonly projectFilterActive: boolean;
  readonly sort: ConversationSearchSort;
  readonly messageMatches?: readonly FederatedSessionMessageSearchMatchView[];
  /** Selected trusted profiles let live hits create rows before the cache refresh arrives. */
  readonly profiles?: readonly ConnectionProfile[];
}

export function projectRemoteMachineSearchResults(
  caches: readonly MachineCacheView[],
  presenceByProfile: Readonly<Record<string, MachinePresenceView>>,
  query: string,
  filters: RemoteMachineSearchFilters,
  now = Date.now()
): readonly RemoteMachineSearchResult[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery === "") return [];
  const cutoff = filters.lastActivity === "all"
    ? undefined
    : now - (MESSAGE_SEARCH_ACTIVITY_DAYS[filters.lastActivity] * MESSAGE_SEARCH_DAY_MS);
  const cacheByProfile = new Map(caches.map((cache) => [cache.profileId, cache] as const));
  const profileById = new Map((filters.profiles ?? []).map((profile) => [profile.id, profile] as const));
  const profilesAreBounded = filters.profiles !== undefined;
  const results = new Map<string, RemoteMachineSearchResult>();
  const cachedTitlesAllowed = !filters.backendFilterActive && !filters.projectFilterActive;
  for (const cache of caches) {
    const presence = presenceByProfile[cache.profileId] ?? "offline";
    if (presence === "accessDenied" || presence === "identityMismatch") continue;
    const profile = profileById.get(cache.profileId);
    if (profile?.serverId !== undefined && cache.serverId !== profile.serverId) continue;
    if (!cachedTitlesAllowed) continue;
    const machineMatch = cache.name.toLocaleLowerCase().includes(normalizedQuery);
    for (const session of cache.sessions) {
      if (filters.status === "active" && session.archived) continue;
      if (filters.status === "archived" && !session.archived) continue;
      if (cutoff !== undefined && (session.lastActivityAt === undefined || session.lastActivityAt < cutoff)) continue;
      const nameMatch = session.name.toLocaleLowerCase().includes(normalizedQuery);
      const targetMatch = session.targetName?.toLocaleLowerCase().includes(normalizedQuery) === true;
      if (nameMatch || targetMatch || machineMatch) {
        const key = federatedSessionSearchKey(cache.profileId, session.id);
        results.set(key, {
          key: `remote:${cache.profileId}:${session.id}`,
          profileId: cache.profileId,
          machineName: cache.name,
          presence,
          session,
          source: "cache",
          reachable: presence === "online" || presence === "current",
          titleMatched: true,
          hits: [],
          relevance: nameMatch ? 0 : targetMatch ? 2 : 3,
          score: 0,
          ...(session.lastActivityAt === undefined ? {} : { activityAt: session.lastActivityAt })
        });
      }
    }
  }

  const seenHits = new Set<string>();
  for (const contentMatch of filters.messageMatches ?? []) {
    if (contentMatch.source !== "live" || !contentMatch.reachable) continue;
    const profile = profileById.get(contentMatch.profileId);
    if (profilesAreBounded && profile === undefined) continue;
    const cache = cacheByProfile.get(contentMatch.profileId);
    const trustedServerId = profile?.serverId ?? cache?.serverId;
    const presence = presenceByProfile[contentMatch.profileId] ?? "offline";
    if (trustedServerId === undefined || trustedServerId !== contentMatch.serverId || presence !== "online") continue;
    const hitIdentity = `${contentMatch.profileId}\u0000${contentMatch.match.sessionId}\u0000${contentMatch.match.eventId}`;
    if (seenHits.has(hitIdentity)) continue;
    seenHits.add(hitIdentity);
    const resultKey = federatedSessionSearchKey(contentMatch.profileId, contentMatch.match.sessionId);
    const previous = results.get(resultKey);
    const cachedSession = cache?.serverId === trustedServerId
      ? cache.sessions.find((session) => session.id === contentMatch.match.sessionId)
      : undefined;
    const session: MachineSessionCacheView = previous?.session ?? cachedSession ?? {
      id: contentMatch.match.sessionId,
      name: contentMatch.match.sessionId,
      state: "idle",
      pinned: false,
      archived: filters.status === "archived",
      lastActivityAt: contentMatch.match.createdAt
    };
    const hits = [...(previous?.hits ?? []), contentMatch.match]
      .sort((left, right) => right.score - left.score || right.createdAt - left.createdAt || left.eventId.localeCompare(right.eventId));
    results.set(resultKey, {
      key: `remote:${contentMatch.profileId}:${contentMatch.match.sessionId}`,
      profileId: contentMatch.profileId,
      machineName: profile?.name ?? cache?.name ?? contentMatch.profileId,
      presence,
      session,
      source: previous?.titleMatched === true ? "cache" : "live",
      reachable: true,
      titleMatched: previous?.titleMatched ?? false,
      hits,
      relevance: previous?.relevance ?? 1,
      score: Math.max(previous?.score ?? Number.NEGATIVE_INFINITY, contentMatch.match.score),
      activityAt: Math.max(previous?.activityAt ?? Number.NEGATIVE_INFINITY, contentMatch.match.createdAt)
    });
  }

  return [...results.values()].sort((left, right) => {
    const activity = filters.sort === "activityAsc"
      ? (left.activityAt ?? Number.MAX_SAFE_INTEGER) - (right.activityAt ?? Number.MAX_SAFE_INTEGER)
      : (right.activityAt ?? -1) - (left.activityAt ?? -1);
    return (filters.sort === "relevance" ? left.relevance - right.relevance : 0)
      || (filters.sort === "relevance" ? right.score - left.score : 0)
      || activity
      || left.machineName.localeCompare(right.machineName, undefined, { sensitivity: "base" })
      || left.session.name.localeCompare(right.session.name, undefined, { sensitivity: "base" })
      || left.key.localeCompare(right.key);
  });
}

export function projectRemoteMachineSearchOptions(
  caches: readonly MachineCacheView[],
  presenceByProfile: Readonly<Record<string, MachinePresenceView>>,
  query: string,
  filters: RemoteMachineSearchFilters,
  now = Date.now(),
  expandedSessionIds: ReadonlySet<string> = new Set()
): readonly RemoteMachineSearchOption[] {
  return flattenRemoteMachineSearchOptions(
    projectRemoteMachineSearchResults(caches, presenceByProfile, query, filters, now)
      .slice(0, CONVERSATION_SEARCH_RESULT_LIMIT),
    expandedSessionIds
  );
}

export function flattenRemoteMachineSearchOptions(
  results: readonly RemoteMachineSearchResult[],
  expandedSessionIds: ReadonlySet<string> = new Set(),
  maximumCollapsedHits = 3
): readonly RemoteMachineSearchOption[] {
  return results.flatMap((result) => {
    const visibleHits = expandedSessionIds.has(federatedSessionSearchKey(result.profileId, result.session.id))
      ? result.hits
      : result.hits.slice(0, Math.max(0, maximumCollapsedHits));
    const hiddenHitCount = result.hits.length - visibleHits.length;
    return [{
      ...result,
      kind: "remoteSession" as const
    }, ...visibleHits.map((match): RemoteMachineMessageSearchOption => ({
      key: `remote-message:${result.profileId}:${result.session.id}:${match.eventId}`,
      kind: "remoteMessage",
      profileId: result.profileId,
      machineName: result.machineName,
      presence: result.presence,
      session: result.session,
      source: "live",
      reachable: true,
      match
    })), ...(hiddenHitCount === 0 ? [] : [{
      key: `remote-expand:${result.profileId}:${result.session.id}`,
      kind: "remoteExpand" as const,
      profileId: result.profileId,
      machineName: result.machineName,
      presence: result.presence,
      session: result.session,
      source: "live" as const,
      reachable: true as const,
      hiddenHitCount
    }])];
  });
}

export function projectFederatedSidebarSearchGroups(
  localProfileId: string,
  localResults: readonly ConversationSearchResult[],
  remoteResults: readonly RemoteMachineSearchResult[],
  sort: ConversationSearchSort,
  maximumResults = CONVERSATION_SEARCH_RESULT_LIMIT
): readonly FederatedSidebarSearchGroup[] {
  const groups = new Map<string, FederatedSidebarSearchGroup>();
  for (const result of localResults) {
    const key = federatedSessionSearchKey(localProfileId, result.session.id);
    groups.set(key, { kind: "local", key, result });
  }
  for (const result of remoteResults) {
    const key = federatedSessionSearchKey(result.profileId, result.session.id);
    if (!groups.has(key)) groups.set(key, { kind: "remote", key, result });
  }
  return [...groups.values()].sort((left, right) => {
    const leftActivity = left.kind === "local" ? left.result.session.updatedAt : left.result.activityAt;
    const rightActivity = right.kind === "local" ? right.result.session.updatedAt : right.result.activityAt;
    const activity = sort === "activityAsc"
      ? (leftActivity ?? Number.MAX_SAFE_INTEGER) - (rightActivity ?? Number.MAX_SAFE_INTEGER)
      : (rightActivity ?? -1) - (leftActivity ?? -1);
    if (sort !== "relevance") return activity || left.key.localeCompare(right.key);
    const leftTitle = left.kind === "local" ? left.result.titleMatch !== null : left.result.titleMatched;
    const rightTitle = right.kind === "local" ? right.result.titleMatch !== null : right.result.titleMatched;
    const leftScore = left.result.score;
    const rightScore = right.result.score;
    return Number(rightTitle) - Number(leftTitle)
      || rightScore - leftScore
      || activity
      || left.key.localeCompare(right.key);
  }).slice(0, Math.max(0, maximumResults));
}

function federatedSessionSearchKey(profileId: string, sessionId: string): string {
  return `${profileId}\u0000${sessionId}`;
}

function RemoteMachineSearchResults({ options, optionOffset, activeOptionIndex, query, locale, t, onActivate, onActiveOptionChange }: {
  readonly options: readonly RemoteMachineSearchOption[];
  readonly optionOffset: number;
  readonly activeOptionIndex: number;
  readonly query: string;
  readonly locale: string;
  readonly t: Translator;
  readonly onActivate: (option: RemoteMachineSearchOption) => void;
  readonly onActiveOptionChange: (index: number) => void;
}): JSX.Element {
  return <div className="conversation-search-results conversation-search-results--remote">
    {options.map((option, localIndex) => {
      const optionIndex = optionOffset + localIndex;
      if (option.kind === "remoteExpand") {
        return <button
          id={searchOptionId(optionIndex)}
          className={cx("conversation-search-result__more", optionIndex === activeOptionIndex && "is-keyboard-active")}
          type="button"
          role="option"
          aria-selected={optionIndex === activeOptionIndex}
          key={option.key}
          onMouseEnter={() => onActiveOptionChange(optionIndex)}
          onClick={() => onActivate(option)}
        >{t("nav.searchMoreHits", { count: option.hiddenHitCount })}</button>;
      }
      const presenceLabel = machinePresenceText(option.presence, t);
      const sourceLabel = t(option.source === "live" ? "machine.searchLive" : "machine.searchCached");
      const title = option.kind === "remoteMessage" ? option.match.snippet : option.session.name;
      const activityAt = option.kind === "remoteMessage" ? option.match.createdAt : option.session.lastActivityAt;
      const sourceMeta = option.kind === "remoteMessage"
        ? `${t(option.match.role === "user" ? "nav.messageByYou" : "nav.messageByAgent")} · ${option.session.name} · ${option.machineName}`
        : option.session.targetName === undefined
          ? option.machineName
          : `${option.session.targetName} · ${option.machineName}`;
      return <section className="conversation-search-result conversation-search-result--remote" key={option.key} aria-label={`${title} · ${option.machineName}`} role="group">
        <button
          id={searchOptionId(optionIndex)}
          className={cx(option.kind === "remoteMessage" ? "conversation-search-result__hit" : "conversation-search-result__session", optionIndex === activeOptionIndex && "is-keyboard-active")}
          type="button"
          role="option"
          aria-selected={optionIndex === activeOptionIndex}
          onMouseEnter={() => onActiveOptionChange(optionIndex)}
          onClick={() => onActivate(option)}
        >
          {option.kind === "remoteSession" && <Laptop aria-hidden="true" />}
          <span className="conversation-search-result__copy">
            <span className="conversation-search-result__title"><HighlightedText value={title} ranges={conversationSearchHighlightRanges(title, query)} /></span>
            <span className="conversation-search-result__meta">{sourceMeta}{activityAt === undefined ? "" : ` · ${formatRelativeTime(activityAt, locale)}`} · {sourceLabel} · {presenceLabel}</span>
          </span>
          <span className="conversation-search-result__kind">{t(option.kind === "remoteMessage"
            ? "nav.searchMatchContent"
            : option.titleMatched && option.hits.length > 0
              ? "nav.searchMatchBoth"
              : option.titleMatched
                ? "nav.searchMatchTitle"
                : "nav.searchMatchContent")}</span>
        </button>
      </section>;
    })}
  </div>;
}

function SearchResults({ results, query, activeSessionId, activeOptionIndex, expandedSessionIds, profileId, locale, t, onActivate, onActiveOptionChange }: {
  readonly results: ReturnType<typeof projectConversationSearchResults>;
  readonly query: string;
  readonly activeSessionId?: string;
  readonly activeOptionIndex: number;
  readonly expandedSessionIds: ReadonlySet<string>;
  readonly profileId: string;
  readonly locale: string;
  readonly t: Translator;
  readonly onActivate: (option: ConversationSearchOption) => void;
  readonly onActiveOptionChange: (index: number) => void;
}): JSX.Element {
  let optionIndex = 0;
  return (
    <div className="conversation-search-results">
      {results.map((result) => {
        const sessionOption: ConversationSearchOption = { key: `session:${result.session.id}`, kind: "session", result };
        const sessionIndex = optionIndex++;
        const visibleHits = expandedSessionIds.has(federatedSessionSearchKey(profileId, result.session.id)) ? result.hits : result.hits.slice(0, 3);
        const hiddenHitCount = result.hits.length - visibleHits.length;
        const matchKind = result.titleMatch === null ? "content" : result.hits.length === 0 ? "title" : "both";
        return (
          <section className="conversation-search-result" key={result.session.id} aria-label={result.session.name} role="group">
            <button
              id={searchOptionId(sessionIndex)}
              className={cx("conversation-search-result__session", result.session.id === activeSessionId && "is-current", sessionIndex === activeOptionIndex && "is-keyboard-active")}
              type="button"
              role="option"
              aria-selected={sessionIndex === activeOptionIndex}
              onMouseEnter={() => onActiveOptionChange(sessionIndex)}
              onClick={() => onActivate(sessionOption)}
            >
              <MessageSquare aria-hidden="true" />
              <span className="conversation-search-result__copy">
                <span className="conversation-search-result__title"><HighlightedText value={result.session.name} ranges={result.titleMatch?.nameRanges ?? []} /></span>
                <span className="conversation-search-result__meta">{result.target !== undefined && <><HighlightedText value={result.target.name} ranges={result.titleMatch?.targetRanges ?? []} /> · </>}{formatRelativeTime(result.session.updatedAt, locale)}</span>
              </span>
              <span className="conversation-search-result__kind">{t(matchKind === "both" ? "nav.searchMatchBoth" : matchKind === "title" ? "nav.searchMatchTitle" : "nav.searchMatchContent")}</span>
            </button>
            {result.hits.length > 0 && <div className="conversation-search-result__hits">{visibleHits.map((hit) => {
              const hitIndex = optionIndex++;
              const option: ConversationSearchOption = { key: `message:${hit.sessionId}:${hit.eventId}`, kind: "message", result, hit };
              return (
                <button
                  id={searchOptionId(hitIndex)}
                  className={cx("conversation-search-result__hit", hitIndex === activeOptionIndex && "is-keyboard-active")}
                  type="button"
                  role="option"
                  aria-selected={hitIndex === activeOptionIndex}
                  key={hit.eventId}
                  title={hit.snippet}
                  onMouseEnter={() => onActiveOptionChange(hitIndex)}
                  onClick={() => onActivate(option)}
                >
                  <strong><HighlightedText value={hit.snippet} ranges={conversationSearchHighlightRanges(hit.snippet, query)} /></strong>
                  <small>{t(hit.role === "user" ? "nav.messageByYou" : "nav.messageByAgent")} · {formatRelativeTime(hit.createdAt, locale)}</small>
                </button>
              );
            })}{hiddenHitCount > 0 && (() => {
              const expandIndex = optionIndex++;
              const option: ConversationSearchOption = { key: `expand:${result.session.id}`, kind: "expand", result };
              return <button
                id={searchOptionId(expandIndex)}
                className={cx("conversation-search-result__more", expandIndex === activeOptionIndex && "is-keyboard-active")}
                type="button"
                role="option"
                aria-selected={expandIndex === activeOptionIndex}
                onMouseEnter={() => onActiveOptionChange(expandIndex)}
                onClick={() => onActivate(option)}
              >{t("nav.searchMoreHits", { count: hiddenHitCount })}</button>;
            })()}</div>}
          </section>
        );
      })}
    </div>
  );
}

function searchOptionId(index: number): string {
  return `conversation-search-option-${index}`;
}

function sessionCallbacks(
  props: SidebarProps,
  beforeNavigate?: (session: SessionView, modifiers?: SessionSelectionModifiers) => boolean | void,
  selectedSessionIds: ReadonlySet<string> = EMPTY_SESSION_ID_SET
): SessionSectionCallbacks {
  return {
    onSelect: (session, modifiers) => {
      if (beforeNavigate?.(session, modifiers) === false) return;
      props.onNavigate({ kind: "session", sessionId: session.id });
      props.onClose();
    },
    onBrowseFiles: (session) => {
      beforeNavigate?.(session);
      const target = props.snapshot.targets.find((candidate) => candidate.id === session.targetId);
      const remembered = target === undefined ? undefined : workspaceSelectedFileStore.get(target.workspaceId);
      props.onNavigate({
        kind: "files",
        sessionId: session.id,
        ...(remembered === undefined ? {} : { file: remembered })
      });
      props.onClose();
    },
    onRename: props.onRename,
    onPin: props.onPin,
    onArchive: props.onArchive,
    onDelete: props.onDelete,
    onCopyTaskLink: props.onCopyTaskLink ?? (() => undefined),
    onExportPortableSession: props.onExportPortableSession,
    canExportPortableSession: (session) => props.onExportPortableSession !== undefined
      && portableSessionExportSupported(session, props.snapshot),
    onSplitSession: props.onSplitSession ?? (() => undefined),
    onOpenSessionWindow: props.onOpenSessionWindow ?? (() => undefined),
    selectedSessionIds,
    projectMenuTargets: props.snapshot.targets.filter((target) => !target.archived && target.remoteWorkspace === undefined),
    movingSessionProjectIds: props.movingSessionProjectIds ?? EMPTY_SESSION_ID_SET,
    onMoveSessionProject: props.onMoveSessionProject ?? (() => undefined)
  };
}

interface SessionSectionCallbacks {
  readonly onSelect: (session: SessionView, modifiers?: SessionSelectionModifiers) => void;
  readonly onBrowseFiles: (session: SessionView) => void;
  readonly onRename: (session: SessionView, name: string) => void;
  readonly onPin: (session: SessionView) => void;
  readonly onArchive: (session: SessionView) => void;
  readonly onDelete: (session: SessionView) => void;
  readonly onCopyTaskLink: (session: SessionView) => void;
  readonly onExportPortableSession?: (session: SessionView) => void;
  readonly canExportPortableSession: (session: SessionView) => boolean;
  readonly onSplitSession: (session: SessionView, side: "right" | "bottom") => void;
  readonly onOpenSessionWindow: (session: SessionView) => void;
  readonly selectedSessionIds: ReadonlySet<string>;
  readonly projectMenuTargets: readonly TargetView[];
  readonly movingSessionProjectIds: ReadonlySet<string>;
  readonly onMoveSessionProject: (session: SessionView, placement: SessionProjectNavigationPlacement) => void;
}

interface SessionSelectionModifiers {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}

interface SessionPriorityProps {
  readonly priorityContext: SidebarPriorityContext;
}

interface SessionDisplayProps {
  readonly sessionInfoFields: readonly SidebarSessionInfoField[];
  readonly sessionProfileId?: string;
  readonly projectNameFor: (session: SessionView) => string;
  readonly environmentNameFor: (session: SessionView) => string;
}

interface SidebarListContextMenuRequest {
  readonly x: number;
  readonly y: number;
}

type SidebarListMenuAnchor =
  | { readonly kind: "trigger"; readonly right: number; readonly bottom: number }
  | { readonly kind: "point"; readonly x: number; readonly y: number };

type SidebarSettingsSubmenuKind = "filters" | "taskInfo";
type SidebarSettingsFilterMenuKind = "status" | "projects" | "backend" | "lastActivity";

interface SidebarSettingsNestedMenu<TKind extends string> {
  readonly kind: TKind;
  readonly trigger: HTMLButtonElement;
  readonly x: number;
  readonly y: number;
}

function SidebarListSettings({ layout, targets, backends, sessions, activeContentFilterCount, deviceGroupingAvailable, foldAction, contextMenuRequest, t, onContextMenuRequestHandled, onStatusChange, onGroupByChange, onGroupDialogueChange, onGroupDeviceChange, onSortByChange, onProjectOrderChange, onMainViewModeChange, onProjectFilterToggle, onProjectFilterReset, onBackendChange, onLastActivityChange, onResetContentFilters, onToggleAllGroups, onSessionInfoFieldToggle }: {
  readonly layout: SidebarLayout;
  readonly targets: readonly TargetView[];
  readonly backends: AppSnapshot["backends"];
  readonly sessions: readonly SessionView[];
  readonly activeContentFilterCount: number;
  readonly deviceGroupingAvailable: boolean;
  readonly foldAction?: "collapseGroups" | "collapseDevices" | "expandAll";
  readonly contextMenuRequest?: SidebarListContextMenuRequest;
  readonly t: Translator;
  readonly onContextMenuRequestHandled: () => void;
  readonly onStatusChange: (status: SidebarLayout["status"]) => void;
  readonly onGroupByChange: (groupBy: SidebarLayout["groupBy"]) => void;
  readonly onGroupDialogueChange: (groupDialogue: boolean) => void;
  readonly onGroupDeviceChange: (groupDevice: boolean) => void;
  readonly onSortByChange: (sortBy: SidebarLayout["sortBy"]) => void;
  readonly onProjectOrderChange: (projectOrder: SidebarLayout["projectOrder"]) => void;
  readonly onMainViewModeChange: (viewMode: SidebarLayout["mainViewMode"]) => void;
  readonly onProjectFilterToggle: (projectId: string) => void;
  readonly onProjectFilterReset: () => void;
  readonly onBackendChange: (backendId: string) => void;
  readonly onLastActivityChange: (lastActivity: SidebarLayout["lastActivity"]) => void;
  readonly onResetContentFilters: () => void;
  readonly onToggleAllGroups: () => void;
  readonly onSessionInfoFieldToggle: (field: SidebarSessionInfoField) => void;
}): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const focusTargetRef = useRef<"first" | "last">("first");
  const menuId = useId();
  const [menu, setMenu] = useState<{ readonly anchor: SidebarListMenuAnchor; readonly x: number; readonly y: number }>();
  const [submenu, setSubmenu] = useState<SidebarSettingsNestedMenu<SidebarSettingsSubmenuKind>>();
  const [filterMenu, setFilterMenu] = useState<SidebarSettingsNestedMenu<SidebarSettingsFilterMenuKind>>();
  const positionFor = (anchor: SidebarListMenuAnchor, width: number, height: number): { readonly x: number; readonly y: number } | undefined => {
    const ownerWindow = triggerRef.current?.ownerDocument.defaultView;
    return ownerWindow === null || ownerWindow === undefined
      ? undefined
      : sidebarListMenuPosition(anchor, { width, height }, { width: ownerWindow.innerWidth, height: ownerWindow.innerHeight });
  };
  const positionNested = (trigger: HTMLButtonElement, width: number, height: number): { readonly x: number; readonly y: number } | undefined => {
    const ownerWindow = trigger.ownerDocument.defaultView;
    return ownerWindow === null
      ? undefined
      : sidebarSessionSubmenuPosition(trigger.getBoundingClientRect(), { width, height }, { width: ownerWindow.innerWidth, height: ownerWindow.innerHeight });
  };
  const open = (anchor: SidebarListMenuAnchor, focusTarget: "first" | "last" = "first"): void => {
    const ownerWindow = triggerRef.current?.ownerDocument.defaultView;
    if (ownerWindow === null || ownerWindow === undefined) return;
    focusTargetRef.current = focusTarget;
    const position = positionFor(
      anchor,
      Math.min(SIDEBAR_LIST_MENU_WIDTH, Math.max(0, ownerWindow.innerWidth - (SESSION_ACTION_MENU_VIEWPORT_MARGIN * 2))),
      SIDEBAR_LIST_MENU_ESTIMATED_HEIGHT
    );
    if (position !== undefined) setMenu({ anchor, ...position });
  };
  const close = (restoreFocus: boolean): void => {
    setMenu(undefined);
    setSubmenu(undefined);
    setFilterMenu(undefined);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };
  const openSubmenu = (kind: SidebarSettingsSubmenuKind, trigger: HTMLButtonElement): void => {
    const position = positionNested(trigger, 220, kind === "filters" ? 194 : 196);
    if (position === undefined) return;
    setSubmenu({ kind, trigger, ...position });
    setFilterMenu(undefined);
  };
  const openFilterMenu = (kind: SidebarSettingsFilterMenuKind, trigger: HTMLButtonElement): void => {
    const height = kind === "projects" ? 310 : kind === "lastActivity" ? 174 : 112;
    const position = positionNested(trigger, 220, height);
    if (position !== undefined) setFilterMenu({ kind, trigger, ...position });
  };

  useEffect(() => {
    if (contextMenuRequest === undefined) return;
    open({ kind: "point", x: contextMenuRequest.x, y: contextMenuRequest.y });
    onContextMenuRequestHandled();
  }, [contextMenuRequest]);

  useLayoutEffect(() => {
    if (menu === undefined) return;
    const popup = menuRef.current;
    const ownerWindow = triggerRef.current?.ownerDocument.defaultView;
    if (popup === null || ownerWindow === null || ownerWindow === undefined) return;
    const bounds = popup.getBoundingClientRect();
    const clamped = positionFor(menu.anchor, bounds.width, bounds.height);
    if (clamped !== undefined && (clamped.x !== menu.x || clamped.y !== menu.y)) setMenu({ anchor: menu.anchor, ...clamped });
    const frame = ownerWindow.requestAnimationFrame(() => {
      const items = popup.querySelectorAll<HTMLButtonElement>("[role^='menuitem']");
      (focusTargetRef.current === "last" ? items.item(items.length - 1) : items.item(0))?.focus({ preventScroll: true });
    });
    return () => ownerWindow.cancelAnimationFrame(frame);
  }, [menu]);

  useLayoutEffect(() => {
    const popup = filterMenu === undefined ? submenuRef.current : filterMenuRef.current;
    const ownerWindow = popup?.ownerDocument.defaultView;
    if (popup === null || popup === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const frame = ownerWindow.requestAnimationFrame(() => popup.querySelector<HTMLButtonElement>("[role^='menuitem']:not([disabled])")?.focus({ preventScroll: true }));
    return () => ownerWindow.cancelAnimationFrame(frame);
  }, [filterMenu, submenu]);

  useEffect(() => {
    if (menu === undefined) return;
    const trigger = triggerRef.current;
    const ownerDocument = trigger?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (trigger === null || trigger === undefined || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const closeOutside = (event: globalThis.PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && (trigger.contains(target)
        || menuRef.current?.contains(target) === true
        || submenuRef.current?.contains(target) === true
        || filterMenuRef.current?.contains(target) === true)) return;
      close(false);
    };
    const closeForViewportChange = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && (menuRef.current?.contains(target) === true
        || submenuRef.current?.contains(target) === true
        || filterMenuRef.current?.contains(target) === true)) return;
      close(false);
    };
    ownerDocument.addEventListener("pointerdown", closeOutside, true);
    ownerDocument.addEventListener("scroll", closeForViewportChange, true);
    ownerWindow.addEventListener("resize", closeForViewportChange);
    return () => {
      ownerDocument.removeEventListener("pointerdown", closeOutside, true);
      ownerDocument.removeEventListener("scroll", closeForViewportChange, true);
      ownerWindow.removeEventListener("resize", closeForViewportChange);
    };
  }, [menu]);

  const selectAndClose = (action: () => void): void => {
    action();
    close(false);
  };
  const navigateMenu = (event: KeyboardEvent<HTMLDivElement>): boolean => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role^='menuitem']:not([disabled])")];
    const activeIndex = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "ArrowDown"
      ? (activeIndex + 1 + items.length) % items.length
      : event.key === "ArrowUp"
        ? (activeIndex - 1 + items.length) % items.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : undefined;
    if (nextIndex === undefined || items.length === 0) return false;
    event.preventDefault();
    items[nextIndex]?.focus({ preventScroll: true });
    return true;
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      if (event.key === "Escape") event.stopPropagation();
      close(true);
      return;
    }
    navigateMenu(event);
  };
  const onSubmenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Tab") {
      close(false);
      return;
    }
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      const restore = filterMenu?.trigger ?? submenu?.trigger;
      if (filterMenu !== undefined) setFilterMenu(undefined);
      else setSubmenu(undefined);
      restore?.focus({ preventScroll: true });
      return;
    }
    navigateMenu(event);
  };
  const ownerDocument = triggerRef.current?.ownerDocument;
  const filterSummary = activeContentFilterCount === 0
    ? t("nav.filtersNone")
    : t("nav.filtersActive", { count: activeContentFilterCount });
  const statusSummary = t(layout.status === "active"
    ? "nav.searchStatusActive"
    : layout.status === "archived"
      ? "nav.searchStatusArchived"
      : "nav.searchStatusAll");
  const projectSummary = layout.projectFilter === "all"
    ? t("nav.searchProjectsAll")
    : t("nav.searchProjectsSelected", { count: layout.projectFilter.length });
  const backendSummary = layout.backendId === "all"
    ? t("nav.searchAgentAll")
    : backends.find((backend) => backend.id === layout.backendId)?.name ?? layout.backendId;
  const lastActivitySummary = t(layout.lastActivity === "1d"
    ? "nav.searchLastActivity1d"
    : layout.lastActivity === "3d"
      ? "nav.searchLastActivity3d"
      : layout.lastActivity === "7d"
        ? "nav.searchLastActivity7d"
        : layout.lastActivity === "30d"
          ? "nav.searchLastActivity30d"
          : "nav.searchLastActivityAll");
  const taskInfoSummary = layout.sessionInfoFields.length === 0
    ? t("nav.filtersNone")
    : layout.sessionInfoFields.map((field) => t(SIDEBAR_SESSION_INFO_OPTIONS.find((option) => option.value === field)?.label ?? "nav.sessionInfo")).join(" · ");
  const groupingSummary = [
    layout.groupBy === "project" ? t("nav.groupByProject") : undefined,
    deviceGroupingAvailable && layout.groupDevice ? t("nav.groupByDevice") : undefined,
    layout.groupDialogue ? t("nav.groupDialogue") : undefined
  ].filter((value): value is string => value !== undefined).join(", ") || t("nav.groupNone");
  const organizerAria = t("nav.organizeSidebarAria", {
    grouping: groupingSummary,
    sort: t(layout.sortBy === "priority" ? "nav.sortPriority" : "nav.sortRecent"),
    filters: filterSummary,
    display: t(layout.mainViewMode === "text" ? "nav.viewText" : "nav.viewList"),
    info: taskInfoSummary
  });
  return <div className="sidebar-list-scope">
    <span>{t(layout.status === "archived" ? "nav.archived" : layout.status === "all" ? "nav.searchScopeAll" : "nav.searchStatusActive")}{activeContentFilterCount > 0 && <small> · {t("nav.filtersActive", { count: activeContentFilterCount })}</small>}</span>
    <div className="sidebar-list-settings">
      {foldAction !== undefined && <IconButton
        className="sidebar-list-settings__fold"
        label={t(foldAction === "expandAll" ? "nav.expandAllGroups" : foldAction === "collapseDevices" ? "nav.collapseAllDevices" : "nav.collapseAllGroups")}
        onClick={onToggleAllGroups}
      >{foldAction === "expandAll" ? <ChevronsUpDown aria-hidden="true" /> : <ChevronsDownUp aria-hidden="true" />}</IconButton>}
      <IconButton
        buttonRef={triggerRef}
        label={organizerAria}
        tip={t("nav.organizeSidebar")}
        aria-pressed={activeContentFilterCount > 0}
        aria-haspopup="menu"
        aria-expanded={menu !== undefined}
        aria-controls={menu === undefined ? undefined : menuId}
        onClick={() => {
          if (menu !== undefined) close(false);
          else {
            const bounds = triggerRef.current?.getBoundingClientRect();
            if (bounds !== undefined) open({ kind: "trigger", right: bounds.right, bottom: bounds.bottom });
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          open({ kind: "trigger", right: bounds.right, bottom: bounds.bottom }, event.key === "ArrowUp" ? "last" : "first");
        }}
      ><SlidersHorizontal aria-hidden="true" /></IconButton>
      {menu !== undefined && ownerDocument !== undefined && createPortal(<div
        ref={menuRef}
        id={menuId}
        className="sidebar-list-settings__menu"
        role="menu"
        aria-label={t("nav.organizeSidebar")}
        style={{ left: menu.x, top: menu.y }}
        onKeyDown={onMenuKeyDown}
      >
        <strong>{t("nav.grouping")}</strong>
        <button type="button" role="menuitemcheckbox" aria-checked={layout.groupBy === "project"} onClick={() => onGroupByChange(layout.groupBy === "project" ? "flat" : "project")}>
          <span>{t("nav.groupByProject")}</span>{layout.groupBy === "project" && <Check aria-hidden="true" />}
        </button>
        {deviceGroupingAvailable && <button type="button" role="menuitemcheckbox" aria-checked={layout.groupDevice} onClick={() => onGroupDeviceChange(!layout.groupDevice)}>
          <span>{t("nav.groupByDevice")}</span>{layout.groupDevice && <Check aria-hidden="true" />}
        </button>}
        <button type="button" role="menuitemcheckbox" aria-checked={layout.groupDialogue} onClick={() => onGroupDialogueChange(!layout.groupDialogue)}>
          <span>{t("nav.groupDialogue")}</span>{layout.groupDialogue && <Check aria-hidden="true" />}
        </button>
        <hr />
        <strong>{t("nav.taskSort")}</strong>
        <button type="button" role="menuitemradio" aria-checked={layout.sortBy === "recency"} onClick={() => selectAndClose(() => onSortByChange("recency"))}>
          <span>{t("nav.sortRecent")}</span>{layout.sortBy === "recency" && <Check aria-hidden="true" />}
        </button>
        <button type="button" role="menuitemradio" aria-checked={layout.sortBy === "priority"} title={t("nav.sortPriorityHint")} onClick={() => selectAndClose(() => onSortByChange("priority"))}>
          <span>{t("nav.sortPriority")}</span>{layout.sortBy === "priority" && <Check aria-hidden="true" />}
        </button>
        {layout.groupBy === "project" && <>
          <hr />
          <strong>{t("nav.projectOrder")}</strong>
          <button type="button" role="menuitemradio" aria-checked={layout.projectOrder === "activity"} onClick={() => selectAndClose(() => onProjectOrderChange("activity"))}>
            <span>{t("nav.projectOrderActivity")}</span>{layout.projectOrder === "activity" && <Check aria-hidden="true" />}
          </button>
          <button type="button" role="menuitemradio" aria-checked={layout.projectOrder === "custom"} title={t("nav.projectOrderCustomHint")} onClick={() => selectAndClose(() => onProjectOrderChange("custom"))}>
            <span>{t("nav.projectOrderCustom")}</span>{layout.projectOrder === "custom" && <Check aria-hidden="true" />}
          </button>
        </>}
        <hr />
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={submenu?.kind === "filters"} onClick={(event) => openSubmenu("filters", event.currentTarget)} onKeyDown={(event) => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          openSubmenu("filters", event.currentTarget);
        }}>
          <Filter className="sidebar-list-settings__option-icon" aria-hidden="true" />
          <span>{t("nav.filters")}</span>
          <small className={activeContentFilterCount > 0 ? "is-active" : undefined}>{filterSummary}</small>
          <ChevronRight aria-hidden="true" />
        </button>
        <hr />
        <strong>{t("nav.mainDisplay")}</strong>
        {SIDEBAR_MAIN_VIEW_OPTIONS.map(({ value, label, Icon }) => <button type="button" role="menuitemradio" aria-checked={layout.mainViewMode === value} key={value} onClick={() => selectAndClose(() => onMainViewModeChange(value))}>
          <Icon className="sidebar-list-settings__option-icon" aria-hidden="true" /><span>{t(label)}</span>{layout.mainViewMode === value && <Check aria-hidden="true" />}
        </button>)}
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={submenu?.kind === "taskInfo"} onClick={(event) => openSubmenu("taskInfo", event.currentTarget)} onKeyDown={(event) => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          openSubmenu("taskInfo", event.currentTarget);
        }}>
          <Info className="sidebar-list-settings__option-icon" aria-hidden="true" />
          <span>{t("nav.sessionInfo")}</span>
          <small aria-label={taskInfoSummary} className={layout.sessionInfoFields.length === 1 && layout.sessionInfoFields[0] === "time" ? undefined : "is-active"}>
            {layout.sessionInfoFields.length === 0 ? t("nav.filtersNone") : layout.sessionInfoFields.map((field) => {
              const Icon = SIDEBAR_SESSION_INFO_OPTIONS.find((option) => option.value === field)?.Icon;
              return Icon === undefined ? null : <Icon key={field} aria-hidden="true" />;
            })}
          </small>
          <ChevronRight aria-hidden="true" />
        </button>
      </div>, ownerDocument.body)}
      {submenu !== undefined && ownerDocument !== undefined && createPortal(<div
        ref={submenuRef}
        className="sidebar-list-settings__menu sidebar-list-settings__submenu"
        role="menu"
        aria-label={t(submenu.kind === "filters" ? "nav.filters" : "nav.sessionInfo")}
        style={{ left: submenu.x, top: submenu.y }}
        onKeyDown={onSubmenuKeyDown}
      >
        {submenu.kind === "filters" ? <>
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={filterMenu?.kind === "status"} onClick={(event) => openFilterMenu("status", event.currentTarget)} onKeyDown={(event) => {
            if (event.key !== "ArrowRight") return;
            event.preventDefault();
            openFilterMenu("status", event.currentTarget);
          }}>
            <CircleDot className="sidebar-list-settings__option-icon" aria-hidden="true" /><span>{t("nav.searchStatus")}</span><small>{statusSummary}</small><ChevronRight aria-hidden="true" />
          </button>
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={filterMenu?.kind === "projects"} onClick={(event) => openFilterMenu("projects", event.currentTarget)} onKeyDown={(event) => {
            if (event.key !== "ArrowRight") return;
            event.preventDefault();
            openFilterMenu("projects", event.currentTarget);
          }}>
            <FolderOpen className="sidebar-list-settings__option-icon" aria-hidden="true" /><span>{t("nav.searchProjects")}</span><small>{projectSummary}</small><ChevronRight aria-hidden="true" />
          </button>
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={filterMenu?.kind === "backend"} onClick={(event) => openFilterMenu("backend", event.currentTarget)} onKeyDown={(event) => {
            if (event.key !== "ArrowRight") return;
            event.preventDefault();
            openFilterMenu("backend", event.currentTarget);
          }}>
            <Bot className="sidebar-list-settings__option-icon" aria-hidden="true" /><span>{t("nav.searchAgent")}</span><small>{backendSummary}</small><ChevronRight aria-hidden="true" />
          </button>
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={filterMenu?.kind === "lastActivity"} onClick={(event) => openFilterMenu("lastActivity", event.currentTarget)} onKeyDown={(event) => {
            if (event.key !== "ArrowRight") return;
            event.preventDefault();
            openFilterMenu("lastActivity", event.currentTarget);
          }}>
            <CalendarClock className="sidebar-list-settings__option-icon" aria-hidden="true" /><span>{t("nav.searchLastActivity")}</span><small>{lastActivitySummary}</small><ChevronRight aria-hidden="true" />
          </button>
          <hr />
          <button type="button" role="menuitem" disabled={activeContentFilterCount === 0} onClick={onResetContentFilters}><span>{t("nav.searchFilterReset")}</span></button>
        </> : <>
          {SIDEBAR_SESSION_INFO_OPTIONS.map(({ value, label, Icon }) => <button type="button" role="menuitemcheckbox" aria-checked={layout.sessionInfoFields.includes(value)} key={value} onClick={() => onSessionInfoFieldToggle(value)}>
            <Icon className="sidebar-list-settings__option-icon" aria-hidden="true" /><span>{t(label)}</span>{layout.sessionInfoFields.includes(value) && <Check aria-hidden="true" />}
          </button>)}
          <small className="sidebar-list-settings__hint">{t("nav.sessionInfoOrderHint")}</small>
        </>}
      </div>, ownerDocument.body)}
      {filterMenu !== undefined && ownerDocument !== undefined && createPortal(<div
        ref={filterMenuRef}
        className={cx("sidebar-list-settings__menu", "sidebar-list-settings__submenu", filterMenu.kind === "projects" && "sidebar-list-settings__submenu--projects")}
        role="menu"
        aria-label={t(filterMenu.kind === "status"
          ? "nav.searchStatus"
          : filterMenu.kind === "projects"
            ? "nav.searchProjects"
            : filterMenu.kind === "backend"
              ? "nav.searchAgent"
              : "nav.searchLastActivity")}
        style={{ left: filterMenu.x, top: filterMenu.y }}
        onKeyDown={onSubmenuKeyDown}
      >
        {filterMenu.kind === "status" && (["active", "archived", "all"] as const).map((status) => <button type="button" role="menuitemradio" aria-checked={layout.status === status} key={status} onClick={() => onStatusChange(status)}>
          <span>{t(status === "active" ? "nav.searchStatusActive" : status === "archived" ? "nav.searchStatusArchived" : "nav.searchStatusAll")}</span>{layout.status === status && <Check aria-hidden="true" />}
        </button>)}
        {filterMenu.kind === "projects" && <>
          <button type="button" role="menuitemcheckbox" aria-checked={layout.projectFilter === "all"} onClick={onProjectFilterReset}><span>{t("nav.searchProjectsAll")}</span>{layout.projectFilter === "all" && <Check aria-hidden="true" />}</button>
          <hr />
          <button type="button" role="menuitemcheckbox" aria-checked={layout.projectFilter === "all" || layout.projectFilter.includes(SIDEBAR_DIALOGUE_FILTER_ID)} onClick={() => onProjectFilterToggle(SIDEBAR_DIALOGUE_FILTER_ID)}>
            <span>{t("nav.dialogue")}</span><small>{sessions.filter((session) => session.projectId === undefined).length}</small>{(layout.projectFilter === "all" || layout.projectFilter.includes(SIDEBAR_DIALOGUE_FILTER_ID)) && <Check aria-hidden="true" />}
          </button>
          {targets.map((target) => <button type="button" role="menuitemcheckbox" aria-checked={layout.projectFilter === "all" || layout.projectFilter.includes(target.id)} key={target.id} onClick={() => onProjectFilterToggle(target.id)}>
            <span>{target.name}</span><small>{sessions.filter((session) => session.projectId === target.id).length}</small>{(layout.projectFilter === "all" || layout.projectFilter.includes(target.id)) && <Check aria-hidden="true" />}
          </button>)}
        </>}
        {filterMenu.kind === "backend" && <>
          <button type="button" role="menuitemradio" aria-checked={layout.backendId === "all"} onClick={() => onBackendChange("all")}><span>{t("nav.searchAgentAll")}</span>{layout.backendId === "all" && <Check aria-hidden="true" />}</button>
          {backends.map((backend) => <button type="button" role="menuitemradio" aria-checked={layout.backendId === backend.id} key={backend.id} onClick={() => onBackendChange(backend.id)}><span>{backend.name}</span>{layout.backendId === backend.id && <Check aria-hidden="true" />}</button>)}
        </>}
        {filterMenu.kind === "lastActivity" && (["1d", "3d", "7d", "30d", "all"] as const).map((lastActivity) => <button type="button" role="menuitemradio" aria-checked={layout.lastActivity === lastActivity} key={lastActivity} onClick={() => onLastActivityChange(lastActivity)}>
          <span>{t(lastActivity === "1d" ? "nav.searchLastActivity1d" : lastActivity === "3d" ? "nav.searchLastActivity3d" : lastActivity === "7d" ? "nav.searchLastActivity7d" : lastActivity === "30d" ? "nav.searchLastActivity30d" : "nav.searchLastActivityAll")}</span>{layout.lastActivity === lastActivity && <Check aria-hidden="true" />}
        </button>)}
      </div>, ownerDocument.body)}
    </div>
  </div>;
}

function PinnedSessionSection({
  viewMode,
  title,
  entries,
  targets,
  activeSessionId,
  locale,
  t,
  onReorder,
  onViewModeChange,
  projectActions,
  workspacePathFor,
  remotePresenceByProfile,
  onOpenRemote,
  collapsedTargets,
  onToggleTarget,
  browsableTargetIds,
  reducedMotion,
  priorityContext,
  automationSchedules,
  scheduleGroupOwnerId,
  scheduleGroupFoldIntent,
  onScheduleGroupExpansionChange,
  onOpenSchedule,
  onRunSchedule,
  onToggleSchedule,
  onDeleteSchedule,
  ...callbacks
}: {
  readonly viewMode: SidebarLayout["pinnedViewMode"];
  readonly title: string;
  readonly entries: readonly SidebarPinnedEntry[];
  readonly targets: readonly TargetView[];
  readonly activeSessionId?: string;
  readonly locale: string;
  readonly t: Translator;
  readonly onReorder: (ids: readonly string[]) => void;
  readonly onViewModeChange: (viewMode: SidebarLayout["pinnedViewMode"]) => void;
  readonly projectActions: SidebarProjectActions;
  readonly workspacePathFor: (target: TargetView) => string;
  readonly remotePresenceByProfile: Readonly<Record<string, MachinePresenceView>>;
  readonly onOpenRemote: (profileId: string, sessionId: string) => void;
  readonly collapsedTargets: ReadonlySet<string>;
  readonly onToggleTarget: (id: string) => void;
  readonly browsableTargetIds: ReadonlySet<string>;
  readonly reducedMotion: boolean;
} & SessionSectionCallbacks & SessionPriorityProps & SessionDisplayProps & ScheduleGroupPresentationProps): JSX.Element {
  const targetNames = new Map(targets.map((target) => [target.id, target.name]));
  const [collapsed, setCollapsed] = useState(false);
  const [viewMenu, setViewMenu] = useState<{ readonly x: number; readonly y: number }>();
  const viewTriggerRef = useRef<HTMLButtonElement>(null);
  const viewMenuRef = useRef<HTMLDivElement>(null);
  const viewMenuFocusTargetRef = useRef<"first" | "last">("first");
  const ViewIcon = SIDEBAR_PINNED_VIEW_OPTIONS.find((option) => option.value === viewMode)?.Icon ?? AlignJustify;
  useEffect(() => {
    if (viewMenu === undefined) return;
    const ownerDocument = viewTriggerRef.current?.ownerDocument;
    if (ownerDocument === undefined) return;
    const closeOutside = (event: globalThis.PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && (viewTriggerRef.current?.contains(target) === true || viewMenuRef.current?.contains(target) === true)) return;
      setViewMenu(undefined);
    };
    ownerDocument.addEventListener("pointerdown", closeOutside, true);
    return () => ownerDocument.removeEventListener("pointerdown", closeOutside, true);
  }, [viewMenu]);
  useLayoutEffect(() => {
    if (viewMenu === undefined) return;
    const popup = viewMenuRef.current;
    const ownerWindow = popup?.ownerDocument.defaultView;
    if (popup === null || popup === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const frame = ownerWindow.requestAnimationFrame(() => {
      const items = popup.querySelectorAll<HTMLButtonElement>("[role^='menuitem']");
      (viewMenuFocusTargetRef.current === "last" ? items.item(items.length - 1) : items.item(0))?.focus({ preventScroll: true });
    });
    return () => ownerWindow.cancelAnimationFrame(frame);
  }, [viewMenu]);
  const openViewMenu = (focusTarget: "first" | "last" = "first"): void => {
    const trigger = viewTriggerRef.current;
    const ownerWindow = trigger?.ownerDocument.defaultView;
    if (trigger === null || trigger === undefined || ownerWindow === null || ownerWindow === undefined) return;
    viewMenuFocusTargetRef.current = focusTarget;
    setViewMenu(sidebarListMenuPosition(
      { kind: "trigger", right: trigger.getBoundingClientRect().right, bottom: trigger.getBoundingClientRect().bottom },
      { width: 168, height: 112 },
      { width: ownerWindow.innerWidth, height: ownerWindow.innerHeight }
    ));
  };
  const renderEntry = (entry: SidebarPinnedEntry): JSX.Element => {
    if (entry.kind === "session") {
      const { session } = entry;
      return <SessionRow
        session={session}
        active={session.id === activeSessionId}
        locale={locale}
        targetName={session.projectId === undefined ? t("nav.dialogue") : targetNames.get(session.projectId)}
        t={t}
        priorityContext={priorityContext}
        {...callbacks}
      />;
    }
    if (entry.kind === "remoteSession") {
      return <RemoteMachineSessionRow
        cache={entry.cache}
        session={entry.session}
        presence={remotePresenceByProfile[entry.cache.profileId] ?? "offline"}
        locale={locale}
        t={t}
        onOpen={onOpenRemote}
      />;
    }
    const { target, sessions: targetSessions } = entry;
    const allTargetSessions = projectActions.allSessions.filter((session) => session.projectId === target.id);
    const projectCollapsed = collapsedTargets.has(target.id);
    const groupIndicatorState = sidebarGroupIndicatorState(targetSessions, priorityContext);
    const browsableSession = allTargetSessions.find((session) => session.targetId === target.id && session.id === activeSessionId)
      ?? allTargetSessions.find((session) => session.targetId === target.id);
    return <div className="pinned-project-entry">
      <div className="project-group">
        <ProjectGroupHeading
          target={target}
          sessions={allTargetSessions}
          displayedSessionCount={targetSessions.length}
          collapsed={projectCollapsed}
          indicator={groupIndicatorState}
          browsableSession={browsableSession !== undefined && browsableTargetIds.has(target.id) ? browsableSession : undefined}
          workspacePath={workspacePathFor(target)}
          t={t}
          onToggle={() => onToggleTarget(target.id)}
          onBrowseFiles={callbacks.onBrowseFiles}
          actions={projectActions}
        />
        <CollapsibleSessionRows
          sessions={targetSessions}
          activeSessionId={activeSessionId}
          locale={locale}
          collapsed={projectCollapsed}
          noDrag
          t={t}
          priorityContext={priorityContext}
          automationSchedules={automationSchedules}
          scheduleGroupOwnerId={`${scheduleGroupOwnerId}:${target.id}`}
          scheduleGroupFoldIntent={scheduleGroupFoldIntent}
          onScheduleGroupExpansionChange={onScheduleGroupExpansionChange}
          onOpenSchedule={onOpenSchedule}
          onRunSchedule={onRunSchedule}
          onToggleSchedule={onToggleSchedule}
          onDeleteSchedule={onDeleteSchedule}
          {...callbacks}
        />
      </div>
    </div>;
  };
  return <section className={cx("session-section", "session-section--pinned", `sidebar-view--${viewMode}`)} aria-label={title}>
    <h2 className="session-section__interactive-heading">
      <button type="button" className="session-section__heading-label" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>{title}</button>
      <span className="session-section__heading-actions">
        <IconButton className="session-section__heading-action" label={t(collapsed ? "nav.expandPinned" : "nav.collapsePinned")} aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </IconButton>
        <IconButton buttonRef={viewTriggerRef} className="session-section__heading-action" label={t("nav.pinnedDisplay")} aria-haspopup="menu" aria-expanded={viewMenu !== undefined} onClick={() => viewMenu === undefined ? openViewMenu() : setViewMenu(undefined)} onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          openViewMenu(event.key === "ArrowUp" ? "last" : "first");
        }}>
          <ViewIcon aria-hidden="true" />
        </IconButton>
      </span>
    </h2>
    {!collapsed && <SortableList
        items={entries}
        getId={(entry) => entry.id}
        onReorder={onReorder}
        renderItem={renderEntry}
        reducedMotion={reducedMotion}
        filter=".session-menu, [data-no-drag]"
        className="session-section__sortable-sessions"
        role="list"
        ariaLabel={title}
      />}
    {viewMenu !== undefined && viewTriggerRef.current !== null && createPortal(<div
      ref={viewMenuRef}
      className="sidebar-list-settings__menu sidebar-list-settings__menu--compact"
      role="menu"
      aria-label={t("nav.pinnedDisplay")}
      style={{ left: viewMenu.x, top: viewMenu.y }}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") event.preventDefault();
          setViewMenu(undefined);
          if (event.key === "Escape") viewTriggerRef.current?.focus({ preventScroll: true });
          return;
        }
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role^='menuitem']")];
        const activeIndex = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
        const nextIndex = event.key === "ArrowDown"
          ? (activeIndex + 1 + items.length) % items.length
          : event.key === "ArrowUp"
            ? (activeIndex - 1 + items.length) % items.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : undefined;
        if (nextIndex === undefined || items.length === 0) return;
        event.preventDefault();
        items[nextIndex]?.focus({ preventScroll: true });
      }}
    >
      {SIDEBAR_PINNED_VIEW_OPTIONS.map(({ value, label, Icon }) => <button type="button" role="menuitemradio" aria-checked={viewMode === value} key={value} onClick={() => {
        onViewModeChange(value);
        setViewMenu(undefined);
      }}>
        <Icon className="sidebar-list-settings__option-icon" aria-hidden="true" /><span>{t(label)}</span>{viewMode === value && <Check aria-hidden="true" />}
      </button>)}
    </div>, viewTriggerRef.current.ownerDocument.body)}
  </section>;
}

function SidebarDeviceSection({ profileId, name, presence, collapsed, t, onToggle, children }: {
  readonly profileId: string;
  readonly name: string;
  readonly presence: MachinePresenceView;
  readonly collapsed: boolean;
  readonly t: Translator;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  const presenceLabel = machinePresenceText(presence, t);
  return <section className="sidebar-device-section" data-machine-profile={profileId} aria-label={name}>
    <button type="button" className="sidebar-device-section__header" aria-expanded={!collapsed} aria-label={t(collapsed ? "nav.expandDeviceTasks" : "nav.collapseDeviceTasks", { name })} onClick={onToggle}>
      {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
      <Laptop aria-hidden="true" />
      <span>{name}</span>
      {presence !== "current" && presence !== "online" && <><i aria-hidden="true" /><small>{presenceLabel}</small></>}
    </button>
    {!collapsed && <div className="sidebar-device-section__content">{children}</div>}
  </section>;
}

function RemoteMachineSessionRow({ cache, session, presence, locale, t, onOpen }: {
  readonly cache: MachineCacheView;
  readonly session: MachineSessionCacheView;
  readonly presence: MachinePresenceView;
  readonly locale: string;
  readonly t: Translator;
  readonly onOpen: (profileId: string, sessionId: string) => void;
}): JSX.Element {
  const presenceLabel = machinePresenceText(presence, t);
  const stateLabel = sessionStateLabel(session.state, t);
  const cachedStatus = remoteCachedStatus(session);
  return <li className="session-row session-row--remote" data-sidebar-session-row="true">
    <button
      className="session-row__main"
      type="button"
      data-session-id={session.id}
      data-machine-profile={cache.profileId}
      title={`${session.name} · ${cache.name} · ${stateLabel} · ${formatRelativeTime(session.lastActivityAt, locale)}`}
      onClick={() => onOpen(cache.profileId, session.id)}
    >
      <MessageSquare className="session-row__agent" aria-hidden="true" />
      <span className="session-row__copy"><SidebarTitleMarquee title={session.name}>{session.name}</SidebarTitleMarquee><small>{session.targetName ?? cache.name} · {stateLabel}</small></span>
      {session.pinned && <Pin className="session-row__pin" aria-label={t("session.pin")} />}
      <span className="session-row__right-slot">{cachedStatus === undefined ? <span
        className={cx("remote-machine-session__presence", presence !== "online" && "is-offline")}
        role="img"
        aria-label={`${cache.name}: ${presenceLabel}`}
      /> : <SidebarRightStatusIndicator status={cachedStatus} active={false} t={t} />}</span>
    </button>
  </li>;
}

function RemoteMachineSessionSections({ caches, presenceByProfile, status, grouped, collapsedProfileIds, contentFiltersActive, lastActivity, locale, t, onToggleProfile, onOpen }: {
  readonly caches: readonly MachineCacheView[];
  readonly presenceByProfile: Readonly<Record<string, MachinePresenceView>>;
  readonly status: SidebarLayout["status"];
  readonly grouped: boolean;
  readonly collapsedProfileIds: ReadonlySet<string>;
  readonly contentFiltersActive: boolean;
  readonly lastActivity: SidebarLayout["lastActivity"];
  readonly locale: string;
  readonly t: Translator;
  readonly onToggleProfile: (profileId: string) => void;
  readonly onOpen: (profileId: string, sessionId: string) => void;
}): JSX.Element {
  const cutoff = sidebarLastActivityCutoff(lastActivity, Date.now());
  const entries = caches.flatMap((cache) => cache.sessions
    .filter((session) => !session.pinned && remoteSessionMatchesSidebarStatus(session, status)
      && !contentFiltersActive
      && (cutoff === undefined || session.lastActivityAt >= cutoff))
    .map((session) => ({ cache, session })));
  const sorted = (values: typeof entries): typeof entries => [...values].sort((left, right) =>
    right.session.lastActivityAt - left.session.lastActivityAt
    || left.session.name.localeCompare(right.session.name));
  const renderRows = (values: typeof entries): JSX.Element => <ul>{sorted(values).map(({ cache, session }) => <RemoteMachineSessionRow
    cache={cache}
    session={session}
    presence={presenceByProfile[cache.profileId] ?? "offline"}
    locale={locale}
    t={t}
    onOpen={onOpen}
    key={`${cache.profileId}:${session.id}`}
  />)}</ul>;
  if (!grouped) return <div className="remote-machine-session-sections">
    {entries.length > 0 && <section className="session-section session-section--remote" aria-label={t("nav.remoteTasks")}>
      <h2><span>{t("nav.remoteTasks")}</span></h2>
      {renderRows(entries)}
    </section>}
  </div>;
  return <div className="remote-machine-session-sections">{caches.map((cache) => {
    const values = entries.filter((entry) => entry.cache.profileId === cache.profileId);
    if (values.length === 0) return null;
    return <SidebarDeviceSection
      profileId={cache.profileId}
      name={cache.name}
      presence={presenceByProfile[cache.profileId] ?? "offline"}
      collapsed={collapsedProfileIds.has(cache.profileId)}
      t={t}
      onToggle={() => onToggleProfile(cache.profileId)}
      key={cache.profileId}
    >{renderRows(values)}</SidebarDeviceSection>;
  })}</div>;
}

interface ScheduleGroupPresentationProps {
  readonly automationSchedules: readonly ScheduleView[];
  readonly scheduleGroupOwnerId: string;
  readonly scheduleGroupFoldIntent?: { readonly revision: number; readonly collapsed: boolean };
  readonly onScheduleGroupExpansionChange: () => void;
  readonly onOpenSchedule: (schedule: ScheduleView) => void;
  readonly onRunSchedule?: (schedule: ScheduleView) => Promise<void>;
  readonly onToggleSchedule?: (schedule: ScheduleView) => Promise<void>;
  readonly onDeleteSchedule: (schedule: ScheduleView) => void;
}

function SessionCollectionSection({ groupBy, groupDialogue, ...props }: {
  readonly groupBy: SidebarLayout["groupBy"];
  readonly groupDialogue: boolean;
  readonly projectOrder: SidebarLayout["projectOrder"];
  readonly onReorderTargets: (ids: readonly string[]) => void;
  readonly reducedMotion: boolean;
  readonly title: string;
  readonly sessions: readonly SessionView[];
  readonly targets: readonly TargetView[];
  readonly activeSessionId?: string;
  readonly locale: string;
  readonly collapsedTargets: ReadonlySet<string>;
  readonly collapsedDialogue: boolean;
  readonly browsableTargetIds: ReadonlySet<string>;
  readonly t: Translator;
  readonly onToggleTarget: (id: string) => void;
  readonly onToggleDialogue: () => void;
  readonly projectActions: SidebarProjectActions;
  readonly workspacePathFor: (target: TargetView) => string;
} & SessionSectionCallbacks & SessionPriorityProps & SessionDisplayProps & ScheduleGroupPresentationProps): JSX.Element {
  const { projectActions, workspacePathFor, ...sectionProps } = props;
  if (groupBy === "flat") return <FlatSessionSection {...sectionProps} />;
  return <SessionSection groupDialogue={groupDialogue} projectActions={projectActions} workspacePathFor={workspacePathFor} {...sectionProps} />;
}

function FlatSessionSection({ title, sessions, targets, activeSessionId, locale, t, priorityContext, ...callbacks }: {
  readonly title: string;
  readonly sessions: readonly SessionView[];
  readonly targets: readonly TargetView[];
  readonly activeSessionId?: string;
  readonly locale: string;
  readonly t: Translator;
} & SessionSectionCallbacks & SessionPriorityProps & SessionDisplayProps & ScheduleGroupPresentationProps): JSX.Element {
  const targetNames = new Map(targets.map((target) => [target.id, target.name]));
  return <section className="session-section session-section--flat" aria-label={title}>
    <h2>{title}</h2>
    <CollapsibleSessionRows
      sessions={sessions}
      activeSessionId={activeSessionId}
      locale={locale}
      targetNameFor={(session) => session.projectId === undefined ? t("nav.dialogue") : targetNames.get(session.projectId)}
      t={t}
      priorityContext={priorityContext}
      {...callbacks}
    />
  </section>;
}

function CollapsibleSessionRows({ sessions, activeSessionId, locale, targetNameFor, collapsed = false, noDrag = false, t, priorityContext, automationSchedules, scheduleGroupOwnerId, scheduleGroupFoldIntent, onScheduleGroupExpansionChange, onOpenSchedule, onRunSchedule, onToggleSchedule, onDeleteSchedule, ...callbacks }: {
  readonly sessions: readonly SessionView[];
  readonly activeSessionId?: string;
  readonly locale: string;
  readonly targetNameFor?: (session: SessionView) => string | undefined;
  readonly collapsed?: boolean;
  readonly noDrag?: boolean;
  readonly t: Translator;
} & SessionSectionCallbacks & SessionPriorityProps & SessionDisplayProps & ScheduleGroupPresentationProps): JSX.Element | null {
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (collapsed) setShowAll(false);
  }, [collapsed]);
  if (collapsed) return null;

  const entries = groupSidebarScheduleSessions(sessions, automationSchedules);
  const view = sidebarSessionListView({
    items: entries,
    showAll,
    isCurrent: (entry) => sidebarScheduleEntrySessions(entry).some((session) => session.id === activeSessionId),
    hasAttention: (entry) => sidebarScheduleEntrySessions(entry).some((session) => visibleSidebarAttention(session, priorityContext) !== undefined),
    activityAt: sidebarScheduleEntryActivityAt,
    nowMs: Date.now()
  });
  return <>
    <SidebarSessionEntryList
      entries={view.visibleItems}
      noDrag={noDrag}
      activeSessionId={activeSessionId}
      locale={locale}
      targetNameFor={targetNameFor}
      t={t}
      priorityContext={priorityContext}
      scheduleGroupOwnerId={scheduleGroupOwnerId}
      scheduleGroupFoldIntent={scheduleGroupFoldIntent}
      onScheduleGroupExpansionChange={onScheduleGroupExpansionChange}
      onOpenSchedule={onOpenSchedule}
      onRunSchedule={onRunSchedule}
      onToggleSchedule={onToggleSchedule}
      onDeleteSchedule={onDeleteSchedule}
      {...callbacks}
    />
    {view.overflowing && <button
      type="button"
      className="session-list-show-all"
      onClick={() => setShowAll(true)}
    >{t("nav.showAllTasks", { count: view.totalCount })}</button>}
  </>;
}

function SidebarSessionEntryList({ entries, noDrag, activeSessionId, locale, targetNameFor, t, priorityContext, scheduleGroupOwnerId, scheduleGroupFoldIntent, onScheduleGroupExpansionChange, onOpenSchedule, onRunSchedule, onToggleSchedule, onDeleteSchedule, ...callbacks }: {
  readonly entries: readonly SidebarScheduleSessionEntry[];
  readonly noDrag: boolean;
  readonly activeSessionId?: string;
  readonly locale: string;
  readonly targetNameFor?: (session: SessionView) => string | undefined;
  readonly t: Translator;
} & SessionSectionCallbacks & SessionPriorityProps & SessionDisplayProps & Omit<ScheduleGroupPresentationProps, "automationSchedules">): JSX.Element {
  const renderEntry = (entry: SidebarScheduleSessionEntry): JSX.Element => entry.kind === "session"
    ? <SessionRow
        key={entry.session.id}
        session={entry.session}
        active={entry.session.id === activeSessionId}
        locale={locale}
        targetName={targetNameFor?.(entry.session)}
        t={t}
        priorityContext={priorityContext}
        {...callbacks}
      />
    : <ScheduleSessionGroupRow
        key={`${scheduleGroupOwnerId}:${entry.group.key}`}
        group={entry.group}
        ownerId={scheduleGroupOwnerId}
        activeSessionId={activeSessionId}
        locale={locale}
        targetNameFor={targetNameFor}
        t={t}
        priorityContext={priorityContext}
        foldIntent={scheduleGroupFoldIntent}
        onExpansionChange={onScheduleGroupExpansionChange}
        onOpenSchedule={onOpenSchedule}
        onRunSchedule={onRunSchedule}
        onToggleSchedule={onToggleSchedule}
        onDeleteSchedule={onDeleteSchedule}
        {...callbacks}
      />;
  return <ul className="sidebar-session-entry-list" data-no-drag={noDrag ? "" : undefined}>{entries.map((entry, index) => <Fragment key={sidebarEntryKey(entry, index)}>{renderEntry(entry)}</Fragment>)}</ul>;
}

function ScheduleSessionGroupRow({ group, ownerId, activeSessionId, locale, targetNameFor, t, priorityContext, foldIntent, onExpansionChange, onOpenSchedule, onRunSchedule, onToggleSchedule, onDeleteSchedule, ...callbacks }: {
  readonly group: SidebarScheduleSessionGroup;
  readonly ownerId: string;
  readonly activeSessionId?: string;
  readonly locale: string;
  readonly targetNameFor?: (session: SessionView) => string | undefined;
  readonly t: Translator;
  readonly foldIntent?: { readonly revision: number; readonly collapsed: boolean };
  readonly onExpansionChange: () => void;
  readonly onOpenSchedule: (schedule: ScheduleView) => void;
  readonly onRunSchedule?: (schedule: ScheduleView) => Promise<void>;
  readonly onToggleSchedule?: (schedule: ScheduleView) => Promise<void>;
  readonly onDeleteSchedule: (schedule: ScheduleView) => void;
} & SessionSectionCallbacks & SessionPriorityProps & SessionDisplayProps): JSX.Element {
  const [expanded, setExpanded] = useState(() => readExpandedScheduleGroups(ownerId).has(group.key));
  const [showAll, setShowAll] = useState(false);
  const [runPending, setRunPending] = useState(false);
  const appliedFoldRevisionRef = useRef<number | undefined>(undefined);
  const previousShowAllRef = useRef(false);
  const showAllAnchorRef = useRef<{
    readonly originActiveSessionId: string | null;
    hasFocusedGroup: boolean;
  } | null>(null);
  const collapsed = !expanded;
  useEffect(() => {
    if (foldIntent === undefined || appliedFoldRevisionRef.current === foldIntent.revision) return;
    appliedFoldRevisionRef.current = foldIntent.revision;
    const nextExpanded = !foldIntent.collapsed;
    setExpanded(nextExpanded);
    writeExpandedScheduleGroup(ownerId, group.key, nextExpanded);
    onExpansionChange();
  }, [foldIntent, group.key, onExpansionChange, ownerId]);
  useLayoutEffect(() => {
    if (collapsed) setShowAll(false);
  }, [collapsed]);
  const latest = group.sessions.reduce<SessionView | undefined>((current, session) => current === undefined || session.updatedAt > current.updatedAt ? session : current, undefined);
  const activeInGroup = activeSessionId !== undefined && group.sessions.some((session) => session.id === activeSessionId);
  useEffect(() => {
    if (showAll && !previousShowAllRef.current) {
      showAllAnchorRef.current = {
        originActiveSessionId: activeSessionId ?? null,
        hasFocusedGroup: false
      };
    } else if (!showAll) {
      showAllAnchorRef.current = null;
    }
    previousShowAllRef.current = showAll;

    const anchor = showAllAnchorRef.current;
    if (!showAll || anchor === null) return;
    if (activeInGroup) {
      anchor.hasFocusedGroup = true;
      return;
    }
    if (anchor.hasFocusedGroup || (activeSessionId ?? null) !== anchor.originActiveSessionId) {
      setShowAll(false);
      showAllAnchorRef.current = null;
    }
  }, [activeInGroup, activeSessionId, showAll]);
  const indicator = collapsed
    ? sidebarGroupIndicatorState(group.sessions, priorityContext)
    : latest === undefined ? undefined : sidebarSessionIndicatorState(latest, priorityContext);
  const status = scheduleDisplayStatus(group.schedule);
  const attentionSessions = group.sessions.filter((session) => sidebarSessionIndicatorState(session, priorityContext) === "error");
  const expandedView = sidebarSessionListView({
    items: group.sessions,
    showAll,
    isCurrent: (session) => session.id === activeSessionId,
    hasAttention: (session) => sidebarSessionIndicatorState(session, priorityContext) !== undefined,
    activityAt: (session) => session.updatedAt,
    nowMs: Date.now()
  });
  const childSessions = collapsed ? (showAll ? attentionSessions : attentionSessions.slice(0, 5)) : expandedView.visibleItems;
  const overflowing = collapsed ? attentionSessions.length > childSessions.length : expandedView.overflowing;
  const totalCount = collapsed ? attentionSessions.length : expandedView.totalCount;
  const activeHidden = activeInGroup && !childSessions.some((session) => session.id === activeSessionId);
  const toggleExpanded = (): void => {
    const next = !expanded;
    setExpanded(next);
    writeExpandedScheduleGroup(ownerId, group.key, next);
    onExpansionChange();
  };
  const runNow = (): void => {
    if (runPending || onRunSchedule === undefined) return;
    setRunPending(true);
    void onRunSchedule(group.schedule).catch(() => undefined).finally(() => setRunPending(false));
  };
  return <li data-schedule-group-id={group.schedule.id} className={cx("schedule-session-group", activeHidden && "is-active")}>
    <div className="schedule-session-group__row">
      <IconButton className="schedule-session-group__toggle" label={t(expanded ? "nav.collapseScheduleRuns" : "nav.expandScheduleRuns", { name: group.schedule.name })} aria-expanded={expanded} onClick={toggleExpanded}>
        {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
      </IconButton>
      <IconButton className="schedule-session-group__schedule" label={t("nav.openSchedule", { name: group.schedule.name })} onClick={() => onOpenSchedule(group.schedule)}>
        <CalendarClock aria-hidden="true" />
        {(status === "paused" || status === "expired") && <Pause className="schedule-session-group__paused" aria-hidden="true" />}
        {group.schedule.unreadRunCount > 0 && <span className="schedule-session-group__unread" aria-label={t("scheduler.unreadRunCount", { count: group.schedule.unreadRunCount })}>{group.schedule.unreadRunCount}</span>}
      </IconButton>
      <button type="button" className="schedule-session-group__main" disabled={latest === undefined} onClick={() => { if (latest !== undefined) callbacks.onSelect(latest); }}>
        <span><strong>{group.schedule.name}</strong><small>{t("nav.scheduleRunCount", { count: group.sessions.length })}</small></span>
      </button>
      <span className="schedule-session-group__status">{indicator === undefined
        ? <span>{latest === undefined ? "" : formatRelativeTime(latest.updatedAt, locale)}</span>
        : <SidebarRightStatusIndicator status={indicator} active={activeHidden} t={t} />}
      </span>
      {onRunSchedule !== undefined && <IconButton className="schedule-session-group__run" disabled={runPending} disabledReason={runPending ? t("common.working") : undefined} label={t("scheduler.runNow")} onClick={runNow}>{runPending ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}</IconButton>}
      <ScheduleSessionGroupMenu
        schedule={group.schedule}
        t={t}
        onEdit={() => onOpenSchedule(group.schedule)}
        onToggle={onToggleSchedule === undefined || status === "expired" ? undefined : () => onToggleSchedule(group.schedule)}
        onDelete={() => onDeleteSchedule(group.schedule)}
      />
    </div>
    {childSessions.length > 0 && <div className="schedule-session-group__children">
      <SidebarPlainSessionList sessions={childSessions} activeSessionId={activeSessionId} locale={locale} targetNameFor={targetNameFor} t={t} priorityContext={priorityContext} {...callbacks} />
      {overflowing && <button type="button" className="session-list-show-all" onClick={() => setShowAll(true)}>{t("nav.showAllTasks", { count: totalCount })}</button>}
    </div>}
  </li>;
}

function SidebarPlainSessionList({ sessions, activeSessionId, locale, targetNameFor, t, priorityContext, ...callbacks }: {
  readonly sessions: readonly SessionView[];
  readonly activeSessionId?: string;
  readonly locale: string;
  readonly targetNameFor?: (session: SessionView) => string | undefined;
  readonly t: Translator;
} & SessionSectionCallbacks & SessionPriorityProps & SessionDisplayProps): JSX.Element {
  const renderSession = (session: SessionView): JSX.Element => <SessionRow
    key={session.id}
    session={session}
    active={session.id === activeSessionId}
    locale={locale}
    targetName={targetNameFor?.(session)}
    t={t}
    priorityContext={priorityContext}
    {...callbacks}
  />;
  return <ul>{sessions.map((session) => renderSession(session))}</ul>;
}

function ScheduleSessionGroupMenu({ schedule, t, onEdit, onToggle, onDelete }: {
  readonly schedule: ScheduleView;
  readonly t: Translator;
  readonly onEdit: () => void;
  readonly onToggle?: () => Promise<void>;
  readonly onDelete: () => void;
}): JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = (): void => { if (detailsRef.current !== null) detailsRef.current.open = false; };
  const run = (action: () => void | Promise<void>): void => {
    close();
    void Promise.resolve(action()).catch(() => undefined);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      detailsRef.current?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
      return;
    }
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const current = items.indexOf(event.target as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") next = items[(current + 1 + items.length) % items.length];
    else if (event.key === "ArrowUp") next = items[(current - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    if (next === undefined) return;
    event.preventDefault();
    next.focus({ preventScroll: true });
  };
  return <details ref={detailsRef} className="schedule-session-group__menu" onToggle={(event) => {
    if (!event.currentTarget.open) return;
    event.currentTarget.ownerDocument.defaultView?.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true }));
  }}>
    <TipSummary label={`${t("common.more")} · ${schedule.name}`}><Ellipsis aria-hidden="true" /></TipSummary>
    <div ref={menuRef} role="menu" onKeyDown={onKeyDown}>
      <button type="button" role="menuitem" onClick={() => run(onEdit)}>{t("scheduler.edit")}</button>
      {onToggle !== undefined && <button type="button" role="menuitem" onClick={() => run(onToggle)}>{schedule.enabled ? t("common.disable") : t("common.enable")}</button>}
      <button type="button" role="menuitem" className="danger-text" onClick={() => run(onDelete)}>{t("common.delete")}</button>
    </div>
  </details>;
}

function sidebarEntryKey(entry: SidebarScheduleSessionEntry | undefined, index: number): string {
  if (entry === undefined) return String(index);
  return entry.kind === "session" ? `session:${entry.session.id}` : `schedule:${entry.group.key}`;
}

const SIDEBAR_EXPANDED_SCHEDULE_GROUPS_PREFIX = "joko.sidebar.expandedScheduleGroups";

function readExpandedScheduleGroups(ownerId: string): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(`${SIDEBAR_EXPANDED_SCHEDULE_GROUPS_PREFIX}.${ownerId}`) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeExpandedScheduleGroup(ownerId: string, groupKey: string, expanded: boolean): void {
  const next = new Set(readExpandedScheduleGroups(ownerId));
  if (expanded) next.add(groupKey); else next.delete(groupKey);
  try { window.localStorage.setItem(`${SIDEBAR_EXPANDED_SCHEDULE_GROUPS_PREFIX}.${ownerId}`, JSON.stringify([...next])); } catch { /* Client storage can be unavailable. */ }
}

function ProjectGroupHeading({ target, sessions, displayedSessionCount, collapsed, indicator, browsableSession, workspacePath, rail = false, t, onToggle, onBrowseFiles, actions }: {
  readonly target: TargetView;
  readonly sessions: readonly SessionView[];
  readonly displayedSessionCount: number;
  readonly collapsed: boolean;
  readonly indicator?: SidebarRightStatus;
  readonly browsableSession?: SessionView;
  readonly workspacePath: string;
  readonly rail?: boolean;
  readonly t: Translator;
  readonly onToggle: (viaKeyboard: boolean) => void;
  readonly onBrowseFiles: (session: SessionView) => void;
  readonly actions: SidebarProjectActions;
}): JSX.Element {
  const headerRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const renameCommittedRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(target.name);
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number }>();
  const [confirmation, setConfirmation] = useState<"archive" | "unarchive" | "remove">();
  const allArchived = sessions.length > 0 && sessions.every((session) => session.archived);
  const archiveCandidates = allArchived
    ? sessions.filter((session) => session.archived)
    : sessions.filter((session) => !session.archived && session.state !== "running" && session.state !== "waiting" && session.state !== "retrying");
  const canSetArchived = actions.onSetTargetSessionsArchived !== undefined && archiveCandidates.length > 0;
  const activeSessionCount = sessions.filter((session) => session.state === "running" || session.state === "waiting" || session.state === "retrying").length;

  useLayoutEffect(() => {
    if (!editing) return;
    renameRef.current?.focus({ preventScroll: true });
    renameRef.current?.select();
  }, [editing]);
  useEffect(() => {
    if (menu === undefined) return;
    const ownerDocument = headerRef.current?.ownerDocument;
    if (ownerDocument === undefined) return;
    const closeOutside = (event: globalThis.PointerEvent): void => {
      const eventTarget = event.target;
      if (eventTarget instanceof Node && (menuRef.current?.contains(eventTarget) === true || moreRef.current?.contains(eventTarget) === true)) return;
      setMenu(undefined);
    };
    ownerDocument.addEventListener("pointerdown", closeOutside, true);
    return () => ownerDocument.removeEventListener("pointerdown", closeOutside, true);
  }, [menu]);
  useLayoutEffect(() => {
    if (menu === undefined) return;
    const frame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [menu]);

  const openMenuAt = (anchor: SidebarListMenuAnchor): void => {
    const ownerWindow = headerRef.current?.ownerDocument.defaultView;
    if (ownerWindow === null || ownerWindow === undefined) return;
    setMenu(sidebarListMenuPosition(anchor, { width: 198, height: 312 }, { width: ownerWindow.innerWidth, height: ownerWindow.innerHeight }));
  };
  const beginRename = (): void => {
    if (actions.onRenameTarget === undefined) return;
    setMenu(undefined);
    renameCommittedRef.current = false;
    setEditValue(target.name);
    setEditing(true);
  };
  const finishRename = (commit: boolean): void => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    setEditing(false);
    const next = editValue.trim();
    if (commit && next !== "" && next !== target.name) actions.onRenameTarget?.(target, next);
  };
  const runMenuAction = (action: () => void): void => {
    setMenu(undefined);
    action();
  };
  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      setMenu(undefined);
      if (event.key === "Escape") moreRef.current?.focus({ preventScroll: true });
      return;
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)")];
    const current = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (current + 1 + items.length) % items.length
      : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length
        : event.key === "Home" ? 0
          : event.key === "End" ? items.length - 1
            : undefined;
    if (next === undefined || items.length === 0) return;
    event.preventDefault();
    items[next]?.focus({ preventScroll: true });
  };
  const renderProjectHeader = (hover?: SidebarHoverCardTriggerProps<HTMLDivElement>): JSX.Element => <div
    ref={hover?.ref}
    role="button"
    tabIndex={editing ? -1 : 0}
    data-project-header=""
    className={cx("project-group__header", rail && "project-group__header--rail", editing && "project-group__header--editing")}
    aria-expanded={!collapsed}
    aria-controls={hover?.["aria-controls"]}
    aria-haspopup={hover?.["aria-haspopup"]}
    onPointerEnter={hover?.onPointerEnter}
    onPointerLeave={hover?.onPointerLeave}
    onPointerDown={hover?.onPointerDown}
    onFocus={hover?.onFocus}
    onBlur={hover?.onBlur}
    onClick={() => { if (!editing) onToggle(false); }}
    onDoubleClick={(event) => {
      event.preventDefault();
      event.stopPropagation();
      beginRename();
    }}
    onKeyDown={(event) => {
      hover?.onKeyDown(event);
      if (event.defaultPrevented || editing || event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onToggle(true);
    }}
  >
    {rail ? <FolderKanban aria-hidden="true" /> : collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
    {editing ? <input
      ref={renameRef}
      aria-label={t("projects.renameLabel")}
      value={editValue}
      maxLength={120}
      onChange={(event) => setEditValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={() => finishRename(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          finishRename(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finishRename(false);
        }
      }}
    /> : <span className="project-group__name">{target.name}</span>}
    {!editing && <>
      <small>{displayedSessionCount}</small>
      {collapsed && indicator !== undefined && <SidebarRightStatusIndicator status={indicator} active={false} t={t} />}
      {rail && <ChevronRight className="project-group__rail-chevron" aria-hidden="true" />}
    </>}
  </div>;

  return <>
    <div
      ref={headerRef}
      className="project-group__heading"
      onContextMenu={(event) => {
        if (editing) {
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        openMenuAt({ kind: "point", x: event.clientX, y: event.clientY });
      }}
    >
      {rail || editing ? renderProjectHeader() : <SidebarHoverCard<HTMLDivElement>
        interactive
        label={t("projects.details", { name: target.name })}
        className="sidebar-hover-card--project"
        trigger={renderProjectHeader}
      >
        <div className="sidebar-hover-card__project-header">
          <FolderOpen aria-hidden="true" />
          <strong>{target.name}</strong>
          <button
            type="button"
            className={cx("sidebar-hover-card__pin", target.pinned && "is-pinned")}
            aria-label={t(target.pinned ? "projects.unpin" : "projects.pin")}
            onClick={() => actions.onPinTarget(target)}
          ><Pin aria-hidden="true" /></button>
        </div>
        <div className="sidebar-hover-card__stats">
          <MessageSquare aria-hidden="true" />
          <span><strong>{sessions.length}</strong> {t("projects.tasks")}</span>
          <span aria-hidden="true">·</span>
          <span><strong>{activeSessionCount}</strong> {t("projects.activeTasks")}</span>
        </div>
        <div className="sidebar-hover-card__project-path">
          <FolderOpen aria-hidden="true" />
          <span>{workspacePath}</span>
        </div>
        <button
          type="button"
          className="sidebar-hover-card__edit"
          data-sidebar-hover-autofocus=""
          onClick={() => actions.onEditTarget(target)}
        ><Settings aria-hidden="true" />{t("projects.edit")}</button>
      </SidebarHoverCard>}
      {!editing && <>
        {actions.onNewTaskInTarget !== undefined && <IconButton
          className="project-group__action"
          label={t("projects.newTask")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            actions.onNewTaskInTarget?.(target);
          }}
        ><SquarePen aria-hidden="true" /></IconButton>}
        <IconButton
          buttonRef={moreRef}
          className="project-group__action"
          label={t("common.more")}
          aria-haspopup="menu"
          aria-expanded={menu !== undefined}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            if (menu === undefined) openMenuAt({ kind: "trigger", right: rect.right, bottom: rect.bottom });
            else setMenu(undefined);
          }}
        ><Ellipsis aria-hidden="true" /></IconButton>
      </>}
    </div>
    {menu !== undefined && createPortal(<div
      ref={menuRef}
      className="sidebar-list-settings__menu sidebar-project-actions-menu"
      role="menu"
      aria-label={target.name}
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={menuKeyDown}
    >
      {actions.onRenameTarget !== undefined && <button type="button" role="menuitem" onClick={beginRename}><span>{t("projects.rename")}</span></button>}
      <button type="button" role="menuitem" onClick={() => runMenuAction(() => actions.onPinTarget(target))}><span>{t(target.pinned ? "projects.unpin" : "projects.pin")}</span></button>
      <hr />
      <button type="button" role="menuitem" onClick={() => runMenuAction(() => actions.onSearchTarget(target))}><span>{t("projects.search")}</span></button>
      {browsableSession !== undefined && <button type="button" role="menuitem" onClick={() => runMenuAction(() => onBrowseFiles(browsableSession))}><span>{t("workspace.browseFiles", { name: target.name })}</span></button>}
      {actions.onCopyTargetLink !== undefined && <button type="button" role="menuitem" onClick={() => runMenuAction(() => actions.onCopyTargetLink?.(target))}><span>{t("projects.copyLink")}</span></button>}
      <hr />
      {actions.onRemoveTarget !== undefined && <button type="button" role="menuitem" onClick={() => runMenuAction(() => setConfirmation("remove"))}><span>{t("projects.removeFromSidebar")}</span></button>}
      <button type="button" role="menuitem" disabled={!canSetArchived} onClick={() => runMenuAction(() => setConfirmation(allArchived ? "unarchive" : "archive"))}><span>{t(allArchived ? "projects.unarchiveAll" : "projects.archiveAll")}</span></button>
    </div>, document.body)}
    <Modal
      open={confirmation !== undefined}
      title={confirmation === "remove"
        ? t("projects.removeTitle", { name: target.name })
        : t(confirmation === "unarchive" ? "projects.unarchiveAllTitle" : "projects.archiveAllTitle", { name: target.name })}
      description={confirmation === "remove" ? t("projects.removeBody") : t("projects.archiveAllBody")}
      size="small"
      dialogRole="alertdialog"
      onClose={() => setConfirmation(undefined)}
    >
      <div className="modal__actions">
        <Button onClick={() => setConfirmation(undefined)}>{t("common.cancel")}</Button>
        <Button tone={confirmation === "unarchive" ? "primary" : "danger"} onClick={() => {
          const action = confirmation;
          setConfirmation(undefined);
          if (action === "remove") actions.onRemoveTarget?.(target);
          else if (action !== undefined) actions.onSetTargetSessionsArchived?.(target, archiveCandidates, action === "archive");
        }}>{t(confirmation === "remove" ? "common.remove" : confirmation === "unarchive" ? "projects.unarchiveAll" : "projects.archiveAll")}</Button>
      </div>
    </Modal>
  </>;
}

function SidebarRailLocalProjectRow({ entry, open, active, indicator, activeSessionId, browsableTargetIds, workspacePath, t, actions, onBrowseFiles, onOpen, onPointerLeave }: {
  readonly entry: Extract<SidebarRailProjectEntry, { readonly kind: "local" }>;
  readonly open: boolean;
  readonly active: boolean;
  readonly indicator?: SidebarRightStatus;
  readonly activeSessionId?: string;
  readonly browsableTargetIds: ReadonlySet<string>;
  readonly workspacePath: string;
  readonly t: Translator;
  readonly actions: SidebarProjectActions;
  readonly onBrowseFiles: (session: SessionView) => void;
  readonly onOpen: (projectId: string, trigger: HTMLElement, openedViaKeyboard: boolean) => void;
  readonly onPointerLeave: () => void;
}): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null);
  const allTargetSessions = actions.allSessions.filter((session) => session.projectId === entry.target.id);
  const browsableSession = allTargetSessions.find((session) => session.id === activeSessionId)
    ?? allTargetSessions[0];
  const openPanel = (openedViaKeyboard: boolean): void => {
    const trigger = rowRef.current?.querySelector<HTMLElement>(".project-group__header");
    if (trigger !== null && trigger !== undefined) onOpen(entry.id, trigger, openedViaKeyboard);
  };
  return <div
    ref={rowRef}
    className={cx("sidebar-rail-project", open && "is-open", active && "is-active")}
    onPointerEnter={() => openPanel(false)}
    onPointerLeave={onPointerLeave}
  >
    <ProjectGroupHeading
      target={entry.target}
      sessions={allTargetSessions}
      displayedSessionCount={entry.sessions.length}
      collapsed={!open}
      indicator={indicator}
      browsableSession={browsableSession !== undefined && browsableTargetIds.has(entry.target.id) ? browsableSession : undefined}
      workspacePath={workspacePath}
      rail
      t={t}
      onToggle={openPanel}
      onBrowseFiles={onBrowseFiles}
      actions={actions}
    />
  </div>;
}

function SessionSection({ title, sessions, targets, activeSessionId, locale, collapsedTargets, collapsedDialogue, groupDialogue, browsableTargetIds, projectOrder, onReorderTargets, reducedMotion, t, onToggleTarget, onToggleDialogue, projectActions, workspacePathFor, priorityContext, ...callbacks }: {
  readonly title: string;
  readonly sessions: readonly SessionView[];
  readonly targets: readonly TargetView[];
  readonly activeSessionId?: string;
  readonly locale: string;
  readonly collapsedTargets: ReadonlySet<string>;
  readonly collapsedDialogue: boolean;
  readonly groupDialogue: boolean;
  readonly browsableTargetIds: ReadonlySet<string>;
  readonly projectOrder: SidebarLayout["projectOrder"];
  readonly onReorderTargets: (ids: readonly string[]) => void;
  readonly reducedMotion: boolean;
  readonly t: Translator;
  readonly onToggleTarget: (id: string) => void;
  readonly onToggleDialogue: () => void;
  readonly projectActions: SidebarProjectActions;
  readonly workspacePathFor: (target: TargetView) => string;
} & SessionSectionCallbacks & SessionPriorityProps & SessionDisplayProps & ScheduleGroupPresentationProps): JSX.Element {
  const groups = targets.map((target) => ({ target, sessions: sessions.filter((session) => session.projectId === target.id) })).filter((group) => group.sessions.length > 0);
  const dialogue = sessions.filter((session) => session.projectId === undefined);
  const renderGroup = ({ target, sessions: targetSessions }: (typeof groups)[number]): JSX.Element => {
    const allTargetSessions = projectActions.allSessions.filter((session) => session.projectId === target.id);
    const collapsed = collapsedTargets.has(target.id);
    const groupIndicatorState = sidebarGroupIndicatorState(targetSessions, priorityContext);
    const browsableSession = allTargetSessions.find((session) => session.targetId === target.id && session.id === activeSessionId)
      ?? allTargetSessions.find((session) => session.targetId === target.id);
    return (
      <div className="project-group" key={target.id}>
        <ProjectGroupHeading
          target={target}
          sessions={allTargetSessions}
          displayedSessionCount={targetSessions.length}
          collapsed={collapsed}
          indicator={groupIndicatorState}
          browsableSession={browsableSession !== undefined && browsableTargetIds.has(target.id) ? browsableSession : undefined}
          workspacePath={workspacePathFor(target)}
          t={t}
          onToggle={() => onToggleTarget(target.id)}
          onBrowseFiles={callbacks.onBrowseFiles}
          actions={projectActions}
        />
        <CollapsibleSessionRows
          sessions={targetSessions}
          activeSessionId={activeSessionId}
          locale={locale}
          collapsed={collapsed}
          noDrag
          t={t}
          priorityContext={priorityContext}
          {...callbacks}
        />
      </div>
    );
  };
  const renderDialogue = (): JSX.Element | null => {
    if (dialogue.length === 0) return null;
    if (!groupDialogue) return <div className="project-group project-group--dialogue project-group--dialogue-flat">
      <CollapsibleSessionRows
        sessions={dialogue}
        activeSessionId={activeSessionId}
        locale={locale}
        noDrag
        t={t}
        priorityContext={priorityContext}
        {...callbacks}
      />
    </div>;
    const groupIndicatorState = sidebarGroupIndicatorState(dialogue, priorityContext);
    return <div className="project-group project-group--dialogue">
      <div className="project-group__heading">
        <div
          role="button"
          tabIndex={0}
          className="project-group__header"
          aria-expanded={!collapsedDialogue}
          onClick={onToggleDialogue}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onToggleDialogue();
          }}
        >
          {collapsedDialogue ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          <span className="project-group__name">{t("nav.dialogue")}</span>
          <small>{dialogue.length}</small>
          {collapsedDialogue && groupIndicatorState !== undefined && <SidebarRightStatusIndicator status={groupIndicatorState} active={false} t={t} />}
        </div>
      </div>
      <CollapsibleSessionRows
        sessions={dialogue}
        activeSessionId={activeSessionId}
        locale={locale}
        collapsed={collapsedDialogue}
        noDrag
        t={t}
        priorityContext={priorityContext}
        {...callbacks}
      />
    </div>;
  };
  return (
    <section className="session-section" aria-label={title}>
      <h2>{title}</h2>
      <div className="session-section__projects">
        {projectOrder === "custom" ? <SortableList
          items={groups}
          getId={(group) => group.target.id}
          onReorder={onReorderTargets}
          renderItem={renderGroup}
          reducedMotion={reducedMotion}
          handle="[data-project-header]"
          className="session-section__sortable-projects"
        /> : groups.map(renderGroup)}
        {renderDialogue()}
      </div>
    </section>
  );
}

function SessionRow({ session, active, locale, targetName, match, t, priorityContext, sessionInfoFields, sessionProfileId, projectNameFor, environmentNameFor, onSelect, onRename, onPin, onArchive, onDelete, onCopyTaskLink, onExportPortableSession, canExportPortableSession, onSplitSession, onOpenSessionWindow, projectMenuTargets, movingSessionProjectIds, onMoveSessionProject, selectedSessionIds }: { readonly session: SessionView; readonly active: boolean; readonly locale: string; readonly targetName?: string; readonly match?: SidebarFuzzyMatch; readonly t: Translator } & SessionSectionCallbacks & SessionPriorityProps & SessionDisplayProps): JSX.Element {
  const indicator = sidebarSessionIndicatorState(session, priorityContext);
  const stateLabel = indicator === undefined
    ? sessionStateLabel(session.state, t)
    : sidebarRightStatusLabel(indicator, t);
  const infoPieces = sidebarSessionInfoPieces(session, sessionInfoFields, locale);
  const codeHostTooltip = codeHostPullRequestTooltip(session.codeHostPullRequests, t);
  const detailProjectName = projectNameFor(session);
  const environmentName = environmentNameFor(session);
  const selected = selectedSessionIds.has(session.id);
  const rowRef = useRef<HTMLLIElement>(null);
  const mainButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCommittedRef = useRef(false);
  const restoreRowFocusRef = useRef(false);
  const contextRequestSequenceRef = useRef(0);
  const [contextMenuRequest, setContextMenuRequest] = useState<SessionMenuContextRequest>();
  const [archivePending, setArchivePending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(session.name);
  useEffect(() => {
    if (!active) return;
    const row = rowRef.current;
    if (row === null || typeof row.scrollIntoView !== "function") return;
    const reducedMotion = row.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    row.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  }, [active]);
  useLayoutEffect(() => {
    if (editing) {
      renameInputRef.current?.focus({ preventScroll: true });
      renameInputRef.current?.select();
      return;
    }
    if (!restoreRowFocusRef.current) return;
    restoreRowFocusRef.current = false;
    mainButtonRef.current?.focus({ preventScroll: true });
  }, [editing]);
  useEffect(() => () => cancelSessionWindowDragPreviewForSession(session.id), [session.id]);
  useEffect(() => {
    if (!archivePending) return;
    const timer = window.setTimeout(() => setArchivePending(false), 4_000);
    const dismiss = (event: globalThis.PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-session-archive-confirm]")?.getAttribute("data-session-archive-confirm") !== session.id) setArchivePending(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", dismiss, true);
    };
  }, [archivePending, session.id]);
  const activate = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (editing || event.detail > 1) return;
    const modifiers = { metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey };
    onSelect(session, modifiers.metaKey || modifiers.ctrlKey || modifiers.shiftKey ? modifiers : undefined);
  };
  const beginRename = (): void => {
    if (editing) return;
    renameCommittedRef.current = false;
    restoreRowFocusRef.current = false;
    setArchivePending(false);
    setContextMenuRequest(undefined);
    setEditValue(session.name);
    setEditing(true);
  };
  const commitRename = (restoreFocus: boolean): void => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    restoreRowFocusRef.current = restoreFocus;
    setEditing(false);
    const name = editValue.trim();
    if (name !== "" && name !== session.name) onRename(session, name);
  };
  const cancelRename = (): void => {
    renameCommittedRef.current = true;
    restoreRowFocusRef.current = true;
    setEditing(false);
  };
  const renameFromDoubleClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    beginRename();
  };
  return (
    <li
      ref={rowRef}
      className={cx("session-row", active && "is-active", selected && "is-selected")}
      data-sidebar-session-row="true"
      onContextMenu={(event) => {
        if (editing) {
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setContextMenuRequest({ x: event.clientX, y: event.clientY, sequence: ++contextRequestSequenceRef.current });
      }}
    >
      {editing ? <div
        className="session-row__main session-row__main--editing"
        data-session-id={session.id}
        aria-current={active ? "page" : undefined}
      >
        <MessageSquare className="session-row__agent" aria-hidden="true" />
        <input
          ref={renameInputRef}
          className="session-row__rename-input"
          aria-label={t("session.rename")}
          value={editValue}
          maxLength={120}
          onChange={(event) => setEditValue(event.target.value)}
          onBlur={() => commitRename(false)}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              commitRename(true);
              return;
            }
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            cancelRename();
          }}
        />
      </div> : <SidebarHoverCard<HTMLButtonElement>
        label={t("session.details", { name: session.name })}
        className="sidebar-hover-card--task"
        trigger={(hover) => <button
        ref={(element) => {
          mainButtonRef.current = element;
          hover.ref(element);
        }}
        className="session-row__main"
        type="button"
        data-session-id={session.id}
        draggable={!session.archived}
        aria-current={active ? "page" : undefined}
        aria-describedby={hover["aria-describedby"]}
        aria-label={`${session.name} · ${stateLabel} · ${formatRelativeTime(session.updatedAt, locale)}${codeHostTooltip === "" ? "" : `\n${codeHostTooltip}`}`}
        onPointerEnter={hover.onPointerEnter}
        onPointerLeave={hover.onPointerLeave}
        onPointerDown={hover.onPointerDown}
        onFocus={hover.onFocus}
        onBlur={hover.onBlur}
        onKeyDown={hover.onKeyDown}
        onClick={activate}
        onDoubleClick={renameFromDoubleClick}
        onDragStart={(event) => {
          if (session.archived) {
            event.preventDefault();
            return;
          }
          const row = event.currentTarget.closest<HTMLElement>(".session-row");
          const ownerWindow = event.currentTarget.ownerDocument.defaultView;
          const nativePreviewStarted = row !== null && ownerWindow !== null && startSessionWindowDragPreview({
            dataTransfer: event.dataTransfer,
            row,
            sessionId: session.id,
            label: session.name,
            hint: t("session.openNewWindow"),
            ownerWindow
          });
          try {
            if (nativePreviewStarted) event.dataTransfer.clearData();
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData(SESSION_SPLIT_DRAG_TYPE, session.id);
            try {
              const link = sessionTaskLink(window.location, session.id, sessionProfileId);
              event.dataTransfer.setData(SESSION_LINK_DRAG_MIME, link);
              if (!nativePreviewStarted) event.dataTransfer.setData("text/plain", link);
            } catch {
              if (!nativePreviewStarted) event.dataTransfer.setData("text/plain", session.name);
            }
          } catch {
            cancelSessionWindowDragPreviewForSession(session.id);
            row?.classList.remove("is-session-dragging");
            event.preventDefault();
            return;
          }
          if (!nativePreviewStarted) row?.classList.add("is-session-dragging");
        }}
        onDragEnd={(event) => {
          event.currentTarget.closest(".session-row")?.classList.remove("is-session-dragging");
          const ownerWindow = event.currentTarget.ownerDocument.defaultView;
          finishSessionWindowDragPreview(ownerWindow ?? undefined);
        }}
      >
        <MessageSquare className="session-row__agent" aria-hidden="true" />
        <span className="session-row__copy"><SidebarTitleMarquee title={session.name}><HighlightedText value={session.name} ranges={match?.nameRanges ?? []} /></SidebarTitleMarquee>{session.pinned && session.summary !== undefined && <span className="session-row__summary">{session.summary}</span>}<small>{targetName !== undefined && <><HighlightedText value={targetName} ranges={match?.targetRanges ?? []} /> · </>}{stateLabel}</small></span>
        {session.pinned && <Pin className="session-row__pin" aria-label={t("session.pin")} />}
        <span className="session-row__right-slot">{indicator === undefined
          ? infoPieces.map((piece) => <span className={cx("session-row__metadata", `session-row__metadata--${piece.field}`)} key={piece.field}>{piece.field === "pr"
            ? <CodeHostPullRequestSidebarBadge pullRequests={session.codeHostPullRequests} t={t} />
            : piece.field === "worktree" && session.worktree !== undefined
              ? <GitBranch className="session-row__worktree" aria-label={t("worktree.sessionBadge", { branch: session.worktree.branch })} />
              : piece.dateTime === undefined
                ? piece.text
                : <time dateTime={piece.dateTime}>{piece.text}</time>}
          </span>)
          : <SidebarRightStatusIndicator status={indicator} active={active} t={t} />}
        </span>
      </button>}
      >
        <div className="sidebar-hover-card__task-header">
          <strong>{session.name}</strong>
          <span className="sidebar-hover-card__environment" aria-label={t("session.environment", { name: environmentName })}>
            <Laptop aria-hidden="true" />
          </span>
          <time dateTime={new Date(session.updatedAt).toISOString()}>{formatRelativeTime(session.updatedAt, locale)}</time>
        </div>
        {codeHostTooltip !== "" && <div className="sidebar-hover-card__supplement">{codeHostTooltip}</div>}
        <div className="sidebar-hover-card__task-project">
          <FolderOpen aria-hidden="true" />
          <span>{detailProjectName}</span>
        </div>
      </SidebarHoverCard>}
      {!editing && <div className="session-row__actions">
      <SessionActionsMenu
        session={session}
        t={t}
        onStartRename={beginRename}
        onPin={onPin}
        onArchive={onArchive}
        onDelete={onDelete}
        onCopyTaskLink={onCopyTaskLink}
        onExportPortableSession={canExportPortableSession(session) ? onExportPortableSession : undefined}
        onSplitSession={onSplitSession}
        onOpenSessionWindow={onOpenSessionWindow}
        projectMenuTargets={projectMenuTargets}
        moving={movingSessionProjectIds.has(session.id)}
        onMoveSessionProject={onMoveSessionProject}
        contextMenuRequest={contextMenuRequest}
        onContextMenuRequestHandled={() => setContextMenuRequest(undefined)}
      />
      {archivePending ? <button
        type="button"
        className="session-row__archive-confirm"
        data-session-archive-confirm={session.id}
        aria-label={t("session.archive")}
        onClick={() => { setArchivePending(false); onArchive(session); }}
      >{t("common.confirm")}</button> : <IconButton
        className="session-row__quick-archive"
        label={session.archived ? t("session.unarchive") : t("session.archive")}
        onClick={() => session.archived ? onArchive(session) : setArchivePending(true)}
      >{session.archived ? <Undo2 aria-hidden="true" /> : <Archive aria-hidden="true" />}</IconButton>}
      </div>}
    </li>
  );
}

interface SessionMenuContextRequest {
  readonly x: number;
  readonly y: number;
  readonly sequence: number;
}

function SessionActionsMenu({ session, t, onStartRename, onPin, onArchive, onDelete, onCopyTaskLink, onExportPortableSession, onSplitSession, onOpenSessionWindow, projectMenuTargets, moving, onMoveSessionProject, contextMenuRequest, onContextMenuRequestHandled }: {
  readonly session: SessionView;
  readonly t: Translator;
  readonly onStartRename: () => void;
  readonly onPin: (session: SessionView) => void;
  readonly onArchive: (session: SessionView) => void;
  readonly onDelete: (session: SessionView) => void;
  readonly onCopyTaskLink: (session: SessionView) => void;
  readonly onExportPortableSession?: (session: SessionView) => void;
  readonly onSplitSession: (session: SessionView, side: "right" | "bottom") => void;
  readonly onOpenSessionWindow: (session: SessionView) => void;
  readonly projectMenuTargets: readonly TargetView[];
  readonly moving: boolean;
  readonly onMoveSessionProject: (session: SessionView, placement: SessionProjectNavigationPlacement) => void;
  readonly contextMenuRequest?: SessionMenuContextRequest;
  readonly onContextMenuRequestHandled: () => void;
}): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const focusTargetRef = useRef<"first" | "last">("first");
  const projectFocusTargetRef = useRef<"first" | "last">("first");
  const pointAnchorRef = useRef<{ readonly x: number; readonly y: number } | undefined>(undefined);
  const menuId = useId();
  const projectMenuId = useId();
  const [position, setPosition] = useState<{ readonly x: number; readonly y: number }>();
  const [projectMenuPosition, setProjectMenuPosition] = useState<{ readonly x: number; readonly y: number }>();

  const close = (restoreFocus: boolean): void => {
    setPosition(undefined);
    setProjectMenuPosition(undefined);
    pointAnchorRef.current = undefined;
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };
  const open = (focusTarget: "first" | "last" = "first"): void => {
    const trigger = triggerRef.current;
    const ownerWindow = trigger?.ownerDocument.defaultView;
    if (trigger === null || trigger === undefined || ownerWindow === null || ownerWindow === undefined) return;
    focusTargetRef.current = focusTarget;
    pointAnchorRef.current = undefined;
    setProjectMenuPosition(undefined);
    setPosition(sidebarSessionMenuPosition(
      trigger.getBoundingClientRect(),
      {
        width: Math.min(SESSION_ACTION_MENU_WIDTH, Math.max(0, ownerWindow.innerWidth - (SESSION_ACTION_MENU_VIEWPORT_MARGIN * 2))),
        height: SESSION_ACTION_MENU_ESTIMATED_HEIGHT
      },
      { width: ownerWindow.innerWidth, height: ownerWindow.innerHeight }
    ));
  };
  const openProjectMenu = (focusTarget: "first" | "last" = "first"): void => {
    const trigger = projectTriggerRef.current;
    const ownerWindow = trigger?.ownerDocument.defaultView;
    if (trigger === null || trigger === undefined || ownerWindow === null || ownerWindow === undefined) return;
    projectFocusTargetRef.current = focusTarget;
    setProjectMenuPosition(sidebarSessionSubmenuPosition(
      trigger.getBoundingClientRect(),
      {
        width: Math.min(SESSION_PROJECT_MENU_WIDTH, Math.max(0, ownerWindow.innerWidth - (SESSION_ACTION_MENU_VIEWPORT_MARGIN * 2))),
        height: SESSION_PROJECT_MENU_ESTIMATED_HEIGHT
      },
      { width: ownerWindow.innerWidth, height: ownerWindow.innerHeight }
    ));
  };

  useEffect(() => {
    if (contextMenuRequest === undefined) return;
    const ownerWindow = triggerRef.current?.ownerDocument.defaultView;
    if (ownerWindow === null || ownerWindow === undefined) return;
    focusTargetRef.current = "first";
    pointAnchorRef.current = { x: contextMenuRequest.x, y: contextMenuRequest.y };
    setProjectMenuPosition(undefined);
    setPosition(clampSidebarMenuPosition(
      pointAnchorRef.current,
      {
        width: Math.min(SESSION_ACTION_MENU_WIDTH, Math.max(0, ownerWindow.innerWidth - (SESSION_ACTION_MENU_VIEWPORT_MARGIN * 2))),
        height: SESSION_ACTION_MENU_ESTIMATED_HEIGHT
      },
      { width: ownerWindow.innerWidth, height: ownerWindow.innerHeight }
    ));
    onContextMenuRequestHandled();
  }, [contextMenuRequest?.sequence]);

  useLayoutEffect(() => {
    if (position === undefined) return;
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    const ownerWindow = trigger?.ownerDocument.defaultView;
    if (menu === null || trigger === null || trigger === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const bounds = menu.getBoundingClientRect();
    const pointAnchor = pointAnchorRef.current;
    const clamped = pointAnchor === undefined
      ? sidebarSessionMenuPosition(
          trigger.getBoundingClientRect(),
          { width: bounds.width, height: bounds.height },
          { width: ownerWindow.innerWidth, height: ownerWindow.innerHeight }
        )
      : clampSidebarMenuPosition(
          pointAnchor,
          { width: bounds.width, height: bounds.height },
          { width: ownerWindow.innerWidth, height: ownerWindow.innerHeight }
        );
    if (clamped.x !== position.x || clamped.y !== position.y) setPosition(clamped);
    const frame = ownerWindow.requestAnimationFrame(() => {
      const items = menu.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not([disabled])");
      (focusTargetRef.current === "last" ? items.item(items.length - 1) : items.item(0))?.focus({ preventScroll: true });
    });
    return () => ownerWindow.cancelAnimationFrame(frame);
  }, [position]);

  useLayoutEffect(() => {
    if (projectMenuPosition === undefined) return;
    const menu = projectMenuRef.current;
    const trigger = projectTriggerRef.current;
    const ownerWindow = trigger?.ownerDocument.defaultView;
    if (menu === null || trigger === null || trigger === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const bounds = menu.getBoundingClientRect();
    const clamped = sidebarSessionSubmenuPosition(
      trigger.getBoundingClientRect(),
      { width: bounds.width, height: bounds.height },
      { width: ownerWindow.innerWidth, height: ownerWindow.innerHeight }
    );
    if (clamped.x !== projectMenuPosition.x || clamped.y !== projectMenuPosition.y) setProjectMenuPosition(clamped);
    const frame = ownerWindow.requestAnimationFrame(() => {
      const items = menu.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not([disabled])");
      (projectFocusTargetRef.current === "last" ? items.item(items.length - 1) : items.item(0))?.focus({ preventScroll: true });
    });
    return () => ownerWindow.cancelAnimationFrame(frame);
  }, [projectMenuPosition]);

  useEffect(() => {
    if (position === undefined) return;
    const trigger = triggerRef.current;
    const ownerDocument = trigger?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (trigger === null || trigger === undefined || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const closeOutside = (event: globalThis.PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && (trigger.contains(target) || menuRef.current?.contains(target) === true || projectMenuRef.current?.contains(target) === true)) return;
      setPosition(undefined);
      setProjectMenuPosition(undefined);
    };
    const closeForViewportChange = (): void => {
      setPosition(undefined);
      setProjectMenuPosition(undefined);
    };
    ownerDocument.addEventListener("pointerdown", closeOutside, true);
    ownerDocument.addEventListener("scroll", closeForViewportChange, true);
    ownerWindow.addEventListener("resize", closeForViewportChange);
    return () => {
      ownerDocument.removeEventListener("pointerdown", closeOutside, true);
      ownerDocument.removeEventListener("scroll", closeForViewportChange, true);
      ownerWindow.removeEventListener("resize", closeForViewportChange);
    };
  }, [position, projectMenuPosition]);

  const run = (action: (session: SessionView) => void): void => {
    setPosition(undefined);
    setProjectMenuPosition(undefined);
    action(session);
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not([disabled])")];
    const activeIndex = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
    if (event.key === "ArrowRight" && event.currentTarget.ownerDocument.activeElement === projectTriggerRef.current) {
      event.preventDefault();
      event.stopPropagation();
      openProjectMenu();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close(true);
      return;
    }
    const nextIndex = event.key === "ArrowDown"
      ? (activeIndex + 1 + items.length) % items.length
      : event.key === "ArrowUp"
        ? (activeIndex - 1 + items.length) % items.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : undefined;
    if (nextIndex === undefined || items.length === 0) return;
    event.preventDefault();
    items[nextIndex]?.focus({ preventScroll: true });
  };
  const onProjectMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not([disabled])")];
    const activeIndex = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      setProjectMenuPosition(undefined);
      projectTriggerRef.current?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close(true);
      return;
    }
    const nextIndex = event.key === "ArrowDown"
      ? (activeIndex + 1 + items.length) % items.length
      : event.key === "ArrowUp"
        ? (activeIndex - 1 + items.length) % items.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : undefined;
    if (nextIndex === undefined || items.length === 0) return;
    event.preventDefault();
    items[nextIndex]?.focus({ preventScroll: true });
  };
  const move = (placement: SessionProjectNavigationPlacement): void => {
    setPosition(undefined);
    setProjectMenuPosition(undefined);
    onMoveSessionProject(session, placement);
  };

  const ownerDocument = triggerRef.current?.ownerDocument;
  return <div className="session-menu">
    <IconButton
      buttonRef={triggerRef}
      label={t("a11y.sessionActions", { name: session.name })}
      aria-haspopup="menu"
      aria-expanded={position !== undefined}
      aria-controls={position === undefined ? undefined : menuId}
      onClick={() => position === undefined ? open() : close(false)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        open(event.key === "ArrowUp" ? "last" : "first");
      }}
    ><Ellipsis aria-hidden="true" /></IconButton>
    {position !== undefined && ownerDocument !== undefined && createPortal(<>
      <div
        ref={menuRef}
        id={menuId}
        className="menu-popover session-menu-popover"
        role="menu"
        aria-label={t("a11y.sessionActions", { name: session.name })}
        style={{ left: position.x, top: position.y }}
        onKeyDown={onMenuKeyDown}
      >
        {!session.archived && <button type="button" role="menuitem" onClick={() => run(onPin)}>{session.pinned ? t("session.unpin") : t("session.pin")}</button>}
        <button type="button" role="menuitem" onClick={() => { close(false); onStartRename(); }}>{t("session.rename")}</button>
        {!session.archived && session.remoteWorkspace !== true && <button
          ref={projectTriggerRef}
          type="button"
          role="menuitem"
          className="session-menu__submenu-trigger"
          aria-haspopup="menu"
          aria-expanded={projectMenuPosition !== undefined}
          aria-controls={projectMenuPosition === undefined ? undefined : projectMenuId}
          disabled={moving}
          onClick={() => projectMenuPosition === undefined ? openProjectMenu() : setProjectMenuPosition(undefined)}
        ><FolderKanban aria-hidden="true" /><span>{moving ? t("session.movingProject") : t("session.moveToProject")}</span><ChevronRight aria-hidden="true" /></button>}
        <div className="menu-separator" role="separator" />
        <button type="button" role="menuitem" onClick={() => run(onCopyTaskLink)}><Copy aria-hidden="true" />{t("session.copyTaskLink")}</button>
        {onExportPortableSession !== undefined && <button type="button" role="menuitem" onClick={() => run(onExportPortableSession)}><FileOutput aria-hidden="true" />{t("session.exportPortable")}</button>}
        {!session.archived && <button type="button" role="menuitem" onClick={() => { close(false); onSplitSession(session, "right"); }}><PanelRight aria-hidden="true" />{t("session.splitRight")}</button>}
        {!session.archived && <button type="button" role="menuitem" onClick={() => { close(false); onSplitSession(session, "bottom"); }}><Rows2 aria-hidden="true" />{t("session.splitDown")}</button>}
        {!session.archived && <button type="button" role="menuitem" onClick={() => run(onOpenSessionWindow)}><ExternalLink aria-hidden="true" />{t("session.openNewWindow")}</button>}
        <div className="menu-separator" role="separator" />
        <button type="button" role="menuitem" onClick={() => run(onArchive)}>{session.archived ? t("session.unarchive") : t("session.archive")}</button>
        <button type="button" role="menuitem" className="danger-text" onClick={() => run(onDelete)}>{t("session.delete")}</button>
      </div>
      {projectMenuPosition !== undefined && <div
        ref={projectMenuRef}
        id={projectMenuId}
        className="menu-popover session-project-menu-popover"
        role="menu"
        aria-label={t("session.moveToProject")}
        style={{ left: projectMenuPosition.x, top: projectMenuPosition.y }}
        onKeyDown={onProjectMenuKeyDown}
      >
        <strong className="session-project-menu__heading">{t("session.moveToProject")}</strong>
        <div className="session-project-menu__projects">
          {projectMenuTargets.map((target) => <button
            key={target.id}
            type="button"
            role="menuitem"
            disabled={session.projectId === target.id}
            aria-current={session.projectId === target.id ? "true" : undefined}
            onClick={() => move({ kind: "project", projectId: target.id })}
          ><FolderKanban aria-hidden="true" /><span>{target.name}</span>{session.projectId === target.id && <Check aria-hidden="true" />}</button>)}
          {projectMenuTargets.length === 0 && <small className="session-project-menu__empty">{t("session.noProjectsAvailable")}</small>}
        </div>
        <div className="menu-separator" role="separator" />
        <button
          type="button"
          role="menuitem"
          disabled={session.projectId === undefined}
          aria-current={session.projectId === undefined ? "true" : undefined}
          onClick={() => move({ kind: "dialogue" })}
        ><MessageSquare aria-hidden="true" /><span>{t("session.moveToDialogue")}</span>{session.projectId === undefined && <Check aria-hidden="true" />}</button>
      </div>}
    </>, ownerDocument.body)}
  </div>;
}

export function sidebarSessionMenuPosition(
  trigger: Pick<DOMRect, "left" | "right" | "top">,
  menu: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number }
): { readonly x: number; readonly y: number } {
  const maximumX = Math.max(SESSION_ACTION_MENU_VIEWPORT_MARGIN, viewport.width - SESSION_ACTION_MENU_VIEWPORT_MARGIN - menu.width);
  const right = trigger.right + SESSION_ACTION_MENU_OFFSET;
  const left = trigger.left - SESSION_ACTION_MENU_OFFSET - menu.width;
  const preferredX = right <= maximumX ? right : left;
  return clampSidebarMenuPosition({ x: preferredX, y: trigger.top + SESSION_ACTION_MENU_OFFSET }, menu, viewport);
}

export function sidebarSessionSubmenuPosition(
  trigger: Pick<DOMRect, "left" | "right" | "top">,
  menu: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number }
): { readonly x: number; readonly y: number } {
  const maximumX = Math.max(SESSION_ACTION_MENU_VIEWPORT_MARGIN, viewport.width - SESSION_ACTION_MENU_VIEWPORT_MARGIN - menu.width);
  const right = trigger.right + SESSION_ACTION_MENU_OFFSET;
  const left = trigger.left - SESSION_ACTION_MENU_OFFSET - menu.width;
  return clampSidebarMenuPosition({
    x: right <= maximumX ? right : left,
    y: trigger.top
  }, menu, viewport);
}

export function sidebarListMenuPosition(
  anchor: SidebarListMenuAnchor,
  menu: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number }
): { readonly x: number; readonly y: number } {
  return clampSidebarMenuPosition(anchor.kind === "trigger"
    ? { x: anchor.right - menu.width, y: anchor.bottom + SIDEBAR_LIST_MENU_OFFSET }
    : anchor, menu, viewport);
}

function clampSidebarMenuPosition(
  preferred: { readonly x: number; readonly y: number },
  menu: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number }
): { readonly x: number; readonly y: number } {
  const maximumX = Math.max(SESSION_ACTION_MENU_VIEWPORT_MARGIN, viewport.width - SESSION_ACTION_MENU_VIEWPORT_MARGIN - menu.width);
  const maximumY = Math.max(SESSION_ACTION_MENU_VIEWPORT_MARGIN, viewport.height - SESSION_ACTION_MENU_VIEWPORT_MARGIN - menu.height);
  return {
    x: Math.min(maximumX, Math.max(SESSION_ACTION_MENU_VIEWPORT_MARGIN, preferred.x)),
    y: Math.min(maximumY, Math.max(SESSION_ACTION_MENU_VIEWPORT_MARGIN, preferred.y))
  };
}

function HighlightedText({ value, ranges }: { readonly value: string; readonly ranges: FuzzyTextMatch["ranges"] }): JSX.Element {
  if (ranges.length === 0) return <>{value}</>;
  const parts: JSX.Element[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push(<Fragment key={`text:${cursor}`}>{value.slice(cursor, range.start)}</Fragment>);
    parts.push(<mark key={`match:${range.start}`}>{value.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  if (cursor < value.length) parts.push(<Fragment key={`text:${cursor}`}>{value.slice(cursor)}</Fragment>);
  return <>{parts}</>;
}

export function sidebarTitleMarqueeMetrics(viewportWidth: number, contentWidth: number): {
  readonly overflowing: boolean;
  readonly shift: number;
  readonly viewportCount: number;
} {
  const viewport = Math.max(0, viewportWidth);
  const content = Math.max(0, contentWidth);
  const overflowing = content > viewport + 1;
  return {
    overflowing,
    shift: overflowing ? viewport - content : 0,
    viewportCount: overflowing ? Math.max(1, Math.ceil(content / Math.max(viewport, 1))) : 1
  };
}

export function SidebarTitleMarquee({ children, title }: { readonly children: ReactNode; readonly title: string }): JSX.Element {
  const containerRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);
  const observerRef = useRef<ResizeObserver | undefined>(undefined);

  const stop = useCallback((): void => {
    const container = containerRef.current;
    if (container === null) return;
    delete container.dataset.titleOverflowing;
    container.style.removeProperty("--sidebar-title-marquee-shift");
    container.style.removeProperty("--sidebar-title-marquee-duration");
  }, []);
  const start = useCallback((): void => {
    const container = containerRef.current;
    const track = trackRef.current;
    if (container === null || track === null) return;
    stop();
    if (container.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true) return;
    const metrics = sidebarTitleMarqueeMetrics(container.clientWidth, track.scrollWidth);
    if (!metrics.overflowing) return;
    container.style.setProperty("--sidebar-title-marquee-shift", `${metrics.shift}px`);
    container.style.setProperty("--sidebar-title-marquee-duration", `calc(var(--motion-sidebar-title-marquee-per-viewport) * ${metrics.viewportCount})`);
    container.dataset.titleOverflowing = "true";
  }, [stop]);
  const stopObserving = useCallback((): void => {
    observerRef.current?.disconnect();
    observerRef.current = undefined;
  }, []);
  const startObserving = useCallback((): void => {
    stopObserving();
    const container = containerRef.current;
    const track = trackRef.current;
    if (container === null || track === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (hoveredRef.current || focusedRef.current) start(); });
    observer.observe(container);
    observer.observe(track);
    observerRef.current = observer;
  }, [start, stopObserving]);

  useLayoutEffect(() => { if (hoveredRef.current || focusedRef.current) start(); }, [start, title]);
  useEffect(() => {
    const row = containerRef.current?.closest<HTMLElement>("[data-sidebar-session-row='true']");
    if (row === undefined || row === null) return;
    const activate = (): void => {
      start();
      startObserving();
    };
    const deactivateIfIdle = (): void => {
      if (hoveredRef.current || focusedRef.current) return;
      stopObserving();
      stop();
    };
    const enter = (): void => {
      hoveredRef.current = true;
      activate();
    };
    const leave = (): void => {
      hoveredRef.current = false;
      deactivateIfIdle();
    };
    const focusIn = (): void => {
      focusedRef.current = true;
      activate();
    };
    const focusOut = (event: FocusEvent): void => {
      if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
      focusedRef.current = false;
      deactivateIfIdle();
    };
    row.addEventListener("mouseenter", enter);
    row.addEventListener("mouseleave", leave);
    row.addEventListener("focusin", focusIn);
    row.addEventListener("focusout", focusOut);
    if (row.matches(":hover")) enter();
    if (row.contains(row.ownerDocument.activeElement)) focusIn();
    return () => {
      row.removeEventListener("mouseenter", enter);
      row.removeEventListener("mouseleave", leave);
      row.removeEventListener("focusin", focusIn);
      row.removeEventListener("focusout", focusOut);
      hoveredRef.current = false;
      focusedRef.current = false;
      deactivateIfIdle();
    };
  }, [start, startObserving, stop, stopObserving]);
  useEffect(() => () => stopObserving(), [stopObserving]);

  return <strong ref={containerRef} className="sidebar-title-marquee">
    <span className="sidebar-title-marquee__ellipsis">{children}</span>
    <span ref={trackRef} className="sidebar-title-marquee__track" aria-hidden="true">{children}</span>
  </strong>;
}

function sessionStateLabel(state: SessionView["state"], t: Translator): string {
  switch (state) {
    case "running": return t("session.running");
    case "waiting": return t("session.waiting");
    case "retrying": return t("session.running");
    case "error": return t("session.error");
    case "idle": return t("session.idle");
    case "closed": return t("session.closed");
  }
}

function machinePresenceText(presence: MachinePresenceView, t: Translator): string {
  if (presence === "current") return t("machine.current");
  if (presence === "online") return t("machine.online");
  if (presence === "checking") return t("machine.checking");
  if (presence === "identityMismatch") return t("machine.identityMismatch");
  if (presence === "accessDenied") return t("machine.accessDenied");
  return t("machine.offline");
}

export function remoteCachedStatus(session: MachineSessionCacheView): SidebarRightStatus | undefined {
  if (session.interactionKind !== undefined) return "awaiting";
  if (session.attentionUnread === true) {
    if (session.attentionKind === "error") return "error";
    if (session.attentionKind === "awaiting") return "awaiting";
    if (session.attentionKind === "done") return "done";
  }
  if (session.state === "running" || session.state === "retrying") return "running";
  if (session.state === "error") return "error";
  return undefined;
}

export function remoteSessionMatchesSidebarStatus(session: MachineSessionCacheView, status: SidebarLayout["status"]): boolean {
  return status === "all" || session.archived === (status === "archived");
}

function sidebarRightStatusLabel(status: SidebarRightStatus, t: Translator): string {
  switch (status) {
    case "error": return t("session.error");
    case "awaiting": return t("timeline.inputRequired");
    case "running": return t("session.running");
    case "done": return t("timeline.completed");
  }
}

export function visibleSidebarSessionIds(root: HTMLElement | null): readonly string[] {
  if (root === null) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const row of root.querySelectorAll<HTMLElement>(".session-row [data-session-id]")) {
    const sessionId = row.dataset.sessionId;
    if (sessionId === undefined || sessionId === "" || seen.has(sessionId)) continue;
    if (row.closest("[aria-hidden='true'], [inert]") !== null) continue;
    seen.add(sessionId);
    result.push(sessionId);
  }
  return result;
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function SidebarRightStatusIndicator({ status, active, t, className }: {
  readonly status: SidebarRightStatus | undefined;
  readonly active: boolean;
  readonly t: Translator;
  readonly className?: string;
}): JSX.Element | null {
  if (status === undefined) return null;
  const label = sidebarRightStatusLabel(status, t);
  return <span
    className={cx("sidebar-right-status", `sidebar-right-status--${status}`, active && "is-active", className)}
    data-sidebar-right-status={status}
    role="img"
    aria-label={label}
    title={label}
  >{status === "running"
      ? <LoaderCircle aria-hidden="true" />
      : <span className="sidebar-right-status__dot" aria-hidden="true" />}
  </span>;
}

function sidebarMonotonicNowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function useReducedMotionPreference(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);
  useEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (preference === undefined) return;
    const sync = (): void => setReduced(preference.matches);
    preference.addEventListener("change", sync);
    sync();
    return () => preference.removeEventListener("change", sync);
  }, []);
  return reduced;
}

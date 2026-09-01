import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { FolderOpen, MessageSquare } from "lucide-react";

import type { AppController, AppRoute } from "../controller.js";
import type {
  AppSnapshot,
  BackendView,
  ComposerFileSelectionQuoteDraft,
  SessionView,
  TargetView,
  WorkspaceEntryView,
  WorkspaceFileChangeView,
  WorkspaceFilePreviewView,
  WorkspaceView
} from "../model.js";
import {
  WORKSPACE_CHAT_RAIL_COLLAPSED_STORAGE_KEY,
  WORKSPACE_CHAT_RAIL_DEFAULT_WIDTH,
  WORKSPACE_CHAT_RAIL_MAX_WIDTH,
  WORKSPACE_CHAT_RAIL_MIN_WIDTH,
  WORKSPACE_CHAT_RAIL_WIDTH_STORAGE_KEY,
  clampWorkspaceChatRailWidth,
  readWorkspaceChatRailCollapsed,
  readWorkspaceChatRailWidth,
  workspaceChatRailDragWidth
} from "../workspace-chat-rail.js";
import { CLIENT_LAYOUT_RESET_EVENT } from "../client-layout-reset.js";
import { workspaceDocumentController, type WorkspaceLeaveChoice, type WorkspaceLeavePromptInput } from "../workspace-document-controller.js";
import { registerWorkspaceDocumentLeaveGate, requestWorkspaceDocumentLeave } from "../workspace-document-lifecycle.js";
import { nextActiveWorkspaceTab, workspaceOpenTabsStore } from "../workspace-open-tabs.js";
import { workspaceSelectedFileStore } from "../workspace-selected-file.js";
import { useAppShortcut } from "../use-app-shortcut.js";
import type { Translator } from "./types.js";
import { InteractionPromptSlot } from "./InteractionPortal.js";
import { SidebarFrame, type SidebarFrameProps } from "./SidebarFrame.js";
import { WorkspaceFileBody } from "./WorkspaceFileBody.js";
import { WorkspaceFileTabsBar } from "./WorkspaceFileTabsBar.js";
import {
  WorkspaceFilesSidebar,
  type WorkspaceFilesDocumentActions,
  type WorkspaceFilesFileIndexPage,
  type WorkspaceFilesProjectOption,
  type WorkspaceFilesExternalChange,
  type WorkspaceFilesSidebarHandle,
  type WorkspaceFilesSearchEvent,
  type WorkspaceFilesSearchRequest
} from "./WorkspaceFilesSidebar.js";
import type { WorkspaceFilesEntryView } from "./workspace-tree-state.js";
import {
  canonicalWorkspaceRelativePath,
  normalizeWorkspaceDirectoryEntries,
  workspacePathParent
} from "./workspace-tree-state.js";
import { WorkspaceSessionTabsBar, type WorkspaceSessionCreateOption } from "./WorkspaceSessionTabsBar.js";
import { Button, IconButton, Modal, Spinner, StatusDot, cx } from "./ui.js";
import "./workspace-files-route.css";

const DOCUMENT_TREE_LISTING = { policy: "documentTree", includeHidden: true } as const;
const WORKSPACE_CHAT_OVERLAY_FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable='true'], [tabindex]:not([tabindex='-1'])";
export const WORKSPACE_FILES_COMPACT_MAX_WIDTH = 980;
export const WORKSPACE_FILES_COMPACT_MEDIA_QUERY = `(max-width: ${WORKSPACE_FILES_COMPACT_MAX_WIDTH}px)`;

export function workspaceFilesUsesCompactLayout(viewportWidth: number): boolean {
  return viewportWidth <= WORKSPACE_FILES_COMPACT_MAX_WIDTH;
}

export function initialWorkspaceChatRailCollapsed(stored: boolean, compactLayout: boolean): boolean {
  return compactLayout || stored;
}

type FilesRoute = Extract<AppRoute, { readonly kind: "files" }>;

export interface WorkspaceFilesRouteProps {
  readonly controller: AppController;
  readonly route: FilesRoute;
  readonly session: SessionView;
  readonly target: TargetView;
  readonly backend: BackendView;
  readonly workspace: WorkspaceView;
  readonly sessions: readonly SessionView[];
  readonly banners?: ReactNode;
  readonly chatPane: ReactNode;
  readonly t: Translator;
  readonly onError: (message: string) => void;
  readonly onSelectionQuote?: (sessionId: string, quote: ComposerFileSelectionQuoteDraft) => void;
  readonly onImageToChat?: (sessionId: string, file: File) => void | Promise<void>;
  readonly navigation: WorkspaceFilesNavigationShell;
}

export type WorkspaceFilesNavigationShell = Pick<SidebarFrameProps,
  | "open"
  | "mode"
  | "width"
  | "onCloseDrawer"
  | "onHide"
  | "onCollapse"
  | "onExpand"
  | "onResizePointerDown"
  | "onResizePointerMove"
  | "onResizePointerUp"
  | "onResizePointerCancel"
  | "onResizeKeyDown"
  | "onResetWidth"
  | "onDisconnect"
>;

interface LeavePromptState {
  readonly input: WorkspaceLeavePromptInput;
  readonly resolve: (choice: WorkspaceLeaveChoice) => void;
}

interface ArchivePromptState {
  readonly sessionId: string;
  readonly neighborId?: string;
  readonly title: string;
}

interface RailDragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
}

interface FilePreviewState {
  readonly workspaceId?: string;
  readonly path?: string;
  readonly preview?: WorkspaceFilePreviewView;
  readonly loading: boolean;
  readonly error?: string;
}

/**
 * The formal workspace-files shell, expressed through Joko's
 * generated contracts. The URL owns the active file; persistent stores only
 * retain ordered tabs, expansion, and rail geometry.
 */
export function WorkspaceFilesRoute({
  controller,
  route,
  session,
  target,
  backend,
  workspace,
  sessions,
  banners,
  chatPane,
  t,
  onError,
  onSelectionQuote,
  onImageToChat,
  navigation
}: WorkspaceFilesRouteProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLElement>(null);
  const chatReturnFocusRef = useRef<HTMLElement | null>(null);
  const navigationReturnFocusRef = useRef<HTMLElement | null>(null);
  const sidebarRef = useRef<WorkspaceFilesSidebarHandle>(null);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const leavePromptRef = useRef<LeavePromptState | undefined>(undefined);
  const [leavePrompt, setLeavePrompt] = useState<LeavePromptState | undefined>(undefined);
  const [archivePrompt, setArchivePrompt] = useState<ArchivePromptState>();
  const [archiveBusy, setArchiveBusy] = useState(false);
  const archiveBusyRef = useRef(false);
  const [previewState, setPreviewState] = useState<FilePreviewState>({ loading: false });
  const [previewRefreshSequence, setPreviewRefreshSequence] = useState(0);
  const [compactLayout, setCompactLayout] = useState(() => browserMatches(WORKSPACE_FILES_COMPACT_MEDIA_QUERY));
  const [railWidth, setRailWidth] = useState(() => readWorkspaceChatRailWidth(browserStorage()));
  const railWidthRef = useRef(railWidth);
  const [railCollapsed, setRailCollapsed] = useState(() => initialWorkspaceChatRailCollapsed(
    readWorkspaceChatRailCollapsed(browserStorage()),
    browserMatches(WORKSPACE_FILES_COMPACT_MEDIA_QUERY)
  ));
  const [railDrag, setRailDrag] = useState<RailDragState>();
  const railDragRef = useRef<RailDragState | undefined>(undefined);
  const rememberNavigationReturnFocus = useCallback((): void => {
    const ownerDocument = rootRef.current?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    const active = ownerDocument?.activeElement;
    if (ownerWindow !== null && ownerWindow !== undefined && active instanceof ownerWindow.HTMLElement && active !== ownerDocument?.body) {
      navigationReturnFocusRef.current = active;
    }
  }, []);
  const takeNavigationReturnFocus = useCallback((): HTMLElement | null => {
    const target = navigationReturnFocusRef.current;
    navigationReturnFocusRef.current = null;
    return target?.isConnected === true && target.closest("[inert], [aria-hidden='true']") === null
      ? target
      // The tab-strip trigger is conditionally unmounted while navigation is
      // open, so restore to its newly mounted replacement rather than the
      // disconnected element captured before opening the drawer.
      : rootRef.current?.querySelector<HTMLElement>(".workspace-file-tabs-bar__navigation-toggle > button") ?? rootRef.current;
  }, []);
  const rememberChatReturnFocus = useCallback((): void => {
    const ownerDocument = rootRef.current?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    const active = ownerDocument?.activeElement;
    if (ownerWindow !== null && ownerWindow !== undefined && active instanceof ownerWindow.HTMLElement && active !== ownerDocument?.body && !chatRef.current?.contains(active)) {
      chatReturnFocusRef.current = active;
    }
  }, []);
  const selectedPathResult = useMemo(() => safeWorkspacePath(route.file), [route.file]);
  const selectedPath = selectedPathResult.path;
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const canWrite = backend.capabilities.get("workspace.files.write")?.supported === true;
  const canWatchFiles = backend.capabilities.get("workspace.files.watch")?.supported === true;
  const workdirSessions = useMemo(
    () => workspaceSessions(sessions, target.workspaceId, controller.state.snapshot.targets),
    [controller.state.snapshot.targets, sessions, target.workspaceId]
  );
  const projectOptions = useMemo(
    () => workspaceFilesProjectOptions(controller.state.snapshot),
    [controller.state.snapshot.backends, controller.state.snapshot.sessions, controller.state.snapshot.targets, controller.state.snapshot.workspaces]
  );
  const createOptions = useMemo<readonly WorkspaceSessionCreateOption[]>(() => (
    backend.health === "unavailable"
      ? []
      : [{ id: backend.id, label: backend.name }]
  ), [backend.health, backend.id, backend.name]);

  const settleLeavePrompt = useCallback((choice: WorkspaceLeaveChoice): void => {
    const pending = leavePromptRef.current;
    if (pending === undefined) return;
    leavePromptRef.current = undefined;
    setLeavePrompt(undefined);
    pending.resolve(choice);
  }, []);

  useEffect(() => {
    return registerWorkspaceDocumentLeaveGate(async (request) => workspaceDocumentController.requestLeave({
      reason: request.reason,
      ...(request.matches === undefined ? {} : { matches: request.matches }),
      prompt: (input) => new Promise<WorkspaceLeaveChoice>((resolve) => {
        // The registry serializes prompts. Failing closed here protects against
        // an unexpected duplicate host rather than replacing a live resolver.
        if (leavePromptRef.current !== undefined) {
          resolve("cancel");
          return;
        }
        const next = { input, resolve };
        leavePromptRef.current = next;
        setLeavePrompt(next);
      })
    }));
  }, []);

  useEffect(() => () => {
    const pending = leavePromptRef.current;
    leavePromptRef.current = undefined;
    pending?.resolve("cancel");
  }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!workspaceDocumentController.shouldPreventUnload((identity) => identity.sessionId === session.id)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [session.id]);

  useEffect(() => {
    const ownerDocument = rootRef.current?.ownerDocument ?? document;
    const active = ownerDocument.activeElement;
    if (active === null || active === ownerDocument.body || active === ownerDocument.documentElement) {
      rootRef.current?.focus({ preventScroll: true });
    }
  }, [session.id, workspace.id]);

  useEffect(() => {
    const ownerWindow = rootRef.current?.ownerDocument.defaultView ?? (typeof window === "undefined" ? undefined : window);
    if (ownerWindow?.matchMedia === undefined) return;
    const media = ownerWindow.matchMedia(WORKSPACE_FILES_COMPACT_MEDIA_QUERY);
    let previous = media.matches;
    const changed = (event: MediaQueryListEvent): void => {
      setCompactLayout(event.matches);
      if (event.matches && !previous) setRailCollapsed(true);
      else if (!event.matches && previous) setRailCollapsed(readWorkspaceChatRailCollapsed(browserStorage()));
      previous = event.matches;
    };
    setCompactLayout(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useAppShortcut("search-in-project", controller.state.preferences.appShortcutOverrides, () => {
    const ownerDocument = rootRef.current?.ownerDocument ?? document;
    const ownerWindow = ownerDocument.defaultView ?? window;
    // A modal owns the keyboard domain until it closes. Do not move focus
    // behind the save/discard, archive, or file-operation confirmation.
    if (ownerDocument.querySelector('[aria-modal="true"]') !== null) return false;
    rememberNavigationReturnFocus();
    if (ownerWindow.matchMedia?.(WORKSPACE_FILES_COMPACT_MEDIA_QUERY).matches === true) setRailCollapsed(true);
    navigationRef.current.onExpand();
    ownerWindow.requestAnimationFrame(() => sidebarRef.current?.openSearch());
    return true;
  }, { stopImmediate: true });

  useEffect(() => {
    if (selectedPath === undefined) return;
    workspaceSelectedFileStore.set(workspace.id, selectedPath);
    workspaceOpenTabsStore.addTab(workspace.id, selectedPath);
  }, [selectedPath, workspace.id]);

  useEffect(() => {
    let current = true;
    if (selectedPathResult.error !== undefined) {
      setPreviewState({ workspaceId: workspace.id, path: route.file, loading: false, error: t("workspace.invalidPath") });
      return () => { current = false; };
    }
    if (selectedPath === undefined) {
      setPreviewState({ workspaceId: workspace.id, loading: false });
      return () => { current = false; };
    }
    setPreviewState((previous) => ({
      workspaceId: workspace.id,
      path: selectedPath,
      ...(previous.workspaceId === workspace.id && previous.path === selectedPath && previous.preview !== undefined ? { preview: previous.preview } : {}),
      loading: true
    }));
    void controllerRef.current.readWorkspaceFile(workspace.id, selectedPath).then((preview) => {
      if (!current) return;
      if (preview.path !== selectedPath) throw new Error("Joko service returned a different workspace file.");
      setPreviewState({ workspaceId: workspace.id, path: selectedPath, preview, loading: false });
    }).catch((error: unknown) => {
      if (!current) return;
      setPreviewState((previous) => previous.workspaceId === workspace.id
        && previous.path === selectedPath
        && previous.preview !== undefined
        && workspaceDocumentController.shouldPreventUnload((identity) => (
          identity.workspaceId === workspace.id && identity.path === selectedPath
        ))
        // A watcher refresh failure must not unmount a dirty editor and lose
        // its in-memory draft. Keep the last fenced preview and retry on the
        // next workspace revision.
        ? { workspaceId: workspace.id, path: selectedPath, preview: previous.preview, loading: false }
        : { workspaceId: workspace.id, path: selectedPath, loading: false, error: messageOf(error, t("workspace.filePreviewUnavailable")) });
    });
    return () => { current = false; };
  }, [previewRefreshSequence, route.file, selectedPath, selectedPathResult.error, t, workspace.id, workspace.revision]);

  const navigateFile = useCallback((path: string | undefined, options?: { readonly search?: string; readonly line?: number }): void => {
    const canonical = path === undefined ? undefined : safeWorkspacePath(path).path;
    if (path !== undefined && canonical === undefined) {
      onError(t("workspace.invalidPath"));
      return;
    }
    if (canonical === undefined) workspaceSelectedFileStore.clear(workspace.id);
    else workspaceSelectedFileStore.set(workspace.id, canonical);
    controllerRef.current.navigate({
      kind: "files",
      sessionId: session.id,
      ...(canonical === undefined ? {} : { file: canonical }),
      ...(options?.search === undefined ? {} : { search: options.search }),
      ...(options?.line === undefined ? {} : { line: options.line })
    }, { replace: true });
  }, [onError, session.id, t, workspace.id]);
  const navigateFileRef = useRef(navigateFile);
  navigateFileRef.current = navigateFile;

  useEffect(() => {
    if (!canWatchFiles) return;
    const abort = new AbortController();
    let lastSequence = 0n;
    const invalidate = async (change: WorkspaceFilesExternalChange): Promise<void> => {
      await sidebarRef.current?.invalidateChange(change);
      if (abort.signal.aborted) return;
      if (change.kind === "overflow" || change.kind === "resync") {
        setPreviewRefreshSequence((value) => value + 1);
      }
    };
    const consume = async (): Promise<void> => {
      let retryDelay = 250;
      while (!abort.signal.aborted) {
        try {
          for await (const change of controllerRef.current.watchWorkspaceFileChanges(
            { kind: "workspace", workspaceId: workspace.id },
            abort.signal
          )) {
            if (abort.signal.aborted || change.workspaceId !== workspace.id) continue;
            if (change.kind === "resync") lastSequence = change.sequence;
            else {
              if (change.sequence <= lastSequence) continue;
              lastSequence = change.sequence;
            }
            retryDelay = 250;
            await invalidate(change);
            if (abort.signal.aborted) return;
            applyWorkspaceFileChangeToRoute({
              change,
              workspaceId: workspace.id,
              selectedPath: selectedPathRef.current,
              isSelectedDirty: (path) => workspaceDocumentController.shouldPreventUnload((identity) => (
                identity.workspaceId === workspace.id && identity.path === path
              )),
              refreshPreview: () => setPreviewRefreshSequence((value) => value + 1),
              navigateFile: (path) => navigateFileRef.current(path)
            });
          }
          if (abort.signal.aborted) return;
          // A clean stream close has the same cache semantics as a disconnect.
          await invalidate({ kind: "resync" });
        } catch {
          if (abort.signal.aborted) return;
          // The next server subscription also starts with a durable RESYNC,
          // but invalidate immediately so a disconnected client never treats
          // cached directory/search/preview state as authoritative.
          await invalidate({ kind: "resync" });
        }
        await abortableWorkspaceWatchDelay(retryDelay, abort.signal);
        retryDelay = Math.min(retryDelay * 2, 2_000);
      }
    };
    void consume();
    return () => abort.abort();
  }, [canWatchFiles, workspace.id]);

  useEffect(() => {
    if (route.file !== undefined) return;
    const remembered = workspaceSelectedFileStore.get(workspace.id);
    if (remembered === undefined) return;
    workspaceOpenTabsStore.addTab(workspace.id, remembered);
    controllerRef.current.navigate({ kind: "files", sessionId: session.id, file: remembered }, { replace: true });
  }, [route.file, session.id, workspace.id]);

  const activateFile = useCallback(async (
    path: string,
    options?: { readonly search?: string; readonly line?: number }
  ): Promise<boolean> => {
    const canonical = safeWorkspacePath(path).path;
    if (canonical === undefined) {
      onError(t("workspace.invalidPath"));
      return false;
    }
    if (canonical !== selectedPath) {
      const allowed = await requestWorkspaceDocumentLeave({
        reason: "switch-file",
        matches: (identity) => identity.sessionId === session.id && identity.workspaceId === workspace.id
      });
      if (!allowed) return false;
    }
    navigateFile(canonical, options);
    return true;
  }, [navigateFile, onError, selectedPath, session.id, t, workspace.id]);

  const navigateAwayFromFiles = useCallback(async (next: AppRoute): Promise<boolean> => {
    const allowed = await requestWorkspaceDocumentLeave({
      reason: "switch-session",
      matches: (identity) => identity.sessionId === session.id && identity.workspaceId === workspace.id
    });
    if (!allowed) return false;
    if (compactLayout) navigationRef.current.onCloseDrawer();
    controllerRef.current.navigate(next);
    return true;
  }, [compactLayout, session.id, workspace.id]);

  const loadDirectory = useCallback(async ({ workspaceId, parentPath }: { readonly workspaceId: string; readonly parentPath: string }): Promise<readonly WorkspaceFilesEntryView[]> => {
    if (workspaceId !== workspace.id) throw new Error("The workspace changed while files were loading.");
    const parent = canonicalWorkspaceRelativePath(parentPath, true);
    return normalizeWorkspaceDirectoryEntries(
      parent,
      (await controllerRef.current.listWorkspaceEntries(workspaceId, parent, DOCUMENT_TREE_LISTING)).map(mapWorkspaceEntry)
    );
  }, [workspace.id]);

  const loadFileIndex = useCallback(async (
    { workspaceId }: { readonly workspaceId: string },
    signal: AbortSignal
  ): Promise<WorkspaceFilesFileIndexPage> => {
    if (workspaceId !== workspace.id) throw new Error("The workspace changed while files were indexing.");
    return await controllerRef.current.listWorkspaceFiles(workspaceId, signal);
  }, [workspace.id]);

  const searchWorkspace = useCallback((request: WorkspaceFilesSearchRequest, signal: AbortSignal): AsyncIterable<WorkspaceFilesSearchEvent> => {
    if (request.workspaceId !== workspace.id) throw new Error("The workspace changed while search was running.");
    return controllerRef.current.streamWorkspaceSearch(
      request.workspaceId,
      request.query,
      request.caseSensitive,
      signal
    );
  }, [workspace.id]);

  const guardAffectedDocument = useCallback(async (reason: "switch-file" | "close-file", path: string, directory: boolean): Promise<boolean> => {
    const prefix = `${path}/`;
    return await requestWorkspaceDocumentLeave({
      reason,
      matches: (identity) => identity.workspaceId === workspace.id
        && (identity.path === path || (directory && identity.path.startsWith(prefix)))
    });
  }, [workspace.id]);

  const documentActions = useMemo<WorkspaceFilesDocumentActions | undefined>(() => {
    const copyRelativePath = async ({ path }: { readonly path: string }): Promise<void> => {
      const clipboard = rootRef.current?.ownerDocument.defaultView?.navigator.clipboard;
      if (clipboard === undefined) throw new Error(t("workspace.clipboardUnavailable"));
      await clipboard.writeText(path);
    };
    if (!canWrite) return {
      capabilities: { copyRelativePath: true },
      copyRelativePath
    };
    return {
      capabilities: { createFile: true, createDirectory: true, rename: true, delete: true, copyRelativePath: true },
      createFile: async ({ workspaceId, path }) => {
        await controllerRef.current.createWorkspaceEntry({ workspaceId, path, kind: "file" });
      },
      createDirectory: async ({ workspaceId, path }) => {
        await controllerRef.current.createWorkspaceEntry({ workspaceId, path, kind: "directory" });
      },
      rename: async ({ workspaceId, fromPath, toPath, kind }) => {
        if (!(await guardAffectedDocument("switch-file", fromPath, kind === "directory"))) return false;
        const entry = await freshWorkspaceEntry(controllerRef.current, workspaceId, fromPath);
        if (entry.revision === undefined) throw new Error(t("workspace.revisionUnavailable"));
        await controllerRef.current.moveWorkspaceEntry({ workspaceId, sourcePath: fromPath, destinationPath: toPath, expectedRevision: entry.revision });
        workspaceOpenTabsStore.renameTabPrefix(workspaceId, fromPath, toPath);
        workspaceSelectedFileStore.renamePrefix(workspaceId, fromPath, toPath);
        if (selectedPath === fromPath || (kind === "directory" && selectedPath?.startsWith(`${fromPath}/`) === true)) {
          const nextPath = selectedPath === fromPath ? toPath : `${toPath}/${selectedPath!.slice(fromPath.length + 1)}`;
          navigateFile(nextPath);
        }
      },
      delete: async ({ workspaceId, path, kind }) => {
        if (!(await guardAffectedDocument("close-file", path, kind === "directory"))) return false;
        const entry = await freshWorkspaceEntry(controllerRef.current, workspaceId, path);
        if (entry.revision === undefined) throw new Error(t("workspace.revisionUnavailable"));
        const liveTabs = workspaceOpenTabsStore.getTabs(workspaceId);
        const prefix = `${path}/`;
        const closing = liveTabs.filter((tab) => tab === path || (kind === "directory" && tab.startsWith(prefix)));
        const selectedAffected = selectedPath === path || (kind === "directory" && selectedPath?.startsWith(prefix) === true);
        const successor = selectedAffected && selectedPath !== undefined
          ? nextActiveWorkspaceTab(liveTabs, selectedPath, closing)
          : undefined;
        await controllerRef.current.deleteWorkspaceEntry({ workspaceId, path, expectedRevision: entry.revision, confirmRecursive: kind === "directory" });
        workspaceOpenTabsStore.closeTabs(workspaceId, closing);
        workspaceSelectedFileStore.clearPrefix(workspaceId, path);
        if (selectedAffected) navigateFile(successor);
      },
      copyRelativePath
    };
  }, [canWrite, guardAffectedDocument, navigateFile, selectedPath, t]);

  const toggleRail = useCallback((): void => {
    const next = !railCollapsed;
    if (!next && compactLayout) rememberChatReturnFocus();
    writeStorage(WORKSPACE_CHAT_RAIL_COLLAPSED_STORAGE_KEY, String(next));
    if (!next && compactLayout && navigation.open) navigation.onCloseDrawer();
    setRailCollapsed(next);
  }, [compactLayout, navigation, railCollapsed, rememberChatReturnFocus]);

  const closeCompactChat = useCallback((): void => {
    if (railCollapsed) return;
    writeStorage(WORKSPACE_CHAT_RAIL_COLLAPSED_STORAGE_KEY, "true");
    setRailCollapsed(true);
  }, [railCollapsed]);

  const openNavigation = useCallback((): void => {
    rememberNavigationReturnFocus();
    if (compactLayout) setRailCollapsed(true);
    navigation.onExpand();
  }, [compactLayout, navigation, rememberNavigationReturnFocus]);

  const chatOverlayOpen = compactLayout && !railCollapsed;
  const previousChatOverlayOpenRef = useRef(chatOverlayOpen);
  useEffect(() => {
    const previous = previousChatOverlayOpenRef.current;
    previousChatOverlayOpenRef.current = chatOverlayOpen;
    if (!previous && chatOverlayOpen) {
      rememberChatReturnFocus();
      chatRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!previous || chatOverlayOpen) return;
    const target = chatReturnFocusRef.current;
    chatReturnFocusRef.current = null;
    if (!railCollapsed) return;
    const safeTarget = target?.isConnected === true && target.closest("[inert], [aria-hidden='true']") === null
      ? target
      : rootRef.current;
    safeTarget?.focus({ preventScroll: true });
  }, [chatOverlayOpen, railCollapsed, rememberChatReturnFocus]);

  useEffect(() => {
    if (!chatOverlayOpen) return;
    const chat = chatRef.current;
    const ownerDocument = chat?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (chat === null || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const handleKey = (event: KeyboardEvent): void => {
      if (event.isComposing || event.defaultPrevented || workspaceChatOverlayHasHigherPrioritySurface(ownerDocument)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeCompactChat();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...chat.querySelectorAll<HTMLElement>(WORKSPACE_CHAT_OVERLAY_FOCUSABLE)]
        .filter((element) => element.closest("[inert], [aria-hidden='true']") === null && element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        chat.focus({ preventScroll: true });
      } else if (event.shiftKey && (ownerDocument.activeElement === chat || ownerDocument.activeElement === first || !chat.contains(ownerDocument.activeElement))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (ownerDocument.activeElement === chat || ownerDocument.activeElement === last || !chat.contains(ownerDocument.activeElement))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    ownerWindow.addEventListener("keydown", handleKey);
    return () => ownerWindow.removeEventListener("keydown", handleKey);
  }, [chatOverlayOpen, closeCompactChat]);

  const beginRailResize = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || railCollapsed) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    const next = { pointerId: event.pointerId, startX: event.clientX, startWidth: railWidthRef.current };
    railDragRef.current = next;
    setRailDrag(next);
  }, [railCollapsed]);

  const moveRailResize = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = railDragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    const next = workspaceChatRailDragWidth(drag.startWidth, drag.startX, event.clientX);
    railWidthRef.current = next;
    setRailWidth(next);
  }, []);

  const finishRailResize = useCallback((event: ReactPointerEvent<HTMLDivElement>, cancelled = false): void => {
    const drag = railDragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    // Clear synchronously before releasePointerCapture emits lostpointercapture.
    railDragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const next = cancelled ? drag.startWidth : railWidthRef.current;
    railWidthRef.current = next;
    setRailWidth(next);
    setRailDrag(undefined);
    if (!cancelled) writeStorage(WORKSPACE_CHAT_RAIL_WIDTH_STORAGE_KEY, String(next));
  }, []);

  const resetRailWidth = useCallback((): void => {
    railWidthRef.current = WORKSPACE_CHAT_RAIL_DEFAULT_WIDTH;
    setRailWidth(WORKSPACE_CHAT_RAIL_DEFAULT_WIDTH);
    setRailCollapsed(false);
    writeStorage(WORKSPACE_CHAT_RAIL_WIDTH_STORAGE_KEY, String(WORKSPACE_CHAT_RAIL_DEFAULT_WIDTH));
    writeStorage(WORKSPACE_CHAT_RAIL_COLLAPSED_STORAGE_KEY, "false");
  }, []);

  useEffect(() => {
    window.addEventListener(CLIENT_LAYOUT_RESET_EVENT, resetRailWidth);
    return () => window.removeEventListener(CLIENT_LAYOUT_RESET_EVENT, resetRailWidth);
  }, [resetRailWidth]);

  const railResizeKey = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey || railCollapsed) return;
    const step = event.shiftKey ? 64 : 16;
    const next = event.key === "ArrowLeft" ? railWidthRef.current + step
      : event.key === "ArrowRight" ? railWidthRef.current - step
        : event.key === "Home" ? WORKSPACE_CHAT_RAIL_DEFAULT_WIDTH
          : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const width = clampWorkspaceChatRailWidth(next);
    railWidthRef.current = width;
    setRailWidth(width);
    writeStorage(WORKSPACE_CHAT_RAIL_WIDTH_STORAGE_KEY, String(width));
  }, [railCollapsed]);

  const activateSession = useCallback((sessionId: string): void => {
    if (sessionId === session.id) return;
    controllerRef.current.navigate({
      kind: "files",
      sessionId,
      ...(selectedPath === undefined ? {} : { file: selectedPath }),
      ...(route.search === undefined ? {} : { search: route.search }),
      ...(route.line === undefined ? {} : { line: route.line })
    }, { replace: true });
  }, [route.line, route.search, selectedPath, session.id]);

  const switchProject = useCallback(async (project: WorkspaceFilesProjectOption): Promise<boolean> => {
    if (project.targetId === target.id) return true;
    const allowed = await requestWorkspaceDocumentLeave({
      reason: "switch-workspace",
      matches: (identity) => identity.sessionId === session.id && identity.workspaceId === workspace.id
    });
    if (!allowed) return false;
    // Cross-project navigation intentionally drops search/line. The target
    // workspace may restore only its own remembered selected file.
    const remembered = workspaceSelectedFileStore.get(project.workspaceId);
    controllerRef.current.navigate({
      kind: "files",
      sessionId: project.sessionId,
      ...(remembered === undefined ? {} : { file: remembered })
    }, { replace: true });
    return true;
  }, [session.id, target.id, workspace.id]);

  const requestArchive = useCallback((sessionId: string, neighborId: string | undefined): void => {
    const closing = workdirSessions.find((candidate) => candidate.id === sessionId);
    if (closing === undefined) return;
    if (closing.state === "running" || closing.state === "waiting" || closing.state === "retrying") {
      onError(t("workspace.archiveRunningBlocked"));
      return;
    }
    setArchivePrompt({ sessionId, ...(neighborId === undefined ? {} : { neighborId }), title: closing.name.trim() || t("session.unnamed") });
  }, [onError, t, workdirSessions]);

  const confirmArchive = useCallback(async (): Promise<void> => {
    const pending = archivePrompt;
    if (pending === undefined || archiveBusyRef.current) return;
    archiveBusyRef.current = true;
    setArchiveBusy(true);
    try {
      if (pending.sessionId === session.id) {
        const matches = (identity: { readonly sessionId: string }): boolean => identity.sessionId === pending.sessionId;
        // Avoid stacking two focus-trapping Modals while the dirty document
        // registry asks its save/discard/cancel question.
        if (workspaceDocumentController.shouldPreventUnload(matches)) setArchivePrompt(undefined);
        const allowed = await requestWorkspaceDocumentLeave({
          reason: "switch-session",
          matches
        });
        if (!allowed) return;
      }
      const latest = controllerRef.current.state.snapshot.sessions.find((candidate) => candidate.id === pending.sessionId);
      if (latest !== undefined && (latest.state === "running" || latest.state === "waiting" || latest.state === "retrying")) {
        setArchivePrompt(undefined);
        onError(t("workspace.archiveRunningBlocked"));
        return;
      }
      await controllerRef.current.archiveSession(pending.sessionId, true);
      setArchivePrompt(undefined);
      if (pending.sessionId === session.id) {
        if (pending.neighborId === undefined) controllerRef.current.navigate({ kind: "session" });
        else activateSession(pending.neighborId);
      }
    } catch (error) {
      onError(messageOf(error, t("workspace.archiveFailed")));
    } finally {
      archiveBusyRef.current = false;
      setArchiveBusy(false);
    }
  }, [activateSession, archivePrompt, onError, session.id, t]);

  const createSession = useCallback(async (optionId: string): Promise<void> => {
    if (optionId !== backend.id) return;
    try {
      const allowed = await requestWorkspaceDocumentLeave({
        reason: "switch-session",
        matches: (identity) => identity.sessionId === session.id
      });
      if (!allowed) return;
      const sessionId = await controllerRef.current.createSession({
        targetId: target.id,
        name: t("session.newTaskName"),
        nativeStart: { kind: "fresh" },
        providerId: session.model?.providerId ?? "",
        modelId: session.model?.modelId ?? "",
        ...(session.effort === undefined ? {} : { effort: session.effort }),
        fastMode: session.fastMode,
        permissionMode: session.permissionMode,
        planMode: session.planMode
      });
      activateSession(sessionId);
    } catch (error) {
      onError(messageOf(error, t("workspace.createSessionFailed")));
    }
  }, [activateSession, backend.id, onError, session, t, target.id]);

  const disconnectFromFiles = useCallback(async (): Promise<void> => {
    const allowed = await requestWorkspaceDocumentLeave({
      reason: "switch-session",
      matches: (identity) => identity.sessionId === session.id && identity.workspaceId === workspace.id
    });
    if (allowed) navigationRef.current.onDisconnect();
  }, [session.id, workspace.id]);

  const stateLabel = workspaceSessionStateLabel(session.state, t);
  const sessionLabel = session.name.trim() || t("session.unnamed");
  const navigationDrawerOpen = compactLayout && navigation.open;

  return <>
    <SidebarFrame
      {...navigation}
      className="workspace-files-shell-sidebar"
      searchLabel={t("workspace.search")}
      server={controller.state.snapshot.server}
      probeRuntimeActivity={controller.probeRuntimeActivity}
      t={t}
      onDisconnect={() => { void disconnectFromFiles(); }}
      drawerRestoreFocus={takeNavigationReturnFocus}
      onHome={() => { void navigateAwayFromFiles({ kind: "session" }); }}
      onNewTask={() => { void navigateAwayFromFiles({ kind: "newSession" }); }}
      onSearch={() => {
        navigation.onExpand();
        (rootRef.current?.ownerDocument.defaultView ?? window).requestAnimationFrame(() => sidebarRef.current?.openSearch());
      }}
      expandedBody={<>
        <WorkspaceFilesSidebar
          ref={sidebarRef}
          className="workspace-files-shell-sidebar__body"
          workspaceId={workspace.id}
          workspaceRevision={workspace.revision}
          workspaceDisplayName={target.name || workspace.name}
          selectedPath={selectedPath}
          activeTargetId={target.id}
          projectOptions={projectOptions}
          labels={workspaceSidebarLabels(t)}
          documentActions={documentActions}
          loadDirectory={loadDirectory}
          loadFileIndex={loadFileIndex}
          searchWorkspace={searchWorkspace}
          onSelectFile={async ({ path }) => {
            const accepted = await activateFile(path);
            if (accepted && compactLayout) navigationRef.current.onCloseDrawer();
            return accepted;
          }}
          onOpenSearchMatch={async (match) => {
            const accepted = await activateFile(match.path, { search: match.query, line: match.line });
            if (accepted && compactLayout) navigationRef.current.onCloseDrawer();
            return accepted;
          }}
          onSelectProject={async (project) => {
            const accepted = await switchProject(project);
            if (accepted && compactLayout) navigationRef.current.onCloseDrawer();
            return accepted;
          }}
          onLeaveDocumentMode={() => navigateAwayFromFiles({ kind: "session", sessionId: session.id })}
        />
      </>}
      railBody={<>
        <nav className="sidebar__rail-sessions workspace-files-shell-rail" aria-label={t("workspace.files")}>
          <IconButton
            className="sidebar__rail-session is-active"
            aria-current="page"
            label={`${t("workspace.files")} · ${target.name || workspace.name}`}
            onClick={navigation.onExpand}
          ><FolderOpen aria-hidden="true" /></IconButton>
          <IconButton
            className="sidebar__rail-session"
            data-session-id={session.id}
            label={`${sessionLabel} · ${stateLabel}`}
            onClick={() => { void navigateAwayFromFiles({ kind: "session", sessionId: session.id }); }}
          ><StatusDot state={session.state} label={stateLabel} /><MessageSquare aria-hidden="true" /></IconButton>
        </nav>
      </>}
    />

    <div
      id="main-content"
      className="app__main workspace-files-shell-main"
      tabIndex={-1}
      aria-hidden={navigationDrawerOpen || undefined}
      inert={navigationDrawerOpen ? true : undefined}
    >
      {banners}
      <div ref={rootRef} className={cx("workspace-files-route", railDrag !== undefined && "is-resizing")} tabIndex={-1}>
        <section
          className="workspace-files-route__document"
          aria-hidden={chatOverlayOpen || undefined}
          inert={chatOverlayOpen ? true : undefined}
        >
          <WorkspaceFileTabsBar
            workspaceId={workspace.id}
            activePath={selectedPath}
            labels={workspaceFileTabLabels(t)}
            onActivate={(path) => { void activateFile(path); }}
            onActivateAfterClose={navigateFile}
            onClear={() => navigateFile(undefined)}
            onBeforeClose={(path) => guardAffectedDocument("close-file", path, false)}
            onCopyPath={async (path) => {
              try {
                const clipboard = rootRef.current?.ownerDocument.defaultView?.navigator.clipboard;
                if (clipboard === undefined) throw new Error(t("workspace.clipboardUnavailable"));
                await clipboard.writeText(path);
              } catch (error) {
                onError(messageOf(error, t("workspace.clipboardUnavailable")));
              }
            }}
            chatCollapsed={railCollapsed}
            onToggleChat={toggleRail}
            navigationOpen={navigation.open}
            onOpenNavigation={openNavigation}
          />
          <div className="workspace-files-route__body">
            {selectedPathResult.error === true
              ? <div className="workspace-file-body workspace-file-body__state is-error" role="alert">{t("workspace.invalidPath")}</div>
              : <WorkspaceFileBody
                  key={`${workspace.id}\u0000${selectedPath ?? ""}`}
                  controller={controller}
                  sessionId={session.id}
                  workspaceId={workspace.id}
                  path={selectedPath}
                  preview={previewState.workspaceId === workspace.id && previewState.path === selectedPath ? previewState.preview : undefined}
                  loading={previewState.workspaceId === workspace.id && previewState.path === selectedPath && previewState.loading}
                  error={previewState.workspaceId === workspace.id && previewState.path === selectedPath ? previewState.error : undefined}
                  canWrite={canWrite}
                  search={route.search}
                  line={route.line}
                  onSearchJumpConsumed={() => navigateFile(selectedPath)}
                  onSelectionQuote={onSelectionQuote === undefined ? undefined : (quote) => onSelectionQuote(session.id, quote)}
                  onImageToChat={onImageToChat === undefined ? undefined : (file) => onImageToChat(session.id, file)}
                />}
          </div>
          <InteractionPromptSlot className="workspace-files-route__interaction-slot" />
          {!railCollapsed && <div
            className="workspace-files-route__separator"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("workspace.resizeChat")}
            aria-valuemin={WORKSPACE_CHAT_RAIL_MIN_WIDTH}
            aria-valuemax={WORKSPACE_CHAT_RAIL_MAX_WIDTH}
            aria-valuenow={railWidth}
            tabIndex={0}
            onPointerDown={beginRailResize}
            onPointerMove={moveRailResize}
            onPointerUp={(event) => finishRailResize(event)}
            onPointerCancel={(event) => finishRailResize(event, true)}
            onLostPointerCapture={(event) => finishRailResize(event, true)}
            onDoubleClick={resetRailWidth}
            onKeyDown={railResizeKey}
          ><span /></div>}
        </section>

        {compactLayout && !railCollapsed && <button
          type="button"
          className="workspace-files-route__chat-scrim"
          aria-label={t("workspace.collapseChat")}
          onClick={closeCompactChat}
        />}
        <aside
          ref={chatRef}
          className={cx("workspace-files-route__chat", railDrag !== undefined && "is-dragging")}
          style={{ width: railCollapsed ? 0 : railWidth } as CSSProperties}
          aria-hidden={railCollapsed || undefined}
          inert={railCollapsed ? true : undefined}
          tabIndex={-1}
        >
          <WorkspaceSessionTabsBar
            activeSessionId={session.id}
            sessions={workdirSessions}
            labels={{ unnamed: t("session.unnamed"), close: (name) => t("workspace.closeSessionTab", { name }), create: t("workspace.createSession") }}
            createOptions={createOptions}
            onActivate={activateSession}
            onClose={requestArchive}
            onRename={(sessionId, name) => {
              void controllerRef.current.renameSession(sessionId, name).catch((error: unknown) => onError(messageOf(error, t("workspace.renameSessionFailed"))));
            }}
            onCreate={(optionId) => { void createSession(optionId); }}
          />
          <div className="workspace-files-route__chat-pane">{chatPane}</div>
        </aside>
      </div>
    </div>

    <Modal
      open={leavePrompt !== undefined}
      title={t("workspace.unsavedTitle")}
      description={leavePrompt === undefined ? undefined : t("workspace.unsavedLeave", { path: leavePrompt.input.document.path })}
      closeLabel={t("common.close")}
      size="small"
      showClose={false}
      dismissOnBackdrop={false}
      initialFocus={() => rootRef.current?.ownerDocument.querySelector<HTMLButtonElement>("[data-leave-cancel]") ?? null}
      onClose={() => settleLeavePrompt("cancel")}
    >
      <div className="workspace-files-leave-dialog">
        <div className="modal__actions">
          <Button tone="primary" onClick={() => settleLeavePrompt("save")}>{t("common.save")}</Button>
          <Button tone="secondary" onClick={() => settleLeavePrompt("discard")}>{t("workspace.discardAndSwitch")}</Button>
          <Button data-leave-cancel="" onClick={() => settleLeavePrompt("cancel")}>{t("common.cancel")}</Button>
        </div>
      </div>
    </Modal>

    <Modal
      open={archivePrompt !== undefined}
      title={t("workspace.archiveSessionTitle")}
      description={archivePrompt === undefined ? undefined : t("workspace.archiveSessionDescription", { name: archivePrompt.title })}
      closeLabel={t("common.close")}
      size="small"
      onClose={() => { if (!archiveBusy) setArchivePrompt(undefined); }}
    >
      <div className="modal__actions">
        <Button disabled={archiveBusy} onClick={() => setArchivePrompt(undefined)}>{t("common.cancel")}</Button>
        <Button tone="primary" disabled={archiveBusy} onClick={() => { void confirmArchive(); }}>{archiveBusy ? <Spinner label={t("common.working")} /> : null}{t("session.archive")}</Button>
      </div>
    </Modal>
  </>;
}

export function applyWorkspaceFileChangeToRoute(input: {
  readonly change: WorkspaceFileChangeView;
  readonly workspaceId: string;
  readonly selectedPath?: string;
  readonly isSelectedDirty: (path: string) => boolean;
  readonly refreshPreview: () => void;
  readonly navigateFile: (path: string | undefined) => void;
}): void {
  const { change, workspaceId, selectedPath } = input;
  if (change.kind === "overflow" || change.kind === "resync") return;
  if (change.kind === "created" || change.kind === "modified") {
    if (selectedPath !== undefined && change.path === selectedPath) input.refreshPreview();
    return;
  }
  if (change.kind === "renamed") {
    if (change.path === undefined || change.previousPath === undefined) return;
    const movedSelection = selectedPath === undefined
      ? undefined
      : rewriteWorkspaceSelectedPath(selectedPath, change.previousPath, change.path);
    if (movedSelection !== undefined && input.isSelectedDirty(selectedPath!)) {
      // Keep the old identity/tab until the user resolves the dirty draft. A
      // save will hit the existing revision/not-found conflict instead of
      // writing the draft into the renamed destination without consent.
      return;
    }
    workspaceOpenTabsStore.renameTabPrefix(workspaceId, change.previousPath, change.path);
    if (movedSelection !== undefined) input.navigateFile(movedSelection);
    else if (selectedPath === change.path) input.refreshPreview();
    return;
  }
  if (change.kind !== "deleted" || change.path === undefined) return;
  const liveTabs = workspaceOpenTabsStore.getTabs(workspaceId);
  const affectedTabs = liveTabs.filter((path) => workspacePathHasPrefix(path, change.path!));
  if (affectedTabs.length === 0 && (selectedPath === undefined || !workspacePathHasPrefix(selectedPath, change.path))) return;
  const selectedAffected = selectedPath !== undefined && workspacePathHasPrefix(selectedPath, change.path);
  const dirtySelected = selectedAffected && input.isSelectedDirty(selectedPath!);
  const closingTabs = dirtySelected ? affectedTabs.filter((path) => path !== selectedPath) : affectedTabs;
  const successor = selectedAffected && !dirtySelected && selectedPath !== undefined
    ? nextActiveWorkspaceTab(liveTabs, selectedPath, closingTabs)
    : undefined;
  workspaceOpenTabsStore.closeTabs(workspaceId, closingTabs);
  if (selectedAffected && !dirtySelected) input.navigateFile(successor);
}

export function rewriteWorkspaceSelectedPath(path: string, fromPath: string, toPath: string): string | undefined {
  if (path === fromPath) return toPath;
  const prefix = `${fromPath}/`;
  return path.startsWith(prefix) ? `${toPath}/${path.slice(prefix.length)}` : undefined;
}

function workspacePathHasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function workspaceSessions(
  sessions: readonly SessionView[],
  workspaceId: string,
  targets: readonly Pick<TargetView, "id" | "workspaceId">[]
): readonly SessionView[] {
  const targetIds = new Set(targets.filter((target) => target.workspaceId === workspaceId).map((target) => target.id));
  const priority: Readonly<Record<SessionView["state"], number>> = {
    running: 0,
    waiting: 1,
    retrying: 2,
    error: 3,
    idle: 4,
    closed: 5
  };
  return sessions
    .filter((candidate) => targetIds.has(candidate.targetId) && !candidate.archived && candidate.state !== "closed")
    .slice()
    .sort((left, right) => Number(right.pinned) - Number(left.pinned)
      || priority[left.state] - priority[right.state]
      || right.updatedAt - left.updatedAt
      || left.id.localeCompare(right.id, "en"));
}

/** Joins the capability snapshot into one switchable Files project per target. */
export function workspaceFilesProjectOptions(snapshot: Pick<AppSnapshot, "backends" | "targets" | "workspaces" | "sessions">): readonly WorkspaceFilesProjectOption[] {
  const filesBackends = new Set(snapshot.backends
    .filter((candidate) => candidate.capabilities.get("workspace.files")?.supported === true)
    .map((candidate) => candidate.id));
  const workspaces = new Map(snapshot.workspaces.map((candidate) => [candidate.id, candidate]));
  const sessionsByTarget = new Map<string, SessionView[]>();
  for (const candidate of snapshot.sessions) {
    if (candidate.archived || candidate.state === "closed") continue;
    const values = sessionsByTarget.get(candidate.targetId) ?? [];
    values.push(candidate);
    sessionsByTarget.set(candidate.targetId, values);
  }
  const projects: WorkspaceFilesProjectOption[] = [];
  for (const candidate of snapshot.targets) {
    if (!filesBackends.has(candidate.backendId)) continue;
    const candidateWorkspace = workspaces.get(candidate.workspaceId);
    if (candidateWorkspace === undefined || candidateWorkspace.targetId !== candidate.id) continue;
    const activeSessions = sessionsByTarget.get(candidate.id) ?? [];
    if (activeSessions.length === 0) continue;
    const latest = activeSessions.slice().sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id, "en"))[0];
    if (latest === undefined || !filesBackends.has(latest.backendId)) continue;
    projects.push({
      targetId: candidate.id,
      workspaceId: candidateWorkspace.id,
      sessionId: latest.id,
      displayName: candidate.name.trim() || candidateWorkspace.name,
      activeSessionCount: activeSessions.length
    });
  }
  return projects;
}

function mapWorkspaceEntry(entry: WorkspaceEntryView): WorkspaceFilesEntryView {
  return {
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    ...(entry.size === undefined ? {} : { size: entry.size }),
    ...(entry.modifiedAt === undefined ? {} : { modifiedAt: entry.modifiedAt }),
    ...(entry.revision === undefined ? {} : { revision: entry.revision }),
    ...(entry.status === undefined ? {} : { status: entry.status }),
    generated: entry.generated
  };
}

async function freshWorkspaceEntry(
  controller: Pick<AppController, "listWorkspaceEntries">,
  workspaceId: string,
  path: string
): Promise<WorkspaceFilesEntryView> {
  const canonical = canonicalWorkspaceRelativePath(path);
  const parent = workspacePathParent(canonical);
  const entry = normalizeWorkspaceDirectoryEntries(
    parent,
    (await controller.listWorkspaceEntries(workspaceId, parent, DOCUMENT_TREE_LISTING)).map(mapWorkspaceEntry)
  )
    .find((candidate) => candidate.path === canonical);
  if (entry === undefined) throw new Error("The workspace entry no longer exists.");
  return entry;
}

function safeWorkspacePath(value: string | undefined): { readonly path?: string; readonly error?: true } {
  if (value === undefined || value === "") return {};
  try {
    return { path: canonicalWorkspaceRelativePath(value) };
  } catch {
    return { error: true };
  }
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function browserMatches(query: string): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia?.(query).matches === true;
  } catch {
    return false;
  }
}

function workspaceChatOverlayHasHigherPrioritySurface(ownerDocument: Document): boolean {
  return ownerDocument.body.classList.contains("modal-open")
    || ownerDocument.querySelector("[role='dialog'][aria-modal='true'], .workspace-image-lightbox, .workspace-mermaid-lightbox, .workspace-file-tab-menu") !== null;
}

function writeStorage(key: string, value: string): void {
  try {
    browserStorage()?.setItem(key, value);
  } catch {
    // Privacy modes and quota failure degrade to the current in-memory state.
  }
}

export function abortableWorkspaceWatchDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function workspaceFileTabLabels(t: Translator) {
  return {
    close: (name: string) => t("workspace.closeFileTab", { name }),
    copyPath: t("workspace.copyRelativePath"),
    closeTab: t("workspace.closeTab"),
    closeOthers: t("workspace.closeOtherTabs"),
    closeRight: t("workspace.closeTabsRight"),
    closeLeft: t("workspace.closeTabsLeft"),
    closeAll: t("workspace.closeAllTabs"),
    collapseChat: t("workspace.collapseChat"),
    expandChat: t("workspace.expandChat"),
    openNavigation: t("a11y.openNavigation")
  };
}

function workspaceSessionStateLabel(state: SessionView["state"], t: Translator): string {
  switch (state) {
    case "running": return t("session.running");
    case "waiting": return t("session.waiting");
    case "retrying": return t("session.running");
    case "error": return t("session.error");
    case "idle": return t("session.idle");
    case "closed": return t("session.closed");
  }
}

function workspaceSidebarLabels(t: Translator) {
  return {
    files: t("workspace.files"),
    back: t("workspace.filesBack"),
    switchProject: t("workspace.switchProject"),
    activeSessionCount: (count: number) => t("workspace.activeSessionCount", { count }),
    search: t("workspace.search"),
    exitSearch: t("workspace.exitSearch"),
    collapseAll: t("workspace.collapseFolders"),
    refresh: t("workspace.refreshFiles"),
    filterPlaceholder: t("workspace.filterFiles"),
    clearFilter: t("workspace.clearFileFilter"),
    loadingTree: t("workspace.loadingFiles"),
    emptyTree: t("workspace.emptyFiles"),
    emptyDirectory: t("workspace.emptyDirectory"),
    loadFailed: t("workspace.filesLoadFailed"),
    retry: t("common.retry"),
    filterLoading: t("workspace.indexingFiles"),
    filterFailed: t("workspace.fileIndexFailed"),
    filterEmpty: t("workspace.filterEmpty"),
    filterTruncated: t("workspace.filterTruncated"),
    searchPlaceholder: t("workspace.searchPlaceholder"),
    matchCase: t("workspace.matchCase"),
    searchEmpty: t("workspace.searchEmpty"),
    searching: t("workspace.searching"),
    searchFailed: t("workspace.searchFailed"),
    searchNoResults: t("workspace.noMatches"),
    newFile: t("workspace.newFile"),
    newFolder: t("workspace.newFolder"),
    rename: t("workspace.rename"),
    delete: t("common.delete"),
    copyRelativePath: t("workspace.copyRelativePath"),
    cancel: t("common.cancel"),
    confirm: t("common.confirm"),
    name: t("workspace.entryName"),
    invalidName: t("workspace.invalidEntryName"),
    actionFailed: t("workspace.actionFailed"),
    copied: t("workspace.pathCopied"),
    dismiss: t("common.dismiss"),
    contextMenu: t("workspace.fileActions"),
    searchSummary: (matches: number, files: number) => t("workspace.searchSummary", { matches, files }),
    searchTruncated: (matches: number) => t("workspace.searchTruncated", { matches }),
    deleteConfirmation: (name: string) => t("workspace.deleteEntryConfirmation", { name })
  };
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject
} from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Clipboard,
  File,
  FileCode2,
  FileImage,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  ListTree,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X
} from "lucide-react";

import { IconButton, cx } from "./ui.js";
import {
  WORKSPACE_ENTRY_DRAG_MIME,
  WORKSPACE_FILTER_RESULT_LIMIT,
  canonicalWorkspaceBasename,
  canonicalWorkspaceRelativePath,
  createWorkspaceEntryDragPayload,
  encodeWorkspaceEntryDragPayload,
  filterWorkspaceFiles,
  flattenWorkspaceTree,
  groupWorkspaceSearchMatches,
  joinWorkspacePath,
  loadWorkspaceExpandedPaths,
  normalizeWorkspaceDirectoryEntries,
  normalizeWorkspaceFileIndex,
  removeWorkspacePathPrefix,
  resolveWorkspaceTreeKeyboardAction,
  rewriteWorkspacePathPrefix,
  saveWorkspaceExpandedPaths,
  workspacePathAncestors,
  workspacePathBasename,
  workspacePathParent,
  workspaceSearchMatchIdentity,
  type WorkspaceDirectoryView,
  type WorkspaceEntryDragPayload,
  type WorkspaceFilesEntryView,
  type WorkspaceFilesSearchMatch,
  type WorkspaceFilesSearchSubmatch,
  type WorkspaceFilesStorage,
  type WorkspaceVisibleTreeRow
} from "./workspace-tree-state.js";
import "./workspace-files-sidebar.css";

const SEARCH_DEBOUNCE_MS = 250;

export interface WorkspaceFilesSearchRequest {
  readonly workspaceId: string;
  readonly query: string;
  readonly caseSensitive: boolean;
}

export interface WorkspaceFilesSearchOpenRequest extends WorkspaceFilesSearchMatch {
  readonly workspaceId: string;
  readonly query: string;
  readonly caseSensitive: boolean;
}

export interface WorkspaceFilesFileIndexPage {
  readonly paths: readonly string[];
  readonly truncated: boolean;
  readonly revision?: string;
}

export type WorkspaceFilesSearchEvent =
  | { readonly kind: "match"; readonly match: WorkspaceFilesSearchMatch }
  | {
      readonly kind: "end";
      readonly truncated: boolean;
      readonly totalMatches: number;
      readonly totalFiles: number;
      readonly revision: string;
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
    };

export interface WorkspaceFilesProjectOption {
  readonly targetId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly activeSessionCount: number;
}

export interface WorkspaceFilesDocumentCapabilities {
  readonly createFile?: boolean;
  readonly createDirectory?: boolean;
  readonly rename?: boolean;
  readonly delete?: boolean;
  readonly copyRelativePath?: boolean;
}

/**
 * Write actions belong only to the formal document host. Inspector must not
 * pass this object, so its read-only file browser cannot accidentally acquire
 * structural workspace mutations.
 */
export interface WorkspaceFilesDocumentActions {
  readonly capabilities: WorkspaceFilesDocumentCapabilities;
  readonly createFile?: (input: { readonly workspaceId: string; readonly parentPath: string; readonly path: string }) => Promise<void>;
  readonly createDirectory?: (input: { readonly workspaceId: string; readonly parentPath: string; readonly path: string }) => Promise<void>;
  /** False means the formal document host cancelled at its dirty-leave gate. */
  readonly rename?: (input: { readonly workspaceId: string; readonly fromPath: string; readonly toPath: string; readonly kind: WorkspaceFilesEntryView["kind"] }) => Promise<void | boolean>;
  /** False means the formal document host cancelled at its dirty-leave gate. */
  readonly delete?: (input: { readonly workspaceId: string; readonly path: string; readonly kind: WorkspaceFilesEntryView["kind"] }) => Promise<void | boolean>;
  readonly copyRelativePath?: (input: { readonly workspaceId: string; readonly path: string }) => Promise<void>;
}

export interface WorkspaceFilesSidebarLabels {
  readonly files: string;
  readonly back: string;
  readonly switchProject: string;
  readonly activeSessionCount: (count: number) => string;
  readonly search: string;
  readonly exitSearch: string;
  readonly collapseAll: string;
  readonly refresh: string;
  readonly filterPlaceholder: string;
  readonly clearFilter: string;
  readonly loadingTree: string;
  readonly emptyTree: string;
  readonly emptyDirectory: string;
  readonly loadFailed: string;
  readonly retry: string;
  readonly filterLoading: string;
  readonly filterFailed: string;
  readonly filterEmpty: string;
  readonly filterTruncated: string;
  readonly searchPlaceholder: string;
  readonly matchCase: string;
  readonly searchEmpty: string;
  readonly searching: string;
  readonly searchFailed: string;
  readonly searchNoResults: string;
  readonly newFile: string;
  readonly newFolder: string;
  readonly rename: string;
  readonly delete: string;
  readonly copyRelativePath: string;
  readonly cancel: string;
  readonly confirm: string;
  readonly name: string;
  readonly invalidName: string;
  readonly actionFailed: string;
  readonly copied: string;
  readonly dismiss: string;
  readonly contextMenu: string;
  readonly searchSummary: (matches: number, files: number) => string;
  readonly searchTruncated: (matches: number) => string;
  readonly deleteConfirmation: (name: string) => string;
}

export interface WorkspaceFilesSidebarProps {
  readonly workspaceId: string;
  /** Projection fence used to invalidate the lazy filename index after watcher updates. */
  readonly workspaceRevision?: string;
  readonly workspaceDisplayName: string;
  readonly selectedPath?: string;
  readonly activeTargetId?: string;
  readonly projectOptions?: readonly WorkspaceFilesProjectOption[];
  readonly labels?: Partial<WorkspaceFilesSidebarLabels>;
  readonly className?: string;
  readonly storage?: WorkspaceFilesStorage;
  readonly initialDirectories?: ReadonlyMap<string, readonly WorkspaceFilesEntryView[]>;
  readonly initialFileIndex?: WorkspaceFilesFileIndexPage;
  readonly searchFocusToken?: number;
  readonly allowEntryDrag?: boolean;
  readonly documentActions?: WorkspaceFilesDocumentActions;
  readonly loadDirectory: (input: { readonly workspaceId: string; readonly parentPath: string }) => Promise<readonly WorkspaceFilesEntryView[]>;
  readonly loadFileIndex?: (input: { readonly workspaceId: string }, signal: AbortSignal) => Promise<WorkspaceFilesFileIndexPage>;
  readonly searchWorkspace: (input: WorkspaceFilesSearchRequest, signal: AbortSignal) => AsyncIterable<WorkspaceFilesSearchEvent>;
  readonly onSelectFile: (input: { readonly workspaceId: string; readonly path: string }) => void | boolean | Promise<void | boolean>;
  readonly onOpenSearchMatch: (input: WorkspaceFilesSearchOpenRequest) => void | boolean | Promise<void | boolean>;
  /** The route host owns the one unified dirty-leave guard. */
  readonly onLeaveDocumentMode: () => void | boolean | Promise<void | boolean>;
  readonly onSelectProject?: (project: WorkspaceFilesProjectOption) => void | boolean | Promise<void | boolean>;
  readonly onDragEntry?: (payload: WorkspaceEntryDragPayload, dataTransfer: DataTransfer) => void;
}

export interface WorkspaceFilesSidebarHandle {
  readonly revealPath: (path: string) => Promise<void>;
  readonly openSearch: () => void;
  readonly retryRoot: () => Promise<void>;
  readonly invalidateChange: (change: WorkspaceFilesExternalChange) => Promise<void>;
}

export interface WorkspaceFilesExternalChange {
  readonly kind: "created" | "modified" | "deleted" | "renamed" | "overflow" | "resync";
  readonly path?: string;
  readonly previousPath?: string;
}

interface DirectoryTreeController {
  readonly directories: ReadonlyMap<string, WorkspaceDirectoryView>;
  readonly expanded: ReadonlySet<string>;
  readonly rows: readonly WorkspaceVisibleTreeRow[];
  readonly loadDirectory: (path: string, force?: boolean) => Promise<boolean>;
  readonly toggleDirectory: (path: string) => void;
  readonly collapseAll: () => void;
  readonly refresh: () => Promise<void>;
  readonly revealPath: (path: string) => Promise<void>;
  readonly afterRename: (oldPath: string, newPath: string, directory: boolean) => Promise<void>;
  readonly afterDelete: (path: string, directory: boolean) => Promise<void>;
  readonly invalidateChange: (change: WorkspaceFilesExternalChange) => Promise<void>;
}

interface ContextMenuState {
  readonly entry?: WorkspaceFilesEntryView;
  readonly x: number;
  readonly y: number;
  readonly ownerDocument: Document;
  readonly returnFocus?: HTMLElement;
}

type WorkspaceFileOperation =
  | { readonly kind: "createFile"; readonly parentPath: string; readonly ownerDocument: Document }
  | { readonly kind: "createDirectory"; readonly parentPath: string; readonly ownerDocument: Document }
  | { readonly kind: "rename"; readonly entry: WorkspaceFilesEntryView; readonly ownerDocument: Document }
  | { readonly kind: "delete"; readonly entry: WorkspaceFilesEntryView; readonly ownerDocument: Document };

interface SearchViewState {
  readonly status: "idle" | "loading" | "done" | "error";
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly matches: readonly WorkspaceFilesSearchMatch[];
  readonly truncated: boolean;
  readonly totalMatches: number;
  readonly totalFiles: number;
  readonly revision?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

interface FileIndexViewState {
  readonly status: "idle" | "loading" | "loaded" | "error";
  readonly paths: readonly string[];
  readonly truncated: boolean;
  readonly revision?: string;
}

interface FileIndexCacheSnapshot extends WorkspaceFilesFileIndexPage {
  readonly fetchedAt: number;
}

const WORKSPACE_FILE_INDEX_CACHE_TTL_MS = 30_000;
const WORKSPACE_FILE_INDEX_TRUNCATED_CACHE_TTL_MS = 5 * 60_000;
const workspaceFileIndexCache = new Map<string, FileIndexCacheSnapshot>();

const EMPTY_SEARCH: SearchViewState = {
  status: "idle",
  query: "",
  caseSensitive: false,
  matches: [],
  truncated: false,
  totalMatches: 0,
  totalFiles: 0
};

const DEFAULT_LABELS: WorkspaceFilesSidebarLabels = {
  files: "Files",
  back: "Back to task",
  switchProject: "Switch project",
  activeSessionCount: (count) => `${count} active`,
  search: "Search files",
  exitSearch: "Exit search",
  collapseAll: "Collapse all folders",
  refresh: "Refresh files",
  filterPlaceholder: "Filter files",
  clearFilter: "Clear file filter",
  loadingTree: "Loading files…",
  emptyTree: "This workspace is empty.",
  emptyDirectory: "This folder is empty.",
  loadFailed: "Files could not be loaded.",
  retry: "Retry",
  filterLoading: "Indexing files…",
  filterFailed: "The file index could not be loaded.",
  filterEmpty: "No matching files.",
  filterTruncated: "More files match. Refine the filter.",
  searchPlaceholder: "Search in files",
  matchCase: "Match case",
  searchEmpty: "Enter a query to search workspace text.",
  searching: "Searching…",
  searchFailed: "Workspace search failed.",
  searchNoResults: "No matching text.",
  newFile: "New file",
  newFolder: "New folder",
  rename: "Rename",
  delete: "Delete",
  copyRelativePath: "Copy relative path",
  cancel: "Cancel",
  confirm: "Confirm",
  name: "Name",
  invalidName: "Enter one valid relative name.",
  actionFailed: "The workspace action failed.",
  copied: "Relative path copied.",
  dismiss: "Dismiss",
  contextMenu: "File actions",
  searchSummary: (matches, files) => `${matches} results in ${files} files`,
  searchTruncated: (matches) => `${matches}+ results. Refine the query.`,
  deleteConfirmation: (name) => `Delete ${name}? This cannot be undone.`
};

const WorkspaceFilesSidebarBody = forwardRef<WorkspaceFilesSidebarHandle, WorkspaceFilesSidebarProps>(function WorkspaceFilesSidebarBody({
  workspaceId,
  workspaceRevision,
  workspaceDisplayName,
  selectedPath,
  activeTargetId,
  projectOptions = [],
  labels: labelOverrides,
  className,
  storage,
  initialDirectories,
  initialFileIndex,
  searchFocusToken,
  allowEntryDrag = true,
  documentActions,
  loadDirectory,
  loadFileIndex,
  searchWorkspace,
  onSelectFile,
  onOpenSearchMatch,
  onLeaveDocumentMode,
  onSelectProject,
  onDragEntry
}, forwardedRef): JSX.Element {
  const labels = useMemo(() => ({ ...DEFAULT_LABELS, ...labelOverrides }), [labelOverrides]);
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<"tree" | "search">("tree");
  const [filterQuery, setFilterQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  const [operation, setOperation] = useState<WorkspaceFileOperation>();
  const [focusedPath, setFocusedPath] = useState<string>();
  const reportRevealFailure = useCallback((): void => setNotice(labels.loadFailed), [labels.loadFailed]);
  const tree = useWorkspaceDirectoryTree({
    workspaceId,
    selectedPath,
    storage,
    initialDirectories,
    loadDirectory,
    rootRef,
    rowRefs,
    onRevealFailure: reportRevealFailure
  });
  const fileIndex = useWorkspaceFileIndex({ workspaceId, revision: workspaceRevision, initialFileIndex, loadFileIndex, enabled: filterQuery.trim() !== "" });
  const search = useWorkspaceSearch({
    workspaceId,
    query: searchQuery,
    caseSensitive,
    searchWorkspace,
    rootRef
  });

  const openSearch = useCallback((): void => {
    setMode("search");
    const ownerWindow = rootRef.current?.ownerDocument.defaultView;
    ownerWindow?.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);
  }, []);

  const closeSearch = useCallback((): void => {
    setMode("tree");
    const ownerWindow = rootRef.current?.ownerDocument.defaultView;
    ownerWindow?.requestAnimationFrame(() => searchButtonRef.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    if (mode !== "search") return;
    const ownerDocument = rootRef.current?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      // Give the document-scoped find bar and modal overlays the first
      // Escape. They own capture-phase dismissal while they are present.
      if (ownerDocument.querySelector("[data-doc-search-bar], [role='dialog'][aria-modal='true'], .workspace-files-context-menu, .workspace-image-lightbox, .workspace-mermaid-lightbox") !== null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeSearch();
    };
    ownerWindow.addEventListener("keydown", keydown, true);
    return () => ownerWindow.removeEventListener("keydown", keydown, true);
  }, [closeSearch, mode]);

  useImperativeHandle(forwardedRef, () => ({
    revealPath: tree.revealPath,
    openSearch,
    retryRoot: async () => { await tree.loadDirectory("", true); },
    invalidateChange: async (change) => {
      fileIndex.invalidate();
      await tree.invalidateChange(change);
    }
  }), [fileIndex.invalidate, openSearch, tree.invalidateChange, tree.loadDirectory, tree.revealPath]);

  useEffect(() => {
    setMode("tree");
    setFilterQuery("");
    setSearchQuery("");
    setCaseSensitive(false);
    setNotice(undefined);
    setContextMenu(undefined);
    setOperation(undefined);
  }, [workspaceId]);

  useEffect(() => {
    if (searchFocusToken === undefined) return;
    openSearch();
  }, [openSearch, searchFocusToken]);

  useEffect(() => {
    if (contextMenu === undefined) return;
    const close = (): void => setContextMenu(undefined);
    contextMenu.ownerDocument.addEventListener("pointerdown", close);
    return () => {
      contextMenu.ownerDocument.removeEventListener("pointerdown", close);
    };
  }, [contextMenu]);

  const closeContextMenu = useCallback((restoreFocus: boolean): void => {
    setContextMenu((current) => {
      if (restoreFocus && current !== undefined) {
        const fallbackPath = current.entry?.path;
        current.ownerDocument.defaultView?.requestAnimationFrame(() => {
          const preferred = current.returnFocus;
          const target = preferred?.isConnected === true && preferred.closest("[inert], [aria-hidden='true']") === null
            ? preferred
            : fallbackPath === undefined ? searchButtonRef.current : rowRefs.current.get(fallbackPath);
          target?.focus({ preventScroll: true });
        });
      }
      return undefined;
    });
  }, []);

  const visibleRows = tree.rows;
  const canonicalSelectedPath = useMemo(() => safeCanonicalPath(selectedPath), [selectedPath]);
  const effectiveFocusPath = visibleRows.some((row) => row.entry.path === focusedPath)
    ? focusedPath
    : visibleRows.some((row) => row.entry.path === canonicalSelectedPath)
      ? canonicalSelectedPath
      : visibleRows[0]?.entry.path;

  useEffect(() => {
    if (effectiveFocusPath !== undefined && effectiveFocusPath !== focusedPath) setFocusedPath(effectiveFocusPath);
  }, [effectiveFocusPath, focusedPath]);

  const selectFile = useCallback(async (path: string): Promise<boolean> => {
    const canonical = canonicalWorkspaceRelativePath(path);
    setNotice(undefined);
    try {
      return await onSelectFile({ workspaceId, path: canonical }) !== false;
    } catch {
      setNotice(labels.actionFailed);
      return false;
    }
  }, [labels.actionFailed, onSelectFile, workspaceId]);

  const handleTreeKey = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, row: WorkspaceVisibleTreeRow): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const action = resolveWorkspaceTreeKeyboardAction(visibleRows, row.entry.path, event.key, tree.expanded);
    if (action === undefined) return;
    event.preventDefault();
    if (action.togglePath !== undefined) tree.toggleDirectory(action.togglePath);
    if (action.selectPath !== undefined) void selectFile(action.selectPath);
    if (action.focusPath !== undefined) {
      setFocusedPath(action.focusPath);
      rowRefs.current.get(action.focusPath)?.focus({ preventScroll: true });
    }
  }, [selectFile, tree, visibleRows]);

  const indexedPaths = fileIndex.status === "loaded"
    ? fileIndex.paths
    : visibleRows.filter((row) => row.entry.kind === "file").map((row) => row.entry.path);
  const filteredPaths = useMemo(
    () => filterWorkspaceFiles(filterQuery, indexedPaths),
    [filterQuery, indexedPaths]
  );
  const filterTruncated = fileIndex.truncated || filteredPaths.length >= WORKSPACE_FILTER_RESULT_LIMIT;

  const openContextMenu = useCallback((event: ReactMouseEvent, entry?: WorkspaceFilesEntryView): void => {
    if (!hasWorkspaceContextActions(documentActions, entry)) return;
    event.preventDefault();
    event.stopPropagation();
    const ownerDocument = event.currentTarget.ownerDocument;
    const currentTarget = event.currentTarget as HTMLElement;
    const activeElement = ownerDocument.activeElement as HTMLElement | null;
    const returnFocus = currentTarget.matches("[data-workspace-tree-row]")
      ? currentTarget
      : typeof activeElement?.focus === "function" ? activeElement : undefined;
    const position = clampWorkspaceFilesMenuPosition(
      event.clientX,
      event.clientY,
      ownerDocument.defaultView?.innerWidth ?? event.clientX + 240,
      ownerDocument.defaultView?.innerHeight ?? event.clientY + 260
    );
    setContextMenu({ entry, ownerDocument, returnFocus, ...position });
  }, [documentActions]);

  const startDrag = useCallback((event: DragEvent<HTMLButtonElement>, entry: WorkspaceFilesEntryView): void => {
    if (!allowEntryDrag) {
      event.preventDefault();
      return;
    }
    const payload = createWorkspaceEntryDragPayload(workspaceId, entry);
    event.dataTransfer.effectAllowed = "copy";
    if (onDragEntry !== undefined) {
      onDragEntry(payload, event.dataTransfer);
      return;
    }
    event.dataTransfer.setData(WORKSPACE_ENTRY_DRAG_MIME, encodeWorkspaceEntryDragPayload(payload));
    event.dataTransfer.setData("text/plain", payload.path);
  }, [allowEntryDrag, onDragEntry, workspaceId]);

  const leaveDocumentMode = useCallback(async (): Promise<void> => {
    setNotice(undefined);
    try { await onLeaveDocumentMode(); } catch { setNotice(labels.actionFailed); }
  }, [labels.actionFailed, onLeaveDocumentMode]);

  const selectProject = useCallback(async (project: WorkspaceFilesProjectOption): Promise<void> => {
    if (project.targetId === activeTargetId || onSelectProject === undefined) return;
    setNotice(undefined);
    try { await onSelectProject(project); } catch { setNotice(labels.actionFailed); }
  }, [activeTargetId, labels.actionFailed, onSelectProject]);

  const openSearchMatch = useCallback(async (match: WorkspaceFilesSearchMatch): Promise<void> => {
    setNotice(undefined);
    try {
      const accepted = await onOpenSearchMatch({
        ...match,
        workspaceId,
        query: search.state.query,
        caseSensitive: search.state.caseSensitive
      });
      if (accepted !== false) await tree.revealPath(match.path);
    } catch {
      setNotice(labels.actionFailed);
    }
  }, [labels.actionFailed, onOpenSearchMatch, search.state.caseSensitive, search.state.query, tree, workspaceId]);

  const selectFilteredPath = useCallback(async (path: string): Promise<void> => {
    if (!(await selectFile(path))) return;
    setFilterQuery("");
    await tree.revealPath(path);
  }, [selectFile, tree]);

  const executeOperation = useCallback(async (active: WorkspaceFileOperation, rawName?: string): Promise<void> => {
    if (documentActions === undefined) throw new Error("Document actions are unavailable.");
    if (active.kind === "createFile" || active.kind === "createDirectory") {
      const name = canonicalWorkspaceBasename(rawName?.trim() ?? "");
      const path = joinWorkspacePath(active.parentPath, name);
      if (active.kind === "createFile") {
        if (!canDocumentAction(documentActions, "createFile") || documentActions.createFile === undefined) throw new Error("Create file is unavailable.");
        await documentActions.createFile({ workspaceId, parentPath: active.parentPath, path });
      } else {
        if (!canDocumentAction(documentActions, "createDirectory") || documentActions.createDirectory === undefined) throw new Error("Create directory is unavailable.");
        await documentActions.createDirectory({ workspaceId, parentPath: active.parentPath, path });
      }
      fileIndex.invalidate();
      await tree.loadDirectory(active.parentPath, true);
      if (active.kind === "createFile") await selectFile(path);
      return;
    }
    if (active.kind === "rename") {
      if (!canDocumentAction(documentActions, "rename") || documentActions.rename === undefined) throw new Error("Rename is unavailable.");
      const name = canonicalWorkspaceBasename(rawName?.trim() ?? "");
      const toPath = joinWorkspacePath(workspacePathParent(active.entry.path), name);
      if (toPath === active.entry.path) return;
      const accepted = await documentActions.rename({ workspaceId, fromPath: active.entry.path, toPath, kind: active.entry.kind });
      if (accepted === false) return;
      fileIndex.invalidate();
      await tree.afterRename(active.entry.path, toPath, active.entry.kind === "directory");
      return;
    }
    if (!canDocumentAction(documentActions, "delete") || documentActions.delete === undefined) throw new Error("Delete is unavailable.");
    const accepted = await documentActions.delete({ workspaceId, path: active.entry.path, kind: active.entry.kind });
    if (accepted === false) return;
    fileIndex.invalidate();
    await tree.afterDelete(active.entry.path, active.entry.kind === "directory");
  }, [documentActions, fileIndex, selectFile, tree, workspaceId]);

  const copyRelativePath = useCallback(async (entry: WorkspaceFilesEntryView): Promise<void> => {
    closeContextMenu(true);
    if (!canDocumentAction(documentActions, "copyRelativePath") || documentActions?.copyRelativePath === undefined) return;
    try {
      await documentActions.copyRelativePath({ workspaceId, path: canonicalWorkspaceRelativePath(entry.path) });
      setNotice(labels.copied);
    } catch {
      setNotice(labels.actionFailed);
    }
  }, [closeContextMenu, documentActions, labels.actionFailed, labels.copied, workspaceId]);

  const beginOperation = useCallback((next: WorkspaceFileOperation): void => {
    closeContextMenu(false);
    setNotice(undefined);
    if ((next.kind === "createFile" || next.kind === "createDirectory")
      && next.parentPath !== ""
      && !tree.expanded.has(next.parentPath)) tree.toggleDirectory(next.parentPath);
    setOperation(next);
  }, [closeContextMenu, tree]);

  const cancelOperation = useCallback((active: WorkspaceFileOperation): void => {
    setOperation((current) => current === active ? undefined : current);
    const focusPath = active.kind === "rename"
      ? active.entry.path
      : active.kind === "createFile" || active.kind === "createDirectory"
        ? active.parentPath
        : active.entry.path;
    active.ownerDocument.defaultView?.requestAnimationFrame(() => {
      (focusPath === "" ? searchButtonRef.current : rowRefs.current.get(focusPath))?.focus({ preventScroll: true });
    });
  }, []);

  const rootDirectory = tree.directories.get("");
  const rootLoading = rootDirectory === undefined || (rootDirectory.status === "loading" && rootDirectory.entries.length === 0);
  const ownerDocument = contextMenu?.ownerDocument;
  const inlineOperation = operation !== undefined && operation.kind !== "delete" ? operation : undefined;
  const rootPending = inlineOperation !== undefined
    && inlineOperation.kind !== "rename"
    && inlineOperation.parentPath === "";
  const canSwitchProject = onSelectProject !== undefined
    && projectOptions.some((project) => project.targetId !== activeTargetId);

  return <div
    ref={rootRef}
    className={cx("workspace-files-sidebar", className)}
    aria-label={labels.files}
    data-workspace-id={workspaceId}
  >
    <div className="workspace-files-sidebar__back-slot">
      <button type="button" onClick={() => { void leaveDocumentMode(); }}><ArrowLeft aria-hidden="true" /><span>{labels.back}</span></button>
    </div>

    <header className="workspace-files-sidebar__header">
      <div className="workspace-files-sidebar__title">
        {mode === "search" ? <><strong>{labels.search}</strong><span className="is-secondary">{workspaceDisplayName}</span></>
          : canSwitchProject ? <WorkspaceFilesProjectSwitcher
              activeTargetId={activeTargetId}
              displayName={workspaceDisplayName}
              labels={labels}
              projects={projectOptions}
              onSelect={selectProject}
            />
            : <span>{workspaceDisplayName}</span>}
      </div>
      <div className="workspace-files-sidebar__actions">
        {mode === "search" ? <IconButton label={labels.exitSearch} onClick={closeSearch}><X aria-hidden="true" /></IconButton> : <>
          <IconButton buttonRef={searchButtonRef} label={labels.search} onClick={openSearch}><Search aria-hidden="true" /></IconButton>
          <IconButton label={labels.collapseAll} onClick={tree.collapseAll}><ChevronsDownUp aria-hidden="true" /></IconButton>
          <IconButton label={labels.refresh} onClick={() => { void tree.refresh(); fileIndex.refresh(); }}><RefreshCw aria-hidden="true" /></IconButton>
        </>}
      </div>
    </header>

    {notice !== undefined && <div className="workspace-files-sidebar__notice" role="status"><span>{notice}</span><IconButton label={labels.dismiss} onClick={() => setNotice(undefined)}><X aria-hidden="true" /></IconButton></div>}

    <div className="workspace-files-sidebar__body">
      <section className={cx("workspace-files-sidebar__tree-mode", mode !== "tree" && "is-hidden")} aria-hidden={mode !== "tree"}>
        <WorkspaceFileFilter value={filterQuery} labels={labels} onChange={setFilterQuery} />
        {filterQuery !== "" ? <WorkspaceFilterResults
          query={filterQuery}
          paths={filteredPaths}
          state={fileIndex}
          truncated={filterTruncated}
          selectedPath={canonicalSelectedPath}
          labels={labels}
          onRetry={fileIndex.retry}
          onSelect={selectFilteredPath}
        /> : <div
          className="workspace-files-tree"
          role="tree"
          aria-label={labels.files}
          aria-busy={rootLoading}
          onContextMenu={(event) => {
            if ((event.target as Element | null)?.closest("[data-workspace-tree-row]") === null) openContextMenu(event);
          }}
        >
          {rootLoading && <WorkspaceLoadingState label={labels.loadingTree} />}
          {rootDirectory?.status === "error" && <WorkspaceLoadError label={labels.loadFailed} retryLabel={labels.retry} onRetry={() => tree.loadDirectory("", true)} />}
          {!rootLoading && rootDirectory?.status !== "error" && visibleRows.length === 0 && !rootPending && <div className="workspace-files-sidebar__empty">{labels.emptyTree}</div>}
          {rootPending && <WorkspaceFilesInlineInput
            operation={inlineOperation}
            depth={0}
            labels={labels}
            onCancel={() => cancelOperation(inlineOperation)}
            onError={setNotice}
            onSubmit={(name) => executeOperation(inlineOperation, name).then(() => setOperation(undefined))}
          />}
          {visibleRows.map((row) => {
            const directory = row.entry.kind === "directory" ? tree.directories.get(row.entry.path) : undefined;
            const expanded = row.entry.kind === "directory" && tree.expanded.has(row.entry.path);
            const loading = directory?.status === "loading";
            if (inlineOperation?.kind === "rename" && inlineOperation.entry.path === row.entry.path) {
              return <WorkspaceFilesInlineInput
                key={`rename:${row.entry.path}`}
                operation={inlineOperation}
                depth={row.depth}
                labels={labels}
                onCancel={() => cancelOperation(inlineOperation)}
                onError={setNotice}
                onSubmit={(name) => executeOperation(inlineOperation, name).then(() => setOperation(undefined))}
              />;
            }
            return <div key={row.entry.path} className="workspace-files-tree__item">
              <button
                ref={(node) => { if (node === null) rowRefs.current.delete(row.entry.path); else rowRefs.current.set(row.entry.path, node); }}
                type="button"
                role="treeitem"
                data-workspace-tree-row=""
                data-relative-path={row.entry.path}
                aria-level={row.depth + 1}
                aria-expanded={row.entry.kind === "directory" ? expanded : undefined}
                aria-selected={row.entry.kind === "file" ? canonicalSelectedPath === row.entry.path : undefined}
                tabIndex={effectiveFocusPath === row.entry.path ? 0 : -1}
                draggable={allowEntryDrag}
                className={cx("workspace-files-tree__row", canonicalSelectedPath === row.entry.path && "is-selected")}
                style={{ "--workspace-tree-depth": row.depth } as CSSProperties}
                onFocus={() => setFocusedPath(row.entry.path)}
                onClick={() => { if (row.entry.kind === "directory") tree.toggleDirectory(row.entry.path); else void selectFile(row.entry.path); }}
                onKeyDown={(event) => handleTreeKey(event, row)}
                onContextMenu={(event) => openContextMenu(event, row.entry)}
                onDragStart={(event) => startDrag(event, row.entry)}
              >
                <span className="workspace-files-tree__chevron" aria-hidden="true">{row.entry.kind === "directory" ? loading ? <LoaderCircle className="is-spinning" /> : expanded ? <ChevronDown /> : <ChevronRight /> : null}</span>
                <span className="workspace-files-tree__icon" aria-hidden="true">{row.entry.kind === "directory" ? expanded ? <FolderOpen /> : <Folder /> : <WorkspaceFileIcon path={row.entry.path} />}</span>
                <span className="workspace-files-tree__name">{row.entry.name}</span>
                {row.entry.generated === true && <span className="workspace-files-tree__badge">G</span>}
                {row.entry.status !== undefined && <span className={cx("workspace-files-tree__status", `is-${safeStatusClass(row.entry.status)}`)} title={row.entry.status} />}
              </button>
              {inlineOperation !== undefined
                && inlineOperation.kind !== "rename"
                && inlineOperation.parentPath === row.entry.path
                && <WorkspaceFilesInlineInput
                  operation={inlineOperation}
                  depth={row.depth + 1}
                  labels={labels}
                  onCancel={() => cancelOperation(inlineOperation)}
                  onError={setNotice}
                  onSubmit={(name) => executeOperation(inlineOperation, name).then(() => setOperation(undefined))}
                />}
              {expanded && directory?.status === "error" && <WorkspaceLoadError nested depth={row.depth + 1} label={labels.loadFailed} retryLabel={labels.retry} onRetry={() => tree.loadDirectory(row.entry.path, true)} />}
              {expanded && directory?.status === "loaded" && directory.entries.length === 0 && <div className="workspace-files-tree__empty-folder" style={{ "--workspace-tree-depth": row.depth + 1 } as CSSProperties}>{labels.emptyDirectory}</div>}
            </div>;
          })}
        </div>}
      </section>

      <section className={cx("workspace-files-sidebar__search-mode", mode !== "search" && "is-hidden")} aria-hidden={mode !== "search"}>
        <WorkspaceSearchPanel
          query={searchQuery}
          caseSensitive={caseSensitive}
          state={search.state}
          labels={labels}
          inputRef={searchInputRef}
          onQueryChange={setSearchQuery}
          onCaseSensitiveChange={setCaseSensitive}
          onExit={closeSearch}
          onRetry={search.retry}
          onOpenMatch={openSearchMatch}
        />
      </section>
    </div>

    {contextMenu !== undefined && ownerDocument !== undefined && createPortal(<WorkspaceFilesContextMenu
      state={contextMenu}
      actions={documentActions}
      labels={labels}
      onClose={() => closeContextMenu(true)}
      onOperation={beginOperation}
      onCopy={(entry) => { void copyRelativePath(entry); }}
    />, ownerDocument.body)}
    {operation?.kind === "delete" && createPortal(<WorkspaceFilesDeleteDialog
      operation={operation}
      labels={labels}
      onClose={() => cancelOperation(operation)}
      onExecute={() => executeOperation(operation)}
    />, operation.ownerDocument.body)}
  </div>;
});

/** Workspace identity changes synchronously discard all async and overlay state. */
export const WorkspaceFilesSidebar = forwardRef<WorkspaceFilesSidebarHandle, WorkspaceFilesSidebarProps>(function WorkspaceFilesSidebar(props, ref): JSX.Element {
  return <WorkspaceFilesSidebarBody key={props.workspaceId} {...props} ref={ref} />;
});

function useWorkspaceDirectoryTree(input: {
  readonly workspaceId: string;
  readonly selectedPath?: string;
  readonly storage?: WorkspaceFilesStorage;
  readonly initialDirectories?: ReadonlyMap<string, readonly WorkspaceFilesEntryView[]>;
  readonly loadDirectory: WorkspaceFilesSidebarProps["loadDirectory"];
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly rowRefs: RefObject<Map<string, HTMLButtonElement>>;
  readonly onRevealFailure: () => void;
}): DirectoryTreeController {
  const initial = useMemo(() => initialDirectoryState(input.initialDirectories), [input.initialDirectories]);
  const [directories, setDirectories] = useState<ReadonlyMap<string, WorkspaceDirectoryView>>(initial);
  const directoriesRef = useRef(directories);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const expandedRef = useRef(expanded);
  const generationRef = useRef(0);
  const revealTokenRef = useRef(0);
  const requestTokens = useRef(new Map<string, number>());
  const inflightRequests = useRef(new Map<string, Promise<boolean>>());

  const replaceDirectories = useCallback((update: (current: ReadonlyMap<string, WorkspaceDirectoryView>) => ReadonlyMap<string, WorkspaceDirectoryView>): void => {
    setDirectories((current) => {
      const next = update(current);
      directoriesRef.current = next;
      return next;
    });
  }, []);

  const currentStorage = useCallback((): WorkspaceFilesStorage | undefined => {
    if (input.storage !== undefined) return input.storage;
    try { return input.rootRef.current?.ownerDocument.defaultView?.localStorage; } catch { return undefined; }
  }, [input.rootRef, input.storage]);

  const persistExpanded = useCallback((next: ReadonlySet<string>): void => {
    expandedRef.current = next;
    setExpanded(next);
    saveWorkspaceExpandedPaths(input.workspaceId, next, currentStorage());
  }, [currentStorage, input.workspaceId]);

  const load = useCallback(async (requestedPath: string, force = false): Promise<boolean> => {
    const parentPath = canonicalWorkspaceRelativePath(requestedPath, true);
    const existing = directoriesRef.current.get(parentPath);
    if (!force && existing?.status === "loaded") return true;
    const inflight = inflightRequests.current.get(parentPath);
    if (!force && inflight !== undefined) return await inflight;
    const generation = generationRef.current;
    const token = (requestTokens.current.get(parentPath) ?? 0) + 1;
    requestTokens.current.set(parentPath, token);
    replaceDirectories((current) => {
      const next = new Map(current);
      next.set(parentPath, { status: "loading", entries: current.get(parentPath)?.entries ?? [] });
      return next;
    });
    const request = (async (): Promise<boolean> => {
      try {
        const values = await input.loadDirectory({ workspaceId: input.workspaceId, parentPath });
        const entries = normalizeWorkspaceDirectoryEntries(parentPath, values);
        if (generationRef.current !== generation || requestTokens.current.get(parentPath) !== token) return false;
        replaceDirectories((current) => {
          const next = new Map(current);
          next.set(parentPath, { status: "loaded", entries });
          return next;
        });
        return true;
      } catch {
        if (generationRef.current !== generation || requestTokens.current.get(parentPath) !== token) return false;
        replaceDirectories((current) => {
          const next = new Map(current);
          next.set(parentPath, { status: "error", entries: current.get(parentPath)?.entries ?? [], error: "load_failed" });
          return next;
        });
        return false;
      }
    })();
    inflightRequests.current.set(parentPath, request);
    try {
      return await request;
    } finally {
      if (inflightRequests.current.get(parentPath) === request) inflightRequests.current.delete(parentPath);
    }
  }, [input.loadDirectory, input.workspaceId, replaceDirectories]);

  useEffect(() => {
    generationRef.current += 1;
    revealTokenRef.current += 1;
    requestTokens.current.clear();
    inflightRequests.current.clear();
    const seeded = initialDirectoryState(input.initialDirectories);
    directoriesRef.current = seeded;
    setDirectories(seeded);
    const restored = loadWorkspaceExpandedPaths(input.workspaceId, currentStorage());
    expandedRef.current = restored;
    setExpanded(restored);
    void Promise.all(["", ...restored].map((path) => load(path, true)));
  }, [currentStorage, input.initialDirectories, input.workspaceId, load]);

  const toggleDirectory = useCallback((requestedPath: string): void => {
    const path = canonicalWorkspaceRelativePath(requestedPath);
    const next = new Set(expandedRef.current);
    if (next.has(path)) next.delete(path);
    else {
      next.add(path);
      if (directoriesRef.current.get(path)?.status !== "loaded") void load(path);
    }
    persistExpanded(next);
  }, [load, persistExpanded]);

  const collapseAll = useCallback((): void => {
    persistExpanded(new Set());
    // Collapsed descendants should not keep an unbounded stale directory cache.
    // Fence their in-flight requests while retaining the root listing.
    for (const path of requestTokens.current.keys()) {
      if (path !== "") requestTokens.current.set(path, (requestTokens.current.get(path) ?? 0) + 1);
    }
    for (const path of inflightRequests.current.keys()) {
      if (path !== "") inflightRequests.current.delete(path);
    }
    replaceDirectories((current) => {
      const root = current.get("");
      return root === undefined ? new Map() : new Map([["", root]]);
    });
  }, [persistExpanded, replaceDirectories]);

  const refresh = useCallback(async (): Promise<void> => {
    const targets = new Set(["", ...directoriesRef.current.keys(), ...expandedRef.current]);
    await Promise.all([...targets].map((path) => load(path, true)));
  }, [load]);

  const revealPath = useCallback(async (requestedPath: string): Promise<void> => {
    const generation = generationRef.current;
    const revealToken = revealTokenRef.current + 1;
    revealTokenRef.current = revealToken;
    const isCurrentReveal = (): boolean => generationRef.current === generation && revealTokenRef.current === revealToken;
    const path = canonicalWorkspaceRelativePath(requestedPath);
    const ancestors = workspacePathAncestors(path);
    const next = new Set(expandedRef.current);
    for (const ancestor of ancestors) next.add(ancestor);
    persistExpanded(next);
    const loaded = await Promise.all(["", ...ancestors].map((ancestor) => load(ancestor)));
    if (!isCurrentReveal()) return;
    if (loaded.some((value) => !value) && input.rowRefs.current.get(path) === undefined) {
      input.onRevealFailure();
      return;
    }
    const ownerWindow = input.rootRef.current?.ownerDocument.defaultView;
    await waitForTwoFrames(ownerWindow);
    if (!isCurrentReveal()) return;
    const row = input.rowRefs.current.get(path);
    if (row === undefined) {
      input.onRevealFailure();
      return;
    }
    const reduceMotion = ownerWindow?.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
    row.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  }, [input.onRevealFailure, input.rootRef, input.rowRefs, load, persistExpanded]);

  useEffect(() => {
    if (input.selectedPath === undefined) return;
    void revealPath(input.selectedPath).catch(input.onRevealFailure);
  }, [input.onRevealFailure, input.selectedPath, revealPath]);

  const afterRename = useCallback(async (oldPath: string, newPath: string, directory: boolean): Promise<void> => {
    const oldCanonical = canonicalWorkspaceRelativePath(oldPath);
    const newCanonical = canonicalWorkspaceRelativePath(newPath);
    if (directory) {
      // Rewrite the durable expansion paths so the preference survives a
      // remount, but intentionally leaves the renamed directory collapsed in
      // the current tree. That also prevents stale descendants flashing under
      // the new basename before their listing is fetched again.
      const rewritten = rewriteWorkspacePathPrefix(expandedRef.current, oldCanonical, newCanonical);
      saveWorkspaceExpandedPaths(input.workspaceId, rewritten, currentStorage());
      const collapsed = removeWorkspacePathPrefix(expandedRef.current, oldCanonical);
      expandedRef.current = collapsed;
      setExpanded(collapsed);
      replaceDirectories((current) => new Map([...current].filter(([path]) => path !== oldCanonical && !path.startsWith(`${oldCanonical}/`))));
    }
    await load(workspacePathParent(oldCanonical), true);
  }, [currentStorage, input.workspaceId, load, replaceDirectories]);

  const afterDelete = useCallback(async (path: string, directory: boolean): Promise<void> => {
    const canonical = canonicalWorkspaceRelativePath(path);
    if (directory) {
      persistExpanded(removeWorkspacePathPrefix(expandedRef.current, canonical));
      replaceDirectories((current) => new Map([...current].filter(([key]) => key !== canonical && !key.startsWith(`${canonical}/`))));
    }
    await load(workspacePathParent(canonical), true);
  }, [load, persistExpanded, replaceDirectories]);

  const invalidateChange = useCallback(async (change: WorkspaceFilesExternalChange): Promise<void> => {
    if (change.kind === "overflow" || change.kind === "resync") {
      await refresh();
      return;
    }
    const paths = [change.path, change.previousPath].filter((path): path is string => path !== undefined);
    if (paths.length === 0) return;
    if (change.kind === "deleted" || change.kind === "renamed") {
      const removed = change.kind === "renamed" ? change.previousPath : change.path;
      if (removed !== undefined) {
        for (const path of requestTokens.current.keys()) {
          if (path === removed || path.startsWith(`${removed}/`)) {
            requestTokens.current.set(path, (requestTokens.current.get(path) ?? 0) + 1);
            inflightRequests.current.delete(path);
          }
        }
        replaceDirectories((current) => new Map([...current].filter(([path]) => path !== removed && !path.startsWith(`${removed}/`))));
      }
    }
    const parents = new Set(paths.map(workspacePathParent));
    await Promise.all([...parents]
      .filter((parent) => parent === "" || directoriesRef.current.has(parent) || expandedRef.current.has(parent))
      .map((parent) => load(parent, true)));
  }, [load, refresh, replaceDirectories]);

  return {
    directories,
    expanded,
    rows: useMemo(() => flattenWorkspaceTree(directories, expanded), [directories, expanded]),
    loadDirectory: load,
    toggleDirectory,
    collapseAll,
    refresh,
    revealPath,
    afterRename,
    afterDelete,
    invalidateChange
  };
}

function useWorkspaceFileIndex(input: {
  readonly workspaceId: string;
  readonly revision?: string;
  readonly initialFileIndex?: WorkspaceFilesFileIndexPage;
  readonly loadFileIndex?: WorkspaceFilesSidebarProps["loadFileIndex"];
  readonly enabled: boolean;
}): FileIndexViewState & {
  readonly invalidate: () => void;
  readonly refresh: () => void;
  readonly retry: () => void;
} {
  const initial = useMemo(() => normalizeInitialFileIndex(input.initialFileIndex), [input.initialFileIndex]);
  const [state, setState] = useState<FileIndexViewState>(initial);
  const generationRef = useRef(0);
  const revisionRef = useRef(input.revision);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const invalidate = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = undefined;
    generationRef.current += 1;
    workspaceFileIndexCache.delete(input.workspaceId);
    setState({ status: "idle", paths: [], truncated: false });
  }, [input.workspaceId]);
  const load = useCallback(async (force = false): Promise<void> => {
    if (input.loadFileIndex === undefined) return;
    const cached = workspaceFileIndexCache.get(input.workspaceId);
    if (!force && cached !== undefined && workspaceFileIndexSnapshotFresh(cached, Date.now())) {
      setState({
        status: "loaded",
        paths: normalizeWorkspaceFileIndex(cached.paths),
        truncated: cached.truncated,
        ...(cached.revision === undefined ? {} : { revision: cached.revision })
      });
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = ++generationRef.current;
    setState((current) => ({ ...current, status: "loading" }));
    try {
      const result = await input.loadFileIndex({ workspaceId: input.workspaceId }, controller.signal);
      const paths = normalizeWorkspaceFileIndex(result.paths);
      if (controller.signal.aborted || generationRef.current !== generation) return;
      const snapshot: FileIndexCacheSnapshot = {
        paths,
        truncated: result.truncated === true,
        ...(result.revision === undefined ? {} : { revision: result.revision }),
        fetchedAt: Date.now()
      };
      workspaceFileIndexCache.set(input.workspaceId, snapshot);
      setState({
        status: "loaded",
        paths,
        truncated: snapshot.truncated,
        ...(snapshot.revision === undefined ? {} : { revision: snapshot.revision })
      });
    } catch {
      if (!controller.signal.aborted && generationRef.current === generation) {
        setState((current) => ({ ...current, status: "error" }));
      }
    }
  }, [input.loadFileIndex, input.workspaceId]);
  useEffect(() => {
    abortRef.current?.abort();
    generationRef.current += 1;
    const cached = workspaceFileIndexCache.get(input.workspaceId);
    setState(input.initialFileIndex === undefined && cached !== undefined
      ? {
          status: workspaceFileIndexSnapshotFresh(cached, Date.now()) ? "loaded" : "idle",
          paths: normalizeWorkspaceFileIndex(cached.paths),
          truncated: cached.truncated,
          ...(cached.revision === undefined ? {} : { revision: cached.revision })
        }
      : normalizeInitialFileIndex(input.initialFileIndex));
  }, [input.initialFileIndex, input.workspaceId]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (revisionRef.current === input.revision) return;
    revisionRef.current = input.revision;
    invalidate();
  }, [input.revision, invalidate]);
  useEffect(() => {
    if (input.enabled && state.status === "idle" && input.loadFileIndex !== undefined) void load();
  }, [input.enabled, input.loadFileIndex, load, state.status]);
  const refresh = useCallback((): void => {
    invalidate();
    if (input.enabled && input.loadFileIndex !== undefined) void load(true);
  }, [input.enabled, input.loadFileIndex, invalidate, load]);
  return { ...state, invalidate, refresh, retry: () => { void load(); } };
}

function useWorkspaceSearch(input: {
  readonly workspaceId: string;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly searchWorkspace: WorkspaceFilesSidebarProps["searchWorkspace"];
  readonly rootRef: RefObject<HTMLElement | null>;
}): { readonly state: SearchViewState; readonly retry: () => void } {
  const [state, setState] = useState<SearchViewState>(EMPTY_SEARCH);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const execute = useCallback(async (): Promise<void> => {
    const query = input.query.trim();
    if (query === "") return;
    const caseSensitive = input.caseSensitive;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = ++generationRef.current;
    setState({
      ...EMPTY_SEARCH,
      status: "loading",
      query,
      caseSensitive
    });
    const matches: WorkspaceFilesSearchMatch[] = [];
    const pending: WorkspaceFilesSearchMatch[] = [];
    const matchedFiles = new Set<string>();
    const ownerWindow = input.rootRef.current?.ownerDocument.defaultView;
    let frame: number | undefined;
    const flush = (): void => {
      if (frame !== undefined && ownerWindow != null) ownerWindow.cancelAnimationFrame(frame);
      frame = undefined;
      if (controller.signal.aborted || generationRef.current !== generation || pending.length === 0) return;
      matches.push(...pending.splice(0));
      const visible = dedupeSearchMatches(matches);
      setState({
        status: "loading",
        query,
        caseSensitive,
        matches: visible,
        truncated: false,
        totalMatches: visible.length,
        totalFiles: matchedFiles.size
      });
    };
    const scheduleFlush = (): void => {
      if (frame !== undefined) return;
      if (ownerWindow == null) {
        flush();
        return;
      }
      frame = ownerWindow.requestAnimationFrame(flush);
    };
    try {
      let terminal: Exclude<WorkspaceFilesSearchEvent, { readonly kind: "match" }> | undefined;
      for await (const event of input.searchWorkspace({
        workspaceId: input.workspaceId,
        query,
        caseSensitive
      }, controller.signal)) {
        if (controller.signal.aborted || generationRef.current !== generation) return;
        if (event.kind === "match") {
          pending.push(event.match);
          matchedFiles.add(event.match.path);
          scheduleFlush();
        } else {
          terminal = event;
        }
      }
      if (controller.signal.aborted || generationRef.current !== generation) return;
      flush();
      if (terminal === undefined) throw new Error("Workspace search ended without a terminal event.");
      const visible = dedupeSearchMatches(matches);
      if (terminal.kind === "error") {
        setState({
          status: "error",
          query,
          caseSensitive,
          matches: visible,
          truncated: false,
          totalMatches: visible.length,
          totalFiles: matchedFiles.size,
          errorCode: terminal.code,
          errorMessage: terminal.message
        });
        return;
      }
      setState({
        status: "done",
        query,
        caseSensitive,
        matches: visible,
        truncated: terminal.truncated,
        totalMatches: terminal.totalMatches,
        totalFiles: terminal.totalFiles,
        revision: terminal.revision
      });
    } catch (error) {
      if (!controller.signal.aborted && generationRef.current === generation) {
        flush();
        const failure = workspaceSearchFailureFromThrown(error, DEFAULT_LABELS.searchFailed);
        setState((current) => ({
          ...current,
          status: "error",
          ...(failure.code === undefined ? {} : { errorCode: failure.code }),
          errorMessage: failure.message
        }));
      }
    } finally {
      if (frame !== undefined && ownerWindow != null) ownerWindow.cancelAnimationFrame(frame);
    }
  }, [input.caseSensitive, input.query, input.rootRef, input.searchWorkspace, input.workspaceId]);

  useEffect(() => {
    abortRef.current?.abort();
    generationRef.current += 1;
    if (input.query.trim() === "") {
      setState(EMPTY_SEARCH);
      return;
    }
    const query = input.query.trim();
    setState({
      ...EMPTY_SEARCH,
      status: "loading",
      query,
      caseSensitive: input.caseSensitive
    });
    const ownerWindow = input.rootRef.current?.ownerDocument.defaultView;
    const timer = (ownerWindow ?? globalThis).setTimeout(() => { void execute(); }, SEARCH_DEBOUNCE_MS);
    return () => {
      (ownerWindow ?? globalThis).clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [execute, input.caseSensitive, input.query, input.rootRef, input.workspaceId]);

  const currentQuery = input.query.trim();
  const currentState = state.query === currentQuery
    && state.caseSensitive === input.caseSensitive
    ? state
    : {
      ...EMPTY_SEARCH,
      status: currentQuery === "" ? "idle" as const : "loading" as const,
      query: currentQuery,
      caseSensitive: input.caseSensitive
    };
  return {
    state: currentState,
    retry: () => { void execute(); }
  };
}

function WorkspaceFileFilter({ value, labels, onChange }: {
  readonly value: string;
  readonly labels: WorkspaceFilesSidebarLabels;
  readonly onChange: (value: string) => void;
}): JSX.Element {
  return <div className="workspace-file-filter"><Search aria-hidden="true" /><input type="text" value={value} placeholder={labels.filterPlaceholder} aria-label={labels.filterPlaceholder} onChange={(event) => onChange(event.target.value)} />{value !== "" && <IconButton label={labels.clearFilter} onClick={() => onChange("")}><X aria-hidden="true" /></IconButton>}</div>;
}

function WorkspaceFilterResults({ paths, state, truncated, selectedPath, labels, onRetry, onSelect }: {
  readonly query: string;
  readonly paths: readonly string[];
  readonly state: FileIndexViewState;
  readonly truncated: boolean;
  readonly selectedPath?: string;
  readonly labels: WorkspaceFilesSidebarLabels;
  readonly onRetry: () => void;
  readonly onSelect: (path: string) => Promise<void>;
}): JSX.Element {
  if (state.status === "loading" && paths.length === 0) return <WorkspaceLoadingState label={labels.filterLoading} />;
  if (state.status === "error" && paths.length === 0) return <WorkspaceLoadError label={labels.filterFailed} retryLabel={labels.retry} onRetry={async () => { onRetry(); return true; }} />;
  return <div className="workspace-file-filter-results" role="listbox" aria-label={labels.filterPlaceholder}>
    {paths.length === 0 && <div className="workspace-files-sidebar__empty">{labels.filterEmpty}</div>}
    {paths.map((path) => <button type="button" role="option" aria-selected={selectedPath === path} className={cx(selectedPath === path && "is-selected")} key={path} onClick={() => { void onSelect(path); }}><File aria-hidden="true" /><span><strong>{workspacePathBasename(path)}</strong>{workspacePathParent(path) !== "" && <small>{workspacePathParent(path)}</small>}</span></button>)}
    {truncated && <p className="workspace-file-filter-results__truncated">{labels.filterTruncated}</p>}
  </div>;
}

function WorkspaceSearchPanel({ query, caseSensitive, state, labels, inputRef, onQueryChange, onCaseSensitiveChange, onExit, onRetry, onOpenMatch }: {
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly state: SearchViewState;
  readonly labels: WorkspaceFilesSidebarLabels;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onQueryChange: (value: string) => void;
  readonly onCaseSensitiveChange: (value: boolean) => void;
  readonly onExit: () => void;
  readonly onRetry: () => void;
  readonly onOpenMatch: (match: WorkspaceFilesSearchMatch) => Promise<void>;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const groups = useMemo(() => groupWorkspaceSearchMatches(state.matches), [state.matches]);
  const summary = query.trim() === "" ? labels.searchEmpty
    : state.status === "loading" && state.matches.length === 0 ? labels.searching
      : state.status === "error" ? workspaceSearchErrorText(state.errorMessage, labels.searchFailed)
        : state.truncated ? labels.searchTruncated(state.totalMatches)
          : state.status === "done" && state.matches.length === 0 ? labels.searchNoResults
            : labels.searchSummary(state.totalMatches, state.totalFiles);
  return <div className="workspace-files-search-panel">
    <div className="workspace-files-search-panel__input">
      <input ref={inputRef} type="text" value={query} placeholder={labels.searchPlaceholder} aria-label={labels.searchPlaceholder} spellCheck={false} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onExit(); } }} />
      <IconButton className={cx(caseSensitive && "is-active")} label={labels.matchCase} aria-pressed={caseSensitive} onClick={() => onCaseSensitiveChange(!caseSensitive)}>Aa</IconButton>
    </div>
    <div className={cx("workspace-files-search-panel__summary", state.status === "error" && "is-error")} aria-live="polite" {...(state.errorCode === undefined ? {} : { "data-error-code": state.errorCode })}><span>{summary}</span>{state.matches.length > 0 && <ListTree aria-hidden="true" />}{state.status === "error" && <button type="button" onClick={onRetry}>{labels.retry}</button>}</div>
    <WorkspaceVirtualSearchResults
      groups={groups}
      collapsed={collapsed}
      onToggle={(path) => setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      })}
      onOpenMatch={onOpenMatch}
    />
  </div>;
}

export function workspaceSearchErrorText(message: string | undefined, fallback: string): string {
  const normalized = message?.trim();
  return normalized === undefined || normalized === "" ? fallback : normalized;
}

type WorkspaceSearchFlatRow =
  | { readonly kind: "header"; readonly path: string; readonly count: number }
  | { readonly kind: "match"; readonly path: string; readonly match: WorkspaceFilesSearchMatch };

function WorkspaceVirtualSearchResults({ groups, collapsed, onToggle, onOpenMatch }: {
  readonly groups: ReturnType<typeof groupWorkspaceSearchMatches>;
  readonly collapsed: ReadonlySet<string>;
  readonly onToggle: (path: string) => void;
  readonly onOpenMatch: (match: WorkspaceFilesSearchMatch) => Promise<void>;
}): JSX.Element {
  const rows = useMemo<readonly WorkspaceSearchFlatRow[]>(() => {
    const flattened: WorkspaceSearchFlatRow[] = [];
    for (const group of groups) {
      flattened.push({ kind: "header", path: group.path, count: group.matches.length });
      if (!collapsed.has(group.path)) {
        for (const match of group.matches) flattened.push({ kind: "match", path: group.path, match });
      }
    }
    return flattened;
  }, [collapsed, groups]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.kind === "header" ? 26 : 22,
    overscan: 8,
    getItemKey: (index) => {
      const row = rows[index];
      return row === undefined ? index : row.kind === "header" ? `header:${row.path}` : `match:${workspaceSearchMatchIdentity(row.match)}`;
    }
  });
  return <div ref={scrollRef} className="workspace-files-search-results">
    <div className="workspace-files-search-results__virtual" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        if (row === undefined) return null;
        return <div
          key={item.key}
          ref={virtualizer.measureElement}
          data-index={item.index}
          className="workspace-files-search-results__virtual-row"
          style={{ transform: `translateY(${item.start}px)` }}
        >{row.kind === "header"
            ? <button type="button" className="workspace-files-search-group__header" aria-expanded={!collapsed.has(row.path)} onClick={() => onToggle(row.path)}>{collapsed.has(row.path) ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}<FileCode2 aria-hidden="true" /><strong>{workspacePathBasename(row.path)}</strong>{workspacePathParent(row.path) !== "" && <small>{workspacePathParent(row.path)}</small>}<span>{row.count}</span></button>
            : <button type="button" className="workspace-files-search-match" title={`Line ${row.match.line}`} onClick={() => { void onOpenMatch(row.match); }}><span>{splitWorkspaceSearchPreview(row.match.preview, row.match.submatches).map((segment) => segment.match
                ? <mark key={segment.key}>{segment.text}</mark>
                : <span key={segment.key}>{segment.text}</span>)}</span></button>}
        </div>;
      })}
    </div>
  </div>;
}

export interface WorkspaceSearchPreviewSegment {
  readonly key: string;
  readonly text: string;
  readonly match: boolean;
}

/** Render only authoritative rg UTF-8 submatches; never re-run the query in JS. */
export function splitWorkspaceSearchPreview(
  preview: string,
  submatches: readonly WorkspaceFilesSearchSubmatch[]
): readonly WorkspaceSearchPreviewSegment[] {
  const leadingTrim = preview.length - preview.trimStart().length;
  const byteBoundaries = workspaceSearchByteToUtf16Boundaries(preview);
  const ranges = submatches.flatMap(({ startByte, endByte }) => {
    const start = byteBoundaries.get(startByte);
    const end = byteBoundaries.get(endByte);
    return start === undefined || end === undefined || end <= start ? [] : [{ start, end }];
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  const segments: WorkspaceSearchPreviewSegment[] = [];
  let cursor = leadingTrim;
  for (const range of ranges) {
    const start = Math.max(range.start, cursor, leadingTrim);
    const end = Math.max(range.end, start);
    if (end <= cursor) continue;
    if (start > cursor) segments.push({ key: `text:${cursor}:${start}`, text: preview.slice(cursor, start), match: false });
    if (end > start) segments.push({ key: `match:${start}:${end}`, text: preview.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < preview.length) segments.push({ key: `text:${cursor}:${preview.length}`, text: preview.slice(cursor), match: false });
  const line = preview.slice(leadingTrim);
  return segments.length === 0 ? [{ key: `text:${leadingTrim}:${preview.length}`, text: line, match: false }] : segments;
}

function workspaceSearchByteToUtf16Boundaries(value: string): ReadonlyMap<number, number> {
  const boundaries = new Map<number, number>([[0, 0]]);
  const encoder = new TextEncoder();
  let byteOffset = 0;
  let utf16Offset = 0;
  for (const character of value) {
    byteOffset += encoder.encode(character).byteLength;
    utf16Offset += character.length;
    boundaries.set(byteOffset, utf16Offset);
  }
  return boundaries;
}

function workspaceSearchFailureFromThrown(error: unknown, fallback: string): {
  readonly code?: string;
  readonly message: string;
} {
  const candidate = typeof error === "object" && error !== null ? error as { readonly code?: unknown; readonly message?: unknown } : undefined;
  const code = typeof candidate?.code === "string" && candidate.code.trim() !== "" ? candidate.code.trim() : undefined;
  const rawMessage = typeof candidate?.message === "string"
    ? candidate.message
    : typeof error === "string" ? error : fallback;
  const message = rawMessage.trim() || fallback;
  return { ...(code === undefined ? {} : { code }), message };
}

function WorkspaceFilesProjectSwitcher({ activeTargetId, displayName, labels, projects, onSelect }: {
  readonly activeTargetId?: string;
  readonly displayName: string;
  readonly labels: WorkspaceFilesSidebarLabels;
  readonly projects: readonly WorkspaceFilesProjectOption[];
  readonly onSelect: (project: WorkspaceFilesProjectOption) => Promise<void>;
}): JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const typeaheadRef = useRef<{ value: string; timer: number | undefined }>({ value: "", timer: undefined });
  useEffect(() => {
    const details = detailsRef.current;
    const ownerDocument = details?.ownerDocument;
    if (details === null || details === undefined || ownerDocument === undefined) return;
    const closeOutside = (event: PointerEvent): void => {
      if (details.open && !details.contains(event.target as Node)) setOpen(false);
    };
    ownerDocument.addEventListener("pointerdown", closeOutside);
    return () => ownerDocument.removeEventListener("pointerdown", closeOutside);
  }, []);
  useEffect(() => {
    if (open) {
      menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
      return;
    }
    typeaheadRef.current.value = "";
    const ownerWindow = detailsRef.current?.ownerDocument.defaultView;
    if (typeaheadRef.current.timer !== undefined) ownerWindow?.clearTimeout(typeaheadRef.current.timer);
    typeaheadRef.current.timer = undefined;
  }, [open]);
  useEffect(() => () => {
    const ownerWindow = detailsRef.current?.ownerDocument.defaultView;
    if (typeaheadRef.current.timer !== undefined) ownerWindow?.clearTimeout(typeaheadRef.current.timer);
  }, []);
  return <details ref={detailsRef} open={open} className="workspace-files-project-switcher" onToggle={(event) => setOpen(event.currentTarget.open)} onKeyDown={(event) => {
    const details = event.currentTarget;
    if (event.key === "Escape" && details.open) {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      setOpen(false);
      details.querySelector("summary")?.focus({ preventScroll: true });
      return;
    }
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
    const current = items.indexOf(details.ownerDocument.activeElement as HTMLButtonElement);
    const keyTarget = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (current < 0 ? 0 : (current + 1) % items.length)
          : event.key === "ArrowUp" ? (current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length)
            : undefined;
    if (keyTarget !== undefined && items.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      if (!details.open) setOpen(true);
      const ownerWindow = details.ownerDocument.defaultView;
      ownerWindow?.requestAnimationFrame(() => items[keyTarget]?.focus({ preventScroll: true }));
      return;
    }
    if (!details.open || event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || items.length === 0) return;
    const ownerWindow = details.ownerDocument.defaultView;
    const key = event.key.toLocaleLowerCase();
    const previous = typeaheadRef.current.value;
    const next = previous !== "" && [...previous].every((character) => character === key) ? key : `${previous}${key}`;
    typeaheadRef.current.value = next;
    if (typeaheadRef.current.timer !== undefined) ownerWindow?.clearTimeout(typeaheadRef.current.timer);
    typeaheadRef.current.timer = ownerWindow?.setTimeout(() => { typeaheadRef.current.value = ""; }, 500);
    const start = current < 0 ? 0 : current + 1;
    const ordered = [...items.slice(start), ...items.slice(0, start)];
    const match = ordered.find((item) => item.textContent?.trim().toLocaleLowerCase().startsWith(next));
    if (match !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      match.focus({ preventScroll: true });
    }
  }}>
    <summary aria-label={labels.switchProject} title={labels.switchProject} aria-haspopup="menu" aria-controls={menuId} aria-expanded={open}>
      <span>{displayName}</span><ChevronDown aria-hidden="true" />
    </summary>
    <div ref={menuRef} id={menuId} className="workspace-files-project-switcher__menu" role="menu">
      {projects.map((project) => {
        const active = project.targetId === activeTargetId;
        return <button
          key={`${project.targetId}\u0000${project.workspaceId}`}
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-current={active ? "true" : undefined}
          onClick={() => {
            setOpen(false);
            detailsRef.current?.querySelector("summary")?.focus({ preventScroll: true });
            if (!active) void onSelect(project);
          }}
        >
          <span>{project.displayName}</span>
          <small>{labels.activeSessionCount(project.activeSessionCount)}</small>
          {active && <Check aria-hidden="true" />}
        </button>;
      })}
    </div>
  </details>;
}

function WorkspaceFilesContextMenu({ state, actions, labels, onClose, onOperation, onCopy }: {
  readonly state: ContextMenuState;
  readonly actions?: WorkspaceFilesDocumentActions;
  readonly labels: WorkspaceFilesSidebarLabels;
  readonly onClose: () => void;
  readonly onOperation: (operation: WorkspaceFileOperation) => void;
  readonly onCopy: (entry: WorkspaceFilesEntryView) => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef<{ value: string; timer: number | undefined }>({ value: "", timer: undefined });
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus(); }, []);
  useEffect(() => () => {
    const ownerWindow = ref.current?.ownerDocument.defaultView;
    if (typeaheadRef.current.timer !== undefined) ownerWindow?.clearTimeout(typeaheadRef.current.timer);
  }, []);
  const entry = state.entry;
  const parentPath = entry?.kind === "directory" ? entry.path : "";
  const items: JSX.Element[] = [];
  if ((entry === undefined || entry.kind === "directory") && canDocumentAction(actions, "createFile")) items.push(<button type="button" role="menuitem" tabIndex={-1} key="create-file" onClick={() => onOperation({ kind: "createFile", parentPath, ownerDocument: state.ownerDocument })}><FilePlus aria-hidden="true" />{labels.newFile}</button>);
  if ((entry === undefined || entry.kind === "directory") && canDocumentAction(actions, "createDirectory")) items.push(<button type="button" role="menuitem" tabIndex={-1} key="create-directory" onClick={() => onOperation({ kind: "createDirectory", parentPath, ownerDocument: state.ownerDocument })}><FolderPlus aria-hidden="true" />{labels.newFolder}</button>);
  if (entry !== undefined && canDocumentAction(actions, "copyRelativePath")) items.push(<button type="button" role="menuitem" tabIndex={-1} key="copy" onClick={() => onCopy(entry)}><Clipboard aria-hidden="true" />{labels.copyRelativePath}</button>);
  if (entry !== undefined && canDocumentAction(actions, "rename")) items.push(<button type="button" role="menuitem" tabIndex={-1} key="rename" onClick={() => onOperation({ kind: "rename", entry, ownerDocument: state.ownerDocument })}><Pencil aria-hidden="true" />{labels.rename}</button>);
  if (entry?.kind === "file" && canDocumentAction(actions, "delete")) items.push(<button type="button" role="menuitem" tabIndex={-1} className="is-danger" key="delete" onClick={() => onOperation({ kind: "delete", entry, ownerDocument: state.ownerDocument })}><Trash2 aria-hidden="true" />{labels.delete}</button>);
  return <div
    ref={ref}
    className="workspace-files-context-menu"
    role="menu"
    aria-orientation="vertical"
    aria-label={labels.contextMenu}
    style={{ left: state.x, top: state.y }}
    onPointerDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.preventDefault()}
    onKeyDown={(event) => navigateMenu(event, ref, typeaheadRef, onClose)}
  >{items}</div>;
}

function WorkspaceFilesInlineInput({ operation, depth, labels, onCancel, onError, onSubmit }: {
  readonly operation: Exclude<WorkspaceFileOperation, { readonly kind: "delete" }>;
  readonly depth: number;
  readonly labels: WorkspaceFilesSidebarLabels;
  readonly onCancel: () => void;
  readonly onError: (message: string) => void;
  readonly onSubmit: (name: string) => Promise<void>;
}): JSX.Element {
  const initialName = operation.kind === "rename" ? operation.entry.name : "";
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const directory = operation.kind === "createDirectory" || (operation.kind === "rename" && operation.entry.kind === "directory");

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus({ preventScroll: true });
    if (operation.kind === "rename" && operation.entry.kind === "file") {
      const dot = operation.entry.name.lastIndexOf(".");
      if (dot > 0) {
        input.setSelectionRange(0, dot);
        return;
      }
    }
    input.select();
  }, [operation]);

  const refocus = (): void => {
    inputRef.current?.ownerDocument.defaultView?.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
  };
  const cancel = (): void => {
    if (busy || committedRef.current) return;
    committedRef.current = true;
    onCancel();
  };
  const commit = async (): Promise<void> => {
    if (busy || committedRef.current) return;
    const trimmed = name.trim();
    if (trimmed === "" || (operation.kind === "rename" && trimmed === operation.entry.name)) {
      cancel();
      return;
    }
    let canonical: string;
    try {
      canonical = canonicalWorkspaceBasename(trimmed);
    } catch {
      onError(labels.invalidName);
      refocus();
      return;
    }
    committedRef.current = true;
    setBusy(true);
    try {
      await onSubmit(canonical);
    } catch {
      committedRef.current = false;
      setBusy(false);
      onError(labels.actionFailed);
      refocus();
    }
  };

  return <div
    className="workspace-files-tree__inline-row"
    role="treeitem"
    aria-level={depth + 1}
    aria-busy={busy}
    data-workspace-tree-inline=""
    style={{ "--workspace-tree-depth": depth } as CSSProperties}
  >
    <span className="workspace-files-tree__chevron" aria-hidden="true" />
    <span className="workspace-files-tree__icon" aria-hidden="true">{directory ? <Folder /> : <File />}</span>
    <input
      ref={inputRef}
      type="text"
      value={name}
      disabled={busy}
      aria-label={operation.kind === "createFile" ? labels.newFile : operation.kind === "createDirectory" ? labels.newFolder : labels.rename}
      placeholder={operation.kind === "createDirectory" ? "new-folder" : operation.kind === "createFile" ? "untitled" : undefined}
      onChange={(event) => setName(event.target.value)}
      onBlur={() => { void commit(); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  </div>;
}

function WorkspaceFilesDeleteDialog({ operation, labels, onClose, onExecute }: {
  readonly operation: Extract<WorkspaceFileOperation, { readonly kind: "delete" }>;
  readonly labels: WorkspaceFilesSidebarLabels;
  readonly onClose: () => void;
  readonly onExecute: () => Promise<void>;
}): JSX.Element {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLButtonElement>("button[data-cancel]")?.focus();
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || dialog === null) return;
      const focusable = [...dialog.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && operation.ownerDocument.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && operation.ownerDocument.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    operation.ownerDocument.addEventListener("keydown", keydown);
    return () => operation.ownerDocument.removeEventListener("keydown", keydown);
  }, [onClose, operation]);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await onExecute();
      onClose();
    } catch {
      setError(labels.actionFailed);
      setBusy(false);
    }
  };
  return <div className="workspace-files-dialog-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={dialogRef} className="workspace-files-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-files-dialog-title" tabIndex={-1}>
      <h2 id="workspace-files-dialog-title">{labels.delete}</h2>
      <form onSubmit={(event) => { void submit(event); }}>
        <p>{labels.deleteConfirmation(workspacePathBasename(operation.entry.path))}</p>
        {error !== undefined && <div className="workspace-files-dialog__error" role="alert">{error}</div>}
        <div className="workspace-files-dialog__actions"><button type="button" data-cancel="" disabled={busy} onClick={onClose}>{labels.cancel}</button><button type="submit" data-confirm="" className="is-danger" disabled={busy}>{busy ? labels.searching : labels.confirm}</button></div>
      </form>
    </div>
  </div>;
}

function WorkspaceLoadError({ label, retryLabel, onRetry, nested = false, depth = 0 }: {
  readonly label: string;
  readonly retryLabel: string;
  readonly onRetry: () => Promise<unknown>;
  readonly nested?: boolean;
  readonly depth?: number;
}): JSX.Element {
  return <div className={cx("workspace-files-load-error", nested && "is-nested")} style={{ "--workspace-tree-depth": depth } as CSSProperties} role="alert"><span>{label}</span><button type="button" onClick={() => { void onRetry(); }}>{retryLabel}</button></div>;
}

function WorkspaceLoadingState({ label }: { readonly label: string }): JSX.Element {
  return <div className="workspace-files-loading" role="status"><LoaderCircle className="is-spinning" aria-hidden="true" /><span>{label}</span></div>;
}

function WorkspaceFileIcon({ path }: { readonly path: string }): JSX.Element {
  if (/\.(?:md|mdx|markdown|mdown|mkdn|mkd)$/iu.test(path)) return <FileText />;
  if (/\.(?:png|jpe?g|gif|webp|bmp|ico|tga|tiff)$/iu.test(path)) return <FileImage />;
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|cc|cxx|hpp|cs|php|dart|lua|sh|bash|zsh|ps1|ya?ml|toml|ini|jsonc?|xml|html?|svg|vue|svelte|css|scss|sass|less|sql|graphql|gql|diff|patch|csproj|sln|shader|unityproj|asmdef)$/iu.test(path)
    ? <FileCode2 />
    : <File />;
}

function initialDirectoryState(values: ReadonlyMap<string, readonly WorkspaceFilesEntryView[]> | undefined): ReadonlyMap<string, WorkspaceDirectoryView> {
  const state = new Map<string, WorkspaceDirectoryView>();
  if (values === undefined) return state;
  for (const [parentPath, entries] of values) {
    const canonicalParent = canonicalWorkspaceRelativePath(parentPath, true);
    state.set(canonicalParent, { status: "loaded", entries: normalizeWorkspaceDirectoryEntries(canonicalParent, entries) });
  }
  return state;
}

function normalizeInitialFileIndex(value: WorkspaceFilesFileIndexPage | undefined): FileIndexViewState {
  if (value === undefined) return { status: "idle", paths: [], truncated: false };
  return {
    status: "loaded",
    paths: normalizeWorkspaceFileIndex(value.paths),
    truncated: value.truncated === true,
    ...(value.revision === undefined ? {} : { revision: value.revision })
  };
}

function workspaceFileIndexSnapshotFresh(snapshot: FileIndexCacheSnapshot, now: number): boolean {
  const ttl = snapshot.truncated
    ? WORKSPACE_FILE_INDEX_TRUNCATED_CACHE_TTL_MS
    : WORKSPACE_FILE_INDEX_CACHE_TTL_MS;
  return now - snapshot.fetchedAt <= ttl;
}

function dedupeSearchMatches(matches: readonly WorkspaceFilesSearchMatch[]): readonly WorkspaceFilesSearchMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const identity = workspaceSearchMatchIdentity(match);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function hasWorkspaceContextActions(actions: WorkspaceFilesDocumentActions | undefined, entry: WorkspaceFilesEntryView | undefined): boolean {
  if (entry === undefined || entry.kind === "directory") {
    if (canDocumentAction(actions, "createFile") || canDocumentAction(actions, "createDirectory")) return true;
  }
  return entry !== undefined && (canDocumentAction(actions, "copyRelativePath")
    || canDocumentAction(actions, "rename")
    || (entry.kind === "file" && canDocumentAction(actions, "delete")));
}

function canDocumentAction(actions: WorkspaceFilesDocumentActions | undefined, action: keyof WorkspaceFilesDocumentCapabilities): boolean {
  if (actions?.capabilities[action] !== true) return false;
  return action === "createFile" ? actions.createFile !== undefined
    : action === "createDirectory" ? actions.createDirectory !== undefined
      : action === "rename" ? actions.rename !== undefined
        : action === "delete" ? actions.delete !== undefined
          : actions.copyRelativePath !== undefined;
}

export function clampWorkspaceFilesMenuPosition(x: number, y: number, viewportWidth: number, viewportHeight: number): { readonly x: number; readonly y: number } {
  const width = 224;
  const height = 212;
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(Math.max(margin, viewportWidth - width - margin), Math.round(x))),
    y: Math.max(margin, Math.min(Math.max(margin, viewportHeight - height - margin), Math.round(y)))
  };
}

function navigateMenu(
  event: ReactKeyboardEvent<HTMLDivElement>,
  ref: RefObject<HTMLDivElement | null>,
  typeaheadRef: RefObject<{ value: string; timer: number | undefined }>,
  onClose: () => void
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    onClose();
    return;
  }
  const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
  if (items.length === 0) return;
  const current = items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0
    : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (current < 0 ? 0 : (current + 1) % items.length)
        : event.key === "ArrowUp" ? (current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length)
          : undefined;
  if (next !== undefined) {
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus({ preventScroll: true });
    return;
  }
  if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
  const ownerWindow = event.currentTarget.ownerDocument.defaultView;
  const key = event.key.toLocaleLowerCase();
  const previous = typeaheadRef.current?.value ?? "";
  const query = previous !== "" && [...previous].every((character) => character === key) ? key : `${previous}${key}`;
  if (typeaheadRef.current !== null) {
    typeaheadRef.current.value = query;
    if (typeaheadRef.current.timer !== undefined) ownerWindow?.clearTimeout(typeaheadRef.current.timer);
    typeaheadRef.current.timer = ownerWindow?.setTimeout(() => {
      if (typeaheadRef.current !== null) typeaheadRef.current.value = "";
    }, 500);
  }
  const start = current < 0 ? 0 : current + 1;
  const ordered = [...items.slice(start), ...items.slice(0, start)];
  const match = ordered.find((item) => item.textContent?.trim().toLocaleLowerCase().startsWith(query));
  if (match !== undefined) {
    event.preventDefault();
    event.stopPropagation();
    match.focus({ preventScroll: true });
  }
}

function safeCanonicalPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try { return canonicalWorkspaceRelativePath(value); } catch { return undefined; }
}

function safeStatusClass(value: string): string {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9_-]/gu, "-").slice(0, 48);
  return normalized === "" ? "unknown" : normalized;
}

function waitForTwoFrames(ownerWindow: Window | null | undefined): Promise<void> {
  if (ownerWindow === undefined || ownerWindow === null) return Promise.resolve();
  return new Promise((resolve) => ownerWindow.requestAnimationFrame(() => ownerWindow.requestAnimationFrame(() => resolve())));
}

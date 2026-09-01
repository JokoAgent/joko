import { Download, File, FileCode2, FileImage, FileText, ImageOff, Maximize2 } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX
} from "react";

import type { AppController } from "../controller.js";
import {
  eventMatchesAppShortcut,
  type AppShortcutOverrides,
  type AppShortcutPlatform
} from "../app-shortcuts.js";
import { translate } from "../i18n.js";
import type {
  ComposerFileSelectionQuoteDraft,
  ComposerSelectionQuoteDraft,
  WorkspaceFilePreviewView
} from "../model.js";
import { workspaceDocumentController } from "../workspace-document-controller.js";
import { useAppShortcut } from "../use-app-shortcut.js";
import { isWorkspaceFileStaleError, type WorkspaceFileSaveDraft } from "./workspace-file-editor.js";
import {
  WorkspaceFileEditorPane,
  type WorkspaceFileEditorPaneHandle
} from "./WorkspaceFileEditorPane.js";
import { WorkspaceDrawioPreview } from "./WorkspaceDrawioPreview.js";
import {
  WorkspaceDocumentSearchBar,
  type WorkspaceDocumentSearchBarLabels
} from "./WorkspaceDocumentSearchBar.js";
import { WorkspaceImageLightbox, type WorkspaceImageLightboxLabels } from "./WorkspaceImageLightbox.js";
import { WorkspaceModelLightbox, type WorkspaceModelLightboxLabels } from "./WorkspaceModelLightbox.js";
import { WorkspaceModelViewer } from "./WorkspaceModelViewer.js";
import { WorkspaceMarkdownImageHost } from "./WorkspaceMarkdownImageHost.js";
import { WorkspaceMermaidHosts, type WorkspaceMermaidHostLabels } from "./WorkspaceMermaidHosts.js";
import { WorkspacePdfCanvas } from "./WorkspacePdfCanvas.js";
import { SelectionQuoteButton } from "./SelectionQuoteButton.js";
import {
  WorkspaceTextEditor,
  type WorkspaceEditorSearchState,
  type WorkspaceEditorSelection,
  type WorkspaceTextEditorHandle
} from "./WorkspaceTextEditor.js";
import type { WorkspaceMarkdownMermaidLabels } from "./workspace-markdown-mermaid.js";
import {
  resolveWorkspaceMarkdownImageSource,
  type WorkspaceMarkdownImageLabels,
  type WorkspaceMarkdownImageResolver
} from "./workspace-markdown-images.js";
import { isWorkspaceMarkdownPath } from "./workspace-file-types.js";
import { materializeWorkspaceModelSource } from "./workspace-gltf-source.js";
import { Button, IconButton, Spinner, cx } from "./ui.js";
import "./workspace-file-body.css";

type WorkspaceFileBodyController = Pick<
  AppController,
  "state" | "writeWorkspaceTextFile" | "readWorkspaceFile" | "getArtifactUrl" | "releaseArtifactUrl" | "downloadArtifact"
>;

export interface WorkspaceFileBodyLabels {
  readonly selectFile: string;
  readonly loading: string;
  readonly editor: string;
  readonly unsaved: string;
  readonly saving: string;
  readonly save: string;
  readonly saveFailed: string;
  readonly externalChange: string;
  readonly reloadDisk: string;
  readonly keepEditing: string;
  readonly overwriteDisk: string;
  readonly insertTable: string;
  readonly addRowAbove: string;
  readonly addRowBelow: string;
  readonly deleteRow: string;
  readonly addColumnLeft: string;
  readonly addColumnRight: string;
  readonly deleteColumn: string;
  readonly deleteTable: string;
  readonly mermaidZoom: string;
  readonly mermaidCopy: string;
  readonly mermaidCopied: string;
  readonly mermaidCopyFailed: string;
  readonly mermaidEditSource: string;
  readonly mermaidRenderFailed: string;
  readonly mermaidEditTitle: string;
  readonly mermaidSource: string;
  readonly mermaidApply: string;
  readonly mermaidTargetMissing: string;
  readonly mermaidZoomOut: string;
  readonly mermaidZoomIn: string;
  readonly cancel: string;
  readonly close: string;
  readonly documentSearch: string;
  readonly documentSearchPlaceholder: string;
  readonly documentSearchPrevious: string;
  readonly documentSearchNext: string;
  readonly documentSearchClose: string;
  readonly documentSearchTruncated: string;
  readonly addToChat: string;
  readonly truncated: string;
  readonly download: string;
  readonly downloadUnavailable: string;
  readonly unavailable: string;
  readonly imageUnavailable: string;
  readonly imageOpen: string;
  readonly imageCopy: string;
  readonly imageCopied: string;
  readonly imageCopyFailed: string;
  readonly imageSaveAs: string;
  readonly imageSaveFailed: string;
  readonly imageAnnotate: string;
  readonly imageDiscardAnnotation: string;
  readonly imageUndoAnnotation: string;
  readonly imageSendToChat: string;
  readonly imageSendFailed: string;
  readonly modelLoading: string;
  readonly modelUnavailable: string;
  readonly modelOpen: string;
  readonly modelZoomIn: string;
  readonly modelZoomOut: string;
  readonly modelReset: string;
  readonly modelInteractionHint: string;
  readonly modelDownloadFailed: string;
  readonly pdfPreview: string;
  readonly drawioRendering: string;
  readonly drawioUnavailable: string;
  readonly retry: string;
  readonly binary: string;
}

export interface WorkspaceFileBodyProps {
  readonly controller: WorkspaceFileBodyController;
  readonly sessionId: string;
  readonly workspaceId: string;
  /** Canonical workspace-relative path selected by the Files route. */
  readonly path?: string | null;
  /** Latest authoritative preview. A mismatched path is never rendered. */
  readonly preview?: WorkspaceFilePreviewView;
  readonly loading?: boolean;
  readonly error?: string;
  /** Capability-driven workspace.files.write gate supplied by the route. */
  readonly canWrite: boolean;
  /** One-shot project-search command from the Files URL. */
  readonly search?: string | null;
  /** One-indexed line paired with the one-shot search command. */
  readonly line?: number | null;
  readonly onSearchJumpConsumed?: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onSelectionQuote?: (quote: ComposerFileSelectionQuoteDraft) => void;
  /** Present only when the active task accepts image attachments. */
  readonly onImageToChat?: (file: File) => void | Promise<void>;
  readonly labels?: Partial<WorkspaceFileBodyLabels>;
  readonly className?: string;
}

export interface WorkspaceFileBodyHandle {
  isDirty(): boolean;
  save(): Promise<boolean>;
  discardLocalChanges(): void;
  focus(): void;
  search(query: string, targetLine?: number): boolean;
  revealLine(line: number): void;
}

/**
 * Formal Files-route body. Authenticated media never receives
 * a server filesystem path, and every editable document joins the shared
 * route/session/window dirty-document registry.
 */
export const WorkspaceFileBody = forwardRef<WorkspaceFileBodyHandle, WorkspaceFileBodyProps>(function WorkspaceFileBody({
  controller,
  sessionId,
  workspaceId,
  path,
  preview,
  loading = false,
  error,
  canWrite,
  search: jumpQuery,
  line: jumpLine,
  onSearchJumpConsumed,
  onDirtyChange,
  onSelectionQuote,
  onImageToChat,
  labels: labelOverrides,
  className
}, forwardedRef) {
  const labels = useWorkspaceFileBodyLabels(controller.state.preferences.locale, labelOverrides);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const selectedPathRef = useRef(path);
  selectedPathRef.current = path;
  const selectedWorkspaceIdRef = useRef(workspaceId);
  selectedWorkspaceIdRef.current = workspaceId;
  const editorRef = useRef<WorkspaceFileEditorPaneHandle>(null);
  const readOnlyEditorRef = useRef<WorkspaceTextEditorHandle>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const markdownImageBlobIdCountsRef = useRef(new Map<string, number>());
  const markdownImageObjectUrlsRef = useRef(new Set<string>());
  const markdownImageRequestsRef = useRef(new Map<string, ReturnType<WorkspaceMarkdownImageResolver>>());
  const markdownImageGenerationRef = useRef(0);
  const [localPreview, setLocalPreview] = useState<WorkspaceFilePreviewView | undefined>(preview);
  const [documentSearchOpen, setDocumentSearchOpen] = useState(false);
  const [documentSearchState, setDocumentSearchState] = useState<WorkspaceEditorSearchState>(EMPTY_DOCUMENT_SEARCH_STATE);
  const dirtyRef = useRef(false);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const lastJumpKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (preview === undefined || path === null || path === undefined || preview.path !== path) return;
    setLocalPreview(preview);
  }, [path, preview?.kind, preview?.path, preview?.revision, preview?.text, preview?.blobId, preview?.byteSize, preview?.modifiedAt, preview?.truncated]);

  useEffect(() => {
    dirtyRef.current = false;
    onDirtyChangeRef.current?.(false);
    setLocalPreview(preview?.path === path ? preview : undefined);
    lastJumpKeyRef.current = undefined;
    setDocumentSearchOpen(false);
    setDocumentSearchState(EMPTY_DOCUMENT_SEARCH_STATE);
  }, [path]);

  useEffect(() => () => onDirtyChangeRef.current?.(false), []);
  useEffect(() => () => {
    markdownImageGenerationRef.current += 1;
    markdownImageRequestsRef.current.clear();
    for (const [blobId, count] of markdownImageBlobIdCountsRef.current) {
      for (let index = 0; index < count; index += 1) controllerRef.current.releaseArtifactUrl(blobId);
    }
    markdownImageBlobIdCountsRef.current.clear();
    for (const url of markdownImageObjectUrlsRef.current) URL.revokeObjectURL(url);
    markdownImageObjectUrlsRef.current.clear();
  }, [path]);

  const activePreview = localPreview?.path === path ? localPreview : undefined;
  const model = path !== null && path !== undefined && isModelPath(path);
  const textPreview = activePreview?.kind === "text" && !model ? activePreview : undefined;
  const markdown = textPreview !== undefined && isWorkspaceMarkdownPath(textPreview.path);
  const drawio = textPreview !== undefined && isDrawioPath(textPreview.path);
  const writable = textPreview !== undefined
    && !drawio
    && canWrite
    && !textPreview.truncated
    && textPreview.revision !== undefined
    && textPreview.revision.trim() !== ""
    && textPreview.text !== undefined;

  const setEditorDirty = useCallback((next: boolean): void => {
    dirtyRef.current = next;
    onDirtyChange?.(next);
  }, [onDirtyChange]);

  const reloadDrawioPreview = useCallback(async (requestedPath: string): Promise<void> => {
    const requestedWorkspaceId = workspaceId;
    const refreshed = await controllerRef.current.readWorkspaceFile(requestedWorkspaceId, requestedPath);
    if (refreshed.path !== requestedPath) throw new Error("Joko service returned a different workspace file.");
    if (selectedWorkspaceIdRef.current !== requestedWorkspaceId) throw new Error("The selected workspace changed.");
    if (selectedPathRef.current !== requestedPath) throw new Error("The selected workspace file changed.");
    setLocalPreview(refreshed);
  }, [workspaceId]);

  const documentGuard = useMemo(() => ({ controller: workspaceDocumentController, sessionId, workspaceId }), [sessionId, workspaceId]);
  const markdownMermaidLabels = useMemo<WorkspaceMarkdownMermaidLabels>(() => ({
    zoom: labels.mermaidZoom,
    copy: labels.mermaidCopy,
    copied: labels.mermaidCopied,
    copyFailed: labels.mermaidCopyFailed,
    editSource: labels.mermaidEditSource,
    renderFailed: labels.mermaidRenderFailed
  }), [
    labels.mermaidCopied,
    labels.mermaidCopy,
    labels.mermaidCopyFailed,
    labels.mermaidEditSource,
    labels.mermaidRenderFailed,
    labels.mermaidZoom
  ]);
  const markdownMermaidHostLabels = useMemo<WorkspaceMermaidHostLabels>(() => ({
    editTitle: labels.mermaidEditTitle,
    source: labels.mermaidSource,
    cancel: labels.cancel,
    apply: labels.mermaidApply,
    targetMissing: labels.mermaidTargetMissing,
    zoomOut: labels.mermaidZoomOut,
    zoomIn: labels.mermaidZoomIn,
    copy: labels.mermaidCopy,
    copied: labels.mermaidCopied,
    copyFailed: labels.mermaidCopyFailed,
    close: labels.close
  }), [
    labels.cancel,
    labels.close,
    labels.mermaidApply,
    labels.mermaidCopied,
    labels.mermaidCopy,
    labels.mermaidCopyFailed,
    labels.mermaidEditTitle,
    labels.mermaidSource,
    labels.mermaidTargetMissing,
    labels.mermaidZoomIn,
    labels.mermaidZoomOut
  ]);
  const markdownImageLabels = useMemo<WorkspaceMarkdownImageLabels>(() => ({
    open: labels.imageOpen,
    loading: labels.loading,
    loadFailed: labels.imageUnavailable
  }), [labels.imageOpen, labels.imageUnavailable, labels.loading]);
  const markdownImageResolver = useCallback<WorkspaceMarkdownImageResolver>(async (source) => {
    if (textPreview === undefined || !markdown) return undefined;
    const generation = markdownImageGenerationRef.current;
    const requestKey = `${textPreview.path}\u0000${source}`;
    const existing = markdownImageRequestsRef.current.get(requestKey);
    if (existing !== undefined) return existing;
    const request = (async () => {
    const resolved = resolveWorkspaceMarkdownImageSource(textPreview.path, source);
    if (resolved === undefined) return undefined;
    if (resolved.kind === "embedded") return {
      url: resolved.url,
      name: workspaceImageName(source),
      mediaType: workspaceImageMediaType(source)
    };
    if (resolved.kind === "remote") {
      try {
        const response = await fetch(resolved.url, { credentials: "omit", referrerPolicy: "no-referrer" });
        if (response.ok) {
          const blob = await response.blob();
          if (blob.type.toLocaleLowerCase().startsWith("image/")) {
            const url = URL.createObjectURL(blob);
            if (generation !== markdownImageGenerationRef.current) {
              URL.revokeObjectURL(url);
              return undefined;
            }
            markdownImageObjectUrlsRef.current.add(url);
            return { url, name: workspaceImageName(new URL(resolved.url).pathname), mediaType: blob.type };
          }
        }
      } catch {
        // A normal cross-origin image often omits CORS response headers. This path
        // still previews it through <img>; retain that display path while
        // credentialed copy/annotation actions remain fail-closed.
      }
      return generation === markdownImageGenerationRef.current
        ? { url: resolved.url, name: workspaceImageName(new URL(resolved.url).pathname) }
        : undefined;
    }
    const image = await controllerRef.current.readWorkspaceFile(workspaceId, resolved.path);
    if (generation !== markdownImageGenerationRef.current) return undefined;
    if (image.path !== resolved.path) return undefined;
    if (image.kind === "text" && /\.svg$/iu.test(image.path) && image.text !== undefined) {
      const url = URL.createObjectURL(new Blob([image.text], { type: "image/svg+xml" }));
      if (generation !== markdownImageGenerationRef.current) {
        URL.revokeObjectURL(url);
        return undefined;
      }
      markdownImageObjectUrlsRef.current.add(url);
      return { url, name: image.name, mediaType: "image/svg+xml" };
    }
    if (image.blobId === undefined || image.blobId === "") return undefined;
    const url = await controllerRef.current.getArtifactUrl(image.blobId);
    if (generation !== markdownImageGenerationRef.current) {
      controllerRef.current.releaseArtifactUrl(image.blobId);
      return undefined;
    }
    markdownImageBlobIdCountsRef.current.set(
      image.blobId,
      (markdownImageBlobIdCountsRef.current.get(image.blobId) ?? 0) + 1
    );
    return { url, name: image.name, mediaType: image.mediaType };
    })();
    markdownImageRequestsRef.current.set(requestKey, request);
    try {
      const result = await request;
      if (result === undefined && markdownImageRequestsRef.current.get(requestKey) === request) {
        markdownImageRequestsRef.current.delete(requestKey);
      }
      return result;
    } catch (cause) {
      if (markdownImageRequestsRef.current.get(requestKey) === request) markdownImageRequestsRef.current.delete(requestKey);
      throw cause;
    }
  }, [markdown, textPreview?.path, workspaceId]);

  const saveWorkspaceText = useCallback(async (draft: WorkspaceFileSaveDraft) => {
    try {
      const result = await controllerRef.current.writeWorkspaceTextFile(workspaceId, draft);
      if (result.path !== draft.path) throw new Error("Joko service returned a different saved workspace file.");
      setLocalPreview((current) => current?.path !== draft.path
        ? current
        : { ...current, text: draft.text, revision: result.revision, truncated: false });
      return { revision: result.revision };
    } catch (cause) {
      if (isWorkspaceFileStaleError(cause)) {
        try {
          const latest = await controllerRef.current.readWorkspaceFile(workspaceId, draft.path);
          if (latest.path === draft.path) setLocalPreview(latest);
        } catch {
          // Preserve the revision-fence error. A watcher refresh may still
          // provide the authoritative conflict snapshot later.
        }
      }
      throw cause;
    }
  }, [workspaceId]);

  const searchEditor = useCallback((query: string, targetLine?: number): boolean => {
    const found = writable
      ? editorRef.current?.search(query, targetLine) ?? false
      : readOnlyEditorRef.current?.search(query, targetLine) ?? false;
    if (!found && targetLine !== undefined) {
      if (writable) editorRef.current?.revealLine(targetLine);
      else readOnlyEditorRef.current?.revealLine(targetLine);
    }
    return found;
  }, [writable]);

  const readDocumentSearchState = useCallback((query: string, targetLine?: number): WorkspaceEditorSearchState => (
    writable
      ? editorRef.current?.searchState(query, targetLine) ?? emptyDocumentSearchState(query)
      : readOnlyEditorRef.current?.searchState(query, targetLine) ?? emptyDocumentSearchState(query)
  ), [writable]);

  const activateDocumentSearch = useCallback((query: string, index: number): WorkspaceEditorSearchState => (
    writable
      ? editorRef.current?.activateSearch(query, index) ?? emptyDocumentSearchState(query)
      : readOnlyEditorRef.current?.activateSearch(query, index) ?? emptyDocumentSearchState(query)
  ), [writable]);

  const clearDocumentSearch = useCallback((): void => {
    if (writable) editorRef.current?.clearSearch();
    else readOnlyEditorRef.current?.clearSearch();
    setDocumentSearchOpen(false);
    setDocumentSearchState(EMPTY_DOCUMENT_SEARCH_STATE);
  }, [writable]);

  const openDocumentSearch = useCallback((query = documentSearchState.query, focusInput = true, targetLine?: number): void => {
    setDocumentSearchOpen(true);
    setDocumentSearchState(readDocumentSearchState(query, targetLine));
    if (focusInput) window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
      searchInputRef.current?.select();
    });
  }, [documentSearchState.query, readDocumentSearchState]);

  useImperativeHandle(forwardedRef, () => ({
    isDirty: () => editorRef.current?.isDirty() ?? false,
    save: () => editorRef.current?.save() ?? Promise.resolve(true),
    discardLocalChanges: () => editorRef.current?.discardLocalChanges(),
    focus: () => {
      if (writable) editorRef.current?.focus();
      else readOnlyEditorRef.current?.focus();
    },
    search: searchEditor,
    revealLine: (line) => {
      if (writable) editorRef.current?.revealLine(line);
      else readOnlyEditorRef.current?.revealLine(line);
    }
  }), [searchEditor, writable]);

  useEffect(() => {
    if (textPreview === undefined || !documentSearchOpen) return;
    const ownerDocument = searchInputRef.current?.ownerDocument ?? document;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== "Escape"
        || event.defaultPrevented
        || event.repeat
        || event.isComposing
        || workspaceDocumentShortcutBlocked(ownerDocument, event.target)
      ) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      clearDocumentSearch();
    };
    ownerDocument.addEventListener("keydown", onKeyDown, true);
    return () => ownerDocument.removeEventListener("keydown", onKeyDown, true);
  }, [clearDocumentSearch, documentSearchOpen, textPreview?.path]);

  useAppShortcut("find-in-page", controller.state.preferences.appShortcutOverrides, (event) => {
    if (textPreview === undefined) return false;
    const ownerDocument = searchInputRef.current?.ownerDocument ?? document;
    if (workspaceDocumentShortcutBlocked(ownerDocument, event.target)) return false;
    openDocumentSearch();
    return true;
  }, { enabled: textPreview !== undefined, stopImmediate: true });

  useAppShortcut("save-file", controller.state.preferences.appShortcutOverrides, (event) => {
    if (textPreview === undefined || !writable) return false;
    const ownerDocument = searchInputRef.current?.ownerDocument ?? document;
    if (workspaceDocumentShortcutBlocked(ownerDocument, event.target)) return false;
    void editorRef.current?.save();
    return true;
  }, { enabled: textPreview !== undefined, stopImmediate: true });

  useEffect(() => {
    if (textPreview === undefined) return;
    const query = jumpQuery ?? "";
    if (query === "" && (jumpLine === null || jumpLine === undefined)) {
      lastJumpKeyRef.current = undefined;
      return;
    }
    const jumpKey = JSON.stringify([textPreview.path, query, jumpLine ?? null]);
    if (lastJumpKeyRef.current === jumpKey) return;
    if (query !== "") {
      setDocumentSearchState(readDocumentSearchState(query, jumpLine ?? undefined));
    }
    else if (jumpLine !== null && jumpLine !== undefined) {
      if (writable) editorRef.current?.revealLine(jumpLine);
      else readOnlyEditorRef.current?.revealLine(jumpLine);
    }
    lastJumpKeyRef.current = jumpKey;
    onSearchJumpConsumed?.();
  }, [jumpLine, jumpQuery, onSearchJumpConsumed, readDocumentSearchState, textPreview?.path, writable]);

  if (path === null || path === undefined || path === "") {
    return <BodyState className={className}>{labels.selectFile}</BodyState>;
  }
  if (error !== undefined) {
    return <BodyState className={className} error>{error}</BodyState>;
  }
  if (loading && activePreview === undefined) {
    return <DelayedLoading className={className} label={labels.loading} />;
  }
  if (activePreview === undefined) {
    return <BodyState className={className}>{labels.loading}</BodyState>;
  }

  if (model) {
    return <AuthenticatedModelPreview
      controller={controller}
      workspaceId={workspaceId}
      preview={activePreview}
      labels={labels}
      className={className}
    />;
  }

  if (textPreview !== undefined) {
    if (drawio) return <section className={cx("workspace-file-body", className)} data-file-kind="drawio" data-file-path={path}>
      <WorkspaceDrawioPreview
        workspaceId={workspaceId}
        path={textPreview.path}
        name={textPreview.name}
        theme={controller.state.preferences.theme}
        xml={textPreview.text ?? ""}
        metadata={workspaceFileMetadata(textPreview, controller.state.preferences.locale)}
        loadingLabel={labels.drawioRendering}
        unavailableLabel={labels.drawioUnavailable}
        retryLabel={labels.retry}
        onRetry={() => reloadDrawioPreview(textPreview.path)}
      />
    </section>;
    return <section className={cx("workspace-file-body", className)} data-file-kind={markdown ? "markdown" : "text"} data-file-path={path} data-local-page-search-owner="true">
      {textPreview.truncated && <div className="workspace-file-body__truncated" role="status">{labels.truncated}</div>}
      <div className="workspace-file-body__text-stage">
        <div className="workspace-file-body__source">
          {writable
            ? <WorkspaceFileEditorPane
                ref={editorRef}
                key={textPreview.path}
                file={{
                  path: textPreview.path,
                  text: textPreview.text ?? "",
                  revision: textPreview.revision!,
                  ...(textPreview.language === undefined ? {} : { languageId: textPreview.language })
                }}
                scrollKey={`${workspaceId}\u0000${textPreview.path}`}
                suppressInitialScrollRestore={jumpQuery !== null && jumpQuery !== undefined && jumpQuery !== ""}
                markdownImageLabels={markdownImageLabels}
                markdownImageResolver={markdownImageResolver}
                labels={{
                  editor: labels.editor,
                  unsaved: labels.unsaved,
                  saving: labels.saving,
                  save: labels.save,
                  saveFailed: labels.saveFailed,
                  externalChange: labels.externalChange,
                  reloadDisk: labels.reloadDisk,
                  keepEditing: labels.keepEditing,
                  overwriteDisk: labels.overwriteDisk,
                  insertTable: labels.insertTable,
                  addRowAbove: labels.addRowAbove,
                  addRowBelow: labels.addRowBelow,
                  deleteRow: labels.deleteRow,
                  addColumnLeft: labels.addColumnLeft,
                  addColumnRight: labels.addColumnRight,
                  deleteColumn: labels.deleteColumn,
                  deleteTable: labels.deleteTable,
                  mermaidZoom: labels.mermaidZoom,
                  mermaidCopy: labels.mermaidCopy,
                  mermaidCopied: labels.mermaidCopied,
                  mermaidCopyFailed: labels.mermaidCopyFailed,
                  mermaidEditSource: labels.mermaidEditSource,
                  mermaidRenderFailed: labels.mermaidRenderFailed
                }}
                onDirtyChange={setEditorDirty}
                onSearchStateChange={setDocumentSearchState}
                selectionQuoteSessionId={onSelectionQuote === undefined ? undefined : sessionId}
                selectionQuoteLabel={onSelectionQuote === undefined ? undefined : labels.addToChat}
                onSelectionQuote={onSelectionQuote}
                documentGuard={documentGuard}
                onSave={saveWorkspaceText}
              />
            : <ReadOnlyWorkspaceEditor
                ref={readOnlyEditorRef}
                sessionId={sessionId}
                path={textPreview.path}
                text={textPreview.text ?? ""}
                languageId={textPreview.language}
                editorLabel={labels.editor}
                markdownMermaidLabels={markdownMermaidLabels}
                markdownImageLabels={markdownImageLabels}
                markdownImageResolver={markdownImageResolver}
                scrollKey={`${workspaceId}\u0000${textPreview.path}`}
                suppressInitialScrollRestore={jumpQuery !== null && jumpQuery !== undefined && jumpQuery !== ""}
                onSearchStateChange={setDocumentSearchState}
                quoteLabel={labels.addToChat}
                onSelectionQuote={onSelectionQuote}
              />}
        </div>
      </div>
      {documentSearchOpen && <WorkspaceDocumentSearchBar
        ref={searchInputRef}
        query={documentSearchState.query}
        total={documentSearchState.total}
        activeIndex={documentSearchState.activeIndex}
        truncated={documentSearchState.truncated}
        labels={documentSearchLabels(labels)}
        onChange={(query) => setDocumentSearchState(readDocumentSearchState(query))}
        onPrevious={() => setDocumentSearchState(activateDocumentSearch(documentSearchState.query, documentSearchState.activeIndex - 1))}
        onNext={() => setDocumentSearchState(activateDocumentSearch(documentSearchState.query, documentSearchState.activeIndex + 1))}
        onClose={() => clearDocumentSearch()}
      />}
      {markdown && <WorkspaceMermaidHosts labels={markdownMermaidHostLabels} />}
      {markdown && <WorkspaceMarkdownImageHost key={path} labels={imageLightboxLabels(labels)} onSendToChat={onImageToChat} />}
    </section>;
  }

  const mediaType = activePreview.mediaType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!isSvgPath(path) && (activePreview.kind === "image" || isRasterImagePath(path) || isRasterImageMediaType(mediaType))) {
    return <AuthenticatedImagePreview controller={controller} preview={activePreview} labels={labels} onSendToChat={onImageToChat} className={className} />;
  }
  if (isPdfPath(path) || mediaType === "application/pdf") {
    return <AuthenticatedPdfPreview controller={controller} preview={activePreview} labels={labels} className={className} />;
  }
  if (isVideoPath(path) || mediaType.startsWith("video/")) {
    return <AuthenticatedVideoPreview controller={controller} preview={activePreview} labels={labels} className={className} />;
  }
  return <BinaryFilePlaceholder controller={controller} preview={activePreview} labels={labels} className={className} />;
});

const ReadOnlyWorkspaceEditor = forwardRef<WorkspaceTextEditorHandle, {
  readonly sessionId: string;
  readonly path: string;
  readonly text: string;
  readonly languageId?: string;
  readonly editorLabel: string;
  readonly markdownMermaidLabels: WorkspaceMarkdownMermaidLabels;
  readonly markdownImageLabels: WorkspaceMarkdownImageLabels;
  readonly markdownImageResolver: WorkspaceMarkdownImageResolver;
  readonly scrollKey: string;
  readonly suppressInitialScrollRestore: boolean;
  readonly quoteLabel: string;
  readonly onSearchStateChange?: (state: WorkspaceEditorSearchState) => void;
  readonly onSelectionQuote?: (quote: ComposerFileSelectionQuoteDraft) => void;
}>(function ReadOnlyWorkspaceEditor({ sessionId, path, text, languageId, editorLabel, markdownMermaidLabels, markdownImageLabels, markdownImageResolver, scrollKey, suppressInitialScrollRestore, quoteLabel, onSearchStateChange, onSelectionQuote }, forwardedRef) {
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<WorkspaceTextEditorHandle>(null);
  const selectionRef = useRef<WorkspaceEditorSelection | undefined>(undefined);
  useImperativeHandle(forwardedRef, () => ({
    getValue: () => editorRef.current?.getValue() ?? text,
    getSelection: () => editorRef.current?.getSelection(),
    focus: () => editorRef.current?.focus(),
    search: (query, line) => editorRef.current?.search(query, line) ?? false,
    searchState: (query, line) => editorRef.current?.searchState(query, line) ?? { query, total: 0, activeIndex: 0, truncated: false },
    activateSearch: (query, index) => editorRef.current?.activateSearch(query, index) ?? { query, total: 0, activeIndex: 0, truncated: false },
    clearSearch: () => editorRef.current?.clearSearch(),
    insertMarkdownTableAt: () => false,
    revealLine: (line) => editorRef.current?.revealLine(line)
  }), [text]);
  const commitQuote = useCallback((quote: ComposerSelectionQuoteDraft): void => {
    if (quote.kind === "file") onSelectionQuote?.(quote);
  }, [onSelectionQuote]);
  return <div ref={rootRef} className="workspace-file-editor-pane workspace-file-editor-pane--read-only">
    <WorkspaceTextEditor ref={editorRef} path={path} value={text} languageId={languageId} readOnly scrollKey={scrollKey} suppressInitialScrollRestore={suppressInitialScrollRestore} ariaLabel={editorLabel} markdownMermaidLabels={markdownMermaidLabels} markdownImageLabels={markdownImageLabels} markdownImageResolver={markdownImageResolver} onSearchStateChange={onSearchStateChange} onSelectionChange={(selection) => { selectionRef.current = selection; }} />
    {onSelectionQuote !== undefined && <SelectionQuoteButton
      sessionId={sessionId}
      containerRef={rootRef}
      sourcePath={path}
      getQuoteText={() => (selectionRef.current ?? editorRef.current?.getSelection())?.text ?? null}
      getQuoteMetadata={() => {
        const selection = selectionRef.current ?? editorRef.current?.getSelection();
        return selection === undefined ? null : { startLine: selection.startLine, endLine: selection.endLine };
      }}
      label={quoteLabel}
      onCommit={commitQuote}
    />}
  </div>;
});

function AuthenticatedImagePreview({ controller, preview, labels, onSendToChat, className }: {
  readonly controller: WorkspaceFileBodyController;
  readonly preview: WorkspaceFilePreviewView;
  readonly labels: WorkspaceFileBodyLabels;
  readonly onSendToChat?: (file: File) => void | Promise<void>;
  readonly className?: string;
}): JSX.Element {
  const artifact = useAuthenticatedArtifactUrl(controller, preview.blobId);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <section className={cx("workspace-file-body workspace-file-body--media", className)} data-file-kind="image">
    <div className="workspace-file-body__media-stage">
      {artifact.status === "loading" && <Spinner label={labels.loading} />}
      {artifact.status === "error" && <BodyInlineEmpty label={labels.imageUnavailable} icon={<ImageOff aria-hidden="true" />} />}
      {artifact.status === "ready" && <button
        ref={openButtonRef}
        type="button"
        className="workspace-file-body__image-open"
        aria-label={`${labels.imageOpen}: ${preview.name}`}
        onClick={() => setOpen(true)}
      ><img src={artifact.url} alt={preview.name} /></button>}
    </div>
    <FileMeta preview={preview} locale={controller.state.preferences.locale} />
    <DownloadAction controller={controller} preview={preview} labels={labels} />
    {open && artifact.status === "ready" && <WorkspaceImageLightbox
      src={artifact.url}
      name={preview.name}
      mediaType={preview.mediaType}
      labels={imageLightboxLabels(labels)}
      returnFocus={openButtonRef.current}
      onClose={() => setOpen(false)}
      onDownload={() => preview.blobId === undefined
        ? Promise.reject(new Error(labels.downloadUnavailable))
        : controller.downloadArtifact(preview.blobId, preview.name)}
      onSendToChat={onSendToChat}
    />}
  </section>;
}

function AuthenticatedVideoPreview({ controller, preview, labels, className }: {
  readonly controller: WorkspaceFileBodyController;
  readonly preview: WorkspaceFilePreviewView;
  readonly labels: WorkspaceFileBodyLabels;
  readonly className?: string;
}): JSX.Element {
  const artifact = useAuthenticatedArtifactUrl(controller, preview.blobId);
  const [failedUrl, setFailedUrl] = useState<string>();
  if (artifact.status === "error" || (artifact.status === "ready" && failedUrl === artifact.url)) {
    return <BinaryFilePlaceholder controller={controller} preview={preview} labels={labels} className={className} />;
  }
  return <section className={cx("workspace-file-body workspace-file-body--media", className)} data-file-kind="video">
    <div className="workspace-file-body__media-stage">
      {artifact.status === "loading" && <Spinner label={labels.loading} />}
      {artifact.status === "ready" && <video
        src={artifact.url}
        controls
        playsInline
        preload="metadata"
        aria-label={preview.name}
        onError={() => setFailedUrl(artifact.url)}
      />}
    </div>
    <FileMeta preview={preview} locale={controller.state.preferences.locale} />
    <DownloadAction controller={controller} preview={preview} labels={labels} />
  </section>;
}

function AuthenticatedModelPreview({ controller, workspaceId, preview, labels, className }: {
  readonly controller: WorkspaceFileBodyController;
  readonly workspaceId: string;
  readonly preview: WorkspaceFilePreviewView;
  readonly labels: WorkspaceFileBodyLabels;
  readonly className?: string;
}): JSX.Element {
  const artifact = useWorkspaceModelArtifactUrl(controller, workspaceId, preview);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string>();
  if (artifact.status === "error" || (artifact.status === "ready" && failedUrl === artifact.url)) {
    return <BinaryFilePlaceholder controller={controller} preview={preview} labels={labels} className={className} />;
  }
  const viewerLabels = { loading: labels.modelLoading, unavailable: labels.modelUnavailable };
  return <section className={cx("workspace-file-body workspace-file-body--media workspace-file-body--model", className)} data-file-kind="model">
    <div className="workspace-file-body__media-stage">
      {artifact.status === "loading" && <Spinner label={labels.modelLoading} />}
      {artifact.status === "ready" && <div className="workspace-file-body__model-stage">
        <WorkspaceModelViewer
          src={artifact.url}
          name={preview.name}
          labels={viewerLabels}
          onError={() => setFailedUrl(artifact.url)}
        />
        <IconButton
          buttonRef={openButtonRef}
          className="workspace-file-body__model-open"
          label={`${labels.modelOpen}: ${preview.name}`}
          tip={labels.modelOpen}
          onClick={() => setOpen(true)}
        ><Maximize2 aria-hidden="true" /></IconButton>
      </div>}
    </div>
    <FileMeta preview={preview} locale={controller.state.preferences.locale} />
    <DownloadAction controller={controller} preview={preview} labels={labels} />
    {open && artifact.status === "ready" && <WorkspaceModelLightbox
      src={artifact.url}
      name={preview.name}
      labels={modelLightboxLabels(labels)}
      returnFocus={openButtonRef.current}
      onClose={() => setOpen(false)}
      onDownload={() => preview.blobId === undefined
        ? Promise.reject(new Error(labels.downloadUnavailable))
        : controller.downloadArtifact(preview.blobId, preview.name)}
    />}
  </section>;
}

function AuthenticatedPdfPreview({ controller, preview, labels, className }: {
  readonly controller: WorkspaceFileBodyController;
  readonly preview: WorkspaceFilePreviewView;
  readonly labels: WorkspaceFileBodyLabels;
  readonly className?: string;
}): JSX.Element {
  const artifact = useAuthenticatedArtifactUrl(controller, preview.blobId);
  const [failedUrl, setFailedUrl] = useState<string>();
  if (artifact.status === "error" || (artifact.status === "ready" && failedUrl === artifact.url)) {
    return <BinaryFilePlaceholder controller={controller} preview={preview} labels={labels} className={className} />;
  }
  return <section className={cx("workspace-file-body workspace-file-body--pdf", className)} data-file-kind="pdf">
    <div className="workspace-file-body__pdf-stage">
      {artifact.status === "loading" && <BodyInlineEmpty label={labels.loading} icon={<Spinner label={labels.loading} />} />}
      {artifact.status === "ready" && <WorkspacePdfCanvas
        url={artifact.url}
        label={`${labels.pdfPreview}: ${preview.name}`}
        loadingLabel={labels.loading}
        onError={() => setFailedUrl(artifact.url)}
      />}
    </div>
    <div className="workspace-file-body__pdf-footer">
      <FileMeta preview={preview} locale={controller.state.preferences.locale} />
      <DownloadAction controller={controller} preview={preview} labels={labels} />
    </div>
  </section>;
}

function BinaryFilePlaceholder({ controller, preview, labels, className }: {
  readonly controller: WorkspaceFileBodyController;
  readonly preview: WorkspaceFilePreviewView;
  readonly labels: WorkspaceFileBodyLabels;
  readonly className?: string;
}): JSX.Element {
  const iconKind = workspaceFilePlaceholderIconKind(preview.path);
  const Icon = iconKind === "markdown" ? FileText : iconKind === "code" ? FileCode2 : iconKind === "image" ? FileImage : File;
  return <section className={cx("workspace-file-body workspace-file-body--unsupported", className)} data-file-kind={preview.kind}>
    <span className="workspace-file-body__file-icon" aria-hidden="true"><Icon /></span>
    <div><strong>{preview.name}</strong><FileMeta preview={preview} locale={controller.state.preferences.locale} includeName={false} fallbackType={labels.binary} /><p>{preview.summary || labels.unavailable}</p></div>
    <DownloadAction controller={controller} preview={preview} labels={labels} />
  </section>;
}

export function workspaceFilePlaceholderIconKind(path: string): "markdown" | "code" | "image" | "file" {
  if (isWorkspaceMarkdownPath(path)) return "markdown";
  if (/\.(?:png|jpe?g|gif|webp|bmp|ico|tga|tiff)$/iu.test(path)) return "image";
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|cc|cxx|hpp|cs|php|dart|lua|sh|bash|zsh|ps1|ya?ml|toml|ini|jsonc?|xml|html?|svg|vue|svelte|css|scss|sass|less|sql|graphql|gql|diff|patch|csproj|sln|shader|unityproj|asmdef)$/iu.test(path)
    ? "code"
    : "file";
}

function DownloadAction({ controller, preview, labels }: {
  readonly controller: WorkspaceFileBodyController;
  readonly preview: WorkspaceFilePreviewView;
  readonly labels: WorkspaceFileBodyLabels;
}): JSX.Element {
  const available = preview.blobId !== undefined && preview.blobId !== "";
  const [failed, setFailed] = useState(false);
  return <><Button
      tone="secondary"
      className="workspace-file-body__download"
      disabled={!available}
      title={available ? labels.download : labels.downloadUnavailable}
      onClick={() => {
        if (preview.blobId === undefined) return;
        setFailed(false);
        void controller.downloadArtifact(preview.blobId, preview.name).catch(() => setFailed(true));
      }}
    ><Download aria-hidden="true" />{labels.download}</Button>
    {failed && <span className="workspace-file-body__download-error" role="alert">{labels.downloadUnavailable}</span>}
  </>;
}

function FileMeta({ preview, locale, includeName = true, fallbackType }: {
  readonly preview: WorkspaceFilePreviewView;
  readonly locale: AppController["state"]["preferences"]["locale"];
  readonly includeName?: boolean;
  readonly fallbackType?: string;
}): JSX.Element {
  const details = [...workspaceFileMetadata(preview, locale)];
  if (details.length === 0 && fallbackType !== undefined) details.push(fallbackType);
  return <span className="workspace-file-body__meta">{[
    includeName ? preview.name : undefined,
    ...details
  ].filter((value): value is string => value !== undefined && value !== "").join(" · ")}</span>;
}

function workspaceFileMetadata(
  preview: WorkspaceFilePreviewView,
  locale: AppController["state"]["preferences"]["locale"]
): readonly string[] {
  return [
    preview.byteSize === undefined ? undefined : formatWorkspaceFileBytes(preview.byteSize),
    preview.modifiedAt === undefined
      ? undefined
      : translate(locale, "workspace.modifiedAt", { time: formatWorkspaceFileMtime(preview.modifiedAt) })
  ].filter((value): value is string => value !== undefined);
}

function BodyState({ children, className, error = false }: { readonly children: string; readonly className?: string; readonly error?: boolean }): JSX.Element {
  return <div className={cx("workspace-file-body workspace-file-body__state", error && "is-error", className)} role={error ? "alert" : "status"}>{children}</div>;
}

function BodyInlineEmpty({ label, icon }: { readonly label: string; readonly icon?: JSX.Element }): JSX.Element {
  return <div className="workspace-file-body__inline-empty">{icon}<span>{label}</span></div>;
}

function DelayedLoading({ className, label }: { readonly className?: string; readonly label: string }): JSX.Element {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 30);
    return () => window.clearTimeout(timer);
  }, []);
  return <div className={cx("workspace-file-body workspace-file-body__state", className)} role="status" aria-label={label}>{visible && <Spinner label={label} />}</div>;
}

type ArtifactUrlState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "error" };

function useAuthenticatedArtifactUrl(controller: WorkspaceFileBodyController, blobId: string | undefined): ArtifactUrlState {
  const [state, setState] = useState<ArtifactUrlState>({ status: "loading" });
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  useEffect(() => {
    let active = true;
    let acquired = false;
    setState({ status: "loading" });
    if (blobId === undefined || blobId === "") {
      setState({ status: "error" });
      return () => { active = false; };
    }
    void controllerRef.current.getArtifactUrl(blobId).then((url) => {
      acquired = true;
      if (active) setState({ status: "ready", url });
      else controllerRef.current.releaseArtifactUrl(blobId);
    }).catch(() => {
      if (active) setState({ status: "error" });
    });
    return () => {
      active = false;
      if (acquired) controllerRef.current.releaseArtifactUrl(blobId);
    };
  }, [blobId]);
  return state;
}

function useWorkspaceModelArtifactUrl(
  controller: WorkspaceFileBodyController,
  workspaceId: string,
  preview: WorkspaceFilePreviewView
): ArtifactUrlState {
  const source = useAuthenticatedArtifactUrl(controller, preview.blobId);
  const [gltf, setGltf] = useState<ArtifactUrlState>({ status: "loading" });
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  useEffect(() => {
    let active = true;
    let materialized: Awaited<ReturnType<typeof materializeWorkspaceModelSource>> | undefined;
    if (source.status !== "ready" || preview.truncated) {
      setGltf(preview.truncated ? { status: "error" } : { status: "loading" });
      return () => { active = false; };
    }
    setGltf({ status: "loading" });
    void materializeWorkspaceModelSource({
      sourceUrl: source.url,
      modelPath: preview.path,
      loadResource: async (path) => {
        const dependency = await controllerRef.current.readWorkspaceFile(workspaceId, path);
        if (dependency.path !== path || dependency.truncated) throw new Error("The model resource is unavailable.");
        if (dependency.kind === "text" && dependency.text !== undefined) {
          return new Blob([dependency.text], { type: dependency.mediaType || workspaceModelResourceMediaType(path) });
        }
        if (dependency.blobId === undefined || dependency.blobId === "") throw new Error("The model resource is unavailable.");
        const url = await controllerRef.current.getArtifactUrl(dependency.blobId);
        try {
          const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
          if (!response.ok) throw new Error("The model resource could not be read.");
          return await response.blob();
        } finally {
          controllerRef.current.releaseArtifactUrl(dependency.blobId);
        }
      }
    }).then((result) => {
      materialized = result;
      if (active) setGltf({ status: "ready", url: result.url });
      else result.dispose();
    }, () => {
      if (active) setGltf({ status: "error" });
    });
    return () => {
      active = false;
      materialized?.dispose();
    };
  }, [preview.path, preview.truncated, source.status, source.status === "ready" ? source.url : undefined, workspaceId]);
  if (preview.truncated) return { status: "error" };
  return source.status === "error" ? source : gltf;
}

export function workspaceFileBodyKind(path: string, preview: WorkspaceFilePreviewView): "text" | "markdown" | "drawio" | "image" | "model" | "pdf" | "video" | "binary" {
  if (isModelPath(path)) return "model";
  if (preview.kind === "text") {
    if (isWorkspaceMarkdownPath(path)) return "markdown";
    if (isDrawioPath(path)) return "drawio";
    return "text";
  }
  const mediaType = preview.mediaType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!isSvgPath(path) && (preview.kind === "image" || isRasterImagePath(path) || isRasterImageMediaType(mediaType))) return "image";
  if (isPdfPath(path) || mediaType === "application/pdf") return "pdf";
  if (isVideoPath(path) || mediaType.startsWith("video/")) return "video";
  return "binary";
}

function isDrawioPath(path: string): boolean {
  return /\.drawio$/iu.test(path);
}

function isSvgPath(path: string): boolean {
  return /\.svg$/iu.test(path);
}

function isPdfPath(path: string): boolean {
  return /\.pdf$/iu.test(path);
}

function isVideoPath(path: string): boolean {
  return /\.(?:mp4|m4v|mov|webm)$/iu.test(path);
}

function isModelPath(path: string): boolean {
  return /\.(?:glb|gltf)$/iu.test(path);
}

function workspaceModelResourceMediaType(path: string): string {
  if (/\.bin$/iu.test(path)) return "application/octet-stream";
  if (/\.ktx2$/iu.test(path)) return "image/ktx2";
  if (/\.jpe?g$/iu.test(path)) return "image/jpeg";
  if (/\.png$/iu.test(path)) return "image/png";
  if (/\.webp$/iu.test(path)) return "image/webp";
  return "application/octet-stream";
}

function isRasterImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp|ico)$/iu.test(path);
}

function isRasterImageMediaType(mediaType: string): boolean {
  return /^(?:image\/(?:png|jpeg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon))$/u.test(mediaType);
}

function workspaceImageName(source: string): string {
  if (/^data:image\//iu.test(source)) {
    const subtype = /^data:image\/([a-z\d.+-]+)/iu.exec(source)?.[1]?.replace("svg+xml", "svg") ?? "png";
    return `image.${subtype}`;
  }
  const clean = source.split(/[?#]/u, 1)[0] ?? source;
  const name = clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1);
  return name || "image";
}

function workspaceImageMediaType(source: string): string | undefined {
  const match = /^data:([^;,]+)/iu.exec(source);
  return match?.[1];
}

export function formatWorkspaceFileBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${(value / 1_073_741_824).toFixed(2)} GB`;
}

export function formatWorkspaceFileMtime(value: number): string {
  const date = new Date(value);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function useWorkspaceFileBodyLabels(locale: AppController["state"]["preferences"]["locale"], overrides: Partial<WorkspaceFileBodyLabels> | undefined): WorkspaceFileBodyLabels {
  return useMemo(() => ({
    selectFile: translate(locale, "workspace.noSelection"),
    loading: translate(locale, "workspace.loadingPreview"),
    editor: translate(locale, "workspace.editor"),
    unsaved: translate(locale, "workspace.unsaved"),
    saving: translate(locale, "workspace.saving"),
    save: translate(locale, "workspace.save"),
    insertTable: translate(locale, "workspace.insertTable"),
    addRowAbove: translate(locale, "workspace.tableAddRowAbove"),
    addRowBelow: translate(locale, "workspace.tableAddRowBelow"),
    deleteRow: translate(locale, "workspace.tableDeleteRow"),
    addColumnLeft: translate(locale, "workspace.tableAddColumnLeft"),
    addColumnRight: translate(locale, "workspace.tableAddColumnRight"),
    deleteColumn: translate(locale, "workspace.tableDeleteColumn"),
    deleteTable: translate(locale, "workspace.tableDeleteTable"),
    mermaidZoom: translate(locale, "workspace.mermaidZoom"),
    mermaidCopy: translate(locale, "workspace.mermaidCopy"),
    mermaidCopied: translate(locale, "workspace.mermaidCopied"),
    mermaidCopyFailed: translate(locale, "workspace.mermaidCopyFailed"),
    mermaidEditSource: translate(locale, "workspace.mermaidEditSource"),
    mermaidRenderFailed: translate(locale, "workspace.mermaidRenderFailed"),
    mermaidEditTitle: translate(locale, "workspace.mermaidEditTitle"),
    mermaidSource: translate(locale, "workspace.mermaidSource"),
    mermaidApply: translate(locale, "workspace.mermaidApply"),
    mermaidTargetMissing: translate(locale, "workspace.mermaidTargetMissing"),
    mermaidZoomOut: translate(locale, "workspace.mermaidZoomOut"),
    mermaidZoomIn: translate(locale, "workspace.mermaidZoomIn"),
    cancel: translate(locale, "common.cancel"),
    close: translate(locale, "common.close"),
    documentSearch: translate(locale, "workspace.documentSearch"),
    documentSearchPlaceholder: translate(locale, "workspace.documentSearchPlaceholder"),
    documentSearchPrevious: translate(locale, "workspace.documentSearchPrevious"),
    documentSearchNext: translate(locale, "workspace.documentSearchNext"),
    documentSearchClose: translate(locale, "workspace.documentSearchClose"),
    documentSearchTruncated: translate(locale, "workspace.documentSearchTruncated"),
    saveFailed: translate(locale, "workspace.saveFailed"),
    externalChange: translate(locale, "workspace.externalChange"),
    reloadDisk: translate(locale, "workspace.reloadDisk"),
    keepEditing: translate(locale, "workspace.keepEditing"),
    overwriteDisk: translate(locale, "workspace.overwriteDisk"),
    addToChat: translate(locale, "timeline.addToChat"),
    truncated: translate(locale, "workspace.previewTruncated"),
    download: translate(locale, "workspace.downloadFile"),
    downloadUnavailable: translate(locale, "workspace.downloadUnavailable"),
    unavailable: translate(locale, "workspace.filePreviewUnavailable"),
    imageUnavailable: translate(locale, "workspace.imageUnavailable"),
    imageOpen: translate(locale, "workspace.imageOpen"),
    imageCopy: translate(locale, "workspace.imageCopy"),
    imageCopied: translate(locale, "workspace.imageCopied"),
    imageCopyFailed: translate(locale, "workspace.imageCopyFailed"),
    imageSaveAs: translate(locale, "workspace.imageSaveAs"),
    imageSaveFailed: translate(locale, "workspace.imageSaveFailed"),
    imageAnnotate: translate(locale, "workspace.imageAnnotate"),
    imageDiscardAnnotation: translate(locale, "workspace.imageDiscardAnnotation"),
    imageUndoAnnotation: translate(locale, "workspace.imageUndoAnnotation"),
    imageSendToChat: translate(locale, "workspace.imageSendToChat"),
    imageSendFailed: translate(locale, "workspace.imageSendFailed"),
    modelLoading: translate(locale, "workspace.modelLoading"),
    modelUnavailable: translate(locale, "workspace.modelUnavailable"),
    modelOpen: translate(locale, "workspace.modelOpen"),
    modelZoomIn: translate(locale, "workspace.modelZoomIn"),
    modelZoomOut: translate(locale, "workspace.modelZoomOut"),
    modelReset: translate(locale, "workspace.modelReset"),
    modelInteractionHint: translate(locale, "workspace.modelInteractionHint"),
    modelDownloadFailed: translate(locale, "workspace.modelDownloadFailed"),
    pdfPreview: translate(locale, "workspace.pdfPreview"),
    drawioRendering: translate(locale, "workspace.drawioRendering"),
    drawioUnavailable: translate(locale, "workspace.drawioPreviewUnavailable"),
    retry: translate(locale, "common.retry"),
    binary: translate(locale, "workspace.binary"),
    ...overrides
  }), [locale, overrides]);
}

const EMPTY_DOCUMENT_SEARCH_STATE: WorkspaceEditorSearchState = { query: "", total: 0, activeIndex: 0, truncated: false };

function emptyDocumentSearchState(query: string): WorkspaceEditorSearchState {
  return query === "" ? EMPTY_DOCUMENT_SEARCH_STATE : { ...EMPTY_DOCUMENT_SEARCH_STATE, query };
}

function documentSearchLabels(labels: WorkspaceFileBodyLabels): WorkspaceDocumentSearchBarLabels {
  return {
    search: labels.documentSearch,
    placeholder: labels.documentSearchPlaceholder,
    previous: labels.documentSearchPrevious,
    next: labels.documentSearchNext,
    close: labels.documentSearchClose,
    truncated: labels.documentSearchTruncated
  };
}

function imageLightboxLabels(labels: WorkspaceFileBodyLabels): WorkspaceImageLightboxLabels {
  return {
    close: labels.close,
    copy: labels.imageCopy,
    copied: labels.imageCopied,
    copyFailed: labels.imageCopyFailed,
    saveAs: labels.imageSaveAs,
    saveFailed: labels.imageSaveFailed,
    annotate: labels.imageAnnotate,
    discardAnnotation: labels.imageDiscardAnnotation,
    undoAnnotation: labels.imageUndoAnnotation,
    sendToChat: labels.imageSendToChat,
    sendFailed: labels.imageSendFailed
  };
}

function modelLightboxLabels(labels: WorkspaceFileBodyLabels): WorkspaceModelLightboxLabels {
  return {
    loading: labels.modelLoading,
    unavailable: labels.modelUnavailable,
    close: labels.close,
    download: labels.download,
    downloadFailed: labels.modelDownloadFailed,
    zoomIn: labels.modelZoomIn,
    zoomOut: labels.modelZoomOut,
    reset: labels.modelReset,
    interactionHint: labels.modelInteractionHint
  };
}

export function workspaceDocumentShortcutAction(
  input: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "defaultPrevented">,
  overrides: AppShortcutOverrides = {},
  platform?: AppShortcutPlatform
): "find" | "save" | undefined {
  if (eventMatchesAppShortcut("find-in-page", input, overrides, platform)) return "find";
  if (eventMatchesAppShortcut("save-file", input, overrides, platform)) return "save";
  return undefined;
}

function workspaceDocumentShortcutBlocked(ownerDocument: Document, target: EventTarget | null): boolean {
  if (ownerDocument.querySelector(".modal-layer, [role='dialog'][aria-modal='true'], .workspace-image-lightbox, .workspace-model-lightbox, .workspace-mermaid-lightbox") !== null) {
    return true;
  }
  const targetElement = target instanceof Element ? target : null;
  if (targetElement !== null && targetElement.closest("[data-doc-search-bar]") !== null) return false;
  return false;
}

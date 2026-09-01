import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, RotateCcw, Save, Table2 } from "lucide-react";

import type { ComposerFileSelectionQuoteDraft, ComposerSelectionQuoteDraft } from "../model.js";
import type { WorkspaceDocumentController } from "../workspace-document-controller.js";
import { SelectionQuoteButton } from "./SelectionQuoteButton.js";
import {
  isWorkspaceFileStaleError,
  normalizeWorkspaceEditorText,
  prepareWorkspaceFileSave,
  reconcileWorkspaceFileSaveSuccess,
  reconcileWorkspaceExternalFileUpdate,
  workspaceFileEditorDirty,
  type WorkspaceFileEditorBaseline,
  type WorkspaceFileSaveDraft
} from "./workspace-file-editor.js";
import {
  WorkspaceTextEditor,
  type WorkspaceEditorSearchState,
  type WorkspaceEditorSelection,
  type WorkspaceTextEditorHandle
} from "./WorkspaceTextEditor.js";
import { isWorkspaceMarkdownPath } from "./workspace-file-types.js";
import type { WorkspaceMarkdownImageLabels, WorkspaceMarkdownImageResolver } from "./workspace-markdown-images.js";
import { Button, Spinner, cx } from "./ui.js";

export interface WorkspaceEditableFile extends WorkspaceFileEditorBaseline {
  readonly languageId?: string;
}

export interface WorkspaceFileSaveResult {
  readonly revision: string;
  /** Exact persisted text; omitted when the server retained the submitted bytes unchanged. */
  readonly text?: string;
}

export interface WorkspaceFileEditorPaneHandle {
  isDirty(): boolean;
  save(): Promise<boolean>;
  discardLocalChanges(): void;
  getValue(): string;
  getSelection(): WorkspaceEditorSelection | undefined;
  focus(): void;
  search(query: string, targetLine?: number): boolean;
  searchState(query: string, targetLine?: number): WorkspaceEditorSearchState;
  activateSearch(query: string, index: number): WorkspaceEditorSearchState;
  clearSearch(): void;
  revealLine(line: number): void;
}

export interface WorkspaceFileEditorLabels {
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
}

export interface WorkspaceFileEditorPaneProps {
  readonly file: WorkspaceEditableFile;
  readonly labels: WorkspaceFileEditorLabels;
  readonly wordWrap?: boolean;
  /** Workspace-qualified identity used by scroll restoration. */
  readonly scrollKey?: string;
  readonly suppressInitialScrollRestore?: boolean;
  readonly markdownImageLabels?: WorkspaceMarkdownImageLabels;
  readonly markdownImageResolver?: WorkspaceMarkdownImageResolver;
  readonly onSave: (draft: WorkspaceFileSaveDraft) => Promise<WorkspaceFileSaveResult>;
  readonly onSelectionChange?: (selection: WorkspaceEditorSelection | undefined) => void;
  readonly onSearchStateChange?: (state: WorkspaceEditorSearchState) => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  /** Reports the current LF editor buffer, including accepted external reloads. */
  readonly onTextChange?: (text: string, dirty: boolean) => void;
  readonly onExternalConflict?: () => void;
  readonly selectionQuoteSessionId?: string;
  readonly selectionQuoteLabel?: string;
  readonly onSelectionQuote?: (quote: ComposerFileSelectionQuoteDraft) => void;
  /** Registers this editor in the shared route/session/window leave guard. */
  readonly documentGuard?: {
    readonly controller: WorkspaceDocumentController;
    readonly sessionId: string;
    readonly workspaceId: string;
  };
}

/**
 * Always-edit file body. It keeps disk bytes as the revision
 * baseline, exposes only the LF editor buffer, and never overwrites dirty text
 * when a watcher observes an external revision.
 */
export const WorkspaceFileEditorPane = forwardRef<WorkspaceFileEditorPaneHandle, WorkspaceFileEditorPaneProps>(function WorkspaceFileEditorPane({
  file,
  labels,
  wordWrap = true,
  scrollKey,
  suppressInitialScrollRestore,
  markdownImageLabels,
  markdownImageResolver,
  onSave,
  onSelectionChange,
  onSearchStateChange,
  onDirtyChange,
  onTextChange,
  onExternalConflict,
  selectionQuoteSessionId,
  selectionQuoteLabel,
  onSelectionQuote,
  documentGuard
}, forwardedRef) {
  const [baseline, setBaseline] = useState<WorkspaceFileEditorBaseline>(file);
  const [editorText, setEditorText] = useState(() => normalizeWorkspaceEditorText(file.text));
  const [incomingConflict, setIncomingConflict] = useState<WorkspaceFileEditorBaseline>();
  const [conflictDismissed, setConflictDismissed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [menuPosition, setMenuPosition] = useState<{ readonly x: number; readonly y: number }>();
  const menuInsertionPointRef = useRef<{ readonly x: number; readonly y: number } | undefined>(undefined);
  const rootRef = useRef<HTMLElement>(null);
  const editorRef = useRef<WorkspaceTextEditorHandle>(null);
  const quoteSelectionRef = useRef<WorkspaceEditorSelection | undefined>(undefined);
  const baselineRef = useRef(baseline);
  const editorTextRef = useRef(editorText);
  const savingRef = useRef(false);
  baselineRef.current = baseline;
  editorTextRef.current = editorText;

  const dirty = workspaceFileEditorDirty(baseline, editorText);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  useEffect(() => {
    const incoming: WorkspaceFileEditorBaseline = file;
    const reconciled = reconcileWorkspaceExternalFileUpdate(
      baselineRef.current,
      editorTextRef.current,
      incoming
    );
    if (reconciled.kind === "unchanged") return;
    if (reconciled.kind === "conflict") {
      setIncomingConflict(reconciled.incoming);
      setConflictDismissed(false);
      onExternalConflict?.();
      return;
    }
    baselineRef.current = reconciled.baseline;
    editorTextRef.current = normalizeWorkspaceEditorText(reconciled.editorText);
    setBaseline(reconciled.baseline);
    setEditorText(editorTextRef.current);
    setIncomingConflict(undefined);
    setConflictDismissed(false);
    setSaveError(undefined);
    onTextChange?.(editorTextRef.current, workspaceFileEditorDirty(reconciled.baseline, editorTextRef.current));
  }, [file.path, file.revision, file.text, onExternalConflict, onTextChange]);

  const save = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) return false;
    const currentBaseline = baselineRef.current;
    const currentText = editorTextRef.current;
    const draft = prepareWorkspaceFileSave(currentBaseline, currentText);
    if (draft === undefined) {
      setSaveError(undefined);
      return true;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await onSave(draft);
      const reconciled = reconcileWorkspaceFileSaveSuccess(
        currentBaseline,
        currentText,
        editorTextRef.current,
        result.revision,
        result.text
      );
      baselineRef.current = reconciled.baseline;
      editorTextRef.current = reconciled.editorText;
      setBaseline(reconciled.baseline);
      setEditorText(reconciled.editorText);
      setIncomingConflict(undefined);
      setConflictDismissed(false);
      onTextChange?.(reconciled.editorText, workspaceFileEditorDirty(reconciled.baseline, reconciled.editorText));
      return true;
    } catch (error) {
      setSaveError(isWorkspaceFileStaleError(error)
        ? labels.externalChange
        : `${labels.saveFailed}: ${messageOf(error)}`);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [labels.externalChange, labels.saveFailed, onSave, onTextChange]);

  const discardLocalChanges = useCallback((): void => {
    const next = incomingConflict ?? baselineRef.current;
    baselineRef.current = next;
    editorTextRef.current = normalizeWorkspaceEditorText(next.text);
    setBaseline(next);
    setEditorText(editorTextRef.current);
    setIncomingConflict(undefined);
    setConflictDismissed(false);
    setSaveError(undefined);
    onTextChange?.(editorTextRef.current, false);
  }, [incomingConflict, onTextChange]);

  const overwriteIncoming = useCallback(async (): Promise<void> => {
    if (incomingConflict === undefined) return;
    baselineRef.current = incomingConflict;
    setBaseline(incomingConflict);
    setIncomingConflict(undefined);
    setConflictDismissed(false);
    setSaveError(undefined);
    await save();
  }, [incomingConflict, save]);

  useImperativeHandle(forwardedRef, () => ({
    isDirty: () => workspaceFileEditorDirty(baselineRef.current, editorTextRef.current),
    save,
    discardLocalChanges,
    getValue: () => editorTextRef.current,
    getSelection: () => editorRef.current?.getSelection(),
    focus: () => editorRef.current?.focus(),
    search: (query, targetLine) => editorRef.current?.search(query, targetLine) ?? false,
    searchState: (query, targetLine) => editorRef.current?.searchState(query, targetLine) ?? { query, total: 0, activeIndex: 0, truncated: false },
    activateSearch: (query, index) => editorRef.current?.activateSearch(query, index) ?? { query, total: 0, activeIndex: 0, truncated: false },
    clearSearch: () => editorRef.current?.clearSearch(),
    revealLine: (line) => editorRef.current?.revealLine(line)
  }), [discardLocalChanges, save]);

  useEffect(() => {
    if (documentGuard === undefined) return;
    const registration = documentGuard.controller.register({
      identity: {
        sessionId: documentGuard.sessionId,
        workspaceId: documentGuard.workspaceId,
        path: file.path
      },
      isDirty: () => workspaceFileEditorDirty(baselineRef.current, editorTextRef.current),
      save,
      discard: discardLocalChanges,
      focus: () => editorRef.current?.focus()
    });
    return () => registration.unregister();
  }, [discardLocalChanges, documentGuard, file.path, save]);

  const markdown = isWorkspaceMarkdownPath(file.path);
  const markdownTableLabels = useMemo(() => ({
    addRowAbove: labels.addRowAbove,
    addRowBelow: labels.addRowBelow,
    deleteRow: labels.deleteRow,
    addColumnLeft: labels.addColumnLeft,
    addColumnRight: labels.addColumnRight,
    deleteColumn: labels.deleteColumn,
    deleteTable: labels.deleteTable
  }), [
    labels.addColumnLeft,
    labels.addColumnRight,
    labels.addRowAbove,
    labels.addRowBelow,
    labels.deleteColumn,
    labels.deleteRow,
    labels.deleteTable
  ]);
  const markdownMermaidLabels = useMemo(() => ({
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

  useEffect(() => {
    if (!markdown || !dirty || saving || incomingConflict !== undefined || saveError !== undefined) return;
    const timer = window.setTimeout(() => { void save(); }, 900);
    return () => window.clearTimeout(timer);
  }, [dirty, editorText, incomingConflict, markdown, save, saveError, saving]);

  useEffect(() => {
    if (menuPosition === undefined) return;
    const ownerDocument = rootRef.current?.ownerDocument;
    if (ownerDocument === undefined) return;
    const close = (): void => {
      setMenuPosition(undefined);
      menuInsertionPointRef.current = undefined;
    };
    const keydown = (event: KeyboardEvent): void => { if (event.key === "Escape") close(); };
    ownerDocument.addEventListener("pointerdown", close);
    ownerDocument.addEventListener("keydown", keydown);
    return () => {
      ownerDocument.removeEventListener("pointerdown", close);
      ownerDocument.removeEventListener("keydown", keydown);
    };
  }, [menuPosition]);

  const handleChange = useCallback((value: string): void => {
    editorTextRef.current = value;
    setSaveError(undefined);
    setEditorText(value);
    onTextChange?.(value, workspaceFileEditorDirty(baselineRef.current, value));
  }, [onTextChange]);

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
    if (quote.kind === "file") onSelectionQuote?.(quote);
  }, [onSelectionQuote]);

  const quoteEnabled = selectionQuoteSessionId !== undefined
    && selectionQuoteLabel !== undefined
    && onSelectionQuote !== undefined;

  return <section
    ref={rootRef}
    className="workspace-file-editor-pane"
    data-dirty={dirty ? "true" : "false"}
    data-selection-quote-context={quoteEnabled ? "" : undefined}
    data-joko-selection-quote-context={quoteEnabled ? "" : undefined}
    onContextMenu={(event) => {
      if (event.target instanceof Element && event.target.closest(".cm-md-table-widget") !== null) return;
      event.preventDefault();
      const ownerWindow = event.currentTarget.ownerDocument.defaultView;
      if (ownerWindow === null) return;
      menuInsertionPointRef.current = { x: event.clientX, y: event.clientY };
      setMenuPosition({
        x: Math.min(Math.max(8, event.clientX), Math.max(8, ownerWindow.innerWidth - 176)),
        y: Math.min(Math.max(8, event.clientY), Math.max(8, ownerWindow.innerHeight - 48))
      });
    }}
  >
    <div className="workspace-file-editor-pane__status" aria-live="polite">
      {(dirty || saving) && <span className={cx("workspace-file-editor-chip", dirty && !saving && "is-dirty")}>
        {saving ? <Spinner label={labels.saving} /> : <i aria-hidden="true" />}
        {saving ? labels.saving : labels.unsaved}
      </span>}
    </div>
    {((incomingConflict !== undefined && !conflictDismissed) || saveError !== undefined) && <div className="workspace-file-editor-alert" role="alert">
      <AlertTriangle aria-hidden="true" />
      <span>{saveError ?? labels.externalChange}</span>
      {incomingConflict !== undefined && <div>
        <Button tone="ghost" onClick={() => { setConflictDismissed(true); setSaveError(undefined); }}>{labels.keepEditing}</Button>
        <Button tone="secondary" onClick={discardLocalChanges}><RotateCcw aria-hidden="true" />{labels.reloadDisk}</Button>
        <Button tone="danger" onClick={() => { void overwriteIncoming(); }}><Save aria-hidden="true" />{labels.overwriteDisk}</Button>
      </div>}
    </div>}
    <WorkspaceTextEditor
      ref={editorRef}
      path={file.path}
      languageId={file.languageId}
      value={editorText}
      wordWrap={wordWrap}
      scrollKey={scrollKey}
      suppressInitialScrollRestore={suppressInitialScrollRestore}
      markdownImageLabels={markdownImageLabels}
      markdownImageResolver={markdownImageResolver}
      ariaLabel={labels.editor}
      markdownTableLabels={markdownTableLabels}
      markdownMermaidLabels={markdownMermaidLabels}
      onChange={handleChange}
      onSave={() => { void save(); }}
      onSelectionChange={onSelectionChange}
      onSearchStateChange={onSearchStateChange}
    />
    {quoteEnabled && <SelectionQuoteButton
      sessionId={selectionQuoteSessionId}
      containerRef={rootRef}
      sourcePath={file.path}
      getQuoteText={getQuoteText}
      getQuoteMetadata={getQuoteMetadata}
      label={selectionQuoteLabel}
      onCommit={commitSelectionQuote}
    />}
    {menuPosition !== undefined && rootRef.current !== null && createPortal(<div
      className="workspace-file-editor-menu"
      role="menu"
      aria-orientation="vertical"
      style={{ left: menuPosition.x, top: menuPosition.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {markdown
        ? <button type="button" role="menuitem" onClick={() => {
            const point = menuInsertionPointRef.current;
            setMenuPosition(undefined);
            menuInsertionPointRef.current = undefined;
            editorRef.current?.insertMarkdownTableAt(point);
          }}>
            <Table2 aria-hidden="true" />
            <span>{labels.insertTable}</span>
          </button>
        : <button type="button" role="menuitem" disabled={!dirty || saving} onClick={() => {
            setMenuPosition(undefined);
            menuInsertionPointRef.current = undefined;
            void save();
          }}>
            <Save aria-hidden="true" />
            <span>{labels.save}</span>
            <kbd>{rootRef.current.ownerDocument.defaultView?.navigator.platform.toLowerCase().includes("mac") === true ? "⌘S" : "Ctrl+S"}</kbd>
          </button>}
    </div>, rootRef.current.ownerDocument.body)}
  </section>;
});

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

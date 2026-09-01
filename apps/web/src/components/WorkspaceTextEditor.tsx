import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting
} from "@codemirror/language";
import { dart, kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { r } from "@codemirror/legacy-modes/mode/r";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { SearchQuery, highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection
} from "@codemirror/view";
import { csharp } from "@replit/codemirror-lang-csharp";
import { tags } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import {
  DEFAULT_WORKSPACE_MARKDOWN_TABLE_LABELS,
  insertWorkspaceMarkdownTable,
  workspaceMarkdownLivePreviewExtensions,
  type WorkspaceMarkdownTableLabels
} from "./workspace-markdown-live-preview.js";
import {
  workspaceMarkdownMermaidThemeChanged,
  workspaceMarkdownMermaidExtensions,
  type WorkspaceMarkdownMermaidLabels
} from "./workspace-markdown-mermaid.js";
import {
  workspaceMarkdownImageExtensions,
  type WorkspaceMarkdownImageLabels,
  type WorkspaceMarkdownImageResolver
} from "./workspace-markdown-images.js";
import { isWorkspaceMarkdownPath } from "./workspace-file-types.js";
import { loadWorkspaceFileScroll, saveWorkspaceFileScroll } from "./workspace-file-scroll-store.js";
import { normalizeWorkspaceFileSource, workspaceFileQuoteFromOffsets } from "./workspace-file-selection.js";

export interface WorkspaceEditorSelection {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface WorkspaceTextEditorHandle {
  getValue(): string;
  getSelection(): WorkspaceEditorSelection | undefined;
  focus(): void;
  /** Highlight a literal query and reveal its first match on/after targetLine. */
  search(query: string, targetLine?: number): boolean;
  /** Populate the document-search surface without changing source selection. */
  searchState(query: string, targetLine?: number): WorkspaceEditorSearchState;
  /** Move the active document-search decoration, wrapping at either end. */
  activateSearch(query: string, index: number): WorkspaceEditorSearchState;
  clearSearch(): void;
  /** Insert the default Markdown table at a viewport point or cursor. */
  insertMarkdownTableAt(coordinates?: { readonly x: number; readonly y: number }): boolean;
  /** Reveal a one-indexed source line without opening CodeMirror's search panel. */
  revealLine(line: number): void;
}

export interface WorkspaceEditorSearchState {
  readonly query: string;
  readonly total: number;
  readonly activeIndex: number;
  readonly truncated: boolean;
}

interface WorkspaceEditorSearchRange {
  readonly from: number;
  readonly to: number;
}

interface WorkspaceEditorSearchDecorations {
  readonly query: string;
  readonly matches: readonly WorkspaceEditorSearchRange[];
  readonly activeIndex: number;
}
interface WorkspaceEditorSearchFieldValue extends WorkspaceEditorSearchDecorations {
  readonly decorations: DecorationSet;
}
const setWorkspaceSearchDecorations = StateEffect.define<WorkspaceEditorSearchDecorations>();
const workspaceSearchDecoration = Decoration.mark({ class: "cm-doc-search-match" });
const workspaceActiveSearchDecoration = Decoration.mark({ class: "cm-doc-search-match cm-doc-search-active" });
const workspaceActiveSearchField = StateField.define<WorkspaceEditorSearchFieldValue>({
  create: () => workspaceEditorSearchFieldValue("", [], -1),
  update(value, transaction) {
    let next: WorkspaceEditorSearchFieldValue | undefined;
    for (const effect of transaction.effects) {
      if (!effect.is(setWorkspaceSearchDecorations)) continue;
      next = workspaceEditorSearchFieldValue(effect.value.query, effect.value.matches, effect.value.activeIndex);
    }
    if (next !== undefined) return next;
    if (transaction.docChanged && value.query !== "") {
      const collected = collectWorkspaceDocumentMatches(transaction.state, value.query);
      const activeIndex = collected.matches.length === 0
        ? -1
        : Math.min(Math.max(value.activeIndex, 0), collected.matches.length - 1);
      return workspaceEditorSearchFieldValue(value.query, collected.matches, activeIndex);
    }
    return { ...value, decorations: value.decorations.map(transaction.changes) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
});

export interface WorkspaceTextEditorProps {
  readonly path: string;
  readonly value: string;
  readonly languageId?: string;
  readonly readOnly?: boolean;
  readonly wordWrap?: boolean;
  /** Workspace-qualified identity; defaults to path for standalone callers. */
  readonly scrollKey?: string;
  /** One-shot project-search jumps must win over a previously saved reading position. */
  readonly suppressInitialScrollRestore?: boolean;
  readonly ariaLabel: string;
  readonly markdownTableLabels?: WorkspaceMarkdownTableLabels;
  readonly markdownMermaidLabels?: WorkspaceMarkdownMermaidLabels;
  readonly markdownImageLabels?: WorkspaceMarkdownImageLabels;
  readonly markdownImageResolver?: WorkspaceMarkdownImageResolver;
  readonly onChange?: (value: string) => void;
  readonly onSave?: (value: string) => void;
  readonly onSelectionChange?: (selection: WorkspaceEditorSelection | undefined) => void;
  /** Recomputed synchronously whenever an active document search sees edits. */
  readonly onSearchStateChange?: (state: WorkspaceEditorSearchState) => void;
}

export const DEFAULT_WORKSPACE_MARKDOWN_MERMAID_LABELS: WorkspaceMarkdownMermaidLabels = {
  zoom: "Zoom diagram",
  copy: "Copy diagram",
  copied: "Copied",
  copyFailed: "Could not copy diagram",
  editSource: "Edit source",
  renderFailed: "Could not render Mermaid: "
};

export const DEFAULT_WORKSPACE_MARKDOWN_IMAGE_LABELS: WorkspaceMarkdownImageLabels = {
  open: "Open image",
  loading: "Loading image",
  loadFailed: "Could not load image"
};

export type WorkspaceEditorChrome = "code" | "markdown" | "plain";

const PLAIN_LANGUAGE_IDS = new Set(["", "text", "txt", "plain", "plaintext", "log"]);

/** Use three deliberately different CodeMirror surfaces. */
export function workspaceEditorChrome(languageId: string | undefined): WorkspaceEditorChrome {
  const language = languageId?.trim().toLowerCase() ?? "";
  if (language === "markdown" || language === "md") return "markdown";
  return PLAIN_LANGUAGE_IDS.has(language) ? "plain" : "code";
}

export const WORKSPACE_LARGE_DOCUMENT_CHARS = 256 * 1024;
export const WORKSPACE_LONG_LINE_CHARS = 5_000;

export function workspaceEditorDegradation(value: string): { readonly largeDocument: boolean; readonly longLine: boolean } {
  const largeDocument = value.length > WORKSPACE_LARGE_DOCUMENT_CHARS;
  if (!largeDocument) return { largeDocument, longLine: false };
  let lineStart = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index !== value.length && value.charCodeAt(index) !== 10) continue;
    if (index - lineStart > WORKSPACE_LONG_LINE_CHARS) return { largeDocument, longLine: true };
    lineStart = index + 1;
  }
  return { largeDocument, longLine: false };
}

/** The file body chooses syntax from the file first and server language second. */
export function workspaceEditorLanguageId(path: string, languageId?: string): string {
  const explicit = languageId?.trim().toLowerCase();
  const fileName = path.replace(/\\/gu, "/").split("/").at(-1)?.toLowerCase() ?? "";
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : "";
  if (isWorkspaceMarkdownPath(path)) return "markdown";
  if (fileName === "makefile") return "makefile";
  if (fileName === "dockerfile") return "dockerfile";
  if (fileName === "procfile") return "shell";
  const fromExtension: Readonly<Record<string, string>> = {
    ".c": "cpp", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".h": "cpp", ".hh": "cpp", ".hpp": "cpp",
    ".cs": "csharp",
    ".css": "css", ".scss": "css", ".sass": "css", ".less": "css",
    ".vue": "xml", ".svelte": "xml",
    ".graphql": "graphql", ".gql": "graphql",
    ".go": "go",
    ".htm": "html", ".html": "html",
    ".java": "java",
    ".js": "javascript", ".jsx": "jsx", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "tsx", ".mts": "typescript", ".cts": "typescript",
    ".json": "json", ".jsonc": "json",
    ".php": "php",
    ".py": "python", ".pyw": "python",
    ".rs": "rust",
    ".sql": "sql",
    ".kt": "kotlin", ".kts": "kotlin",
    ".dart": "dart", ".scala": "scala", ".sc": "scala", ".swift": "swift",
    ".rb": "ruby", ".lua": "lua",
    ".bash": "shell", ".sh": "shell", ".zsh": "shell",
    ".ps1": "powershell", ".psm1": "powershell",
    ".toml": "toml", ".ini": "ini", ".properties": "properties",
    ".pl": "perl", ".pm": "perl", ".groovy": "groovy", ".gradle": "groovy",
    ".hs": "haskell", ".lhs": "haskell", ".r": "r",
    ".diff": "diff", ".patch": "diff", ".proto": "protobuf",
    ".dockerfile": "dockerfile", ".makefile": "makefile", ".mk": "makefile",
    ".xml": "xml", ".svg": "xml",
    ".yaml": "yaml", ".yml": "yaml"
  };
  return fromExtension[extension] ?? explicit ?? "text";
}

export function workspaceEditorSelection(
  text: string,
  anchor: number,
  head: number
): WorkspaceEditorSelection | undefined {
  const source = normalizeWorkspaceFileSource(text);
  const quote = workspaceFileQuoteFromOffsets(source, anchor, head);
  if (quote === undefined) return undefined;
  return {
    from: Math.min(anchor, head),
    to: Math.max(anchor, head),
    text: quote.text,
    startLine: quote.startLine,
    endLine: quote.endLine
  };
}

export const WorkspaceTextEditor = forwardRef<WorkspaceTextEditorHandle, WorkspaceTextEditorProps>(function WorkspaceTextEditor({
  path,
  value,
  languageId,
  readOnly = false,
  wordWrap = true,
  scrollKey = path,
  suppressInitialScrollRestore = false,
  ariaLabel,
  markdownTableLabels = DEFAULT_WORKSPACE_MARKDOWN_TABLE_LABELS,
  markdownMermaidLabels = DEFAULT_WORKSPACE_MARKDOWN_MERMAID_LABELS,
  markdownImageLabels = DEFAULT_WORKSPACE_MARKDOWN_IMAGE_LABELS,
  markdownImageResolver,
  onChange,
  onSave,
  onSelectionChange,
  onSearchStateChange
}, forwardedRef) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const applyingExternalRef = useRef(false);
  const callbacksRef = useRef({ onChange, onSave, onSelectionChange, onSearchStateChange });
  callbacksRef.current = { onChange, onSave, onSelectionChange, onSearchStateChange };
  const language = useMemo(() => workspaceEditorLanguageId(path, languageId), [languageId, path]);

  useImperativeHandle(forwardedRef, () => ({
    getValue: () => viewRef.current?.state.doc.toString() ?? value,
    getSelection: () => {
      const view = viewRef.current;
      if (view === undefined) return undefined;
      const selection = view.state.selection.main;
      return workspaceEditorSelection(view.state.doc.toString(), selection.anchor, selection.head);
    },
    focus: () => viewRef.current?.focus(),
    search: (query, targetLine) => {
      const view = viewRef.current;
      if (view === undefined) return false;
      return applyWorkspaceDocumentSearch(view, query, targetLine).total > 0;
    },
    searchState: (query, targetLine) => {
      const view = viewRef.current;
      return view === undefined ? emptyWorkspaceEditorSearchState(query) : applyWorkspaceDocumentSearch(view, query, targetLine);
    },
    activateSearch: (query, index) => {
      const view = viewRef.current;
      return view === undefined ? emptyWorkspaceEditorSearchState(query) : activateWorkspaceDocumentSearch(view, query, index);
    },
    clearSearch: () => {
      const view = viewRef.current;
      if (view === undefined) return;
      view.dispatch({ effects: setWorkspaceSearchDecorations.of({ query: "", matches: [], activeIndex: -1 }) });
    },
    insertMarkdownTableAt: (coordinates) => {
      const view = viewRef.current;
      return view === undefined || language !== "markdown"
        ? false
        : insertWorkspaceMarkdownTable(view, coordinates);
    },
    revealLine: (lineNumber) => {
      const view = viewRef.current;
      if (view === undefined) return;
      const line = view.state.doc.line(clampEditorLine(view.state.doc.lines, lineNumber));
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: "center" })
      });
    }
  }), [language, value]);

  useLayoutEffect(() => {
    const parent = hostRef.current;
    if (parent === null) return;
    const degradation = workspaceEditorDegradation(value);
    const state = EditorState.create({
      doc: value,
      extensions: workspaceEditorExtensions({
        language,
        readOnly,
        wordWrap: wordWrap && !degradation.longLine,
        syntaxHighlighting: !degradation.largeDocument,
        ariaLabel,
        markdownTableLabels,
        markdownMermaidLabels,
        markdownImageLabels,
        markdownImageResolver
      }, applyingExternalRef, callbacksRef)
    });
    const view = new EditorView({ state, parent });
    viewRef.current = view;
    const ownerWindow = parent.ownerDocument.defaultView;
    const refreshMermaidTheme = (): void => {
      if (viewRef.current === view) view.dispatch({ effects: workspaceMarkdownMermaidThemeChanged.of(undefined) });
    };
    const themeObserver = workspaceEditorChrome(language) === "markdown" && ownerWindow !== null
      ? new ownerWindow.MutationObserver(refreshMermaidTheme)
      : undefined;
    themeObserver?.observe(parent.ownerDocument.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const colorScheme = workspaceEditorChrome(language) === "markdown" ? ownerWindow?.matchMedia("(prefers-color-scheme: dark)") : undefined;
    colorScheme?.addEventListener("change", refreshMermaidTheme);
    const savedScroll = suppressInitialScrollRestore ? undefined : loadWorkspaceFileScroll(scrollKey);
    let restoreFrame: number | undefined;
    let restoreTicks = savedScroll === undefined ? 0 : 8;
    let restoring = savedScroll !== undefined;
    const readAnchor = (): { readonly top: number; readonly line: number | null; readonly offset: number | null } => {
      const top = view.scrollDOM.scrollTop;
      try {
        const block = view.lineBlockAtHeight(top);
        return { top, line: view.state.doc.lineAt(block.from).number, offset: top - block.top };
      } catch {
        return { top, line: null, offset: null };
      }
    };
    const persistScroll = (): void => {
      if (!restoring) saveWorkspaceFileScroll(scrollKey, readAnchor());
    };
    const restore = (): void => {
      if (savedScroll === undefined || restoreTicks <= 0) {
        restoring = false;
        persistScroll();
        return;
      }
      restoreTicks -= 1;
      try {
        if (savedScroll.line !== null && savedScroll.line >= 1 && savedScroll.line <= view.state.doc.lines) {
          const line = view.state.doc.line(savedScroll.line);
          view.scrollDOM.scrollTop = view.lineBlockAt(line.from).top + (savedScroll.offset ?? 0);
        } else {
          view.scrollDOM.scrollTop = savedScroll.top;
        }
        view.requestMeasure();
      } catch {
        view.scrollDOM.scrollTop = savedScroll.top;
      }
      restoreFrame = window.requestAnimationFrame(restore);
    };
    const cancelRestore = (): void => {
      if (!restoring) return;
      restoring = false;
      restoreTicks = 0;
      if (restoreFrame !== undefined) window.cancelAnimationFrame(restoreFrame);
      persistScroll();
    };
    view.scrollDOM.addEventListener("scroll", persistScroll, { passive: true });
    view.scrollDOM.addEventListener("wheel", cancelRestore, { passive: true });
    view.scrollDOM.addEventListener("touchmove", cancelRestore, { passive: true });
    view.scrollDOM.addEventListener("pointerdown", cancelRestore, { passive: true });
    view.scrollDOM.addEventListener("keydown", cancelRestore);
    if (savedScroll !== undefined) restore();
    return () => {
      themeObserver?.disconnect();
      colorScheme?.removeEventListener("change", refreshMermaidTheme);
      if (restoreFrame !== undefined) window.cancelAnimationFrame(restoreFrame);
      restoring = false;
      // Scroll events already persist stable positions. Avoid writing during
      // React StrictMode's mount-probe cleanup, which can replace an existing
      // anchor with a transient zero-height layout.
      view.scrollDOM.removeEventListener("scroll", persistScroll);
      view.scrollDOM.removeEventListener("wheel", cancelRestore);
      view.scrollDOM.removeEventListener("touchmove", cancelRestore);
      view.scrollDOM.removeEventListener("pointerdown", cancelRestore);
      view.scrollDOM.removeEventListener("keydown", cancelRestore);
      callbacksRef.current.onSelectionChange?.(undefined);
      viewRef.current = undefined;
      view.destroy();
    };
  }, [ariaLabel, language, markdownImageLabels, markdownImageResolver, markdownMermaidLabels, markdownTableLabels, path, readOnly, scrollKey, wordWrap]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === undefined || view.state.doc.toString() === value) return;
    const main = view.state.selection.main;
    applyingExternalRef.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: {
          anchor: Math.min(main.anchor, value.length),
          head: Math.min(main.head, value.length)
        }
      });
    } finally {
      applyingExternalRef.current = false;
    }
  }, [value]);

  return <div ref={hostRef} className="workspace-text-editor" data-language={language} />;
});

function workspaceEditorExtensions(
  options: {
    readonly language: string;
    readonly readOnly: boolean;
    readonly wordWrap: boolean;
    readonly syntaxHighlighting: boolean;
    readonly ariaLabel: string;
    readonly markdownTableLabels: WorkspaceMarkdownTableLabels;
    readonly markdownMermaidLabels: WorkspaceMarkdownMermaidLabels;
    readonly markdownImageLabels: WorkspaceMarkdownImageLabels;
    readonly markdownImageResolver?: WorkspaceMarkdownImageResolver;
  },
  applyingExternalRef: { current: boolean },
  callbacksRef: { current: Pick<WorkspaceTextEditorProps, "onChange" | "onSave" | "onSelectionChange" | "onSearchStateChange"> }
): readonly Extension[] {
  const chrome = workspaceEditorChrome(options.language);
  return [
    ...(chrome === "code" ? [lineNumbers()] : []),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    search(),
    workspaceActiveSearchField,
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: (view) => {
          callbacksRef.current.onSave?.(view.state.doc.toString());
          return true;
        }
      },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap
    ]),
    EditorState.readOnly.of(options.readOnly),
    EditorView.editable.of(!options.readOnly),
    EditorView.contentAttributes.of({ "aria-label": options.ariaLabel, spellcheck: "false" }),
    ...(options.wordWrap ? [EditorView.lineWrapping] : []),
    ...(options.syntaxHighlighting ? [languageExtension(options.language), syntaxHighlighting(workspaceHighlightStyle)] : []),
    ...(chrome === "markdown" ? workspaceMarkdownEditorExtensions({
      table: options.markdownTableLabels,
      mermaid: options.markdownMermaidLabels,
      image: options.markdownImageLabels,
      imageResolver: options.markdownImageResolver
    }) : []),
    workspaceEditorThemes[chrome],
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !applyingExternalRef.current) {
        callbacksRef.current.onChange?.(update.state.doc.toString());
      }
      if (update.docChanged) {
        callbacksRef.current.onSearchStateChange?.(workspaceEditorSearchState(update.state.field(workspaceActiveSearchField)));
      }
      if (update.selectionSet || update.docChanged) {
        const main = update.state.selection.main;
        callbacksRef.current.onSelectionChange?.(
          workspaceEditorSelection(update.state.doc.toString(), main.anchor, main.head)
        );
      }
    })
  ];
}

/**
 * Markdown chrome is assembled here so later inline preview
 * widgets can join the same chain without changing the editor lifecycle.
 */
export function workspaceMarkdownEditorExtensions(labels: {
  readonly table: WorkspaceMarkdownTableLabels;
  readonly mermaid: WorkspaceMarkdownMermaidLabels;
  readonly image?: WorkspaceMarkdownImageLabels;
  readonly imageResolver?: WorkspaceMarkdownImageResolver;
}): readonly Extension[] {
  return [
    ...workspaceMarkdownLivePreviewExtensions(labels.table),
    ...workspaceMarkdownImageExtensions(labels.imageResolver, labels.image),
    ...workspaceMarkdownMermaidExtensions(labels.mermaid)
  ];
}

export function clampEditorLine(totalLines: number, line: number): number {
  if (!Number.isFinite(line)) return 1;
  return Math.min(Math.max(Math.trunc(line), 1), Math.max(totalLines, 1));
}

function languageExtension(language: string): Extension {
  switch (language) {
    case "cpp": return cpp();
    case "csharp": return csharp();
    case "css": return css();
    case "go": return go();
    case "html": return html();
    case "java": return java();
    case "javascript": return javascript();
    case "jsx": return javascript({ jsx: true });
    case "typescript": return javascript({ typescript: true });
    case "tsx": return javascript({ jsx: true, typescript: true });
    case "json": return json();
    case "markdown": return markdown();
    case "php": return php();
    case "python": return python();
    case "rust": return rust();
    case "sql": return sql({ dialect: PostgreSQL });
    case "toml": return StreamLanguage.define(toml);
    case "kotlin": return StreamLanguage.define(kotlin);
    case "dart": return StreamLanguage.define(dart);
    case "scala": return StreamLanguage.define(scala);
    case "swift": return StreamLanguage.define(swift);
    case "ruby": return StreamLanguage.define(ruby);
    case "lua": return StreamLanguage.define(lua);
    case "shell": return StreamLanguage.define(shell);
    case "powershell": return StreamLanguage.define(powerShell);
    case "ini":
    case "properties": return StreamLanguage.define(properties);
    case "perl": return StreamLanguage.define(perl);
    case "groovy": return StreamLanguage.define(groovy);
    case "haskell": return StreamLanguage.define(haskell);
    case "r": return StreamLanguage.define(r);
    case "dockerfile": return StreamLanguage.define(dockerFile);
    case "diff": return StreamLanguage.define(diff);
    case "protobuf": return StreamLanguage.define(protobuf);
    case "xml": return xml();
    case "yaml": return yaml();
    default: return [];
  }
}

const workspaceEditorBaseTheme = {
  "&": {
    height: "100%",
    minHeight: "220px",
    color: "var(--text)",
    backgroundColor: "transparent"
  },
  ".cm-scroller": {
    overflow: "auto",
    overflowX: "hidden"
  },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)" },
  ".cm-foldPlaceholder": {
    color: "var(--text-soft)",
    backgroundColor: "var(--surface-hover)",
    border: "1px solid var(--line)"
  },
  ".cm-searchMatch": { backgroundColor: "var(--amber-soft)", outline: "1px solid var(--amber)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--amber-soft)" },
  ".cm-doc-search-match": {
    backgroundColor: "var(--amber-soft)",
    borderRadius: "2px"
  },
  ".cm-doc-search-active": {
    backgroundColor: "color-mix(in srgb, var(--accent) 32%, transparent)",
    fontWeight: "500",
    outline: "1px solid var(--accent-edge)"
  }
} as const;

const workspaceEditorThemes: Readonly<Record<WorkspaceEditorChrome, Extension>> = {
  code: EditorView.theme({
    ...workspaceEditorBaseTheme,
    "&": { ...workspaceEditorBaseTheme["&"], fontSize: "14px" },
    ".cm-scroller": { ...workspaceEditorBaseTheme[".cm-scroller"], lineHeight: "1.5" },
    ".cm-content": {
      padding: "28px 30px 28px 14px",
      caretColor: "var(--text)",
      fontFamily: "var(--app-font-code, var(--app-font-code-default))",
      lineHeight: "1.5"
    },
    ".cm-line": {
      padding: "0",
      fontFamily: "var(--app-font-code, var(--app-font-code-default))",
      lineHeight: "1.5"
    },
    ".cm-gutters": {
      paddingLeft: "30px",
      color: "var(--syntax-comment, var(--text-faint))",
      backgroundColor: "transparent",
      border: "none",
      fontFamily: "var(--app-font-code, var(--app-font-code-default))",
      userSelect: "none"
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "2ch",
      padding: "0 16px 0 0",
      color: "var(--syntax-comment, var(--text-faint))",
      textAlign: "right"
    },
    ".cm-activeLine, .cm-activeLineGutter": { background: "transparent" }
  }),
  plain: EditorView.theme({
    ...workspaceEditorBaseTheme,
    "&": { ...workspaceEditorBaseTheme["&"], fontSize: "15px" },
    ".cm-scroller": { ...workspaceEditorBaseTheme[".cm-scroller"], lineHeight: "1.6" },
    ".cm-content": {
      padding: "28px 40px",
      caretColor: "var(--text)",
      fontFamily: "var(--app-font-ui, var(--app-font-ui-default))",
      lineHeight: "1.6"
    },
    ".cm-line": {
      padding: "0",
      fontFamily: "var(--app-font-ui, var(--app-font-ui-default))",
      lineHeight: "1.6"
    },
    ".cm-gutters": { display: "none" },
    ".cm-activeLine, .cm-activeLineGutter": { background: "transparent" }
  }),
  markdown: EditorView.theme({
    ...workspaceEditorBaseTheme,
    "&": { ...workspaceEditorBaseTheme["&"], fontSize: "16px" },
    ".cm-scroller": { ...workspaceEditorBaseTheme[".cm-scroller"], lineHeight: "1.68" },
    ".cm-content": {
      width: "100%",
      maxWidth: "920px",
      margin: "0 auto",
      padding: "34px 72px 48px",
      caretColor: "var(--text)",
      fontFamily: "var(--app-font-ui, var(--app-font-ui-default))",
      lineHeight: "1.68"
    },
    ".cm-line": {
      padding: "0",
      fontFamily: "var(--app-font-ui, var(--app-font-ui-default))",
      lineHeight: "1.68"
    },
    ".cm-md-heading-line": {
      paddingTop: "0.72em",
      paddingBottom: "0.18em",
      color: "var(--text)",
      fontWeight: "500"
    },
    ".cm-md-heading-1": { fontSize: "2.15em", lineHeight: "1.12" },
    ".cm-md-heading-2": { fontSize: "1.62em", lineHeight: "1.18" },
    ".cm-md-heading-3": { fontSize: "1.28em", lineHeight: "1.24" },
    ".cm-md-heading-4, .cm-md-heading-5, .cm-md-heading-6": { fontSize: "1.06em", lineHeight: "1.32" },
    ".cm-md-quote-line": {
      paddingLeft: "14px",
      borderLeft: "3px solid var(--line-strong, var(--line))",
      color: "var(--text-soft)"
    },
    ".cm-md-list-line": { paddingLeft: "4px" },
    ".cm-md-marker": { color: "var(--text-soft)" },
    ".cm-md-marker-bullet": { display: "inline-block", minWidth: "1.45em", textAlign: "center" },
    ".cm-md-marker-ordered": { display: "inline-block", minWidth: "1.7em", paddingRight: "0.25em", textAlign: "right" },
    ".cm-md-marker-checked, .cm-md-marker-unchecked": { display: "inline-block", minWidth: "1.35em" },
    ".cm-md-horizontal-rule": {
      boxSizing: "content-box",
      display: "block",
      height: "1px",
      padding: "0.75em 0",
      backgroundColor: "var(--line-strong, var(--line))",
      backgroundClip: "content-box"
    },
    ".cm-md-fence-line": {
      paddingLeft: "16px",
      paddingRight: "16px",
      color: "var(--text-soft)",
      backgroundColor: "var(--surface-hover)",
      fontFamily: "var(--app-font-code, var(--app-font-code-default))",
      fontSize: "0.875em",
      lineHeight: "1.7"
    },
    ".cm-md-fence-body": { color: "var(--text)" },
    ".cm-md-fence-first": {
      paddingTop: "10px",
      borderTop: "0.65em solid transparent",
      borderTopLeftRadius: "12px calc(12px + 0.65em)",
      borderTopRightRadius: "12px calc(12px + 0.65em)",
      backgroundClip: "padding-box"
    },
    ".cm-md-fence-last": {
      paddingBottom: "10px",
      borderBottom: "0.65em solid transparent",
      borderBottomLeftRadius: "12px calc(12px + 0.65em)",
      borderBottomRightRadius: "12px calc(12px + 0.65em)",
      backgroundClip: "padding-box"
    },
    ".cm-md-image-widget": {
      boxSizing: "border-box",
      display: "flex",
      width: "100%",
      alignItems: "flex-start",
      gap: "12px",
      padding: "12px 0"
    },
    ".cm-md-image-widget.cm-md-image-center": { justifyContent: "center" },
    ".cm-md-image-item": {
      boxSizing: "border-box",
      minWidth: "0",
      maxWidth: "100%",
      borderRadius: "10px"
    },
    ".cm-md-image-widget img": {
      boxSizing: "border-box",
      display: "block",
      width: "auto",
      maxWidth: "100%",
      height: "auto",
      maxHeight: "680px",
      borderRadius: "10px",
      backgroundColor: "var(--surface-hover)",
      objectFit: "contain"
    },
    ".cm-md-image-clickable": { cursor: "zoom-in" },
    ".cm-md-image-clickable:hover": { opacity: "0.9" },
    ".cm-md-image-clickable:focus-visible": {
      outline: "2px solid var(--accent)",
      outlineOffset: "2px"
    },
    ".cm-md-image-error": {
      boxSizing: "border-box",
      minWidth: "220px",
      maxWidth: "100%",
      border: "1px solid var(--line)",
      borderRadius: "10px",
      padding: "14px 16px",
      color: "var(--text-soft)",
      backgroundColor: "var(--surface-hover)",
      fontSize: "12px"
    },
    ".cm-md-image-loading": { opacity: "0.72" },
    ".cm-md-image-error-label": { fontWeight: "600" },
    ".cm-md-image-error-path": {
      marginTop: "4px",
      overflow: "hidden",
      fontFamily: "var(--app-font-code, var(--app-font-code-default))",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    },
    ".cm-md-mermaid-widget": {
      boxSizing: "border-box",
      width: "100%",
      padding: "12px 0"
    },
    ".cm-md-mermaid-card": {
      position: "relative",
      boxSizing: "border-box",
      display: "grid",
      width: "100%",
      minHeight: "148px",
      placeItems: "center",
      overflow: "hidden",
      border: "1px solid var(--line)",
      borderRadius: "12px",
      backgroundColor: "var(--surface-raised)",
      color: "var(--text)"
    },
    ".cm-md-mermaid-card > svg": {
      boxSizing: "border-box",
      display: "block",
      width: "auto",
      maxWidth: "100%",
      height: "auto",
      maxHeight: "680px",
      padding: "28px"
    },
    ".cm-md-mermaid-clickable": { cursor: "zoom-in" },
    ".cm-md-mermaid-clickable:focus-visible": {
      outline: "2px solid var(--accent)",
      outlineOffset: "2px"
    },
    ".cm-md-mermaid-fallback": {
      boxSizing: "border-box",
      width: "100%",
      maxHeight: "360px",
      margin: "0",
      padding: "22px 24px",
      overflow: "auto",
      color: "var(--text-soft)",
      backgroundColor: "var(--surface-hover)",
      fontFamily: "var(--app-font-code, var(--app-font-code-default))",
      fontSize: "13px",
      lineHeight: "1.6",
      whiteSpace: "pre-wrap"
    },
    ".cm-md-mermaid-loading .cm-md-mermaid-fallback": { opacity: "0.7" },
    ".cm-md-mermaid-error": { alignContent: "start", placeItems: "stretch" },
    ".cm-md-mermaid-error-banner": {
      padding: "10px 44px 10px 14px",
      borderBottom: "1px solid color-mix(in srgb, var(--red) 30%, var(--line))",
      color: "var(--red)",
      backgroundColor: "color-mix(in srgb, var(--red) 8%, var(--surface-raised))",
      fontSize: "13px",
      lineHeight: "1.45"
    },
    ".cm-md-mermaid-toolbar": {
      position: "absolute",
      zIndex: "2",
      top: "8px",
      right: "8px",
      display: "flex",
      gap: "4px",
      padding: "4px",
      border: "1px solid var(--line)",
      borderRadius: "9px",
      backgroundColor: "color-mix(in srgb, var(--surface-raised) 92%, transparent)",
      boxShadow: "var(--shadow-menu)",
      opacity: "0",
      transition: "opacity 120ms ease"
    },
    ".cm-md-mermaid-card:hover .cm-md-mermaid-toolbar, .cm-md-mermaid-card:focus-within .cm-md-mermaid-toolbar, .cm-md-mermaid-error .cm-md-mermaid-toolbar": {
      opacity: "1"
    },
    ".cm-md-mermaid-toolbar-btn": {
      boxSizing: "border-box",
      display: "grid",
      width: "28px",
      height: "28px",
      padding: "0",
      placeItems: "center",
      border: "0",
      borderRadius: "7px",
      backgroundColor: "transparent",
      color: "var(--text-soft)",
      cursor: "pointer"
    },
    ".cm-md-mermaid-toolbar-btn:hover, .cm-md-mermaid-toolbar-btn:focus-visible": {
      backgroundColor: "var(--surface-hover)",
      color: "var(--text)",
      outline: "none"
    },
    ".cm-md-mermaid-toolbar-btn:disabled": { cursor: "wait", opacity: "0.55" },
    ".cm-md-table-widget": { position: "relative", overflow: "visible", padding: "0.65em 0" },
    ".cm-md-table-widget table": { width: "100%", minWidth: "100%", borderCollapse: "collapse", tableLayout: "fixed", fontSize: "0.95em", lineHeight: "1.5" },
    ".cm-md-table-widget th, .cm-md-table-widget td": {
      padding: "8px 10px",
      border: "1px solid var(--line)",
      outline: "none",
      textAlign: "left",
      verticalAlign: "top",
      overflowWrap: "anywhere",
      wordBreak: "break-word"
    },
    ".cm-md-table-widget th": { position: "relative", backgroundColor: "var(--surface-hover)", fontWeight: "600" },
    ".cm-md-table-resize-handle": {
      position: "absolute",
      zIndex: "1",
      top: "0",
      right: "-3px",
      width: "6px",
      height: "100%",
      backgroundColor: "transparent",
      cursor: "col-resize",
      userSelect: "none"
    },
    ".cm-md-table-resize-handle:hover": { backgroundColor: "var(--line)" },
    ".cm-md-table-widget td:focus, .cm-md-table-widget th:focus": { boxShadow: "inset 0 0 0 1px var(--accent-edge)" },
    ".cm-md-table-menu": {
      position: "absolute",
      zIndex: "20",
      display: "none",
      width: "168px",
      padding: "6px",
      border: "1px solid var(--line)",
      borderRadius: "12px",
      backgroundColor: "var(--surface-raised)",
      boxShadow: "var(--shadow-menu)"
    },
    ".cm-md-table-widget[data-menu-open='true'] .cm-md-table-menu": { display: "block" },
    ".cm-md-table-menu-separator": { height: "1px", margin: "5px 4px", backgroundColor: "var(--line)" },
    ".cm-md-table-menu-item": {
      display: "block",
      width: "100%",
      padding: "7px 10px",
      border: "0",
      borderRadius: "8px",
      backgroundColor: "transparent",
      color: "var(--text)",
      cursor: "pointer",
      font: "inherit",
      fontSize: "13px",
      lineHeight: "1.35",
      textAlign: "left"
    },
    ".cm-md-table-menu-item:hover, .cm-md-table-menu-item:focus-visible": { backgroundColor: "var(--surface-hover)", outline: "none" },
    ".cm-md-table-menu-item:disabled": { color: "var(--text-disabled, var(--text-faint))", cursor: "default", opacity: "0.55" },
    ".cm-md-table-menu-item:disabled:hover": { backgroundColor: "transparent" },
    ".cm-gutters": { display: "none" },
    ".cm-activeLine, .cm-activeLineGutter": { background: "transparent" }
  })
};

function applyWorkspaceDocumentSearch(view: EditorView, query: string, targetLine?: number): WorkspaceEditorSearchState {
  const collected = collectWorkspaceDocumentMatches(view.state, query);
  if (collected.matches.length === 0) {
    view.dispatch({ effects: setWorkspaceSearchDecorations.of({ query, matches: [], activeIndex: -1 }) });
    return { query, total: 0, activeIndex: 0, truncated: collected.truncated };
  }
  const targetPosition = targetLine === undefined
    ? 0
    : view.state.doc.line(clampEditorLine(view.state.doc.lines, targetLine)).from;
  const firstAtOrAfterTarget = collected.matches.findIndex((match) => match.from >= targetPosition);
  const activeIndex = firstAtOrAfterTarget < 0 ? collected.matches.length - 1 : firstAtOrAfterTarget;
  return commitWorkspaceDocumentSearch(view, query, collected, activeIndex);
}

function activateWorkspaceDocumentSearch(view: EditorView, query: string, requestedIndex: number): WorkspaceEditorSearchState {
  const collected = collectWorkspaceDocumentMatches(view.state, query);
  if (collected.matches.length === 0) {
    view.dispatch({ effects: setWorkspaceSearchDecorations.of({ query, matches: [], activeIndex: -1 }) });
    return { query, total: 0, activeIndex: 0, truncated: collected.truncated };
  }
  const activeIndex = ((Math.trunc(requestedIndex) % collected.matches.length) + collected.matches.length) % collected.matches.length;
  return commitWorkspaceDocumentSearch(view, query, collected, activeIndex);
}

function commitWorkspaceDocumentSearch(
  view: EditorView,
  query: string,
  collected: ReturnType<typeof collectWorkspaceDocumentMatches>,
  activeIndex: number
): WorkspaceEditorSearchState {
  const active = collected.matches[activeIndex]!;
  view.dispatch({ effects: [
    setWorkspaceSearchDecorations.of({ query, matches: collected.matches, activeIndex }),
    EditorView.scrollIntoView(active.from, { y: "center" })
  ] });
  return { query, total: collected.matches.length, activeIndex, truncated: collected.truncated };
}

function collectWorkspaceDocumentMatches(state: EditorState, query: string): {
  readonly matches: readonly WorkspaceEditorSearchRange[];
  readonly truncated: boolean;
} {
  const searchQuery = new SearchQuery({ search: query, caseSensitive: false, literal: true });
  if (query === "") return { matches: [], truncated: false };
  const matches: WorkspaceEditorSearchRange[] = [];
  const cursor = searchQuery.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    matches.push({ from: next.value.from, to: next.value.to });
  }
  return { matches, truncated: false };
}

function workspaceEditorSearchFieldValue(
  query: string,
  matches: readonly WorkspaceEditorSearchRange[],
  activeIndex: number
): WorkspaceEditorSearchFieldValue {
  return {
    query,
    matches,
    activeIndex,
    decorations: Decoration.set(matches.map((match, index) => (
      index === activeIndex ? workspaceActiveSearchDecoration : workspaceSearchDecoration
    ).range(match.from, match.to)))
  };
}

function workspaceEditorSearchState(value: WorkspaceEditorSearchFieldValue): WorkspaceEditorSearchState {
  return {
    query: value.query,
    total: value.matches.length,
    activeIndex: value.activeIndex < 0 ? 0 : value.activeIndex,
    truncated: false
  };
}

function emptyWorkspaceEditorSearchState(query: string): WorkspaceEditorSearchState {
  return { query, total: 0, activeIndex: 0, truncated: false };
}

const workspaceHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword, #cf222e)" },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: "var(--syntax-name, #8250df)" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "var(--syntax-function, #8250df)" },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: "var(--syntax-constant, #0550ae)" },
  { tag: [tags.definition(tags.name), tags.separator], color: "var(--syntax-definition, #953800)" },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: "var(--syntax-type, #953800)" },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link], color: "var(--syntax-operator, #0a3069)" },
  { tag: [tags.meta, tags.comment], color: "var(--syntax-comment, #6e7781)", fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, textDecoration: "underline" },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: "var(--syntax-atom, #0550ae)" },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: "var(--syntax-string, #0a3069)" },
  { tag: tags.invalid, color: "var(--red)", textDecoration: "underline wavy" }
]);

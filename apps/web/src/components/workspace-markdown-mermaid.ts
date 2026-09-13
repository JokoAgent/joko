import { Facet, RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { writeClipboardText } from "../clipboard-action.js";
import { mermaidDocumentTheme, renderMermaid } from "./mermaid-render.js";
import { copyMermaid } from "./mermaid-image-export.js";

export interface WorkspaceMarkdownMermaidLabels {
  readonly zoom: string;
  readonly copy: string;
  readonly copied: string;
  readonly copyFailed: string;
  readonly editSource: string;
  readonly renderFailed: string;
}

export interface WorkspaceMarkdownMermaidBlock {
  readonly from: number;
  readonly to: number;
  readonly bodyFrom: number;
  readonly bodyTo: number;
  readonly source: string;
}

export interface WorkspaceMermaidLifetime {
  readonly returnFocus: HTMLElement;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

export interface WorkspaceMermaidOpenDetail extends WorkspaceMermaidLifetime {
  readonly svg: string;
  readonly source: string;
}

export interface WorkspaceMermaidEditDetail extends WorkspaceMermaidLifetime {
  readonly source: string;
  readonly apply: (source: string) => "applied" | "target-missing";
  readonly restoreFocus: () => void;
}

export const WORKSPACE_MERMAID_OPEN_EVENT = "joko-workspace-mermaid-open";
export const WORKSPACE_MERMAID_EDIT_EVENT = "joko-workspace-mermaid-edit";
/** Forces every mounted Mermaid widget to re-render against the resolved theme. */
export const workspaceMarkdownMermaidThemeChanged = StateEffect.define<void>();

const DEFAULT_LABELS: WorkspaceMarkdownMermaidLabels = {
  zoom: "Zoom diagram",
  copy: "Copy diagram",
  copied: "Copied",
  copyFailed: "Could not copy diagram",
  editSource: "Edit source",
  renderFailed: "Could not render Mermaid: "
};

const labelsFacet = Facet.define<WorkspaceMarkdownMermaidLabels, WorkspaceMarkdownMermaidLabels>({
  combine: (values) => values[0] ?? DEFAULT_LABELS
});

const OPEN_MERMAID_BACKTICK = /^ {0,3}`{3,}\s*mermaid(?:[ \t][^`]*)?$/u;
const OPEN_MERMAID_TILDE = /^ {0,3}~{3,}\s*mermaid(?:[ \t].*)?$/u;
const OPEN_OTHER_BACKTICK = /^ {0,3}`{3,}[^`]*$/u;
const OPEN_OTHER_TILDE = /^ {0,3}~{3,}.*$/u;

function fenceRun(text: string): string | undefined {
  return /^ {0,3}([`~]+)/u.exec(text)?.[1];
}

function closingFence(opener: string): RegExp {
  const character = opener[0] === "`" ? "`" : "~";
  return new RegExp(`^ {0,3}${character}{${opener.length},}\\s*$`, "u");
}

/** CommonMark-aware Mermaid discovery; examples inside a larger fence stay source. */
export function findWorkspaceMarkdownMermaidBlocks(doc: Text): readonly WorkspaceMarkdownMermaidBlock[] {
  const blocks: WorkspaceMarkdownMermaidBlock[] = [];
  let lineNumber = 1;
  while (lineNumber <= doc.lines) {
    const line = doc.line(lineNumber);
    const mermaid = OPEN_MERMAID_BACKTICK.test(line.text) || OPEN_MERMAID_TILDE.test(line.text)
      ? fenceRun(line.text)
      : undefined;
    const other = mermaid === undefined && (OPEN_OTHER_BACKTICK.test(line.text) || OPEN_OTHER_TILDE.test(line.text))
      ? fenceRun(line.text)
      : undefined;
    const opener = mermaid ?? other;
    if (opener === undefined) {
      lineNumber += 1;
      continue;
    }
    const close = closingFence(opener);
    let closingLine = -1;
    for (let candidate = lineNumber + 1; candidate <= doc.lines; candidate += 1) {
      if (close.test(doc.line(candidate).text)) {
        closingLine = candidate;
        break;
      }
    }
    if (closingLine < 0) {
      if (other !== undefined) break;
      lineNumber += 1;
      continue;
    }
    if (mermaid !== undefined) {
      const source: string[] = [];
      for (let bodyLine = lineNumber + 1; bodyLine < closingLine; bodyLine += 1) source.push(doc.line(bodyLine).text);
      const closeLine = doc.line(closingLine);
      blocks.push({
        from: line.from,
        to: closeLine.to,
        bodyFrom: closeLine.from === line.to + 1 ? closeLine.from : doc.line(lineNumber + 1).from,
        bodyTo: closeLine.from,
        source: source.join("\n")
      });
    }
    lineNumber = closingLine + 1;
  }
  return blocks;
}

const mountedWidgets = new WeakMap<HTMLElement, () => void>();

class WorkspaceMermaidWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly hostEditable: boolean,
    private readonly labels: WorkspaceMarkdownMermaidLabels,
    private readonly themeEpoch: object
  ) { super(); }

  override eq(other: WorkspaceMermaidWidget): boolean {
    return other.source === this.source && other.hostEditable === this.hostEditable
      && other.themeEpoch === this.themeEpoch && JSON.stringify(other.labels) === JSON.stringify(this.labels);
  }

  override toDOM(view: EditorView): HTMLElement {
    const ownerDocument = view.dom.ownerDocument;
    const ownerWindow = ownerDocument.defaultView!;
    const request = new AbortController();
    const context = { ownerDocument, signal: request.signal };
    const wrapper = ownerDocument.createElement("div");
    wrapper.className = "cm-md-mermaid-widget";
    wrapper.contentEditable = "false";
    const card = ownerDocument.createElement("div");
    card.className = "cm-md-mermaid-card cm-md-mermaid-loading";
    const fallback = ownerDocument.createElement("pre");
    fallback.className = "cm-md-mermaid-fallback";
    fallback.textContent = this.source;
    card.append(fallback);
    wrapper.append(card);
    const current = (): boolean => !request.signal.aborted && wrapper.isConnected
      && wrapper.ownerDocument === ownerDocument && card.ownerDocument === ownerDocument && view.dom.ownerDocument === ownerDocument;
    const retire = (): void => request.abort();
    const resume = (): void => {
      if (request.signal.aborted && wrapper.isConnected && wrapper.ownerDocument === ownerDocument && view.dom.ownerDocument === ownerDocument) {
        view.dispatch({ effects: workspaceMarkdownMermaidThemeChanged.of(undefined) });
      }
    };
    ownerWindow.addEventListener("pagehide", retire);
    ownerWindow.addEventListener("pageshow", resume);
    mountedWidgets.set(wrapper, () => {
      request.abort();
      ownerWindow.removeEventListener("pagehide", retire);
      ownerWindow.removeEventListener("pageshow", resume);
    });
    const dispatchOpen = (trigger: HTMLElement, svg: string): void => {
      if (!current()) return;
      trigger.dispatchEvent(new ownerWindow.CustomEvent<WorkspaceMermaidOpenDetail>(WORKSPACE_MERMAID_OPEN_EVENT, {
        bubbles: true, detail: { svg, source: this.source, returnFocus: trigger, signal: request.signal, isCurrent: current }
      }));
    };
    const attachToolbar = (svg?: string): void => {
      card.querySelector(".cm-md-mermaid-toolbar")?.remove();
      const toolbar = ownerDocument.createElement("div");
      toolbar.className = "cm-md-mermaid-toolbar";
      if (svg !== undefined) toolbar.append(iconButton(ownerDocument, this.labels.zoom, EXPAND_ICON, (trigger) => dispatchOpen(trigger, svg)));
      const feedback = ownerDocument.createElement("span");
      feedback.className = "cm-md-mermaid-copy-feedback";
      feedback.setAttribute("role", "alert");
      let pending = false;
      let timer: number | undefined;
      const copy = iconButton(ownerDocument, this.labels.copy, COPY_ICON, () => {
        if (!current() || pending) return;
        pending = true;
        feedback.textContent = "";
        copy.setAttribute("aria-busy", "true");
        copy.setAttribute("aria-disabled", "true");
        if (timer !== undefined) ownerWindow.clearTimeout(timer);
        const action = svg === undefined ? writeClipboardText(this.source, context) : copyMermaid(svg, this.source, card, context);
        void action.then(() => {
          if (!current() || !copy.isConnected) return;
          copy.innerHTML = CHECK_ICON;
          copy.title = this.labels.copied;
          copy.setAttribute("aria-label", this.labels.copied);
          timer = ownerWindow.setTimeout(() => {
            if (!current() || !copy.isConnected) return;
            copy.innerHTML = COPY_ICON;
            copy.title = this.labels.copy;
            copy.setAttribute("aria-label", this.labels.copy);
          }, 1_500);
        }).catch(() => {
          if (!current() || !copy.isConnected) return;
          copy.title = this.labels.copyFailed;
          copy.setAttribute("aria-label", this.labels.copyFailed);
          feedback.textContent = this.labels.copyFailed;
        }).finally(() => {
          pending = false;
          if (!current() || !copy.isConnected) return;
          copy.removeAttribute("aria-busy");
          copy.removeAttribute("aria-disabled");
        });
      });
      request.signal.addEventListener("abort", () => { if (timer !== undefined) ownerWindow.clearTimeout(timer); }, { once: true });
      toolbar.append(copy, feedback);
      if (this.hostEditable) toolbar.append(iconButton(ownerDocument, this.labels.editSource, CODE_ICON, (trigger) => {
        if (!current()) return;
        trigger.dispatchEvent(new ownerWindow.CustomEvent<WorkspaceMermaidEditDetail>(WORKSPACE_MERMAID_EDIT_EVENT, {
          bubbles: true,
          detail: {
            source: this.source, returnFocus: trigger, signal: request.signal, isCurrent: current,
            restoreFocus: () => {
              if (!view.dom.isConnected || view.dom.ownerDocument !== ownerDocument) return;
              if (current() && trigger.isConnected) trigger.focus({ preventScroll: true });
              else view.focus();
            },
            apply: (source) => {
              if (!current()) return "target-missing";
              const block = resolveLiveBlock(view, card, this.source);
              if (block === undefined) return "target-missing";
              const normalized = source.replace(/\r?\n+$/u, "");
              view.dispatch({ changes: { from: block.bodyFrom, to: block.bodyTo, insert: normalized === "" ? "" : `${normalized}\n` } });
              return "applied";
            }
          }
        }));
      }));
      card.append(toolbar);
    };
    attachToolbar();
    void renderMermaid(this.source.trim(), mermaidDocumentTheme(ownerDocument), context).then((svg) => {
      if (!current()) return;
      const host = ownerDocument.createElement("div");
      host.innerHTML = svg;
      const parsed = host.firstElementChild;
      if (parsed?.localName !== "svg") throw new Error("Invalid SVG.");
      card.classList.remove("cm-md-mermaid-loading", "cm-md-mermaid-error");
      card.classList.add("cm-md-mermaid-clickable");
      card.replaceChildren(parsed);
      attachToolbar(svg);
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", this.labels.zoom);
      card.tabIndex = 0;
      const open = (event: Event): void => {
        if (event.target instanceof ownerWindow.Element && event.target.closest(".cm-md-mermaid-toolbar") !== null) return;
        event.preventDefault();
        event.stopPropagation();
        dispatchOpen(card, svg);
      };
      card.addEventListener("click", open);
      card.addEventListener("keydown", (event) => {
        if (!event.defaultPrevented && !event.isComposing && (event.key === "Enter" || event.key === " ")) open(event);
      });
    }).catch((cause: unknown) => {
      if (!current()) return;
      card.classList.remove("cm-md-mermaid-loading");
      card.classList.add("cm-md-mermaid-error");
      const error = ownerDocument.createElement("div");
      error.className = "cm-md-mermaid-error-banner";
      error.textContent = `${this.labels.renderFailed}${cause instanceof Error ? cause.message : String(cause)}`;
      card.replaceChildren(error, fallback);
      attachToolbar();
    });
    return wrapper;
  }

  override destroy(dom: HTMLElement): void {
    mountedWidgets.get(dom)?.();
    mountedWidgets.delete(dom);
  }
}

function iconButton(ownerDocument: Document, label: string, icon: string, action: (button: HTMLButtonElement) => void): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.className = "cm-md-mermaid-toolbar-btn";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = icon;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    action(button);
  });
  return button;
}

function resolveLiveBlock(view: EditorView, element: HTMLElement, source: string): WorkspaceMarkdownMermaidBlock | undefined {
  let position: number;
  try {
    position = view.posAtDOM(element);
  } catch {
    return undefined;
  }
  return findWorkspaceMarkdownMermaidBlocks(view.state.doc).find((block) =>
    position >= block.from && position <= block.to && block.source === source
  );
}

const mermaidField = StateField.define<{ readonly decorations: DecorationSet; readonly themeEpoch: object }>({
  create: (state) => {
    const themeEpoch = {};
    return { themeEpoch, decorations: mermaidDecorations(state.doc, state.facet(EditorView.editable), state.facet(labelsFacet), themeEpoch) };
  },
  update(value, transaction) {
    const editableChanged = transaction.startState.facet(EditorView.editable) !== transaction.state.facet(EditorView.editable);
    const labelsChanged = transaction.startState.facet(labelsFacet) !== transaction.state.facet(labelsFacet);
    const themeChanged = transaction.effects.some((effect) => effect.is(workspaceMarkdownMermaidThemeChanged));
    if (!transaction.docChanged && !editableChanged && !labelsChanged && !themeChanged) return value;
    const themeEpoch = themeChanged ? {} : value.themeEpoch;
    return { themeEpoch, decorations: mermaidDecorations(transaction.state.doc, transaction.state.facet(EditorView.editable), transaction.state.facet(labelsFacet), themeEpoch) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
});

function mermaidDecorations(doc: Text, editable: boolean, labels: WorkspaceMarkdownMermaidLabels, themeEpoch: object): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const block of findWorkspaceMarkdownMermaidBlocks(doc)) builder.add(block.from, block.to, Decoration.replace({
    block: true,
    widget: new WorkspaceMermaidWidget(block.source, editable, labels, themeEpoch)
  }));
  return builder.finish();
}

export function workspaceMarkdownMermaidExtensions(labels: WorkspaceMarkdownMermaidLabels): readonly Extension[] {
  return [labelsFacet.of(labels), mermaidField];
}

const EXPAND_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 21-6-6m6 6v-4.8m0 4.8h-4.8"/><path d="M3 16.2V21m0 0h4.8M3 21l6-6"/><path d="M21 7.8V3m0 0h-4.8M21 3l-6 6"/><path d="M3 7.8V3m0 0h4.8M3 3l6 6"/></svg>';
const CODE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 16 22 12 18 8"/><polyline points="6 8 2 12 6 16"/><line x1="14.5" y1="4" x2="9.5" y2="20"/></svg>';
const COPY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

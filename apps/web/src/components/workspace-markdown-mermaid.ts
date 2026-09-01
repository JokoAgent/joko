import { Facet, RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

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

export interface WorkspaceMermaidOpenDetail {
  readonly svg: string;
  readonly source: string;
}

export interface WorkspaceMermaidEditDetail {
  readonly source: string;
  readonly apply: (source: string) => "applied" | "target-missing";
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

type MermaidApi = typeof import("mermaid")["default"];
let mermaidModule: Promise<MermaidApi> | undefined;
let initializedTheme: "dark" | "default" | undefined;
const renderCache = new Map<string, string>();

function darkTheme(): boolean {
  const theme = document.documentElement.dataset.theme;
  return theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

async function mermaid(): Promise<MermaidApi> {
  mermaidModule ??= import("mermaid").then((module) => module.default);
  const api = await mermaidModule;
  const theme = darkTheme() ? "dark" : "default";
  if (initializedTheme !== theme) {
    api.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      fontFamily: "inherit",
      theme,
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
      journey: { useMaxWidth: false },
      pie: { useMaxWidth: false }
    });
    initializedTheme = theme;
  }
  return api;
}

function cachedSvg(key: string): string | undefined {
  const value = renderCache.get(key);
  if (value === undefined) return undefined;
  renderCache.delete(key);
  renderCache.set(key, value);
  return value;
}

function rememberSvg(key: string, svg: string): void {
  renderCache.delete(key);
  renderCache.set(key, svg);
  while (renderCache.size > 64) {
    const oldest = renderCache.keys().next();
    if (oldest.done) return;
    renderCache.delete(oldest.value);
  }
}

class WorkspaceMermaidWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly hostEditable: boolean,
    private readonly labels: WorkspaceMarkdownMermaidLabels
  ) {
    super();
  }

  override eq(other: WorkspaceMermaidWidget): boolean {
    return other.source === this.source
      && other.hostEditable === this.hostEditable
      && JSON.stringify(other.labels) === JSON.stringify(this.labels);
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-mermaid-widget";
    wrapper.contentEditable = "false";
    const card = document.createElement("div");
    card.className = "cm-md-mermaid-card cm-md-mermaid-loading";
    const fallback = document.createElement("pre");
    fallback.className = "cm-md-mermaid-fallback";
    fallback.textContent = this.source;
    card.append(fallback);
    wrapper.append(card);
    this.attachToolbar(view, card);

    const key = `${darkTheme() ? "dark" : "default"}|${this.source}`;
    const cached = cachedSvg(key);
    if (cached !== undefined) this.showSvg(view, card, cached);
    else void this.render(view, card, fallback, key);
    return wrapper;
  }

  private async render(view: EditorView, card: HTMLElement, fallback: HTMLElement, key: string): Promise<void> {
    if (this.source.trim() === "") {
      this.showError(card, fallback, "empty source");
      return;
    }
    try {
      const api = await mermaid();
      await api.parse(this.source.trim());
      const { svg } = await api.render(`joko-mermaid-${crypto.randomUUID()}`, this.source.trim());
      if (!card.isConnected) return;
      rememberSvg(key, svg);
      this.showSvg(view, card, svg);
    } catch (cause) {
      this.showError(card, fallback, cause instanceof Error ? cause.message : String(cause));
    }
  }

  private showSvg(view: EditorView, card: HTMLElement, svg: string): void {
    const parsed = parseSvg(svg);
    if (parsed === undefined) {
      const fallback = card.querySelector<HTMLElement>(".cm-md-mermaid-fallback") ?? document.createElement("pre");
      this.showError(card, fallback, "invalid SVG");
      return;
    }
    card.classList.remove("cm-md-mermaid-loading", "cm-md-mermaid-error");
    card.classList.add("cm-md-mermaid-clickable");
    card.replaceChildren(parsed);
    this.attachToolbar(view, card, svg);
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    const open = (event: Event): void => {
      if (event.target instanceof Element && event.target.closest(".cm-md-mermaid-toolbar") !== null) return;
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent<WorkspaceMermaidOpenDetail>(WORKSPACE_MERMAID_OPEN_EVENT, {
        detail: { svg, source: this.source }
      }));
    };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") open(event);
    });
  }

  private showError(card: HTMLElement, fallback: HTMLElement, message: string): void {
    if (!card.isConnected) return;
    card.classList.remove("cm-md-mermaid-loading");
    card.classList.add("cm-md-mermaid-error");
    fallback.className = "cm-md-mermaid-fallback";
    fallback.textContent = this.source;
    const error = document.createElement("div");
    error.className = "cm-md-mermaid-error-banner";
    error.textContent = `${this.labels.renderFailed}${message}`;
    const toolbar = card.querySelector<HTMLElement>(".cm-md-mermaid-toolbar");
    card.replaceChildren(error, fallback, ...(toolbar === null ? [] : [toolbar]));
  }

  private attachToolbar(view: EditorView, card: HTMLElement, svg?: string): void {
    card.querySelector(".cm-md-mermaid-toolbar")?.remove();
    const toolbar = document.createElement("div");
    toolbar.className = "cm-md-mermaid-toolbar";
    if (svg !== undefined) {
      toolbar.append(iconButton(this.labels.zoom, EXPAND_ICON, () => {
        window.dispatchEvent(new CustomEvent<WorkspaceMermaidOpenDetail>(WORKSPACE_MERMAID_OPEN_EVENT, {
          detail: { svg, source: this.source }
        }));
      }));
      const copy = iconButton(this.labels.copy, COPY_ICON, () => {
        feedback.textContent = "";
        copy.disabled = true;
        void copyWorkspaceMermaid(svg, this.source, card).then(() => {
          copy.innerHTML = CHECK_ICON;
          copy.title = this.labels.copied;
          copy.setAttribute("aria-label", this.labels.copied);
          window.setTimeout(() => {
            if (!copy.isConnected) return;
            copy.innerHTML = COPY_ICON;
            copy.title = this.labels.copy;
            copy.setAttribute("aria-label", this.labels.copy);
            copy.disabled = false;
          }, 1_500);
        }).catch(() => {
          copy.title = this.labels.copyFailed;
          copy.setAttribute("aria-label", this.labels.copyFailed);
          feedback.textContent = this.labels.copyFailed;
          copy.disabled = false;
        });
      });
      const feedback = document.createElement("span");
      feedback.className = "cm-md-mermaid-copy-feedback";
      feedback.setAttribute("role", "alert");
      feedback.setAttribute("aria-live", "assertive");
      feedback.setAttribute("aria-atomic", "true");
      toolbar.append(copy);
      toolbar.append(feedback);
    }
    if (this.hostEditable) toolbar.append(iconButton(this.labels.editSource, CODE_ICON, () => {
      window.dispatchEvent(new CustomEvent<WorkspaceMermaidEditDetail>(WORKSPACE_MERMAID_EDIT_EVENT, {
        detail: {
          source: this.source,
          apply: (source) => {
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
  }
}

function iconButton(label: string, icon: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-md-mermaid-toolbar-btn";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = icon;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  });
  return button;
}

function parseSvg(source: string): SVGElement | undefined {
  const host = document.createElement("div");
  host.innerHTML = source;
  return host.firstElementChild instanceof SVGElement ? host.firstElementChild : undefined;
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

const mermaidField = StateField.define<DecorationSet>({
  create: (state) => mermaidDecorations(state.doc, state.facet(EditorView.editable), state.facet(labelsFacet)),
  update(value, transaction) {
    const editableChanged = transaction.startState.facet(EditorView.editable) !== transaction.state.facet(EditorView.editable);
    const labelsChanged = transaction.startState.facet(labelsFacet) !== transaction.state.facet(labelsFacet);
    const themeChanged = transaction.effects.some((effect) => effect.is(workspaceMarkdownMermaidThemeChanged));
    return transaction.docChanged || editableChanged || labelsChanged || themeChanged
      ? mermaidDecorations(transaction.state.doc, transaction.state.facet(EditorView.editable), transaction.state.facet(labelsFacet))
      : value;
  },
  provide: (field) => EditorView.decorations.from(field)
});

function mermaidDecorations(doc: Text, editable: boolean, labels: WorkspaceMarkdownMermaidLabels): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const block of findWorkspaceMarkdownMermaidBlocks(doc)) builder.add(block.from, block.to, Decoration.replace({
    block: true,
    widget: new WorkspaceMermaidWidget(block.source, editable, labels)
  }));
  return builder.finish();
}

export function workspaceMarkdownMermaidExtensions(labels: WorkspaceMarkdownMermaidLabels): readonly Extension[] {
  return [labelsFacet.of(labels), mermaidField];
}

export async function copyWorkspaceMermaid(svg: string, source: string, card: HTMLElement): Promise<void> {
  if (typeof ClipboardItem === "undefined" || navigator.clipboard?.write === undefined) throw new Error("Clipboard unavailable.");
  const png = await renderWorkspaceMermaidPng(svg, getComputedStyle(card).backgroundColor);
  await navigator.clipboard.write([new ClipboardItem({
    "image/png": png,
    "text/plain": new Blob([source], { type: "text/plain" })
  })]);
}

export async function renderWorkspaceMermaidPng(svg: string, background: string): Promise<Blob> {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const viewBox = parsed.getAttribute("viewBox")?.trim().split(/\s+/u).map(Number);
  const baseWidth = Number(parsed.getAttribute("width")) || (viewBox?.[2] ?? 1_024);
  const baseHeight = Number(parsed.getAttribute("height")) || (viewBox?.[3] ?? 768);
  const scale = Math.min(3, 4_096 / Math.max(baseWidth, baseHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(baseWidth * scale));
  canvas.height = Math.max(1, Math.round(baseHeight * scale));
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Canvas unavailable.");
  context.fillStyle = background === "rgba(0, 0, 0, 0)" ? (darkTheme() ? "#1f1f1d" : "#ffffff") : background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
  } finally {
    URL.revokeObjectURL(url);
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob === null ? reject(new Error("PNG encoding failed.")) : resolve(blob), "image/png"));
}

const EXPAND_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 21-6-6m6 6v-4.8m0 4.8h-4.8"/><path d="M3 16.2V21m0 0h4.8M3 21l6-6"/><path d="M21 7.8V3m0 0h-4.8M21 3l-6 6"/><path d="M3 7.8V3m0 0h4.8M3 3l6 6"/></svg>';
const CODE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 16 22 12 18 8"/><polyline points="6 8 2 12 6 16"/><line x1="14.5" y1="4" x2="9.5" y2="20"/></svg>';
const COPY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

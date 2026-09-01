import { Facet, RangeSetBuilder, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export interface WorkspaceMarkdownImageSpec {
  readonly src: string;
  readonly alt: string;
  readonly title: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface WorkspaceMarkdownImageTarget {
  readonly from: number;
  readonly to: number;
  readonly align: "center" | null;
  readonly images: readonly WorkspaceMarkdownImageSpec[];
}

export interface WorkspaceMarkdownResolvedImage {
  readonly url: string;
  readonly name: string;
  readonly mediaType?: string;
  readonly release?: () => void;
}

export type WorkspaceMarkdownImageResolver = (source: string) => Promise<WorkspaceMarkdownResolvedImage | undefined>;

export interface WorkspaceMarkdownImageLabels {
  readonly open: string;
  readonly loading: string;
  readonly loadFailed: string;
}

export const WORKSPACE_MARKDOWN_IMAGE_OPEN_EVENT = "joko-workspace-markdown-image-open";

export interface WorkspaceMarkdownImageOpenDetail extends WorkspaceMarkdownResolvedImage {
  readonly returnFocus: HTMLElement;
}

const DEFAULT_LABELS: WorkspaceMarkdownImageLabels = {
  open: "Open image",
  loading: "Loading image",
  loadFailed: "Could not load image"
};
const missingResolver: WorkspaceMarkdownImageResolver = async () => undefined;
const resolverFacet = Facet.define<WorkspaceMarkdownImageResolver, WorkspaceMarkdownImageResolver>({
  combine: (values) => values[0] ?? missingResolver
});
const labelsFacet = Facet.define<WorkspaceMarkdownImageLabels, WorkspaceMarkdownImageLabels>({
  combine: (values) => values[0] ?? DEFAULT_LABELS
});

const MARKDOWN_IMAGE = /^ {0,3}!\[([^\]]*)\]\(\s*(<[^<>]*>|[^)\s]+)(?:\s+("[^"]*"|'[^']*'))?\s*\)\s*$/u;
const WIKI_IMAGE = /^ {0,3}!\[\[([^\]|]+)(?:\|(\d+)(?:x(\d+))?)?\]\]\s*$/u;
const HTML_BARE_IMAGE = /^ {0,3}<img\b([^>]*?)\/?\s*>\s*$/iu;
const HTML_WRAPPED_IMAGE = /^ {0,3}<p\b([^>]*)>\s*<img\b([^>]*?)\/?\s*>\s*<\/p>\s*$/iu;
const HTML_PARAGRAPH_OPEN = /^ {0,3}<p\b([^>]*)>\s*$/iu;
const HTML_IMAGE_ONLY = /^\s*<img\b([^>]*?)\/?\s*>\s*$/iu;
const HTML_PARAGRAPH_CLOSE = /^\s*<\/p>\s*$/iu;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/u;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp|ico|svg)$/iu;

export function workspaceMarkdownImageExtensions(
  resolver: WorkspaceMarkdownImageResolver | undefined,
  labels: WorkspaceMarkdownImageLabels = DEFAULT_LABELS
): readonly Extension[] {
  return [resolverFacet.of(resolver ?? missingResolver), labelsFacet.of(labels), markdownImageDecorationField];
}

export function findWorkspaceMarkdownImageTargets(doc: Text): readonly WorkspaceMarkdownImageTarget[] {
  const targets: WorkspaceMarkdownImageTarget[] = [];
  let lineNumber = 1;
  while (lineNumber <= doc.lines) {
    const line = doc.line(lineNumber);
    const fence = FENCE_OPEN.exec(line.text)?.[1];
    if (fence !== undefined) {
      const character = fence[0] === "`" ? "`" : "~";
      const close = new RegExp(`^ {0,3}${character}{${fence.length},}\\s*$`, "u");
      let closingLine = -1;
      for (let candidate = lineNumber + 1; candidate <= doc.lines; candidate += 1) {
        if (close.test(doc.line(candidate).text)) {
          closingLine = candidate;
          break;
        }
      }
      if (closingLine < 0) break;
      lineNumber = closingLine + 1;
      continue;
    }

    const paragraph = HTML_PARAGRAPH_OPEN.exec(line.text);
    if (paragraph !== null) {
      const images: WorkspaceMarkdownImageSpec[] = [];
      let candidate = lineNumber + 1;
      while (candidate <= doc.lines) {
        const image = HTML_IMAGE_ONLY.exec(doc.line(candidate).text);
        if (image === null) break;
        const spec = parseImageAttributes(image[1] ?? "");
        if (spec === null) break;
        images.push(spec);
        candidate += 1;
      }
      if (images.length > 0 && candidate <= doc.lines && HTML_PARAGRAPH_CLOSE.test(doc.line(candidate).text)) {
        targets.push({
          from: line.from,
          to: doc.line(candidate).to,
          align: imageAlignment(paragraph[1] ?? ""),
          images
        });
        lineNumber = candidate + 1;
        continue;
      }
      lineNumber = candidate;
      continue;
    }

    const single = singleLineImage(line.text);
    if (single !== null) targets.push({ from: line.from, to: line.to, align: single.align, images: [single.spec] });
    lineNumber += 1;
  }
  return targets;
}

export type WorkspaceMarkdownImageSource =
  | { readonly kind: "embedded"; readonly url: string }
  | { readonly kind: "remote"; readonly url: string }
  | { readonly kind: "workspace"; readonly path: string };

/** Resolve against the Markdown file's parent without permitting workspace escape. */
export function resolveWorkspaceMarkdownImageSource(
  markdownPath: string,
  authoredSource: string
): WorkspaceMarkdownImageSource | undefined {
  const source = decodeAuthoredPath(authoredSource.trim());
  if (/^data:image\//iu.test(source)) return { kind: "embedded", url: source };
  if (/^https?:\/\//iu.test(source)) return { kind: "remote", url: source };
  if (source === "" || source.startsWith("/") || source.startsWith("\\") || /^[a-z][a-z\d+.-]*:/iu.test(source) || source.includes("\\")) return undefined;

  const base = markdownPath.split("/").slice(0, -1);
  const parts = [...base];
  for (const part of source.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    if (part.endsWith(".") || part.endsWith(" ") || /[:*?"<>|\u0000-\u001f\u007f-\u009f]/u.test(part)) return undefined;
    parts.push(part);
  }
  return parts.length === 0 ? undefined : { kind: "workspace", path: parts.join("/") };
}

function decodeAuthoredPath(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function singleLineImage(text: string): { readonly spec: WorkspaceMarkdownImageSpec; readonly align: "center" | null } | null {
  const markdown = MARKDOWN_IMAGE.exec(text);
  if (markdown !== null) {
    const token = markdown[2] ?? "";
    const src = token.startsWith("<") ? token.slice(1, -1).trim() : token;
    if (src === "") return null;
    const title = markdown[3] ?? "";
    return {
      spec: { src, alt: markdown[1] ?? "", title: title === "" ? "" : title.slice(1, -1), width: null, height: null },
      align: null
    };
  }
  const wiki = WIKI_IMAGE.exec(text);
  if (wiki !== null) {
    const src = (wiki[1] ?? "").trim();
    if (src === "" || !IMAGE_EXTENSION.test(src)) return null;
    return {
      spec: {
        src,
        alt: "",
        title: "",
        width: wiki[2] === undefined ? null : Number(wiki[2]),
        height: wiki[3] === undefined ? null : Number(wiki[3])
      },
      align: null
    };
  }
  const wrapped = HTML_WRAPPED_IMAGE.exec(text);
  if (wrapped !== null) {
    const spec = parseImageAttributes(wrapped[2] ?? "");
    return spec === null ? null : { spec, align: imageAlignment(wrapped[1] ?? "") };
  }
  const bare = HTML_BARE_IMAGE.exec(text);
  if (bare !== null) {
    const spec = parseImageAttributes(bare[1] ?? "");
    return spec === null ? null : { spec, align: null };
  }
  return null;
}

function imageAttribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "iu").exec(attributes);
  return match === null ? null : match[1] ?? match[2] ?? match[3] ?? "";
}

function imageDimension(attributes: string, name: string): number | null {
  const value = imageAttribute(attributes, name)?.trim();
  const match = value === undefined ? null : /^(\d+)(?:px)?$/u.exec(value);
  return match === null ? null : Number(match[1]);
}

function parseImageAttributes(attributes: string): WorkspaceMarkdownImageSpec | null {
  const src = imageAttribute(attributes, "src");
  if (src === null || src === "") return null;
  return {
    src,
    alt: imageAttribute(attributes, "alt") ?? "",
    title: imageAttribute(attributes, "title") ?? "",
    width: imageDimension(attributes, "width"),
    height: imageDimension(attributes, "height")
  };
}

function imageAlignment(attributes: string): "center" | null {
  return imageAttribute(attributes, "align")?.toLocaleLowerCase() === "center" ? "center" : null;
}

class WorkspaceMarkdownImageWidget extends WidgetType {
  readonly #roots = new WeakMap<HTMLElement, { disposed: boolean; releases: (() => void)[] }>();

  constructor(
    readonly target: WorkspaceMarkdownImageTarget,
    readonly resolver: WorkspaceMarkdownImageResolver,
    readonly labels: WorkspaceMarkdownImageLabels
  ) {
    super();
  }

  override eq(other: WorkspaceMarkdownImageWidget): boolean {
    return other.resolver === this.resolver
      && other.labels === this.labels
      && JSON.stringify(other.target) === JSON.stringify(this.target);
  }

  toDOM(): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-md-image-widget";
    if (this.target.align === "center") root.classList.add("cm-md-image-center");
    root.setAttribute("contenteditable", "false");
    const lifecycle = { disposed: false, releases: [] as (() => void)[] };
    this.#roots.set(root, lifecycle);
    for (const spec of this.target.images) root.appendChild(this.#item(spec, lifecycle));
    return root;
  }

  override destroy(dom: HTMLElement): void {
    const lifecycle = this.#roots.get(dom);
    if (lifecycle === undefined) return;
    lifecycle.disposed = true;
    for (const release of lifecycle.releases.splice(0)) release();
    this.#roots.delete(dom);
  }

  #item(spec: WorkspaceMarkdownImageSpec, lifecycle: { disposed: boolean; releases: (() => void)[] }): HTMLElement {
    const holder = document.createElement("div");
    holder.className = "cm-md-image-item";
    holder.appendChild(this.#status(this.labels.loading, spec.src, true));
    void this.resolver(spec.src).then((resolved) => {
      if (lifecycle.disposed) {
        resolved?.release?.();
        return;
      }
      if (resolved === undefined) {
        holder.replaceChildren(this.#status(this.labels.loadFailed, spec.src));
        return;
      }
      if (resolved.release !== undefined) lifecycle.releases.push(resolved.release);
      const image = document.createElement("img");
      image.src = resolved.url;
      image.referrerPolicy = "no-referrer";
      image.alt = spec.alt;
      image.draggable = false;
      image.loading = "lazy";
      if (spec.title !== "") image.title = spec.title;
      if (spec.width !== null) image.style.width = `${spec.width}px`;
      if (spec.height !== null) image.style.height = `${spec.height}px`;
      image.addEventListener("load", () => {
        holder.classList.add("cm-md-image-clickable");
        holder.setAttribute("role", "button");
        holder.setAttribute("tabindex", "0");
        holder.setAttribute("aria-label", spec.alt || this.labels.open);
      });
      image.addEventListener("error", () => {
        holder.classList.remove("cm-md-image-clickable");
        holder.removeAttribute("role");
        holder.removeAttribute("tabindex");
        holder.replaceChildren(this.#status(this.labels.loadFailed, spec.src));
      });
      const open = (event: Event): void => {
        if (!holder.classList.contains("cm-md-image-clickable")) return;
        event.preventDefault();
        event.stopPropagation();
        window.dispatchEvent(new CustomEvent<WorkspaceMarkdownImageOpenDetail>(WORKSPACE_MARKDOWN_IMAGE_OPEN_EVENT, {
          detail: { ...resolved, returnFocus: holder }
        }));
      };
      holder.addEventListener("click", open);
      holder.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") open(event);
      });
      holder.replaceChildren(image);
    }).catch(() => {
      if (!lifecycle.disposed) holder.replaceChildren(this.#status(this.labels.loadFailed, spec.src));
    });
    return holder;
  }

  #status(label: string, source: string, loading = false): HTMLElement {
    const card = document.createElement("div");
    card.className = `cm-md-image-error${loading ? " cm-md-image-loading" : ""}`;
    const title = document.createElement("div");
    title.className = "cm-md-image-error-label";
    title.textContent = label;
    const path = document.createElement("div");
    path.className = "cm-md-image-error-path";
    path.textContent = source;
    card.append(title, path);
    return card;
  }
}

const markdownImageDecorationField = StateField.define<DecorationSet>({
  create(state) {
    return buildImageDecorations(state.doc, state.facet(resolverFacet), state.facet(labelsFacet));
  },
  update(value, transaction) {
    const resolver = transaction.state.facet(resolverFacet);
    const labels = transaction.state.facet(labelsFacet);
    if (!transaction.docChanged
      && transaction.startState.facet(resolverFacet) === resolver
      && transaction.startState.facet(labelsFacet) === labels) return value;
    return buildImageDecorations(transaction.state.doc, resolver, labels);
  },
  provide: (field) => EditorView.decorations.from(field)
});

function buildImageDecorations(doc: Text, resolver: WorkspaceMarkdownImageResolver, labels: WorkspaceMarkdownImageLabels): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const target of findWorkspaceMarkdownImageTargets(doc)) {
    builder.add(target.from, target.to, Decoration.replace({
      block: true,
      widget: new WorkspaceMarkdownImageWidget(target, resolver, labels)
    }));
  }
  return builder.finish();
}

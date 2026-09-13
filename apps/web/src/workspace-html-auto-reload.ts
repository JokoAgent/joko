import type { SessionView, TimelineItemView } from "./model.js";

const surfaces = new WeakMap<Document, Map<string, Set<HTMLElement>>>();

export function registerWorkspaceHtmlPreviewSurface(browserId: string, pageId: string, element: HTMLElement): () => void {
  const document = element.ownerDocument;
  let pages = surfaces.get(document);
  if (pages === undefined) { pages = new Map(); surfaces.set(document, pages); }
  const key = `${browserId}/${pageId}`;
  let elements = pages.get(key);
  if (elements === undefined) { elements = new Set(); pages.set(key, elements); }
  elements.add(element);
  return () => { elements.delete(element); if (elements.size === 0) pages.delete(key); };
}

export function isWorkspaceHtmlPreviewVisible(document: Document, browserId: string, pageId: string): boolean {
  return [...(surfaces.get(document)?.get(`${browserId}/${pageId}`) ?? [])]
    .some((element) => element.isConnected && element.closest("[hidden], [aria-hidden='true']") === null);
}

/** Observe one active preview's main Run and its independently delivered file-change evidence. */
export class WorkspaceHtmlAutoReload {
  #runId: string | undefined;
  #path: string;
  #previewOrigin: string | undefined;

  constructor(readonly workspaceId: string, path: string) { this.#path = path; }

  /** Follow only the live page URL from the same bounded Joko preview origin. */
  observePageUrl(url: string): boolean {
    const parsed = workspaceHtmlPath(url);
    if (parsed === undefined || (this.#previewOrigin !== undefined && parsed.origin !== this.#previewOrigin)) return false;
    this.#previewOrigin ??= parsed.origin;
    this.#path = parsed.path;
    return true;
  }

  observe(session: SessionView, items: readonly TimelineItemView[], active: boolean): boolean {
    if (!active) { this.#runId = undefined; return false; }
    if (session.activeRunId !== undefined) { this.#runId = session.activeRunId; return false; }
    if (this.#runId === undefined) return false;
    const evidence = items.find((item) => item.runId === this.#runId && item.workspaceDiff?.changeSetId !== undefined
      && item.workspaceDiff.workspaceId === this.workspaceId);
    if (evidence === undefined) return false;
    this.#runId = undefined;
    return evidence.workspaceDiff!.files.some((file) => file.path === this.#path && file.status !== "deleted");
  }
}

function workspaceHtmlPath(url: string): { readonly origin: string; readonly path: string } | undefined {
  if (url.length === 0 || url.length > 8_192) return undefined;
  try {
    const value = new URL(url);
    const path = decodeURIComponent(value.pathname.slice(1));
    if (value.protocol !== "http:" || value.port !== "" || value.username !== "" || value.password !== ""
      || !/^[a-z0-9-]{1,80}\.preview\.joko\.localhost$/u.test(value.hostname)
      || path.length === 0 || path.length > 4_096 || !/\.html?$/iu.test(path) || /[\\:\x00-\x1f]/u.test(path)
      || path.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
    return { origin: value.origin, path };
  } catch { return undefined; }
}

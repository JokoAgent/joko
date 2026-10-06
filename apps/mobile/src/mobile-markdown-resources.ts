import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { FileKind, type BlobRef, type FilePreview, type WorkspaceEntry } from "@joko/contracts";
import { parseMobileMarkdown, type MobileMarkdownInline } from "./mobile-markdown";
import { classifyChatPathLinkTarget, classifyInlineCodePathCandidate, resolveChatAbsPath, splitChatPathLineSuffix, toWorkdirRel } from "./mobile-markdown-path-candidate";
import { canonicalWorkspacePath, normalizeMediaType, workspaceEntryRevisionKey, workspaceParentPath } from "./workspace-files";
import { inspectMobileImageGalleryBytes, mobileImageGalleryDimensionsMatch, mobileImageGalleryPage, mobileImageGalleryPreviewUri,
  type MobileImageGalleryPage } from "./mobile-image-gallery";
import { assertWorkspaceFilePreview } from "./network";

export interface MobileMarkdownResourceCandidate {
  readonly key: string;
  readonly kind: "image" | "path";
  readonly relativePath: string;
  readonly label: string;
  readonly ambiguous: boolean;
  readonly line?: number;
  readonly column?: number;
}
export interface MobileMarkdownResourceReference {
  readonly key: string;
  readonly kind: "file" | "directory" | "image";
  readonly label: string;
  readonly relativePath: string;
  readonly image?: { readonly uri: string; readonly width: number; readonly height: number;
    readonly nativeQuarterTurn?: true };
}
export interface MobileMarkdownResourceDescriptor {
  readonly leaseId: string;
  readonly references: ReadonlyMap<string, MobileMarkdownResourceReference>;
}
export interface MobileMarkdownResourceContext {
  readonly workspaceId: string;
  readonly workdir: string;
  readonly baseDirectory?: string;
  readonly maximumSourceCharacters?: number;
  assertCurrent(signal?: AbortSignal): void;
  revalidateSource(signal: AbortSignal): Promise<void>;
  listDirectory(parent: string, signal: AbortSignal): Promise<{ readonly entries: readonly WorkspaceEntry[]; readonly revision: string }>;
  readFile(entry: WorkspaceEntry, signal: AbortSignal): Promise<FilePreview>;
  download(blob: BlobRef, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }>;
}
interface Lease {
  readonly id: string;
  readonly context: MobileMarkdownResourceContext;
  readonly controller: AbortController;
  readonly candidates: readonly MobileMarkdownResourceCandidate[];
  readonly references: Map<string, MobileMarkdownResourceReference>;
  readonly entries: Map<string, WorkspaceEntry>;
  readonly pages: Map<string, MobileImageGalleryPage>;
  pins: number;
  bytes: number;
  pixels: number;
}

export function mobileMarkdownResourceKey(inline: MobileMarkdownInline): string | undefined {
  return inline.type === "image" || inline.type === "link" ? JSON.stringify([inline.type, inline.url])
    : inline.type === "code" ? JSON.stringify(["code", inline.text]) : undefined;
}

export function collectMobileMarkdownResourceCandidates(text: string, workdir: string, baseDirectory?: string, maximumSourceCharacters = 200_000): readonly MobileMarkdownResourceCandidate[] {
  if (!Number.isSafeInteger(maximumSourceCharacters) || maximumSourceCharacters < 1 || text.length > Math.min(2_097_152, maximumSourceCharacters)) return [];
  const candidates = new Map<string, MobileMarkdownResourceCandidate>();
  const collect = (inlines: readonly MobileMarkdownInline[]) => {
    for (const inline of inlines) {
      if (candidates.size >= 64) break;
      const key = mobileMarkdownResourceKey(inline);
      if (!key || candidates.has(key)) continue;
      const image = inline.type === "image";
      const raw = inline.type === "image" || inline.type === "link" ? inline.url : inline.type === "code" ? inline.text : "";
      if (!raw || raw.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(raw)) continue;
      const classified = image ? splitChatPathLineSuffix(raw) : inline.type === "code"
        ? classifyInlineCodePathCandidate(raw) : classifyChatPathLinkTarget(raw);
      if (!classified) continue;
      let href = classified.href;
      if (/^file:\/\//iu.test(href)) {
        try {
          const url = new URL(href);
          if (url.hostname && url.hostname !== "localhost" || url.username || url.password || url.search || url.hash) continue;
          href = decodeURIComponent(url.pathname);
          if (/^\/[A-Za-z]:[\\/]/u.test(href)) href = href.slice(1);
        } catch { continue; }
      } else if (/^[a-z][a-z0-9+.-]*:/iu.test(href) && !/^[A-Za-z]:[\\/]/u.test(href)) continue;
      else {
        try { href = decodeURIComponent(href); } catch { /* Literal percent filenames remain valid candidates. */ }
      }
      const absolute = /^[\\/]|^[A-Za-z]:[\\/]/u.test(href);
      const relative = baseDirectory !== undefined && !absolute ? fileRelativePath(baseDirectory, href, workdir)
        : toWorkdirRel(workdir, resolveChatAbsPath(href, workdir));
      if (relative === null) continue;
      let path: string;
      try { path = canonicalWorkspacePath(relative.replace(/\/+$/u, "")); } catch { continue; }
      candidates.set(key, { key, kind: image ? "image" : "path", relativePath: path,
        label: inline.type === "image" ? inline.alt : inline.type === "link" ? inline.text : raw,
        ambiguous: !image && "ambiguousShape" in classified && classified.ambiguousShape === true,
        ...(classified.line ? { line: classified.line } : {}), ...(classified.column ? { column: classified.column } : {}) });
    }
  };
  for (const block of parseMobileMarkdown(text)) {
    if ("inlines" in block) collect(block.inlines);
    else if (block.type === "table") { block.header.forEach(collect); block.rows.forEach((row) => row.cells.forEach(collect)); }
  }
  return [...candidates.values()];
}

function fileRelativePath(baseDirectory: string, href: string, workdir: string): string | null {
  const segments = canonicalWorkspacePath(baseDirectory).split("/").filter(Boolean);
  const relative = /^[A-Za-z]:[\\/]/u.test(workdir) ? href.replace(/\\/gu, "/") : href;
  for (const segment of relative.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { if (!segments.length) return null; segments.pop(); }
    else segments.push(segment);
  }
  return segments.join("/");
}

export class MobileMarkdownResourceReader {
  #leases = new Map<string, Lease>();
  #activeReads = 0;
  #waiting: { grant(): void; cancel(): void; readonly signal: AbortSignal }[] = [];

  async prepare(id: string, text: string, context: MobileMarkdownResourceContext, signal: AbortSignal): Promise<MobileMarkdownResourceDescriptor> {
    context.assertCurrent(signal);
    const candidates = collectMobileMarkdownResourceCandidates(text, context.workdir, context.baseDirectory, context.maximumSourceCharacters);
    if (!candidates.length) return { leaseId: id, references: new Map() };
    if (this.#leases.size >= 64 || this.#leases.has(id)) throw new Error("The message resource limit was reached.");
    const lease: Lease = { id, context, controller: new AbortController(), candidates,
      references: new Map(), entries: new Map(), pages: new Map(), pins: 1, bytes: 0, pixels: 0 };
    this.#leases.set(id, lease);
    const abort = () => lease.controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const deadline = setTimeout(abort, 15_000);
    try {
      const directories = new Map<string, readonly WorkspaceEntry[]>();
      for (const candidate of lease.candidates) {
        this.#assert(lease);
        const parent = workspaceParentPath(candidate.relativePath);
        try {
          if (!directories.has(parent)) directories.set(parent, await this.#directory(lease, parent));
          const entries = directories.get(parent)!;
          const entry = entries.find((item) => pathKey(item.relativePath, context.workdir) === pathKey(candidate.relativePath, context.workdir));
          if (!entry || (entry.kind !== FileKind.REGULAR && entry.kind !== FileKind.DIRECTORY)) continue;
          if (entry.kind === FileKind.REGULAR && !entry.revision) continue;
          if (candidate.kind === "image" && entry.kind !== FileKind.REGULAR) continue;
          lease.entries.set(candidate.key, entry);
          const reference: MobileMarkdownResourceReference = { key: candidate.key,
            kind: entry.kind === FileKind.DIRECTORY ? "directory" : "file",
            relativePath: entry.relativePath, label: candidate.label };
          if (candidate.kind === "path") lease.references.set(candidate.key, reference);
          if (candidate.kind === "image" && entry.kind === FileKind.REGULAR) await this.#image(lease, candidate, entry);
        } catch {
          this.#assert(lease);
        }
      }
      this.#assert(lease);
      const descriptor = { leaseId: id, references: new Map(lease.references) };
      if (!lease.references.size) this.release(id);
      return descriptor;
    } catch (error) { this.release(id); throw error; }
    finally { clearTimeout(deadline); signal.removeEventListener("abort", abort); }
  }

  assertCurrent(id: string): void { this.#assert(this.#lease(id)); }
  retain(id: string): void { const lease = this.#lease(id); this.#assert(lease); lease.pins += 1; }
  release(id: string): void {
    const lease = this.#leases.get(id); if (!lease) return;
    lease.pins -= 1;
    if (lease.pins <= 0) { lease.controller.abort(); this.#leases.delete(id); }
  }
  releaseAll(): void { for (const lease of this.#leases.values()) lease.controller.abort(); this.#leases.clear(); }
  retireStale(): void {
    for (const lease of this.#leases.values()) {
      try { this.#assert(lease); } catch { lease.controller.abort(); this.#leases.delete(lease.id); }
    }
  }
  imagePages(id: string): readonly MobileImageGalleryPage[] { const lease = this.#lease(id); this.#assert(lease); return [...lease.pages.values()]; }
  imagePage(id: string, key: string): MobileImageGalleryPage | undefined { const lease = this.#lease(id); this.#assert(lease); return lease.pages.get(key); }

  async revalidate(id: string, key: string, signal: AbortSignal): Promise<{
    readonly candidate: MobileMarkdownResourceCandidate; readonly entry: WorkspaceEntry;
  }> {
    const lease = this.#lease(id); this.#assert(lease, signal);
    const candidate = lease.candidates.find((item) => item.key === key);
    if (!candidate || !lease.references.has(key)) throw new Error("The message path is unavailable.");
    await this.#read(lease, (current) => lease.context.revalidateSource(current), signal);
    const entries = await this.#directory(lease, workspaceParentPath(candidate.relativePath), signal);
    const entry = entries.find((item) => pathKey(item.relativePath, lease.context.workdir) === pathKey(candidate.relativePath, lease.context.workdir));
    const previous = lease.entries.get(key);
    if (!entry || entry.kind !== FileKind.REGULAR && entry.kind !== FileKind.DIRECTORY
      || entry.kind === FileKind.REGULAR && !entry.revision || previous && (entry.kind !== previous.kind
        || entry.relativePath !== previous.relativePath || entry.kind === FileKind.REGULAR
          && workspaceEntryRevisionKey(entry.revision!) !== workspaceEntryRevisionKey(previous.revision!))) {
      throw new Error("The message path changed. Reload the message before opening it.");
    }
    this.#assert(lease, signal);
    return { candidate, entry };
  }

  async revalidateImages(id: string, signal: AbortSignal): Promise<void> {
    const lease = this.#lease(id);
    for (const key of lease.pages.keys()) await this.revalidate(id, key, signal);
  }

  #lease(id: string): Lease { const lease = this.#leases.get(id); if (!lease) throw new Error("The message resource was released."); return lease; }
  #assert(lease: Lease, signal?: AbortSignal): void {
    signal?.throwIfAborted(); lease.controller.signal.throwIfAborted();
    if (this.#leases.get(lease.id) !== lease) throw new Error("The message resource changed.");
    lease.context.assertCurrent(signal);
  }
  async #directory(lease: Lease, parent: string, signal?: AbortSignal): Promise<readonly WorkspaceEntry[]> {
    const result = await this.#read(lease, (current) => lease.context.listDirectory(parent, current), signal);
    if (!result.revision) throw new Error("The Workspace directory is not fenced.");
    const seen = new Set<string>();
    for (const entry of result.entries) {
      const key = pathKey(canonicalWorkspacePath(entry.relativePath), lease.context.workdir);
      if (entry.workspaceId !== lease.context.workspaceId
        || pathKey(workspaceParentPath(entry.relativePath), lease.context.workdir) !== pathKey(parent, lease.context.workdir) || seen.has(key)) {
        throw new Error("The Workspace directory returned an ambiguous path.");
      }
      seen.add(key);
    }
    return result.entries;
  }
  async #read<T>(lease: Lease, read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.#assert(lease, signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    lease.controller.signal.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    if (lease.controller.signal.aborted || signal?.aborted) abort();
    const deadline = setTimeout(abort, 15_000);
    try {
      await this.#acquire(controller.signal);
      let raw: Promise<T>;
      try { this.#assert(lease, signal); controller.signal.throwIfAborted(); raw = read(controller.signal); }
      catch (error) { this.#releaseRead(); throw error; }
      void raw.then(() => this.#releaseRead(), () => this.#releaseRead());
      const result = await awaitMobileMarkdownResourceRead(raw, controller.signal);
      this.#assert(lease, signal); return result;
    } finally {
      clearTimeout(deadline);
      lease.controller.signal.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", abort);
    }
  }
  #acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#activeReads < 2 && this.#waiting.length === 0) { this.#activeReads += 1; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const waiting = { signal, grant: () => { signal.removeEventListener("abort", waiting.cancel); resolve(); },
        cancel: () => {
          signal.removeEventListener("abort", waiting.cancel);
          this.#waiting = this.#waiting.filter((item) => item !== waiting);
          reject(new Error("The message resource read was cancelled."));
        } };
      this.#waiting.push(waiting);
      signal.addEventListener("abort", waiting.cancel, { once: true });
    });
  }
  #releaseRead(): void {
    this.#activeReads -= 1;
    while (this.#activeReads < 2 && this.#waiting.length) {
      const waiting = this.#waiting.shift()!;
      if (waiting.signal.aborted) waiting.cancel();
      else { this.#activeReads += 1; waiting.grant(); }
    }
  }
  async #image(lease: Lease, candidate: MobileMarkdownResourceCandidate, entry: WorkspaceEntry): Promise<void> {
    const revision = entry.revision!;
    if (revision.byteSize < 1n || revision.byteSize > 8n * 1_024n * 1_024n) return;
    const occupied = [...this.#leases.values()].reduce((total, item) => total + item.bytes, 0);
    if (occupied + Number(revision.byteSize) > 16 * 1_024 * 1_024) return;
    lease.bytes += Number(revision.byteSize);
    let adopted = false;
    try {
      const preview = await this.#read(lease, (signal) => lease.context.readFile(entry, signal));
      assertWorkspaceFilePreview(lease.context.workspaceId, entry.relativePath, revision, preview);
      const returned = preview.entry;
      if (preview.truncated || !returned?.revision || returned.workspaceId !== lease.context.workspaceId || returned.relativePath !== entry.relativePath
        || returned.kind !== FileKind.REGULAR) {
        throw new Error("The image file changed while being read.");
      }
      const blob = preview.content.case === "image" ? preview.content.value.blob : preview.content.case === "blob" ? preview.content.value : undefined;
      const dimensions = preview.content.case === "image" ? preview.content.value : undefined;
      if (dimensions && (dimensions.widthPixels === 0) !== (dimensions.heightPixels === 0)) throw new Error("The image dimensions are incomplete.");
      const page = mobileImageGalleryPage({ pageId: "markdown-" + lease.id + "-" + lease.pages.size,
        title: candidate.label || blob?.fileName || "Image", blob, source: { kind: "workspace", relativePath: entry.relativePath,
          revisionKey: workspaceEntryRevisionKey(revision) }, ...(dimensions && dimensions.widthPixels > 0 && dimensions.heightPixels > 0
            ? { widthPixels: dimensions.widthPixels, heightPixels: dimensions.heightPixels, requireDimensions: true } : {}) });
      if (!page || page.blob.byteSize !== revision.byteSize || page.blob.byteSize !== returned.revision.byteSize
        || page.sha256Hex !== returned.revision.sha256Hex
        || page.mediaType !== normalizeMediaType(returned.mediaType) || page.mediaType !== normalizeMediaType(entry.mediaType)) {
        throw new Error("The image did not return its exact typed Blob.");
      }
      const downloaded = await this.#read(lease, (signal) => lease.context.download(page.blob, signal));
      if (downloaded.bytes.byteLength !== page.byteSize || normalizeMediaType(downloaded.mediaType) !== page.mediaType
        || bytesToHex(sha256(downloaded.bytes)) !== page.sha256Hex) throw new Error("The downloaded image changed.");
      const decoded = inspectMobileImageGalleryBytes(downloaded.bytes, page.mediaType);
      if (page.widthPixels !== undefined && !mobileImageGalleryDimensionsMatch(decoded, page.widthPixels, page.heightPixels!)) {
        throw new Error("The image dimensions changed.");
      }
      const pixels = [...this.#leases.values()].reduce((total, item) => total + item.pixels, 0);
      if (pixels + decoded.width * decoded.height > 12_000_000) return;
      lease.pixels += decoded.width * decoded.height;
      lease.pages.set(candidate.key, page);
      lease.references.set(candidate.key, { key: candidate.key, kind: "image", label: candidate.label, relativePath: entry.relativePath,
        image: { uri: mobileImageGalleryPreviewUri(downloaded.bytes, decoded), width: decoded.width, height: decoded.height,
          ...(decoded.nativeQuarterTurn ? { nativeQuarterTurn: true } : {}) } });
      adopted = true;
    } finally { if (!adopted) lease.bytes -= Number(revision.byteSize); }
  }
}

function pathKey(path: string, workdir: string): string { return /^[A-Za-z]:[\\/]/u.test(workdir) ? path.toLocaleLowerCase("en-US") : path; }
export function awaitMobileMarkdownResourceRead<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("The message resource read was cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

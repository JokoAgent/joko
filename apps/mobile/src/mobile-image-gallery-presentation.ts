import type { MobileClient } from "./mobile-client";
import type { MobileImageGalleryDescriptor, MobileImageGalleryPageSession } from "./mobile-image-gallery";
import type { MobileTimelineImagePreview } from "./mobile-timeline-images";
import { awaitMobileMarkdownResourceRead } from "./mobile-markdown-resources";

export interface MobileImageGalleryView {
  readonly descriptor: MobileImageGalleryDescriptor;
  readonly pageIndex: number;
  readonly pageKey: string;
  readonly session?: MobileImageGalleryPageSession;
  readonly preview?: MobileTimelineImagePreview;
  readonly adjacentPreviews?: readonly { readonly pageIndex: number; readonly preview: MobileTimelineImagePreview }[];
  readonly busy: boolean;
  readonly failed: boolean;
}
type Client = Pick<MobileClient, "loadImageGalleryPage" | "cancelImageGallery" | "pinImageGalleryCachedPreview" | "releaseImageGalleryPreview" | "discardImageGalleryPage">;

/** The selected page is visible before its original bytes or native decode are ready. */
export class MobileImageGalleryPresenter {
  #view: MobileImageGalleryView | undefined;
  #listeners = new Set<() => void>();
  #controller: AbortController | undefined;
  #opening: AbortController | undefined;
  #rawRead: Promise<MobileImageGalleryPageSession> | undefined;
  #attempt = 0;
  #nativeRetries = new Set<string>();
  constructor(readonly client: Client) {}
  get snapshot(): MobileImageGalleryView | undefined { return this.#view; }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  #set(view: MobileImageGalleryView | undefined): void { this.#view = view; for (const listener of this.#listeners) listener(); }
  #releasePreviews(view: MobileImageGalleryView | undefined, discard = false): void {
    if (!view) return;
    const previews = [...(view.preview ? [view.preview] : []), ...(view.adjacentPreviews?.map((item) => item.preview) ?? [])];
    for (const id of new Set(previews.map((preview) => preview.leaseId))) {
      this.client.releaseImageGalleryPreview(view.descriptor.leaseId, id, discard && view.preview?.leaseId === id);
    }
  }

  close = (): void => {
    this.#opening?.abort(); this.#opening = undefined;
    const previous = this.#view; this.#releasePreviews(previous);
    this.#controller?.abort(); this.#controller = undefined; this.#set(undefined); this.#nativeRetries.clear();
    if (previous) {
      this.client.cancelImageGallery(previous.descriptor.leaseId);
    }
  };

  async open(begin: (signal: AbortSignal) => Promise<MobileImageGalleryDescriptor>): Promise<void> {
    this.close(); const controller = new AbortController(); this.#opening = controller;
    const deadline = setTimeout(() => controller.abort(), 15_000);
    const raw = begin(controller.signal);
    void raw.then((descriptor) => { if (controller.signal.aborted) this.client.cancelImageGallery(descriptor.leaseId); }, () => undefined);
    try {
      const descriptor = await awaitMobileMarkdownResourceRead(raw, controller.signal);
      if (this.#opening !== controller) return;
      if (!descriptor.pages.length || !descriptor.pages[descriptor.initialIndex]) throw new Error("The gallery has no selected image.");
      this.#opening = undefined; this.#startPage(descriptor, descriptor.initialIndex, false);
    } catch (failure) {
      if (!controller.signal.aborted || this.#opening === controller) throw failure;
    } finally { clearTimeout(deadline); if (this.#opening === controller) this.#opening = undefined; }
  }

  navigate = (pageIndex: number): void => {
    const current = this.#view;
    if (!current || !Number.isSafeInteger(pageIndex) || !current.descriptor.pages[pageIndex] || pageIndex === current.pageIndex) return;
    this.#startPage(current.descriptor, pageIndex, false);
  };
  retry = (): void => { const current = this.#view; if (current) this.#startPage(current.descriptor, current.pageIndex, true); };
  nativeFailed = (loadId: string, automatically = true): void => {
    const current = this.#view; if (!current || current.session?.leaseId !== loadId) return;
    const key = current.descriptor.pages[current.pageIndex]!.pageId;
    if (automatically && !this.#nativeRetries.has(key)) {
      this.#nativeRetries.add(key); this.#startPage(current.descriptor, current.pageIndex, true); return;
    }
    this.#releasePreviews(current, true); this.#controller?.abort();
    this.client.discardImageGalleryPage(current.descriptor.leaseId, loadId);
    this.#set({ descriptor: current.descriptor, pageIndex: current.pageIndex, pageKey: current.pageKey, busy: false, failed: true });
  };
  previewFailed = (previewId: string): void => {
    const current = this.#view;
    if (!current || current.preview?.leaseId !== previewId && !current.adjacentPreviews?.some((item) => item.preview.leaseId === previewId)) return;
    this.client.releaseImageGalleryPreview(current.descriptor.leaseId, previewId, true);
    if (current.preview?.leaseId === previewId) { const { preview: _preview, ...rest } = current; this.#set(rest); }
    else this.#set({ ...current, adjacentPreviews: current.adjacentPreviews!.filter((item) => item.preview.leaseId !== previewId) });
  };

  #startPage(descriptor: MobileImageGalleryDescriptor, pageIndex: number, refresh: boolean): void {
    this.#releasePreviews(this.#view, refresh); this.#controller?.abort();
    this.client.discardImageGalleryPage(descriptor.leaseId);
    const controller = new AbortController(); this.#controller = controller;
    const pageKey = `${descriptor.leaseId}:${pageIndex}:${++this.#attempt}`;
    this.#set({ descriptor, pageIndex, pageKey, busy: true, failed: false });
    if (!refresh) for (const index of [pageIndex, pageIndex - 1, pageIndex + 1]) {
      if (!descriptor.pages[index]) continue;
      void this.client.pinImageGalleryCachedPreview(descriptor.leaseId, index, controller.signal).then((preview) => {
        if (!preview) return;
        if (controller.signal.aborted || this.#view?.pageKey !== pageKey) { this.client.releaseImageGalleryPreview(descriptor.leaseId, preview.leaseId); return; }
        if (index === pageIndex) this.#set({ ...this.#view, preview });
        else this.#set({ ...this.#view, adjacentPreviews: [...(this.#view.adjacentPreviews ?? []), { pageIndex: index, preview }] });
      }, () => undefined);
    }
    void this.#read(descriptor, pageIndex, pageKey, controller);
  }
  async #read(descriptor: MobileImageGalleryDescriptor, pageIndex: number, pageKey: string, controller: AbortController): Promise<void> {
    const read = new AbortController(); const abort = () => read.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(abort, 15_000);
    try {
      // Cancelled, uncooperative downloads retain the single original-read slot until their actual completion.
      if (this.#rawRead) await awaitMobileMarkdownResourceRead(this.#rawRead.catch(() => undefined), read.signal);
      read.signal.throwIfAborted();
      const raw = this.client.loadImageGalleryPage(descriptor.leaseId, pageIndex, read.signal); this.#rawRead = raw;
      void raw.then(() => { if (this.#rawRead === raw) this.#rawRead = undefined; }, () => { if (this.#rawRead === raw) this.#rawRead = undefined; });
      const session = await awaitMobileMarkdownResourceRead(raw, read.signal);
      if (this.#view?.pageKey !== pageKey || controller.signal.aborted) return;
      if (session.galleryLeaseId !== descriptor.leaseId || session.pageIndex !== pageIndex || session.pageId !== descriptor.pages[pageIndex]!.pageId) {
        throw new Error("The original image belongs to another gallery page.");
      }
      this.#set({ ...this.#view, session, busy: false, failed: false });
    } catch {
      if (this.#view?.pageKey === pageKey && !controller.signal.aborted) this.#set({ ...this.#view, busy: false, failed: true });
    } finally { clearTimeout(deadline); controller.signal.removeEventListener("abort", abort); }
  }
}

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

  close = (): void => {
    this.#opening?.abort(); this.#opening = undefined; this.#controller?.abort(); this.#controller = undefined;
    const previous = this.#view; this.#set(undefined); this.#nativeRetries.clear();
    if (previous) {
      if (previous.preview) this.client.releaseImageGalleryPreview(previous.descriptor.leaseId, previous.preview.leaseId);
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
    this.#controller?.abort();
    this.client.discardImageGalleryPage(current.descriptor.leaseId, loadId);
    if (current.preview) this.client.releaseImageGalleryPreview(current.descriptor.leaseId, current.preview.leaseId, true);
    this.#set({ descriptor: current.descriptor, pageIndex: current.pageIndex, pageKey: current.pageKey, busy: false, failed: true });
  };
  previewFailed = (previewId: string): void => {
    const current = this.#view; if (!current || current.preview?.leaseId !== previewId) return;
    this.client.releaseImageGalleryPreview(current.descriptor.leaseId, previewId, true);
    const { preview: _preview, ...rest } = current; this.#set(rest);
  };

  #startPage(descriptor: MobileImageGalleryDescriptor, pageIndex: number, refresh: boolean): void {
    this.#controller?.abort(); const previous = this.#view;
    if (previous?.preview) this.client.releaseImageGalleryPreview(previous.descriptor.leaseId, previous.preview.leaseId, refresh);
    this.client.discardImageGalleryPage(descriptor.leaseId);
    const controller = new AbortController(); this.#controller = controller;
    const pageKey = `${descriptor.leaseId}:${pageIndex}:${++this.#attempt}`;
    this.#set({ descriptor, pageIndex, pageKey, busy: true, failed: false });
    if (!refresh) void this.client.pinImageGalleryCachedPreview(descriptor.leaseId, pageIndex, controller.signal).then((preview) => {
      if (!preview) return;
      if (controller.signal.aborted || this.#view?.pageKey !== pageKey) { this.client.releaseImageGalleryPreview(descriptor.leaseId, preview.leaseId); return; }
      this.#set({ ...this.#view, preview });
    }, () => undefined);
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

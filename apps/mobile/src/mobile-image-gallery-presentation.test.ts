import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileImageGalleryDescriptor, MobileImageGalleryPageSession } from "./mobile-image-gallery";
import { MobileImageGalleryPresenter } from "./mobile-image-gallery-presentation";

const presenters: MobileImageGalleryPresenter[] = [];
afterEach(() => { presenters.splice(0).forEach((value) => value.close()); vi.useRealTimers(); });
function fixture() {
  const descriptor: MobileImageGalleryDescriptor = { leaseId: "gallery", sourceKind: "timeline", sourceLabel: "Task message", initialIndex: 0,
    pages: [0, 1].map((index) => ({ pageId: `page-${index}`, title: `${index}.png`, mediaType: "image/png", byteSize: 1, sha256Hex: "a".repeat(64) })) };
  const preview = { leaseId: "preview", uri: "data:image/png;base64,preview", width: 40, height: 20, mediaType: "image/png", animated: false };
  const session = (index: number, id = `original-${index}`): MobileImageGalleryPageSession => ({ leaseId: id, galleryLeaseId: descriptor.leaseId,
    pageId: descriptor.pages[index]!.pageId, pageIndex: index, pageCount: 2, sourceKind: "timeline", sourceLabel: descriptor.sourceLabel,
    previewUri: `data:image/png;base64,${id}`, sourceBase64: "AA==", sourceMediaType: "image/png", fileName: `${index}.png`, initialStrokes: [],
    annotatable: true, addable: true, maximumBytes: 1_024, expectedWidthPixels: 40, expectedHeightPixels: 20, expectedAnimated: false });
  const client = { loadImageGalleryPage: vi.fn<MobileImageGalleryPresenter["client"]["loadImageGalleryPage"]>(async (_id, index) => session(index)),
    pinImageGalleryCachedPreview: vi.fn<MobileImageGalleryPresenter["client"]["pinImageGalleryCachedPreview"]>(async () => preview),
    releaseImageGalleryPreview: vi.fn(), discardImageGalleryPage: vi.fn(), cancelImageGallery: vi.fn() };
  const presenter = new MobileImageGalleryPresenter(client); presenters.push(presenter);
  return { presenter, client, descriptor, preview, session };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

describe("progressive canonical gallery presentation", () => {
  it("opens before the original and keeps the independently pinned preview while current-page fetch errors recover in place", async () => {
    const { presenter, client, descriptor, preview, session } = fixture();
    let finish!: (value: MobileImageGalleryPageSession) => void;
    client.loadImageGalleryPage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await presenter.open(async () => descriptor); await settle();
    expect(presenter.snapshot).toMatchObject({ pageIndex: 0, busy: true, preview }); expect(presenter.snapshot?.session).toBeUndefined();
    finish(session(0)); await settle(); expect(presenter.snapshot).toMatchObject({ busy: false, preview, session: session(0) });
    client.loadImageGalleryPage.mockRejectedValueOnce(new Error("download failed")); presenter.navigate(1); await settle();
    expect(presenter.snapshot).toMatchObject({ pageIndex: 1, busy: false, failed: true }); expect(presenter.snapshot?.session).toBeUndefined();
    const pins = client.pinImageGalleryCachedPreview.mock.calls.length; presenter.retry(); await settle();
    expect(presenter.snapshot).toMatchObject({ pageIndex: 1, busy: false, failed: false, session: session(1) }); expect(presenter.snapshot?.preview).toBeUndefined();
    expect(client.pinImageGalleryCachedPreview).toHaveBeenCalledTimes(pins); expect(client.releaseImageGalleryPreview).toHaveBeenCalledWith("gallery", "preview", true);
  });

  it("cancels stale pages immediately while an uncooperative original retains the only download slot", async () => {
    const { presenter, client, descriptor, session } = fixture(); let finish!: (value: MobileImageGalleryPageSession) => void;
    client.loadImageGalleryPage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await presenter.open(async () => descriptor); presenter.navigate(1); await settle();
    expect(client.loadImageGalleryPage).toHaveBeenCalledOnce(); expect(client.loadImageGalleryPage.mock.calls[0]![2]!.aborted).toBe(true);
    expect(presenter.snapshot).toMatchObject({ pageIndex: 1, busy: true });
    finish(session(0)); await settle(); await settle();
    expect(client.loadImageGalleryPage).toHaveBeenCalledTimes(2); expect(presenter.snapshot?.session?.pageId).toBe("page-1");
    presenter.close(); expect(presenter.snapshot).toBeUndefined(); expect(client.cancelImageGallery).toHaveBeenCalledWith("gallery");
  });

  it("drops bad previews, refetches native failures only once per page and leaves explicit retry available", async () => {
    const { presenter, client, descriptor } = fixture(); await presenter.open(async () => descriptor); await settle();
    presenter.previewFailed("preview"); expect(presenter.snapshot?.preview).toBeUndefined(); expect(client.releaseImageGalleryPreview).toHaveBeenCalledWith("gallery", "preview", true);
    presenter.nativeFailed("original-0"); await settle(); expect(client.loadImageGalleryPage).toHaveBeenCalledTimes(2);
    presenter.nativeFailed("retired-load"); expect(client.loadImageGalleryPage).toHaveBeenCalledTimes(2);
    presenter.nativeFailed("original-0"); expect(presenter.snapshot).toMatchObject({ pageIndex: 0, failed: true }); expect(presenter.snapshot?.session).toBeUndefined();
    presenter.retry(); await settle(); expect(client.loadImageGalleryPage).toHaveBeenCalledTimes(3); expect(presenter.snapshot?.failed).toBe(false);
  });

  it("bounds original-read deadlines, preserves a valid cached frame and rejects late opening and preview results", async () => {
    vi.useFakeTimers(); const { presenter, client, descriptor, session, preview } = fixture();
    let finish!: (value: MobileImageGalleryPageSession) => void;
    client.loadImageGalleryPage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await presenter.open(async () => descriptor); await settle(); await vi.advanceTimersByTimeAsync(15_000);
    expect(presenter.snapshot).toMatchObject({ pageIndex: 0, failed: true, busy: false, preview });
    finish(session(0)); await settle(); expect(presenter.snapshot?.session).toBeUndefined(); presenter.close();
    let opened!: (value: MobileImageGalleryDescriptor) => void;
    const opening = presenter.open(() => new Promise((resolve) => { opened = resolve; }));
    presenter.close(); await opening; opened(descriptor); await settle(); expect(presenter.snapshot).toBeUndefined();
    let pinned!: (value: typeof preview) => void;
    client.pinImageGalleryCachedPreview.mockImplementationOnce(() => new Promise((resolve) => { pinned = resolve; }));
    await presenter.open(async () => descriptor); await settle(); presenter.close(); pinned({ ...preview, leaseId: "late-preview" }); await settle();
    expect(client.releaseImageGalleryPreview).toHaveBeenCalledWith("gallery", "late-preview"); expect(presenter.snapshot).toBeUndefined();
  });
});

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
    prepareImageGalleryAdjacentPreview: vi.fn<MobileImageGalleryPresenter["client"]["prepareImageGalleryAdjacentPreview"]>().mockRejectedValue(new Error("not cached")),
    pinImageGalleryCachedPreview: vi.fn<MobileImageGalleryPresenter["client"]["pinImageGalleryCachedPreview"]>(async () => preview),
    releaseImageGalleryPreview: vi.fn(), discardImageGalleryPage: vi.fn(), cancelImageGallery: vi.fn() };
  const presenter = new MobileImageGalleryPresenter(client); presenters.push(presenter);
  return { presenter, client, descriptor, preview, session };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

describe("progressive canonical gallery presentation", () => {
  it("warms an uncached adjacent image after the current original and cancels background work before navigating", async () => {
    const { presenter, client, descriptor, session, preview } = fixture();
    client.pinImageGalleryCachedPreview.mockResolvedValue(undefined);
    let original!: (value: MobileImageGalleryPageSession) => void; let warm!: (value: typeof preview) => void;
    client.loadImageGalleryPage.mockImplementationOnce(() => new Promise((resolve) => { original = resolve; }));
    client.prepareImageGalleryAdjacentPreview.mockImplementationOnce(() => new Promise((resolve) => { warm = resolve; }));
    await presenter.open(async () => descriptor); await settle();
    expect(client.prepareImageGalleryAdjacentPreview).not.toHaveBeenCalled();
    original(session(0)); await vi.waitFor(() => expect(client.prepareImageGalleryAdjacentPreview).toHaveBeenCalledOnce());
    expect(client.prepareImageGalleryAdjacentPreview.mock.calls[0]![1]).toBe(1);
    presenter.navigate(1); expect(client.prepareImageGalleryAdjacentPreview.mock.calls[0]![2].aborted).toBe(true);
    await vi.waitFor(() => expect(presenter.snapshot?.session?.pageIndex).toBe(1));
    warm({ ...preview, leaseId: "late-warm" }); await settle();
    expect(client.releaseImageGalleryPreview).toHaveBeenCalledWith("gallery", "late-warm");
    expect(presenter.snapshot?.adjacentPreviews).toBeUndefined();
    client.prepareImageGalleryAdjacentPreview.mockResolvedValue({ ...preview, leaseId: "ready-warm" });
    presenter.navigate(0); await vi.waitFor(() => expect(presenter.snapshot?.adjacentPreviews?.[0]?.preview.leaseId).toBe("ready-warm"));
    expect(presenter.snapshot?.session?.pageIndex).toBe(0);
  });

  it("pins only the current and adjacent cached pages, releasing retired or late pins without reading adjacent originals", async () => {
    const { presenter, client, descriptor, session, preview } = fixture();
    const window = { ...descriptor, initialIndex: 2, pages: Array.from({ length: 5 }, (_, index) => ({
      ...descriptor.pages[0]!, pageId: `page-${index}`, title: `${index}.png`
    })) };
    client.loadImageGalleryPage.mockImplementation(async (_id, index) => ({ ...session(0), leaseId: `original-${index}`,
      pageIndex: index, pageId: window.pages[index]!.pageId, pageCount: 5 }));
    let late!: (value: typeof preview) => void; let sequence = 0;
    client.pinImageGalleryCachedPreview.mockImplementation(async (_id, index) => {
      if (index === 3 && sequence++ === 2) return new Promise((resolve) => { late = resolve; });
      return { ...preview, leaseId: `cached-${index}-${sequence++}` };
    });
    await presenter.open(async () => window); await settle();
    expect(client.pinImageGalleryCachedPreview.mock.calls.map((call) => call[1])).toEqual([2, 1, 3]);
    expect(client.loadImageGalleryPage).toHaveBeenCalledOnce();
    expect(presenter.snapshot?.adjacentPreviews?.map((item) => item.pageIndex)).toEqual([1]);
    const currentPin = presenter.snapshot!.preview!.leaseId; const neighborPin = presenter.snapshot!.adjacentPreviews![0]!.preview.leaseId;
    presenter.navigate(4); await settle();
    expect(client.releaseImageGalleryPreview).toHaveBeenCalledWith("gallery", currentPin, false);
    expect(client.releaseImageGalleryPreview).toHaveBeenCalledWith("gallery", neighborPin, false);
    expect(client.pinImageGalleryCachedPreview.mock.calls.slice(3).map((call) => call[1])).toEqual([4, 3]);
    expect(client.loadImageGalleryPage.mock.calls.map((call) => call[1])).toEqual([2, 4]);
    late({ ...preview, leaseId: "retired-neighbor" }); await settle();
    expect(client.releaseImageGalleryPreview).toHaveBeenCalledWith("gallery", "retired-neighbor");
    expect(presenter.snapshot?.adjacentPreviews).toHaveLength(1);
    const neighbor = presenter.snapshot!.adjacentPreviews![0]!.preview;
    presenter.previewFailed(neighbor.leaseId); expect(presenter.snapshot?.adjacentPreviews).toEqual([]);
    expect(presenter.snapshot?.preview).toBeDefined();
    expect(client.releaseImageGalleryPreview).toHaveBeenCalledWith("gallery", neighbor.leaseId, true);
    presenter.close(); expect(presenter.snapshot).toBeUndefined();
    expect(client.pinImageGalleryCachedPreview.mock.calls.every((call) => call[2].aborted)).toBe(true);
  });

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

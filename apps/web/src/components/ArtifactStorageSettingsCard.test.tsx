// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot } from "../model.js";
import { sha256Hex } from "../web-crypto.js";
import { activeDraftAttachmentSha256, ArtifactStorageSettingsCard } from "./SettingsPage.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("ArtifactStorageSettingsCard", () => {
  it("protects structured page-comment screenshots as active draft media", async () => {
    const screenshot = new File(["page evidence"], "browser-comment-1.png", { type: "image/png" });
    Object.defineProperty(screenshot, "arrayBuffer", { value: async () => new TextEncoder().encode("page evidence").buffer });
    const controller = {
      readDraft: vi.fn(async () => ({
        text: "",
        attachments: [],
        mentions: [],
        deliveryMode: "prompt" as const,
        browserComments: [{
          id: "comment-1",
          markerNumber: 1,
          pageUrl: "https://example.test",
          target: { kind: "element" as const, point: { x: 1, y: 1 }, viewport: { width: 10, height: 10 } },
          comment: "",
          screenshot: { id: "screen-1", kind: "image" as const, file: screenshot }
        }]
      })),
      readNewSessionDraft: vi.fn(async () => undefined)
    } as unknown as AppController;
    const snapshot = { ...emptySnapshot(), sessions: [{ id: "session-1" }] } as unknown as ReturnType<typeof emptySnapshot>;
    await expect(activeDraftAttachmentSha256(controller, snapshot)).resolves.toEqual([await sha256Hex(await screenshot.arrayBuffer())]);
  });

  it("fails closed before scanning when an active task draft cannot be read", async () => {
    const scanStorage = vi.fn();
    const cleanup = vi.fn();
    const readDraft = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("draft unavailable"));
    const controller = {
      readDraft,
      readNewSessionDraft: vi.fn(async () => undefined),
      getArtifactStorageStats: vi.fn(async () => ({
        support: "supported" as const,
        stats: {
          referenceCount: 0,
          uniqueBlobCount: 0,
          totalBytes: 0,
          cacheReferenceCount: 0,
          cacheBytes: 0,
          temporaryFileCount: 0,
          temporaryBytes: 0
        }
      })),
      scanArtifactStorage: scanStorage,
      reconcileArtifactStorage: vi.fn(),
      cleanupArtifactStorage: cleanup
    } as unknown as AppController;
    const snapshot = { ...emptySnapshot(), sessions: [{ id: "session-1" }] } as unknown as ReturnType<typeof emptySnapshot>;
    const container = await render(controller, snapshot);

    await act(async () => vi.waitFor(() => expect(controller.getArtifactStorageStats).toHaveBeenCalledWith([])));
    await clickButton(container, "Scan for cleanup");
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Artifact storage could not be scanned.")));

    expect(readDraft).toHaveBeenCalledTimes(2);
    expect(scanStorage).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("fails closed before cleanup when the new-task draft cannot be read", async () => {
    const cleanup = vi.fn();
    const readNewSessionDraft = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("new-task draft unavailable"));
    const scanStorage = vi.fn(async () => ({
      token: "b".repeat(64),
      expiresAt: Date.now() + 60_000,
      protectedReferenceCount: 0,
      expiredReferenceCount: 1,
      orphanBlobCount: 1,
      orphanBlobBytes: 11,
      temporaryFileCount: 0,
      temporaryBytes: 0,
      missingBlobCount: 0,
      unsafeEntryCount: 0,
      cleanableBytes: 11
    }));
    const controller = {
      readDraft: vi.fn(async () => undefined),
      readNewSessionDraft,
      getArtifactStorageStats: vi.fn(async () => ({
        support: "supported" as const,
        stats: {
          referenceCount: 1,
          uniqueBlobCount: 1,
          totalBytes: 11,
          cacheReferenceCount: 1,
          cacheBytes: 11,
          temporaryFileCount: 0,
          temporaryBytes: 0
        }
      })),
      scanArtifactStorage: scanStorage,
      reconcileArtifactStorage: vi.fn(),
      cleanupArtifactStorage: cleanup
    } as unknown as AppController;
    const container = await render(controller);

    await act(async () => vi.waitFor(() => expect(controller.getArtifactStorageStats).toHaveBeenCalledWith([])));
    await clickButton(container, "Scan for cleanup");
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Confirm storage cleanup")));
    await clickButton(container, "Clean up 11 B");
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Artifact storage cleanup failed without a confirmed result.")));

    expect(readNewSessionDraft).toHaveBeenCalledTimes(3);
    expect(scanStorage).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("shows a scan report before cleanup and repeats the active-draft fence", async () => {
    const file = new File(["draft bytes"], "draft.txt", { type: "text/plain" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("draft bytes").buffer
    });
    const digest = await sha256Hex(await file.arrayBuffer());
    const cleanup = vi.fn(async () => ({
      outcome: "completed" as const,
      expiredReferencesDeleted: 1,
      blobsRemoved: 1,
      temporaryFilesRemoved: 0,
      freedBytes: 11,
      skipped: 0
    }));
    const getStats = vi.fn(async () => ({
      support: "supported" as const,
      stats: {
        referenceCount: 1,
        uniqueBlobCount: 1,
        totalBytes: 11,
        cacheReferenceCount: 1,
        cacheBytes: 11,
        temporaryFileCount: 0,
        temporaryBytes: 0
      }
    }));
    const scanStorage = vi.fn(async () => ({
      token: "a".repeat(64),
      expiresAt: Date.now() + 60_000,
      protectedReferenceCount: 1,
      expiredReferenceCount: 1,
      orphanBlobCount: 1,
      orphanBlobBytes: 11,
      temporaryFileCount: 0,
      temporaryBytes: 0,
      missingBlobCount: 0,
      unsafeEntryCount: 0,
      cleanableBytes: 11
    }));
    const controller = {
      readDraft: vi.fn(async () => undefined),
      readNewSessionDraft: vi.fn(async () => ({ attachments: [{ id: "draft", file, kind: "file" }] })),
      getArtifactStorageStats: getStats,
      scanArtifactStorage: scanStorage,
      reconcileArtifactStorage: vi.fn(),
      cleanupArtifactStorage: cleanup
    } as unknown as AppController;
    const container = await render(controller);

    await act(async () => vi.waitFor(() => expect(getStats).toHaveBeenCalledWith([digest])));
    expect([...container.querySelectorAll("button")].find((candidate) => candidate.textContent === "Scan for cleanup")?.disabled).toBe(false);
    await clickButton(container, "Scan for cleanup");
    await act(async () => vi.waitFor(() => expect(scanStorage).toHaveBeenCalledWith([digest])));
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Confirm storage cleanup")));
    expect(container.textContent).toContain("Confirm storage cleanup");
    expect(container.textContent).toContain("Protected 1 references");
    expect(cleanup).not.toHaveBeenCalled();

    await clickButton(container, "Clean up 11 B");
    await act(async () => vi.waitFor(() => expect(cleanup).toHaveBeenCalled()));
    expect(cleanup).toHaveBeenCalledWith("a".repeat(64), [digest]);
    expect(container.textContent).toContain("Cleanup completed");
  });
});

async function render(
  controller: AppController,
  snapshot: ReturnType<typeof emptySnapshot> = emptySnapshot()
): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<ArtifactStorageSettingsCard
    controller={controller}
    snapshot={snapshot}
    t={(key, values) => translate("en", key, values)}
  />));
  return container;
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`Button not found: ${label}`);
  await act(async () => button.click());
}

// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisualHarness } from "./VisualHarness.js";
import { VisualArtifactStorageFixture, VISUAL_ARTIFACT_STORAGE_DRAFT_TEXT, VISUAL_ARTIFACT_STORAGE_SETTLE_EVENT,
  type VisualArtifactStorageState } from "./VisualArtifactStorageFixture.js";

let root: Root | undefined;
const draftSha256 = createHash("sha256").update(VISUAL_ARTIFACT_STORAGE_DRAFT_TEXT).digest("hex");

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/__visual-harness__?scenario=artifact-storage&theme=light#/settings/about");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((media: string) => ({
    matches: false, media, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => true)
  })) });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  // jsdom omits this browser Blob method; FileReader still reads the actual fixture bytes.
  Object.defineProperty(File.prototype, "arrayBuffer", { configurable: true, value: function(this: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error("Expected file bytes."));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  } });
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete document.documentElement.dataset.harnessArtifactStorageState;
  delete document.documentElement.dataset.harnessLastAction;
  delete document.documentElement.dataset.visualHarness;
  delete document.documentElement.dataset.theme;
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(File.prototype, "arrayBuffer");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.restoreAllMocks();
});

describe("Artifact storage visual harness", () => {
  it("presents actual draft protection, health, scan retry, warning cancellation and exact-token cleanup through About", async () => {
    await renderHarness();
    expect(state()).toMatchObject({ phase: "ready", protectedSha256: [draftSha256],
      stats: { referenceCount: 2, uniqueBlobCount: 2, totalBytes: 22 } });
    const initialStatsReads = state().statsReads;
    expect(document.querySelector(".artifact-storage-card")?.textContent).toContain("2 unique files (22 B) across 2 references.");
    const health = button("Check health");
    const scan = button("Scan for cleanup");
    expect(health.disabled).toBe(false);
    expect(scan.disabled).toBe(false);
    await click(health);
    expect(state()).toMatchObject({ phase: "checking", healthRequests: 1, pending: { kind: "health", protectedSha256: [draftSha256] } });
    await click(health);
    await click(scan);
    expect(state()).toMatchObject({ healthRequests: 1, scanRequests: 0 });
    await settle("healthy");
    expect(document.body.textContent).toContain("Storage records and files are consistent.");

    await click(scan);
    const failedAttempt = required(state().pending);
    expect(state()).toMatchObject({ phase: "scanning", scanRequests: 1 });
    await click(scan);
    expect(state().scanRequests).toBe(1);
    await settle("failure");
    expect(document.body.textContent).toContain("Artifact storage could not be scanned.");
    expect(state()).toMatchObject({ failedScans: 1, cleanupRequests: 0 });
    await click(scan);
    expect(required(state().pending).token).not.toBe(failedAttempt.token);
    await settle("success", failedAttempt);
    expect(state().phase).toBe("scanning");
    await settle("warning");
    const warningToken = required(state().scan).token;
    expect(state()).toMatchObject({ phase: "report", scan: { protectedReferenceCount: 1, missingBlobCount: 1, unsafeEntryCount: 1 } });
    expect(document.body.textContent).toContain("Protected 1 references because matching attachments remain in active drafts.");
    expect(document.querySelector(".artifact-storage-warning")).not.toBeNull();
    expect(button("Clean up 11 B").disabled).toBe(true);
    await click(button("Clean up 11 B"));
    expect(state().cleanupRequests).toBe(0);
    await act(async () => wait(40));
    expect(document.activeElement?.textContent).toBe("Cancel");
    await click(button("Cancel"));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(state().cleanupRequests).toBe(0);

    await click(scan);
    await settle("success");
    const acceptedToken = required(state().scan).token;
    expect(acceptedToken).not.toBe(warningToken);
    expect(state().protectedSha256).toEqual([draftSha256]);
    expect(button("Clean up 11 B").disabled).toBe(false);
    await act(async () => wait(40));
    expect(document.activeElement?.textContent).toBe("Clean up 11 B");
    await click(button("Clean up 11 B"));
    expect(state()).toMatchObject({ phase: "running", cleanupRequests: 1,
      cleanup: { token: acceptedToken, maintenanceId: acceptedToken, protectedSha256: [draftSha256], status: "running", percent: 60 } });
    expect(window.sessionStorage.getItem("joko.artifact-storage.maintenance-id")).toBe(acceptedToken);
    expect(document.querySelector<HTMLProgressElement>('progress[value="60"]')).not.toBeNull();
    expect(health.disabled).toBe(true);
    expect(scan.disabled).toBe(true);
    expect([...document.querySelectorAll('[role="alertdialog"] button')].some((value) => value.textContent?.trim() === "Cancel")).toBe(false);
    await act(async () => wait(300));
    expect(state()).toMatchObject({ progressReads: 1, pending: { kind: "progress", token: acceptedToken, maintenanceId: acceptedToken } });
    await settle("completed", failedAttempt);
    expect(state().phase).toBe("running");
    await settle("completed");
    expect(state()).toMatchObject({ phase: "completed", healthRequests: 1, scanRequests: 3, cleanupRequests: 1,
      progressReads: 1, failedScans: 1, completedCleanups: 1, statsReads: initialStatsReads + 1,
      stats: { referenceCount: 1, uniqueBlobCount: 1, totalBytes: 11, cacheBytes: 0 } });
    expect(state().protectedSha256).toEqual([draftSha256]);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.body.textContent).toContain("Cleanup completed.");
    expect(document.body.textContent).toContain("Freed 11 B; removed 1 expired references, 1 files, and 0 temporary uploads.");
    expect(document.querySelector(".artifact-storage-card")?.textContent).toContain("1 unique files (11 B) across 1 references.");
    expect(window.sessionStorage.getItem("joko.artifact-storage.maintenance-id")).toBeNull();
  }, 15_000);

  it("retires pending owner/token/progress reads and rejects mismatched draft protection without new cleanup effects", async () => {
    const fixture = new VisualArtifactStorageFixture();
    await fixture.getArtifactStorageStats([draftSha256]);
    const first = fixture.scanArtifactStorage([draftSha256]);
    const firstAttempt = required(fixture.state.pending);
    const retired = expect(first).rejects.toThrow("owner retired");
    fixture.cancelPending();
    await retired;
    expect(fixture.settle({ ownerId: fixture.state.ownerId, ...firstAttempt, outcome: "success" })).toBe(false);
    const second = fixture.scanArtifactStorage([draftSha256]);
    const currentAttempt = required(fixture.state.pending);
    expect(fixture.settle({ ownerId: "retired-owner", ...currentAttempt, outcome: "success" })).toBe(false);
    expect(fixture.settle({ ownerId: fixture.state.ownerId, ...firstAttempt, outcome: "success" })).toBe(false);
    expect(fixture.settle({ ownerId: fixture.state.ownerId, ...currentAttempt, token: firstAttempt.token, outcome: "success" })).toBe(false);
    expect(fixture.settle({ ownerId: fixture.state.ownerId, ...currentAttempt, outcome: "success" })).toBe(true);
    const accepted = await second;
    await expect(fixture.beginArtifactStorageCleanup(required(firstAttempt.token), [draftSha256])).rejects.toThrow("eligible");
    await expect(fixture.beginArtifactStorageCleanup(accepted.token, ["b".repeat(64)])).rejects.toThrow("draft changed");
    expect(fixture.state.cleanupRequests).toBe(0);
    const job = await fixture.beginArtifactStorageCleanup(accepted.token, [draftSha256]);
    const progress = fixture.getArtifactStorageCleanup(job.maintenanceId);
    const progressAttempt = required(fixture.state.pending);
    const progressRetired = expect(progress).rejects.toThrow("owner retired");
    fixture.cancelPending();
    await progressRetired;
    expect(fixture.settle({ ownerId: fixture.state.ownerId, ...progressAttempt, outcome: "completed" })).toBe(false);
    const replacement = new VisualArtifactStorageFixture();
    const replacementScan = replacement.scanArtifactStorage([draftSha256]);
    const replacementAttempt = required(replacement.state.pending);
    expect(replacement.settle({ ownerId: fixture.state.ownerId, ...replacementAttempt, outcome: "success" })).toBe(false);
    expect(replacement.settle({ ownerId: replacement.state.ownerId, ...replacementAttempt, outcome: "success" })).toBe(true);
    await replacementScan;

    await renderHarness();
    await click(button("Check health"));
    const mounted = state();
    const pending = required(mounted.pending);
    await act(async () => root?.unmount());
    root = undefined;
    expect(document.documentElement.dataset.harnessArtifactStorageState).toBeUndefined();
    window.dispatchEvent(new CustomEvent(VISUAL_ARTIFACT_STORAGE_SETTLE_EVENT, {
      detail: { ownerId: mounted.ownerId, ...pending, outcome: "healthy" }
    }));
    expect(document.documentElement.dataset.harnessArtifactStorageState).toBeUndefined();
  });
});

async function renderHarness(): Promise<void> {
  await Promise.all([import("../components/SessionPane.js"), import("../components/SettingsPage.js")]);
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => { root?.render(<VisualHarness />); await wait(100); });
  await act(async () => wait(40));
}
function state(): VisualArtifactStorageState {
  return JSON.parse(required(document.documentElement.dataset.harnessArtifactStorageState)) as VisualArtifactStorageState;
}
function button(label: string): HTMLButtonElement {
  return required([...document.querySelectorAll<HTMLButtonElement>("button")].find((value) => value.textContent?.trim() === label
    || value.getAttribute("aria-label") === label));
}
async function click(control: HTMLButtonElement): Promise<void> {
  await act(async () => { control.click(); await wait(35); });
}
async function settle(outcome: "healthy" | "failure" | "warning" | "success" | "completed", attempt = required(state().pending)): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(VISUAL_ARTIFACT_STORAGE_SETTLE_EVENT, {
      detail: { ownerId: state().ownerId, ...attempt, outcome }
    }));
    await wait(35);
  });
}
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Expected the Artifact storage fixture control to exist.");
  return value;
}
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

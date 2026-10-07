// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisualHarness } from "./VisualHarness.js";
import { VisualHistoryMaintenanceFixture, VISUAL_HISTORY_MAINTENANCE_SETTLE_EVENT,
  type VisualHistoryMaintenanceState } from "./VisualHistoryMaintenanceFixture.js";

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/__visual-harness__?scenario=maintenance&theme=light#/settings/about");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((media: string) => ({
    matches: false, media, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => true)
  })) });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
  delete document.documentElement.dataset.harnessHistoryMaintenanceState;
  delete document.documentElement.dataset.harnessLastAction;
  delete document.documentElement.dataset.visualHarness;
  delete document.documentElement.dataset.theme;
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.restoreAllMocks();
});

describe("Task history maintenance visual harness", () => {
  it("presents typed scan failure, explicit retry, exact cleanup cancellation and completion through the real About card", async () => {
    await renderHarness();
    expect(state()).toMatchObject({ phase: "ready", scanRequests: 0, cleanupRequests: 0 });
    expect(button("Clean tasks not updated for more than").textContent).toContain("7 days");
    const active = button("Clean active task history");
    const backup = button("Back up the database before cleanup");
    expect(active.getAttribute("aria-checked")).toBe("false");
    expect(backup.getAttribute("aria-checked")).toBe("true");
    await click(active);
    expect(document.body.textContent).toContain("Include active tasks in database cleanup?");
    await act(async () => wait(40));
    expect(document.activeElement?.textContent).toBe("Include active tasks");
    await click(button("Keep active tasks"));
    expect(active.getAttribute("aria-checked")).toBe("false");

    const scan = button("Scan database");
    await click(scan);
    const failedAttempt = required(state().pending);
    expect(state()).toMatchObject({ phase: "scanning", scanRequests: 1, pending: { kind: "scan" } });
    expect(document.body.textContent).toContain("Scanning the database");
    expect(document.querySelector(".task-history-card")?.getAttribute("aria-busy")).toBe("true");
    expect(scan.disabled).toBe(true);
    await click(scan);
    expect(state().scanRequests).toBe(1);
    await settle("failure");
    expect(document.body.textContent).toContain("The task history database could not be scanned. Try again.");
    expect(scan.disabled).toBe(false);
    expect(backup.getAttribute("aria-checked")).toBe("true");

    await click(scan);
    await settle("success", failedAttempt);
    expect(state()).toMatchObject({ phase: "scanning", scanRequests: 2, failedScans: 1 });
    await settle("success");
    const firstScanId = required(state().scan).scanId;
    expect(state()).toMatchObject({ phase: "report", scan: { retention: "7-days", includeActiveTasks: false } });
    expect(document.body.textContent).toContain("2 soft-deleted tasks and 3 archived tasks");
    expect(document.body.textContent).toContain("17 messages");
    expect(document.querySelector(".task-history-report")?.textContent).toContain("8.0 KB");
    expect(document.querySelector(".task-history-report")?.textContent).toContain("16 KB");
    expect(document.body.textContent).toContain("Files, attachments, generated media, and Artifacts on disk are not deleted");
    await act(async () => wait(40));
    expect(document.activeElement?.textContent).toBe("Confirm database cleanup");
    await click(button("Confirm database cleanup"));
    expect(state()).toMatchObject({ phase: "running", cleanupRequests: 1,
      cleanup: { scanId: firstScanId, backupEnabled: true, status: "running", percent: 60, cancellable: true } });
    expect(document.querySelector<HTMLProgressElement>('.task-history-modal progress[value="60"]')).not.toBeNull();
    await act(async () => wait(300));
    const cancelledAttempt = required(state().pending);
    expect(cancelledAttempt.kind).toBe("progress");
    await click(button("Cancel cleanup"));
    expect(state()).toMatchObject({ phase: "cancelled", cancelRequests: 1, cleanup: { status: "cancelled" } });
    expect(state().pending).toBeUndefined();
    expect(document.body.textContent).toContain("Database cleanup was cancelled. The original database remains active.");
    await settle("completed", cancelledAttempt);
    expect(state().completedCleanups).toBe(0);

    await click(scan);
    await settle("success");
    const secondScanId = required(state().scan).scanId;
    expect(secondScanId).not.toBe(firstScanId);
    await click(button("Confirm database cleanup"));
    await act(async () => wait(300));
    expect(state()).toMatchObject({ phase: "running", cleanupRequests: 2, pending: { kind: "progress", scanId: secondScanId } });
    await settle("completed", cancelledAttempt);
    expect(state().phase).toBe("running");
    await settle("completed");
    expect(state()).toMatchObject({ phase: "completed", scanRequests: 3, cleanupRequests: 2, cancelRequests: 1,
      failedScans: 1, completedCleanups: 1, cleanup: { status: "completed", percent: 100, backupEnabled: true } });
    expect(document.body.textContent).toContain("Database cleanup completed");
    expect(document.body.textContent).toContain("Removed 17 messages from 5 tasks and reclaimed 2.0 KB");
    expect(document.body.textContent).toContain("latest cleanup backup");

    await click(scan);
    await settle("insufficient-space");
    expect(document.body.textContent).toContain("not enough disk space");
    expect(button("Confirm database cleanup").disabled).toBe(true);
    await click(button("Confirm database cleanup"));
    expect(state().cleanupRequests).toBe(2);
    await click(button("Cancel"));
    expect(document.querySelector(".task-history-modal")).toBeNull();
  }, 15_000);

  it("retires old owner, scan and progress attempts without letting a disposed listener settle new work", async () => {
    const fixture = new VisualHistoryMaintenanceFixture();
    const first = fixture.scanTaskHistory("7-days", false);
    const firstAttempt = required(fixture.state.pending);
    const retired = expect(first).rejects.toThrow("owner retired");
    fixture.cancelPending();
    await retired;
    expect(fixture.settle({ ownerId: fixture.state.ownerId, ...firstAttempt, outcome: "success" })).toBe(false);
    const second = fixture.scanTaskHistory("7-days", false);
    const currentAttempt = required(fixture.state.pending);
    expect(fixture.settle({ ownerId: "retired-owner", ...currentAttempt, outcome: "success" })).toBe(false);
    expect(fixture.settle({ ownerId: fixture.state.ownerId, ...firstAttempt, outcome: "success" })).toBe(false);
    expect(fixture.settle({ ownerId: fixture.state.ownerId, ...currentAttempt, scanId: firstAttempt.scanId, outcome: "success" })).toBe(false);
    expect(fixture.settle({ ownerId: fixture.state.ownerId, ...currentAttempt, outcome: "success" })).toBe(true);
    const scan = await second;
    await expect(fixture.beginTaskHistoryCleanup(firstAttempt.scanId, true)).rejects.toThrow("eligible");
    const job = await fixture.beginTaskHistoryCleanup(scan.scanId, true);
    const progress = fixture.getTaskHistoryCleanup(job.maintenanceId);
    const progressAttempt = required(fixture.state.pending);
    const progressRetired = expect(progress).rejects.toThrow("owner retired");
    fixture.cancelPending();
    await progressRetired;
    expect(fixture.settle({ ownerId: fixture.state.ownerId, ...progressAttempt, outcome: "completed" })).toBe(false);
    const replacement = new VisualHistoryMaintenanceFixture();
    const replacementScan = replacement.scanTaskHistory("7-days", false);
    const replacementAttempt = required(replacement.state.pending);
    expect(replacement.settle({ ownerId: fixture.state.ownerId, ...replacementAttempt, outcome: "success" })).toBe(false);
    expect(replacement.settle({ ownerId: replacement.state.ownerId, ...replacementAttempt, outcome: "success" })).toBe(true);
    await replacementScan;

    await renderHarness();
    await click(button("Scan database"));
    const mounted = state();
    const pending = required(mounted.pending);
    await act(async () => root?.unmount());
    root = undefined;
    expect(document.documentElement.dataset.harnessHistoryMaintenanceState).toBeUndefined();
    window.dispatchEvent(new CustomEvent(VISUAL_HISTORY_MAINTENANCE_SETTLE_EVENT, {
      detail: { ownerId: mounted.ownerId, ...pending, outcome: "success" }
    }));
    expect(document.documentElement.dataset.harnessHistoryMaintenanceState).toBeUndefined();
  });
});

async function renderHarness(): Promise<void> {
  await Promise.all([import("../components/SessionPane.js"), import("../components/SettingsPage.js")]);
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => { root?.render(<VisualHarness />); await wait(100); });
}
function state(): VisualHistoryMaintenanceState {
  return JSON.parse(required(document.documentElement.dataset.harnessHistoryMaintenanceState)) as VisualHistoryMaintenanceState;
}
function button(label: string): HTMLButtonElement {
  return required([...document.querySelectorAll<HTMLButtonElement>("button")].find((value) => value.textContent?.trim() === label
    || value.getAttribute("aria-label") === label));
}
async function click(control: HTMLButtonElement): Promise<void> {
  await act(async () => { control.click(); await wait(35); });
}
async function settle(outcome: "failure" | "success" | "insufficient-space" | "completed", attempt = required(state().pending)): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(VISUAL_HISTORY_MAINTENANCE_SETTLE_EVENT, {
      detail: { ownerId: state().ownerId, ...attempt, outcome }
    }));
    await wait(35);
  });
}
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Expected the history maintenance fixture control to exist.");
  return value;
}
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

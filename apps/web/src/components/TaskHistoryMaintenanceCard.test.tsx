// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { TaskHistoryMaintenanceCard } from "./SettingsPage.js";

const roots: Root[] = [];
const SCAN_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("TaskHistoryMaintenanceCard", () => {
  it("uses safe defaults, presents the scan report, and executes the exact accepted scan", async () => {
    const scanTaskHistory = vi.fn(async () => scan());
    const cleanupResult = {
      outcome: "completed" as const,
      activeTaskCount: 0,
      deletedTaskCount: 2,
      archivedTaskCount: 3,
      messageCount: 17,
      beforeBytes: 4_096,
      afterBytes: 2_048,
      reclaimedBytes: 2_048,
      backupCreated: true,
      skippedTaskCount: 1
    };
    const beginTaskHistoryCleanup = vi.fn(async () => ({
      maintenanceId: "22222222-2222-4222-8222-222222222222",
      status: "completed" as const,
      phase: "installing" as const,
      percent: 100,
      cancellable: false as const,
      updatedAt: Date.now(),
      result: cleanupResult
    }));
    const container = await render({
      getTaskHistoryMaintenanceSupport: vi.fn(async () => ({ supported: true })),
      scanTaskHistory,
      beginTaskHistoryCleanup
    });

    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Clean tasks not updated for more than")));
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Back up the database before cleanup"]')?.getAttribute("aria-checked"))
      .toBe("true");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Clean tasks not updated for more than"]')?.textContent)
      .toContain("7 days");

    await clickButton(container, "Scan database");
    await act(async () => vi.waitFor(() => expect(scanTaskHistory).toHaveBeenCalledWith("7-days", false)));
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Database scan results")));
    expect(container.textContent).toContain("2 soft-deleted tasks and 3 archived tasks");
    expect(container.textContent).toContain("17 messages");
    expect(container.textContent).toContain("Files, attachments, generated media, and Artifacts on disk are not deleted");
    expect(document.activeElement?.textContent).toBe("Confirm database cleanup");

    await clickButton(container, "Confirm database cleanup");
    await act(async () => vi.waitFor(() => expect(beginTaskHistoryCleanup).toHaveBeenCalledWith(SCAN_ID, true)));
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Database cleanup completed")));
    expect(container.textContent).toContain("Removed 17 messages from 5 tasks and reclaimed 2.0 KB");
    expect(container.textContent).toContain("latest cleanup backup");
  });

  it("requires an explicit, focused confirmation before active tasks enter the scan", async () => {
    const scanTaskHistory = vi.fn(async () => scan({ includeActiveTasks: true, activeTaskCount: 1 }));
    const container = await render({
      getTaskHistoryMaintenanceSupport: vi.fn(async () => ({ supported: true })),
      scanTaskHistory
    });
    await act(async () => vi.waitFor(() => expect(container.querySelector('[aria-label="Clean active task history"]')).not.toBeNull()));

    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Clean active task history"]')!;
    await act(async () => toggle.click());
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Include active tasks in database cleanup?")));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement?.textContent).toBe("Include active tasks");
    await clickButton(container, "Keep active tasks");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await act(async () => toggle.click());
    await clickButton(container, "Include active tasks");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await clickButton(container, "Scan database");
    await act(async () => vi.waitFor(() => expect(scanTaskHistory).toHaveBeenCalledWith("7-days", true)));
  });

  it("blocks cleanup when the database volume cannot hold the working copy", async () => {
    const beginTaskHistoryCleanup = vi.fn();
    const container = await render({
      getTaskHistoryMaintenanceSupport: vi.fn(async () => ({ supported: true })),
      scanTaskHistory: vi.fn(async () => scan({ databaseVolumeFreeBytes: 100, temporaryBytesRequired: 200 })),
      beginTaskHistoryCleanup
    });
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Scan database")));
    await clickButton(container, "Scan database");
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("not enough disk space")));
    const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Confirm database cleanup");
    expect(confirm?.disabled).toBe(true);
    expect(beginTaskHistoryCleanup).not.toHaveBeenCalled();
  });

  it("shows worker progress and offers cancellation only while replacement is still safe", async () => {
    const maintenanceId = "33333333-3333-4333-8333-333333333333";
    const cancelled = {
      maintenanceId,
      status: "cancelled" as const,
      phase: "compacting" as const,
      percent: 60,
      cancellable: false as const,
      updatedAt: Date.now()
    };
    const cancelTaskHistoryCleanup = vi.fn(async () => cancelled);
    const container = await render({
      getTaskHistoryMaintenanceSupport: vi.fn(async () => ({ supported: true })),
      scanTaskHistory: vi.fn(async () => scan()),
      beginTaskHistoryCleanup: vi.fn(async () => ({
        maintenanceId,
        status: "running" as const,
        phase: "compacting" as const,
        percent: 60,
        cancellable: true,
        updatedAt: Date.now()
      })),
      getTaskHistoryCleanup: vi.fn(async () => cancelled),
      cancelTaskHistoryCleanup
    });
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Scan database")));
    await clickButton(container, "Scan database");
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Database scan results")));
    await clickButton(container, "Confirm database cleanup");
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Compacting database · 60%")));
    expect(container.querySelector<HTMLProgressElement>('progress[value="60"]')).not.toBeNull();

    await clickButton(container, "Cancel cleanup");
    expect(cancelTaskHistoryCleanup).toHaveBeenCalledWith(maintenanceId);
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("original database remains active")));
  });
});

async function render(methods: Partial<AppController>): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<TaskHistoryMaintenanceCard
    controller={methods as AppController}
    t={(key, values) => translate("en", key, values)}
  />));
  return container;
}

function scan(overrides: Partial<Awaited<ReturnType<AppController["scanTaskHistory"]>>> = {}) {
  return {
    scanId: SCAN_ID,
    retention: "7-days" as const,
    includeActiveTasks: false,
    scannedAt: Date.now(),
    olderThan: Date.now() - 7 * 24 * 60 * 60_000,
    expiresAt: Date.now() + 60_000,
    activeTaskCount: 0,
    deletedTaskCount: 2,
    archivedTaskCount: 3,
    messageCount: 17,
    estimatedHistoryBytes: 1_024,
    databaseBytes: 4_096,
    temporaryBytesRequired: 8_192,
    databaseVolumeFreeBytes: 16_384,
    ...overrides
  };
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`Button not found: ${label}`);
  await act(async () => button.click());
}

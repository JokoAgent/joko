// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleRunHistoryView, ScheduleView } from "../model.js";
import { translate } from "../i18n.js";
import {
  dismissScheduleFailure,
  scheduleFailureDismissalPrefix
} from "../schedule-failure-dismissal.js";
import { SessionScheduleNotice } from "./SessionScheduleNotice.js";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("session automation history attention", () => {
  it("marks linked terminal records read without removing the failure, and scopes dismissal to the exact failure and owner", async () => {
    const markRead = vi.fn(async () => undefined);
    const failed = run("failure-1");
    await render("owner-1", [failed, run("other", { sessionId: "other-task" }), run("active", { state: "running" })], markRead);
    expect(markRead).toHaveBeenCalledExactlyOnceWith("schedule", "failure-1");
    expect(host.textContent).toContain("Scheduled command failed");
    await render("owner-1", [{ ...failed, readAt: 5 }], markRead);
    expect(host.textContent).toContain("Scheduled command failed");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')?.click());
    expect(host.textContent).not.toContain("Scheduled command failed");
    await render("owner-1", [run("failure-2", { finishedAt: 8 })], markRead);
    expect(host.textContent).toContain("Scheduled command failed");
    await render("owner-2", [failed], markRead);
    expect(host.textContent).toContain("Scheduled command failed");
  });

  it("keeps an exact dismissal across remount and shows a newer failure", async () => {
    const markRead = vi.fn(async () => undefined);
    await render("owner-reload", [run("failure-1")], markRead);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
    expect(host.textContent).not.toContain("Scheduled command failed");

    await act(async () => root.unmount());
    root = createRoot(host);
    await render("owner-reload", [run("failure-1")], markRead);
    expect(host.textContent).not.toContain("Scheduled command failed");
    await render("owner-reload", [run("failure-2", { finishedAt: 4 })], markRead);
    expect(host.textContent).toContain("Scheduled command failed");
  });

  it("uses the rendered document storage realm and converges on storage events", async () => {
    const frame = document.body.appendChild(document.createElement("iframe"));
    const frameWindow = frame.contentWindow!;
    const frameDocument = frame.contentDocument!;
    const frameHost = frameDocument.body.appendChild(frameDocument.createElement("div"));
    const frameRoot = createRoot(frameHost);
    vi.spyOn(frameDocument, "hasFocus").mockReturnValue(false);
    const failure = run("failure-frame");
    await act(async () => frameRoot.render(<SessionScheduleNotice
      ownerId="owner-frame"
      sessionId="task"
      schedules={[schedule("schedule", [failure])]}
      markRead={vi.fn(async () => undefined)}
      t={(key, values) => translate("en", key, values)}
    />));
    expect(frameHost.textContent).toContain("Scheduled command failed");

    const prefix = scheduleFailureDismissalPrefix("owner-frame", "task");
    dismissScheduleFailure(frameWindow.localStorage, prefix, {
      completedAt: failure.finishedAt!,
      scheduleId: "schedule",
      runId: failure.runId,
      triggerId: failure.id
    });
    const key = Array.from({ length: frameWindow.localStorage.length }, (_, index) => frameWindow.localStorage.key(index))
      .find((candidate) => candidate?.startsWith(prefix));
    const FrameStorageEvent = (frameWindow as Window & typeof globalThis).StorageEvent;
    await act(async () => frameWindow.dispatchEvent(new FrameStorageEvent("storage", {
      key,
      storageArea: frameWindow.localStorage
    })));
    expect(frameHost.textContent).not.toContain("Scheduled command failed");

    await act(async () => frameRoot.unmount());
    frame.remove();
  });

  it("hides the current instance when dismissal storage is unavailable", async () => {
    const markRead = vi.fn(async () => undefined);
    await render("owner-storage-fault", [run("failure-storage")], markRead);
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("quota"); });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
    expect(host.textContent).not.toContain("Scheduled command failed");
    expect(markRead).toHaveBeenCalledExactlyOnceWith("schedule", "failure-storage");
  });

  it("selects the newest failure by time, schedule, run and trigger identity", async () => {
    const sameTime = { finishedAt: 10 };
    await renderSchedules("owner-order", [
      schedule("schedule-a", [run("trigger-z", { ...sameTime, runId: "run-z", error: "older schedule" })]),
      schedule("schedule-b", [run("trigger-a", { ...sameTime, runId: "run-a", error: "newer schedule" })])
    ], vi.fn(async () => undefined));
    expect(host.textContent).toContain("newer schedule");
    expect(host.textContent).not.toContain("older schedule");

    await renderSchedules("owner-order", [schedule("schedule-b", [
      run("trigger-a", { ...sameTime, runId: "run-z", error: "older trigger" }),
      run("trigger-z", { ...sameTime, runId: "run-z", error: "newer trigger" })
    ])], vi.fn(async () => undefined));
    expect(host.textContent).toContain("newer trigger");
    expect(host.textContent).not.toContain("older trigger");
  });

  it("does not acknowledge a background window and keeps a failed receipt retryable", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    const markRead = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    await render("owner-background", [run("failure-background")], markRead);
    expect(markRead).not.toHaveBeenCalled();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(markRead).toHaveBeenCalledTimes(1);
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Mark run as read");
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(markRead).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Scheduled command failed");
  });
});

async function render(ownerId: string, history: readonly ScheduleRunHistoryView[], markRead: (scheduleId: string, triggerId: string) => Promise<void>): Promise<void> {
  await renderSchedules(ownerId, [schedule("schedule", history)], markRead);
}
async function renderSchedules(ownerId: string, schedules: readonly ScheduleView[], markRead: (scheduleId: string, triggerId: string) => Promise<void>): Promise<void> {
  await act(async () => root.render(<SessionScheduleNotice ownerId={ownerId} sessionId="task" schedules={schedules} markRead={markRead} t={(key, values) => translate("en", key, values)} />));
}
function schedule(id: string, history: readonly ScheduleRunHistoryView[]): ScheduleView {
  return { id, name: `Schedule ${id}`, history } as ScheduleView;
}
function run(id: string, patch: Partial<ScheduleRunHistoryView> = {}): ScheduleRunHistoryView {
  return { id, runId: id, sessionId: "task", state: "failed", scheduledAt: 1, triggeredAt: 2, finishedAt: 3, error: "Scheduled command failed", zeroCost: true, costAttribution: "zero", ...patch };
}

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleRunHistoryView, ScheduleView } from "../model.js";
import { translate } from "../i18n.js";
import { SessionScheduleNotice } from "./SessionScheduleNotice.js";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  await act(async () => root.render(<SessionScheduleNotice ownerId={ownerId} sessionId="task" schedules={[{ id: "schedule", name: "Nightly", history } as ScheduleView]} markRead={markRead} t={(key, values) => translate("en", key, values)} />));
}
function run(id: string, patch: Partial<ScheduleRunHistoryView> = {}): ScheduleRunHistoryView {
  return { id, runId: id, sessionId: "task", state: "failed", scheduledAt: 1, triggeredAt: 2, finishedAt: 3, error: "Scheduled command failed", zeroCost: true, costAttribution: "zero", ...patch };
}

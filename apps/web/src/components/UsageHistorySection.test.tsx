// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { UsageHistorySummaryView, UsageReportEntryView, UsageReportView } from "../model.js";
import { UsageHistoryContent } from "./UsageHistorySection.js";
import { VisualUsageHistoryFixture } from "../dev/VisualUsageHistoryFixture.js";

const roots: Root[] = [];
const t = (key: string) => key;
type ReportApi = AppController["getUsageReport"];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("usage history requests and filters", () => {
  it.each(["rows", "empty"])("keeps a focused Retry and its error while pending, then focuses the successful %s result", async (kind) => {
    const response = deferred<UsageReportView>();
    const api = vi.fn<ReportApi>().mockRejectedValueOnce(new Error("Report unavailable"))
      .mockImplementationOnce(() => response.promise);
    const view = await mount(api);
    const retry = button(view.host, "common.retry");
    await act(async () => { retry.focus(); retry.click(); });
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Report unavailable");
    expect(retry.isConnected).toBe(true);
    expect(retry.disabled).toBe(false);
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(retry);
    await act(async () => retry.click());
    expect(api).toHaveBeenCalledTimes(2);
    await act(async () => response.resolve(report(kind === "rows" ? [entry("recovered")] : [])));
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    expect(document.activeElement).toBe(view.host.querySelector(kind === "rows" ? "summary" : ".usage-history-scope"));
  });

  it("shows the visual fixture's first real failure under StrictMode and recovers only on Retry", async () => {
    const fixture = new VisualUsageHistoryFixture("error");
    const view = await mount(fixture.getUsageReport, true);
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("temporarily unavailable");
    expect(rows(view.host)).toHaveLength(0);
    await click(view.host, "common.retry");
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    expect(view.host.querySelector(".usage-history-summary")).not.toBeNull();
  });

  it("moves the focused final-page trigger to the first new disclosure and preserves earlier expansion", async () => {
    const page = deferred<UsageReportView>();
    const api = vi.fn<ReportApi>().mockResolvedValueOnce(report([entry("first")], "last-page"))
      .mockImplementationOnce(() => page.promise);
    const view = await mount(api);
    const first = view.host.querySelector("summary")!;
    await act(async () => first.click());
    const more = button(view.host, "common.more");
    await act(async () => { more.focus(); more.click(); });
    expect(more.disabled).toBe(false);
    expect(more.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(more);
    await act(async () => page.resolve(report([entry("second"), entry("third")])));
    expect(view.host.contains(more)).toBe(false);
    expect(document.activeElement).toBe(view.host.querySelectorAll("summary")[1]);
    expect(view.host.querySelector("details")?.open).toBe(true);
  });

  it.each([["more", "moved"], ["more", "disconnected"], ["more", "replaced"], ["retry", "moved"], ["retry", "replaced"]])("does not reclaim %s focus after its owner is %s", async (action, change) => {
    const page = deferred<UsageReportView>();
    const api = vi.fn<ReportApi>();
    if (action === "more") api.mockResolvedValueOnce(report([entry("first")], "last-page"));
    else api.mockRejectedValueOnce(new Error("Report unavailable"));
    api.mockImplementationOnce(() => page.promise);
    const view = await mount(api);
    const trigger = button(view.host, action === "more" ? "common.more" : "common.retry");
    await act(async () => { trigger.focus(); trigger.click(); });
    const other = document.body.appendChild(document.createElement("button"));
    other.textContent = "Another control";
    if (change === "disconnected") await view.render(api, false);
    if (change === "replaced") await view.render(vi.fn<ReportApi>().mockResolvedValue(report([entry("new-source")])), true);
    other.focus();
    await act(async () => page.resolve(report([entry("late")])));
    expect(document.activeElement).toBe(other);
    if (change !== "moved") expect(view.host.textContent).not.toContain("Task late");
  });

  it("replaces a reconnected cursor page while keeping earlier disclosures and their focus", async () => {
    const first = entry("first"); const second = entry("second");
    const api = vi.fn<ReportApi>().mockResolvedValueOnce(report([first], "page-two"))
      .mockResolvedValueOnce(report([second], "page-three"))
      .mockResolvedValueOnce(report([{ ...second, title: "Second refreshed" }], "page-three"));
    const view = await mount(api);
    const summary = view.host.querySelector("summary")!;
    await act(async () => { summary.focus(); summary.click(); });
    expect(summary.tabIndex).toBe(0);
    expect(document.activeElement).toBe(summary);
    expect(view.host.querySelector("details")?.open).toBe(true);
    await click(view.host, "common.more");
    expect(rows(view.host)).toHaveLength(2);
    await view.render(api, false);
    expect(button(view.host, "common.more").disabled).toBe(true);
    await view.render(api, true);
    expect(api.mock.calls.at(-1)?.[0]).toMatchObject({ pageToken: "page-two" });
    expect(rows(view.host)).toHaveLength(2);
    expect(view.host.textContent).toContain("Second refreshed");
    expect(view.host.querySelector("summary")).toBe(summary);
    expect(document.activeElement).toBe(summary);
    expect(view.host.querySelector("details")?.open).toBe(true);
  });

  it("keeps the last successful grouping and range after a failed filter request and retries the requested filters", async () => {
    const api = vi.fn<ReportApi>().mockResolvedValueOnce(report([entry("first")], "next-old"))
      .mockRejectedValueOnce(new Error("Report temporarily unavailable"))
      .mockResolvedValueOnce(report([{ ...entry("provider-row"), title: "Unused task title", providerId: "chosen-provider" }]));
    const view = await mount(api);
    await change(field<HTMLSelectElement>(view.host, "usage.report.group"), "provider");
    await change(field<HTMLInputElement>(view.host, "usage.report.providerId"), "chosen-provider");
    await change(field<HTMLSelectElement>(view.host, "usage.report.range"), "all");
    expect(api).toHaveBeenCalledTimes(1);
    expect(view.host.textContent).toContain("usage.report.pendingFilters");
    await click(view.host, "usage.report.apply");
    expect(api.mock.calls.at(-1)?.[0]).toEqual({ group: "provider", providerId: "chosen-provider" });
    expect(view.host.textContent).toContain("usage.report.previousResult");
    expect(view.host.querySelector("summary strong")?.textContent).toBe("Task first");
    expect(view.host.querySelector(".usage-history-scope")?.textContent).toContain("usage.report.group.task");
    expect(view.host.querySelector(".usage-history-scope")?.textContent).not.toContain("chosen-provider");
    expect(button(view.host, "common.more").disabled).toBe(true);
    expect(field<HTMLInputElement>(view.host, "usage.report.providerId").value).toBe("chosen-provider");
    await click(view.host, "common.retry");
    expect(api.mock.calls.at(-1)?.[0]).toEqual({ group: "provider", providerId: "chosen-provider" });
    expect(view.host.querySelector("summary strong")?.textContent).toBe("chosen-provider");
    expect(view.host.textContent).not.toContain("usage.report.previousResult");
    expect(view.host.querySelector(".usage-history-scope")?.textContent).toContain("usage.report.range.all");
  });

  it("rejects reversed custom dates without discarding edits, and uses canonical task links with unavailable references explained", async () => {
    const api = vi.fn<ReportApi>().mockResolvedValue(report([entry("task/one"), { ...entry("removed"), referenceAvailable: false }]));
    const view = await mount(api);
    expect(view.host.querySelector("a")?.getAttribute("href")).toBe("#/tasks/task%2Fone");
    expect(view.host.querySelectorAll("a")).toHaveLength(1);
    expect(view.host.textContent).toContain("usage.report.taskUnavailable");
    await change(field<HTMLSelectElement>(view.host, "usage.report.range"), "custom");
    await change(field<HTMLInputElement>(view.host, "usage.report.from"), "2026-09-10");
    await change(field<HTMLInputElement>(view.host, "usage.report.through"), "2026-09-01");
    expect(button(view.host, "usage.report.apply").disabled).toBe(true);
    expect(field<HTMLInputElement>(view.host, "usage.report.from").getAttribute("aria-invalid")).toBe("true");
    expect(view.host.textContent).toContain("usage.report.invalidRange");
    await act(async () => view.host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(api).toHaveBeenCalledTimes(1);
    await change(field<HTMLInputElement>(view.host, "usage.report.through"), "2026-09-12");
    await click(view.host, "usage.report.apply");
    expect(api.mock.calls.at(-1)?.[0]).toEqual({ group: "task", fromDay: "2026-09-10", throughDay: "2026-09-12" });
    await view.render(api, false);
    expect(button(view.host, "usage.report.reset").disabled).toBe(true);
    expect(field<HTMLInputElement>(view.host, "usage.report.from").value).toBe("2026-09-10");
  });

  it("retires old requests and cursors across API changes and keeps same-source rows after a failed refresh", async () => {
    const late = deferred<UsageReportView>();
    const firstApi = vi.fn<ReportApi>().mockResolvedValueOnce(report([entry("old-first")], "old-page"))
      .mockImplementationOnce(() => late.promise);
    const newRequest = deferred<UsageReportView>();
    const secondApi = vi.fn<ReportApi>().mockImplementationOnce(() => newRequest.promise)
      .mockRejectedValueOnce(new Error("Refresh failed"));
    const view = await mount(firstApi);
    await click(view.host, "common.more");
    const oldSignal = firstApi.mock.calls.at(-1)![1];
    await view.render(secondApi, true);
    expect(oldSignal.aborted).toBe(true);
    expect(secondApi.mock.calls[0]?.[0].pageToken).toBeUndefined();
    expect(rows(view.host)).toHaveLength(0);
    await act(async () => late.resolve(report([entry("late-old")])));
    expect(rows(view.host)).toHaveLength(0);
    await act(async () => newRequest.resolve(report([entry("new-node")])));
    expect(rows(view.host)).toHaveLength(1);
    expect(view.host.textContent).not.toContain("old-first");
    await click(view.host, "usage.refresh");
    expect(view.host.textContent).toContain("Task new-node");
    expect(view.host.textContent).toContain("Refresh failed");
  });
});

async function mount(api: ReportApi, strict = false) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root);
  const render = async (nextApi: ReportApi, connected: boolean) => act(async () => {
    const content = <UsageHistoryContent api={nextApi} connected={connected} locale="en" t={t} />;
    root.render(strict ? <StrictMode>{content}</StrictMode> : content);
  });
  await render(api, true);
  return { host, render };
}

function rows(host: ParentNode) { return [...host.querySelectorAll("details")]; }
function button(host: ParentNode, label: string): HTMLButtonElement { return [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!; }
async function click(host: ParentNode, label: string) { await act(async () => button(host, label).click()); }
function field<T extends HTMLInputElement | HTMLSelectElement>(host: ParentNode, label: string): T {
  return [...host.querySelectorAll("label")].find((candidate) => candidate.firstChild?.textContent === label)!.querySelector<T>("input,select")!;
}
async function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(input.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
const summary: UsageHistorySummaryView = { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5, totalTokens: 135, costMicros: 0, currencyCode: "USD" }, currencyTotals: [], costComplete: false, estimated: false };
function entry(key: string): UsageReportEntryView { return { key, sessionId: key, backendId: "backend", providerId: "provider", modelId: "model", title: `Task ${key}`, referenceAvailable: true, summary, measuredAt: Date.UTC(2026, 8, 9, 4) }; }
function report(entries: readonly UsageReportEntryView[], nextPageToken = ""): UsageReportView { return { entries, nextPageToken, summary, totalGroups: 3 }; }

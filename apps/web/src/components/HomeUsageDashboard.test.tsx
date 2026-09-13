// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { UsageHistoryView, UsageTokensView } from "../model.js";
import { readUsageDashboardPreference, resetUsageDashboardPreferencesForTests } from "../usage-dashboard-preferences.js";
import { HomeUsageDashboard } from "./HomeUsageDashboard.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetUsageDashboardPreferencesForTests();
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  resetUsageDashboardPreferencesForTests();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("home usage dashboard", () => {
  it("renders the complete stable history surface and aborts refresh while collapsed", async () => {
    const signals: AbortSignal[] = [];
    const getUsageHistory = vi.fn(async (_days, _backend, _provider, signal?: AbortSignal) => {
      if (signal !== undefined) signals.push(signal);
      return history();
    });
    const controller = { getUsageHistory } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => root.render(<HomeUsageDashboard controller={controller} ownerId="owner-a" locale="en" t={(key, values) => translate("en", key, values)} />));
    await act(async () => Promise.resolve());

    expect(getUsageHistory).toHaveBeenCalledWith(140, "", "", expect.any(AbortSignal));
    expect(container.querySelectorAll(".usage-stat")).toHaveLength(5);
    expect(container.querySelectorAll(".usage-heatmap__cell")).toHaveLength(140);
    expect(container.querySelectorAll(".usage-daily-bars__day")).toHaveLength(30);
    expect(container.textContent).toContain("model-a");
    expect(container.textContent).toContain("backend-a · provider");
    expect(container.textContent).toContain("backend-b · provider");
    expect(container.textContent).toContain("Reported by provider");

    const collapse = required(container.querySelector<HTMLButtonElement>(".home-usage-dashboard__collapse"));
    await act(async () => collapse.click());

    expect(signals[0]?.aborted).toBe(true);
    expect(container.querySelector(".home-usage-dashboard__body")).toBeNull();
    expect(readUsageDashboardPreference("owner-a").collapsed).toBe(true);
    expect(readUsageDashboardPreference("owner-b").collapsed).toBe(false);
  });

  it("never adds different currencies and shows token-only cost when pricing is unknown", async () => {
    const value = history();
    const unknown = {
      ...value,
      today: { ...value.today, currencyTotals: [], costComplete: false, estimated: true },
      last30Days: {
        ...value.last30Days,
        currencyTotals: [currency("USD", 1_000_000), currency("CNY", 2_000_000)],
        costComplete: true
      }
    };
    const controller = { getUsageHistory: vi.fn(async () => unknown) } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<HomeUsageDashboard controller={controller} ownerId="owner" locale="en" t={(key, values) => translate("en", key, values)} />));
    await act(async () => Promise.resolve());

    const stats = container.querySelectorAll<HTMLElement>(".usage-stat");
    expect(stats[0]?.textContent).toContain("Tokens only");
    expect(stats[2]?.textContent).toContain("$1.00");
    expect(stats[2]?.textContent).toMatch(/CN¥2\.00|CNY\s*2\.00/u);
  });
});

function history(): UsageHistoryView {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  const days = Array.from({ length: 140 }, (_, index) => {
    const day = new Date(now.getTime() - (139 - index) * 86_400_000).toISOString().slice(0, 10);
    const usage = tokens(index + 1, index === 139 ? 1_000_000 : 0);
    return { day, usage, currencyTotals: usage.costMicros === 0 ? [] : [currency("USD", usage.costMicros)], costComplete: true, estimated: false };
  });
  const today = { usage: tokens(100, 1_000_000), currencyTotals: [currency("USD", 1_000_000)], costComplete: true, estimated: false };
  return {
    days,
    modelDaily: days.slice(-30).flatMap((day) => [
      { ...day, backendId: "backend-a", providerId: "provider", modelId: "model-a" },
      { ...day, backendId: "backend-b", providerId: "provider", modelId: "model-a" }
    ]),
    models: [
      { ...today, backendId: "backend-a", providerId: "provider", modelId: "model-a" },
      { ...today, backendId: "backend-b", providerId: "provider", modelId: "model-a" }
    ],
    today,
    last30Days: today,
    currentStreakDays: 3,
    longestStreakDays: 7,
    todayAnomalous: false,
    generatedAt: Date.now(),
    measuredAt: Date.now(),
    estimated: false
  };
}

function tokens(totalTokens: number, costMicros: number): UsageTokensView {
  return { inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens, costMicros, currencyCode: costMicros === 0 ? "" : "USD" };
}

function currency(currencyCode: string, costMicros: number) {
  return { currencyCode, usage: { ...tokens(100, costMicros), currencyCode }, costComplete: true, estimated: false } as const;
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected rendered value.");
  return value;
}

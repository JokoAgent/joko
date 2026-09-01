import { describe, expect, it } from "vitest";
import { formatCompactUsageTokens, formatMessageTurnCost, messageUsagePresentation } from "./message-usage.js";
import type { Translator } from "./types.js";

const t: Translator = (key, values) => {
  const entries = Object.entries(values ?? {}).map(([name, value]) => `${name}=${String(value)}`).join(",");
  return entries.length === 0 ? key : `${key}|${entries}`;
};

describe("message usage presentation", () => {
  it("uses the exact compact token units without leaving 1000 in the smaller unit", () => {
    expect(formatCompactUsageTokens(999)).toBe("999");
    expect(formatCompactUsageTokens(12_400)).toBe("12.4k");
    expect(formatCompactUsageTokens(999_999)).toBe("1.0M");
    expect(formatCompactUsageTokens(2_107_700)).toBe("2.1M");
    expect(formatCompactUsageTokens(9_290_698_420)).toBe("9.3B");
  });

  it("shows authoritative positive cost and complete token/cache detail", () => {
    const view = messageUsagePresentation({
      inputTokens: 12_400,
      outputTokens: 8_900,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 86_400,
      totalTokens: 2_107_700,
      cost: 0.042,
      currency: "USD"
    }, t);
    expect(view?.label).toBe("$0.04");
    expect(view?.tooltipLines).toEqual([
      "timeline.usageCostLine|cost=$0.04",
      "timeline.usageTokenLine|total=2.1M,input=12.4k,output=8.9k",
      "timeline.usageCacheLine|read=2.0M,write=86.4k,rate=95.3%"
    ]);
  });

  it("falls back to tokens and explains unavailable billed cost", () => {
    const view = messageUsagePresentation({
      inputTokens: 40_000,
      outputTokens: 10_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 15_000,
      totalTokens: 65_000,
      cost: 0,
      currency: "USD"
    }, t);
    expect(view?.label).toBe("timeline.usageTokens|tokens=65.0k");
    expect(view?.tooltipLines).toEqual([
      "timeline.usageTokenLine|total=65.0k,input=40.0k,output=10.0k",
      "timeline.usageCacheLine|read=0,write=15.0k,rate=0%",
      "timeline.usageSuggestionLine|suggestion=timeline.usageLowCacheSuggestion",
      "timeline.usageNoBilledCost"
    ]);
  });

  it("omits the meta cell when neither money nor usage is present", () => {
    expect(messageUsagePresentation(undefined, t)).toBeUndefined();
    expect(messageUsagePresentation({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, currency: "USD" }, t)).toBeUndefined();
  });

  it("retains a lower bound for sub-cent cost", () => {
    expect(formatMessageTurnCost(0.004, "USD")).toBe("<$0.01");
    expect(formatMessageTurnCost(1.5, "CNY")).toBe("¥1.50");
  });
});

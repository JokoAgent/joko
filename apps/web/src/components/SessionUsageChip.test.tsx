// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { translate } from "../i18n.js";
import type { UsageTokensView } from "../model.js";
import { SessionUsageChip } from "./SessionUsageChip.js";
import { formatKnownUsageCost, resolveSessionUsageDisplay } from "./session-usage.js";

describe("task usage display", () => {
  it("uses authoritative cumulative totals instead of context occupancy", () => {
    expect(resolveSessionUsageDisplay(usage(), false, "en")).toBeUndefined();
    expect(resolveSessionUsageDisplay(usage(), true, "en")).toMatchObject({
      totalTokens: 1_430_000,
      totalTokensText: "1.4M",
      costText: "$0.125"
    });
  });

  it("does not invent a cost without a positive amount and currency", () => {
    expect(formatKnownUsageCost(0, "USD", "en")).toBeUndefined();
    expect(formatKnownUsageCost(125_000, "", "en")).toBeUndefined();
    expect(formatKnownUsageCost(125_000, "USD", "en")).toBe("$0.125");
  });

  it("keeps unknown cost out of the chip while explaining it in the tooltip", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(
      <SessionUsageChip
        usage={{ ...usage(), costMicros: 0, currencyCode: "" }}
        supported
        locale="en"
        t={(key, values) => translate("en", key, values)}
      />
    ));

    expect(container.textContent).toBe("1.4M tok");
    expect(container.querySelector(".session-usage-chip")?.getAttribute("title")).toContain("Task cost is unavailable");
    expect(container.textContent).not.toContain("$0");
    await act(async () => root.unmount());
  });
});

function usage(): UsageTokensView {
  return {
    inputTokens: 1_000_000,
    outputTokens: 400_000,
    cacheReadTokens: 20_000,
    cacheWriteTokens: 10_000,
    totalTokens: 1_430_000,
    costMicros: 125_000,
    currencyCode: "USD"
  };
}

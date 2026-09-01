import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { translate } from "../i18n.js";
import { ContextCapacityRing, formatTokenCount, resolveDisplayContextWindow } from "./ContextCapacityRing.js";

describe("context capacity presentation", () => {
  it("formats visible capacity and resolves the strongest available window", () => {
    expect([999, 1_000, 1_250, 200_000, 1_000_000, 1_250_000].map(formatTokenCount))
      .toEqual(["999", "1K", "1.3K", "200K", "1M", "1.3M"]);
    expect(resolveDisplayContextWindow(200_000, 992_000)).toBe(992_000);
    expect(resolveDisplayContextWindow(1_000_000, 992_000)).toBe(1_000_000);
    expect(resolveDisplayContextWindow(0, 262_144)).toBe(262_144);
    expect(resolveDisplayContextWindow(0)).toBe(200_000);
  });

  it("distinguishes an unknown measurement from a measured live ratio", () => {
    const unknown = renderToStaticMarkup(
      <ContextCapacityRing
        modelContextWindow={200_000}
        t={(key, values) => translate("en", key, values)}
      />
    );
    const measured = renderToStaticMarkup(
      <ContextCapacityRing
        context={{ usedTokens: 50_000, contextWindow: 200_000, reservedTokens: 150_000, utilizationRatio: 0.25 }}
        modelContextWindow={200_000}
        t={(key, values) => translate("en", key, values)}
      />
    );

    expect(unknown).toContain("No context data yet");
    expect(unknown).not.toContain("0 / 200K");
    expect(measured).toContain("Context — 50K / 200K (25%)");
  });
});

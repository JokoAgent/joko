// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MobileModelQuotaBar, mobileQuotaColors } from "./MobileModelQuotaBar";

vi.mock("react-native", async () => {
  const React = await import("react");
  return { View: ({ children, style, accessibilityRole, accessibilityLabel, accessibilityValue }: {
    children: React.ReactNode; style: React.CSSProperties; accessibilityRole?: string; accessibilityLabel?: string;
    accessibilityValue?: { min: number; max: number; now: number }
  }) => React.createElement("div", { style, role: accessibilityRole, "aria-label": accessibilityLabel,
    "aria-valuemin": accessibilityValue?.min, "aria-valuemax": accessibilityValue?.max, "aria-valuenow": accessibilityValue?.now }, children) };
});

it("draws the real zero, fractional and full remainder with independent quota warning boundaries", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host);
  try {
    for (const [remaining, expectedColor] of [[0, mobileQuotaColors.critical], [0.1, mobileQuotaColors.critical],
      [10, mobileQuotaColors.critical], [10.1, mobileQuotaColors.warning], [29.9, mobileQuotaColors.warning], [30, "#777777"], [100, "#777777"]] as const) {
      await act(() => root.render(createElement(MobileModelQuotaBar, { remaining, label: "Actual quota", colors: { muted: "#777777", border: "#eeeeee" } })));
      const progress = host.querySelector('[role="progressbar"]') as HTMLDivElement;
      expect(progress.getAttribute("aria-valuenow")).toBe(String(remaining));
      const fill = progress.firstElementChild as HTMLDivElement;
      expect(fill.style.width).toBe(`${remaining}%`); expect(fill.style.minWidth).toBe("");
      const probe = document.createElement("div"); probe.style.color = expectedColor;
      expect(fill.style.backgroundColor).toBe(probe.style.color);
    }
    await act(() => root.render(createElement(MobileModelQuotaBar, { remaining: Number.NaN, label: "Unavailable", colors: { muted: "#777", border: "#eee" } })));
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
  } finally { await act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

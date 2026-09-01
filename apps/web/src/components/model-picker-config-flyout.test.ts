import { describe, expect, it } from "vitest";

import { placeModelPickerConfigFlyout } from "./model-picker-config-flyout.js";

describe("model picker configuration flyout placement", () => {
  const bounds = { left: 8, right: 692, top: 8, bottom: 512 };

  it("opens below when the lower edge has room", () => {
    expect(placeModelPickerConfigFlyout(
      { left: 120, right: 680, top: 80, bottom: 128 },
      bounds,
      280,
      180
    )).toEqual({ left: 370, top: 125, width: 280, maxHeight: 387, side: "below" });
  });

  it("flips above a row near the lower edge", () => {
    expect(placeModelPickerConfigFlyout(
      { left: 120, right: 680, top: 420, bottom: 468 },
      bounds,
      280,
      180
    )).toEqual({ left: 370, top: 243, width: 280, maxHeight: 415, side: "above" });
  });

  it("uses the roomier side when both sides can show the full detail", () => {
    expect(placeModelPickerConfigFlyout(
      { left: 120, right: 680, top: 400, bottom: 448 },
      { left: 8, right: 692, top: 8, bottom: 712 },
      280,
      120
    )).toEqual({ left: 370, top: 283, width: 280, maxHeight: 395, side: "above" });
  });

  it("uses the larger side and caps its own scrolling height in a short picker", () => {
    expect(placeModelPickerConfigFlyout(
      { left: 20, right: 300, top: 105, bottom: 145 },
      { left: 8, right: 312, top: 8, bottom: 212 },
      280,
      240
    )).toEqual({ left: 8, top: 8, width: 280, maxHeight: 100, side: "above" });
  });

  it("clamps width and horizontal position to narrow bounds", () => {
    expect(placeModelPickerConfigFlyout(
      { left: 10, right: 150, top: 40, bottom: 80 },
      { left: 12, right: 132, top: 12, bottom: 240 },
      280,
      80
    )).toEqual({ left: 12, top: 77, width: 120, maxHeight: 163, side: "below" });
  });
});

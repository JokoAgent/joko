import { describe, expect, it } from "vitest";

import { shouldAutoFocusComposer } from "./composer-auto-focus.js";

describe("composer automatic focus", () => {
  const ready = {
    enabled: true,
    readOnly: false,
    hydrated: true,
    activeElementIsNeutral: true,
    activeElementMatchesAnchor: false,
    activeElementInsideComposer: false
  };

  it("focuses after hydration when focus is still neutral or on the navigation anchor", () => {
    expect(shouldAutoFocusComposer(ready)).toBe(true);
    expect(shouldAutoFocusComposer({ ...ready, activeElementIsNeutral: false, activeElementMatchesAnchor: true })).toBe(true);
  });

  it("does not steal focus from another control or a caret already inside the composer", () => {
    expect(shouldAutoFocusComposer({ ...ready, activeElementIsNeutral: false })).toBe(false);
    expect(shouldAutoFocusComposer({ ...ready, activeElementInsideComposer: true })).toBe(false);
    expect(shouldAutoFocusComposer({ ...ready, enabled: false })).toBe(false);
    expect(shouldAutoFocusComposer({ ...ready, readOnly: true })).toBe(false);
    expect(shouldAutoFocusComposer({ ...ready, hydrated: false })).toBe(false);
  });
});

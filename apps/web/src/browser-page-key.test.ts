import { describe, expect, it } from "vitest";

import { browserPageKey } from "./browser-page-key.js";

describe("Browser page identity", () => {
  it("keeps Provider-scoped opaque page IDs distinct without delimiter collisions", () => {
    expect(browserPageKey("provider-a", "page-one")).not.toBe(browserPageKey("provider-b", "page-one"));
    expect(browserPageKey("a:b", "c")).not.toBe(browserPageKey("a", "b:c"));
  });
});

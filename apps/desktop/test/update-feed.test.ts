import { describe, expect, it } from "vitest";

import { resolveDesktopUpdateFeedUrl } from "../src/update-feed.js";

describe("desktop update feed configuration", () => {
  it("accepts only canonical credential-free HTTPS release feeds", () => {
    expect(resolveDesktopUpdateFeedUrl(" https://updates.example.com/joko "))
      .toBe("https://updates.example.com/joko");
    expect(resolveDesktopUpdateFeedUrl("https://updates.example.com"))
      .toBe("https://updates.example.com/");
  });

  it.each([
    undefined,
    "",
    "not a URL",
    "http://updates.example.com/joko",
    "https://user:secret@updates.example.com/joko",
    "https://updates.example.com/joko?token=secret",
    "https://updates.example.com/joko#channel"
  ])("fails closed for an absent or unsafe feed: %s", (value) => {
    expect(resolveDesktopUpdateFeedUrl(value)).toBeUndefined();
  });
});

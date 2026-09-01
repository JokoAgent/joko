import { describe, expect, it } from "vitest";
import { parseBrowserOmnibox } from "./browser-omnibox.js";

describe("Browser omnibox", () => {
  it("keeps HTTP(S), completes hosts, and searches words or phrases", () => {
    expect(parseBrowserOmnibox(" https://example.test/a ")).toBe("https://example.test/a");
    expect(parseBrowserOmnibox("example.test/docs")).toBe("https://example.test/docs");
    expect(parseBrowserOmnibox("localhost:4319")).toBe("https://localhost:4319");
    expect(parseBrowserOmnibox("browser focus")).toBe("https://www.google.com/search?q=browser%20focus");
    expect(parseBrowserOmnibox("浏览器")).toBe(`https://www.google.com/search?q=${encodeURIComponent("浏览器")}`);
  });

  it("supports Ctrl+Enter completion and an about:blank fallback", () => {
    expect(parseBrowserOmnibox("openai", { ctrlEnter: true })).toBe("https://www.openai.com");
    expect(parseBrowserOmnibox(" ")).toBe("about:blank");
    expect(parseBrowserOmnibox("about:blank")).toBe("about:blank");
  });
});

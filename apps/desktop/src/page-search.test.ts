import { describe, expect, it } from "vitest";

import {
  DESKTOP_PAGE_SEARCH_MAX_TEXT_LENGTH,
  parseDesktopPageSearchRequest,
  parseDesktopPageSearchStopAction
} from "./channels.js";

describe("desktop page search IPC boundary", () => {
  it("accepts only exact bounded requests and stop actions", () => {
    expect(parseDesktopPageSearchRequest({
      text: "needle",
      forward: false,
      findNext: true,
      requestToken: 7
    })).toEqual({ text: "needle", forward: false, findNext: true, requestToken: 7 });
    expect(() => parseDesktopPageSearchRequest({
      text: "x".repeat(DESKTOP_PAGE_SEARCH_MAX_TEXT_LENGTH + 1),
      forward: true,
      findNext: false,
      requestToken: 1
    })).toThrow(/invalid/u);
    expect(() => parseDesktopPageSearchRequest({
      text: "needle",
      forward: true,
      findNext: false,
      requestToken: 1,
      extra: true
    })).toThrow(/invalid/u);
    expect(parseDesktopPageSearchStopAction("activateSelection")).toBe("activateSelection");
    expect(() => parseDesktopPageSearchStopAction("dismiss")).toThrow(/invalid/u);
  });
});

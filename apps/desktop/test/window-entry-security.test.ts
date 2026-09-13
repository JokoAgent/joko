import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  INSPECTOR_WINDOW_FRAME_NAME,
  INSPECTOR_WINDOW_URL,
  isInspectorWindowOpenRequest
} from "../src/channels.js";
import {
  createNavigationPolicy,
  isAllowedDesktopAppEntrySearch,
  isAllowedMainFrameNavigation,
  isAllowedPackagedBundleResource,
  runtimeProcessMonitorEntryUrl
} from "../src/security.js";

describe("trusted auxiliary window entries", () => {
  it("admits only exact credential-free application queries", () => {
    for (const search of [
      "?runtimeProcessMonitor=1",
      "?sessionWindow=1&bootSession=task-1",
      "?bootSession=task-1&sessionWindow=1"
    ]) expect(isAllowedDesktopAppEntrySearch(search)).toBe(true);

    for (const search of [
      "?runtimeProcessMonitor=0",
      "?runtimeProcessMonitor=1&auth=secret",
      "?runtimeProcessMonitor=1&runtimeProcessMonitor=1",
      "?sessionWindow=1&bootSession=%20task",
      "?sessionWindow=1&bootSession=task&auth=secret",
      `?sessionWindow=1&bootSession=${"x".repeat(257)}`
    ]) expect(isAllowedDesktopAppEntrySearch(search)).toBe(false);
  });

  it("admits only the exact internal Inspector frame request", () => {
    expect(isInspectorWindowOpenRequest(INSPECTOR_WINDOW_URL, INSPECTOR_WINDOW_FRAME_NAME)).toBe(true);
    expect(isInspectorWindowOpenRequest("https://example.com", INSPECTOR_WINDOW_FRAME_NAME)).toBe(false);
    expect(isInspectorWindowOpenRequest(INSPECTOR_WINDOW_URL, "other-window")).toBe(false);
    expect(isInspectorWindowOpenRequest(undefined, INSPECTOR_WINDOW_FRAME_NAME)).toBe(false);
  });

  it("constructs a strict packaged monitor entry without renderer route state", () => {
    const policy = createNavigationPolicy(resolve("dist/web/index.html"));
    const entry = runtimeProcessMonitorEntryUrl("joko://app/index.html?discard=private#/settings/about");
    expect(entry).toBe("joko://app/index.html?runtimeProcessMonitor=1");
    expect(isAllowedMainFrameNavigation(entry, policy)).toBe(true);
    expect(isAllowedPackagedBundleResource(entry, policy)).toBe(true);
    expect(isAllowedPackagedBundleResource(`${entry}#/runtime-process-monitor`, policy)).toBe(false);
    expect(runtimeProcessMonitorEntryUrl("http://127.0.0.1:4319/app?discard=private#/settings/about"))
      .toBe("http://127.0.0.1:4319/app?runtimeProcessMonitor=1");
  });
});

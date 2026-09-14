import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  INSPECTOR_WINDOW_FRAME_NAME,
  INSPECTOR_WINDOW_URL,
  isDesktopExtensionId,
  isInspectorWindowOpenRequest
} from "../src/channels.js";
import {
  createNavigationPolicy,
  isAllowedDesktopAppEntrySearch,
  isAllowedExtensionWindowNavigation,
  isAllowedMainFrameNavigation,
  isAllowedPackagedBundleResource,
  runtimeProcessMonitorEntryUrl
} from "../src/security.js";

describe("trusted auxiliary window entries", () => {
  it("accepts only current-v1 Extension identities", () => {
    expect(isDesktopExtensionId("extension_0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isDesktopExtensionId("extension_0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(isDesktopExtensionId("extension_0123456789abcdef0123456789abcde")).toBe(false);
    expect(isDesktopExtensionId("../extension_0123456789abcdef0123456789abcdef")).toBe(false);
  });

  it("binds an Extension window to its exact native owner identity", () => {
    const policy = createNavigationPolicy(resolve("dist/web/index.html"));
    const id = "extension_0123456789abcdef0123456789abcdef";
    const entry = `joko://app/index.html?extensionWindow=1&bootExtension=${id}#/extensions/${id}`;
    expect(isAllowedExtensionWindowNavigation(entry, id, policy)).toBe(true);
    expect(isAllowedExtensionWindowNavigation(entry, "extension_11111111111111111111111111111111", policy)).toBe(false);
    expect(isAllowedExtensionWindowNavigation("joko://app/index.html", id, policy)).toBe(false);
    expect(isAllowedExtensionWindowNavigation(
      `joko://app/index.html?extensionWindow=1&bootExtension=${id}&auth=secret#/extensions/${id}`,
      id,
      policy
    )).toBe(false);
  });

  it("admits only exact credential-free application queries", () => {
    for (const search of [
      "?runtimeProcessMonitor=1",
      "?sessionWindow=1&bootSession=task-1",
      "?bootSession=task-1&sessionWindow=1",
      "?extensionWindow=1&bootExtension=extension_0123456789abcdef0123456789abcdef",
      "?bootExtension=extension_0123456789abcdef0123456789abcdef&extensionWindow=1"
    ]) expect(isAllowedDesktopAppEntrySearch(search)).toBe(true);

    for (const search of [
      "?runtimeProcessMonitor=0",
      "?runtimeProcessMonitor=1&auth=secret",
      "?runtimeProcessMonitor=1&runtimeProcessMonitor=1",
      "?sessionWindow=1&bootSession=%20task",
      "?sessionWindow=1&bootSession=task&auth=secret",
      `?sessionWindow=1&bootSession=${"x".repeat(257)}`,
      "?extensionWindow=1&bootExtension=extension_0123456789abcdef0123456789abcdeg",
      "?extensionWindow=1&bootExtension=extension_0123456789abcdef0123456789abcdef&auth=secret",
      "?extensionWindow=1&bootExtension=extension_0123456789abcdef0123456789abcdef&bootExtension=extension_11111111111111111111111111111111"
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

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DESKTOP_DEEP_LINK_SETTINGS_SECTIONS } from "../src/channels.js";
import {
  DesktopDeepLinkDeliveryBuffer,
  DesktopInboundOpenIntentFence,
  buildDesktopFocusDeepLink,
  buildDesktopPortableDeepLink,
  buildDesktopSessionDeepLink,
  buildDesktopSettingsDeepLink,
  desktopInboundOpenIntentFromArgv,
  isPortableSessionPath,
  parseDesktopDeepLink
} from "../src/deep-link.js";

describe("Desktop public deep links", () => {
  it("round-trips task, machine, and message identities through the canonical task form", () => {
    const link = buildDesktopSessionDeepLink({
      sessionId: "task / 一",
      profileId: "machine / 一",
      messageId: "message / 一",
      messageEventId: "event / 一"
    });
    expect(link).toBe(
      "joko://task/task%20%2F%20%E4%B8%80?event=event+%2F+%E4%B8%80&message=message+%2F+%E4%B8%80&profile=machine+%2F+%E4%B8%80"
    );
    expect(parseDesktopDeepLink(link)).toEqual({
      kind: "session",
      sessionId: "task / 一",
      profileId: "machine / 一",
      messageId: "message / 一",
      messageEventId: "event / 一"
    });
  });

  it("round-trips every public settings section and rejects unknown panels", () => {
    for (const section of DESKTOP_DEEP_LINK_SETTINGS_SECTIONS) {
      expect(parseDesktopDeepLink(buildDesktopSettingsDeepLink(section))).toEqual({ kind: "settings", section });
    }
    expect(parseDesktopDeepLink("joko://settings/not-a-panel")).toBeUndefined();
    for (const mergedPanel of ["appearance", "backends", "credentials", "policy", "remoteHosts", "mcp", "pi", "diagnostics"]) {
      expect(parseDesktopDeepLink(`joko://settings/${mergedPanel}`)).toBeUndefined();
    }
    expect(parseDesktopDeepLink("joko://settings/providers?connect=hidden-route")).toBeUndefined();
  });

  it("round-trips focus and portable import handoffs", () => {
    expect(parseDesktopDeepLink(buildDesktopFocusDeepLink())).toEqual({ kind: "focus" });
    expect(parseDesktopDeepLink(buildDesktopFocusDeepLink("oauth return")))
      .toEqual({ kind: "focus", source: "oauth return" });
    expect(parseDesktopDeepLink(buildDesktopPortableDeepLink())).toEqual({ kind: "portable" });
  });

  it("rejects malformed, privileged-origin, folder, and non-whitelisted routes", () => {
    for (const value of [
      "https://example.test/task/one",
      "joko://app/index.html",
      "joko://project/%2Fserver%2Fworkspace",
      "joko://session/task-one",
      "joko://task/",
      "joko://task/one/two",
      "joko://task/%ZZ",
      "joko://task/%0A",
      "joko://task/one#fragment",
      "joko://user@task/one",
      "joko://task:9/one",
      "joko://task/one?unknown=value",
      "joko://task/one?message=a&message=b",
      "joko://task/one?message=",
      "joko://task/one?event=event-without-message",
      "joko://portable/import/extra",
      "joko://portable/import?path=%2Ftmp%2Ftask.jshare",
      `joko://task/${"x".repeat(257)}`
    ]) expect(parseDesktopDeepLink(value), value).toBeUndefined();
  });
});

describe("Desktop OS open intent routing", () => {
  it("finds URL and portable-package arguments on cold start and second instance delivery", () => {
    expect(desktopInboundOpenIntentFromArgv(["app", "--flag", "joko://task/task-one"], "win32"))
      .toEqual({ kind: "session", sessionId: "task-one" });
    expect(desktopInboundOpenIntentFromArgv(["app", "C:\\Transfers\\Task.JSHARE"], "win32"))
      .toEqual({ kind: "portableFile", path: "C:\\Transfers\\Task.JSHARE" });
    expect(desktopInboundOpenIntentFromArgv(["app", "/tmp/task.jshare"], "linux"))
      .toEqual({ kind: "portableFile", path: "/tmp/task.jshare" });
  });

  it("never resolves a folder switch or a relative package path", () => {
    expect(desktopInboundOpenIntentFromArgv(["app", "--open-folder", "C:\\server-workspace"], "win32"))
      .toBeUndefined();
    expect(isPortableSessionPath("task.jshare", "linux")).toBe(false);
    expect(isPortableSessionPath("/tmp/task.jshare.zip", "linux")).toBe(false);
  });

  it("buffers the latest cold intent, consumes it once, and reopens the gate after reload", () => {
    const buffer = new DesktopDeepLinkDeliveryBuffer();
    const first = { kind: "settings", section: "general" } as const;
    const latest = { kind: "settings", section: "providers" } as const;
    expect(buffer.offer(first)).toBeUndefined();
    expect(buffer.offer(latest)).toBeUndefined();
    expect(buffer.takeAfterRendererReady()).toEqual(latest);
    expect(buffer.takeAfterRendererReady()).toBeUndefined();

    const live = { kind: "session", sessionId: "task-live" } as const;
    expect(buffer.offer(live)).toEqual(live);
    buffer.resetRenderer();
    expect(buffer.offer(first)).toBeUndefined();
    expect(buffer.takeAfterRendererReady()).toEqual(first);
  });

  it("keeps an in-flight navigation current across focus-only handoffs", () => {
    const fence = new DesktopInboundOpenIntentFence();
    const navigation = fence.begin({ kind: "portableFile", path: "/tmp/task.jshare" });
    expect(navigation).toBeDefined();

    expect(fence.begin({ kind: "focus", source: "return" })).toBeUndefined();
    expect(navigation === undefined ? false : fence.isCurrent(navigation)).toBe(true);
  });

  it("lets the latest navigation supersede a slower native file handoff", () => {
    const fence = new DesktopInboundOpenIntentFence();
    const file = fence.begin({ kind: "portableFile", path: "/tmp/task.jshare" });
    const task = fence.begin({ kind: "session", sessionId: "task-latest" });
    expect(file).toBeDefined();
    expect(task).toBeDefined();
    expect(file === undefined ? true : fence.isCurrent(file)).toBe(false);
    expect(task === undefined ? false : fence.isCurrent(task)).toBe(true);
  });
});

describe("Desktop deep-link distribution metadata", () => {
  it("registers the public scheme and portable package association", () => {
    const builder = JSON.parse(readFileSync(new URL("../electron-builder.json", import.meta.url), "utf8")) as {
      readonly protocols?: readonly { readonly name?: string; readonly schemes?: readonly string[] }[];
      readonly fileAssociations?: readonly { readonly ext?: string; readonly mimeType?: string; readonly role?: string }[];
    };
    expect(builder.protocols).toEqual([{ name: "Joko task link", schemes: ["joko"] }]);
    expect(builder.fileAssociations).toEqual([expect.objectContaining({
      ext: "jshare",
      mimeType: "application/vnd.joko.session",
      role: "Editor"
    })]);
  });
});

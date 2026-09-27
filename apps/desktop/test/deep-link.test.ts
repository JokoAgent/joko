import { DEEP_LINK_IDENTITIES } from "./i18n/deep-link-corpus.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DESKTOP_DEEP_LINK_SETTINGS_SECTIONS } from "../src/channels.js";
import { DesktopMainDocumentOccurrenceAuthority } from "../src/main-document-occurrence.js";
import {
  DesktopDeepLinkDeliveryBuffer,
  DesktopInboundOpenIntentFence,
  buildDesktopFocusDeepLink,
  buildDesktopPortableDeepLink,
  buildDesktopSessionDeepLink,
  buildDesktopSettingsDeepLink,
  desktopDeepLinkDeliveryMatchesAcknowledgement,
  desktopInboundOpenIntentFromArgv,
  isDesktopMainDocumentReplacementNavigation,
  isPortableSessionPath,
  parseDesktopDeepLinkAcknowledgement,
  parseDesktopDeepLink
} from "../src/deep-link.js";

describe("Desktop public deep links", () => {
  it("round-trips task, machine, and message identities through the canonical task form", () => {
    const link = buildDesktopSessionDeepLink({
      sessionId: DEEP_LINK_IDENTITIES.sessionId,
      profileId: DEEP_LINK_IDENTITIES.profileId,
      messageId: DEEP_LINK_IDENTITIES.messageId,
      messageEventId: DEEP_LINK_IDENTITIES.messageEventId
    });
    expect(parseDesktopDeepLink(link.replace("joko://task/", "joko://session/"))).toEqual({
      kind: "session",
      sessionId: DEEP_LINK_IDENTITIES.sessionId,
      profileId: DEEP_LINK_IDENTITIES.profileId,
      messageId: DEEP_LINK_IDENTITIES.messageId,
      messageEventId: DEEP_LINK_IDENTITIES.messageEventId
    });
    expect(link).toBe(
      "joko://task/task%20%2F%20%E4%B8%80?event=event+%2F+%E4%B8%80&message=message+%2F+%E4%B8%80&profile=machine+%2F+%E4%B8%80"
    );
    expect(parseDesktopDeepLink(link)).toEqual({
      kind: "session",
      sessionId: DEEP_LINK_IDENTITIES.sessionId,
      profileId: DEEP_LINK_IDENTITIES.profileId,
      messageId: DEEP_LINK_IDENTITIES.messageId,
      messageEventId: DEEP_LINK_IDENTITIES.messageEventId
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
      " joko://task/one",
      "joko://task/one\n",
      "joko://app/index.html",
      "joko://project/%2Fserver%2Fworkspace",
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

  it("never builds a link that its own public length fence would reject", () => {
    const largeIdentity = "一".repeat(256);
    expect(() => buildDesktopSessionDeepLink({
      sessionId: largeIdentity,
      profileId: largeIdentity,
      messageId: largeIdentity,
      messageEventId: largeIdentity
    })).toThrow(/public handoff limit/u);
  });
});

describe("Desktop OS open intent routing", () => {
  it("keeps the ready delivery gate until a replacement preload actually captures authority", () => {
    const buffer = new DesktopDeepLinkDeliveryBuffer();
    const endpoint = {};
    let nextOccurrence = 0;
    const documents = new DesktopMainDocumentOccurrenceAuthority<object>(
      () => `document-${++nextOccurrence}`
    );
    const firstClaim = "00000000-0000-4000-8000-000000000001";
    const original = documents.capture(endpoint, firstClaim).current.occurrence;
    expect(buffer.takeAfterRendererReady(original)).toBeUndefined();

    // did-start-navigation is only an attempt. A cancellation or failure
    // must not mutate the captured Document occurrence or its ready gate.
    expect([
      isDesktopMainDocumentReplacementNavigation(true, true),
      isDesktopMainDocumentReplacementNavigation(false, false),
      isDesktopMainDocumentReplacementNavigation(false, true),
      isDesktopMainDocumentReplacementNavigation(true, false)
    ]).toEqual([false, false, false, true]);
    const repeatedCapture = documents.capture(endpoint, firstClaim);
    if (repeatedCapture.created) buffer.resetRenderer();
    expect(repeatedCapture.created).toBe(false);
    const originalDelivery = buffer.offer({ kind: "settings", section: "providers" });
    expect(originalDelivery).toMatchObject({
      documentOccurrence: original,
      navigation: { kind: "settings", section: "providers" }
    });

    const replacement = documents.capture(endpoint, "00000000-0000-4000-8000-000000000002");
    expect(replacement.created).toBe(true);
    expect(replacement.retired?.occurrence).toBe(original);
    if (replacement.created) buffer.resetRenderer();
    expect(buffer.takeAfterRendererReady(replacement.current.occurrence)).toMatchObject({
      documentOccurrence: replacement.current.occurrence,
      deliveryOccurrence: originalDelivery?.deliveryOccurrence,
      navigation: { kind: "settings", section: "providers" }
    });
    expect(buffer.acknowledge({
      documentOccurrence: replacement.current.occurrence,
      deliveryOccurrence: buffer.takeAfterRendererReady(replacement.current.occurrence)!.deliveryOccurrence
    })).toBe(true);
    expect(buffer.offer({ kind: "settings", section: "general" })).toMatchObject({
      documentOccurrence: replacement.current.occurrence,
      navigation: { kind: "settings", section: "general" }
    });
  });

  it("retains an exact ready claim when a live host send cannot be attempted", () => {
    const buffer = new DesktopDeepLinkDeliveryBuffer();
    buffer.takeAfterRendererReady("document-one");
    const claim = buffer.offer({ kind: "settings", section: "providers" });
    expect(claim).toBeDefined();

    // Host send failure is not a Document retirement signal. The same
    // occurrence can still pull and acknowledge the retained claim.
    expect(buffer.takeAfterRendererReady("document-one")).toEqual(claim);
    expect(buffer.acknowledge(claim!)).toBe(true);
  });

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

  it("retains the latest cold intent until its exact document and delivery acknowledge it", () => {
    const buffer = new DesktopDeepLinkDeliveryBuffer();
    const first = { kind: "settings", section: "general" } as const;
    const latest = { kind: "settings", section: "providers" } as const;
    expect(buffer.offer(first)).toBeUndefined();
    expect(buffer.offer(latest)).toBeUndefined();
    const claim = buffer.takeAfterRendererReady("document-one");
    expect(claim).toEqual({
      documentOccurrence: "document-one",
      deliveryOccurrence: expect.any(Number),
      navigation: latest
    });
    expect(buffer.takeAfterRendererReady("document-one")).toEqual(claim);
    expect(buffer.acknowledge({
      documentOccurrence: "document-one",
      deliveryOccurrence: claim!.deliveryOccurrence
    })).toBe(true);
    expect(buffer.takeAfterRendererReady("document-one")).toBeUndefined();

    const live = { kind: "session", sessionId: "task-live" } as const;
    const liveClaim = buffer.offer(live);
    expect(liveClaim?.navigation).toEqual(live);
    expect(buffer.takeAfterRendererReady("document-one")).toEqual(liveClaim);
  });

  it("exposes the exact offered occurrence before a renderer document is ready", () => {
    const buffer = new DesktopDeepLinkDeliveryBuffer();
    const offer = buffer.offerWithOccurrence({ kind: "settings", section: "providers" });
    expect(offer.delivery).toBeUndefined();
    const claim = buffer.takeAfterRendererReady("document-one");
    expect(claim).toMatchObject({
      documentOccurrence: "document-one",
      deliveryOccurrence: offer.deliveryOccurrence,
      navigation: { kind: "settings", section: "providers" }
    });
  });

  it("keeps an unacknowledged delivery across reload and rejects the retired document acknowledgement", () => {
    const buffer = new DesktopDeepLinkDeliveryBuffer();
    const navigation = { kind: "settings", section: "general" } as const;
    buffer.offer(navigation);
    const retired = buffer.takeAfterRendererReady("document-one")!;
    buffer.resetRenderer();
    const replacement = buffer.takeAfterRendererReady("document-two")!;

    expect(replacement).toEqual({
      documentOccurrence: "document-two",
      deliveryOccurrence: retired.deliveryOccurrence,
      navigation
    });
    expect(buffer.acknowledge(retired)).toBe(false);
    expect(buffer.takeAfterRendererReady("document-two")).toEqual(replacement);
    expect(buffer.acknowledge(replacement)).toBe(true);
  });

  it("does not let a late or out-of-order acknowledgement clear a newer intent", () => {
    const buffer = new DesktopDeepLinkDeliveryBuffer();
    expect(buffer.takeAfterRendererReady("document-one")).toBeUndefined();
    const first = buffer.offer({ kind: "settings", section: "general" })!;
    const latest = buffer.offer({ kind: "settings", section: "providers" })!;

    expect(latest.deliveryOccurrence).not.toBe(first.deliveryOccurrence);
    expect(buffer.acknowledge(first)).toBe(false);
    expect(buffer.takeAfterRendererReady("document-one")).toEqual(latest);
    expect(buffer.acknowledge(latest)).toBe(true);
    expect(buffer.acknowledge(first)).toBe(false);
    expect(buffer.takeAfterRendererReady("document-one")).toBeUndefined();
  });

  it("parses only bounded exact delivery acknowledgements", () => {
    expect(parseDesktopDeepLinkAcknowledgement({
      documentOccurrence: "document-one",
      deliveryOccurrence: 1
    })).toEqual({ documentOccurrence: "document-one", deliveryOccurrence: 1 });
    expect(() => parseDesktopDeepLinkAcknowledgement({
      documentOccurrence: "document-one",
      deliveryOccurrence: 1,
      extra: true
    })).toThrow(/invalid|exact/u);
    expect(() => parseDesktopDeepLinkAcknowledgement({
      documentOccurrence: "document-one",
      deliveryOccurrence: 0
    })).toThrow(/invalid/u);
  });

  it("attributes an acknowledgement only to its exact delivery occurrence", () => {
    const delivery = {
      documentOccurrence: "document-two",
      deliveryOccurrence: 4,
      navigation: { kind: "settings", section: "providers" }
    } as const;
    expect(desktopDeepLinkDeliveryMatchesAcknowledgement(delivery, {
      documentOccurrence: "document-two",
      deliveryOccurrence: 4
    })).toBe(true);
    expect(desktopDeepLinkDeliveryMatchesAcknowledgement(delivery, {
      documentOccurrence: "document-one",
      deliveryOccurrence: 4
    })).toBe(false);
    expect(desktopDeepLinkDeliveryMatchesAcknowledgement(delivery, {
      documentOccurrence: "document-two",
      deliveryOccurrence: 5
    })).toBe(false);
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

  it("retires a buffered older navigation while a newer native file is still materializing", () => {
    const buffer = new DesktopDeepLinkDeliveryBuffer();
    const fence = new DesktopInboundOpenIntentFence();
    const olderNavigation = { kind: "settings", section: "general" } as const;
    const older = fence.begin(olderNavigation);
    expect(older).toBeDefined();
    buffer.retirePendingForNewNavigation();
    if (older !== undefined && fence.isCurrent(older)) buffer.offer(olderNavigation);

    const file = fence.begin({ kind: "portableFile", path: "/tmp/latest.jshare" });
    expect(file).toBeDefined();
    buffer.retirePendingForNewNavigation();

    expect(buffer.takeAfterRendererReady("document-one")).toBeUndefined();
    expect(fence.begin({ kind: "focus", source: "return" })).toBeUndefined();
    expect(file === undefined ? false : fence.isCurrent(file)).toBe(true);
    if (older !== undefined && fence.isCurrent(older)) buffer.offer(olderNavigation);
    expect(buffer.takeAfterRendererReady("document-one")).toBeUndefined();

    const replacement = buffer.offer({ kind: "portable" });
    expect(replacement).toEqual({
      documentOccurrence: "document-one",
      deliveryOccurrence: expect.any(Number),
      navigation: { kind: "portable" }
    });
  });

  it("keeps a notification route newer than a slow native file materialization", () => {
    const buffer = new DesktopDeepLinkDeliveryBuffer();
    const fence = new DesktopInboundOpenIntentFence();
    expect(buffer.takeAfterRendererReady("document-one")).toBeUndefined();

    const file = fence.begin({ kind: "portableFile", path: "/tmp/older.jshare" });
    expect(file).toBeDefined();
    buffer.retirePendingForNewNavigation();

    const notificationNavigation = {
      kind: "session",
      profileId: "machine-one",
      sessionId: "task-from-notification"
    } as const;
    const notification = fence.begin(notificationNavigation);
    expect(notification).toBeDefined();
    buffer.retirePendingForNewNavigation();
    if (notification !== undefined && fence.isCurrent(notification)) buffer.offer(notificationNavigation);

    const delivered = buffer.takeAfterRendererReady("document-one");
    expect(delivered?.navigation).toEqual(notificationNavigation);
    if (file !== undefined && fence.isCurrent(file)) buffer.offer({ kind: "portable" });
    expect(buffer.takeAfterRendererReady("document-one")).toEqual(delivered);
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

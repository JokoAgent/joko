import { describe, expect, it } from "vitest";
import {
  parseMobileComposerRouteHref,
  sanitizeMobileComposerReferenceLabel,
  seedMobileComposerRouteReference,
  segmentMobileComposerRoutePaste,
  summarizeMobileComposerMessageReference
} from "./mobile-composer-route-links";

describe("mobile composer task and project links", () => {
  it("segments mixed bare and Markdown links while retaining adjacent text and punctuation", () => {
    const segments = segmentMobileComposerRoutePaste(
      "See https://user:pass@example.test/view?token=secret&theme=dark#/tasks/session%20one?message=message-1&auth=bad, then [Other @ task](#/tasks/session-2) in #/projects/project%2Fone?token=bad."
    );

    expect(segments).toEqual([
      { kind: "text", text: "See " },
      {
        kind: "route-reference",
        routeKind: "session",
        href: "https://example.test/view?theme=dark#/tasks/session%20one?message=message-1",
        label: null,
        sessionId: "session one",
        messageId: "message-1"
      },
      { kind: "text", text: ", then " },
      {
        kind: "route-reference",
        routeKind: "session",
        href: "#/tasks/session-2",
        label: "Other @ task",
        sessionId: "session-2"
      },
      { kind: "text", text: " in " },
      {
        kind: "route-reference",
        routeKind: "project",
        href: "#/projects/project%2Fone",
        label: null,
        projectId: "project/one"
      },
      { kind: "text", text: "." }
    ]);
  });

  it("rejects malformed, duplicate, cross-kind, and non-Joko route identities", () => {
    expect(parseMobileComposerRouteHref("#/tasks/%E0%A4%A")).toBeUndefined();
    expect(parseMobileComposerRouteHref("#/tasks/session?message=one&message=two")).toBeUndefined();
    expect(parseMobileComposerRouteHref("#/projects/project?message=message")).toBeUndefined();
    expect(parseMobileComposerRouteHref("ftp://example.test/#/tasks/session")).toBeUndefined();
    expect(segmentMobileComposerRoutePaste("Keep #/tasks/%E0%A4%A literal")).toBeNull();
    expect(parseMobileComposerRouteHref("https://example.test/(view)#/tasks/session%29one")).toEqual({
      routeKind: "session",
      href: "https://example.test/%28view%29#/tasks/session%29one",
      sessionId: "session)one"
    });
    expect(parseMobileComposerRouteHref(
      "https://user:pass@example.test/app?credential=gone&theme=dark#/projects/project%2Fone?secret=gone&view=board"
    )).toEqual({
      routeKind: "project",
      href: "https://example.test/app?theme=dark#/projects/project%2Fone?view=board",
      projectId: "project/one"
    });
  });

  it("seeds stable task/message wire text and bounds presentation", () => {
    const session = seedMobileComposerRouteReference({
      kind: "route-reference",
      routeKind: "session",
      href: "#/tasks/session-long-identity",
      label: "[Roadmap] @ team",
      sessionId: "session-long-identity"
    });
    expect(session).toEqual({
      routeKind: "session",
      href: "#/tasks/session-long-identity",
      sessionId: "session-long-identity",
      displayText: "Roadmap ＠ team",
      serialized: "[Roadmap ＠ team](#/tasks/session-long-identity)",
      pending: false
    });

    const message = seedMobileComposerRouteReference({
      kind: "route-reference",
      routeKind: "session",
      href: "#/tasks/session?event=event-long-identity",
      label: "Ignored message label",
      sessionId: "session",
      eventId: "event-long-identity"
    });
    expect(message).toMatchObject({
      displayText: "event-lo…tity",
      serialized: "#/tasks/session?event=event-long-identity",
      pending: true
    });
    expect(seedMobileComposerRouteReference({
      kind: "route-reference",
      routeKind: "project",
      href: "#/projects/project-long-identity",
      label: null,
      projectId: "project-long-identity"
    })).toEqual({
      routeKind: "project",
      href: "#/projects/project-long-identity",
      projectId: "project-long-identity",
      displayText: "project-…tity",
      serialized: "#/projects/project-long-identity",
      pending: true
    });
    expect(sanitizeMobileComposerReferenceLabel("  A   [task] @me  ")).toBe("A task ＠me");
    expect(summarizeMobileComposerMessageReference("a\n" + "b".repeat(300))).toHaveLength(240);
  });
});

import { describe, expect, it } from "vitest";
import {
  findMobileComposerWorkspacePathCandidates,
  mobileComposerWorkspacePathComparisonKey,
  parseMobileComposerRouteHref,
  sanitizeMobileComposerReferenceLabel,
  seedMobileComposerRouteReference,
  segmentMobileComposerRoutePaste,
  summarizeMobileComposerMessageReference
} from "./mobile-composer-route-links";

describe("mobile composer task, project, and Workspace path links", () => {
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

  it("finds only strict Windows and POSIX Workspace descendants outside route links", () => {
    expect(findMobileComposerWorkspacePathCandidates(
      "D:\\REPO\\src\\known.ts:12:3, D:/repo D:/repo-two/no.ts D:/repo/src/../secret #/tasks/D:%5Crepo%5Cignored",
      "D:\\repo\\"
    )).toEqual([{
      sourcePath: "D:\\REPO\\src\\known.ts",
      relativePath: "src/known.ts",
      comparisonKey: "src/known.ts"
    }]);
    expect(findMobileComposerWorkspacePathCandidates(
      "/srv/joko/src/known.ts) /srv/Joko/src/wrong.ts /srv/joko /srv/joko-two/no.ts",
      "/srv/joko/"
    )).toEqual([{
      sourcePath: "/srv/joko/src/known.ts",
      relativePath: "src/known.ts",
      comparisonKey: "src/known.ts"
    }]);
    expect(findMobileComposerWorkspacePathCandidates(
      "D:\\Repoİ\\src\\known.ts",
      "D:\\Repoİ"
    )).toEqual([{
      sourcePath: "D:\\Repoİ\\src\\known.ts",
      relativePath: "src/known.ts",
      comparisonKey: "src/known.ts"
    }]);
    expect(findMobileComposerWorkspacePathCandidates("\\\\server\\share\\file.ts", "\\\\server\\share")).toEqual([]);
    expect(mobileComposerWorkspacePathComparisonKey("Src/File.ts", "D:\\repo")).toBe("src/file.ts");
    expect(mobileComposerWorkspacePathComparisonKey("Src/File.ts", "/repo")).toBe("Src/File.ts");
  });

  it("upgrades only directory-validated Workspace paths alongside route links", () => {
    const segments = segmentMobileComposerRoutePaste(
      "Open D:\\repo\\SRC\\Known.ts:12, keep D:\\repo\\src\\missing.ts and #/projects/mobile.",
      { workspacePath: {
        workspaceId: "workspace-one",
        serverPathDisplay: "D:\\repo",
        resolutions: [{
          candidateRelativePath: "SRC/Known.ts",
          relativePath: "src/Known.ts",
          directory: false
        }]
      } }
    );
    expect(segments).toEqual([
      { kind: "text", text: "Open " },
      {
        kind: "route-reference",
        routeKind: "path",
        workspaceId: "workspace-one",
        relativePath: "src/Known.ts",
        directory: false,
        serialized: "@src/Known.ts",
        displayText: "src/Known.ts"
      },
      { kind: "text", text: ":12, keep D:\\repo\\src\\missing.ts and " },
      {
        kind: "route-reference",
        routeKind: "project",
        href: "#/projects/mobile",
        label: null,
        projectId: "mobile"
      },
      { kind: "text", text: "." }
    ]);
    expect(segmentMobileComposerRoutePaste("D:\\repo\\src\\missing.ts", {
      workspacePath: { workspaceId: "workspace-one", serverPathDisplay: "D:\\repo", resolutions: [] }
    })).toBeNull();
  });

  it("seeds path atoms without retaining an absolute server path", () => {
    expect(seedMobileComposerRouteReference({
      kind: "route-reference",
      routeKind: "path",
      workspaceId: "workspace-one",
      relativePath: "src/main.ts",
      directory: false,
      serialized: "@src/main.ts",
      displayText: "src/main.ts"
    })).toEqual({
      routeKind: "path",
      workspaceId: "workspace-one",
      relativePath: "src/main.ts",
      directory: false,
      serialized: "@src/main.ts",
      displayText: "src/main.ts",
      pending: false
    });
  });
});

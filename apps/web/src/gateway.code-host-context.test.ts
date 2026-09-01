import { create } from "@bufbuild/protobuf";
import {
  CodeHostPullRequestProjectionSchema,
  CodeHostPullRequestReferenceSchema,
  CodeHostPullRequestState,
  PermissionMode,
  SessionSchema,
  SessionState,
  SnapshotSchema
} from "@joko/contracts";
import { describe, expect, it } from "vitest";

import { mapSnapshot } from "./gateway.js";

describe("gateway code-host context", () => {
  it("maps observed and extracted-only pull request projections without Backend branching", () => {
    const session = create(SessionSchema, {
      sessionId: "session-1",
      backendId: "any-coding-agent",
      targetId: "target-1",
      displayName: "Task",
      state: SessionState.IDLE,
      permissionMode: PermissionMode.ASK,
      codeHostPullRequests: [
        create(CodeHostPullRequestProjectionSchema, {
          reference: create(CodeHostPullRequestReferenceSchema, {
            referenceKey: "code.example/acme/widgets#42",
            host: "code.example",
            repositoryOwner: "acme",
            repositoryName: "widgets",
            number: 42n,
            webUrl: "https://code.example/acme/widgets/pull/42"
          }),
          state: CodeHostPullRequestState.MERGED,
          observed: true,
          title: "Ship the pull request badge",
          headBranch: "feature/pr-badge",
          unresolvedReviewThreadCount: 1
        }),
        create(CodeHostPullRequestProjectionSchema, {
          reference: create(CodeHostPullRequestReferenceSchema, {
            referenceKey: "forge.example/team/service#7",
            host: "forge.example",
            repositoryOwner: "team",
            repositoryName: "service",
            number: 7n,
            webUrl: "https://forge.example/team/service/-/merge_requests/7"
          })
        })
      ]
    });
    const mapped = mapSnapshot(create(SnapshotSchema, { sessions: [session] })).sessions[0];
    expect(mapped?.codeHostPullRequests).toEqual([
      {
        key: "code.example/acme/widgets#42",
        host: "code.example",
        repositoryOwner: "acme",
        repositoryName: "widgets",
        number: 42,
        webUrl: "https://code.example/acme/widgets/pull/42",
        projection: {
          state: "merged",
          draft: false,
          title: "Ship the pull request badge",
          headBranch: "feature/pr-badge",
          unresolvedReviewThreadCount: 1,
          observedAt: 0
        }
      },
      {
        key: "forge.example/team/service#7",
        host: "forge.example",
        repositoryOwner: "team",
        repositoryName: "service",
        number: 7,
        webUrl: "https://forge.example/team/service/-/merge_requests/7"
      }
    ]);
  });

  it.each([
    { webUrl: "javascript:alert(1)", title: "Safe title", headBranch: "safe-branch" },
    { webUrl: "https://evil.example/acme/widgets/pull/42", title: "Safe title", headBranch: "safe-branch" },
    { webUrl: "https://code.example/acme/widgets/pull/42?redirect=https://evil.example", title: "Safe title", headBranch: "safe-branch" },
    { webUrl: "https://code.example/acme/widgets/pull/42", title: "line\nbreak", headBranch: "safe-branch" },
    { webUrl: "https://code.example/acme/widgets/pull/42", title: "Safe title", headBranch: "../escape" }
  ])("rejects unsafe projected metadata %#", ({ webUrl, title, headBranch }) => {
    const session = create(SessionSchema, {
      sessionId: "session-unsafe",
      backendId: "any-coding-agent",
      targetId: "target-1",
      displayName: "Task",
      state: SessionState.IDLE,
      permissionMode: PermissionMode.ASK,
      codeHostPullRequests: [create(CodeHostPullRequestProjectionSchema, {
        reference: create(CodeHostPullRequestReferenceSchema, {
          referenceKey: "code.example/acme/widgets#42",
          host: "code.example",
          repositoryOwner: "acme",
          repositoryName: "widgets",
          number: 42n,
          webUrl
        }),
        state: CodeHostPullRequestState.OPEN,
        observed: true,
        title,
        headBranch
      })]
    });
    expect(() => mapSnapshot(create(SnapshotSchema, { sessions: [session] }))).toThrow(/invalid code-host/u);
  });
});

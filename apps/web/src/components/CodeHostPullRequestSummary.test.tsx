import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CodeHostPullRequestView } from "../model.js";
import type { Translator } from "./types.js";
import {
  CodeHostPullRequestSummary,
  codeHostDisplayBranch,
  codeHostPullRequestDisplayState,
  codeHostPullRequestTooltip
} from "./CodeHostPullRequestSummary.js";

const t: Translator = (key, values) => `${key}${values === undefined ? "" : `:${Object.values(values).join(":")}`}`;

describe("code-host pull request summary", () => {
  it("projects merged/draft/review facts into the header hover surface", () => {
    const pullRequests: readonly CodeHostPullRequestView[] = [
      {
        key: "code.example/acme/widgets#42",
        host: "code.example",
        repositoryOwner: "acme",
        repositoryName: "widgets",
        number: 42,
        webUrl: "https://code.example/acme/widgets/pull/42",
        projection: {
          state: "open",
          draft: true,
          title: "Draft the badge",
          headBranch: "feature/draft-badge",
          unresolvedReviewThreadCount: 2,
          observedAt: 1
        }
      },
      {
        key: "code.example/acme/widgets#43",
        host: "code.example",
        repositoryOwner: "acme",
        repositoryName: "widgets",
        number: 43,
        webUrl: "https://code.example/acme/widgets/pull/43",
        projection: {
          state: "merged",
          draft: false,
          title: "Merge the badge",
          headBranch: "feature/merged-badge",
          unresolvedReviewThreadCount: 0,
          observedAt: 2
        }
      }
    ];
    const tooltip = codeHostPullRequestTooltip(pullRequests, t);
    expect(tooltip).toContain("codeHost.statusDraft");
    expect(tooltip).toContain("Draft the badge");
    expect(tooltip).toContain("feature/draft-badge");
    expect(tooltip).toContain("codeHost.unresolvedReviewThreads:2");
    expect(tooltip).toContain("codeHost.statusMerged");
    const html = renderToStaticMarkup(<CodeHostPullRequestSummary pullRequests={pullRequests} t={t} />);
    expect(html).toContain("codeHost.pullRequestCount");
    expect(html).toContain("codeHost.statusMerged");
  });

  it("classifies all four observed states", () => {
    const cases = [
      { state: "open" as const, draft: false, expected: "open" },
      { state: "open" as const, draft: true, expected: "draft" },
      { state: "merged" as const, draft: false, expected: "merged" },
      { state: "closed" as const, draft: false, expected: "closed" }
    ];
    for (const item of cases) {
      const pullRequest = observedPullRequest(item.state, item.draft);
      expect(codeHostPullRequestDisplayState(pullRequest)).toBe(item.expected);
    }
  });

  it("prefers a trusted workspace branch and otherwise falls back to the most recent observed PR head", () => {
    const pullRequests = [observedPullRequest("open", false), {
      ...observedPullRequest("open", false),
      number: 43,
      projection: { ...observedPullRequest("open", false).projection!, headBranch: "older/head" }
    }];
    expect(codeHostDisplayBranch({ trusted: true, branch: "workspace/main" }, pullRequests)).toBe("workspace/main");
    expect(codeHostDisplayBranch({ trusted: false, branch: "untrusted/branch" }, pullRequests)).toBe("feature/header-chip");
    expect(codeHostDisplayBranch(undefined, pullRequests)).toBe("feature/header-chip");
  });

  it("labels extracted references whose provider projection is unavailable", () => {
    expect(codeHostPullRequestTooltip([{
      key: "forge.example/team/service#7",
      host: "forge.example",
      repositoryOwner: "team",
      repositoryName: "service",
      number: 7,
      webUrl: "https://forge.example/team/service/-/merge_requests/7"
    }], t)).toContain("codeHost.statusUnavailable");
  });
});

function observedPullRequest(
  state: "open" | "closed" | "merged",
  draft: boolean
): CodeHostPullRequestView {
  return {
    key: "code.example/acme/widgets#42",
    host: "code.example",
    repositoryOwner: "acme",
    repositoryName: "widgets",
    number: 42,
    webUrl: "https://code.example/acme/widgets/pull/42",
    projection: {
      state,
      draft,
      title: "Header chip",
      headBranch: "feature/header-chip",
      unresolvedReviewThreadCount: 0,
      observedAt: 1
    }
  };
}

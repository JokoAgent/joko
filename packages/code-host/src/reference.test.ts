import { describe, expect, it } from "vitest";

import {
  extractCodeHostPullRequestReferences,
  parseCodeHostPullRequestReference
} from "./reference.js";

describe("code-host pull request references", () => {
  it("extracts and de-duplicates pull and merge request URLs without retaining surrounding text", () => {
    expect(extractCodeHostPullRequestReferences([
      "Review https://code.example/acme/widgets/pull/42, then https://code.example/acme/widgets/pull/42.",
      "Merge request: https://forge.example/team/service/-/merge_requests/7"
    ])).toEqual([
      {
        key: "code.example/acme/widgets#42",
        host: "code.example",
        repositoryOwner: "acme",
        repositoryName: "widgets",
        number: 42,
        webUrl: "https://code.example/acme/widgets/pull/42"
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

  it("rejects credential-bearing, insecure, malformed, and non-review URLs", () => {
    expect(parseCodeHostPullRequestReference("https://token@code.example/acme/widgets/pull/2")).toBeUndefined();
    expect(parseCodeHostPullRequestReference("http://code.example/acme/widgets/pull/2")).toBeUndefined();
    expect(parseCodeHostPullRequestReference("https://code.example/acme/widgets/issues/2")).toBeUndefined();
    expect(parseCodeHostPullRequestReference("https://code.example/acme%2Fescape/widgets/pull/2")).toBeUndefined();
    expect(parseCodeHostPullRequestReference("https://code.example/acme/widgets/pull/0")).toBeUndefined();
    expect(parseCodeHostPullRequestReference("https://code.example/acme/widgets/pull/2?next=https://evil.example")).toBeUndefined();
    expect(parseCodeHostPullRequestReference("https://code.example/acme/widgets/pull/2#fragment")).toBeUndefined();
  });

  it("canonicalizes nested GitLab projects and supported review subpages", () => {
    const refs = extractCodeHostPullRequestReferences([
      "https://gitlab.com/team/sub/repo/-/merge_requests/7/diffs?diff_id=2 https://gitlab.com/team/sub/repo/-/merge_requests/7",
      "https://github.com/Org/Project/pull/8/files#diff-123 https://github.com/org/project/pull/8",
      "https://gitlab.com/team/sub/repo/-/issues/7 https://secret@gitlab.com/team/sub/repo/-/merge_requests/7"
    ]);
    expect(refs.map(({ repositoryOwner, webUrl }) => ({ repositoryOwner, webUrl }))).toEqual([
      { repositoryOwner: "team/sub", webUrl: "https://gitlab.com/team/sub/repo/-/merge_requests/7" },
      { repositoryOwner: "org", webUrl: "https://github.com/org/project/pull/8" }
    ]);
  });
  it("deduplicates GitHub repository casing and preserves distinct PRs and other hosts", () => {
    const references = extractCodeHostPullRequestReferences([
      "https://github.com/Acme/Widgets/pull/42 https://github.com/acme/widgets/pull/42",
      "https://github.com/acme/widgets/pull/43 https://github.com/Acme/Another/pull/42",
      "https://forge.example/Acme/Widgets/pull/42 https://forge.example/acme/widgets/pull/42"
    ]);
    expect(references.map(reference => reference.key)).toEqual([
      "github.com/acme/widgets#42", "github.com/acme/widgets#43", "github.com/acme/another#42",
      "forge.example/Acme/Widgets#42", "forge.example/acme/widgets#42"
    ]);
    expect(references[0]?.webUrl).toBe("https://github.com/acme/widgets/pull/42");
  });

  it("bounds the number of references projected from one Session", () => {
    const references = extractCodeHostPullRequestReferences(Array.from(
      { length: 32 },
      (_, index) => `https://code.example/acme/widgets/pull/${index + 1}`
    ));
    expect(references).toHaveLength(16);
    expect(references.at(-1)?.number).toBe(16);
  });
});

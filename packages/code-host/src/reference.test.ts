import { describe, expect, it } from "vitest";

import {
  extractCodeHostPullRequestReferences,
  parseCodeHostPullRequestReference
} from "./reference.js";

describe("code-host pull request references", () => {
  it("extracts and de-duplicates pull and merge request URLs without retaining surrounding text", () => {
    expect(extractCodeHostPullRequestReferences([
      "Review https://code.example/acme/widgets/pull/42, then https://code.example/acme/widgets/pull/42.",
      "Mirror: https://forge.example/team/service/-/merge_requests/7"
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

  it("bounds the number of references projected from one Session", () => {
    const references = extractCodeHostPullRequestReferences(Array.from(
      { length: 32 },
      (_, index) => `https://code.example/acme/widgets/pull/${index + 1}`
    ));
    expect(references).toHaveLength(16);
    expect(references.at(-1)?.number).toBe(16);
  });
});

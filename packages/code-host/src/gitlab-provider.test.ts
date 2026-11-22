import { expect, it, vi } from "vitest";
import { createGitLabCodeHostProvider, parseCodeHostPullRequestReference } from "./index.js";

it.each(["gitlab.com", "git.room.example"] as const)("reads the exact authorized GitLab host %s and fences changes", async host => {
  const reference = parseCodeHostPullRequestReference(`https://${host}/group/sub/project/-/merge_requests/7`)!;
  let owner = true, state = "opened";
  let currentToken: string | undefined = "first-test-token";
  let hasNextPage = false, hasConflicts: boolean | undefined = true;
  const authorize = vi.fn(() => owner ? { sessionOwnerId: "test-task", referenceKey: reference.key, ownerRevision: "1" } : undefined);
  const readToken = vi.fn(async (requestedHost: string) => requestedHost === host ? currentToken : undefined);
  const response = () => Response.json({ data: { project: { mergeRequest: {
    state, hasConflicts, title: "Exact merge request", draft: false, sourceBranch: "feature/ordered", resolvableDiscussionsCount: 4, resolvedDiscussionsCount: 3,
    diffHeadSha: "a".repeat(40), headPipeline: { jobs: { count: 4, pageInfo: { hasNextPage },
      nodes: [{ status: "SUCCESS" }, { status: "FAILED" }, { status: "MANUAL", allowFailure: true }, { status: "RUNNING" }] } }
  } } } });
  const fetcher = vi.fn<typeof fetch>(async () => response());
  const provider = createGitLabCodeHostProvider({ authorization: { authorize, isCurrent: () => owner }, readToken, fetch: fetcher });
  const input = { sessionOwnerId: "test-task", signal: new AbortController().signal };
  await expect(provider.getPullRequest(reference, input)).resolves.toEqual({ state: "open", title: "Exact merge request",
    draft: false, headBranch: "feature/ordered", unresolvedReviewThreadCount: 1, hasConflicts: true,
    checks: { total: 4, passed: 1, failed: 1, skipped: 1, pending: 1 } });
  expect(fetcher).toHaveBeenCalledWith(`https://${host}/api/graphql`, expect.objectContaining({ redirect: "error", credentials: "omit" }));
  expect(readToken.mock.calls).toEqual([[host, expect.any(AbortSignal)], [host, expect.any(AbortSignal)]]);
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).variables).toEqual({ path: "group/sub/project", iid: "7" });
  state = "merged";
  hasNextPage = true;
  hasConflicts = false;
  const merged = await provider.getPullRequest(reference, input);
  expect(merged.state).toBe("merged");
  expect(merged.checks).toBeUndefined();
  expect(merged.hasConflicts).toBe(false);
  hasConflicts = undefined;
  await expect(provider.getPullRequest(reference, input)).resolves.not.toHaveProperty("hasConflicts");
  fetcher.mockImplementationOnce(async () => { currentToken = "rotated-test-token"; return response(); });
  await expect(provider.getPullRequest(reference, input)).rejects.toMatchObject({ name: "CodeHostProviderUnavailableError" });
  owner = false;
  await expect(provider.getPullRequest(reference, input)).rejects.toMatchObject({ name: "CodeHostProviderUnavailableError" });
  owner = true;
  currentToken = undefined;
  await expect(provider.getPullRequest(reference, input)).rejects.toMatchObject({ name: "CodeHostProviderUnavailableError" });
  expect(fetcher).toHaveBeenCalledTimes(4);
});

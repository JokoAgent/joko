import { expect, it, vi } from "vitest";
import { createGitLabCodeHostProvider, parseCodeHostPullRequestReference } from "./index.js";

it.each(["gitlab.com", "git.room.example"] as const)("reads the exact authorized GitLab host %s and fences changes", async host => {
  const reference = parseCodeHostPullRequestReference(`https://${host}/group/sub/project/-/merge_requests/7`)!;
  let owner = true, state = "opened";
  let approved: boolean | null = false, mergedAt: string | null = null, closedAt: string | null = null;
  const pipeline = { id: "gid://gitlab/Ci::Pipeline/17", status: "RUNNING", finishedAt: null as string | null };
  let currentToken: string | undefined = "first-test-token";
  let hasNextPage = false, conflicts: boolean | undefined = true;
  const authorize = vi.fn(() => owner ? { sessionOwnerId: "test-task", referenceKey: reference.key, ownerRevision: "1" } : undefined);
  const readToken = vi.fn(async (requestedHost: string) => requestedHost === host ? currentToken : undefined);
  const response = () => Response.json({ data: { project: { mergeRequest: {
    state, conflicts, title: "Exact merge request", draft: false, sourceBranch: "feature/ordered", resolvableDiscussionsCount: 4, resolvedDiscussionsCount: 3,
    approved, userNotesCount: 3, mergedAt, closedAt,
    diffHeadSha: "a".repeat(40), headPipeline: { ...pipeline, jobs: { count: 4, pageInfo: { hasNextPage },
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
  const { query, variables } = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(query).toMatch(/\bconflicts\b/);
  expect(query).not.toMatch(/\bhasConflicts\b/);
  expect(variables).toEqual({ path: "group/sub/project", iid: "7" });
  const follow = { ...input, purpose: "follow" as const };
  const open = await provider.getPullRequest(reference, follow);
  expect(open.activity).toMatchObject({
    headSha: "a".repeat(40), reviewDecision: "not_approved", commentCount: 3, mergeState: "conflicts",
    checks: expect.arrayContaining(["failed:1", "pending:1"])
  });
  expect(open.activity).not.toHaveProperty("mergedAt");
  expect(open.activity).toMatchObject({ pipelineId: pipeline.id, pipelineStatus: "RUNNING" });
  expect(open.activity).not.toHaveProperty("pipelineFinishedAt");
  const followRequest = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
  expect(followRequest.variables).toEqual(variables);
  expect(followRequest.query.match(/\w+/gu)).toEqual(expect.arrayContaining(["approved", "userNotesCount", "mergedAt", "closedAt"]));
  expect(followRequest.query).toMatch(/headPipeline\s*\{\s*id finishedAt status\b/u);
  state = "merged";
  approved = true;
  mergedAt = "2026-11-27T01:00:00Z";
  hasNextPage = true;
  conflicts = false;
  const merged = await provider.getPullRequest(reference, follow);
  expect(merged.state).toBe("merged");
  expect(merged.activity).toMatchObject({ mergedAt: Date.parse(mergedAt), reviewDecision: "approved", mergeState: "no_conflicts" });
  expect(merged.checks).toBeUndefined();
  expect(merged.hasConflicts).toBe(false);
  state = "closed";
  closedAt = pipeline.finishedAt = "2026-11-27T02:00:00Z";
  pipeline.status = "SUCCESS";
  const closed = await provider.getPullRequest(reference, follow);
  expect(closed.activity).toMatchObject({ closedAt: Date.parse(closedAt), pipelineId: pipeline.id,
    pipelineStatus: "SUCCESS", pipelineFinishedAt: Date.parse(pipeline.finishedAt) });
  expect(closed.activity).not.toHaveProperty("mergedAt");
  closedAt = "unknown";
  conflicts = undefined;
  approved = null;
  mergedAt = null;
  const unknown = await provider.getPullRequest(reference, follow);
  expect(unknown).not.toHaveProperty("hasConflicts");
  expect(unknown.activity).not.toHaveProperty("mergedAt");
  expect(unknown.activity).not.toHaveProperty("closedAt");
  expect(unknown.activity).not.toHaveProperty("reviewDecision");
  fetcher.mockImplementationOnce(async () => { currentToken = "rotated-test-token"; return response(); });
  await expect(provider.getPullRequest(reference, follow)).rejects.toMatchObject({ name: "CodeHostProviderUnavailableError" });
  owner = false;
  await expect(provider.getPullRequest(reference, input)).rejects.toMatchObject({ name: "CodeHostProviderUnavailableError" });
  owner = true;
  currentToken = undefined;
  await expect(provider.getPullRequest(reference, input)).rejects.toMatchObject({ name: "CodeHostProviderUnavailableError" });
  expect(fetcher).toHaveBeenCalledTimes(6);
});

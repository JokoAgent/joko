import type { CodeHostPullRequestActivity } from "./types.js";

const MAX_CHECKS = 100;

export function githubPullRequestActivity(value: unknown): CodeHostPullRequestActivity {
  const pr = record(value);
  const sha = record(pr?.["head"])?.["sha"];
  const merged = pr?.["merged_at"];
  const mergedAt = typeof merged === "string" ? Date.parse(merged) : undefined;
  const mergeState = status(pr?.["mergeable_state"]);
  const commentCount = count(pr?.["comments"]);
  const reviewCommentCount = count(pr?.["review_comments"]);
  return {
    ...(typeof sha === "string" && /^[a-f0-9]{40}$/u.test(sha) ? { headSha: sha } : {}),
    ...(mergedAt !== undefined && Number.isSafeInteger(mergedAt) && mergedAt > 0 ? { mergedAt } : {}),
    ...(mergeState === undefined || mergeState === "unknown" ? {} : { mergeState }),
    ...(commentCount === undefined ? {} : { commentCount }),
    ...(reviewCommentCount === undefined ? {} : { reviewCommentCount })
  };
}

export function githubPublicChecks(runs: unknown, combined: unknown): readonly string[] | undefined {
  const checks = record(runs);
  const statuses = record(combined);
  const runStates = exactStates(checks?.["check_runs"], checks?.["total_count"], run => {
    const current = status(run["status"]);
    const conclusion = status(run["conclusion"]);
    return current === undefined ? undefined : `check:${current}:${conclusion ?? ""}`;
  });
  const statusStates = exactStates(statuses?.["statuses"], statuses?.["total_count"], context => {
    const current = status(context["state"]);
    return current === undefined ? undefined : `status:${current}`;
  });
  return runStates === undefined || statusStates === undefined ? undefined : [...runStates, ...statusStates].sort();
}

export function githubGraphQlActivity(pull: Readonly<Record<string, unknown>> | undefined): CodeHostPullRequestActivity {
  const commits = record(pull?.["commits"])?.["nodes"];
  const commit = Array.isArray(commits) && commits.length === 1 ? record(record(commits[0])?.["commit"]) : undefined;
  const oid = commit?.["oid"];
  const rollup = commit?.["statusCheckRollup"];
  const contexts = record(rollup)?.["contexts"];
  const checks = rollup === null ? [] : exactStates(record(contexts)?.["nodes"], record(contexts)?.["totalCount"], item => {
    if (item["__typename"] === "StatusContext") {
      const current = status(item["state"]);
      return current === undefined ? undefined : `status:${current}`;
    }
    if (item["__typename"] !== "CheckRun") return undefined;
    const current = status(item["status"]);
    const conclusion = status(item["conclusion"]);
    return current === undefined ? undefined : `check:${current}:${conclusion ?? ""}`;
  });
  const reviewDecision = pull?.["reviewDecision"] === null ? "none" : status(pull?.["reviewDecision"]);
  const mergeState = status(pull?.["mergeStateStatus"]);
  return {
    ...(typeof oid === "string" && /^[a-f0-9]{40}$/u.test(oid) ? { headSha: oid } : {}),
    ...(checks === undefined ? {} : { checks }),
    ...(reviewDecision === undefined ? {} : { reviewDecision }),
    ...(mergeState === undefined || mergeState === "unknown" ? {} : { mergeState })
  };
}

function exactStates(
  nodes: unknown,
  total: unknown,
  stateOf: (node: Readonly<Record<string, unknown>>) => string | undefined
): string[] | undefined {
  if (!Array.isArray(nodes) || nodes.length > MAX_CHECKS || nodes.length !== total) return undefined;
  const states: string[] = [];
  for (const item of nodes) {
    const node = record(item);
    const state = node === undefined ? undefined : stateOf(node);
    if (state === undefined) return undefined;
    states.push(state);
  }
  return states.sort();
}

function status(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z_]{1,40}$/iu.test(value) ? value.toLowerCase() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  TriangleAlert
} from "lucide-react";
import type { JSX } from "react";

import type { CodeHostPullRequestView } from "../model.js";
import type { Translator } from "./types.js";
import { Tip } from "./ui.js";

export function CodeHostPullRequestSummary({
  pullRequests,
  t,
  onOpen,
  onSignIn
}: {
  readonly pullRequests?: readonly CodeHostPullRequestView[];
  readonly t: Translator;
  readonly onOpen?: (url: string) => void;
  readonly onSignIn?: () => void;
}): JSX.Element | null {
  if (pullRequests === undefined || pullRequests.length === 0) return null;
  const first = pullRequests[0]!;
  const label = `${first.webUrl.includes("/-/merge_requests/") ? "!" : "#"}${first.number}`;
  const visible = pullRequests.length === 1
    ? label
    : t("codeHost.pullRequestCount", { label, count: pullRequests.length - 1 });
  const statusTooltip = codeHostPullRequestTooltip(pullRequests, t);
  const tooltip = onSignIn === undefined ? statusTooltip : `${statusTooltip}\n${t("codeHost.signInReason")}`;
  const state = codeHostPullRequestDisplayState(first);
  const StateIcon = codeHostPullRequestStateIcon(state);
  const reviewCount = (state === "open" || state === "draft")
    ? first.projection?.unresolvedReviewThreadCount ?? 0
    : 0;
  const content = <>
    <StateIcon aria-hidden="true" />
    <span>{visible}</span>
    {first.projection?.hasConflicts === true && <span className="code-host-pull-request-summary__reviews" aria-hidden="true"><TriangleAlert /></span>}
    {reviewCount > 0 && <span className="code-host-pull-request-summary__reviews" aria-hidden="true">
      <MessageSquare />
      <span>{reviewCount > 99 ? "99+" : reviewCount}</span>
    </span>}
  </>;
  const summary = onOpen === undefined && onSignIn === undefined
    ? <span className="code-host-pull-request-summary" data-state={state} aria-label={tooltip}>{content}</span>
    : <button
        type="button"
        className="code-host-pull-request-summary"
        data-state={state}
        aria-label={onSignIn === undefined ? `${t("codeHost.openPullRequest", {
          repository: `${first.repositoryOwner}/${first.repositoryName}`,
          number: first.number,
          state: codeHostPullRequestStateLabel(first, t)
        })}${reviewCount > 0 ? ` · ${t("codeHost.unresolvedReviewThreads", { count: reviewCount })}` : ""}`
          : t("codeHost.signInForPullRequest", { number: first.number })}
        onClick={onSignIn ?? (() => onOpen?.(first.webUrl))}
      >{content}</button>;
  return <Tip text={tooltip} preformatted>{summary}</Tip>;
}

export function CodeHostPullRequestSidebarBadge({
  pullRequests,
  t
}: {
  readonly pullRequests?: readonly CodeHostPullRequestView[];
  readonly t: Translator;
}): JSX.Element | null {
  const first = pullRequests?.[0];
  if (first === undefined) return null;
  const state = codeHostPullRequestDisplayState(first);
  const StateIcon = codeHostPullRequestStateIcon(state);
  const reviewCount = (state === "open" || state === "draft")
    ? first.projection?.unresolvedReviewThreadCount ?? 0
    : 0;
  return <span
    className="session-row__code-host"
    data-state={state}
    role="img"
    aria-label={codeHostPullRequestTooltip(pullRequests, t)}
  >
    <StateIcon aria-hidden="true" />
    <span className="session-row__code-host-number" aria-hidden="true">{first.webUrl.includes("/-/merge_requests/") ? "!" : "#"}{first.number}</span>
    {first.projection?.hasConflicts === true && <TriangleAlert aria-hidden="true" />}
    {reviewCount > 0 && <span className="session-row__code-host-review" aria-hidden="true" />}
  </span>;
}

export function codeHostPullRequestTooltip(
  pullRequests: readonly CodeHostPullRequestView[] | undefined,
  t: Translator
): string {
  if (pullRequests === undefined || pullRequests.length === 0) return "";
  return pullRequests.map((pullRequest) => {
    const projection = pullRequest.projection;
    const state = codeHostPullRequestStateLabel(pullRequest, t);
    const reviews = projection?.unresolvedReviewThreadCount !== undefined && projection.unresolvedReviewThreadCount > 0
      ? ` · ${t("codeHost.unresolvedReviewThreads", { count: projection.unresolvedReviewThreadCount })}`
      : "";
    const checks = projection?.checks === undefined || projection.checks.total === 0 ? ""
      : "\n" + t("codeHost.checkCounts", projection.checks);
    return projection === undefined
      ? `${codeHostPullRequestCompactLabel(pullRequest, t)} · ${state}`
      : `${codeHostPullRequestCompactLabel(pullRequest, t)}\n${projection.title}\n${state} · ${projection.headBranch}${reviews}${checks}`;
  }).join("\n");
}

export function codeHostPullRequestDisplayState(
  pullRequest: CodeHostPullRequestView
): "open" | "draft" | "merged" | "closed" | "unavailable" {
  const projection = pullRequest.projection;
  if (projection === undefined) return "unavailable";
  if (projection.state === "merged") return "merged";
  if (projection.state === "closed") return "closed";
  return projection.draft ? "draft" : "open";
}

export function codeHostPullRequestHeadBranchFallback(
  pullRequests: readonly CodeHostPullRequestView[] | undefined
): string | undefined {
  return pullRequests?.find((pullRequest) => pullRequest.projection !== undefined)?.projection?.headBranch;
}

export function codeHostDisplayBranch(
  workspace: { readonly trusted: boolean; readonly branch?: string } | undefined,
  pullRequests: readonly CodeHostPullRequestView[] | undefined
): string | undefined {
  return workspace?.trusted === true && workspace.branch !== undefined && workspace.branch.length > 0
    ? workspace.branch
    : codeHostPullRequestHeadBranchFallback(pullRequests);
}

export function codeHostPullRequestCompactLabel(
  pullRequest: CodeHostPullRequestView,
  t: Translator
): string {
  return t("codeHost.pullRequest", {
    repository: `${pullRequest.repositoryOwner}/${pullRequest.repositoryName}`,
    number: pullRequest.number
  });
}

export function codeHostPullRequestStateLabel(
  pullRequest: CodeHostPullRequestView,
  t: Translator
): string {
  const state = codeHostPullRequestDisplayState(pullRequest);
  if (state === "merged") return t("codeHost.statusMerged");
  if (state === "draft") return t("codeHost.statusDraft");
  if (state === "open") return t(pullRequest.projection?.hasConflicts === true ? "codeHost.mergeConflicts" : "codeHost.statusOpen");
  if (state === "closed") return t("codeHost.statusClosed");
  return t("codeHost.statusUnavailable");
}

function codeHostPullRequestStateIcon(
  state: ReturnType<typeof codeHostPullRequestDisplayState>
): typeof GitPullRequest {
  if (state === "draft") return GitPullRequestDraft;
  if (state === "merged") return GitMerge;
  if (state === "closed") return GitPullRequestClosed;
  return GitPullRequest;
}

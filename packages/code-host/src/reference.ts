import type { CodeHostPullRequestReference } from "./types.js";

const URL_CANDIDATE = /https:\/\/[^\s<>\[\]{}"']+/giu;
const SAFE_REPOSITORY_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u;
const MAX_REFERENCE_COUNT = 16;
const MAX_CHANGE_NUMBER = 2_147_483_647;

/** Extract a bounded, de-duplicated set without retaining the source text. */
export function extractCodeHostPullRequestReferences(
  context: Iterable<string>
): readonly CodeHostPullRequestReference[] {
  const references = new Map<string, CodeHostPullRequestReference>();
  for (const text of context) {
    if (typeof text !== "string" || text.length === 0) continue;
    for (const match of text.matchAll(URL_CANDIDATE)) {
      const candidate = trimTrailingPunctuation(match[0]);
      const reference = parseCodeHostPullRequestReference(candidate);
      if (reference === undefined || references.has(reference.key)) continue;
      references.set(reference.key, reference);
      if (references.size >= MAX_REFERENCE_COUNT) return [...references.values()];
    }
  }
  return [...references.values()];
}

export function parseCodeHostPullRequestReference(
  candidate: string
): CodeHostPullRequestReference | undefined {
  if (candidate.length === 0 || candidate.length > 2_048) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
  ) return undefined;
  const host = url.host.toLocaleLowerCase("en-US");
  if (host.length === 0 || host.length > 255 || /[\u0000-\u001f\u007f]/u.test(host)) return undefined;
  const segments = url.pathname.replace(/\/$/u, "").slice(1).split("/");
  const parsed = pullRequestPath(segments, host);
  if (parsed === undefined) return undefined;
  if (host !== "github.com" && parsed.kind === "pull" && (url.search !== "" || url.hash !== "")) return undefined;
  const owner = parsed.owner.map(decodeRepositorySegment);
  const repository = decodeRepositorySegment(parsed.repository);
  if (owner.some(segment => segment === undefined) || repository === undefined) return undefined;
  if (!/^[1-9][0-9]{0,9}$/u.test(parsed.number)) return undefined;
  const number = Number(parsed.number);
  if (!Number.isSafeInteger(number) || number > MAX_CHANGE_NUMBER) return undefined;
  const githubPullRequest = host === "github.com" && parsed.kind === "pull";
  const repositoryOwner = githubPullRequest ? owner.join("/").toLowerCase() : owner.join("/");
  const repositoryName = githubPullRequest ? repository.toLowerCase() : repository;
  const key = codeHostPullRequestReferenceKey({ host, repositoryOwner, repositoryName, number });
  if (key.length > 512) return undefined;
  return {
    key,
    host,
    repositoryOwner,
    repositoryName,
    number,
    webUrl: canonicalWebUrl(host, repositoryOwner, repositoryName, number, parsed.kind)
  };
}

export function codeHostPullRequestReferenceKey(
  reference: Pick<CodeHostPullRequestReference, "host" | "repositoryOwner" | "repositoryName" | "number">
): string {
  return `${reference.host.toLocaleLowerCase("en-US")}/${reference.repositoryOwner}/${reference.repositoryName}#${reference.number}`;
}

function pullRequestPath(segments: readonly string[], host: string): {
  readonly owner: readonly string[];
  readonly repository: string;
  readonly number: string;
  readonly kind: "pull" | "merge-request";
} | undefined {
  if ((segments[2] === "pull" || segments[2] === "pulls")
    && (segments.length === 4 || host === "github.com" && segments.length === 5 && ["files", "commits", "checks"].includes(segments[4]!))) {
    return { owner: [segments[0]!], repository: segments[1]!, number: segments[3]!, kind: "pull" };
  }
  const separator = segments.indexOf("-");
  if (isCodeHostGitLabHostname(host) && separator >= 2 && segments[separator + 1] === "merge_requests"
    && (segments.length === separator + 3 || segments.length === separator + 4
      && ["diffs", "commits", "pipelines"].includes(segments[separator + 3]!))) {
    return { owner: segments.slice(0, separator - 1), repository: segments[separator - 1]!,
      number: segments[separator + 2]!, kind: "merge-request" };
  }
  if (isCodeHostGitLabHostname(host) && segments.length === 4 && segments[2] === "merge_requests") {
    return { owner: [segments[0]!], repository: segments[1]!, number: segments[3]!, kind: "merge-request" };
  }
  return undefined;
}

function isCodeHostGitLabHostname(host: string): boolean {
  return host !== "github.com" && /^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/iu.test(host);
}

function canonicalWebUrl(
  host: string,
  repositoryOwner: string,
  repositoryName: string,
  number: number,
  kind: "pull" | "merge-request"
): string {
  const owner = repositoryOwner.split("/").map(encodeURIComponent).join("/");
  const repository = encodeURIComponent(repositoryName);
  const path = kind === "pull"
    ? `/${owner}/${repository}/pull/${number}`
    : `/${owner}/${repository}/-/merge_requests/${number}`;
  return new URL(path, `https://${host}`).href;
}

function decodeRepositorySegment(value: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  return SAFE_REPOSITORY_SEGMENT.test(decoded) ? decoded : undefined;
}

function trimTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && /[.,;:!?]/u.test(value[end - 1] ?? "")) end -= 1;
  while (end > 0 && value[end - 1] === ")") {
    const prefix = value.slice(0, end);
    const opens = [...prefix].filter((character) => character === "(").length;
    const closes = [...prefix].filter((character) => character === ")").length;
    if (closes <= opens) break;
    end -= 1;
  }
  return value.slice(0, end);
}

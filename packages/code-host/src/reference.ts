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
    || url.search !== ""
    || url.hash !== ""
  ) return undefined;
  const host = url.host.toLocaleLowerCase("en-US");
  if (host.length === 0 || host.length > 255 || /[\u0000-\u001f\u007f]/u.test(host)) return undefined;
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const parsed = pullRequestPath(segments);
  if (parsed === undefined) return undefined;
  const repositoryOwner = decodeRepositorySegment(parsed.owner);
  const repositoryName = decodeRepositorySegment(parsed.repository);
  if (repositoryOwner === undefined || repositoryName === undefined) return undefined;
  if (!/^[1-9][0-9]{0,9}$/u.test(parsed.number)) return undefined;
  const number = Number(parsed.number);
  if (!Number.isSafeInteger(number) || number > MAX_CHANGE_NUMBER) return undefined;
  return {
    key: codeHostPullRequestReferenceKey({ host, repositoryOwner, repositoryName, number }),
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

function pullRequestPath(segments: readonly string[]): {
  readonly owner: string;
  readonly repository: string;
  readonly number: string;
  readonly kind: "pull" | "merge-request";
} | undefined {
  if (segments.length === 4 && (segments[2] === "pull" || segments[2] === "pulls")) {
    return { owner: segments[0]!, repository: segments[1]!, number: segments[3]!, kind: "pull" };
  }
  if (segments.length === 5 && segments[2] === "-" && segments[3] === "merge_requests") {
    return { owner: segments[0]!, repository: segments[1]!, number: segments[4]!, kind: "merge-request" };
  }
  if (segments.length === 4 && segments[2] === "merge_requests") {
    return { owner: segments[0]!, repository: segments[1]!, number: segments[3]!, kind: "merge-request" };
  }
  return undefined;
}

function canonicalWebUrl(
  host: string,
  repositoryOwner: string,
  repositoryName: string,
  number: number,
  kind: "pull" | "merge-request"
): string {
  const owner = encodeURIComponent(repositoryOwner);
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

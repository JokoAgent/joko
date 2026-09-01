import {
  CODE_HOST_PULL_REQUEST_CAPABILITY,
  CodeHostProviderRetryableError,
  CodeHostPullRequestNotFoundError,
  type CodeHostProvider,
  type CodeHostProviderResult,
  type CodeHostPullRequestReference
} from "./types.js";
import { codeHostPullRequestReferenceKey } from "./reference.js";
import { boundedCodeHostHeadBranch, boundedCodeHostPullRequestTitle } from "./validation.js";

const PUBLIC_REFERENCE_HOST = "github.com";
const PUBLIC_API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "Joko-Code-Host/0.1";
const MAXIMUM_CHANGE_NUMBER = 2_147_483_647;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const PUBLIC_PROJECTION_TTL_MS = 60 * 60_000;
const DEFAULT_PULL_REQUEST_BODY_BYTES = 256 * 1024;
const REPOSITORY_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u;

type FetchPort = typeof globalThis.fetch;

export interface PublicCodeHostProviderOptions {
  readonly fetch?: FetchPort;
  readonly requestTimeoutMs?: number;
  readonly maximumPullRequestBodyBytes?: number;
  readonly now?: () => number;
}

/**
 * Credential-free production adapter for public pull requests on one fixed host.
 * The destination origin and every path segment are derived from a validated
 * reference; redirects, ambient credentials, and response bodies over the
 * configured limits are rejected.
 *
 * Private repositories and exact review-thread resolution deliberately remain
 * outside this adapter. Anonymous REST does not expose reviewThreads.isResolved.
 */
export class PublicCodeHostProvider implements CodeHostProvider {
  readonly capability = CODE_HOST_PULL_REQUEST_CAPABILITY;
  readonly minimumTimeToLiveMs = PUBLIC_PROJECTION_TTL_MS;
  readonly #fetch: FetchPort;
  readonly #requestTimeoutMs: number;
  readonly #maximumPullRequestBodyBytes: number;
  readonly #now: () => number;

  constructor(options: PublicCodeHostProviderOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#requestTimeoutMs = boundedPositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      60_000,
      "request timeout"
    );
    this.#maximumPullRequestBodyBytes = boundedPositiveInteger(
      options.maximumPullRequestBodyBytes ?? DEFAULT_PULL_REQUEST_BODY_BYTES,
      2 * 1024 * 1024,
      "pull request response limit"
    );
  }

  supports(reference: CodeHostPullRequestReference): boolean {
    return isSupportedPublicReference(reference);
  }

  async getPullRequest(
    reference: CodeHostPullRequestReference,
    options: { readonly signal: AbortSignal; readonly sessionOwnerId: string }
  ): Promise<CodeHostProviderResult> {
    if (!isSupportedPublicReference(reference)) {
      throw new TypeError("The public code-host reference is outside the outbound policy.");
    }
    if (typeof options.sessionOwnerId !== "string" || options.sessionOwnerId.trim() === "") {
      throw new TypeError("The code-host Session owner is invalid.");
    }
    const request = combinedAbortSignal(options.signal, this.#requestTimeoutMs);
    try {
      const pullRequest = await this.#readJson(
        publicApiUrl(reference),
        request.signal,
        this.#maximumPullRequestBodyBytes
      );
      return parsePullRequest(pullRequest);
    } finally {
      request.dispose();
    }
  }

  async #readJson(url: URL, signal: AbortSignal, maximumBytes: number): Promise<unknown> {
    assertPublicApiUrl(url);
    const response = await this.#fetch(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
        "x-github-api-version": API_VERSION
      },
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal
    });
    if (response.status === 404) throw new CodeHostPullRequestNotFoundError();
    if (response.status === 403 || response.status === 429) {
      throw new CodeHostProviderRetryableError(retryAfterMs(response.headers, this.#now()));
    }
    if (!response.ok) throw new Error("The public code-host request failed.");
    const contentType = response.headers.get("content-type")?.toLocaleLowerCase("en-US") ?? "";
    if (!contentType.startsWith("application/json")) {
      throw new Error("The public code-host response is not JSON.");
    }
    return readBoundedJson(response, maximumBytes);
  }
}

export function createPublicCodeHostProvider(
  options: PublicCodeHostProviderOptions = {}
): CodeHostProvider {
  return new PublicCodeHostProvider(options);
}

export function isSupportedPublicReference(reference: CodeHostPullRequestReference): boolean {
  if (
    reference.host !== PUBLIC_REFERENCE_HOST
    || !REPOSITORY_OWNER.test(reference.repositoryOwner)
    || !REPOSITORY_NAME.test(reference.repositoryName)
    || !Number.isSafeInteger(reference.number)
    || reference.number < 1
    || reference.number > MAXIMUM_CHANGE_NUMBER
  ) return false;
  return reference.key === codeHostPullRequestReferenceKey(reference)
    && reference.webUrl === publicWebUrl(reference);
}

function publicWebUrl(reference: CodeHostPullRequestReference): string {
  return `https://${PUBLIC_REFERENCE_HOST}/${encodeURIComponent(reference.repositoryOwner)}/${encodeURIComponent(reference.repositoryName)}/pull/${reference.number}`;
}

function publicApiUrl(reference: CodeHostPullRequestReference): URL {
  const owner = encodeURIComponent(reference.repositoryOwner);
  const repository = encodeURIComponent(reference.repositoryName);
  const url = new URL(`/repos/${owner}/${repository}/pulls/${reference.number}`, PUBLIC_API_ORIGIN);
  assertPublicApiUrl(url);
  return url;
}

function assertPublicApiUrl(url: URL): void {
  if (
    url.origin !== PUBLIC_API_ORIGIN
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || !/^\/repos\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pulls\/[1-9][0-9]{0,9}$/u.test(url.pathname)
    || url.search !== ""
  ) throw new Error("The public code-host destination is outside the outbound policy.");
}

function parsePullRequest(value: unknown): Pick<CodeHostProviderResult, "state" | "draft" | "title" | "headBranch"> {
  const record = objectValue(value);
  const state = record?.["state"];
  const draft = record?.["draft"];
  const merged = record?.["merged"];
  const mergedAt = record?.["merged_at"];
  const title = boundedCodeHostPullRequestTitle(record?.["title"]);
  const headBranch = boundedCodeHostHeadBranch(objectValue(record?.["head"])?.["ref"]);
  if (
    (state !== "open" && state !== "closed")
    || typeof draft !== "boolean"
    || typeof merged !== "boolean"
    || (mergedAt !== null && typeof mergedAt !== "string")
    || title === undefined
    || headBranch === undefined
  ) throw new Error("The public code-host pull request response is invalid.");
  return {
    state: merged || (typeof mergedAt === "string" && mergedAt.length > 0)
      ? "merged"
      : state,
    draft,
    title,
    headBranch
  };
}


function retryAfterMs(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter !== undefined && retryAfter !== "") {
    if (/^[1-9][0-9]{0,4}$/u.test(retryAfter)) {
      return Math.min(Number(retryAfter) * 1_000, 86_400_000);
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at) && at > now) return Math.min(Math.ceil(at - now), 86_400_000);
  }
  const reset = headers.get("x-ratelimit-reset")?.trim();
  if (reset !== undefined && /^[1-9][0-9]{0,10}$/u.test(reset)) {
    const at = Number(reset) * 1_000;
    if (Number.isSafeInteger(at) && at > now) return Math.min(at - now, 86_400_000);
  }
  return undefined;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      throw new Error("The public code-host response exceeds the body limit.");
    }
  }
  if (response.body === null) throw new Error("The public code-host response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("The public code-host response exceeds the body limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("The public code-host response is not valid UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("The public code-host response is not valid JSON.");
  }
}

function combinedAbortSignal(parent: AbortSignal, timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const forward = (): void => controller.abort(parent.reason);
  if (parent.aborted) forward(); else parent.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("The public code-host request timed out.")), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", forward);
    }
  };
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`The public code-host ${label} is invalid.`);
  }
  return value;
}

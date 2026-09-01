import {
  CODE_HOST_PULL_REQUEST_CAPABILITY,
  CodeHostProviderRetryableError,
  CodeHostProviderUnavailableError,
  CodeHostPullRequestNotFoundError,
  type CodeHostProvider,
  type CodeHostProviderResult,
  type CodeHostPullRequestReference
} from "./types.js";
import {
  createGhCliTokenSource,
  type GhCliCredentialLease,
  type GhCliTokenSource
} from "./gh-cli-token-source.js";
import { isSupportedPublicReference } from "./public-provider.js";
import { boundedCodeHostHeadBranch, boundedCodeHostPullRequestTitle } from "./validation.js";

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "Joko-Code-Host/0.1";
const AUTHENTICATED_PROJECTION_TTL_MS = 60_000;
const DEFAULT_REST_TIMEOUT_MS = 10_000;
const DEFAULT_GRAPHQL_TIMEOUT_MS = 3_000;
const DEFAULT_REST_BODY_BYTES = 256 * 1024;
const DEFAULT_GRAPHQL_BODY_BYTES = 256 * 1024;
const MAXIMUM_REVIEW_THREADS = 100;

const UNRESOLVED_REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { isResolved }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

type FetchPort = typeof globalThis.fetch;

export interface CodeHostSessionAuthorization {
  readonly sessionOwnerId: string;
  readonly referenceKey: string;
  readonly ownerRevision: string;
}

/** Orchestrator-owned port that fences a reference to its current durable Session owner. */
export interface CodeHostSessionAuthorizationPort {
  authorize(
    sessionOwnerId: string,
    reference: CodeHostPullRequestReference
  ): CodeHostSessionAuthorization | undefined;
  isCurrent(
    authorization: CodeHostSessionAuthorization,
    reference: CodeHostPullRequestReference
  ): boolean;
}

export interface CodeHostCredentialSource {
  readCredential(): Promise<GhCliCredentialLease | undefined>;
  isCurrent(credential: GhCliCredentialLease): boolean;
}

export interface AuthenticatedCodeHostProviderOptions {
  readonly authorization: CodeHostSessionAuthorizationPort;
  readonly credentialSource?: CodeHostCredentialSource;
  readonly fetch?: FetchPort;
  readonly restTimeoutMs?: number;
  readonly graphQlTimeoutMs?: number;
  readonly maximumRestBodyBytes?: number;
  readonly maximumGraphQlBodyBytes?: number;
  readonly now?: () => number;
}

/** Owner-fenced authenticated adapter for private and public pull requests. */
export class AuthenticatedCodeHostProvider implements CodeHostProvider {
  readonly capability = CODE_HOST_PULL_REQUEST_CAPABILITY;
  readonly minimumTimeToLiveMs = AUTHENTICATED_PROJECTION_TTL_MS;
  readonly #authorization: CodeHostSessionAuthorizationPort;
  readonly #credentialSource: CodeHostCredentialSource;
  readonly #fetch: FetchPort;
  readonly #restTimeoutMs: number;
  readonly #graphQlTimeoutMs: number;
  readonly #maximumRestBodyBytes: number;
  readonly #maximumGraphQlBodyBytes: number;
  readonly #now: () => number;

  constructor(options: AuthenticatedCodeHostProviderOptions) {
    this.#authorization = options.authorization;
    this.#credentialSource = options.credentialSource ?? createGhCliTokenSource();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#restTimeoutMs = boundedPositiveInteger(options.restTimeoutMs ?? DEFAULT_REST_TIMEOUT_MS, 60_000, "REST timeout");
    this.#graphQlTimeoutMs = boundedPositiveInteger(options.graphQlTimeoutMs ?? DEFAULT_GRAPHQL_TIMEOUT_MS, 60_000, "GraphQL timeout");
    this.#maximumRestBodyBytes = boundedPositiveInteger(options.maximumRestBodyBytes ?? DEFAULT_REST_BODY_BYTES, 2 * 1024 * 1024, "REST response limit");
    this.#maximumGraphQlBodyBytes = boundedPositiveInteger(options.maximumGraphQlBodyBytes ?? DEFAULT_GRAPHQL_BODY_BYTES, 2 * 1024 * 1024, "GraphQL response limit");
    this.#now = options.now ?? Date.now;
  }

  supports(reference: CodeHostPullRequestReference): boolean {
    return isSupportedPublicReference(reference);
  }

  async getPullRequest(
    reference: CodeHostPullRequestReference,
    options: { readonly signal: AbortSignal; readonly sessionOwnerId: string }
  ): Promise<CodeHostProviderResult> {
    if (!isSupportedPublicReference(reference)) {
      throw new TypeError("The authenticated code-host reference is outside the outbound policy.");
    }
    let authorization: CodeHostSessionAuthorization | undefined;
    try {
      authorization = this.#authorization.authorize(options.sessionOwnerId, reference);
    } catch {
      throw new Error("The code-host Session authorization is invalid.");
    }
    if (authorization === undefined) throw new Error("The code-host Session authorization is invalid.");
    let credential: GhCliCredentialLease | undefined;
    try {
      credential = await this.#credentialSource.readCredential();
    } catch {
      throw new CodeHostProviderRetryableError();
    }
    if (credential === undefined) throw new CodeHostProviderUnavailableError();
    assertCredential(credential);
    this.#assertFences(authorization, credential, reference);

    const graphQl = this.#readUnresolvedReviewThreadCount(reference, credential, options.signal)
      .catch((error: unknown) => {
        if (options.signal.aborted) throw options.signal.reason ?? error;
        return undefined;
      });
    const result = await this.#readPullRequest(reference, credential, options.signal);
    const unresolvedReviewThreadCount = await graphQl;
    this.#assertFences(authorization, credential, reference);
    return {
      ...result,
      ...(unresolvedReviewThreadCount === undefined ? {} : { unresolvedReviewThreadCount })
    };
  }

  async #readPullRequest(
    reference: CodeHostPullRequestReference,
    credential: GhCliCredentialLease,
    signal: AbortSignal
  ): Promise<Pick<CodeHostProviderResult, "state" | "draft" | "title" | "headBranch">> {
    const request = combinedAbortSignal(signal, this.#restTimeoutMs, "REST");
    try {
      let response: Response;
      try {
        response = await this.#fetch(restApiUrl(reference), {
          method: "GET",
          headers: authenticatedHeaders(credential.token, false),
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: request.signal
        });
      } catch {
        if (request.signal.aborted) throw request.signal.reason ?? new Error("The authenticated code-host REST request was aborted.");
        throw new Error("The authenticated code-host REST request failed.");
      }
      if (response.status === 404) throw new CodeHostPullRequestNotFoundError();
      if (response.status === 403 || response.status === 429 || response.status >= 500) {
        throw new CodeHostProviderRetryableError(retryAfterMs(response.headers, this.#now()));
      }
      if (!response.ok) throw new Error("The authenticated code-host REST request failed.");
      assertJsonResponse(response);
      return parsePullRequest(await readBoundedJson(response, this.#maximumRestBodyBytes));
    } finally {
      request.dispose();
    }
  }

  async #readUnresolvedReviewThreadCount(
    reference: CodeHostPullRequestReference,
    credential: GhCliCredentialLease,
    signal: AbortSignal
  ): Promise<number> {
    const request = combinedAbortSignal(signal, this.#graphQlTimeoutMs, "GraphQL");
    try {
      const body = JSON.stringify({
        query: UNRESOLVED_REVIEW_THREADS_QUERY,
        variables: {
          owner: reference.repositoryOwner,
          repo: reference.repositoryName,
          number: reference.number
        }
      });
      const url = new URL("/graphql", API_ORIGIN);
      assertApiUrl(url, "graphql");
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: "POST",
          headers: authenticatedHeaders(credential.token, true),
          body,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: request.signal
        });
      } catch {
        if (request.signal.aborted) throw request.signal.reason ?? new Error("The authenticated code-host GraphQL request was aborted.");
        throw new Error("The authenticated code-host GraphQL request failed.");
      }
      if (!response.ok) throw new Error("The authenticated code-host GraphQL request failed.");
      assertJsonResponse(response);
      return parseUnresolvedReviewThreadCount(await readBoundedJson(response, this.#maximumGraphQlBodyBytes));
    } finally {
      request.dispose();
    }
  }

  #assertFences(
    authorization: CodeHostSessionAuthorization,
    credential: GhCliCredentialLease,
    reference: CodeHostPullRequestReference
  ): void {
    let current = false;
    try {
      current = this.#credentialSource.isCurrent(credential)
        && this.#authorization.isCurrent(authorization, reference);
    } catch {
      current = false;
    }
    if (!current) throw new Error("The code-host authorization changed during the request.");
  }
}

export function createAuthenticatedCodeHostProvider(
  options: AuthenticatedCodeHostProviderOptions
): CodeHostProvider {
  return new AuthenticatedCodeHostProvider(options);
}

function authenticatedHeaders(token: string, graphQl: boolean): Headers {
  if (token.length === 0 || token.length > 8 * 1024 || !/^[\x21-\x7e]+$/u.test(token)) {
    throw new Error("The code-host credential is invalid.");
  }
  const headers = new Headers({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": USER_AGENT,
    "x-github-api-version": API_VERSION
  });
  if (graphQl) headers.set("content-type", "application/json");
  return headers;
}

function assertCredential(credential: GhCliCredentialLease): void {
  if (!Number.isSafeInteger(credential.generation) || credential.generation < 1) {
    throw new Error("The code-host credential generation is invalid.");
  }
  authenticatedHeaders(credential.token, false);
}

function restApiUrl(reference: CodeHostPullRequestReference): URL {
  const url = new URL(
    `/repos/${encodeURIComponent(reference.repositoryOwner)}/${encodeURIComponent(reference.repositoryName)}/pulls/${reference.number}`,
    API_ORIGIN
  );
  assertApiUrl(url, "rest");
  return url;
}

function assertApiUrl(url: URL, kind: "rest" | "graphql"): void {
  const validPath = kind === "graphql"
    ? url.pathname === "/graphql"
    : /^\/repos\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pulls\/[1-9][0-9]{0,9}$/u.test(url.pathname);
  if (
    url.origin !== API_ORIGIN
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || url.search !== ""
    || !validPath
  ) throw new Error("The authenticated code-host destination is outside the outbound policy.");
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
  ) throw new Error("The authenticated code-host pull request response is invalid.");
  return {
    state: merged || (typeof mergedAt === "string" && mergedAt.length > 0) ? "merged" : state,
    draft,
    title,
    headBranch
  };
}

function parseUnresolvedReviewThreadCount(value: unknown): number {
  const root = objectValue(value);
  if (root === undefined || root["errors"] !== undefined) {
    throw new Error("The authenticated code-host GraphQL response is invalid.");
  }
  const data = objectValue(root["data"]);
  const repository = objectValue(data?.["repository"]);
  const pullRequest = objectValue(repository?.["pullRequest"]);
  const reviewThreads = objectValue(pullRequest?.["reviewThreads"]);
  const nodes = reviewThreads?.["nodes"];
  const hasNextPage = objectValue(reviewThreads?.["pageInfo"])?.["hasNextPage"];
  if (
    !Array.isArray(nodes)
    || nodes.length > MAXIMUM_REVIEW_THREADS
    || hasNextPage !== false
  ) {
    throw new Error("The authenticated code-host GraphQL response is invalid.");
  }
  let unresolved = 0;
  for (const node of nodes) {
    const isResolved = objectValue(node)?.["isResolved"];
    if (typeof isResolved !== "boolean") {
      throw new Error("The authenticated code-host GraphQL response is invalid.");
    }
    if (!isResolved) unresolved += 1;
  }
  return unresolved;
}

function assertJsonResponse(response: Response): void {
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLocaleLowerCase("en-US") ?? "";
  if (response.redirected || contentType !== "application/json") {
    throw new Error("The authenticated code-host response is not JSON.");
  }
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      throw new Error("The authenticated code-host response exceeds the body limit.");
    }
  }
  if (response.body === null) throw new Error("The authenticated code-host response is empty.");
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
        throw new Error("The authenticated code-host response exceeds the body limit.");
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
    throw new Error("The authenticated code-host response is not valid UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("The authenticated code-host response is not valid JSON.");
  }
}

function combinedAbortSignal(parent: AbortSignal, timeoutMs: number, operation: string): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const forward = (): void => controller.abort(parent.reason);
  if (parent.aborted) forward(); else parent.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`The authenticated code-host ${operation} request timed out.`)),
    timeoutMs
  );
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", forward);
    }
  };
}

function retryAfterMs(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter !== undefined && retryAfter !== "") {
    if (/^[1-9][0-9]{0,4}$/u.test(retryAfter)) return Math.min(Number(retryAfter) * 1_000, 86_400_000);
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

function objectValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`The authenticated code-host ${label} is invalid.`);
  }
  return value;
}

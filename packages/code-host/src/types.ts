export const CODE_HOST_PULL_REQUEST_CAPABILITY = "code-host.pull-request" as const;
export const CODE_HOST_SESSION_PROJECTION_SCHEMA_VERSION = 1 as const;
export const CODE_HOST_PULL_REQUEST_TITLE_MAX_LENGTH = 512;
export const CODE_HOST_PULL_REQUEST_HEAD_BRANCH_MAX_LENGTH = 255;

export type CodeHostPullRequestState = "open" | "closed" | "merged";

/** Credential-free, normalized identity extracted from user-visible task context. */
export interface CodeHostPullRequestReference {
  readonly key: string;
  readonly host: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly number: number;
  readonly webUrl: string;
}

/** Bounded facts returned by a capability-owned code-host provider. */
export interface CodeHostPullRequestProjection {
  readonly state: CodeHostPullRequestState;
  readonly draft: boolean;
  readonly title: string;
  readonly headBranch: string;
  /** Exact GraphQL review-thread count. Absent when authentication or GraphQL is unavailable. */
  readonly unresolvedReviewThreadCount?: number;
  readonly observedAt: number;
}

export interface CodeHostSessionReferenceProjection {
  readonly reference: CodeHostPullRequestReference;
  readonly projection?: CodeHostPullRequestProjection;
  readonly freshUntil?: number;
  /** A negative-cache fence. An older successful projection, if any, remains untouched. */
  readonly notFoundUntil?: number;
  /** Service-private transient failure/rate-limit fence; never projected to clients. */
  readonly retryAfterUntil?: number;
}

export interface CodeHostSessionProjection {
  readonly schemaVersion: typeof CODE_HOST_SESSION_PROJECTION_SCHEMA_VERSION;
  readonly sessionOwnerId: string;
  readonly references: readonly CodeHostSessionReferenceProjection[];
}

export interface CodeHostProviderResult {
  readonly state: CodeHostPullRequestState;
  readonly draft: boolean;
  readonly title: string;
  readonly headBranch: string;
  readonly unresolvedReviewThreadCount?: number;
}

/**
 * Implementations own credential resolution and outbound policy. Callers never pass
 * tokens, ambient environment values, Backend IDs, or raw message content.
 */
export interface CodeHostProvider {
  readonly capability: typeof CODE_HOST_PULL_REQUEST_CAPABILITY;
  /** Provider-specific lower bound between outbound reads for any result. */
  readonly minimumTimeToLiveMs?: number;
  supports(reference: CodeHostPullRequestReference): boolean;
  getPullRequest(
    reference: CodeHostPullRequestReference,
    options: {
      readonly signal: AbortSignal;
      /** Opaque product owner used to resolve an owner-scoped credential reference. */
      readonly sessionOwnerId: string;
    }
  ): Promise<CodeHostProviderResult>;
}

export interface CodeHostProjectionRepository {
  read(sessionOwnerId: string): CodeHostSessionProjection | undefined;
  write(projection: CodeHostSessionProjection): void;
}

export class CodeHostPullRequestNotFoundError extends Error {
  constructor() {
    super("The code-host pull request was not found.");
    this.name = "CodeHostPullRequestNotFoundError";
  }
}

export class CodeHostProviderRetryableError extends Error {
  readonly retryAfterMs?: number;

  constructor(retryAfterMs?: number) {
    super("The code-host provider is temporarily unavailable.");
    this.name = "CodeHostProviderRetryableError";
    if (retryAfterMs !== undefined) {
      if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 1 || retryAfterMs > 86_400_000) {
        throw new RangeError("The code-host retry delay is invalid.");
      }
      this.retryAfterMs = retryAfterMs;
    }
  }
}

/** The provider has no usable owner-scoped credential; coordinators may try the next provider. */
export class CodeHostProviderUnavailableError extends Error {
  constructor() {
    super("The code-host provider is unavailable for this owner.");
    this.name = "CodeHostProviderUnavailableError";
  }
}

import {
  reconcileCodeHostSessionReferences,
  sameCodeHostSessionProjection
} from "./projection.js";
import {
  CODE_HOST_PULL_REQUEST_CAPABILITY,
  CodeHostProviderRetryableError,
  CodeHostProviderUnavailableError,
  CodeHostPullRequestNotFoundError,
  type CodeHostProjectionRepository,
  type CodeHostProvider,
  type CodeHostProviderResult,
  type CodeHostPullRequestReference,
  type CodeHostSessionProjection,
  type CodeHostSessionReferenceProjection
} from "./types.js";
import { boundedCodeHostHeadBranch, boundedCodeHostPullRequestTitle } from "./validation.js";

export interface CodeHostProjectionCoordinatorOptions {
  readonly repository: CodeHostProjectionRepository;
  readonly providers?: readonly CodeHostProvider[];
  readonly now?: () => number;
  readonly timeToLiveMs?: number;
  readonly notFoundTimeToLiveMs?: number;
  readonly failureTimeToLiveMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface CodeHostProjectionRefreshResult {
  readonly projection: CodeHostSessionProjection;
  readonly changed: boolean;
}

export class CodeHostProjectionCoordinator {
  private readonly repository: CodeHostProjectionRepository;
  private readonly providers: readonly CodeHostProvider[];
  private readonly now: () => number;
  private readonly timeToLiveMs: number;
  private readonly notFoundTimeToLiveMs: number;
  private readonly failureTimeToLiveMs: number;
  private readonly requestTimeoutMs: number;
  private readonly sessionInflight = new Map<string, Promise<CodeHostProjectionRefreshResult>>();

  constructor(options: CodeHostProjectionCoordinatorOptions) {
    this.repository = options.repository;
    this.providers = options.providers ?? [];
    for (const provider of this.providers) {
      if (provider.capability !== CODE_HOST_PULL_REQUEST_CAPABILITY) {
        throw new Error("The code-host Provider advertises an unsupported capability.");
      }
      if (provider.minimumTimeToLiveMs !== undefined) {
        positiveDuration(provider.minimumTimeToLiveMs, "Provider minimum projection TTL");
      }
    }
    this.now = options.now ?? Date.now;
    this.timeToLiveMs = positiveDuration(options.timeToLiveMs ?? 60_000, "projection TTL");
    this.notFoundTimeToLiveMs = positiveDuration(options.notFoundTimeToLiveMs ?? 30_000, "not-found TTL");
    this.failureTimeToLiveMs = positiveDuration(options.failureTimeToLiveMs ?? 60_000, "failure TTL");
    this.requestTimeoutMs = positiveDuration(options.requestTimeoutMs ?? 15_000, "request timeout");
  }

  refreshSession(
    sessionOwnerId: string,
    references: readonly CodeHostPullRequestReference[]
  ): Promise<CodeHostProjectionRefreshResult> {
    const pending = this.sessionInflight.get(sessionOwnerId);
    if (pending !== undefined) return pending;
    const request = this.refreshSessionUnshared(sessionOwnerId, references).finally(() => {
      if (this.sessionInflight.get(sessionOwnerId) === request) this.sessionInflight.delete(sessionOwnerId);
    });
    this.sessionInflight.set(sessionOwnerId, request);
    return request;
  }

  private async refreshSessionUnshared(
    sessionOwnerId: string,
    references: readonly CodeHostPullRequestReference[]
  ): Promise<CodeHostProjectionRefreshResult> {
    const before = this.repository.read(sessionOwnerId);
    let current = reconcileCodeHostSessionReferences(before, sessionOwnerId, references);
    let changed = !sameCodeHostSessionProjection(before, current);
    if (changed) this.repository.write(current);

    for (const entry of current.references) {
      const refreshed = await this.refreshReference(sessionOwnerId, entry);
      if (refreshed === entry) continue;
      current = {
        ...current,
        references: current.references.map((candidate) => candidate.reference.key === entry.reference.key ? refreshed : candidate)
      };
      this.repository.write(current);
      changed = true;
    }
    return { projection: current, changed };
  }

  private async refreshReference(
    sessionOwnerId: string,
    entry: CodeHostSessionReferenceProjection
  ): Promise<CodeHostSessionReferenceProjection> {
    const observedAt = this.now();
    if (
      (entry.freshUntil ?? 0) > observedAt
      || (entry.notFoundUntil ?? 0) > observedAt
      || (entry.retryAfterUntil ?? 0) > observedAt
    ) return entry;
    const providers = this.supportingProviders(entry.reference);
    if (providers.length === 0) return entry;
    let provider: CodeHostProvider | undefined;
    try {
      let result: CodeHostProviderResult | undefined;
      for (const candidate of providers) {
        try {
          result = await withTimeout(
            (signal) => candidate.getPullRequest(entry.reference, { signal, sessionOwnerId }),
            this.requestTimeoutMs
          );
          provider = candidate;
          break;
        } catch (error) {
          if (error instanceof CodeHostProviderUnavailableError) continue;
          provider = candidate;
          throw error;
        }
      }
      if (result === undefined || provider === undefined) return entry;
      const projection = validatedProviderResult(result, observedAt);
      const timeToLiveMs = Math.max(this.timeToLiveMs, provider.minimumTimeToLiveMs ?? 0);
      return {
        reference: entry.reference,
        projection,
        freshUntil: observedAt + timeToLiveMs
      };
    } catch (error) {
      const minimumTimeToLiveMs = provider?.minimumTimeToLiveMs ?? 0;
      if (error instanceof CodeHostPullRequestNotFoundError) {
        return {
          reference: entry.reference,
          ...(entry.projection === undefined ? {} : { projection: entry.projection }),
          notFoundUntil: observedAt + Math.max(
            this.notFoundTimeToLiveMs,
            minimumTimeToLiveMs
          )
        };
      }
      const requestedDelay = error instanceof CodeHostProviderRetryableError
        ? error.retryAfterMs ?? 0
        : 0;
      return {
        reference: entry.reference,
        ...(entry.projection === undefined ? {} : { projection: entry.projection }),
        retryAfterUntil: observedAt + Math.max(
          this.failureTimeToLiveMs,
          requestedDelay,
          minimumTimeToLiveMs
        )
      };
    }
  }

  private supportingProviders(reference: CodeHostPullRequestReference): CodeHostProvider[] {
    const supporting: CodeHostProvider[] = [];
    for (const provider of this.providers) {
      try {
        if (provider.supports(reference)) supporting.push(provider);
      } catch {
        // A broken capability probe is isolated like any other provider fault.
      }
    }
    return supporting;
  }
}

function validatedProviderResult(
  value: CodeHostProviderResult,
  observedAt: number
): CodeHostSessionReferenceProjection["projection"] {
  if (value.state !== "open" && value.state !== "closed" && value.state !== "merged") {
    throw new Error("The code-host Provider returned an invalid pull request state.");
  }
  const title = boundedCodeHostPullRequestTitle(value.title);
  const headBranch = boundedCodeHostHeadBranch(value.headBranch);
  if (
    typeof value.draft !== "boolean"
    || title === undefined
    || headBranch === undefined
    || (value.unresolvedReviewThreadCount !== undefined && (
      !Number.isSafeInteger(value.unresolvedReviewThreadCount)
      || value.unresolvedReviewThreadCount < 0
      || value.unresolvedReviewThreadCount > 100
    ))
  ) {
    throw new Error("The code-host Provider returned invalid review metadata.");
  }
  return {
    state: value.state,
    draft: value.draft,
    title,
    headBranch,
    ...(value.unresolvedReviewThreadCount === undefined
      ? {}
      : { unresolvedReviewThreadCount: value.unresolvedReviewThreadCount }),
    observedAt
  };
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 86_400_000) {
    throw new Error(`The code-host ${label} is invalid.`);
  }
  return value;
}

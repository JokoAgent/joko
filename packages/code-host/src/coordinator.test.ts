import { describe, expect, it, vi } from "vitest";

import {
  CodeHostProjectionCoordinator,
  CodeHostPullRequestNotFoundError,
  CodeHostProviderRetryableError,
  CodeHostProviderUnavailableError,
  emptyCodeHostSessionProjection,
  materializeCodeHostSessionProjection,
  type CodeHostProjectionRepository,
  type CodeHostProvider,
  type CodeHostPullRequestReference,
  type CodeHostSessionProjection
} from "./index.js";

const reference: CodeHostPullRequestReference = {
  key: "code.example/acme/widgets#42",
  host: "code.example",
  repositoryOwner: "acme",
  repositoryName: "widgets",
  number: 42,
  webUrl: "https://code.example/acme/widgets/pull/42"
};

const providerResult = {
  state: "open" as const,
  draft: false,
  title: "Bounded projection",
  headBranch: "feature/projection"
};

describe("code-host Provider conformance and cache", () => {
  it("fails closed on the pre-title projection shape", () => {
    expect(materializeCodeHostSessionProjection({
      schemaVersion: 1,
      sessionOwnerId: "session-a",
      references: [{
        reference: {
          key: reference.key,
          host: reference.host,
          repositoryOwner: reference.repositoryOwner,
          repositoryName: reference.repositoryName,
          number: reference.number
        },
        projection: { state: "open", draft: false, reviewCount: 0, observedAt: 1 }
      }]
    }, "session-a")).toBeUndefined();
  });

  it("deduplicates in-flight reads and observes the success TTL within one Session owner", async () => {
    let release: (() => void) | undefined;
    let requests = 0;
    const provider = fakeProvider(async () => {
      requests += 1;
      if (requests === 1) await new Promise<void>((resolve) => { release = resolve; });
      return { ...providerResult, draft: true, unresolvedReviewThreadCount: 3 };
    });
    const repository = new MemoryRepository();
    let now = 1_000;
    const coordinator = new CodeHostProjectionCoordinator({ repository, providers: [provider], now: () => now, timeToLiveMs: 100 });

    const first = coordinator.refreshSession("session-a", [reference]);
    const duplicate = coordinator.refreshSession("session-a", [reference]);
    await vi.waitFor(() => expect(provider.getPullRequest).toHaveBeenCalledOnce());
    release?.();
    const [left, right] = await Promise.all([first, duplicate]);
    expect(left.projection).toEqual(right.projection);
    expect(left.projection.references[0]?.projection).toMatchObject({ state: "open", draft: true, unresolvedReviewThreadCount: 3 });
    expect(provider.getPullRequest.mock.calls[0]?.[1].sessionOwnerId).toBe("session-a");

    await coordinator.refreshSession("session-a", [reference]);
    expect(provider.getPullRequest).toHaveBeenCalledOnce();
    now = 1_101;
    await coordinator.refreshSession("session-a", [reference]);
    expect(provider.getPullRequest).toHaveBeenCalledTimes(2);
  });

  it("binds in-flight work to the Session owner instead of sharing authorization across owners", async () => {
    const provider = fakeProvider(async () => providerResult);
    const coordinator = new CodeHostProjectionCoordinator({ repository: new MemoryRepository(), providers: [provider] });
    await Promise.all([
      coordinator.refreshSession("session-a", [reference]),
      coordinator.refreshSession("session-b", [reference])
    ]);
    expect(provider.getPullRequest).toHaveBeenCalledTimes(2);
  });

  it("negative-caches not-found responses while preserving the last successful projection", async () => {
    const repository = new MemoryRepository();
    repository.write({
      ...emptyCodeHostSessionProjection("session-a"),
      references: [{
        reference,
        projection: { ...providerResult, unresolvedReviewThreadCount: 1, observedAt: 400 },
        freshUntil: 500
      }]
    });
    const provider = fakeProvider(async () => { throw new CodeHostPullRequestNotFoundError(); });
    const coordinator = new CodeHostProjectionCoordinator({ repository, providers: [provider], now: () => 1_000, notFoundTimeToLiveMs: 100 });

    const first = await coordinator.refreshSession("session-a", [reference]);
    expect(first.projection.references[0]?.projection).toEqual({ ...providerResult, unresolvedReviewThreadCount: 1, observedAt: 400 });
    expect(first.projection.references[0]?.notFoundUntil).toBe(1_100);
    await coordinator.refreshSession("session-a", [reference]);
    expect(provider.getPullRequest).toHaveBeenCalledOnce();
  });

  it("backs off transient failures without replacing an older successful snapshot", async () => {
    const repository = new MemoryRepository();
    const stored: CodeHostSessionProjection = {
      ...emptyCodeHostSessionProjection("session-a"),
      references: [{
        reference,
        projection: { ...providerResult, state: "closed", observedAt: 400 },
        freshUntil: 500
      }]
    };
    repository.write(stored);
    let now = 1_000;
    const provider = fakeProvider(async () => { throw new CodeHostProviderRetryableError(500); });
    const coordinator = new CodeHostProjectionCoordinator({
      repository,
      providers: [provider],
      now: () => now,
      failureTimeToLiveMs: 100
    });

    const result = await coordinator.refreshSession("session-a", [reference]);
    expect(result.projection.references[0]?.projection).toEqual(stored.references[0]?.projection);
    expect(result.projection.references[0]?.retryAfterUntil).toBe(1_500);
    expect(result.changed).toBe(true);
    await Promise.all(Array.from({ length: 20 }, () => coordinator.refreshSession("session-a", [reference])));
    expect(provider.getPullRequest).toHaveBeenCalledOnce();
    now = 1_501;
    await coordinator.refreshSession("session-a", [reference]);
    expect(provider.getPullRequest).toHaveBeenCalledTimes(2);
  });

  it("honors a Provider minimum success TTL", async () => {
    let now = 1_000;
    const provider = {
      ...fakeProvider(async () => providerResult),
      minimumTimeToLiveMs: 3_600_000
    };
    const coordinator = new CodeHostProjectionCoordinator({
      repository: new MemoryRepository(),
      providers: [provider],
      now: () => now,
      timeToLiveMs: 100
    });

    const first = await coordinator.refreshSession("session-a", [reference]);
    expect(first.projection.references[0]?.freshUntil).toBe(3_601_000);
    now = 3_600_999;
    await coordinator.refreshSession("session-a", [reference]);
    expect(provider.getPullRequest).toHaveBeenCalledOnce();
  });

  it("tries the next supporting capability only when the preferred provider is unavailable", async () => {
    const authenticated = fakeProvider(async () => { throw new CodeHostProviderUnavailableError(); });
    const fallback = fakeProvider(async () => providerResult);
    const coordinator = new CodeHostProjectionCoordinator({
      repository: new MemoryRepository(),
      providers: [authenticated, fallback]
    });

    const result = await coordinator.refreshSession("session-a", [reference]);
    expect(result.projection.references[0]?.projection).toMatchObject(providerResult);
    expect(authenticated.getPullRequest).toHaveBeenCalledOnce();
    expect(fallback.getPullRequest).toHaveBeenCalledOnce();
  });
});

class MemoryRepository implements CodeHostProjectionRepository {
  readonly values = new Map<string, CodeHostSessionProjection>();
  writes = 0;

  read(sessionOwnerId: string): CodeHostSessionProjection | undefined {
    return this.values.get(sessionOwnerId);
  }

  write(projection: CodeHostSessionProjection): void {
    this.writes += 1;
    this.values.set(projection.sessionOwnerId, projection);
  }
}

function fakeProvider(
  implementation: CodeHostProvider["getPullRequest"]
): CodeHostProvider & { readonly getPullRequest: ReturnType<typeof vi.fn<CodeHostProvider["getPullRequest"]>> } {
  return {
    capability: "code-host.pull-request",
    supports: (candidate) => candidate.host === "code.example",
    getPullRequest: vi.fn(implementation)
  };
}

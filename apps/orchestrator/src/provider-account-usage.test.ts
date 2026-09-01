import { describe, expect, it, vi } from "vitest";

import {
  ProviderAccountUsageProvider,
  type ProviderAccountUsageCredential,
  type ProviderAccountUsageCredentialIdentity,
  type ProviderAccountUsageCredentialResolver
} from "./provider-account-usage.js";

const NOW = 1_800_000_000_000;

class FakeCredentialResolver implements ProviderAccountUsageCredentialResolver {
  catalogGeneration = 1;
  identity: ProviderAccountUsageCredentialIdentity | undefined = {
    providerId: "subscription-provider",
    catalogGeneration: 1,
    providerGeneration: 1n,
    authGeneration: "account-a:1"
  };
  credential: ProviderAccountUsageCredential = {
    accessToken: "access-secret-a",
    accountId: "account-a"
  };
  readonly authorizationRecoveries: ProviderAccountUsageCredentialIdentity[] = [];

  currentCatalogGeneration(): number {
    return this.catalogGeneration;
  }

  describeProviderAccountUsage(providerId: string): ProviderAccountUsageCredentialIdentity | undefined {
    return this.identity?.providerId === providerId ? this.identity : undefined;
  }

  async useProviderAccountUsageCredential<T>(
    identity: ProviderAccountUsageCredentialIdentity,
    operation: (credential: ProviderAccountUsageCredential) => Promise<T>
  ): Promise<T> {
    if (identity !== this.identity) throw new Error("stale identity");
    return await operation(this.credential);
  }

  async recoverProviderAccountUsageAuthorization(identity: ProviderAccountUsageCredentialIdentity): Promise<void> {
    this.authorizationRecoveries.push(identity);
  }
}

describe("ProviderAccountUsageProvider", () => {
  it("uses the fixed credential-free transport shape and parses both account windows", async () => {
    const credentials = new FakeCredentialResolver();
    let capturedUrl: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse({
        plan_type: "pro",
        rate_limit: {
          limit_reached: false,
          primary_window: {
            used_percent: 23.5,
            limit_window_seconds: 18_000,
            reset_at: 1_800_003_600
          },
          secondary_window: {
            used_percent: 72,
            window_minutes: 10_080,
            reset_after_seconds: 7200
          }
        },
        credits: { has_credits: true, unlimited: false, balance: "12.50" }
      });
    }) as typeof globalThis.fetch;
    const provider = new ProviderAccountUsageProvider({ credentials, fetch, now: () => NOW });

    await expect(provider.get("subscription-provider")).resolves.toEqual({
      providerId: "subscription-provider",
      planType: "pro",
      limitReached: false,
      primaryWindow: { usedPercent: 23.5, windowMinutes: 300, resetAt: 1_800_003_600_000 },
      secondaryWindow: { usedPercent: 72, windowMinutes: 10_080, resetAt: NOW + 7_200_000 },
      credits: { hasCredits: true, unlimited: false, balance: "12.50", observedAt: NOW },
      observedAt: NOW
    });
    expect(capturedUrl).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(capturedInit).toMatchObject({
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer"
    });
    expect(capturedInit?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer access-secret-a",
      "chatgpt-account-id": "account-a"
    });
    expect(JSON.stringify(provider.peek("subscription-provider"))).not.toContain("secret");
  });

  it("normalizes compatible WHAM scalar encodings and clamps finite percentages", async () => {
    const credentials = new FakeCredentialResolver();
    const provider = new ProviderAccountUsageProvider({
      credentials,
      now: () => NOW,
      fetch: vi.fn(async () => jsonResponse({
        rate_limit: {
          primary_window: { used_percent: "105", limit_window_seconds: "18000" },
          secondary_window: { used_percent: -5, limit_window_seconds: 604_800 }
        },
        credits: { has_credits: "0", unlimited: 1, balance: 12.5 }
      })) as typeof globalThis.fetch
    });

    await expect(provider.get("subscription-provider")).resolves.toMatchObject({
      primaryWindow: { usedPercent: 100, windowMinutes: 300 },
      secondaryWindow: { usedPercent: 0, windowMinutes: 10_080 },
      credits: { hasCredits: false, unlimited: true, balance: "12.5" }
    });
  });

  it("drops malformed optional fields without poisoning a valid plan or sibling window", async () => {
    const credentials = new FakeCredentialResolver();
    const provider = new ProviderAccountUsageProvider({
      credentials,
      now: () => NOW,
      fetch: vi.fn(async () => jsonResponse({
        plan_type: "business",
        rate_limit: {
          limit_reached: "not-a-boolean",
          primary_window: {
            used_percent: "9".repeat(1_000),
            limit_window_seconds: "NaN"
          },
          secondary_window: {
            used_percent: "23",
            limit_window_seconds: "not-a-number",
            reset_at: "not-a-number",
            reset_after_seconds: "3600"
          }
        },
        credits: {
          has_credits: "maybe",
          unlimited: 2,
          balance: `unsafe\u0000${"x".repeat(129)}`
        }
      })) as typeof globalThis.fetch
    });

    await expect(provider.get("subscription-provider")).resolves.toEqual({
      providerId: "subscription-provider",
      planType: "business",
      secondaryWindow: { usedPercent: 23, resetAt: NOW + 3_600_000 },
      observedAt: NOW
    });
  });

  it("keeps balance-only credits optional instead of inventing boolean fields", async () => {
    const credentials = new FakeCredentialResolver();
    const provider = new ProviderAccountUsageProvider({
      credentials,
      now: () => NOW,
      fetch: vi.fn(async () => jsonResponse({ credits: { balance: "0" } })) as typeof globalThis.fetch
    });

    await expect(provider.get("subscription-provider")).resolves.toMatchObject({
      credits: { balance: "0", observedAt: NOW }
    });
    const credits = (await provider.get("subscription-provider"))?.credits;
    expect(credits).not.toHaveProperty("hasCredits");
    expect(credits).not.toHaveProperty("unlimited");
  });

  it("deduplicates refreshes, retains an old snapshot through bounded backoff, and never exposes upstream bodies", async () => {
    const credentials = new FakeCredentialResolver();
    let now = NOW;
    const first = deferred<Response>();
    const fetch = vi.fn()
      .mockImplementationOnce(async () => await first.promise)
      .mockResolvedValueOnce(new Response("secret upstream failure", { status: 503, headers: { "content-type": "text/plain" } }));
    const provider = new ProviderAccountUsageProvider({
      credentials,
      fetch: fetch as typeof globalThis.fetch,
      now: () => now,
      cacheTtlMs: 10,
      initialBackoffMs: 100,
      maximumBackoffMs: 100
    });

    const one = provider.get("subscription-provider");
    const two = provider.get("subscription-provider");
    expect(fetch).toHaveBeenCalledTimes(1);
    first.resolve(jsonResponse({ rate_limit: { primary_window: { used_percent: 10 } } }));
    const snapshot = await one;
    await expect(two).resolves.toEqual(snapshot);

    now += 11;
    await expect(provider.get("subscription-provider")).resolves.toEqual(snapshot);
    expect(fetch).toHaveBeenCalledTimes(2);
    now += 50;
    await expect(provider.get("subscription-provider")).resolves.toEqual(snapshot);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])("clears the current identity snapshot on %i without reading the response body", async (status) => {
    const credentials = new FakeCredentialResolver();
    let now = NOW;
    const unauthorized = {
      status,
      redirected: false,
      headers: new Headers(),
      get body(): never { throw new Error("unauthorized body must not be read"); }
    } as unknown as Response;
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ rate_limit: { primary_window: { used_percent: 10 } } }))
      .mockResolvedValueOnce(unauthorized);
    const provider = new ProviderAccountUsageProvider({
      credentials,
      fetch: fetch as typeof globalThis.fetch,
      now: () => now,
      cacheTtlMs: 10,
      initialBackoffMs: 100,
      maximumBackoffMs: 100
    });
    await expect(provider.get("subscription-provider")).resolves.toBeDefined();

    now += 11;
    await expect(provider.get("subscription-provider")).resolves.toBeUndefined();
    expect(provider.peek("subscription-provider")).toBeUndefined();
    expect(credentials.authorizationRecoveries).toEqual([credentials.identity]);
    await expect(provider.get("subscription-provider")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not let an unauthorized response for an aborted identity clear the replacement identity", async () => {
    const credentials = new FakeCredentialResolver();
    let now = NOW;
    const oldUnauthorized = deferred<Response>();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ rate_limit: { primary_window: { used_percent: 10 } } }))
      .mockImplementationOnce(async () => await oldUnauthorized.promise)
      .mockResolvedValueOnce(jsonResponse({ rate_limit: { primary_window: { used_percent: 77 } } }));
    const provider = new ProviderAccountUsageProvider({
      credentials,
      fetch: fetch as typeof globalThis.fetch,
      now: () => now,
      cacheTtlMs: 10
    });
    await provider.get("subscription-provider");
    now += 11;
    const oldPending = provider.get("subscription-provider");

    credentials.identity = {
      providerId: "subscription-provider",
      catalogGeneration: 1,
      providerGeneration: 2n,
      authGeneration: "account-b:2"
    };
    credentials.credential = { accessToken: "access-secret-b", accountId: "account-b" };
    await expect(provider.get("subscription-provider")).resolves.toMatchObject({
      primaryWindow: { usedPercent: 77 }
    });
    oldUnauthorized.resolve({ status: 401, redirected: false } as Response);

    await expect(oldPending).resolves.toBeUndefined();
    expect(provider.peek("subscription-provider")?.primaryWindow?.usedPercent).toBe(77);
    expect(credentials.authorizationRecoveries).toEqual([]);
  });

  it("fails closed for redirects, authorization failures, malformed JSON, unsupported media, and oversized bodies", async () => {
    const cases = [
      new Response(null, { status: 302, headers: { location: "https://example.test" } }),
      jsonResponse({ error: "credential rejected" }, 401),
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
      new Response("{}", { status: 200, headers: { "content-type": "text/html" } }),
      new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 1 } }, padding: "x".repeat(256) }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    ];
    for (const response of cases) {
      const credentials = new FakeCredentialResolver();
      const provider = new ProviderAccountUsageProvider({
        credentials,
        bodyLimitBytes: 128,
        fetch: vi.fn(async () => response) as typeof globalThis.fetch
      });
      await expect(provider.get("subscription-provider")).resolves.toBeUndefined();
      expect(provider.peek("subscription-provider")).toBeUndefined();
    }
  });

  it("does not return or retain an old account snapshot after an auth generation switch", async () => {
    const credentials = new FakeCredentialResolver();
    const switched = deferred<Response>();
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ rate_limit: { primary_window: { used_percent: 10 } } }))
      .mockImplementationOnce(async () => await switched.promise);
    let now = NOW;
    const provider = new ProviderAccountUsageProvider({
      credentials,
      fetch: fetch as typeof globalThis.fetch,
      now: () => now,
      cacheTtlMs: 10
    });
    await provider.get("subscription-provider");

    now += 11;
    credentials.identity = {
      providerId: "subscription-provider",
      catalogGeneration: 1,
      providerGeneration: 2n,
      authGeneration: "account-b:2"
    };
    credentials.credential = { accessToken: "access-secret-b", accountId: "account-b" };
    const pending = provider.get("subscription-provider");
    credentials.identity = {
      providerId: "subscription-provider",
      catalogGeneration: 1,
      providerGeneration: 3n,
      authGeneration: "account-c:3"
    };
    switched.resolve(jsonResponse({ rate_limit: { primary_window: { used_percent: 20 } } }));

    await expect(pending).resolves.toBeUndefined();
    expect(provider.peek("subscription-provider")).toBeUndefined();
  });

  it("invalidates every cached snapshot when the catalog generation changes", async () => {
    const credentials = new FakeCredentialResolver();
    const provider = new ProviderAccountUsageProvider({
      credentials,
      fetch: vi.fn(async () => jsonResponse({ rate_limit: { primary_window: { used_percent: 10 } } })) as typeof globalThis.fetch
    });
    await expect(provider.get("subscription-provider")).resolves.toBeDefined();

    credentials.catalogGeneration = 2;
    credentials.identity = {
      providerId: "subscription-provider",
      catalogGeneration: 2,
      providerGeneration: 2n,
      authGeneration: "account-a:1"
    };
    expect(provider.peek("subscription-provider")).toBeUndefined();
  });

  it("cannot resurrect cache when invalidated during a pending fetch", async () => {
    const credentials = new FakeCredentialResolver();
    const response = deferred<Response>();
    const provider = new ProviderAccountUsageProvider({
      credentials,
      fetch: vi.fn(async () => await response.promise) as typeof globalThis.fetch
    });

    const pending = provider.get("subscription-provider");
    provider.invalidate("subscription-provider");
    response.resolve(jsonResponse({ rate_limit: { primary_window: { used_percent: 44 } } }));

    await expect(pending).resolves.toBeUndefined();
    expect(provider.peek("subscription-provider")).toBeUndefined();
  });

  it("rejects credential header injection before issuing a request", async () => {
    const credentials = new FakeCredentialResolver();
    const fetch = vi.fn();
    const provider = new ProviderAccountUsageProvider({ credentials, fetch: fetch as typeof globalThis.fetch });
    credentials.credential = { accessToken: "secret\r\ninjected: true", accountId: "account-a" };
    await expect(provider.get("subscription-provider")).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();

    provider.invalidate();
    credentials.credential = { accessToken: "secret", accountId: "x".repeat(257) };
    await expect(provider.get("subscription-provider")).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts a hung upstream request at the configured timeout", async () => {
    const credentials = new FakeCredentialResolver();
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
      });
    }) as typeof globalThis.fetch;
    const provider = new ProviderAccountUsageProvider({ credentials, fetch, timeoutMs: 1 });

    await expect(provider.get("subscription-provider")).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("aborts the upstream request after the last waiting caller is cancelled", async () => {
    const credentials = new FakeCredentialResolver();
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
      });
    }) as typeof globalThis.fetch;
    const provider = new ProviderAccountUsageProvider({ credentials, fetch, timeoutMs: 10_000 });
    const caller = new AbortController();

    const pending = provider.get("subscription-provider", caller.signal);
    caller.abort(new DOMException("caller stopped", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("keeps a shared upstream refresh alive while another caller is still waiting", async () => {
    const credentials = new FakeCredentialResolver();
    const response = deferred<Response>();
    let observedSignal: AbortSignal | undefined;
    const provider = new ProviderAccountUsageProvider({
      credentials,
      fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        observedSignal = init?.signal ?? undefined;
        return await response.promise;
      }) as typeof globalThis.fetch
    });
    const cancelledCaller = new AbortController();

    const cancelled = provider.get("subscription-provider", cancelledCaller.signal);
    const waiting = provider.get("subscription-provider");
    cancelledCaller.abort(new DOMException("caller stopped", "AbortError"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignal?.aborted).toBe(false);

    response.resolve(jsonResponse({ plan_type: "pro" }));
    await expect(waiting).resolves.toMatchObject({ planType: "pro" });
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

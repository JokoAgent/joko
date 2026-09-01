import { describe, expect, it, vi } from "vitest";

import {
  CodeHostPullRequestNotFoundError,
  CodeHostProviderRetryableError,
  PublicCodeHostProvider,
  type CodeHostProvider,
  type CodeHostPullRequestReference
} from "./index.js";

const reference: CodeHostPullRequestReference = {
  key: "github.com/acme/widgets#42",
  host: "github.com",
  repositoryOwner: "acme",
  repositoryName: "widgets",
  number: 42,
  webUrl: "https://github.com/acme/widgets/pull/42"
};

describe("public code-host Provider conformance", () => {
  it("supports only canonical references admitted by the fixed public-host policy", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider: CodeHostProvider = new PublicCodeHostProvider({ fetch });

    expect(provider.supports(reference)).toBe(true);
    expect(provider.minimumTimeToLiveMs).toBe(60 * 60_000);
    expect(provider.supports({ ...reference, host: "github.com.evil.example", key: "github.com.evil.example/acme/widgets#42" })).toBe(false);
    expect(provider.supports({ ...reference, repositoryOwner: "-acme", key: "github.com/-acme/widgets#42" })).toBe(false);
    expect(provider.supports({ ...reference, repositoryName: "widgets/escape", key: "github.com/acme/widgets/escape#42" })).toBe(false);
    expect(provider.supports({ ...reference, number: 0, key: "github.com/acme/widgets#0" })).toBe(false);
    expect(provider.supports({ ...reference, key: "github.com/acme/other#42" })).toBe(false);
    expect(provider.supports({ ...reference, webUrl: "https://evil.example/acme/widgets/pull/42" })).toBe(false);

    await expect(provider.getPullRequest(
      { ...reference, host: "github.com.evil.example", key: "github.com.evil.example/acme/widgets#42" },
      { signal: new AbortController().signal, sessionOwnerId: "session-a" }
    )).rejects.toThrow(/outbound policy/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses one bounded credential-free REST request without inventing review-thread metadata", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      expect(new URL(url).origin).toBe("https://api.github.com");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ state: "closed", draft: false, merged: true, merged_at: "2026-08-26T01:02:03Z", title: "Ship bounded badges", head: { ref: "feature/pr-badges" } });
    });
    const provider = new PublicCodeHostProvider({ fetch });

    await expect(provider.getPullRequest(reference, {
      signal: new AbortController().signal,
      sessionOwnerId: "session-a"
    })).resolves.toEqual({
      state: "merged",
      draft: false,
      title: "Ship bounded badges",
      headBranch: "feature/pr-badges"
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.github.com/repos/acme/widgets/pulls/42");
  });

  it("maps 404 without reading a body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("upstream detail", {
      status: 404,
      headers: { "content-type": "text/plain" }
    }));
    const provider = new PublicCodeHostProvider({ fetch });

    await expect(provider.getPullRequest(reference, {
      signal: new AbortController().signal,
      sessionOwnerId: "session-a"
    })).rejects.toBeInstanceOf(CodeHostPullRequestNotFoundError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("maps anonymous rate limits to a bounded retry fence without reading the upstream body", async () => {
    const provider = new PublicCodeHostProvider({
      now: () => 1_000,
      fetch: async () => new Response("upstream-sensitive-value", {
        status: 429,
        headers: { "retry-after": "120", "content-type": "text/plain" }
      })
    });
    const error = await provider.getPullRequest(reference, {
      signal: new AbortController().signal,
      sessionOwnerId: "session-a"
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(CodeHostProviderRetryableError);
    expect((error as CodeHostProviderRetryableError).retryAfterMs).toBe(120_000);
    expect(String(error)).not.toContain("upstream-sensitive-value");
  });

  it("rejects oversized or malformed responses without exposing their content", async () => {
    const oversized = new PublicCodeHostProvider({
      fetch: async () => jsonResponse({ state: "open", draft: false, merged: false, merged_at: null, title: "Oversized", head: { ref: "oversized" }, padding: "x".repeat(128) }),
      maximumPullRequestBodyBytes: 64
    });
    await expect(oversized.getPullRequest(reference, {
      signal: new AbortController().signal,
      sessionOwnerId: "session-a"
    })).rejects.toThrow(/body limit/u);

    const malformed = new PublicCodeHostProvider({
      fetch: async () => jsonResponse({ state: "open", draft: "upstream-sensitive-value", merged: false, merged_at: null, title: "Malformed", head: { ref: "malformed" } })
    });
    const error = await malformed.getPullRequest(reference, {
      signal: new AbortController().signal,
      sessionOwnerId: "session-a"
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("upstream-sensitive-value");
  });

  it("rejects unsafe or unbounded title and head branch metadata", async () => {
    const values = [
      { title: "line\nbreak", head: { ref: "safe-branch" } },
      { title: "x".repeat(513), head: { ref: "safe-branch" } },
      { title: "Safe title", head: { ref: "../escape" } },
      { title: "Safe title", head: { ref: "x".repeat(256) } }
    ];
    for (const value of values) {
      const provider = new PublicCodeHostProvider({
        fetch: async () => jsonResponse({ state: "open", draft: false, merged: false, merged_at: null, ...value })
      });
      await expect(provider.getPullRequest(reference, {
        signal: new AbortController().signal,
        sessionOwnerId: "session-a"
      })).rejects.toThrow(/response is invalid/u);
    }
  });

  it("propagates caller cancellation into the active outbound request", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
      });
    });
    const provider = new PublicCodeHostProvider({ fetch });
    const controller = new AbortController();
    const pending = provider.getPullRequest(reference, { signal: controller.signal, sessionOwnerId: "session-a" });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    controller.abort(new Error("cancelled"));

    await expect(pending).rejects.toThrow("cancelled");
    expect(observedSignal?.aborted).toBe(true);
  });
});

function jsonResponse(value: unknown, extraHeaders: Readonly<Record<string, string>> = {}): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body, "utf8").toString(10),
      ...extraHeaders
    }
  });
}

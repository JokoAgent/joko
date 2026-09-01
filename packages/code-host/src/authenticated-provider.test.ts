import { describe, expect, it, vi } from "vitest";

import {
  AuthenticatedCodeHostProvider,
  CodeHostProjectionCoordinator,
  CodeHostProviderUnavailableError,
  PublicCodeHostProvider,
  type CodeHostCredentialSource,
  type CodeHostSessionProjection,
  type CodeHostPullRequestReference,
  type CodeHostSessionAuthorizationPort,
  type GhCliCredentialLease
} from "./index.js";

const reference: CodeHostPullRequestReference = {
  key: "github.com/acme/private-repository#42",
  host: "github.com",
  repositoryOwner: "acme",
  repositoryName: "private-repository",
  number: 42,
  webUrl: "https://github.com/acme/private-repository/pull/42"
};

describe("authenticated code-host Provider", () => {
  it("reads a private pull request with an owner-fenced credential and exact GraphQL thread count", async () => {
    const token = "gho_private_memory_only";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.origin).toBe("https://api.github.com");
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
      expect(init?.referrerPolicy).toBe("no-referrer");
      if (url.pathname === "/graphql") {
        expect(init?.method).toBe("POST");
        expect(headers.get("content-type")).toBe("application/json");
        const request = JSON.parse(String(init?.body)) as { variables: unknown; query: string };
        expect(request.variables).toEqual({ owner: "acme", repo: "private-repository", number: 42 });
        expect(request.query).toContain("reviewThreads(first: 100)");
        expect(request.query).toContain("pageInfo { hasNextPage }");
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }],
                  pageInfo: { hasNextPage: false }
                }
              }
            }
          }
        });
      }
      expect(url.href).toBe("https://api.github.com/repos/acme/private-repository/pulls/42");
      expect(init?.method).toBe("GET");
      return jsonResponse({
        state: "open",
        draft: false,
        merged: false,
        merged_at: null,
        title: "Private status",
        head: { ref: "feature/private-status" }
      });
    });
    const provider = new AuthenticatedCodeHostProvider({
      authorization: authorization(),
      credentialSource: credentialSource(token),
      fetch
    });

    await expect(provider.getPullRequest(reference, requestOptions())).resolves.toEqual({
      state: "open",
      draft: false,
      title: "Private status",
      headBranch: "feature/private-status",
      unresolvedReviewThreadCount: 2
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(await provider.getPullRequest(reference, requestOptions()))).not.toContain(token);
  });

  it("degrades GraphQL failures to an absent count without losing basic REST status", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => new URL(String(input)).pathname === "/graphql"
      ? new Response("private upstream detail", { status: 500, headers: { "content-type": "text/plain" } })
      : jsonResponse({
        state: "closed",
        draft: false,
        merged: true,
        merged_at: "2026-08-27T01:00:00Z",
        title: "Merged private status",
        head: { ref: "feature/merged" }
      }));
    const provider = new AuthenticatedCodeHostProvider({
      authorization: authorization(),
      credentialSource: credentialSource("gho_graphql_degrade"),
      fetch
    });

    await expect(provider.getPullRequest(reference, requestOptions())).resolves.toEqual({
      state: "merged",
      draft: false,
      title: "Merged private status",
      headBranch: "feature/merged"
    });
  });

  it.each([
    { label: "more than the bounded first page", pageInfo: { hasNextPage: true } },
    { label: "missing pageInfo", pageInfo: undefined },
    { label: "malformed pageInfo", pageInfo: { hasNextPage: "false" } }
  ])("does not publish a prefix count for $label", async ({ pageInfo }) => {
    const nodes = Array.from({ length: 100 }, () => ({ isResolved: false }));
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => new URL(String(input)).pathname === "/graphql"
      ? jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes,
                ...(pageInfo === undefined ? {} : { pageInfo })
              }
            }
          }
        }
      })
      : jsonResponse({
        state: "open",
        draft: false,
        merged: false,
        merged_at: null,
        title: "Bounded review threads",
        head: { ref: "feature/bounded-threads" }
      }));
    const provider = new AuthenticatedCodeHostProvider({
      authorization: authorization(),
      credentialSource: credentialSource("gho_bounded_threads"),
      fetch
    });

    await expect(provider.getPullRequest(reference, requestOptions())).resolves.toEqual({
      state: "open",
      draft: false,
      title: "Bounded review threads",
      headBranch: "feature/bounded-threads"
    });
  });

  it("reports no credential as provider-unavailable so the coordinator can use public fallback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new AuthenticatedCodeHostProvider({
      authorization: authorization(),
      credentialSource: credentialSource(undefined),
      fetch
    });

    await expect(provider.getPullRequest(reference, requestOptions()))
      .rejects.toBeInstanceOf(CodeHostProviderUnavailableError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls through to the anonymous provider only when the host CLI has no credential", async () => {
    const authenticatedFetch = vi.fn<typeof globalThis.fetch>();
    const publicFetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return jsonResponse({
        state: "open",
        draft: true,
        merged: false,
        merged_at: null,
        title: "Public fallback",
        head: { ref: "feature/public-fallback" }
      });
    });
    const authenticated = new AuthenticatedCodeHostProvider({
      authorization: authorization(),
      credentialSource: credentialSource(undefined),
      fetch: authenticatedFetch
    });
    const values = new Map<string, CodeHostSessionProjection>();
    const coordinator = new CodeHostProjectionCoordinator({
      repository: {
        read: (owner) => values.get(owner),
        write: (projection) => { values.set(projection.sessionOwnerId, projection); }
      },
      providers: [authenticated, new PublicCodeHostProvider({ fetch: publicFetch })]
    });

    const result = await coordinator.refreshSession("session-a", [reference]);
    expect(result.projection.references[0]?.projection).toMatchObject({
      state: "open",
      draft: true,
      title: "Public fallback"
    });
    expect(authenticatedFetch).not.toHaveBeenCalled();
    expect(publicFetch).toHaveBeenCalledOnce();
  });

  it("does not retry a credentialed not-found response anonymously", async () => {
    const authenticated = new AuthenticatedCodeHostProvider({
      authorization: authorization(),
      credentialSource: credentialSource("gho_owner_scoped"),
      fetch: async () => new Response(null, { status: 404 })
    });
    const publicFetch = vi.fn<typeof globalThis.fetch>();
    const values = new Map<string, CodeHostSessionProjection>();
    const coordinator = new CodeHostProjectionCoordinator({
      repository: {
        read: (owner) => values.get(owner),
        write: (projection) => { values.set(projection.sessionOwnerId, projection); }
      },
      providers: [authenticated, new PublicCodeHostProvider({ fetch: publicFetch })]
    });

    const result = await coordinator.refreshSession("session-a", [reference]);
    expect(result.projection.references[0]?.projection).toBeUndefined();
    expect(result.projection.references[0]?.notFoundUntil).toBeGreaterThan(0);
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it("checks the Session authorization before reading credentials or issuing requests", async () => {
    const readCredential = vi.fn(async () => ({ token: "gho_should_not_be_read", generation: 1 }));
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new AuthenticatedCodeHostProvider({
      authorization: { authorize: () => undefined, isCurrent: () => false },
      credentialSource: { readCredential, isCurrent: () => true },
      fetch
    });

    await expect(provider.getPullRequest(reference, requestOptions())).rejects.toThrow(/Session authorization/u);
    expect(readCredential).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects header injection and fences a rotated credential without exposing either token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => new URL(String(input)).pathname === "/graphql"
      ? jsonResponse({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } })
      : jsonResponse({ state: "open", draft: false, merged: false, merged_at: null, title: "Safe", head: { ref: "safe" } }));
    const injected = new AuthenticatedCodeHostProvider({
      authorization: authorization(),
      credentialSource: credentialSource("safe\r\nx-injected: value"),
      fetch
    });
    const injectedError = await injected.getPullRequest(reference, requestOptions()).catch((error: unknown) => error);
    expect(String(injectedError)).not.toContain("x-injected");
    expect(fetch).not.toHaveBeenCalled();

    let current = true;
    const rotating = new AuthenticatedCodeHostProvider({
      authorization: authorization(),
      credentialSource: credentialSource("gho_rotated_secret", () => current),
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        current = false;
        return response;
      }
    });
    const rotationError = await rotating.getPullRequest(reference, requestOptions()).catch((error: unknown) => error);
    expect(String(rotationError)).toMatch(/authorization changed/u);
    expect(String(rotationError)).not.toContain("gho_rotated_secret");
  });

  it("fails closed on unbounded REST bodies while keeping response and credential content out of errors", async () => {
    const provider = new AuthenticatedCodeHostProvider({
      authorization: authorization(),
      credentialSource: credentialSource("gho_bounded_secret"),
      maximumRestBodyBytes: 64,
      fetch: async (input) => new URL(String(input)).pathname === "/graphql"
        ? jsonResponse({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } })
        : jsonResponse({
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          title: "upstream-private-detail",
          head: { ref: "safe" },
          padding: "x".repeat(128)
        })
    });
    const error = await provider.getPullRequest(reference, requestOptions()).catch((failure: unknown) => failure);
    expect(String(error)).toMatch(/body limit/u);
    expect(String(error)).not.toContain("upstream-private-detail");
    expect(String(error)).not.toContain("gho_bounded_secret");
  });

  it.each([
    {
      label: "a misleading media type",
      response: () => new Response(JSON.stringify({
        state: "open",
        draft: false,
        merged: false,
        merged_at: null,
        title: "Unsafe response",
        head: { ref: "unsafe" }
      }), { status: 200, headers: { "content-type": "application/json-evil" } })
    },
    {
      label: "a response marked as redirected",
      response: () => {
        const response = jsonResponse({
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          title: "Unsafe response",
          head: { ref: "unsafe" }
        });
        Object.defineProperty(response, "redirected", { configurable: true, value: true });
        return response;
      }
    }
  ])("rejects $label even when fetch claims success", async ({ response }) => {
    const provider = new AuthenticatedCodeHostProvider({
      authorization: authorization(),
      credentialSource: credentialSource("gho_response_policy"),
      fetch: async (input) => new URL(String(input)).pathname === "/graphql"
        ? jsonResponse({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } })
        : response()
    });

    await expect(provider.getPullRequest(reference, requestOptions())).rejects.toThrow(/not JSON/u);
  });

  it("propagates caller cancellation instead of treating it as GraphQL degradation", async () => {
    const controller = new AbortController();
    let graphSignal: AbortSignal | undefined;
    const provider = new AuthenticatedCodeHostProvider({
      authorization: authorization(),
      credentialSource: credentialSource("gho_cancelled"),
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname !== "/graphql") {
          return jsonResponse({ state: "open", draft: false, merged: false, merged_at: null, title: "Safe", head: { ref: "safe" } });
        }
        graphSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          graphSignal?.addEventListener("abort", () => reject(graphSignal?.reason), { once: true });
        });
      }
    });
    const pending = provider.getPullRequest(reference, { signal: controller.signal, sessionOwnerId: "session-a" });
    await vi.waitFor(() => expect(graphSignal).toBeDefined());
    controller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toThrow("caller cancelled");
    expect(graphSignal?.aborted).toBe(true);
  });
});

function authorization(): CodeHostSessionAuthorizationPort {
  return {
    authorize: (sessionOwnerId, candidate) => sessionOwnerId === "session-a" && candidate.key === reference.key
      ? { sessionOwnerId, referenceKey: candidate.key, ownerRevision: "1" }
      : undefined,
    isCurrent: (lease, candidate) => lease.sessionOwnerId === "session-a"
      && lease.referenceKey === candidate.key
      && lease.ownerRevision === "1"
  };
}

function credentialSource(
  token: string | undefined,
  isCurrent: () => boolean = () => true
): CodeHostCredentialSource {
  const credential: GhCliCredentialLease | undefined = token === undefined
    ? undefined
    : { token, generation: 1 };
  return {
    readCredential: async () => credential,
    isCurrent
  };
}

function requestOptions(): { readonly signal: AbortSignal; readonly sessionOwnerId: string } {
  return { signal: new AbortController().signal, sessionOwnerId: "session-a" };
}

function jsonResponse(value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body, "utf8").toString(10)
    }
  });
}

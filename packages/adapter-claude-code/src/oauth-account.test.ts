import { describe, expect, it, vi } from "vitest";
import {
  ClaudeCodeOAuthAccount,
  type ClaudeCodeCredentialPort
} from "./oauth-account.js";

describe("ClaudeCodeOAuthAccount secret projection", () => {
  it("retains every observed token for the lifetime of the account owner", async () => {
    let serialized: string | undefined;
    const credentials: ClaudeCodeCredentialPort = {
      readSerialized: async () => serialized,
      compareAndSet: async () => false,
      restoreExact: async () => false,
      deleteExact: async () => false
    };
    const account = new ClaudeCodeOAuthAccount({
      credentials,
      now: () => 1_000,
      expiryMarginMs: 60_000
    });

    for (let index = 0; index < 80; index += 1) {
      serialized = JSON.stringify({
        format: 1,
        type: "oauth",
        accessToken: `access-${index}`,
        refreshToken: `refresh-${index}`,
        expiresAt: 1_000_000,
        scopes: ["user:inference"],
        subscriptionType: null,
        rateLimitTier: null
      });
      await account.readAccount(false);
    }

    expect(account.redactionValues()).toContain("access-0");
    expect(account.redactionValues()).toContain("refresh-0");
    expect(account.redactionValues()).toContain("access-79");
    expect(account.redactionValues()).toContain("refresh-79");
  });

  it("commits rotated tokens across a metadata-only compare-and-set conflict", async () => {
    const original = {
      format: 1,
      type: "oauth",
      accessToken: "access-before-refresh",
      refreshToken: "refresh-before-refresh",
      expiresAt: 2_000_000,
      scopes: ["user:inference"],
      subscriptionType: null,
      rateLimitTier: null
    } as const;
    let serialized: string | undefined = JSON.stringify(original);
    let injectMetadataConflict = true;
    const credentials: ClaudeCodeCredentialPort = {
      readSerialized: async () => serialized,
      compareAndSet: async (input) => {
        if (injectMetadataConflict) {
          injectMetadataConflict = false;
          serialized = JSON.stringify({
            ...original,
            subscriptionType: "max",
            rateLimitTier: "default_max"
          });
          return false;
        }
        if (serialized !== input.expected) return false;
        serialized = input.value;
        return true;
      },
      restoreExact: async () => false,
      deleteExact: async () => false
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString().includes("/v1/oauth/token")) {
        return new Response(JSON.stringify({
          access_token: "access-after-refresh",
          refresh_token: "refresh-after-refresh",
          expires_in: 3_600,
          scope: "user:inference"
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("", { status: 503 });
    }) as unknown as typeof fetch;
    const account = new ClaudeCodeOAuthAccount({
      credentials,
      fetch: fetchImpl,
      now: () => 1_000,
      expiryMarginMs: 60_000
    });

    const snapshot = await account.readAccount(true);
    const stored = JSON.parse(serialized ?? "null") as Record<string, unknown>;

    expect(snapshot.authenticationState).toBe("authenticated");
    expect(stored["accessToken"]).toBe("access-after-refresh");
    expect(stored["refreshToken"]).toBe("refresh-after-refresh");
    expect(stored["subscriptionType"]).toBe("max");
    expect(stored["rateLimitTier"]).toBe("default_max");
  });

  it("does not finish replacement quiescence before an entered credential mutation settles", async () => {
    const casEntered = deferred<void>();
    const releaseCas = deferred<void>();
    let serialized: string | undefined = JSON.stringify({
      format: 1,
      type: "oauth",
      accessToken: "access-before-quiesce",
      refreshToken: "refresh-before-quiesce",
      expiresAt: 2_000_000,
      scopes: ["user:inference"],
      subscriptionType: null,
      rateLimitTier: null
    });
    const credentials: ClaudeCodeCredentialPort = {
      readSerialized: async () => serialized,
      compareAndSet: async (input) => {
        casEntered.resolve(undefined);
        await releaseCas.promise;
        if (serialized !== input.expected) return false;
        serialized = input.value;
        return true;
      },
      restoreExact: async () => false,
      deleteExact: async () => false
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: "access-after-quiesce",
      refresh_token: "refresh-after-quiesce",
      expires_in: 3_600,
      scope: "user:inference"
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as unknown as typeof fetch;
    const account = new ClaudeCodeOAuthAccount({
      credentials,
      fetch: fetchImpl,
      now: () => 1_000,
      expiryMarginMs: 60_000
    });

    const refreshing = account.readAccount(true);
    await casEntered.promise;
    let quiesced = false;
    const quiescing = account.quiesceForReplacement().then(() => { quiesced = true; });
    await Promise.resolve();

    expect(quiesced).toBe(false);
    releaseCas.resolve(undefined);
    await Promise.all([refreshing, quiescing]);
    expect(quiesced).toBe(true);
  });

  it("rejects a browser authorization without inference scope before credential commit", async () => {
    let serialized: string | undefined;
    const compareAndSet = vi.fn(async () => false);
    const credentials: ClaudeCodeCredentialPort = {
      readSerialized: async () => serialized,
      compareAndSet,
      restoreExact: async () => false,
      deleteExact: async () => false
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: "access-without-inference",
      refresh_token: "refresh-without-inference",
      expires_in: 3_600,
      scope: "user:profile"
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as unknown as typeof fetch;
    const account = new ClaudeCodeOAuthAccount({ credentials, fetch: fetchImpl });
    const login = await account.beginLogin();
    const authorization = new URL(login.url);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("code", "authorization-code");

    await fetch(callback);
    const observation = account.readLoginOutcome(login.loginId);
    await account.dispose();

    expect(observation).toEqual({
      outcome: "error",
      failureReason: "not_a_subscription"
    });
    expect(serialized).toBeUndefined();
    expect(compareAndSet).not.toHaveBeenCalled();
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

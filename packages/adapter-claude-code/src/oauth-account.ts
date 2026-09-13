import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BackendAuthenticationState } from "@joko/core";
import type { ClaudeSdkOAuthTokenProvider } from "./sdk-runtime.js";

const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const SUCCESS_URL = "https://platform.claude.com/oauth/code/success?app=claude-code";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_SCOPES = Object.freeze([
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload"
] as const);
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;
const DEFAULT_EXPIRY_MARGIN_MS = 5 * 60_000;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const ORGANIZATION_TYPE_TO_SUBSCRIPTION = new Map<string, string>([
  ["claude_max", "max"],
  ["claude_pro", "pro"],
  ["claude_enterprise", "enterprise"],
  ["claude_team", "team"]
]);

export interface ClaudeCodeCredentialPort {
  readSerialized(): Promise<string | undefined>;
  compareAndSet(input: {
    readonly expected: string | undefined;
    readonly value: string;
    readonly expiresAt: number;
  }): Promise<boolean>;
  restoreExact(input: {
    readonly expected: string;
    readonly value: string;
    readonly expiresAt: number;
  }): Promise<boolean>;
  deleteExact(expected: string): Promise<boolean>;
}

export interface ClaudeCodeAccountSnapshot {
  readonly authenticated: boolean;
  readonly authenticationState: BackendAuthenticationState;
  readonly ownsCredential: boolean;
}

export interface ClaudeCodeBrowserLogin {
  readonly method: "oauth_browser";
  readonly loginId: string;
  readonly url: string;
}

export type ClaudeCodeLoginOutcome = "pending" | "completed" | "cancelled" | "error";

export interface ClaudeCodeLoginObservation {
  readonly outcome: ClaudeCodeLoginOutcome;
  readonly failureReason?: "not_a_subscription";
}

export interface ClaudeCodeRuntimeAuthorization {
  readonly environment: Readonly<Record<string, string>>;
  readonly getOAuthToken: ClaudeSdkOAuthTokenProvider;
  isCurrent(): boolean;
  release(): void;
}

export interface ClaudeCodeOAuthAccountOptions {
  readonly credentials: ClaudeCodeCredentialPort;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly loginTimeoutMs?: number;
  readonly refreshTimeoutMs?: number;
  readonly expiryMarginMs?: number;
}

interface OAuthCredential {
  readonly format: 1;
  readonly type: "oauth";
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly subscriptionType: string | null;
  readonly rateLimitTier: string | null;
}

interface TokenResponse {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
  readonly scopes?: readonly string[];
}

interface CallbackResult {
  readonly code: string;
  readonly state: string;
  readonly response: ServerResponse;
}

interface PendingCallback {
  readonly promise: Promise<CallbackResult>;
  resolve(value: CallbackResult): void;
  reject(error: unknown): void;
}

interface ActiveLogin {
  readonly loginId: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly generation: number;
  readonly previousSerialized?: string;
  readonly server: Server;
  readonly controller: AbortController;
  readonly callback: PendingCallback;
  readonly expiresAt: number;
  completion: Promise<void>;
  cleanupError?: Error;
  terminal?: ClaudeCodeLoginOutcome;
}

interface RefreshFlight {
  readonly key: string;
  readonly promise: Promise<OAuthCredential | undefined>;
}

/** Owns the browser flow and keeps refreshable subscription credentials behind an opaque port. */
export class ClaudeCodeOAuthAccount {
  readonly #credentials: ClaudeCodeCredentialPort;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #loginTimeoutMs: number;
  readonly #refreshTimeoutMs: number;
  readonly #expiryMarginMs: number;
  #activeLogin: ActiveLogin | undefined;
  #loginState: "signed_out" | "pending" | "error" = "signed_out";
  #generation = 0;
  #revoking = false;
  #disposed = false;
  #startupLeases = 0;
  readonly #startupDrainWaiters = new Set<() => void>();
  #refreshFlight: RefreshFlight | undefined;
  readonly #loginOutcomes = new Map<string, ClaudeCodeLoginOutcome>();
  readonly #loginFailureReasons = new Map<string, "not_a_subscription">();
  readonly #redactionValues = new Set<string>();
  #mutationTail: Promise<void> = Promise.resolve();
  #transitionTail: Promise<void> = Promise.resolve();

  constructor(options: ClaudeCodeOAuthAccountOptions) {
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#loginTimeoutMs = positiveTimeout(options.loginTimeoutMs, DEFAULT_LOGIN_TIMEOUT_MS);
    this.#refreshTimeoutMs = positiveTimeout(options.refreshTimeoutMs, DEFAULT_REFRESH_TIMEOUT_MS);
    this.#expiryMarginMs = positiveTimeout(options.expiryMarginMs, DEFAULT_EXPIRY_MARGIN_MS);
  }

  async readAccount(refreshToken = false): Promise<ClaudeCodeAccountSnapshot> {
    const serialized = await this.#credentials.readSerialized();
    if (this.#revoking || this.#disposed) {
      return {
        authenticated: false,
        authenticationState: this.#disposed ? "signed_out" : "pending",
        ownsCredential: serialized !== undefined
      };
    }
    if (this.#activeLogin !== undefined) {
      return { authenticated: false, authenticationState: "pending", ownsCredential: serialized !== undefined };
    }
    if (serialized === undefined) {
      return {
        authenticated: false,
        authenticationState: this.#loginState,
        ownsCredential: false
      };
    }
    let credential: OAuthCredential;
    try {
      credential = parseCredential(serialized);
      this.#rememberCredentialSecrets(credential);
    } catch {
      return { authenticated: false, authenticationState: "error", ownsCredential: true };
    }
    const shouldRefresh = refreshToken || credential.expiresAt <= this.#now() + this.#expiryMarginMs;
    if (shouldRefresh) {
      try {
        const refreshed = await this.#refresh(serialized, credential);
        if (refreshed !== undefined) credential = refreshed;
      } catch {
        const authenticated = credential.expiresAt > this.#now();
        return {
          authenticated,
          authenticationState: authenticated ? "authenticated" : "expired",
          ownsCredential: true
        };
      }
    }
    const authenticated = credential.expiresAt > this.#now();
    return {
      authenticated,
      authenticationState: authenticated ? "authenticated" : "expired",
      ownsCredential: true
    };
  }

  async runtimeAuthorization(): Promise<ClaudeCodeRuntimeAuthorization | undefined> {
    const release = this.#acquireStartupLease();
    if (release === undefined) return undefined;
    const generation = this.#generation;
    try {
      if (this.#activeLogin !== undefined) {
        release();
        return undefined;
      }
      const serialized = await this.#credentials.readSerialized();
      if (serialized === undefined) {
        release();
        return undefined;
      }
      let credential: OAuthCredential;
      try {
        credential = parseCredential(serialized);
        this.#rememberCredentialSecrets(credential);
      } catch {
        release();
        return undefined;
      }
      if (credential.expiresAt <= this.#now() + this.#expiryMarginMs) {
        try {
          const refreshed = await this.#refresh(serialized, credential);
          if (refreshed === undefined) {
            release();
            return undefined;
          }
          credential = refreshed;
        } catch {
          if (credential.expiresAt <= this.#now()) {
            release();
            return undefined;
          }
        }
      }
      if (credential.expiresAt <= this.#now()
        || this.#revoking
        || this.#disposed
        || generation !== this.#generation) {
        release();
        return undefined;
      }
      let currentAccessToken = credential.accessToken;
      const isCurrent = () => !this.#revoking
        && !this.#disposed
        && generation === this.#generation;
      const getOAuthToken: ClaudeSdkOAuthTokenProvider = async ({ signal, onDecline }) => {
        try {
          if (!isCurrent()) return null;
          const latestSerialized = await this.#credentials.readSerialized();
          if (latestSerialized === undefined || !isCurrent()) return null;
          const latest = parseCredential(latestSerialized);
          this.#rememberCredentialSecrets(latest);
          const refreshed = await this.#refresh(latestSerialized, latest, signal);
          if (refreshed === undefined || !isCurrent()) return null;
          currentAccessToken = refreshed.accessToken;
          return currentAccessToken;
        } catch {
          onDecline?.();
          return null;
        }
      };
      return {
        environment: {
          CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
          CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
          CLAUDE_CODE_OAUTH_TOKEN: currentAccessToken,
          CLAUDE_CODE_OAUTH_SCOPES: credential.scopes.join(" "),
          CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
          ...(credential.subscriptionType === null
            ? {}
            : { CLAUDE_CODE_SUBSCRIPTION_TYPE: credential.subscriptionType }),
          ...(credential.rateLimitTier === null
            ? {}
            : { CLAUDE_CODE_RATE_LIMIT_TIER: credential.rateLimitTier })
        },
        getOAuthToken,
        isCurrent,
        release
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  async beginLogin(beforeStart?: () => Promise<void>): Promise<ClaudeCodeBrowserLogin> {
    return this.#transition(() => this.#beginLogin(beforeStart));
  }

  async #beginLogin(beforeStart?: () => Promise<void>): Promise<ClaudeCodeBrowserLogin> {
    if (this.#revoking || this.#disposed) throw new Error("Subscription authorization is unavailable.");
    this.#revoking = true;
    const transitionGeneration = ++this.#generation;
    try {
      await this.#drainStartupLeases();
      this.#assertTransitionCurrent(transitionGeneration);
      const active = this.#activeLogin;
      let activeCleanupError: Error | undefined;
      if (active !== undefined) {
        if (active.terminal === undefined) {
          active.controller.abort();
          active.callback.reject(new Error("The OAuth login flow was cancelled."));
        }
        await active.completion;
        this.#assertTransitionCurrent(transitionGeneration);
        activeCleanupError = active.cleanupError;
      }
      await this.#mutationTail;
      this.#assertTransitionCurrent(transitionGeneration);
      if (activeCleanupError !== undefined) throw activeCleanupError;
      await beforeStart?.();
      this.#assertTransitionCurrent(transitionGeneration);
      const previousSerialized = await this.#credentials.readSerialized();
      if (previousSerialized !== undefined) this.#rememberCredentialSecrets(parseCredential(previousSerialized));
      this.#assertTransitionCurrent(transitionGeneration);
      const generation = this.#generation;
      const loginId = randomUUID();
      const state = randomBytes(32).toString("base64url");
      const codeVerifier = randomBytes(32).toString("base64url");
      const callback = pendingCallback();
      const controller = new AbortController();
      const server = createServer();
      server.on("error", () => {
        controller.abort();
        callback.reject(new Error("The local OAuth callback listener failed."));
      });
      await listenOnLoopback(server);
      if (this.#disposed || generation !== this.#generation) {
        await closeServer(server);
        throw new Error("Subscription authorization is unavailable.");
      }
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        server.close();
        throw new Error("The local OAuth callback listener did not start.");
      }
      const redirectUri = `http://localhost:${address.port}/callback`;
      const flow: ActiveLogin = {
        loginId,
        state,
        codeVerifier,
        redirectUri,
        generation,
        ...(previousSerialized === undefined ? {} : { previousSerialized }),
        server,
        controller,
        callback,
        expiresAt: this.#now() + this.#loginTimeoutMs,
        completion: Promise.resolve()
      };
      server.on("request", (request, response) => {
        receiveCallback(flow, request.method, request.url, response);
      });
      this.#activeLogin = flow;
      this.#loginState = "pending";
      this.#rememberLoginOutcome(loginId, "pending");
      flow.completion = this.#completeLogin(flow);
      return {
        method: "oauth_browser",
        loginId,
        url: authorizationUrl(flow)
      };
    } finally {
      this.#revoking = this.#disposed;
    }
  }

  async cancelLogin(loginId: string): Promise<void> {
    return this.#transition(() => this.#cancelLogin(loginId));
  }

  async #cancelLogin(loginId: string): Promise<void> {
    if (!validLoginId(loginId)) throw new Error("The OAuth login identity is invalid.");
    const active = this.#activeLogin;
    if (active === undefined || active.loginId !== loginId) {
      throw new Error("The OAuth login flow is no longer active.");
    }
    if (active.terminal === "completed") throw new Error("The OAuth login flow has already completed.");
    await this.#cancelActiveLogin("signed_out");
    this.#rememberLoginOutcome(loginId, "cancelled");
  }

  readLoginOutcome(loginId: string): ClaudeCodeLoginObservation {
    if (!validLoginId(loginId)) throw new Error("The OAuth login identity is invalid.");
    const failureReason = this.#loginFailureReasons.get(loginId);
    return {
      outcome: this.#loginOutcomes.get(loginId) ?? "error",
      ...(failureReason === undefined ? {} : { failureReason })
    };
  }

  async logout(hooks: {
    readonly beforeDelete?: () => Promise<void>;
    readonly onDeleted?: () => void;
  } = {}): Promise<void> {
    return this.#transition(() => this.#logout(hooks));
  }

  async #logout(hooks: {
    readonly beforeDelete?: () => Promise<void>;
    readonly onDeleted?: () => void;
  }): Promise<void> {
    if (this.#disposed) throw new Error("Subscription authorization is unavailable.");
    this.#revoking = true;
    ++this.#generation;
    try {
      await this.#drainStartupLeases();
      const active = this.#activeLogin;
      let activeCleanupError: Error | undefined;
      if (active !== undefined) {
        if (active.terminal === undefined) {
          active.controller.abort();
          active.callback.reject(new Error("The OAuth login flow was cancelled."));
        }
        await active.completion;
        activeCleanupError = active.cleanupError;
      }
      await this.#mutationTail;
      if (activeCleanupError !== undefined) throw activeCleanupError;
      await hooks.beforeDelete?.();
      const deleted = await this.#mutate(async () => {
        const serialized = await this.#credentials.readSerialized();
        return serialized === undefined || this.#credentials.deleteExact(serialized);
      });
      if (!deleted) throw new Error("The subscription credential could not be removed.");
      this.#loginState = "signed_out";
      hooks.onDeleted?.();
    } finally {
      ++this.#generation;
      this.#revoking = this.#disposed;
    }
  }

  async dispose(): Promise<void> {
    return this.#transition(() => this.#dispose());
  }

  async quiesceForReplacement(): Promise<void> {
    return this.#transition(() => this.#quiesceForReplacement());
  }

  async #quiesceForReplacement(): Promise<void> {
    if (this.#disposed) return;
    this.#revoking = true;
    ++this.#generation;
    try {
      await this.#drainStartupLeases();
      const active = this.#activeLogin;
      let activeCleanupError: Error | undefined;
      if (active !== undefined) {
        if (active.terminal === undefined) {
          active.controller.abort();
          active.callback.reject(new Error("The OAuth login flow was cancelled."));
        }
        await active.completion;
        activeCleanupError = active.cleanupError;
      }
      await this.#mutationTail;
      if (activeCleanupError !== undefined) throw activeCleanupError;
    } finally {
      ++this.#generation;
      this.#revoking = this.#disposed;
    }
  }

  async #dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#revoking = true;
    ++this.#generation;
    await this.#drainStartupLeases();
    const active = this.#activeLogin;
    let activeCleanupError: Error | undefined;
    if (active !== undefined) {
      if (active.terminal === undefined) {
        active.controller.abort();
        active.callback.reject(new Error("The OAuth login flow was cancelled."));
      }
      await active.completion;
      activeCleanupError = active.cleanupError;
    }
    await this.#mutationTail;
    if (activeCleanupError !== undefined) throw activeCleanupError;
  }

  redactionValues(): readonly string[] {
    return [...this.#redactionValues];
  }

  async #completeLogin(flow: ActiveLogin): Promise<void> {
    const timer = setTimeout(() => flow.controller.abort(), this.#loginTimeoutMs);
    let callbackResponse: ServerResponse | undefined;
    try {
      const callback = await withAbort(flow.callback.promise, flow.controller.signal);
      callbackResponse = callback.response;
      const token = await this.#exchangeCode(flow, callback.code, callback.state);
      if (token.scopes === undefined) throw new OAuthNotSubscriptionError();
      const nextCredential: OAuthCredential = {
        format: 1,
        type: "oauth",
        accessToken: token.accessToken,
        refreshToken: requiredRefreshToken(token.refreshToken),
        expiresAt: token.expiresAt,
        scopes: token.scopes,
        subscriptionType: null,
        rateLimitTier: null
      };
      this.#rememberCredentialSecrets(nextCredential);
      const serialized = serializeCredential(nextCredential);
      const committed = await this.#mutate(async () => {
        if (flow.controller.signal.aborted || flow.generation !== this.#generation) return false;
        const written = await this.#credentials.compareAndSet({
          expected: flow.previousSerialized,
          value: serialized,
          expiresAt: nextCredential.expiresAt
        });
        if (!written) return false;
        if (!flow.controller.signal.aborted && flow.generation === this.#generation) {
          flow.terminal = "completed";
          this.#loginState = "signed_out";
          this.#rememberLoginOutcome(flow.loginId, "completed");
          return true;
        }
        try {
          const restored = flow.previousSerialized === undefined
            ? await this.#credentials.deleteExact(serialized)
            : await this.#credentials.restoreExact({
                expected: serialized,
                value: flow.previousSerialized,
                expiresAt: parseCredential(flow.previousSerialized).expiresAt
              });
          if (!restored) throw new Error("The cancelled OAuth credential changed concurrently.");
        } catch {
          flow.cleanupError = new Error("The cancelled OAuth credential could not be restored safely.");
          throw flow.cleanupError;
        }
        return false;
      });
      if (!committed) throw new Error("The OAuth login flow was cancelled.");
      callback.response.writeHead(302, {
        Location: SUCCESS_URL,
        "Cache-Control": "no-store"
      });
      callback.response.end();
      void this.#backfillSubscriptionProfile(serialized, nextCredential, flow.generation)
        .catch(() => undefined);
    } catch (error) {
      if (callbackResponse !== undefined && !callbackResponse.headersSent) {
        callbackResponse.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store"
        });
        callbackResponse.end("Sign-in could not be completed. Return to Joko and try again.");
      } else if (callbackResponse !== undefined && !callbackResponse.writableEnded) {
        callbackResponse.end();
      }
      if (this.#activeLogin?.loginId === flow.loginId && flow.terminal !== "completed") {
        const cancelled = flow.generation !== this.#generation;
        this.#loginState = cancelled ? "signed_out" : "error";
        flow.terminal = cancelled ? "cancelled" : "error";
        this.#rememberLoginOutcome(
          flow.loginId,
          flow.terminal,
          !cancelled && error instanceof OAuthNotSubscriptionError
            ? "not_a_subscription"
            : undefined
        );
      }
    } finally {
      clearTimeout(timer);
      await closeServer(flow.server);
      if (this.#activeLogin?.loginId === flow.loginId) this.#activeLogin = undefined;
    }
  }

  async #exchangeCode(flow: ActiveLogin, code: string, state: string): Promise<TokenResponse> {
    const bounded = boundedAbort(flow.controller.signal, this.#refreshTimeoutMs);
    try {
      const response = await this.#fetch(TOKEN_URL, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: flow.redirectUri,
          client_id: CLIENT_ID,
          code_verifier: flow.codeVerifier,
          state
        }),
        signal: bounded.signal
      });
      if (!response.ok) throw new Error("The OAuth authorization code was rejected.");
      return parseTokenResponse(await readJsonResponse(response), this.#now());
    } finally {
      bounded.dispose();
    }
  }

  async #refresh(
    serialized: string,
    credential: OAuthCredential,
    signal?: AbortSignal
  ): Promise<OAuthCredential | undefined> {
    if (this.#revoking || this.#disposed) return undefined;
    const generation = this.#generation;
    const key = createHash("sha256")
      .update(`${generation}\0${credential.refreshToken}`, "utf8")
      .digest("base64url");
    let flight = this.#refreshFlight;
    if (flight === undefined || flight.key !== key) {
      const promise = this.#performRefresh(serialized, credential, generation);
      flight = { key, promise };
      this.#refreshFlight = flight;
      void promise.finally(() => {
        if (this.#refreshFlight?.promise === promise) this.#refreshFlight = undefined;
      }).catch(() => undefined);
    }
    return signal === undefined ? flight.promise : withAbort(flight.promise, signal);
  }

  async #performRefresh(
    serialized: string,
    credential: OAuthCredential,
    generation: number
  ): Promise<OAuthCredential | undefined> {
    const bounded = boundedAbort(undefined, this.#refreshTimeoutMs);
    let token: TokenResponse;
    try {
      const response = await this.#fetch(TOKEN_URL, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
          client_id: CLIENT_ID,
          scope: credential.scopes.join(" ")
        }),
        signal: bounded.signal
      });
      if (!response.ok) throw new Error("The OAuth credential could not be refreshed.");
      token = parseTokenResponse(await readJsonResponse(response), this.#now());
    } finally {
      bounded.dispose();
    }
    const refreshed: OAuthCredential = {
      format: 1,
      type: "oauth",
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? credential.refreshToken,
      expiresAt: token.expiresAt,
      scopes: token.scopes ?? credential.scopes,
      subscriptionType: credential.subscriptionType,
      rateLimitTier: credential.rateLimitTier
    };
    this.#rememberCredentialSecrets(refreshed);
    const result = await this.#mutate(async (): Promise<{
      readonly credential: OAuthCredential;
      readonly committedSerialized?: string;
    } | undefined> => {
      let expected = serialized;
      let candidate = refreshed;
      while (generation === this.#generation && !this.#revoking && !this.#disposed) {
        const current = await this.#credentials.readSerialized();
        if (current === undefined) return undefined;
        if (current !== expected) {
          const latest = parseCredential(current);
          this.#rememberCredentialSecrets(latest);
          if (!sameTokenIdentity(latest, credential)) return { credential: latest };
          expected = current;
          candidate = {
            ...refreshed,
            subscriptionType: latest.subscriptionType,
            rateLimitTier: latest.rateLimitTier
          };
        }
        const candidateSerialized = serializeCredential(candidate);
        const written = await this.#credentials.compareAndSet({
          expected,
          value: candidateSerialized,
          expiresAt: candidate.expiresAt
        });
        if (written && generation === this.#generation && !this.#revoking && !this.#disposed) {
          return { credential: candidate, committedSerialized: candidateSerialized };
        }
      }
      return undefined;
    });
    if (result?.committedSerialized !== undefined) {
      void this.#backfillSubscriptionProfile(
        result.committedSerialized,
        result.credential,
        generation
      )
        .catch(() => undefined);
    }
    return result?.credential;
  }

  async #backfillSubscriptionProfile(
    serialized: string,
    credential: OAuthCredential,
    generation: number
  ): Promise<void> {
    const profile = await this.#readSubscriptionProfile(credential.accessToken);
    if (profile === undefined || generation !== this.#generation || this.#revoking || this.#disposed) return;
    const updated: OAuthCredential = {
      ...credential,
      subscriptionType: profile.subscriptionType ?? credential.subscriptionType,
      rateLimitTier: profile.rateLimitTier ?? credential.rateLimitTier
    };
    if (updated.subscriptionType === credential.subscriptionType
      && updated.rateLimitTier === credential.rateLimitTier) return;
    const nextSerialized = serializeCredential(updated);
    await this.#mutate(async () => {
      if (generation !== this.#generation || this.#revoking || this.#disposed) return;
      const current = await this.#credentials.readSerialized();
      if (current !== serialized) return;
      await this.#credentials.compareAndSet({
        expected: serialized,
        value: nextSerialized,
        expiresAt: updated.expiresAt
      });
    });
  }

  async #readSubscriptionProfile(
    accessToken: string,
    parentSignal?: AbortSignal
  ): Promise<{ readonly subscriptionType: string | null; readonly rateLimitTier: string | null } | undefined> {
    const bounded = boundedAbort(parentSignal, this.#refreshTimeoutMs);
    try {
      const response = await this.#fetch(PROFILE_URL, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Cache-Control": "no-cache"
        },
        signal: bounded.signal
      });
      if (!response.ok) return undefined;
      const value = await readJsonResponse(response);
      if (!isRecord(value) || !isRecord(value["organization"])) return undefined;
      const organizationType = value["organization"]["organization_type"];
      const rateLimitTier = value["organization"]["rate_limit_tier"];
      const subscriptionType = typeof organizationType === "string"
        ? ORGANIZATION_TYPE_TO_SUBSCRIPTION.get(organizationType) ?? null
        : null;
      return {
        subscriptionType,
        rateLimitTier: validNullableMetadata(rateLimitTier) && rateLimitTier !== null
          ? rateLimitTier
          : null
      };
    } catch {
      return undefined;
    } finally {
      bounded.dispose();
    }
  }

  async #cancelActiveLogin(nextState: "signed_out" | "error"): Promise<void> {
    const active = this.#activeLogin;
    if (active === undefined) return;
    ++this.#generation;
    active.controller.abort();
    active.callback.reject(new Error("The OAuth login flow was cancelled."));
    await active.completion;
    if (active.cleanupError !== undefined) throw active.cleanupError;
    this.#rememberLoginOutcome(active.loginId, "cancelled");
    this.#loginState = nextState;
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #transition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#transitionTail.then(operation, operation);
    this.#transitionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #assertTransitionCurrent(generation: number): void {
    if (this.#disposed || generation !== this.#generation) {
      throw new Error("Subscription authorization is unavailable.");
    }
  }

  #acquireStartupLease(): (() => void) | undefined {
    if (this.#revoking || this.#disposed) return undefined;
    this.#startupLeases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#startupLeases -= 1;
      if (this.#startupLeases !== 0) return;
      for (const resolve of this.#startupDrainWaiters) resolve();
      this.#startupDrainWaiters.clear();
    };
  }

  #drainStartupLeases(): Promise<void> {
    if (this.#startupLeases === 0) return Promise.resolve();
    return new Promise((resolve) => { this.#startupDrainWaiters.add(resolve); });
  }

  #rememberCredentialSecrets(credential: OAuthCredential): void {
    for (const value of [credential.accessToken, credential.refreshToken]) {
      this.#redactionValues.add(value);
    }
  }

  #rememberLoginOutcome(
    loginId: string,
    outcome: ClaudeCodeLoginOutcome,
    failureReason?: "not_a_subscription"
  ): void {
    this.#loginOutcomes.delete(loginId);
    this.#loginOutcomes.set(loginId, outcome);
    this.#loginFailureReasons.delete(loginId);
    if (failureReason !== undefined) this.#loginFailureReasons.set(loginId, failureReason);
    while (this.#loginOutcomes.size > 32) {
      const oldest = this.#loginOutcomes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#loginOutcomes.delete(oldest);
      this.#loginFailureReasons.delete(oldest);
    }
  }
}

function authorizationUrl(flow: ActiveLogin): string {
  const challenge = createHash("sha256").update(flow.codeVerifier, "utf8").digest("base64url");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", flow.redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", flow.state);
  return url.toString();
}

function receiveCallback(
  flow: ActiveLogin,
  method: string | undefined,
  requestUrl: string | undefined,
  response: ServerResponse
): void {
  if (method !== "GET" || requestUrl === undefined) {
    rejectCallbackRequest(response, 405, "Unsupported callback request.");
    return;
  }
  let url: URL;
  try {
    url = new URL(requestUrl, flow.redirectUri);
  } catch {
    rejectCallbackRequest(response, 400, "Invalid callback request.");
    return;
  }
  if (url.pathname !== "/callback") {
    rejectCallbackRequest(response, 404, "Callback route not found.");
    return;
  }
  const state = url.searchParams.get("state");
  if (state !== flow.state) {
    rejectCallbackRequest(response, 400, "Invalid callback request.");
    return;
  }
  if (url.searchParams.has("error")) {
    rejectCallbackRequest(response, 400, "Sign-in was not authorized.");
    flow.callback.reject(new Error("The OAuth provider did not authorize the login."));
    return;
  }
  const code = url.searchParams.get("code");
  if (code === null
    || code.length === 0
    || code.length > 8_192
    || /[\u0000-\u001f\u007f]/u.test(code)) {
    rejectCallbackRequest(response, 400, "Invalid callback request.");
    flow.callback.reject(new Error("The OAuth callback was invalid."));
    return;
  }
  flow.callback.resolve({ code, state, response });
}

function rejectCallbackRequest(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(message);
}

function pendingCallback(): PendingCallback {
  let settled = false;
  let resolvePromise!: (value: CallbackResult) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<CallbackResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    resolve: (value) => {
      if (settled) {
        rejectCallbackRequest(value.response, 409, "The callback has already been received.");
        return;
      }
      settled = true;
      resolvePromise(value);
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    }
  };
}

function parseCredential(serialized: string): OAuthCredential {
  if (Buffer.byteLength(serialized, "utf8") === 0 || Buffer.byteLength(serialized, "utf8") > MAX_CREDENTIAL_BYTES) {
    throw new Error("The subscription credential is invalid.");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("The subscription credential is invalid.");
  }
  if (!isRecord(value)
    || value["format"] !== 1
    || value["type"] !== "oauth"
    || !boundedSecret(value["accessToken"])
    || !boundedSecret(value["refreshToken"])
    || !Number.isSafeInteger(value["expiresAt"])
    || (value["expiresAt"] as number) < 1
    || !exactKeys(value, [
      "accessToken",
      "expiresAt",
      "format",
      "rateLimitTier",
      "refreshToken",
      "scopes",
      "subscriptionType",
      "type"
    ])
    || !validNullableMetadata(value["subscriptionType"])
    || !validNullableMetadata(value["rateLimitTier"])
    || !validScopes(value["scopes"])) {
    throw new Error("The subscription credential is invalid.");
  }
  return {
    format: 1,
    type: "oauth",
    accessToken: value["accessToken"],
    refreshToken: value["refreshToken"],
    expiresAt: value["expiresAt"] as number,
    scopes: [...value["scopes"]],
    subscriptionType: value["subscriptionType"] as string | null,
    rateLimitTier: value["rateLimitTier"] as string | null
  };
}

function serializeCredential(credential: OAuthCredential): string {
  return JSON.stringify(credential);
}

function sameTokenIdentity(left: OAuthCredential, right: OAuthCredential): boolean {
  return left.accessToken === right.accessToken && left.refreshToken === right.refreshToken;
}

function parseTokenResponse(value: unknown, now: number): TokenResponse {
  if (!isRecord(value)
    || !boundedSecret(value["access_token"])
    || !Number.isFinite(value["expires_in"])
    || (value["refresh_token"] !== undefined && !boundedSecret(value["refresh_token"]))) {
    throw new Error("The OAuth token response is invalid.");
  }
  const expiresInSeconds = Math.floor(value["expires_in"] as number);
  if (expiresInSeconds < 1 || expiresInSeconds > 366 * 24 * 60 * 60) {
    throw new Error("The OAuth token response is invalid.");
  }
  const expiresAt = now + expiresInSeconds * 1_000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error("The OAuth token response is invalid.");
  }
  const scope = value["scope"];
  const scopes = typeof scope === "string"
    ? scope.split(/\s+/u).filter((item) => item.length > 0)
    : undefined;
  if (scopes !== undefined) {
    if (!scopes.includes("user:inference")) throw new OAuthNotSubscriptionError();
    if (!validReturnedScopes(scopes)) throw new Error("The OAuth token response is invalid.");
  }
  return {
    accessToken: value["access_token"],
    ...(value["refresh_token"] === undefined ? {} : { refreshToken: value["refresh_token"] }),
    expiresAt,
    ...(scopes === undefined ? {} : { scopes })
  };
}

function requiredRefreshToken(value: string | undefined): string {
  if (!boundedSecret(value)) throw new Error("The OAuth token response has no refresh credential.");
  return value;
}

function boundedSecret(value: unknown): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") > 0
    && Buffer.byteLength(value, "utf8") <= 32_768
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validNullableMetadata(value: unknown): value is string | null {
  return value === null || (typeof value === "string"
    && Buffer.byteLength(value, "utf8") > 0
    && Buffer.byteLength(value, "utf8") <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value));
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_OAUTH_RESPONSE_BYTES) {
      throw new Error("The OAuth response is too large.");
    }
  }
  if (response.body === null) throw new Error("The OAuth response body is missing.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_OAUTH_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("The OAuth response is too large.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as unknown;
  } catch {
    throw new Error("The OAuth response is invalid.");
  }
}

function validScopes(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 32
    && new Set(value).size === value.length
    && value.includes("user:inference")
    && value.every((item) => typeof item === "string"
      && item.length > 0
      && item.length <= 256
      && !/[\u0000-\u001f\u007f]/u.test(item)
      && (OAUTH_SCOPES as readonly string[]).includes(item));
}

function validReturnedScopes(value: readonly string[]): boolean {
  return value.length > 0
    && value.length <= 32
    && new Set(value).size === value.length
    && value.every((item) => item.length > 0
      && item.length <= 256
      && !/[\u0000-\u001f\u007f]/u.test(item)
      && (OAUTH_SCOPES as readonly string[]).includes(item));
}

class OAuthNotSubscriptionError extends Error {
  constructor() {
    super("The authorized account does not provide subscription inference access.");
    this.name = "OAuthNotSubscriptionError";
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validLoginId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError("OAuth timeout must be positive.");
  return resolved;
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "localhost");
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 1_000);
    server.closeIdleConnections?.();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function boundedAbort(parent: AbortSignal | undefined, timeoutMs: number): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    }
  };
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("The operation was cancelled."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("The operation was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

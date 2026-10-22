import { describe, expect, it, vi } from "vitest";
import { CodexExternalAuthSession, assertCodexEphemeralAuth, useCodexHistoryHome } from "./external-auth.js";
import { AppServerHost } from "./host.js";
import { ScriptedRpcTransport } from "./testing.js";
import type { JsonObject, JsonValue } from "./protocol.js";

const initial = { accessToken: "test-token-old", chatgptAccountId: "account-b" };

describe("external account authentication", () => {
  it.each(["win32", "darwin", "linux"] as const)("honors %s environment casing without leaking Windows identity aliases", platform => {
    const aliases = { Codex_Home: "/old-home", Codex_Access_Token: "old-token", codex_api_key: "old-key", OpenAI_API_Key: "old-key",
      OpenAI_Federation_Rule_Id: "old-rule", OpenAI_Identity_Token_File: "/old-file", OpenAI_Workload_Identity_Context: "old-context" };
    const env = { ...aliases, CODEX_HOME: "/account-b", OPENAI_API_KEY: "old-uppercase", OWNED_GATEWAY_API_KEY: "selected-gateway", Path: "/bin" };
    expect(useCodexHistoryHome(env, "/history-a", platform)).toEqual({ ...(platform === "win32" ? {} : aliases),
      CODEX_HOME: "/history-a", OWNED_GATEWAY_API_KEY: "selected-gateway", Path: "/bin" });
    expect(env).toMatchObject({ ...aliases, CODEX_HOME: "/account-b", OPENAI_API_KEY: "old-uppercase" });
  });

  it("removes inherited native identities while preserving the selected gateway credentials", () => {
    const env = { CODEX_HOME: "/account-b", CODEX_ACCESS_TOKEN: "old", CODEX_API_KEY: "old", OPENAI_API_KEY: "old", OPENAI_FEDERATION_RULE_ID: "",
      OPENAI_IDENTITY_TOKEN_FILE: "/old", OPENAI_WORKLOAD_IDENTITY_CONTEXT: "old", OWNED_GATEWAY_API_KEY: "selected-gateway", PATH: "/bin" };
    expect(useCodexHistoryHome(env, "/history-a")).toEqual({ CODEX_HOME: "/history-a", OWNED_GATEWAY_API_KEY: "selected-gateway", PATH: "/bin" });
    expect(env.CODEX_HOME).toBe("/account-b");
  });

  it("refreshes the pinned account and reauthenticates each new client", async () => {
    const readTokens = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue({ ...initial, accessToken: "test-token-new" });
    const session = new CodexExternalAuthSession({ readTokens });
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    await session.authenticate(request);
    expect(request).toHaveBeenCalledWith("account/login/start", { type: "chatgptAuthTokens", ...initial });
    await expect(session.tokens(true, "account-b")).resolves.toMatchObject({ accessToken: "test-token-new" });
    expect(readTokens).toHaveBeenLastCalledWith(true, "test-token-old");
    await session.authenticate(request);
    expect(request).toHaveBeenLastCalledWith("account/login/start", { type: "chatgptAuthTokens", ...initial, accessToken: "test-token-new" });
  });

  it("does not treat the same rejected token as a refresh", async () => {
    const session = new CodexExternalAuthSession({ readTokens: async () => initial });
    await session.tokens(false);
    await expect(session.tokens(true, "account-b")).rejects.toThrow("authentication is unavailable");
  });

  it("rejects foreign refreshes before reading credentials and account changes on reconnect", async () => {
    const readTokens = vi.fn().mockResolvedValue(initial), session = new CodexExternalAuthSession({ readTokens });
    await session.tokens(false);
    await expect(session.tokens(true, "account-a")).rejects.toThrow("authentication is unavailable");
    expect(readTokens).toHaveBeenCalledTimes(1);
    readTokens.mockResolvedValue({ ...initial, chatgptAccountId: "account-c" });
    await expect(session.tokens(false)).rejects.toThrow("authentication is unavailable");
  });

  it("redacts source and RPC errors, including echoed credentials", async () => {
    const source = new CodexExternalAuthSession({ readTokens: async () => { throw new Error("secret-token"); } });
    await expect(source.tokens(false)).rejects.toThrow("Codex account authentication is unavailable or has changed");
    const session = new CodexExternalAuthSession({ readTokens: async () => initial });
    await expect(session.authenticate(async () => { throw new Error("secret-token"); })).rejects.toThrow("Codex could not initialize isolated account authentication");
    await expect(session.authenticate(async () => ({ type: "apiKey" }))).rejects.toThrow("Codex could not initialize isolated account authentication");
  });

  it("refuses effective persistent credential policy before sending external tokens", async () => {
    const request = vi.fn().mockResolvedValue({ config: { cli_auth_credentials_store: "file" } });
    await expect(assertCodexEphemeralAuth(request)).rejects.toThrow("isolated account authentication");
    expect(request).toHaveBeenCalledExactlyOnceWith("config/read", { includeLayers: false });
  });

  it("bounds credential reads and ignores results arriving after timeout", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: typeof initial) => void;
      const session = new CodexExternalAuthSession({ readTokens: () => new Promise(done => { resolve = done; }) });
      const rejected = expect(session.tokens(false)).rejects.toThrow("authentication is unavailable");
      await vi.advanceTimersByTimeAsync(10_000); await rejected; resolve(initial);
      await expect(session.tokens(true, initial.chatgptAccountId)).rejects.toThrow("authentication is unavailable");
    } finally { vi.useRealTimers(); }
  });
});

function transport(credentialStore = "ephemeral") {
  return new ScriptedRpcTransport(async (method, params): Promise<JsonValue> => method === "initialize"
    ? { userAgent: "joko/0.159.2", codexHome: "/private", platformFamily: "unix", platformOs: "linux" }
    : method === "config/read" ? { config: { cli_auth_credentials_store: credentialStore } }
    : method === "account/login/start" ? { type: (params as JsonObject)["type"]! } : {});
}

describe("native account owner routing", () => {
  it("gates concurrent requests until ephemeral policy and authentication finish", async () => {
    const native = transport(); let finish!: (value: typeof initial) => void;
    const readTokens = vi.fn(() => new Promise<typeof initial>(resolve => { finish = resolve; }));
    const host = new AppServerHost({ transportFactory: () => native, externalAuth: { readTokens } });
    try {
      const first = host.request("model/list", {}), second = host.request("thread/list", {});
      await vi.waitFor(() => expect(readTokens).toHaveBeenCalledTimes(1));
      expect(host.initializeResult).toBeUndefined();
      expect(native.requests.map(value => value.method)).toEqual(["initialize", "config/read"]);
      finish(initial); await Promise.all([first, second]);
      expect(native.requests.map(value => value.method)).toEqual(["initialize", "config/read", "account/login/start", "model/list", "thread/list"]);
    } finally { await host.shutdown(); }
  });

  it("never reads account credentials when the effective policy can persist them", async () => {
    const native = transport("file"), readTokens = vi.fn(async () => initial);
    const host = new AppServerHost({ transportFactory: () => native, externalAuth: { readTokens } });
    try { await expect(host.ensureStarted()).rejects.toThrow("isolated account authentication"); expect(readTokens).not.toHaveBeenCalled(); }
    finally { await host.shutdown(); }
  });

  it("routes exact account refresh without granting Source tool handlers an account port", async () => {
    const native = transport(), readTokens = vi.fn(async (refresh: boolean) => ({ ...initial, accessToken: refresh ? "test-token-new" : initial.accessToken }));
    const host = new AppServerHost({ transportFactory: () => native, externalAuth: { readTokens } });
    try {
      await host.ensureStarted(); const onRequest = vi.fn(async () => undefined);
      await host.subscribe("source-thread", host.generation, { onNotification: () => undefined, onDisconnect: () => undefined, onRequest });
      await expect(native.requestFromServer("account/chatgptAuthTokens/refresh", { reason: "unauthorized", previousAccountId: "account-a", threadId: "source-thread" })).rejects.toThrow();
      await expect(native.requestFromServer("account/chatgptAuthTokens/refresh", { reason: "periodic", previousAccountId: "account-b", threadId: "source-thread" })).rejects.toThrow();
      expect(readTokens).toHaveBeenCalledTimes(1);
      await expect(native.requestFromServer("account/chatgptAuthTokens/refresh", { reason: "unauthorized", previousAccountId: "account-b", threadId: "source-thread" }))
        .resolves.toEqual({ ...initial, accessToken: "test-token-new" });
      expect(readTokens).toHaveBeenLastCalledWith(true, "test-token-old"); expect(onRequest).not.toHaveBeenCalled();
    } finally { await host.shutdown(); }
  });

  it("rejects tokens captured before shutdown without sending them to a retired process", async () => {
    const native = transport(); let finish!: (value: typeof initial) => void;
    const readTokens = vi.fn(() => new Promise<typeof initial>(resolve => { finish = resolve; }));
    const host = new AppServerHost({ transportFactory: () => native, externalAuth: { readTokens } });
    const starting = expect(host.ensureStarted()).rejects.toThrow("isolated account authentication");
    await vi.waitFor(() => expect(readTokens).toHaveBeenCalledTimes(1));
    await host.shutdown(); finish(initial); await starting;
    expect(native.requests.map(value => value.method)).toEqual(["initialize", "config/read"]);
  });
});

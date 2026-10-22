import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { CodexChatgptTokens, CodexExternalAuth } from "./external-auth.js";

export type CodexHostedAuthenticationAuthority =
  | { readonly kind: "chatgpt"; readonly readTokens: CodexExternalAuth["readTokens"] }
  | { readonly kind: "api_key"; readonly readApiKey: () => Promise<string> };
type Authentication = { readonly kind: "chatgpt"; readonly principal: string; readonly tokens: CodexChatgptTokens } | { readonly kind: "api_key"; readonly apiKey: string };

/** Exact SDK-owned credential reader. No token is projected to account status. */
export async function readCodexOwnedAuthentication(home: string, environmentApiKey?: string): Promise<Authentication> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const target = join(home, "auth.json"), pathInfo = await lstat(target);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size > 1024 * 1024) throw new Error();
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathInfo.dev || before.ino !== pathInfo.ino || before.size > 1024 * 1024) throw new Error();
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.byteLength > 1024 * 1024 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error();
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!record(decoded)) throw new Error();
    const tokens = decoded["tokens"];
    if (record(tokens) && typeof tokens["access_token"] === "string" && tokens["access_token"]) {
      const jwt = typeof tokens["id_token"] === "string" ? tokens["id_token"] : tokens["access_token"];
      const payload = jwt.split(".")[1]; let claims: Record<string, unknown> = {};
      if (payload) { const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); if (record(decoded)) claims = decoded; }
      const auth = record(claims["https://api.openai.com/auth"]) ? claims["https://api.openai.com/auth"] : {};
      const accountId = tokens["account_id"] ?? auth["chatgpt_account_id"];
      const subject = claims["sub"];
      if (typeof accountId !== "string" || !accountId || accountId.length > 1024 || typeof subject !== "string" || !subject) throw new Error();
      const plan = auth["chatgpt_plan_type"];
      return { kind: "chatgpt", principal: createHash("sha256").update(`${subject}\0${accountId}`).digest("hex"), tokens: { accessToken: tokens["access_token"], chatgptAccountId: accountId,
        ...(typeof plan === "string" && plan ? { chatgptPlanType: plan } : {}) } };
    }
    const apiKey = decoded["OPENAI_API_KEY"];
    if (typeof apiKey === "string" && apiKey) return { kind: "api_key", apiKey };
    throw new Error();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && environmentApiKey) return { kind: "api_key", apiKey: environmentApiKey };
    throw new Error("The selected native account authentication is unavailable.");
  } finally { await handle?.close(); }
}

/** The original Adapter owns refresh; isolated SDKs never receive refresh tokens. */
export async function captureCodexHostedAuthentication(options: {
  readonly home: string; readonly environmentApiKey?: string; readonly assertCurrent: () => void;
  readonly refresh: (staleAccessToken: string) => Promise<void>;
}): Promise<CodexHostedAuthenticationAuthority> {
  options.assertCurrent(); const initial = await readCodexOwnedAuthentication(options.home, options.environmentApiKey); options.assertCurrent();
  const read = async () => { options.assertCurrent(); const result = await readCodexOwnedAuthentication(options.home, options.environmentApiKey); options.assertCurrent(); return result; };
  if (initial.kind === "api_key") {
    const identity = createHash("sha256").update(initial.apiKey).digest("hex");
    return { kind: "api_key", readApiKey: async () => {
      const current = await read();
      if (current.kind !== "api_key" || createHash("sha256").update(current.apiKey).digest("hex") !== identity) throw new Error("The native account changed.");
      return current.apiKey;
    } };
  }
  const accountId = initial.tokens.chatgptAccountId, principal = initial.principal;
  return { kind: "chatgpt", readTokens: async (refresh, staleAccessToken) => {
    let current = await read();
    if (current.kind !== "chatgpt" || current.tokens.chatgptAccountId !== accountId || current.principal !== principal) throw new Error("The native account changed.");
    if (refresh && current.tokens.accessToken === staleAccessToken) {
      await options.refresh(staleAccessToken); options.assertCurrent(); current = await read();
    }
    if (current.kind !== "chatgpt" || current.tokens.chatgptAccountId !== accountId || current.principal !== principal
      || refresh && current.tokens.accessToken === staleAccessToken) throw new Error("The native account refresh is unavailable.");
    return current.tokens;
  } };
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

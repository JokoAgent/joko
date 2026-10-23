import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, ProxyAgent, buildConnector, fetch as undiciFetch, Dispatcher } from "undici";
import { connectSocks5Tunnel } from "@joko/outbound-network";
import { isBrowserProxyRequestUrlAllowed, type BrowserProxyLookup } from "@joko/tool-browser";
import { evaluateOrderedPolicyRules, type AdapterContext } from "@joko/core";
import { fetchWebPage, type GuardedFetch } from "./hosted-agent-claude-web-fetch.js";
import { HostedAgentExecutorError, type HostedAgentExecutorPolicy } from "./hosted-agent-executor.js";

export class HostedAgentWebFetchBlockedError extends Error {
  constructor() { super("The destination requires Source network approval."); }
}
type Result = Awaited<ReturnType<typeof fetchWebPage>>;
export interface HostedAgentClaudeWebFetchOptions {
  readonly context: AdapterContext;
  readonly readPolicy: () => HostedAgentExecutorPolicy;
  readonly assertCurrent: () => void;
  readonly resolveProxy?: (target: string, options: { readonly signal?: AbortSignal }) => Promise<string | null | undefined> | string | null | undefined;
  readonly environmentProxyForTarget?: (target: URL) => string | null | undefined;
  readonly lookup?: (hostname: string) => Promise<readonly string[]>;
  /** Private test/transport seam: the vetted address is explicit and must be pinned. */
  readonly request?: (input: { readonly url: URL; readonly addresses: readonly string[]; readonly proxy: string | null | undefined;
    readonly init: RequestInit; readonly assertCurrent: () => void }) => Promise<{ response: Response; release(): Promise<void> }>;
}

/** Captured for one original Source Queue operation; never a creation-time
 * callback reused by later inputs. DNS, proxy and approval remain on Source. */
export function createHostedAgentClaudeWebFetch(options: HostedAgentClaudeWebFetchOptions): (input: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<Result> {
  return async (input, parentSignal) => {
    const signal = AbortSignal.any([parentSignal, options.context.signal, AbortSignal.timeout(30_000)]);
    signal.throwIfAborted(); options.assertCurrent();
    if (typeof input.url !== "string" || !input.url || input.url.length > 16_384 || /[\x00-\x20\x7f]/u.test(input.url)
      || input.prompt !== undefined && (typeof input.prompt !== "string" || input.prompt.length > 16_384)
      || input.start_index !== undefined && (!Number.isSafeInteger(input.start_index) || Number(input.start_index) < 0)
      || Object.keys(input).some(key => !["url", "prompt", "start_index"].includes(key))) throw new HostedAgentExecutorError("INVALID_REQUEST");
    let url: URL; try { url = new URL(input.url); } catch { throw new HostedAgentExecutorError("INVALID_REQUEST"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !url.hostname) throw new HostedAgentExecutorError("INVALID_REQUEST");
    url.hash = "";
    const policy = options.readPolicy(), authorization = options.context.nativeToolAuthorization, revision = authorization?.capture();
    const assert = () => {
      signal.throwIfAborted(); options.assertCurrent();
      if (options.readPolicy().revision !== policy.revision) throw new HostedAgentExecutorError("STALE_AUTHORITY");
      try { authorization?.assertCurrent(revision); } catch { throw new HostedAgentExecutorError("STALE_AUTHORITY"); }
    };
    const delegated = await authorization?.review({ toolName: "WebFetch", input: { ...input }, signal }); assert();
    if (delegated?.unavailable || delegated?.verdict === "block") throw new HostedAgentExecutorError("ACCESS_DENIED");
    const approved = new Set<string>();
    const authorizeTarget = async (current: URL): Promise<readonly string[]> => {
      assert();
      if (current.username || current.password || !["https:", "http:"].includes(current.protocol)) throw new HostedAgentExecutorError("INVALID_REQUEST");
      const hostname = current.hostname.replace(/^\[|\]$/gu, "");
      const addresses = isIP(hostname) ? [hostname] : await awaitAbort(
        options.lookup?.(hostname) ?? lookup(hostname, { all: true }).then(rows => rows.map(row => row.address)), signal);
      assert();
      if (!addresses.length || addresses.length > 64 || addresses.some(address => isIP(address) === 0)) throw new HostedAgentWebFetchBlockedError();
      const https = new URL(current); https.protocol = "https:";
      const publicTarget = await isBrowserProxyRequestUrlAllowed(https.href,
        { mode: "proxied", server: "https://source-policy.invalid", allowedHostnames: [hostname.toLowerCase().replace(/\.+$/u, "")] },
        (async () => addresses.map(address => ({ address, family: isIP(address) }))) as unknown as BrowserProxyLookup);
      assert();
      const rule = policy.snapshot ? evaluateOrderedPolicyRules(policy.snapshot, { subjectKind: "network", risk: publicTarget ? "read_only" : "high", toolName: "WebFetch" }) : undefined;
      if (rule?.action === "deny") throw new HostedAgentExecutorError("ACCESS_DENIED");
      const elevated = policy.permissionMode === "bypassPermissions";
      if (!approved.has(current.href) && (rule?.action === "ask" || delegated?.verdict === "ask" || !publicTarget && !elevated)) {
        const decision = await options.context.requestInteraction({ id: `hosted-fetch:${options.context.generation}:${globalThis.crypto.randomUUID()}`,
          kind: "permission", title: "Allow task network access", toolName: "WebFetch",
          summary: `Fetch ${current.origin}${current.pathname} using this task computer's network?`, risk: publicTarget ? "medium" : "high",
          choices: ["allow_once", "deny_once"] }, { signal });
        assert();
        if (!(decision.kind === "confirmed" && decision.confirmed || decision.kind === "selected" && decision.value === "allow_once")) throw new HostedAgentWebFetchBlockedError();
        approved.add(current.href);
      }
      return addresses;
    };
    // An approved local HTTP endpoint must retain HTTP. Public HTTP URLs are
    // still upgraded by the native-style fetcher, as in the fixed behavior.
    if (url.protocol === "http:") await authorizeTarget(url);
    const guarded: GuardedFetch = async (target, init, beforeDispatch, approval) => {
      assert(); const current = new URL(target); current.hash = "";
      if (approval?.targetUrl !== current.href) throw new HostedAgentExecutorError("INVALID_REQUEST");
      const addresses = await authorizeTarget(current);
      const environmentProxy = options.environmentProxyForTarget?.(current);
      const proxy = environmentProxy === undefined ? await awaitAbort(Promise.resolve(options.resolveProxy?.(current.href, { signal })), signal) : environmentProxy;
      assert(); await beforeDispatch(); assert();
      return (options.request ?? pinnedSourceRequest)({ url: current, addresses, proxy, init: { ...init, signal }, assertCurrent: assert });
    };
    const response = await fetchWebPage(guarded, { url, startIndex: Number(input.start_index ?? 0),
      allowPrivateNetwork: policy.permissionMode === "bypassPermissions" || approved.has(url.href), signal });
    assert(); return response;
  };
}

/** The proxy receives a vetted IP, never an untrusted DNS name. Host and TLS
 * SNI still identify the original website. The response owns its dispatcher. */
export async function pinnedSourceRequest(input: { readonly url: URL; readonly addresses: readonly string[];
  readonly proxy: string | null | undefined; readonly init: RequestInit; readonly assertCurrent: () => void }): Promise<{ response: Response; release(): Promise<void> }> {
  input.assertCurrent();
  const address = input.addresses[0]; if (!address || !isIP(address)) throw new HostedAgentWebFetchBlockedError();
  const originalHost = input.url.hostname.replace(/^\[|\]$/gu, ""), target = new URL(input.url);
  target.hostname = address.includes(":") ? `[${address}]` : address;
  let dispatcher: Dispatcher;
  const tls = { ...(isIP(originalHost) === 0 ? { servername: originalHost } : {}), timeout: 15_000 };
  if (!input.proxy) dispatcher = new Agent({ connect: buildConnector(tls) });
  else {
    let proxy: URL; try { proxy = new URL(input.proxy); } catch { throw new Error("The Source outbound proxy is invalid."); }
    if (["http:", "https:"].includes(proxy.protocol)) dispatcher = new ProxyAgent({ uri: proxy.href, requestTls: tls });
    else if (["socks5:", "socks5h:"].includes(proxy.protocol)) {
      const connectTls = buildConnector(tls);
      dispatcher = new Agent({ connect: (options, callback) => {
        input.assertCurrent();
        void connectSocks5Tunnel(proxy.href, address, Number(input.url.port || (input.url.protocol === "https:" ? 443 : 80))).then(socket => {
          try { input.assertCurrent(); } catch (error) { socket.destroy(); callback(error as Error, null); return; }
          if (input.url.protocol === "http:") callback(null, socket);
          else connectTls({ ...options, servername: isIP(originalHost) ? undefined : originalHost, httpSocket: socket }, callback);
        }, () => callback(new Error("The Source proxy connection failed."), null));
      } });
    } else throw new Error("The Source outbound proxy protocol is unsupported.");
  }
  const pinned = dispatcher;
  dispatcher = new class extends Dispatcher {
    override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
      input.assertCurrent();
      const headers: Record<string, string | string[] | undefined> = {};
      if (Array.isArray(options.headers)) {
        for (let index = 0; index < options.headers.length; index += 2) {
          const key = String(options.headers[index]); if (key.toLowerCase() !== "host") headers[key] = String(options.headers[index + 1]);
        }
      } else {
        for (const [key, value] of Object.entries(options.headers ?? {})) if (key.toLowerCase() !== "host") headers[key] = value;
      }
      headers.host = input.url.host;
      return pinned.dispatch({ ...options, origin: target.origin, headers }, handler);
    }
    override close(): Promise<void> { return pinned.close(); }
    override destroy(): Promise<void> { return pinned.destroy(); }
  }();
  try {
    input.assertCurrent();
    const headers = new Headers(input.init.headers); headers.set("host", input.url.host);
    headers.delete("authorization"); headers.delete("cookie"); headers.delete("proxy-authorization");
    const response = await undiciFetch(input.url, { ...(input.init as Parameters<typeof undiciFetch>[1]), headers, dispatcher,
      method: "GET", redirect: "manual", credentials: "omit" });
    input.assertCurrent();
    return { response: response as unknown as Response, release: async () => { await dispatcher.close(); } };
  } catch (error) { await dispatcher.destroy().catch(() => undefined); throw error; }
}

async function awaitAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new HostedAgentExecutorError("STALE_AUTHORITY")); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([pending, interrupted]); } finally { signal.removeEventListener("abort", abort); }
}

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, DecoratorHandler, Dispatcher, ProxyAgent, buildConnector, fetch as undiciFetch } from "undici";
import { connectSocks5Tunnel } from "@joko/outbound-network";
import { isBrowserProxyRequestUrlAllowed, type BrowserProxyLookup } from "@joko/tool-browser";
import { evaluateOrderedPolicyRules, type AdapterContext } from "@joko/core";
import { fetchWebPage, type GuardedFetch } from "./hosted-agent-claude-web-fetch.js";
import { HostedAgentExecutorError, type HostedAgentExecutorPolicy } from "./hosted-agent-executor.js";

export class HostedAgentWebFetchBlockedError extends Error {
  constructor() { super("The destination requires Source network approval."); }
}
type Result = Awaited<ReturnType<typeof fetchWebPage>>;
interface PinnedSourceRequestInput {
  readonly url: URL;
  readonly addresses: readonly string[];
  readonly proxy: string | null | undefined;
  readonly init: RequestInit;
  readonly assertCurrent: () => void;
}

export interface HostedAgentClaudeWebFetchOptions {
  readonly context: AdapterContext;
  readonly readPolicy: () => HostedAgentExecutorPolicy;
  readonly assertCurrent: () => void;
  readonly resolveProxy?: (target: string, options: { readonly signal?: AbortSignal }) => Promise<string | null | undefined> | string | null | undefined;
  readonly environmentProxyForTarget?: (target: URL) => string | null | undefined;
  readonly lookup?: (hostname: string) => Promise<readonly string[]>;
  /** Private test/transport seam: the vetted address is explicit and must be pinned. */
  readonly request?: (input: PinnedSourceRequestInput) => Promise<{ response: Response; release(): Promise<void> }>;
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
export async function pinnedSourceRequest(input: PinnedSourceRequestInput): Promise<{ response: Response; release(): Promise<void> }> {
  const assertCurrent = () => {
    input.init.signal?.throwIfAborted();
    input.assertCurrent();
  };
  assertCurrent();
  const addresses = input.proxy ? input.addresses : input.addresses.slice(0, 1);
  const headers = new Headers(input.init.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  let connectionError: unknown;

  for (const address of addresses) {
    assertCurrent();
    if (!isIP(address)) throw new HostedAgentWebFetchBlockedError();
    const host = address.includes(":") ? `[${address}]` : address;
    const port = input.url.port ? `:${input.url.port}` : "";
    const origin = new URL(`${input.url.protocol}//${host}${port}`).origin;
    const pinned = createPinnedTransport(input.url, input.proxy, address, assertCurrent);
    let requestStarted = false;
    let failedBeforeRequest = false;
    const dispatcher = new class extends Dispatcher {
      override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
        assertCurrent();
        const forwarded: Record<string, string | string[] | undefined> = {};
        const original = options.headers;
        if (Array.isArray(original)) {
          for (let index = 0; index < original.length; index += 2) {
            const key = String(original[index]);
            if (key.toLowerCase() !== "host") forwarded[key] = String(original[index + 1]);
          }
        } else {
          for (const [key, value] of Object.entries(original ?? {})) {
            if (key.toLowerCase() !== "host") forwarded[key] = value;
          }
        }
        forwarded.host = input.url.host;
        const attempt = new class extends DecoratorHandler {
          // Undici calls onConnect on the origin request just before writing it.
          onConnect(abort: (error?: Error) => void): void {
            requestStarted = true;
            assertCurrent();
            handler.onConnect?.(abort);
          }
          onError(error: Error): void {
            failedBeforeRequest = !requestStarted;
            handler.onError?.(error);
          }
        }(handler);
        return pinned.dispatch({ ...options, origin, headers: forwarded }, attempt);
      }
      override close(): Promise<void> { return pinned.close(); }
      override destroy(): Promise<void> { return pinned.destroy(); }
    }();

    try {
      const response = await undiciFetch(input.url, { ...(input.init as Parameters<typeof undiciFetch>[1]), headers, dispatcher,
        method: "GET", redirect: "manual", credentials: "omit" });
      assertCurrent();
      return { response: response as unknown as Response, release: async () => { await dispatcher.close(); } };
    } catch (error) {
      const canRetry = failedBeforeRequest && !requestStarted;
      await dispatcher.destroy().catch(() => undefined);
      if (!canRetry) throw error;
      connectionError = error;
    }
  }
  throw connectionError ?? new HostedAgentWebFetchBlockedError();
}

function createPinnedTransport(url: URL, proxyUrl: string | null | undefined, address: string, assertCurrent: () => void): Dispatcher {
  const originalHost = url.hostname.replace(/^\[|\]$/gu, "");
  const tls = { ...(isIP(originalHost) === 0 ? { servername: originalHost } : {}), timeout: 15_000 };
  if (!proxyUrl) return new Agent({ connect: buildConnector(tls) });
  let proxy: URL;
  try { proxy = new URL(proxyUrl); } catch { throw new Error("The Source outbound proxy is invalid."); }
  if (["http:", "https:"].includes(proxy.protocol)) return new ProxyAgent({ uri: proxy.href, requestTls: tls });
  if (!["socks5:", "socks5h:"].includes(proxy.protocol)) throw new Error("The Source outbound proxy protocol is unsupported.");

  const connectTls = buildConnector(tls);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return new Agent({ connect: (options, callback) => {
    assertCurrent();
    void connectSocks5Tunnel(proxy.href, address, port).then(socket => {
      try { assertCurrent(); } catch (error) { socket.destroy(); callback(error as Error, null); return; }
      if (url.protocol === "http:") callback(null, socket);
      else connectTls({ ...options, servername: tls.servername, httpSocket: socket }, callback);
    }, () => callback(new Error("The Source proxy connection failed."), null));
  } });
}

async function awaitAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new HostedAgentExecutorError("STALE_AUTHORITY")); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([pending, interrupted]); } finally { signal.removeEventListener("abort", abort); }
}

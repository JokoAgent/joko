import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { create } from "@bufbuild/protobuf";
import { RemoteDesktopIceServerSchema, type RemoteDesktopIceServer } from "@joko/contracts";
import { parseRemoteDesktopIceConfig, REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS } from "@joko/device-peer";
import { inspectKeyDirectoryPermissions, inspectPrivateKeyPermissions } from "@joko/remote-ssh";
import type { OrchestratorConfig } from "./config.js";
import { toProtoTimestamp } from "./proto-mapper.js";
import type { RemoteDesktopIceConfigurationProvider } from "./remote-desktop-coordinator.js";

export const REMOTE_DESKTOP_ICE_RESPONSE_BYTES = 16_384;

/** Private deployment endpoint, fetched per authorized media attempt without a credential cache. */
export class ConfiguredRemoteDesktopIceConfiguration implements RemoteDesktopIceConfigurationProvider {
  constructor(private readonly options: {
    readonly configuration?: OrchestratorConfig["remoteDesktopIce"];
    readonly fetch: typeof fetch;
    readonly now?: () => number;
    readonly readToken?: (path: string, signal: AbortSignal) => Promise<string>;
  }) {}

  async getConfiguration(input: Parameters<RemoteDesktopIceConfigurationProvider["getConfiguration"]>[0]
  ): Promise<readonly RemoteDesktopIceServer[]> {
    input.signal.throwIfAborted();
    const now = this.options.now ?? Date.now;
    const configuration = this.options.configuration;
    if (configuration === undefined) return publicRemoteDesktopIceConfiguration(now());
    const timeout = new AbortController();
    const signal = AbortSignal.any([input.signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(), REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS);
    let onAbort: (() => void) | undefined;
    try {
      const request = async (): Promise<readonly RemoteDesktopIceServer[]> => {
        const token = await (this.options.readToken ?? readIceToken)(configuration.tokenPath, signal);
        signal.throwIfAborted();
        const response = await this.options.fetch(configuration.url, {
          method: "GET", cache: "no-store", redirect: "error", signal,
          headers: { authorization: `Bearer ${token}`, accept: "application/json", "cache-control": "no-store" }
        });
        signal.throwIfAborted();
        if (!response.ok) { await response.body?.cancel(); throw new Error("ICE_CONFIG_UNAVAILABLE"); }
        const raw = await readConfigurationBody(response, signal);
        signal.throwIfAborted();
        const servers = parseRemoteDesktopIceConfig(raw, now());
        if (servers.length === 0) return publicRemoteDesktopIceConfiguration(now());
        const expiresAt = Date.parse((raw as { expiresAt: string }).expiresAt);
        return Object.freeze(servers.map(server => create(RemoteDesktopIceServerSchema, {
          urls: [...server.urls], username: server.username, credential: server.credential,
          expiresAt: toProtoTimestamp(expiresAt)
        })));
      };
      // Bound credential/proxy/native reads as well as the HTTP request. Late work
      // checks the same signal before it can send a token or return any material.
      return await Promise.race([request(), new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("ICE_CONFIG_UNAVAILABLE"));
        if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
      })]);
    } catch {
      input.signal.throwIfAborted();
      return publicRemoteDesktopIceConfiguration(now());
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      timeout.abort();
    }
  }
}

export function publicRemoteDesktopIceConfiguration(now: number): readonly RemoteDesktopIceServer[] {
  return Object.freeze([create(RemoteDesktopIceServerSchema, {
    urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"],
    expiresAt: toProtoTimestamp(now + 5 * 60_000)
  })]);
}

async function readConfigurationBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > REMOTE_DESKTOP_ICE_RESPONSE_BYTES) {
    await response.body?.cancel(); throw new Error("ICE_CONFIG_UNAVAILABLE");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("ICE_CONFIG_UNAVAILABLE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > REMOTE_DESKTOP_ICE_RESPONSE_BYTES) throw new Error("ICE_CONFIG_UNAVAILABLE");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readIceToken(path: string, signal: AbortSignal): Promise<string> {
  const directory = dirname(path);
  await inspectKeyDirectoryPermissions(directory, signal);
  signal.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let permission: Awaited<ReturnType<typeof inspectPrivateKeyPermissions>> | undefined;
  let bytes: Buffer | undefined;
  try {
    permission = await inspectPrivateKeyPermissions(directory, basename(path), handle, signal);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > 4_098) throw new Error("ICE_CONFIG_UNAVAILABLE");
    bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const part = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (part.bytesRead === 0) break;
      offset += part.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) throw new Error("ICE_CONFIG_UNAVAILABLE");
    await permission.verifyFinal();
    signal.throwIfAborted();
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    const token = /^([A-Za-z0-9._~+\/-]{1,4096}={0,2})(?:\r?\n)?$/u.exec(value)?.[1];
    if (token === undefined || token.length > 4096) throw new Error("ICE_CONFIG_UNAVAILABLE");
    return token;
  } finally {
    bytes?.fill(0);
    await permission?.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
}

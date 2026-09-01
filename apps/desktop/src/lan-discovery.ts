import { randomBytes } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

import {
  LAN_DISCOVERY_GROUP,
  LAN_DISCOVERY_MAX_DATAGRAM_BYTES,
  LAN_DISCOVERY_NONCE_BYTES,
  LAN_DISCOVERY_PORT,
  decodeLanDiscoveryDatagram,
  encodeLanDiscoveryQuery
} from "@joko/contracts";

import type { DesktopDiscoveredNode } from "./channels.js";
import { isAllowedRendererNetworkUrl } from "./security.js";

export const DESKTOP_DISCOVERY_TIMEOUT_MS = 1_200;
export const DESKTOP_DISCOVERY_MAX_RESULTS = 64;
export const DESKTOP_DISCOVERY_MAX_RECEIVED_DATAGRAMS = 256;

interface LanDiscoverySocket {
  bind(port: number, address: string, callback: () => void): void;
  setMulticastTTL(ttl: number): void;
  setMulticastLoopback(flag: boolean): void;
  send(message: Uint8Array, port: number, address: string, callback: (error: Error | null) => void): void;
  close(callback?: () => void): void;
  on(event: "message", listener: (message: Buffer, remote: RemoteInfo) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
}

export interface ScanLanOrchestratorNodesOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxResults?: number;
  readonly now?: () => number;
  readonly randomNonce?: () => Uint8Array;
  readonly socketFactory?: () => LanDiscoverySocket;
}

/**
 * Sends one nonce-bound multicast query and accepts only matching unicast
 * announcements. Discovery is credential-free and never establishes trust;
 * the Web client still verifies GetServerInfo before reading an Auth Key.
 */
export function scanLanOrchestratorNodes(
  options: ScanLanOrchestratorNodesOptions = {}
): Promise<readonly DesktopDiscoveredNode[]> {
  const timeoutMs = boundedInteger(options.timeoutMs ?? DESKTOP_DISCOVERY_TIMEOUT_MS, 50, 5_000, "timeout");
  const maxResults = boundedInteger(options.maxResults ?? DESKTOP_DISCOVERY_MAX_RESULTS, 1, DESKTOP_DISCOVERY_MAX_RESULTS, "result limit");
  const now = options.now ?? Date.now;
  const nonce = (options.randomNonce ?? (() => randomBytes(LAN_DISCOVERY_NONCE_BYTES)))();
  const query = encodeLanDiscoveryQuery(nonce);
  const socket = (options.socketFactory ?? (() => createSocket({ type: "udp4", reuseAddr: true }) as unknown as LanDiscoverySocket))();
  const results = new Map<string, DesktopDiscoveredNode>();
  const signal = options.signal;

  return new Promise<readonly DesktopDiscoveredNode[]>((resolve, reject) => {
    let settled = false;
    let receivedDatagrams = 0;
    const timer = setTimeout(() => finish(), timeoutMs);
    timer.unref();

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.off("error", onError);
      const settle = (): void => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve([...results.values()].sort((left, right) =>
          left.displayName.localeCompare(right.displayName) || left.serverId.localeCompare(right.serverId)
        ));
      };
      try { socket.close(settle); } catch { settle(); }
    };
    const onAbort = (): void => finish(abortError());
    const onError = (): void => finish(new Error("Desktop LAN discovery socket failed."));
    const onMessage = (message: Buffer, _remote: RemoteInfo): void => {
      if (settled) return;
      receivedDatagrams += 1;
      if (receivedDatagrams > DESKTOP_DISCOVERY_MAX_RECEIVED_DATAGRAMS) {
        finish();
        return;
      }
      if (message.byteLength > LAN_DISCOVERY_MAX_DATAGRAM_BYTES) return;
      const decoded = decodeLanDiscoveryDatagram(message, now());
      if (decoded?.kind !== "announce" || !sameBytes(decoded.nonce, nonce)) return;
      if (!isAllowedRendererNetworkUrl(decoded.node.origin)) return;
      if (results.has(decoded.node.serverId)) return;
      results.set(decoded.node.serverId, Object.freeze({
        serverId: decoded.node.serverId,
        displayName: decoded.node.displayName,
        origin: decoded.node.origin,
        version: decoded.node.version,
        apiVersion: decoded.node.apiVersion,
        pairingEnabled: decoded.node.pairingEnabled,
        lastSeenAt: decoded.node.lastSeen
      }));
      if (results.size >= maxResults) finish();
    };

    socket.on("message", onMessage);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    try {
      socket.bind(0, "0.0.0.0", () => {
        if (settled) return;
        try {
          socket.setMulticastTTL(1);
          socket.setMulticastLoopback(true);
          socket.send(query, LAN_DISCOVERY_PORT, LAN_DISCOVERY_GROUP, (error) => {
            if (error !== null) finish(new Error("Desktop LAN discovery query could not be sent."));
          });
        } catch {
          finish(new Error("Desktop LAN discovery query could not be sent."));
        }
      });
    } catch {
      finish(new Error("Desktop LAN discovery socket could not be opened."));
    }
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Desktop LAN discovery ${label} is invalid.`);
  }
  return value;
}

function abortError(): Error {
  const error = new Error("Desktop LAN discovery scan was cancelled.");
  error.name = "AbortError";
  return error;
}

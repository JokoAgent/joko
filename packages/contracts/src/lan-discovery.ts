import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";

import {
  DiscoveredNodeSchema,
  LanDiscoveryDatagramKind,
  LanDiscoveryDatagramSchema
} from "./gen/joko/v1/runtime_pb.js";

export const LAN_DISCOVERY_GROUP = "239.255.77.77";
export const LAN_DISCOVERY_PORT = 43_180;
export const LAN_DISCOVERY_PROTOCOL_VERSION = 1;
export const LAN_DISCOVERY_MAX_DATAGRAM_BYTES = 2_048;
export const LAN_DISCOVERY_NONCE_BYTES = 16;

export const LAN_DISCOVERY_MAGIC = "JOKO-ORCHESTRATOR-LAN";
const MAGIC_BYTES = new TextEncoder().encode(LAN_DISCOVERY_MAGIC);

export interface DiscoveredNodeRecord {
  readonly serverId: string;
  readonly displayName: string;
  readonly origin: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly pairingEnabled: boolean;
  readonly lastSeen: number;
}

export type DecodedLanDiscoveryDatagram =
  | { readonly kind: "query"; readonly nonce: Uint8Array }
  | { readonly kind: "announce"; readonly nonce: Uint8Array; readonly node: DiscoveredNodeRecord };

export function encodeLanDiscoveryQuery(nonce: Uint8Array): Uint8Array {
  validateNonce(nonce);
  return toBinary(LanDiscoveryDatagramSchema, create(LanDiscoveryDatagramSchema, {
    magic: MAGIC_BYTES,
    protocolVersion: LAN_DISCOVERY_PROTOCOL_VERSION,
    nonce,
    kind: LanDiscoveryDatagramKind.QUERY
  }));
}

export function encodeLanDiscoveryAnnouncement(nonce: Uint8Array, node: DiscoveredNodeRecord): Uint8Array {
  validateNonce(nonce);
  validateDiscoveredNode(node);
  const encoded = toBinary(LanDiscoveryDatagramSchema, create(LanDiscoveryDatagramSchema, {
    magic: MAGIC_BYTES,
    protocolVersion: LAN_DISCOVERY_PROTOCOL_VERSION,
    nonce,
    kind: LanDiscoveryDatagramKind.ANNOUNCE,
    node: create(DiscoveredNodeSchema, {
      serverId: node.serverId,
      displayName: node.displayName,
      origin: node.origin,
      version: node.version,
      apiVersion: node.apiVersion,
      pairingEnabled: node.pairingEnabled,
      lastSeen: timestamp(node.lastSeen)
    })
  }));
  if (encoded.byteLength > LAN_DISCOVERY_MAX_DATAGRAM_BYTES) throw new RangeError("LAN discovery datagram exceeds its byte limit.");
  return encoded;
}

export function decodeLanDiscoveryDatagram(bytes: Uint8Array, receivedAt = Date.now()): DecodedLanDiscoveryDatagram | undefined {
  if (bytes.byteLength < 1 || bytes.byteLength > LAN_DISCOVERY_MAX_DATAGRAM_BYTES) return undefined;
  try {
    const value = fromBinary(LanDiscoveryDatagramSchema, bytes);
    if (!sameBytes(value.magic, MAGIC_BYTES) || value.protocolVersion !== LAN_DISCOVERY_PROTOCOL_VERSION) return undefined;
    validateNonce(value.nonce);
    if (value.kind === LanDiscoveryDatagramKind.QUERY) {
      if (value.node !== undefined) return undefined;
      return { kind: "query", nonce: value.nonce };
    }
    if (value.kind !== LanDiscoveryDatagramKind.ANNOUNCE || value.node === undefined) return undefined;
    const node: DiscoveredNodeRecord = {
      serverId: value.node.serverId,
      displayName: value.node.displayName,
      origin: value.node.origin,
      version: value.node.version,
      apiVersion: value.node.apiVersion,
      pairingEnabled: value.node.pairingEnabled,
      // Cache freshness is based exclusively on the receiver's clock.
      lastSeen: receivedAt
    };
    validateDiscoveredNode(node);
    if (value.node.lastSeen === undefined || !validTimestamp(value.node.lastSeen.seconds, value.node.lastSeen.nanos)) return undefined;
    return { kind: "announce", nonce: value.nonce, node };
  } catch {
    return undefined;
  }
}

export function validateDiscoveredNode(node: DiscoveredNodeRecord): void {
  boundedUtf8(node.serverId, 128, "server ID", /^[a-z0-9][a-z0-9._:-]*$/iu);
  boundedUtf8(node.displayName, 128, "display name");
  boundedUtf8(node.version, 64, "version");
  boundedUtf8(node.apiVersion, 64, "API version", /^[a-z0-9][a-z0-9._-]*$/iu);
  boundedUtf8(node.origin, 512, "origin");
  const origin = new URL(node.origin);
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username !== "" || origin.password !== "" || origin.pathname !== "/" ||
    origin.search !== "" || origin.hash !== "" || origin.origin !== node.origin ||
    !isPrivateLanDiscoveryHost(origin.hostname)
  ) throw new RangeError("LAN discovery origin is not a bare local-network HTTP(S) origin.");
  if (!Number.isFinite(node.lastSeen) || node.lastSeen < 0) throw new RangeError("LAN discovery last-seen time is invalid.");
}

/** Shared syntactic LAN-origin boundary for Orchestrator and Desktop discovery. */
export function isPrivateLanDiscoveryHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (normalized === "fd00:ec2::254" || normalized === "metadata" || normalized.startsWith("metadata.") || normalized === "instance-data" || normalized.startsWith("instance-data.")) return false;
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = ipv4Octets(normalized);
  if (octets !== undefined) {
    if (octets[3] === 255) return false;
    return octets[0] === 127 || octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168);
  }
  const firstHextet = normalized.split(":", 1)[0];
  if (firstHextet !== undefined && /^[0-9a-f]{1,4}$/iu.test(firstHextet) && (Number.parseInt(firstHextet, 16) & 0xfe00) === 0xfc00) return true;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/iu.test(normalized)) return false;
  return !normalized.includes(".") || normalized.endsWith(".local") || normalized.endsWith(".home.arpa");
}

function validateNonce(nonce: Uint8Array): void {
  if (nonce.byteLength !== LAN_DISCOVERY_NONCE_BYTES) throw new RangeError("LAN discovery nonce must be exactly 16 bytes.");
}

function boundedUtf8(value: string, maximumBytes: number, label: string, pattern?: RegExp): void {
  if (value.length === 0 || new TextEncoder().encode(value).byteLength > maximumBytes || value.includes("\0") || (pattern !== undefined && !pattern.test(value))) {
    throw new RangeError(`LAN discovery ${label} is invalid.`);
  }
}

function timestamp(value: number) {
  const milliseconds = Math.trunc(value);
  return create(TimestampSchema, {
    seconds: BigInt(Math.floor(milliseconds / 1_000)),
    nanos: (milliseconds % 1_000) * 1_000_000
  });
}

function validTimestamp(seconds: bigint, nanos: number): boolean {
  return seconds >= 0n && seconds <= 253_402_300_799n && Number.isInteger(nanos) && nanos >= 0 && nanos < 1_000_000_000;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function normalizeHostname(host: string): string {
  const normalized = host.trim().toLocaleLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
}

function ipv4Octets(host: string): readonly [number, number, number, number] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const values = parts.map((part) => /^\d{1,3}$/u.test(part) ? Number(part) : Number.NaN);
  if (values.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return values as unknown as readonly [number, number, number, number];
}

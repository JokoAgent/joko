import ipaddr from "ipaddr.js";

const BLOCKED_V4_RANGES = new Set(["unspecified", "broadcast", "multicast", "linkLocal", "loopback", "carrierGradeNat", "private", "reserved"]);
const BLOCKED_V6_RANGES = new Set(["unspecified", "loopback", "linkLocal", "uniqueLocal", "multicast", "reserved", "benchmarking", "discard", "orchid2"]);
const BENCHMARK_V4: [ipaddr.IPv4, number] = [ipaddr.IPv4.parse("198.18.0.0"), 15];

export function normalizeProxyHostname(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.+$/u, "");
  return normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
}

function blockedV4(address: ipaddr.IPv4): boolean {
  // The explicit proxy policy permits the established fake-IP benchmark range.
  if (address.match(BENCHMARK_V4)) return false;
  return BLOCKED_V4_RANGES.has(address.range());
}

function embeddedV4(address: ipaddr.IPv6): ipaddr.IPv4 | undefined {
  if (address.isIPv4MappedAddress()) return address.toIPv4Address();
  const parts = address.parts;
  let pair: readonly [number, number] | undefined;
  if (address.range() === "rfc6145" || address.range() === "rfc6052"
    || parts.slice(0, 6).every(value => value === 0)
    || (parts[0] === 0x64 && parts[1] === 0xff9b && parts[2] === 1 && parts.slice(3, 6).every(value => value === 0))
    || ((parts[4]! & 0xfcff) === 0 && parts[5] === 0x5efe)) pair = [parts[6]!, parts[7]!];
  else if (parts[0] === 0x2002) pair = [parts[1]!, parts[2]!];
  else if (parts[0] === 0x2001 && parts[1] === 0) pair = [parts[6]! ^ 0xffff, parts[7]! ^ 0xffff];
  if (pair === undefined) return undefined;
  return ipaddr.IPv4.parse([pair[0] >>> 8, pair[0] & 0xff, pair[1] >>> 8, pair[1] & 0xff].join("."));
}

/** Same private/special-use policy for DNS answers and URL IP literals. */
export function isBlockedProxyAddress(raw: string): boolean {
  const value = normalizeProxyHostname(raw);
  if (!ipaddr.isValid(value)) return true;
  const address = ipaddr.parse(value);
  if (address.kind() === "ipv4") return !ipaddr.IPv4.isValidFourPartDecimal(value) || blockedV4(address as ipaddr.IPv4);
  const v6 = address as ipaddr.IPv6;
  if (BLOCKED_V6_RANGES.has(v6.range()) || (v6.parts[0]! & 0xffc0) === 0xfec0) return true;
  const embedded = embeddedV4(v6);
  return embedded !== undefined && blockedV4(embedded);
}

export function isBlockedProxyHostname(raw: string): boolean {
  const hostname = normalizeProxyHostname(raw);
  if (hostname === "localhost" || hostname === "localhost.localdomain" || hostname === "metadata.google.internal"
    || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  if (ipaddr.isValid(hostname)) return isBlockedProxyAddress(hostname);
  return hostname.includes(":") || /^\d+(?:\.\d+){0,3}$/u.test(hostname);
}

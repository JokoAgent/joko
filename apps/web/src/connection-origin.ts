const LOOPBACK_NAMES = new Set(["localhost"]);

/**
 * Canonicalizes a Orchestrator base URL and enforces the transport boundary before
 * an Auth Key can be read or attached to a request. Public nodes require
 * HTTPS. Plain HTTP is limited to literal local/private addresses and names
 * that are reserved for local resolution.
 */
export function normalizeOrchestratorOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid Joko node URL.");
  }
  if (url.username !== "" || url.password !== "") throw new Error("Joko node addresses cannot contain credentials.");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Joko node addresses must contain only a scheme, host, and optional port.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Joko node addresses must use HTTP or HTTPS.");
  }
  if (url.protocol === "http:" && !isLocalOrPrivateHostname(url.hostname)) {
    throw new Error("Public Joko nodes require HTTPS. HTTP is limited to localhost and trusted private networks.");
  }
  return url.origin;
}

export function isInsecureLanOrigin(value: string): boolean {
  try {
    const url = new URL(normalizeOrchestratorOrigin(value));
    return url.protocol === "http:" && !isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function isLocalOrPrivateHostname(value: string): boolean {
  const hostname = canonicalHostname(value);
  if (hostname === "" || hostname === "0.0.0.0" || hostname === "::") return false;
  if (isLoopbackHostname(hostname)) return true;
  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== undefined) return isPrivateIpv4(ipv4);
  const ipv6 = parseIpv6(hostname);
  if (ipv6 !== undefined) return isPrivateIpv6(ipv6);
  if (hostname.endsWith(".local") || hostname.endsWith(".home.arpa")) return true;
  return !hostname.includes(".") && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname);
}

export function isLoopbackHostname(value: string): boolean {
  const hostname = canonicalHostname(value);
  if (LOOPBACK_NAMES.has(hostname) || hostname.endsWith(".localhost")) return true;
  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== undefined) return ipv4[0] === 127;
  const ipv6 = parseIpv6(hostname);
  return ipv6 !== undefined && ipv6.slice(0, 7).every((word) => word === 0) && ipv6[7] === 1;
}

function canonicalHostname(value: string): string {
  const lowered = value.trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
}

function parseIpv4(value: string): readonly [number, number, number, number] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part, index) => !Number.isInteger(part) || part < 0 || part > 255 || String(part) !== parts[index])) return undefined;
  return numbers as unknown as readonly [number, number, number, number];
}

function isPrivateIpv4(value: readonly [number, number, number, number]): boolean {
  const [a, b] = value;
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function parseIpv6(value: string): readonly number[] | undefined {
  if (!value.includes(":")) return undefined;
  const double = value.indexOf("::");
  if (double !== -1 && double !== value.lastIndexOf("::")) return undefined;
  const left = (double === -1 ? value : value.slice(0, double)).split(":").filter(Boolean);
  const right = (double === -1 ? "" : value.slice(double + 2)).split(":").filter(Boolean);
  const parseWords = (parts: readonly string[]): number[] | undefined => {
    const words: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/u.test(part)) return undefined;
      words.push(Number.parseInt(part, 16));
    }
    return words;
  };
  const leftWords = parseWords(left);
  const rightWords = parseWords(right);
  if (leftWords === undefined || rightWords === undefined) return undefined;
  if (double === -1) return leftWords.length === 8 ? leftWords : undefined;
  const missing = 8 - leftWords.length - rightWords.length;
  if (missing < 1) return undefined;
  return [...leftWords, ...Array.from({ length: missing }, () => 0), ...rightWords];
}

function isPrivateIpv6(words: readonly number[]): boolean {
  if (words.length !== 8) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  if ((words[0]! & 0xfe00) === 0xfc00) return true;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isPrivateIpv4([words[6]! >>> 8, words[6]! & 0xff, words[7]! >>> 8, words[7]! & 0xff]);
  }
  return false;
}

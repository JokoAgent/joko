import { lookup } from "node:dns/promises";
import { isBlockedProxyAddress, isBlockedProxyHostname, normalizeProxyHostname } from "./proxy-network-policy.js";

export interface BrowserStartOptions {
  readonly proxyServer?: string;
  readonly proxyAllowedHostnames?: readonly string[];
  readonly signal?: AbortSignal;
  /** The host checks its exact invocation authority at each native boundary. */
  readonly assertCurrent?: () => void;
}
export type BrowserProxyRoute =
  | { readonly mode: "direct" }
  | { readonly mode: "proxied"; readonly server: string; readonly allowedHostnames?: readonly string[] };
export type BrowserProxyLookup = typeof lookup;

const SCHEMES = new Set(["http:", "https:", "socks:", "socks4:", "socks5:"]);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
function invalid(message: string): Error { return new Error(`Invalid proxyServer: ${message}`); }
function validateDnsName(hostname: string): void {
  if (hostname.length > 253 || hostname.split(".").some(label => label.length === 0 || label.length > 63 || !DNS_LABEL.test(label))) {
    throw invalid("hostnames must use bounded DNS labels.");
  }
}
function allowedHostname(raw: string): string {
  const value = raw.trim().toLowerCase();
  const wildcard = value.startsWith("*.");
  const hostname = wildcard ? value.slice(2) : value;
  validateDnsName(hostname);
  if (!hostname.includes(".") || isBlockedProxyHostname(hostname) || /^\d+(?:\.\d+){3}$/u.test(hostname)) {
    throw invalid("allowed hostnames must be public DNS names, not IP or local-network targets.");
  }
  const parsed = new URL(`https://${hostname}`);
  if (parsed.hostname !== hostname || parsed.port || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw invalid("allowed hostnames must not include a scheme, port, path, or credentials.");
  }
  return wildcard ? `*.${hostname}` : hostname;
}

/** Validate the complete route before stopping a browser or changing its mode. */
export function parseBrowserProxyServer(raw: unknown, rawAllowedHostnames?: unknown): BrowserProxyRoute {
  if (raw === undefined || raw === null) {
    if (rawAllowedHostnames !== undefined && rawAllowedHostnames !== null) throw invalid("allowed hostnames require proxyServer.");
    return { mode: "direct" };
  }
  if (typeof raw !== "string") throw invalid("expected a URL string.");
  const value = raw.trim();
  if (!value || value.length > 2048 || /[\s\u0000-\u001f\u007f,;"']/u.test(value)) throw invalid("expected a bounded URL without whitespace, lists, or quoting.");
  const separator = value.indexOf("://");
  const suffix = separator >= 0 ? value.slice(separator + 3) : "";
  const authority = suffix.endsWith("/") ? suffix.slice(0, -1) : suffix;
  if (!authority || /[/?#]/u.test(authority)) throw invalid("path, query, and fragment are not supported.");
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.startsWith("[")) {
    const bracket = hostPort.indexOf("]");
    if (bracket < 0 || (hostPort.slice(bracket + 1) !== "" && !/^:\d+$/u.test(hostPort.slice(bracket + 1)))) throw invalid("port is malformed.");
  } else {
    const colon = hostPort.lastIndexOf(":");
    if (colon >= 0 && !/^\d+$/u.test(hostPort.slice(colon + 1))) throw invalid("port is malformed.");
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw invalid("must use a supported proxy URL format."); }
  if (!SCHEMES.has(parsed.protocol)) throw invalid("scheme must be http, https, socks, socks4, or socks5.");
  if (!parsed.hostname || !parsed.host) throw invalid("host is required.");
  if (!parsed.hostname.startsWith("[")) validateDnsName(parsed.hostname);
  if (parsed.port && (!/^\d+$/u.test(parsed.port) || Number(parsed.port) > 65535)) throw invalid("port is malformed.");
  if ((parsed.pathname !== "" && parsed.pathname !== "/") || parsed.search || parsed.hash) throw invalid("path, query, and fragment are not supported.");
  if (parsed.username || parsed.password) throw invalid("authenticated proxies are not supported; omit the username and password.");
  let allowedHostnames: readonly string[] | undefined;
  if (rawAllowedHostnames !== undefined && rawAllowedHostnames !== null) {
    if (!Array.isArray(rawAllowedHostnames) || rawAllowedHostnames.length === 0 || rawAllowedHostnames.length > 32
      || rawAllowedHostnames.some(item => typeof item !== "string")) throw invalid("allowed hostnames must contain 1–32 DNS patterns.");
    allowedHostnames = [...new Set(rawAllowedHostnames.map(item => allowedHostname(item as string)))].sort();
  }
  return { mode: "proxied", server: `${parsed.protocol}//${parsed.host}`, ...(allowedHostnames === undefined ? {} : { allowedHostnames }) };
}

export function browserProxyRouteKey(route: BrowserProxyRoute): string {
  return JSON.stringify([route.mode, route.mode === "proxied" ? route.server : null, route.mode === "proxied" ? route.allowedHostnames ?? null : null]);
}
export function publicBrowserProxyRoute(route: BrowserProxyRoute | undefined): { readonly mode: "direct" | "proxied" | "unknown"; readonly server?: string } {
  return route === undefined ? { mode: "unknown" } : route.mode === "direct" ? { mode: "direct" } : { mode: "proxied", server: route.server };
}
export async function isBrowserProxyRequestUrlAllowed(raw: string, route: BrowserProxyRoute, lookupFn: BrowserProxyLookup = lookup): Promise<boolean> {
  if (route.mode === "direct") return true;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }
  const hostname = normalizeProxyHostname(parsed.hostname);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || isBlockedProxyHostname(hostname)) return false;
  if (!(route.allowedHostnames ?? []).some(pattern => pattern.startsWith("*.")
    ? hostname !== pattern.slice(2) && hostname.endsWith(`.${pattern.slice(2)}`)
    : hostname === pattern)) return false;
  try {
    // No positive cache: a later DNS answer must not bypass private-IP checks.
    const addresses = await lookupFn(hostname, { all: true });
    return addresses.length > 0 && addresses.every(address => !isBlockedProxyAddress(address.address));
  } catch { return false; }
}

/** PAC applies before restored tabs/workers or the CDP request gate can run. */
export function buildBrowserProxyLaunchArgs(route: BrowserProxyRoute): readonly string[] {
  if (route.mode === "direct") return [];
  const parsed = new URL(route.server);
  const directive = parsed.protocol === "https:" ? "HTTPS" : parsed.protocol === "socks5:" || parsed.protocol === "socks:" ? "SOCKS5" : parsed.protocol === "socks4:" ? "SOCKS" : "PROXY";
  const proxyLiteral = JSON.stringify(`${directive} ${parsed.host}`);
  const pac = [
    "function FindProxyForURL(url,host){",
    `var a=${JSON.stringify(route.allowedHostnames ?? [])};`,
    'var u=String(url||"").toLowerCase();',
    'if(u.slice(0,8)!=="https://"&&u.slice(0,6)!=="wss://")return "PROXY 0.0.0.0:0";',
    'host=(host||"").toLowerCase().replace(/\\.+$/,"");',
    'function v4b(ip){',
    'if(isInNet(ip,"198.18.0.0","255.254.0.0"))return false;',
    'return isInNet(ip,"0.0.0.0","255.0.0.0")||isInNet(ip,"10.0.0.0","255.0.0.0")||isInNet(ip,"127.0.0.0","255.0.0.0")||isInNet(ip,"169.254.0.0","255.255.0.0")||isInNet(ip,"172.16.0.0","255.240.0.0")||isInNet(ip,"192.168.0.0","255.255.0.0")||isInNet(ip,"100.64.0.0","255.192.0.0")||isInNet(ip,"192.0.0.0","255.255.255.0")||isInNet(ip,"192.0.2.0","255.255.255.0")||isInNet(ip,"198.51.100.0","255.255.255.0")||isInNet(ip,"203.0.113.0","255.255.255.0")||isInNet(ip,"224.0.0.0","240.0.0.0")||isInNet(ip,"240.0.0.0","240.0.0.0");',
    '}',
    'function blocked(){var h=host;if(h.charAt(0)==="[")h=h.slice(1,h.length-1);',
    'if(h.indexOf(":")>=0){if(h==="::1"||h==="0:0:0:0:0:0:0:1")return true;if(h.slice(0,5)==="fe80:")return true;if(h.indexOf("::ffff:")===0)return v4b(h.slice(7));return false;}',
    'var ip=dnsResolve(host);if(!ip)return true;return v4b(ip);}',
    'for(var i=0;i<a.length;i++){var p=a[i].toLowerCase();',
    'if(p.indexOf("*.")===0){var s=p.slice(2);if(s&&host!==s&&host.length>s.length&&host.slice(-(s.length+1))==="."+s){',
    `if(blocked())return "PROXY 0.0.0.0:0";return ${proxyLiteral};}}`,
    'else if(host===p){',
    `if(blocked())return "PROXY 0.0.0.0:0";return ${proxyLiteral};}}`,
    'return "PROXY 0.0.0.0:0";}',
  ].join("");
  return [`--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString("base64")}`, "--webrtc-ip-handling-policy=disable_non_proxied_udp"];
}

/** Private, bounded Desktop-to-Orchestrator launch snapshot for fixed outbound routes. */
export const MANAGED_OUTBOUND_PROXY_SNAPSHOT_ENV = "JOKO_OUTBOUND_PROXY_SNAPSHOT";
export const MANAGED_OUTBOUND_PROXY_SNAPSHOT_MAXIMUM_BYTES = 16 * 1024;

export type ManagedOutboundProxyMatch = "exact" | "prefix";

export interface ManagedOutboundProxyTarget {
  readonly id: string;
  readonly route: string;
  readonly match: ManagedOutboundProxyMatch;
  readonly probeUrl: string;
}

export const MANAGED_OUTBOUND_PROXY_TARGETS = Object.freeze([
  {
    id: "native-subscription-profile",
    route: "https://api.anthropic.com/api/oauth/profile",
    match: "exact",
    probeUrl: "https://api.anthropic.com/api/oauth/profile"
  },
  {
    id: "native-subscription-token",
    route: "https://platform.claude.com/v1/oauth/token",
    match: "exact",
    probeUrl: "https://platform.claude.com/v1/oauth/token"
  },
  {
    id: "android-platform-tools-darwin",
    route: "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip",
    match: "exact",
    probeUrl: "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip"
  },
  {
    id: "android-platform-tools-linux",
    route: "https://dl.google.com/android/repository/platform-tools-latest-linux.zip",
    match: "exact",
    probeUrl: "https://dl.google.com/android/repository/platform-tools-latest-linux.zip"
  },
  {
    id: "android-platform-tools-windows",
    route: "https://dl.google.com/android/repository/platform-tools-latest-windows.zip",
    match: "exact",
    probeUrl: "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"
  },
  {
    id: "computer-driver-tags",
    route: "https://api.github.com/repos/trycua/cua/git/matching-refs/tags/",
    match: "prefix",
    probeUrl: "https://api.github.com/repos/trycua/cua/git/matching-refs/tags/cua-driver-rs-v"
  },
  {
    id: "computer-driver-releases",
    route: "https://api.github.com/repos/trycua/cua/releases/tags/",
    match: "prefix",
    probeUrl: "https://api.github.com/repos/trycua/cua/releases/tags/cua-driver-rs-v0.0.0"
  },
  {
    id: "computer-driver-install-posix",
    route: "https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh",
    match: "exact",
    probeUrl: "https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh"
  },
  {
    id: "computer-driver-install-windows",
    route: "https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1",
    match: "exact",
    probeUrl: "https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1"
  },
  {
    id: "computer-driver-release-assets",
    route: "https://github.com/trycua/cua/releases/download/",
    match: "prefix",
    probeUrl: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.0.0/cua-driver-placeholder"
  }
] as const satisfies readonly ManagedOutboundProxyTarget[]);

export const MANAGED_OUTBOUND_PROXY_ENVIRONMENT_KEYS = Object.freeze([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy"
] as const);

export type ManagedOutboundProxyVerdict = string | null;

export interface ManagedOutboundProxySnapshot {
  readonly version: 1;
  readonly routes: Readonly<Record<string, ManagedOutboundProxyVerdict>>;
}

export function hasManagedOutboundProxyEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): boolean {
  return MANAGED_OUTBOUND_PROXY_ENVIRONMENT_KEYS.some((name) => {
    const value = environment[name];
    return typeof value === "string" && value.trim() !== "";
  });
}

export function encodeManagedOutboundProxySnapshot(
  routes: Readonly<Record<string, ManagedOutboundProxyVerdict | undefined>>
): string | undefined {
  const allowed = new Set<string>(MANAGED_OUTBOUND_PROXY_TARGETS.map(({ id }) => id));
  const normalized: Record<string, ManagedOutboundProxyVerdict> = {};
  for (const [id, verdict] of Object.entries(routes)) {
    if (!allowed.has(id) || verdict === undefined) continue;
    normalized[id] = verdict === null ? null : normalizedManagedProxyUrl(verdict);
  }
  if (Object.keys(normalized).length === 0) return undefined;
  const serialized = JSON.stringify({ version: 1, routes: normalized });
  if (new TextEncoder().encode(serialized).byteLength > MANAGED_OUTBOUND_PROXY_SNAPSHOT_MAXIMUM_BYTES) {
    throw new TypeError("Managed outbound proxy snapshot exceeds its size limit.");
  }
  return serialized;
}

export function decodeManagedOutboundProxySnapshot(
  serialized: string | undefined
): ManagedOutboundProxySnapshot | undefined {
  if (
    serialized === undefined
    || serialized === ""
    || new TextEncoder().encode(serialized).byteLength > MANAGED_OUTBOUND_PROXY_SNAPSHOT_MAXIMUM_BYTES
    || /[\0\r\n]/u.test(serialized)
  ) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["routes"])) return undefined;
  const allowed = new Set<string>(MANAGED_OUTBOUND_PROXY_TARGETS.map(({ id }) => id));
  const routes: Record<string, ManagedOutboundProxyVerdict> = {};
  for (const [id, verdict] of Object.entries(value["routes"])) {
    if (!allowed.has(id)) return undefined;
    if (verdict === null) {
      routes[id] = null;
      continue;
    }
    if (typeof verdict !== "string") return undefined;
    try {
      routes[id] = normalizedManagedProxyUrl(verdict);
    } catch {
      return undefined;
    }
  }
  return Object.keys(routes).length === 0 ? undefined : { version: 1, routes };
}

export function resolveManagedOutboundProxy(
  snapshot: ManagedOutboundProxySnapshot | undefined,
  upstreamUrl: string
): ManagedOutboundProxyVerdict | undefined {
  if (snapshot === undefined) return undefined;
  let requested: URL;
  try {
    requested = new URL(upstreamUrl);
  } catch {
    return undefined;
  }
  if (
    requested.protocol !== "https:"
    || requested.username !== ""
    || requested.password !== ""
  ) return undefined;
  const normalized = requested.toString();
  const target = [...MANAGED_OUTBOUND_PROXY_TARGETS]
    .sort((left, right) => right.route.length - left.route.length)
    .find((candidate) => candidate.match === "exact"
      ? normalized === candidate.route
      : normalized.startsWith(candidate.route));
  return target === undefined ? undefined : snapshot.routes[target.id];
}

export function createManagedOutboundProxyResolver(
  serialized: string | undefined
): (upstreamUrl: string) => ManagedOutboundProxyVerdict | undefined {
  const snapshot = decodeManagedOutboundProxySnapshot(serialized);
  return (upstreamUrl) => resolveManagedOutboundProxy(snapshot, upstreamUrl);
}

function normalizedManagedProxyUrl(value: string): string {
  if (value === "" || value.length > 2_048 || /[\0\r\n]/u.test(value)) {
    throw new TypeError("Managed outbound proxy URL is invalid.");
  }
  const proxy = new URL(value);
  const port = proxy.port === "" ? (proxy.protocol === "http:" ? 80 : 1080) : Number(proxy.port);
  if (
    (proxy.protocol !== "http:" && proxy.protocol !== "socks5:")
    || proxy.hostname === ""
    || proxy.username !== ""
    || proxy.password !== ""
    || proxy.pathname !== (proxy.protocol === "http:" ? "/" : "")
    || proxy.search !== ""
    || proxy.hash !== ""
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
  ) throw new TypeError("Managed outbound proxy URL is invalid.");
  return proxy.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

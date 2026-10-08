import { REMOTE_DESKTOP_STUN_SERVERS } from "./remote-desktop-ice.js";

export const REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS = 3_000;

export interface RemoteDesktopIceServer {
  readonly urls: readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

const ICE_URL = /^(stun|turn|turns):(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[0-9a-fA-F:]+\]):([0-9]{1,5})(\?transport=(udp|tcp))?$/u;

/**
 * Accepts only bounded, short-lived TURN material. Unknown response fields are
 * ignored at this external configuration boundary; only the returned shape may
 * cross into a capture renderer.
 */
export function parseRemoteDesktopIceConfig(
  value: unknown,
  now = Date.now()
): readonly RemoteDesktopIceServer[] {
  const fail = (): never => {
    throw new Error("INVALID_REMOTE_DESKTOP_ICE_CONFIG");
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  const record = value as { readonly iceServers?: unknown; readonly expiresAt?: unknown };
  if (!Array.isArray(record.iceServers) || record.iceServers.length > 4) return fail();
  if (record.iceServers.length === 0 && record.expiresAt === null) return Object.freeze([]);
  const expiresAt = typeof record.expiresAt === "string" ? Date.parse(record.expiresAt) : Number.NaN;
  // Leave time for cold capture, SDP exchange and connection establishment,
  // while refusing credentials that could become a durable secret.
  if (!Number.isFinite(expiresAt) || expiresAt <= now + 120_000 || expiresAt > now + 86_400_000) {
    return fail();
  }
  return Object.freeze(record.iceServers.map((server) => {
    if (typeof server !== "object" || server === null || Array.isArray(server)) return fail();
    const candidate = server as {
      readonly urls?: unknown;
      readonly username?: unknown;
      readonly credential?: unknown;
    };
    if (!Array.isArray(candidate.urls) || candidate.urls.length < 1 || candidate.urls.length > 4) {
      return fail();
    }
    const urls = Object.freeze(candidate.urls.map((url) => parseIceUrl(url, fail)));
    if (!urls.some((url) => /^turns?:/u.test(url))
      || typeof candidate.username !== "string"
      || candidate.username.length < 1
      || candidate.username.length > 256
      || typeof candidate.credential !== "string"
      || candidate.credential.length < 1
      || candidate.credential.length > 256) {
      return fail();
    }
    return Object.freeze({
      urls,
      username: candidate.username,
      credential: candidate.credential
    });
  }));
}

/**
 * Resolves a fresh configuration for one media attempt. It intentionally has
 * no cache and never exposes upstream bodies or credential-bearing failures.
 */
export async function resolveRemoteDesktopIceServers(
  fetchConfig: () => Promise<unknown>,
  options: {
    readonly timeoutMs?: number;
    readonly now?: number;
    readonly fallback?: readonly RemoteDesktopIceServer[];
  } = {}
): Promise<readonly RemoteDesktopIceServer[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutMs = options.timeoutMs ?? REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS;
    const value = await Promise.race([
      Promise.resolve().then(fetchConfig),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT")), timeoutMs);
      })
    ]);
    const servers = parseRemoteDesktopIceConfig(value, options.now ?? Date.now());
    if (servers.length > 0) return servers;
  } catch {
    // Deliberately fail to public STUN without logging response bodies, errors,
    // usernames or credentials. JPEG compatibility transport is independent.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (options.fallback !== undefined) {
    return Object.freeze(options.fallback.map((server) => Object.freeze({
      urls: Object.freeze([...server.urls]),
      ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined ? {} : { credential: server.credential })
    })));
  }
  return Object.freeze(REMOTE_DESKTOP_STUN_SERVERS.map((server) => Object.freeze({
    urls: Object.freeze([server.urls])
  })));
}

function parseIceUrl(value: unknown, fail: () => never): string {
  if (typeof value !== "string" || value.length > 512) return fail();
  const match = ICE_URL.exec(value);
  if (match === null
    || Number(match[2]) < 1
    || Number(match[2]) > 65_535
    || (match[1] === "stun" && match[3] !== undefined)
    || (match[1] === "turns" && match[4] !== "tcp")) {
    return fail();
  }
  try {
    const host = new URL(`http://${value.slice(value.indexOf(":") + 1).split("?")[0]}`).hostname;
    if (!host.startsWith("[") && host.split(".").some((label) =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label))) {
      return fail();
    }
  } catch {
    return fail();
  }
  return value;
}

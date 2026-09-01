import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isPrivateLanDiscoveryHost } from "@joko/contracts";
import { discoverBrowserExecutable } from "./browser-executable.js";
import { discoverCodexExecutable } from "./codex-executable.js";

export interface OrchestratorConfig {
  readonly host: string;
  readonly port: number;
  readonly internalPort: number;
  readonly publicOrigin: string;
  /** Private service-to-service endpoint. Never derived from the advertised public origin. */
  readonly internalOrigin: string;
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly tls?: { readonly certificatePath: string; readonly privateKeyPath: string };
  readonly allowInsecureLoopback: boolean;
  readonly allowInsecureLan: boolean;
  readonly lanDiscoveryEnabled: boolean;
  readonly piExecutable?: string;
  readonly codexExecutable?: string;
  readonly claudeCodeExecutable?: string;
  readonly piAgentHome: string;
  readonly piSettingsFile?: string;
  readonly workspace: {
    readonly id: string;
    readonly root: string;
    readonly displayName: string;
    readonly trusted: boolean;
  };
  readonly artifactDirectory: string;
  readonly webDirectory: string;
  readonly browser?: {
    readonly executablePath: string;
    readonly headless: boolean;
  };
  readonly corsOrigins: readonly string[];
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const workspaceRoot = resolve(environment.JOKO_WORKSPACE_ROOT ?? process.cwd());
  const dataDirectory = secureDataDirectory(environment, workspaceRoot);
  const host = environment.JOKO_HOST ?? "127.0.0.1";
  const port = readPort(environment.JOKO_PORT ?? "4318");
  const internalPort = readPort(environment.JOKO_INTERNAL_PORT ?? String(port === 1 ? 2 : port - 1), "JOKO_INTERNAL_PORT");
  if (internalPort === port) throw new Error("JOKO_INTERNAL_PORT must differ from JOKO_PORT.");
  const allowInsecureLoopback = environment.JOKO_ALLOW_INSECURE_LOOPBACK === "1";
  const allowInsecureLan = environment.JOKO_ALLOW_INSECURE_LAN === "1";
  const certificatePath = environment.JOKO_TLS_CERT;
  const privateKeyPath = environment.JOKO_TLS_KEY;
  const tls = certificatePath !== undefined && privateKeyPath !== undefined
    ? { certificatePath: resolve(certificatePath), privateKeyPath: resolve(privateKeyPath) }
    : undefined;

  if ((certificatePath === undefined) !== (privateKeyPath === undefined)) {
    throw new Error("JOKO_TLS_CERT and JOKO_TLS_KEY must be configured together.");
  }
  if (tls !== undefined && (!existsSync(tls.certificatePath) || !existsSync(tls.privateKeyPath))) {
    throw new Error("Configured TLS certificate or private key does not exist.");
  }

  const scheme = tls === undefined ? "http" : "https";
  if (tls === undefined) {
    const permitted = isLoopbackHost(host)
      ? allowInsecureLoopback
      : isLanBindHost(host) && allowInsecureLan;
    if (!permitted) {
      throw new Error("TLS is required unless insecure loopback or private-LAN mode is explicitly enabled.");
    }
  }
  const configuredPublicOrigin = environment.JOKO_PUBLIC_ORIGIN;
  if (isWildcardHost(host) && configuredPublicOrigin === undefined) {
    throw new Error("JOKO_PUBLIC_ORIGIN is required when JOKO_HOST is a wildcard address.");
  }
  const publicOrigin = validateServiceOrigin(
    configuredPublicOrigin ?? new URL(`${scheme}://${formatOriginHost(host)}:${port}`).origin,
    { tls: tls !== undefined, allowInsecureLan, label: "JOKO_PUBLIC_ORIGIN" }
  );
  // The authenticated Pi bridge has its own loopback-only HTTP listener. It
  // deliberately does not inherit public TLS/DNS or the advertised origin.
  const internalOrigin = `http://127.0.0.1:${internalPort}`;
  const corsOrigins = splitList(environment.JOKO_CORS_ORIGINS ?? "http://127.0.0.1:4319,http://localhost:4319")
    .map((origin) => validateCorsOrigin(origin, allowInsecureLan));
  const browserExecutable = discoverBrowserExecutable(environment);
  const codexExecutable = discoverCodexExecutable(environment);
  return {
    host,
    port,
    internalPort,
    publicOrigin,
    internalOrigin,
    dataDirectory,
    databasePath: resolve(environment.JOKO_DATABASE_PATH ?? resolve(dataDirectory, "orchestrator.db")),
    ...(tls === undefined ? {} : { tls }),
    allowInsecureLoopback,
    allowInsecureLan,
    lanDiscoveryEnabled: environment.JOKO_LAN_DISCOVERY !== "0",
    ...(environment.JOKO_PI_EXECUTABLE === undefined ? {} : { piExecutable: environment.JOKO_PI_EXECUTABLE }),
    ...(codexExecutable === undefined ? {} : { codexExecutable }),
    ...(environment.JOKO_CLAUDE_CODE_EXECUTABLE === undefined
      ? {}
      : { claudeCodeExecutable: environment.JOKO_CLAUDE_CODE_EXECUTABLE }),
    piAgentHome: resolve(environment.JOKO_PI_AGENT_HOME ?? resolve(dataDirectory, "pi-agent-home")),
    ...(environment.JOKO_PI_SETTINGS_FILE === undefined
      ? {}
      : { piSettingsFile: resolve(environment.JOKO_PI_SETTINGS_FILE) }),
    workspace: {
      id: environment.JOKO_WORKSPACE_ID ?? "workspace-local",
      root: workspaceRoot,
      displayName: environment.JOKO_WORKSPACE_NAME ?? "Local workspace",
      trusted: environment.JOKO_WORKSPACE_TRUSTED === "1"
    },
    artifactDirectory: resolve(environment.JOKO_ARTIFACT_DIR ?? resolve(dataDirectory, "artifacts")),
    webDirectory: resolve(environment.JOKO_WEB_DIR ?? resolve("apps/web/dist")),
    ...(browserExecutable === undefined
      ? {}
      : {
          browser: {
            executablePath: browserExecutable,
            // The dedicated headed browser is the product default. Owners may
            // still force the governed sidebar surface for unattended nodes.
            headless: environment.JOKO_BROWSER_HEADLESS === "1"
          }
        }),
    corsOrigins
  };
}

function secureDataDirectory(environment: NodeJS.ProcessEnv, workspaceRoot: string): string {
  const configured = environment.JOKO_DATA_DIR?.trim();
  const candidate = canonicalizePotentialPath(configured === undefined || configured === ""
    ? defaultDataDirectory(environment)
    : configured);
  const protectedRoots = [
    { label: "configured workspace", path: canonicalizePotentialPath(workspaceRoot) },
    ...jokoSourceRoots().map((path) => ({ label: "Joko source tree", path }))
  ];
  for (const root of protectedRoots) {
    if (isWithin(root.path, candidate)) {
      throw new Error(`JOKO_DATA_DIR must be outside the ${root.label}.`);
    }
  }
  return candidate;
}

function defaultDataDirectory(environment: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    const localAppData = environment.LOCALAPPDATA?.trim();
    const userDataRoot = localAppData !== undefined && isAbsolute(localAppData)
      ? localAppData
      : join(homedir(), "AppData", "Local");
    return join(userDataRoot, "Joko", "Orchestrator");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Joko", "Orchestrator");
  }
  const xdgDataHome = environment.XDG_DATA_HOME?.trim();
  const userDataRoot = xdgDataHome !== undefined && isAbsolute(xdgDataHome)
    ? xdgDataHome
    : join(homedir(), ".local", "share");
  return join(userDataRoot, "joko", "orchestrator");
}

function jokoSourceRoots(): readonly string[] {
  const roots = new Map<string, string>();
  for (const start of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    const root = findJokoSourceRoot(start);
    if (root !== undefined) roots.set(pathComparisonKey(root), root);
  }
  return [...roots.values()];
}

function findJokoSourceRoot(start: string): string | undefined {
  let current = canonicalizePotentialPath(start);
  for (;;) {
    const workspaceManifest = join(current, "pnpm-workspace.yaml");
    if (
      existsSync(workspaceManifest) &&
      existsSync(join(current, "apps", "orchestrator", "package.json")) &&
      existsSync(join(current, "packages", "contracts", "package.json"))
    ) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Resolve links in the deepest existing ancestor while preserving a not-yet-created suffix.
 * This prevents an apparently external JOKO_DATA_DIR symlink from resolving into a workspace.
 */
function canonicalizePotentialPath(value: string): string {
  const absolute = resolve(value);
  const suffix: string[] = [];
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync.native(existing), ...suffix);
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function pathComparisonKey(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

export function readTls(config: OrchestratorConfig): { key: Buffer; cert: Buffer } | undefined {
  if (config.tls === undefined) return undefined;
  return {
    key: readFileSync(config.tls.privateKeyPath),
    cert: readFileSync(config.tls.certificatePath)
  };
}

function readPort(value: string, label = "JOKO_PORT"): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${label} must be a valid TCP port.`);
  return port;
}

function splitList(value: string): readonly string[] {
  return value.split(",").map((item) => item.trim()).filter((item) => item !== "");
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = ipv4Octets(normalized);
  return octets !== undefined && octets[0] === 127;
}

export function isPrivateLanHost(host: string): boolean {
  return isPrivateLanDiscoveryHost(host);
}

export function isPrivateLanHttpOrigin(value: string): boolean {
  try {
    const origin = parseBareOrigin(value, "LAN Web origin");
    return origin.protocol === "http:" && origin.origin === value && isPrivateLanHost(origin.hostname);
  } catch {
    return false;
  }
}

function isLanBindHost(host: string): boolean {
  return isWildcardHost(host) || isPrivateLanHost(host);
}

function isWildcardHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  return normalized === "0.0.0.0" || normalized === "::";
}

function validateServiceOrigin(
  value: string,
  options: { readonly tls: boolean; readonly allowInsecureLan: boolean; readonly label: string }
): string {
  const origin = parseBareOrigin(value, options.label);
  if ((origin.protocol === "https:") !== options.tls) {
    throw new Error(`${options.label} scheme must match the configured Orchestrator TLS mode.`);
  }
  if (origin.protocol === "http:") {
    if (!isPrivateLanHost(origin.hostname)) {
      throw new Error(`${options.label} may use HTTP only for a loopback or private-LAN host.`);
    }
    if (!isLoopbackHost(origin.hostname) && !options.allowInsecureLan) {
      throw new Error(`${options.label} private-LAN HTTP requires JOKO_ALLOW_INSECURE_LAN=1.`);
    }
  }
  return origin.origin;
}

function validateCorsOrigin(value: string, allowInsecureLan: boolean): string {
  const origin = parseBareOrigin(value, "JOKO_CORS_ORIGINS entry");
  if (origin.protocol === "http:" && !isLoopbackHost(origin.hostname)) {
    if (!isPrivateLanHost(origin.hostname)) {
      throw new Error("JOKO_CORS_ORIGINS may not contain a public HTTP origin.");
    }
    if (!allowInsecureLan) {
      throw new Error("Private-LAN HTTP CORS origins require JOKO_ALLOW_INSECURE_LAN=1.");
    }
  }
  return origin.origin;
}

function parseBareOrigin(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) origin.`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" || parsed.password !== "" ||
    parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" ||
    parsed.origin !== value ||
    isWildcardHost(parsed.hostname)
  ) throw new Error(`${label} must be a bare, non-wildcard HTTP(S) origin without credentials, path, query, or fragment.`);
  return parsed;
}

function normalizeHostname(host: string): string {
  const normalized = host.trim().toLocaleLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
}

function formatOriginHost(host: string): string {
  const normalized = normalizeHostname(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function ipv4Octets(host: string): readonly [number, number, number, number] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => /^\d{1,3}$/u.test(part) ? Number(part) : Number.NaN);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return octets as unknown as readonly [number, number, number, number];
}

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isPrivateLanDiscoveryHost } from "@joko/contracts";
import { CLOUDFLARED_VERSION } from "@jokoagent/linkspan-cloudflare";
import { validateTurnUrl } from "@jokoagent/linkspan-turn";
import type { EndpointTransportKind } from "@joko/connection-transport/trust";
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
  readonly voiceDictionaryLanDiscoveryEnabled?: boolean;
  readonly piExecutable?: string;
  readonly codexExecutable?: string;
  readonly claudeCodeExecutable?: string;
  /** Managed Desktop's private command retirement helper. */
  readonly personalDevelopmentCommandHostPath?: string;
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
  readonly pdfRendererHost?: { readonly executablePath: string; readonly appPath?: string };
  readonly mobilePush?: {
    readonly apns: {
      readonly teamId: string;
      readonly keyId: string;
      readonly privateKeyPath: string;
      readonly topic: string;
    };
  };
  /** Deployment-owned HTTPS endpoint and private bearer file, never public settings. */
  readonly remoteDesktopIce?: { readonly url: string; readonly tokenPath: string };
  /** Explicit, server-only hosted TURN key. Mutually exclusive with the external ICE broker. */
  readonly remoteDesktopTurn?: {
    readonly provider?: "cloudflare" | "twilio" | "coturn";
    readonly keyId: string;
    readonly tokenPath: string;
    readonly ttlSeconds: number;
    readonly urls?: readonly string[];
  };
  /** Select one private deployment entry's same-host UDP media mapping. */
  readonly remoteDesktopUdp?: { readonly entryId: string };
  readonly linkspan?: {
    readonly port: number;
    readonly cloudflaredExecutable?: string;
    readonly originCaPool?: string;
    readonly originServerName?: string;
    /** Private deployment selection; provider secrets never enter public settings. */
    readonly deploymentPath?: string;
  };
  /** Optional standalone Service-device outbound agent authority. */
  readonly devicePeerAgent?: {
    readonly controllerOrigin: string;
    readonly controllerServerId: string;
    readonly endpointPublicKey?: string;
    readonly transportKind?: EndpointTransportKind;
    readonly transportPath?: string;
    readonly connectionId: string;
    readonly deviceId: string;
    readonly credentialPath: string;
    readonly stateDirectory: string;
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
  const pdfHostExecutable = environment.JOKO_DOCUMENT_PDF_ELECTRON_EXECUTABLE;
  const pdfHostApp = environment.JOKO_DOCUMENT_PDF_ELECTRON_APP;
  if (pdfHostExecutable !== undefined && (!isAbsolute(pdfHostExecutable) || !existsSync(pdfHostExecutable)
    || !lstatSync(pdfHostExecutable).isFile() || lstatSync(pdfHostExecutable).isSymbolicLink())) {
    throw new Error("JOKO_DOCUMENT_PDF_ELECTRON_EXECUTABLE must be an existing absolute file.");
  }
  if (pdfHostApp !== undefined && (pdfHostExecutable === undefined || !isAbsolute(pdfHostApp) || !existsSync(pdfHostApp)
    || !lstatSync(pdfHostApp).isDirectory() || lstatSync(pdfHostApp).isSymbolicLink())) {
    throw new Error("JOKO_DOCUMENT_PDF_ELECTRON_APP must be an existing absolute directory.");
  }
  const codexExecutable = discoverCodexExecutable(environment);
  const personalDevelopmentCommandHostPath = environment.JOKO_PERSONAL_DEVELOPMENT_COMMAND_HOST;
  if (personalDevelopmentCommandHostPath !== undefined && !isAbsolute(personalDevelopmentCommandHostPath)) {
    throw new Error("JOKO_PERSONAL_DEVELOPMENT_COMMAND_HOST must be absolute.");
  }
  const mobilePush = readMobilePushConfig(environment);
  const remoteDesktopIce = readRemoteDesktopIceConfig(environment, workspaceRoot);
  const remoteDesktopTurn = readRemoteDesktopTurnConfig(environment, workspaceRoot);
  if (remoteDesktopIce !== undefined && remoteDesktopTurn !== undefined) {
    throw new Error("Choose either the external ICE broker or hosted TURN; automatic provider switching is not supported.");
  }
  const devicePeerAgent = readDevicePeerAgentConfig(environment, dataDirectory, allowInsecureLan, workspaceRoot);
  const udpEntry = environment.JOKO_REMOTE_DESKTOP_UDP_ENTRY_ID;
  if (udpEntry !== undefined && (!/^[a-z][a-z0-9-]{0,63}$/u.test(udpEntry) || environment.JOKO_LINKSPAN_CONNECTORS_FILE === undefined)) throw new Error("JOKO_REMOTE_DESKTOP_UDP_ENTRY_ID requires a valid entry in the private Linkspan deployment file.");
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
    voiceDictionaryLanDiscoveryEnabled: environment.JOKO_VOICE_DICTIONARY_LAN_DISCOVERY !== "0",
    ...(environment.JOKO_PI_EXECUTABLE === undefined ? {} : { piExecutable: environment.JOKO_PI_EXECUTABLE }),
    ...(codexExecutable === undefined ? {} : { codexExecutable }),
    ...(personalDevelopmentCommandHostPath === undefined ? {} : { personalDevelopmentCommandHostPath }),
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
    ...(pdfHostExecutable === undefined ? {} : { pdfRendererHost: {
      executablePath: pdfHostExecutable, ...(pdfHostApp === undefined ? {} : { appPath: pdfHostApp })
    } }),
    ...(mobilePush === undefined ? {} : { mobilePush }),
    ...(remoteDesktopIce === undefined ? {} : { remoteDesktopIce }),
    ...(remoteDesktopTurn === undefined ? {} : { remoteDesktopTurn }),
    ...(udpEntry === undefined ? {} : { remoteDesktopUdp: { entryId: udpEntry } }),
    ...(devicePeerAgent === undefined ? {} : { devicePeerAgent }),
    ...readLinkspanConfig(environment, tls, publicOrigin, workspaceRoot),
    corsOrigins
  };
}

function readLinkspanConfig(environment: NodeJS.ProcessEnv, tls: OrchestratorConfig["tls"], publicOrigin: string, workspaceRoot: string): { readonly linkspan?: OrchestratorConfig["linkspan"] } {
  const port = environment.JOKO_LINKSPAN_PORT;
  const mode = environment.JOKO_LINKSPAN_CLOUDFLARE;
  const deployment = environment.JOKO_LINKSPAN_CONNECTORS_FILE;
  let deploymentPath: string | undefined;
  if (deployment !== undefined) {
    if (!isAbsolute(deployment)) throw new Error("JOKO_LINKSPAN_CONNECTORS_FILE must be an absolute private file outside source/workspace roots.");
    deploymentPath = canonicalizePotentialPath(deployment);
    if ([workspaceRoot, ...jokoSourceRoots()].some(root => isWithin(canonicalizePotentialPath(root), deploymentPath!))) {
      throw new Error("JOKO_LINKSPAN_CONNECTORS_FILE must be outside source/workspace roots.");
    }
  }
  if (mode !== undefined && mode !== "quick") throw new Error("JOKO_LINKSPAN_CLOUDFLARE must be quick when enabled.");
  const bundled = fileURLToPath(new URL(`../dist/linkspan-helper/${CLOUDFLARED_VERSION}/${process.platform}-${process.arch}/${process.platform === "win32" ? "cloudflared.exe" : "cloudflared"}`, import.meta.url));
  const helper = environment.JOKO_LINKSPAN_CLOUDFLARED ?? (mode === "quick" ? bundled : undefined);
  if (port === undefined && helper === undefined && deploymentPath === undefined) return {};
  if (helper !== undefined && tls === undefined) throw new Error("Cloudflare requires the configured JOKO_TLS_CERT and JOKO_TLS_KEY for its verified HTTPS origin.");
  if (helper !== undefined && (!isAbsolute(helper) || !existsSync(helper) || !lstatSync(helper).isFile() || lstatSync(helper).isSymbolicLink())) {
    throw new Error("JOKO_LINKSPAN_CLOUDFLARED must identify a prepared, absolute helper file.");
  }
  return { linkspan: { port: port === undefined ? 0 : readPort(port, "JOKO_LINKSPAN_PORT"),
    ...(deploymentPath === undefined ? {} : { deploymentPath }),
    ...(tls === undefined ? {} : { originCaPool: tls.certificatePath,
      originServerName: new URL(publicOrigin).hostname.replace(/^\[|\]$/gu, "") }),
    ...(helper === undefined ? {} : { cloudflaredExecutable: helper, originCaPool: tls!.certificatePath,
      originServerName: new URL(publicOrigin).hostname.replace(/^\[|\]$/gu, "") }) } };
}

function readDevicePeerAgentConfig(
  environment: NodeJS.ProcessEnv,
  dataDirectory: string,
  allowInsecureLan: boolean,
  workspaceRoot: string
): OrchestratorConfig["devicePeerAgent"] {
  const values = {
    controllerOrigin: environment.JOKO_DEVICE_PEER_CONTROLLER_ORIGIN?.trim(),
    controllerServerId: environment.JOKO_DEVICE_PEER_CONTROLLER_SERVER_ID?.trim(),
    connectionId: environment.JOKO_DEVICE_PEER_CONNECTION_ID?.trim(),
    deviceId: environment.JOKO_DEVICE_PEER_DEVICE_ID?.trim()
  };
  const configured = Object.values(values).filter((value) => value !== undefined && value !== "");
  const credentialSetting = environment.JOKO_DEVICE_PEER_AUTH_KEY_FILE?.trim();
  const transportKind = environment.JOKO_DEVICE_PEER_TRANSPORT_KIND?.trim() || undefined;
  const transportFile = environment.JOKO_DEVICE_PEER_TRANSPORT_FILE?.trim() || undefined;
  if (configured.length === 0 && !credentialSetting && transportKind === undefined && transportFile === undefined) return undefined;
  if (configured.length !== Object.keys(values).length) {
    throw new Error(
      "JOKO_DEVICE_PEER_CONTROLLER_ORIGIN, JOKO_DEVICE_PEER_CONTROLLER_SERVER_ID, " +
      "JOKO_DEVICE_PEER_CONNECTION_ID, and JOKO_DEVICE_PEER_DEVICE_ID must be configured together."
    );
  }
  const credentialPath = credentialSetting === undefined || credentialSetting === ""
    ? resolve(dataDirectory, "device-peer-agent", "auth-key")
    : credentialSetting;
  if (!isAbsolute(credentialPath) || resolve(credentialPath) !== credentialPath) {
    throw new Error("JOKO_DEVICE_PEER_AUTH_KEY_FILE must be a normalized absolute path.");
  }
  try {
    const credentialInfo = lstatSync(credentialPath);
    const getuid = process.geteuid;
    if (!credentialInfo.isFile() || credentialInfo.isSymbolicLink()
      || pathComparisonKey(realpathSync.native(credentialPath)) !== pathComparisonKey(credentialPath)
      || (process.platform !== "win32" && (credentialInfo.mode & 0o077) !== 0)
      || (process.platform !== "win32" && getuid !== undefined && credentialInfo.uid !== getuid())) {
      throw new Error("unsafe");
    }
  } catch {
    // Keep deployment paths out of configuration errors. The Service owner
    // repeats the check through an open handle, including the Windows ACL.
    throw new Error("JOKO_DEVICE_PEER_AUTH_KEY_FILE is unavailable or unsafe.");
  }
  const controllerOrigin = validatePeerControllerOrigin(values.controllerOrigin!, allowInsecureLan);
  if (transportKind !== undefined && !["https", "webrtc", "iroh", "tailcat", "http-connect"].includes(transportKind)
    || (transportKind === "iroh" || transportKind === "tailcat" || transportKind === "http-connect") !== (transportFile !== undefined)) {
    throw new Error("Select a supported Service Device peer transport; iroh/tailcat/HTTP CONNECT require their own private transport file and HTTPS/WebRTC do not use that file.");
  }
  let transportPath: string | undefined;
  if (transportFile !== undefined) {
    if (!isAbsolute(transportFile)) throw new Error("JOKO_DEVICE_PEER_TRANSPORT_FILE must be an absolute private file outside source/workspace roots.");
    transportPath = canonicalizePotentialPath(transportFile);
    if ([workspaceRoot, ...jokoSourceRoots()].some(root => isWithin(canonicalizePotentialPath(root), transportPath!))) {
      throw new Error("JOKO_DEVICE_PEER_TRANSPORT_FILE must remain outside source/workspace roots.");
    }
  }
  const endpointPublicKey = environment.JOKO_DEVICE_PEER_ENDPOINT_PUBLIC_KEY?.trim();
  const controller = new URL(controllerOrigin);
  const restrictedLanHttp = allowInsecureLan && controller.protocol === "http:" && isPrivateLanHost(controller.hostname);
  if ((endpointPublicKey !== undefined && !/^ed25519:[a-f0-9]{64}$/u.test(endpointPublicKey))
    || (endpointPublicKey === undefined && (transportKind !== undefined || !isLoopbackHost(controller.hostname) && !restrictedLanHttp))) {
    throw new Error("JOKO_DEVICE_PEER_ENDPOINT_PUBLIC_KEY must be supplied through a trusted deployment channel.");
  }
  return {
    controllerOrigin,
    ...(endpointPublicKey === undefined ? {} : { endpointPublicKey }),
    ...(transportKind === undefined ? {} : { transportKind: transportKind as EndpointTransportKind }),
    ...(transportPath === undefined ? {} : { transportPath }),
    controllerServerId: devicePeerIdentifier(values.controllerServerId!, "controller server"),
    connectionId: devicePeerIdentifier(values.connectionId!, "Connection"),
    deviceId: devicePeerIdentifier(values.deviceId!, "Device"),
    credentialPath,
    stateDirectory: resolve(dataDirectory, "device-peer-agent")
  };
}

function readRemoteDesktopIceConfig(environment: NodeJS.ProcessEnv, workspaceRoot: string): OrchestratorConfig["remoteDesktopIce"] {
  const endpoint = environment.JOKO_REMOTE_DESKTOP_ICE_URL?.trim();
  const tokenSetting = environment.JOKO_REMOTE_DESKTOP_ICE_TOKEN_FILE?.trim();
  if (!endpoint && !tokenSetting) return undefined;
  const fail = (): never => { throw new Error("Remote Desktop ICE requires an HTTPS URL and a private token file outside workspace/source roots."); };
  if (!endpoint || !tokenSetting || !isAbsolute(tokenSetting)) return fail();
  let url: URL;
  try { url = new URL(endpoint); } catch { return fail(); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) return fail();
  const tokenPath = canonicalizePotentialPath(tokenSetting);
  if ([workspaceRoot, ...jokoSourceRoots()].some(root => isWithin(canonicalizePotentialPath(root), tokenPath))) return fail();
  return { url: url.toString(), tokenPath };
}

function readRemoteDesktopTurnConfig(environment: NodeJS.ProcessEnv, workspaceRoot: string): OrchestratorConfig["remoteDesktopTurn"] {
  const provider = environment.JOKO_REMOTE_DESKTOP_TURN_PROVIDER?.trim() ?? "cloudflare";
  const keyId = environment.JOKO_REMOTE_DESKTOP_TURN_KEY_ID?.trim();
  const tokenSetting = environment.JOKO_REMOTE_DESKTOP_TURN_TOKEN_FILE?.trim();
  const ttlSetting = environment.JOKO_REMOTE_DESKTOP_TURN_TTL_SECONDS?.trim();
  const urlsSetting = environment.JOKO_REMOTE_DESKTOP_TURN_URLS;
  if (!keyId && !tokenSetting && !ttlSetting && environment.JOKO_REMOTE_DESKTOP_TURN_PROVIDER === undefined && urlsSetting === undefined) return undefined;
  const fail = (): never => { throw new Error("Hosted TURN requires an explicitly selected provider/key, a private token file outside workspace/source roots, and a TTL from 180 to 86400 seconds."); };
  if (!["cloudflare", "twilio", "coturn"].includes(provider)) return fail();
  if (!keyId || !/^[A-Za-z0-9_-]{1,128}$/u.test(keyId) || !tokenSetting || !isAbsolute(tokenSetting)) return fail();
  if (provider === "twilio" && !/^AC[a-f0-9]{32}$/iu.test(keyId)) return fail();
  const tokenPath = canonicalizePotentialPath(tokenSetting);
  if ([workspaceRoot, ...jokoSourceRoots()].some(root => isWithin(canonicalizePotentialPath(root), tokenPath))) return fail();
  const ttlSeconds = ttlSetting === undefined ? 600 : Number(ttlSetting);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 180 || ttlSeconds > 86_400) return fail();
  const urls = urlsSetting === undefined ? undefined : splitList(urlsSetting);
  if (provider === "coturn" && (urls === undefined || urls.length < 1 || urls.length > 4
    || !urls.every(validateTurnUrl))) return fail();
  if (provider !== "coturn" && urls !== undefined) return fail();
  return { keyId, tokenPath, ttlSeconds, ...(provider === "cloudflare" ? {} : { provider: provider as "twilio" | "coturn" }),
    ...(urls === undefined ? {} : { urls }) };
}

function readMobilePushConfig(environment: NodeJS.ProcessEnv): OrchestratorConfig["mobilePush"] {
  const values = {
    teamId: environment.JOKO_APNS_TEAM_ID?.trim(),
    keyId: environment.JOKO_APNS_KEY_ID?.trim(),
    privateKeyPath: environment.JOKO_APNS_PRIVATE_KEY?.trim(),
    topic: environment.JOKO_APNS_TOPIC?.trim()
  };
  const configured = Object.values(values).filter((value) => value !== undefined && value !== "");
  if (configured.length === 0) return undefined;
  if (configured.length !== Object.keys(values).length) {
    throw new Error("JOKO_APNS_TEAM_ID, JOKO_APNS_KEY_ID, JOKO_APNS_PRIVATE_KEY, and JOKO_APNS_TOPIC must be configured together.");
  }
  if (!/^[A-Z0-9]{10}$/u.test(values.teamId!) || !/^[A-Z0-9]{10}$/u.test(values.keyId!)) {
    throw new Error("APNs Team ID and Key ID must be ten uppercase ASCII letters or digits.");
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/u.test(values.topic!)) {
    throw new Error("JOKO_APNS_TOPIC is invalid.");
  }
  const privateKeyPath = resolve(values.privateKeyPath!);
  if (!existsSync(privateKeyPath)) throw new Error("The configured APNs private key does not exist.");
  return {
    apns: {
      teamId: values.teamId!,
      keyId: values.keyId!,
      privateKeyPath,
      topic: values.topic!
    }
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

function validatePeerControllerOrigin(value: string, allowInsecureLan: boolean): string {
  const origin = parseBareOrigin(value, "JOKO_DEVICE_PEER_CONTROLLER_ORIGIN");
  if (origin.protocol === "http:") {
    if (!isPrivateLanHost(origin.hostname)) {
      throw new Error("JOKO_DEVICE_PEER_CONTROLLER_ORIGIN may use HTTP only for a loopback or private-LAN host.");
    }
    if (!isLoopbackHost(origin.hostname) && !allowInsecureLan) {
      throw new Error("Private-LAN Device peer HTTP requires JOKO_ALLOW_INSECURE_LAN=1.");
    }
  }
  return origin.origin;
}

function devicePeerIdentifier(value: string, label: string): string {
  if (value.length < 1 || value.length > 256 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`The Device peer ${label} identity is invalid.`);
  }
  return value;
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

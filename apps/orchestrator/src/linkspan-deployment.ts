import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectKeyDirectoryPermissions, inspectPrivateKeyPermissions } from "@joko/remote-ssh";
import type { ConnectorConfig } from "@jokoagent/linkspan-connectors";
import type { DatagramConfig } from "@jokoagent/linkspan-connectors/datagram";
import { CLOUDFLARED_VERSION } from "@jokoagent/linkspan-cloudflare";
import { normalizeEndpointTransport, type EndpointTransport } from "@joko/connection-transport/trust";
import type { LinkspanResourceManagement } from "./linkspan-resource-manager.js";

export interface CloudflareNamedDeployment {
  readonly provider: "cloudflare";
  readonly mode: "named";
  readonly executable: string;
  readonly accountId: string;
  readonly tunnelId: string;
  readonly tunnelSecret: string;
  readonly publicOrigin: string;
}
export interface LinkspanDeploymentEntry {
  readonly id: string;
  readonly connector?: ConnectorConfig | CloudflareNamedDeployment | SdkDeployment;
  readonly management?: LinkspanResourceManagement;
  readonly mediaUdp?: DatagramConfig;
  readonly mediaUdpManagement?: Extract<LinkspanResourceManagement, { readonly provider: "netbird" }>;
}
/** A distinct bounded journal/state namespace, even for a 64-character entry. */
export function linkspanMediaUdpEntryId(entryId: string): string { return `udp-${createHash("sha256").update(entryId).digest("hex").slice(0, 40)}`; }

/** The logical host remains the application's origin; the CONNECT proxy is an
 * explicit, separately selected locator and never changes system proxy state. */
export function linkspanHttpConnectTransport(connector: NonNullable<LinkspanDeploymentEntry["connector"]>): Extract<EndpointTransport, { readonly kind: "http-connect" }> | undefined {
  if (connector.provider !== "frp" || connector.mode !== "tcpmux") return;
  let origin: URL;
  try { origin = new URL(connector.publicOrigin); } catch { throw invalid(); }
  if (origin.protocol !== "https:" || origin.origin !== connector.publicOrigin) throw invalid();
  const transport = normalizeEndpointTransport({ kind: "http-connect", proxyOrigin: connector.publicProxyOrigin,
    authority: `${origin.hostname}:${origin.port || "443"}` });
  if (transport.kind !== "http-connect") throw invalid();
  return transport;
}
export type SdkDeployment = {
  readonly provider: "iroh";
  readonly invitationDirectory: string;
  readonly secretKeyHex: string;
  readonly relayUrls?: readonly string[];
  readonly relayToken?: string;
  readonly relayTokenExpiresAt?: number;
  readonly servicesApiSecretPath?: string;
  /** GUI configuration resolves this only from the server Vault. */
  readonly servicesApiSecret?: string;
  readonly relayLeaseTtlSeconds?: number;
} | {
  readonly provider: "tailcat";
  readonly invitationDirectory: string;
  readonly serverKey: string;
  readonly presharedKey: string;
  readonly allowedClients: readonly string[];
  readonly allowPrivateAddressPairing?: boolean;
  readonly port?: number;
  readonly derpMapUrl?: string;
  readonly regionId?: number;
};
interface PreparedRuntimes {
  readonly target: string;
  readonly helpers: Record<string, { executable: string; target: string; version: string; sha256: string }>;
}
interface PreparedPinggySdk {
  readonly target: string;
  readonly nodeAbi: string;
  readonly version: string;
  readonly sdkDirectory: string;
}

/** A release receipt stays relocatable. The SDK performs the native ABI and
 * complete source/binary integrity verification when the selected path starts. */
export function resolvePreparedPinggySdkDirectory(runtimeRoot: string, value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const selected = value as { target?: unknown; backends?: unknown; prepared?: { pinggy?: unknown } };
  const sdk = selected.prepared?.pinggy as Partial<PreparedPinggySdk> | undefined;
  const target = `${process.platform}-${process.arch}`;
  if (!isAbsolute(runtimeRoot) || selected.target !== target || !Array.isArray(selected.backends) || !selected.backends.includes("pinggy-sdk")
    || sdk === undefined || sdk === null || typeof sdk !== "object" || Array.isArray(sdk) || sdk.target !== target
    || sdk.nodeAbi !== "137" || sdk.version !== "0.5.3"
    || typeof sdk.sdkDirectory !== "string" || sdk.sdkDirectory.length > 4096) throw new Error("Build the selected Pinggy SDK for this server target before enabling it.");
  const parts = sdk.sdkDirectory.split("/");
  if (parts.length < 2 || parts[0] !== "pinggy" || parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part))) throw invalid();
  if (sdk.sdkDirectory !== `pinggy/pinggy-0.5.3/${target}/node-137`) throw invalid();
  const directory = resolve(runtimeRoot, ...parts), suffix = relative(runtimeRoot, directory);
  if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw invalid();
  return directory;
}

/** Deployment secrets stay in a permission-checked private file, never in public settings. */
export async function readLinkspanDeployment(path: string, signal: AbortSignal, options: { readonly resolveRuntime?: boolean } = {}): Promise<readonly LinkspanDeploymentEntry[]> {
  const directory = dirname(path);
  await inspectKeyDirectoryPermissions(directory, signal);
  signal.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let permissions: Awaited<ReturnType<typeof inspectPrivateKeyPermissions>> | undefined;
  let bytes: Buffer | undefined;
  try {
    permissions = await inspectPrivateKeyPermissions(directory, basename(path), handle, signal);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 2 || before.size > 65536) throw invalid();
    bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const part = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (part.bytesRead === 0) break;
      offset += part.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw invalid();
    await permissions.verifyFinal(); signal.throwIfAborted();
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset))); } catch { throw invalid(); }
    return await prepareLinkspanDeployment(value, options);
  } finally {
    bytes?.fill(0); await permissions?.close().catch(() => undefined); await handle.close().catch(() => undefined);
  }
}
/** Resolve only fixed build receipts; GUI input never supplies helper paths. */
export async function prepareLinkspanDeployment(value: unknown, options: { readonly resolveRuntime?: boolean } = {}): Promise<readonly LinkspanDeploymentEntry[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw invalid();
  const ids = new Set<string>();
  let prepared: PreparedRuntimes | undefined;
  const runtimeRoot = fileURLToPath(new URL("../dist/linkspan-runtime/", import.meta.url));
  const pinggyDirectory = async (): Promise<string> => {
    try { prepared ??= JSON.parse(await readFile(resolve(runtimeRoot, "selected.json"), "utf8")) as PreparedRuntimes; }
    catch { throw new Error("Build the selected Pinggy SDK before enabling it."); }
    return resolvePreparedPinggySdkDirectory(runtimeRoot, prepared);
  };
  const providers = new Set(["cloudflare", "funnel", "frp", "rathole", "bore", "ssh", "netbird", "ngrok", "zrok", "pangolin", "pinggy", "dev-tunnels", "localtunnel", "iroh", "tailcat"]);
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Object.keys(entry).some(key => !["id", "connector", "management", "mediaUdp", "mediaUdpManagement"].includes(key))
      || typeof entry.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(entry.id) || ids.has(entry.id)
      || (entry.connector === undefined ? entry.mediaUdp === undefined : entry.connector === null || typeof entry.connector !== "object" || !providers.has(entry.connector.provider))) throw invalid();
    if (entry.connector?.provider === "cloudflare" && entry.connector.mode !== "named") throw invalid();
    if (entry.connector !== undefined) linkspanHttpConnectTransport(entry.connector);
    if (entry.connector?.provider === "iroh") {
      const urls = entry.connector.relayUrls;
      if (urls !== undefined && (!Array.isArray(urls) || urls.length > 8 || urls.some((value: unknown) => typeof value !== "string"))) throw invalid();
      if (entry.connector.servicesApiSecretPath !== undefined && (!Array.isArray(urls) || urls.length === 0)) throw new Error("A restricted iroh relay requires explicit nonempty owned relay URLs before lease issuance.");
    }
    if (entry.mediaUdp !== undefined) {
      if (entry.mediaUdp === null || typeof entry.mediaUdp !== "object" || !["netbird", "pangolin", "frp", "rathole", "pinggy"].includes(entry.mediaUdp.provider)
        || entry.mediaUdp.provider === "pinggy" && entry.mediaUdp.runtime !== "sdk") throw invalid();
      if (options.resolveRuntime !== false && entry.mediaUdp.provider === "pinggy" && entry.mediaUdp.sdkDirectory === undefined) {
        entry.mediaUdp.sdkDirectory = await pinggyDirectory();
      }
      if (options.resolveRuntime !== false && entry.mediaUdp.provider !== "pinggy" && entry.mediaUdp.helper === undefined) {
        try { prepared ??= JSON.parse(await readFile(resolve(runtimeRoot, "selected.json"), "utf8")) as NonNullable<typeof prepared>; } catch { throw new Error("Build the selected UDP media helper before enabling it."); }
        const helper = prepared.helpers[entry.mediaUdp.provider];
        if (prepared.target !== `${process.platform}-${process.arch}` || helper === undefined || isAbsolute(helper.executable)) throw invalid();
        const executable = resolve(runtimeRoot, helper.executable), suffix = relative(runtimeRoot, executable);
        if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw invalid();
        entry.mediaUdp.helper = { ...helper, executable };
      }
    }
    if (entry.mediaUdpManagement !== undefined && (entry.mediaUdp?.provider !== "netbird" || entry.mediaUdpManagement === null
      || typeof entry.mediaUdpManagement !== "object" || entry.mediaUdpManagement.provider !== "netbird" || entry.mediaUdpManagement.mode !== "udp")) throw invalid();
    if (entry.connector === undefined) { if (entry.management !== undefined) throw invalid(); ids.add(entry.id); continue; }
    if (options.resolveRuntime !== false && entry.connector.provider === "cloudflare" && entry.connector.executable === undefined) {
      entry.connector.executable = fileURLToPath(new URL(`../dist/linkspan-helper/${CLOUDFLARED_VERSION}/${process.platform}-${process.arch}/${process.platform === "win32" ? "cloudflared.exe" : "cloudflared"}`, import.meta.url));
    }
    if (entry.management !== undefined && (entry.management === null || typeof entry.management !== "object"
      || entry.management.provider !== entry.connector.provider || !["cloudflare", "netbird", "dev-tunnels"].includes(entry.management.provider))) throw invalid();
    if (options.resolveRuntime !== false && ["funnel", "frp", "rathole", "bore", "netbird", "zrok", "pangolin"].includes(entry.connector.provider) && entry.connector.helper === undefined) {
      try { prepared ??= JSON.parse(await readFile(resolve(runtimeRoot, "selected.json"), "utf8")) as NonNullable<typeof prepared>; } catch { throw new Error("Build the explicitly selected connector helper before enabling this entrance."); }
      const helper = prepared.helpers[entry.connector.provider];
      if (prepared.target !== `${process.platform}-${process.arch}` || helper === undefined || isAbsolute(helper.executable)) throw new Error("The selected helper was not prepared for this server target.");
      const executable = resolve(runtimeRoot, helper.executable), suffix = relative(runtimeRoot, executable);
      if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw invalid();
      entry.connector.helper = { ...helper, executable };
    }
    if (options.resolveRuntime !== false && entry.connector.provider === "pinggy" && entry.connector.runtime === "sdk" && entry.connector.sdkDirectory === undefined) {
      entry.connector.sdkDirectory = await pinggyDirectory();
    }
    ids.add(entry.id);
  }
  return Object.freeze(value as LinkspanDeploymentEntry[]);
}
function invalid(): Error { return new Error("The private Linkspan deployment file is invalid. Check its bounded entries and selected provider configuration locally."); }

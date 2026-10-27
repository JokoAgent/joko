import { randomBytes, createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Code, ConnectError } from '@connectrpc/connect';
import { CLOUDFLARED_VERSION } from '@jokoagent/linkspan-cloudflare';
import { SERVER_ACCESS_PROVIDERS, serverAccessDefaults, serverAccessFields, serverAccessMode, serverAccessModes } from '@joko/contracts/server-access';
import type { OrchestratorConfig } from './config.js';
import { prepareLinkspanDeployment, resolvePreparedPinggySdkDirectory, type LinkspanDeploymentEntry } from './linkspan-deployment.js';
import type { LinkspanResourceManagement } from './linkspan-resource-manager.js';
import { readIceToken } from './remote-desktop-ice-configuration.js';
import { validateTurnUrl } from '@jokoagent/linkspan-turn';

export interface AccessMaterial {
  readonly fields: Record<string, string>;
  readonly identity?: Record<string, string>;
  readonly deployment?: LinkspanDeploymentEntry;
  readonly deploymentId?: string;
  /** Retained from a private deployment takeover, never editable/public fields. */
  readonly providerStateDirectory?: string;
  readonly irohRelayLease?: { readonly relayToken: string; readonly relayTokenExpiresAt: number };
}
export interface AccessConfiguration {
  readonly provider: string;
  readonly mode: string;
  readonly fields: Record<string, string>;
  readonly configuredSecrets: string[];
}
export const accessError = (issue: string, code = Code.FailedPrecondition): never => { throw new ConnectError(issue, code); };
const list = (value: string | undefined) => value?.split(/[\r\n]+/u).map(part => part.trim()).filter(Boolean) ?? [];

/** Bounds and whitelist run before storing any input or dispatching a provider. */
export function normalizeAccessConfiguration(provider: string, mode: string, input: Record<string, string>, previous?: AccessMaterial): AccessMaterial & AccessConfiguration {
  const definition = serverAccessMode(provider, mode);
  if (!definition || JSON.stringify(input).length > 48_000) return accessError('invalid_configuration', Code.InvalidArgument);
  const fields: Record<string, string> = { ...serverAccessDefaults(provider, mode) };
  for (const [key, value] of Object.entries(input)) {
    const field = definition.fields.find(field => field.key === key);
    if (!field || typeof value !== 'string' || value.length > (field.kind === 'secret' || field.kind === 'multiline' ? 16_384 : 4096)
      || /\0/u.test(value)) return accessError('invalid_configuration', Code.InvalidArgument);
    fields[key] = field.kind === 'secret' ? value : value.trim();
  }
  for (const field of definition.fields) if (field.kind === 'secret' && !(field.key in input) && previous?.fields[field.key]) fields[field.key] = previous.fields[field.key]!;
  const selected = serverAccessFields(provider, mode, fields);
  for (const key of Object.keys(fields)) if (!selected.some(field => field.key === key)) delete fields[key];
  for (const field of selected) {
    const value = fields[field.key];
    if (field.required && !value) return accessError(`required:${field.key}`, Code.InvalidArgument);
    if (!value) { delete fields[field.key]; continue; }
    if (field.kind === 'toggle' && value !== 'true' && value !== 'false' || field.kind === 'choice' && !field.choices?.includes(value)) return accessError(`invalid:${field.key}`, Code.InvalidArgument);
    if (field.kind === 'number') {
      const number = Number(value), max = field.key === 'maximumTransferMiB' ? 1_048_576 : field.key === 'maximumSessionMinutes' ? 1440 : field.key.endsWith('Seconds') ? 86_400 : 65_535;
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number) || number < 1 || number > max) return accessError(`invalid:${field.key}`, Code.InvalidArgument);
    }
    if (['publicOrigin', 'publicProxyOrigin', 'managementUrl', 'endpoint', 'host', 'derpMapUrl'].includes(field.key) && (value.includes('://') || field.key !== 'host')) {
      let url: URL; try { url = new URL(value); } catch { return accessError(`invalid:${field.key}`, Code.InvalidArgument); }
      if (url.protocol !== 'https:' && !(field.key === 'publicProxyOrigin' && url.protocol === 'http:') || url.username || url.password || url.hash || url.search
        || ['publicOrigin', 'publicProxyOrigin', 'managementUrl'].includes(field.key) && url.origin !== value) return accessError(`invalid:${field.key}`, Code.InvalidArgument);
    }
  }
  if (definition.requiresExistingPaidAccount && fields['paidEnabled'] !== 'true') return accessError('paid_consent_required', Code.InvalidArgument);
  if (provider === 'ssh' && !fields['privateKey'] && !fields['password']) return accessError('required:privateKey', Code.InvalidArgument);
  if (provider === 'iroh') {
    const urls = list(fields['relayUrls']);
    if (urls.length > 8 || fields['servicesApiSecret'] && !urls.length) return accessError('invalid:relayUrls', Code.InvalidArgument);
    for (const value of urls) { let url: URL; try { url = new URL(value); } catch { return accessError('invalid:relayUrls', Code.InvalidArgument); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) return accessError('invalid:relayUrls', Code.InvalidArgument); }
  }
  if (provider === 'tailcat' && (list(fields['allowedClients']).length > 128 || list(fields['allowedClients']).some(value => !/^nodekey:[a-f0-9]{64}$/u.test(value)))) return accessError('invalid:allowedClients', Code.InvalidArgument);
  if (mode === 'turn') {
    if (Number(fields['ttlSeconds']) < 180) return accessError('invalid:ttlSeconds', Code.InvalidArgument);
    if (provider === 'coturn' && (list(fields['urls']).length < 1 || list(fields['urls']).length > 4)) return accessError('invalid:urls', Code.InvalidArgument);
    if (provider === 'twilio' && !/^AC[a-fA-F0-9]{32}$/u.test(fields['keyId'] ?? '')) return accessError('invalid:keyId', Code.InvalidArgument);
    if (!list(fields['urls']).every(validateTurnUrl)) return accessError('invalid:urls', Code.InvalidArgument);
  }
  const identity = previous?.identity ?? (provider === 'iroh' ? { secretKeyHex: randomBytes(32).toString('hex') } : provider === 'tailcat'
    ? { serverKey: `privkey:${randomBytes(32).toString('hex')}`, presharedKey: `psk:${randomBytes(32).toString('hex')}` } : undefined);
  const deploymentId = previous?.deploymentId ?? previous?.deployment?.id;
  const deployed = (previous?.deployment?.connector ?? previous?.deployment?.mediaUdp) as unknown as Record<string, unknown> | undefined;
  const providerStateDirectory = ['funnel', 'netbird'].includes(provider) ? previous?.providerStateDirectory ?? deployed?.['stateDirectory'] : undefined;
  const irohRelayLease = provider === 'iroh' ? previous?.irohRelayLease ?? (typeof deployed?.['relayToken'] === 'string' && typeof deployed['relayTokenExpiresAt'] === 'number'
    ? { relayToken: deployed['relayToken'], relayTokenExpiresAt: deployed['relayTokenExpiresAt'] } : undefined) : undefined;
  return { provider, mode, fields, configuredSecrets: selected.filter(field => field.kind === 'secret' && fields[field.key]).map(field => field.key), ...(identity ? { identity } : {}), ...(deploymentId ? { deploymentId } : {}),
    ...(typeof providerStateDirectory === 'string' ? { providerStateDirectory } : {}), ...(irohRelayLease ? { irohRelayLease } : {}) };
}
export function publicAccessFields(provider: string, mode: string, fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(serverAccessFields(provider, mode, fields).filter(field => field.kind !== 'secret' && fields[field.key] !== undefined).map(field => [field.key, fields[field.key]!]));
}

export const bundledCloudflared = () => fileURLToPath(new URL(`../dist/linkspan-helper/${CLOUDFLARED_VERSION}/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'}`, import.meta.url));
const runtimeRoot = () => fileURLToPath(new URL('../dist/linkspan-runtime/', import.meta.url));
const regular = (path: string) => { try { const info = lstatSync(path); return info.isFile() && !info.isSymbolicLink(); } catch { return false; } };
export async function accessCapabilities(config: OrchestratorConfig) {
  let receipt: { target?: string; backends?: string[]; helpers?: Record<string, { executable: string; target: string }>; prepared?: Record<string, unknown> } | undefined;
  try { receipt = JSON.parse(await readFile(join(runtimeRoot(), 'selected.json'), 'utf8')); } catch { /* Missing builds are a capability, not a service failure. */ }
  return SERVER_ACCESS_PROVIDERS.flatMap(provider => serverAccessModes(provider.id).map(mode => {
    let state = 'ready', issue = '';
    const runtime = mode.runtime;
    if (runtime === 'cloudflare') { if (!regular(config.linkspan?.cloudflaredExecutable ?? bundledCloudflared())) state = 'missing_runtime'; }
    else if (['ssh', 'ngrok', 'localtunnel', 'dev-tunnels', 'pinggy-ssh', 'turn'].includes(runtime)) {
      try {
        const entry = import.meta.resolve(`@jokoagent/linkspan-${runtime === 'pinggy-ssh' ? 'pinggy' : runtime}`);
        if (!regular(fileURLToPath(entry))) state = 'missing_runtime';
      } catch { state = 'missing_runtime'; }
    } else if (receipt?.target !== `${process.platform}-${process.arch}` || !receipt.backends?.includes(runtime)) state = 'missing_runtime';
    else if (runtime === 'pinggy-sdk') {
      try { if (process.versions.modules !== '137' || !existsSync(resolvePreparedPinggySdkDirectory(runtimeRoot(), receipt))) state = 'missing_runtime'; } catch { state = 'missing_runtime'; }
    } else if (['iroh', 'tailcat'].includes(runtime)) {
      if (!receipt.prepared?.[runtime] || !existsSync(join(runtimeRoot(), runtime))) state = 'missing_runtime';
    } else {
      const helper = receipt.helpers?.[runtime], executable = helper && resolve(runtimeRoot(), helper.executable), suffix = executable && relative(runtimeRoot(), executable);
      if (!helper || helper.target !== `${process.platform}-${process.arch}` || isAbsolute(helper.executable)
        || !suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix) || !regular(executable!)) state = 'missing_runtime';
    }
    if (state === 'missing_runtime') issue = `runtime:${runtime}:${process.platform}-${process.arch}`;
    else if (mode.requiresTls && !config.tls) { state = 'missing_tls'; issue = 'tls_required'; }
    else if (mode.id === 'turn' && config.remoteDesktopIce) { state = 'external_ice_config'; issue = 'external_ice_config'; }
    return { provider: provider.id, mode: mode.id, state, issue };
  }));
}

/** A PEM is public, immutable and content-addressed. Browser callers never supply a helper/file target. */
async function certificate(config: OrchestratorConfig, pem: string): Promise<string> {
  if (!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/u.test(pem) || pem.includes('PRIVATE KEY')) return accessError('invalid_certificate', Code.InvalidArgument);
  const directory = join(config.dataDirectory, 'linkspan-certificates');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${createHash('sha256').update(pem).digest('hex')}.pem`);
  try { await writeFile(path, pem, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(path, 'utf8') !== pem) throw error; }
  return path;
}

export async function accessDeployment(config: OrchestratorConfig, id: string, provider: string, mode: string, material: AccessMaterial): Promise<LinkspanDeploymentEntry> {
  id = material.deploymentId ?? material.deployment?.id ?? id;
  if (material.deployment) {
    const frozen = structuredClone(material.deployment), connector = frozen.connector as unknown as Record<string, unknown> | undefined;
    if (connector?.['provider'] === 'iroh' && material.fields['servicesApiSecret']) { connector['servicesApiSecret'] = material.fields['servicesApiSecret']; delete connector['servicesApiSecretPath']; }
    const raw = (connector ?? frozen.mediaUdp) as Record<string, unknown>;
    if (material.fields['serverCaPem']) raw['serverCaPool'] = await certificate(config, material.fields['serverCaPem']);
    if (material.fields['trustedRootPem']) (raw['transport'] as Record<string, unknown>)['trustedRoot'] = await certificate(config, material.fields['trustedRootPem']);
    return (await prepareLinkspanDeployment([frozen]))[0]!;
  }
  const fields = material.fields, selected: Record<string, unknown> = { provider };
  if (['funnel', 'netbird'].includes(provider) && material.providerStateDirectory) selected['stateDirectory'] = material.providerStateDirectory;
  const ignored = new Set(['maximumSessionMinutes', 'maximumTransferMiB', 'paidEnabled', 'resourceMode', 'apiToken', 'domain', 'peerId', 'tokenScheme']);
  for (const field of serverAccessFields(provider, mode, fields)) if (!ignored.has(field.key) && fields[field.key]) {
    selected[field.key] = field.kind === 'number' ? Number(fields[field.key]) : field.kind === 'toggle' ? fields[field.key] === 'true' : fields[field.key];
  }
  if (provider === 'iroh' || provider === 'tailcat') {
    const invitationDirectory = join(config.dataDirectory, 'credentials', 'linkspan-invitations');
    await mkdir(invitationDirectory, { recursive: true, mode: 0o700 });
    Object.assign(selected, material.identity, { invitationDirectory });
    if (provider === 'iroh' && material.irohRelayLease) Object.assign(selected, material.irohRelayLease);
    if (provider === 'iroh') { if (fields['relayUrls']) selected['relayUrls'] = list(fields['relayUrls']); }
    else selected['allowedClients'] = list(fields['allowedClients']);
  } else {
    selected['budget'] = { paidEnabled: fields['paidEnabled'] === 'true', maximumSessionMs: Number(fields['maximumSessionMinutes'] ?? 60) * 60_000, maximumBytes: Number(fields['maximumTransferMiB'] ?? 1024) * 1_048_576 };
    if (['cloudflare', 'funnel', 'frp', 'ngrok', 'zrok', 'pangolin', 'netbird'].includes(provider)) selected['mode'] = mode;
    if (provider === 'cloudflare') delete selected['budget'];
    if (provider === 'ngrok' && fields['domain']) selected['domain'] = fields['domain'];
    if (provider === 'funnel') selected['port'] = Number(fields['port'] ?? 443);
    if (provider === 'frp') { selected['serverCaPool'] = await certificate(config, fields['serverCaPem']!); delete selected['serverCaPem']; }
    if (provider === 'rathole') {
      const tls = mode.endsWith('tls');
      selected['transport'] = tls ? { type: 'tls', hostname: fields['hostname'], trustedRoot: await certificate(config, fields['trustedRootPem']!) }
        : { type: 'noise', remotePublicKey: fields['remotePublicKey'] };
      for (const key of ['hostname', 'trustedRootPem', 'remotePublicKey']) delete selected[key];
    }
    if (provider === 'pinggy') {
      const [runtime, kind, endpoint] = mode.split('-'); selected['runtime'] = runtime; selected['mode'] = kind;
      if (endpoint) selected['tlstcpEndpoint'] = endpoint;
    }
  }
  const media = serverAccessMode(provider, mode)?.purpose === 'media';
  if (media) { delete selected['mode']; return (await prepareLinkspanDeployment([{ id, mediaUdp: selected }]))[0]!; }
  return (await prepareLinkspanDeployment([{ id, connector: selected }]))[0]!;
}

export function accessManagement(provider: string, mode: string, fields: Record<string, string>, credentialReferenceId: string): LinkspanResourceManagement | undefined {
  if (fields['resourceMode'] !== 'managed') return;
  if (provider === 'cloudflare' && mode === 'named') return { provider, accountId: fields['accountId']!, credentialReferenceId };
  if (provider === 'netbird' && ['http', 'tls', 'tcp', 'udp'].includes(mode)) return { provider, managementUrl: fields['managementUrl']!, mode: mode as 'http' | 'tls' | 'tcp' | 'udp', domain: fields['domain']!, peerId: fields['peerId']!, targetPort: Number(fields['listenPort']), credentialReferenceId };
  if (provider === 'dev-tunnels') return { provider, clusterId: fields['clusterId']!, port: Number(fields['port']), tokenScheme: fields['tokenScheme'] === 'github' ? 'github' : 'Bearer', credentialReferenceId };
  return accessError('resource_unavailable');
}

/** Deployment reads are private; only the metadata whitelist can leave this module. */
export async function describeDeployment(entry: LinkspanDeploymentEntry): Promise<AccessConfiguration & { material: AccessMaterial }> {
  const value = entry.connector ?? entry.mediaUdp;
  if (!value) return accessError('invalid_deployment');
  const raw = value as unknown as Record<string, unknown>, provider = value.provider;
  const transport = raw['transport'] as { type?: string; remotePublicKey?: string; hostname?: string; trustedRoot?: string } | undefined;
  const mode = provider === 'iroh' || provider === 'tailcat' ? 'relay' : provider === 'rathole' ? `${entry.connector ? '' : 'udp-'}${transport?.type}`
    : provider === 'pinggy' ? `${raw['runtime']}-${entry.connector ? raw['mode'] : 'udp'}${raw['mode'] === 'tlstcp' ? `-${raw['tlstcpEndpoint']}` : ''}`
    : !entry.connector ? 'udp' : String(raw['mode'] ?? (['bore', 'ssh'].includes(provider) ? 'tcp' : 'http'));
  const fields: Record<string, string> = { ...serverAccessDefaults(provider, mode) };
  for (const field of serverAccessMode(provider, mode)?.fields ?? []) if (raw[field.key] !== undefined) fields[field.key] = Array.isArray(raw[field.key]) ? (raw[field.key] as string[]).join('\n') : String(raw[field.key]);
  const budget = raw['budget'] as { maximumSessionMs: number; maximumBytes: number; paidEnabled: boolean } | undefined;
  if (budget) Object.assign(fields, { maximumSessionMinutes: String(budget.maximumSessionMs / 60_000), maximumTransferMiB: String(budget.maximumBytes / 1_048_576), paidEnabled: String(budget.paidEnabled) });
  if (transport) { if (transport.remotePublicKey) fields['remotePublicKey'] = transport.remotePublicKey; if (transport.hostname) fields['hostname'] = transport.hostname; }
  if (provider === 'iroh' && typeof raw['servicesApiSecretPath'] === 'string') fields['servicesApiSecret'] = await readIceToken(raw['servicesApiSecretPath'], AbortSignal.timeout(10_000));
  const management = entry.management ?? entry.mediaUdpManagement;
  if (management) {
    fields['resourceMode'] = 'managed';
    for (const field of serverAccessMode(provider, mode)?.fields ?? []) {
      const value = (management as unknown as Record<string, unknown>)[field.key];
      if (value !== undefined && field.kind !== 'secret') fields[field.key] = String(value);
    }
    if (management.tokenPath) fields['apiToken'] = await readIceToken(management.tokenPath, AbortSignal.timeout(10_000));
    if (management.provider === 'netbird') fields['listenPort'] = String(management.targetPort);
  }
  for (const [path, key] of [[raw['serverCaPool'], 'serverCaPem'], [transport?.trustedRoot, 'trustedRootPem']] as const) if (typeof path === 'string') {
    const pem = await readFile(path, 'utf8'); if (pem.length > 16_384) return accessError('invalid_certificate'); fields[key] = pem;
  }
  const identity: Record<string, string> | undefined = provider === 'iroh' ? { secretKeyHex: String(raw['secretKeyHex']) } : provider === 'tailcat' ? { serverKey: String(raw['serverKey']), presharedKey: String(raw['presharedKey']) } : undefined;
  return { provider, mode, fields: publicAccessFields(provider, mode, fields), configuredSecrets: serverAccessMode(provider, mode)?.fields.filter(field => field.kind === 'secret' && fields[field.key]).map(field => field.key) ?? [],
    material: { fields, deployment: entry, deploymentId: entry.id, ...(identity ? { identity } : {}) } };
}

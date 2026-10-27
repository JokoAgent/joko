/** Lightweight setup metadata. Reading this catalogue never loads a carrier. */
export { serverAccessEnglish, serverAccessChinese, serverAccessIssue, serverAccessText } from './server-access-messages.js';
export type ServerAccessProvider = 'cloudflare' | 'funnel' | 'frp' | 'rathole' | 'bore' | 'ssh'
  | 'netbird' | 'ngrok' | 'zrok' | 'pangolin' | 'pinggy' | 'dev-tunnels' | 'localtunnel' | 'iroh' | 'tailcat' | 'twilio' | 'coturn';

export interface ServerAccessField {
  readonly key: string;
  readonly kind: 'text' | 'secret' | 'multiline' | 'number' | 'choice' | 'toggle';
  readonly required?: boolean;
  readonly advanced?: boolean;
  readonly initial?: string;
  readonly choices?: readonly string[];
  readonly resource?: 'existing' | 'managed';
  readonly multiline?: boolean;
}
export interface ServerAccessMode {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly ServerAccessField[];
  readonly runtime: string;
  readonly requiresTls: boolean;
  readonly requiresExistingPaidAccount?: boolean;
  readonly purpose?: 'media';
}
export interface ServerAccessProviderDefinition {
  readonly id: ServerAccessProvider;
  readonly name: string;
  readonly modes: readonly ServerAccessMode[];
}

const field = (key: string, kind: ServerAccessField['kind'] = 'text', options: Omit<ServerAccessField, 'key' | 'kind'> = {}): ServerAccessField => ({ key, kind, ...options });
const required = (key: string, kind: ServerAccessField['kind'] = 'text') => field(key, kind, { required: true });
const optional = (key: string, kind: ServerAccessField['kind'] = 'text', initial?: string) => field(key, kind, { advanced: true, ...(initial === undefined ? {} : { initial }) });
const mode = (id: string, label: string, runtime: string, fields: readonly ServerAccessField[], requiresTls = true, requiresExistingPaidAccount = false): ServerAccessMode =>
  ({ id, label, runtime, fields: requiresExistingPaidAccount ? fields.map(value => value.key === 'paidEnabled' ? { ...value, advanced: false } : value) : fields,
    requiresTls, ...(requiresExistingPaidAccount ? { requiresExistingPaidAccount } : {}) });
const origin = required('publicOrigin');
const budget = [optional('maximumSessionMinutes', 'number', '60'), optional('maximumTransferMiB', 'number', '1024'), field('paidEnabled', 'toggle', { initial: 'false', advanced: true })];
const relay = [required('serverAddress'), required('serverPort', 'number'), required('token', 'secret'), required('serverName'), required('serverCaPem', 'multiline')];
const ssh = [required('host'), optional('port', 'number', '22'), required('username'), required('hostKeySha256'), field('privateKey', 'secret', { multiline: true }), field('password', 'secret'), optional('passphrase', 'secret')];
const existing = (value: ServerAccessField): ServerAccessField => ({ ...value, resource: 'existing' });
const managed = (value: ServerAccessField): ServerAccessField => ({ ...value, resource: 'managed' });
const resourceChoice = field('resourceMode', 'choice', { initial: 'existing', choices: ['existing', 'managed'] });
const resourceToken = managed(required('apiToken', 'secret'));
const netbird = [resourceChoice, required('managementUrl'), required('setupKey', 'secret'), existing(required('resourceId')), required('listenPort', 'number'), existing(origin),
  resourceToken, managed(required('domain')), managed(required('peerId'))];
const pangolin = [required('endpoint'), required('siteId'), required('siteSecret', 'secret'), origin];
const pinggyHttp = [optional('token', 'secret'), optional('publicOrigin')];
const pinggySsh = [required('serverHostKeySha256'), optional('serverAddress')];

export const SERVER_ACCESS_PROVIDERS: readonly ServerAccessProviderDefinition[] = [
  { id: 'cloudflare', name: 'Cloudflare', modes: [
    mode('quick', 'Quick Tunnel', 'cloudflare', []),
    mode('named', 'Named tunnel', 'cloudflare', [resourceChoice, required('accountId'), existing(required('tunnelId')), existing(required('tunnelSecret', 'secret')), origin, resourceToken]),
    { ...mode('turn', 'TURN', 'turn', [required('keyId'), required('apiToken', 'secret'), optional('ttlSeconds', 'number', '3600')], false), purpose: 'media' }
  ] },
  { id: 'funnel', name: 'Tailscale Funnel', modes: [
    mode('http', 'HTTPS / WSS', 'funnel', [required('hostname'), required('authKey', 'secret'), field('port', 'choice', { initial: '443', choices: ['443', '8443', '10000'], advanced: true }), ...budget]),
    mode('tcp', 'TCP', 'funnel', [required('hostname'), required('authKey', 'secret'), field('port', 'choice', { initial: '443', choices: ['443', '8443', '10000'], advanced: true }), ...budget])
  ] },
  { id: 'iroh', name: 'iroh', modes: [mode('relay', 'Direct / relay', 'iroh', [
    optional('relayUrls', 'multiline'), optional('servicesApiSecret', 'secret'), optional('relayLeaseTtlSeconds', 'number', '3600')
  ], false)] },
  { id: 'tailcat', name: 'tailcat', modes: [mode('relay', 'DERP', 'tailcat', [
    field('allowPrivateAddressPairing', 'toggle', { initial: 'true' }), optional('allowedClients', 'multiline'), optional('derpMapUrl'), optional('port', 'number', '443'), optional('regionId', 'number')
  ], false)] },
  { id: 'ngrok', name: 'ngrok', modes: [
    mode('http', 'HTTPS / WSS', 'ngrok', [required('authtoken', 'secret'), optional('domain'), ...budget]),
    mode('tls', 'TLS', 'ngrok', [required('authtoken', 'secret'), required('domain'), origin, ...budget], true, true),
    mode('tcp', 'TCP', 'ngrok', [required('authtoken', 'secret'), origin, optional('remoteAddress'), ...budget])
  ] },
  { id: 'pinggy', name: 'Pinggy', modes: [
    mode('sdk-http', 'HTTPS / WSS · SDK', 'pinggy-sdk', [...pinggyHttp, ...budget]),
    mode('ssh-http', 'HTTPS / WSS · SSH', 'pinggy-ssh', [...pinggySsh, ...pinggyHttp, ...budget]),
    ...(['tls', 'tcp', 'tlstcp-tcp', 'tlstcp-tls'] as const).flatMap(kind => (['sdk', 'ssh'] as const).map(runtime =>
      mode(`${runtime}-${kind}`, `${kind.toUpperCase()} · ${runtime.toUpperCase()}`, `pinggy-${runtime}`,
        [...(runtime === 'ssh' ? pinggySsh : []), origin, optional('token', 'secret'), ...budget], true, kind.startsWith('tlstcp'))))
  ] },
  { id: 'localtunnel', name: 'localtunnel', modes: [mode('http', 'HTTPS / WSS', 'localtunnel', [optional('host'), optional('subdomain'), ...budget])] },
  { id: 'frp', name: 'frp', modes: (['http', 'https', 'tcp', 'tcpmux'] as const).map(kind =>
    mode(kind, kind === 'tcpmux' ? 'HTTP CONNECT' : kind.toUpperCase(), 'frp',
      [...relay, origin, ...(kind === 'tcp' ? [required('remotePort', 'number')] : kind === 'tcpmux' ? [required('publicProxyOrigin')] : []), ...budget], kind !== 'tcpmux')) },
  { id: 'rathole', name: 'rathole', modes: (['noise', 'tls'] as const).map(kind =>
    mode(kind, `TCP · ${kind.toUpperCase()}`, 'rathole', [required('remoteAddress'), required('serviceName'), required('token', 'secret'),
      ...(kind === 'noise' ? [required('remotePublicKey')] : [required('hostname'), required('trustedRootPem', 'multiline')]), origin, ...budget])) },
  { id: 'bore', name: 'bore', modes: [mode('tcp', 'TCP', 'bore', [required('serverAddress'), required('remotePort', 'number'), origin, optional('secret', 'secret'), ...budget])] },
  { id: 'ssh', name: 'SSH reverse', modes: [mode('tcp', 'TCP', 'ssh', [...ssh, required('remoteBindAddress'), required('remotePort', 'number'), origin, ...budget])] },
  { id: 'netbird', name: 'NetBird public proxy', modes: (['http', 'tls', 'tcp'] as const).map(kind => mode(kind, kind.toUpperCase(), 'netbird', [...netbird, ...budget])) },
  { id: 'zrok', name: 'zrok', modes: [
    mode('public', 'Public HTTPS / WSS', 'zrok', [required('environmentDirectory'), optional('publicOrigin'), ...budget]),
    mode('reserved', 'Reserved hostname', 'zrok', [required('environmentDirectory'), required('reservedToken', 'secret'), origin, ...budget])
  ] },
  { id: 'pangolin', name: 'Pangolin', modes: (['http', 'tcp'] as const).map(kind => mode(kind, kind.toUpperCase(), 'pangolin', [...pangolin, ...budget])) },
  { id: 'dev-tunnels', name: 'Dev Tunnels', modes: [mode('http', 'Anonymous HTTPS / WSS', 'dev-tunnels', [resourceChoice, existing(required('tunnelId')), required('clusterId'), existing(required('hostAccessToken', 'secret')), required('port', 'number'), existing(origin), resourceToken,
    managed(field('tokenScheme', 'choice', { initial: 'Bearer', choices: ['Bearer', 'github'] })), ...budget])] },
  { id: 'twilio', name: 'Twilio', modes: [{ ...mode('turn', 'TURN', 'turn', [required('keyId'), required('apiToken', 'secret'), optional('ttlSeconds', 'number', '3600')], false), purpose: 'media' }] },
  { id: 'coturn', name: 'coturn', modes: [{ ...mode('turn', 'TURN', 'turn', [required('keyId'), required('apiToken', 'secret'), required('urls', 'multiline'), optional('ttlSeconds', 'number', '3600')], false), purpose: 'media' }] }
];

/** Media UDP publishes only the already-authorized local media projection. */
export const SERVER_ACCESS_MEDIA_MODES: Readonly<Record<string, readonly ServerAccessMode[]>> = {
  frp: [{ ...mode('udp', 'UDP', 'frp', [...relay, required('remotePort', 'number'), required('publicHost'), required('publicPort', 'number'), ...budget], false), purpose: 'media' }],
  rathole: ['noise', 'tls'].map(kind => ({ ...mode(`udp-${kind}`, `UDP · ${kind.toUpperCase()}`, 'rathole', [required('remoteAddress'), required('serviceName'), required('token', 'secret'),
    ...(kind === 'noise' ? [required('remotePublicKey')] : [required('hostname'), required('trustedRootPem', 'multiline')]), required('publicHost'), required('publicPort', 'number'), ...budget], false), purpose: 'media' as const })),
  netbird: [{ ...mode('udp', 'UDP', 'netbird', [resourceChoice, required('managementUrl'), required('setupKey', 'secret'), existing(required('resourceId')), required('listenPort', 'number'), existing(required('publicHost')), existing(required('publicPort', 'number')), resourceToken, managed(required('domain')), managed(required('peerId')), ...budget], false), purpose: 'media' }],
  pangolin: [{ ...mode('udp', 'UDP', 'pangolin', [required('endpoint'), required('siteId'), required('siteSecret', 'secret'), required('remoteNodeId'), required('publicHost'), required('publicPort', 'number'), ...budget], false), purpose: 'media' }],
  pinggy: [{ ...mode('sdk-udp', 'UDP · SDK', 'pinggy-sdk', [optional('token', 'secret'), optional('publicHost'), optional('publicPort', 'number'), ...budget], false), purpose: 'media' }]
};

export function serverAccessModes(provider: string): readonly ServerAccessMode[] {
  return [...(serverAccessProvider(provider)?.modes ?? []), ...(SERVER_ACCESS_MEDIA_MODES[provider] ?? [])];
}
export function serverAccessFields(provider: string, mode: string, values: Readonly<Record<string, string>>): readonly ServerAccessField[] {
  return (serverAccessMode(provider, mode)?.fields ?? []).filter(field => !field.resource || field.resource === (values['resourceMode'] || 'existing'));
}

export function serverAccessProvider(value: string): ServerAccessProviderDefinition | undefined {
  return SERVER_ACCESS_PROVIDERS.find(provider => provider.id === value);
}
export function serverAccessMode(provider: string, value: string): ServerAccessMode | undefined {
  return serverAccessModes(provider).find(mode => mode.id === value);
}
export function serverAccessDefaults(provider: string, selectedMode: string): Readonly<Record<string, string>> {
  return Object.fromEntries(serverAccessMode(provider, selectedMode)?.fields.filter(field => field.initial !== undefined).map(field => [field.key, field.initial!]) ?? []);
}

/** Selected-mode guidance stays lightweight; it must not initialize an SDK. */
export function serverAccessGuidance(provider: string, selectedMode: string): readonly string[] {
  if (selectedMode === 'turn') return ['access.turnHelp', provider === 'cloudflare' ? 'access.turnCloudflareHelp' : 'access.turnTtlHelp'];
  if (provider === 'cloudflare') return [selectedMode === 'quick' ? 'access.quickHelp' : 'access.namedHelp'];
  if (provider === 'iroh' || provider === 'tailcat') return ['access.sdkHelp', `access.${provider}Help`];
  const keys = [`access.${provider}Help`, 'access.budgetHelp'];
  if (provider === 'frp') keys.unshift(selectedMode === 'tcpmux' ? 'access.connectHelp' : selectedMode === 'http' ? 'access.frpHttpHelp' : selectedMode === 'udp' ? 'access.udpHelp' : 'access.rawTlsHelp');
  else if (selectedMode === 'udp' || selectedMode.startsWith('udp-') || selectedMode === 'sdk-udp') keys.unshift('access.udpHelp');
  else if (['tcp', 'tls', 'noise'].includes(selectedMode)
    || provider === 'pinggy' && /^(sdk|ssh)-(tcp|tls|tlstcp-tcp)$/u.test(selectedMode)) keys.unshift('access.rawTlsHelp');
  return keys;
}

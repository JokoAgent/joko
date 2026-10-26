import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { installEndpointTransportPreparation, normalizeEndpointPublicKey, normalizeEndpointTransport, requireEndpointTrust, type EndpointTrust } from '@joko/connection-transport/node';

/** Register locations only. SDK code and binary loading wait for a selected path. */
export function createDesktopEndpointRuntimePreparation(options: { readonly packaged: boolean; readonly resourcesPath: string; readonly sourceDirectory: string }): (kind: 'iroh' | 'tailcat') => Promise<void> {
  const root = options.packaged ? join(options.resourcesPath, 'orchestrator-runtime', 'dist', 'linkspan-runtime')
    : join(options.sourceDirectory, 'orchestrator-runtime', 'dist', 'linkspan-runtime');
  const configured = new Map<'iroh' | 'tailcat', Promise<void>>();
  return kind => {
    const existing = configured.get(kind);
    if (existing !== undefined) return existing;
    const directory = join(root, kind);
    const pending = kind === 'iroh'
      ? import('@jokoagent/linkspan-iroh-node').then(({ configureIrohRuntime }) => { configureIrohRuntime(directory); })
      : import('@jokoagent/linkspan-tailcat-node').then(({ configureTailcatRuntime }) => { configureTailcatRuntime(directory); });
    configured.set(kind, pending);
    void pending.catch(() => { if (configured.get(kind) === pending) configured.delete(kind); });
    return pending;
  };
}

export function installDesktopEndpointRuntimes(options: { readonly packaged: boolean; readonly resourcesPath: string; readonly sourceDirectory: string },
  prepare = createDesktopEndpointRuntimePreparation(options)): () => void {
  return installEndpointTransportPreparation(prepare);
}

/** Reads the independent locator entry without retrieving the business Auth Key. */
export async function desktopEndpointTrust(owner: EndpointTrust & { readonly profileId: string }, readSecret: (id: string) => Promise<string | undefined>): Promise<Omit<EndpointTrust, 'origin'>> {
  const endpointPublicKey = owner.endpointPublicKey === undefined ? requireEndpointTrust({ origin: owner.origin }) : normalizeEndpointPublicKey(owner.endpointPublicKey);
  const transportKind = owner.transportKind ?? 'https';
  if (transportKind === 'https') return { endpointPublicKey, transportKind };
  if (endpointPublicKey === undefined) throw new Error('The selected transport requires a trusted node public key.');
  if (transportKind === 'webrtc') return { endpointPublicKey, transportKind, endpointTransport: { kind: 'webrtc' } };
  const id = `transport_${createHash('sha256').update(owner.profileId, 'utf8').digest('hex')}`;
  const raw = await readSecret(id);
  if (raw === undefined || raw.length > 32768) throw new Error('The private transport locator is unavailable. Import its trusted invitation again.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('The protected transport locator is invalid.'); }
  const expectedOwner = JSON.stringify([owner.profileId, owner.origin, owner.serverId, endpointPublicKey, transportKind]);
  if (value === null || typeof value !== 'object' || Array.isArray(value) || (value as { owner?: unknown }).owner !== expectedOwner) throw new Error('The protected transport locator does not match this connection owner.');
  const endpointTransport = normalizeEndpointTransport((value as { transport?: unknown }).transport);
  if (endpointTransport.kind !== transportKind) throw new Error('The protected locator belongs to another connection transport.');
  return { endpointPublicKey, transportKind, endpointTransport };
}

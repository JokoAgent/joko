import type { OrchestratorApplication } from './application.js';
import type { OrchestratorConfig } from './config.js';
import type { OperationalStore } from '@joko/store';
import type { CredentialManager } from './credential-manager.js';
import type { RemoteDesktopIceConfigurationProvider } from './remote-desktop-coordinator.js';
import { LinkspanRemoteDesktopTurnConfiguration } from './linkspan-turn-configuration.js';
import { LinkspanRemoteDesktopUdpMapping, type RemoteDesktopUdpMappingProvider } from './linkspan-media-udp.js';
import type { DevicePeerSelectionIdentity } from './device-peer-owner.js';
import type { AccessHandle, AccessRecord, ServerAccessRuntime } from './server-access-manager.js';
import { accessDeployment, accessManagement, accessError, bundledCloudflared, type AccessMaterial } from './server-access-configuration.js';
import { startManagedLinkspanConnector } from './linkspan-connector.js';
import { startManagedProviderConnector } from './linkspan-provider-connector.js';
import { startLinkspanSdkIngress } from './linkspan-sdk-server.js';
import { linkspanHttpConnectTransport, linkspanMediaUdpEntryId } from './linkspan-deployment.js';
import { manageLinkspanResource, resolveManagedLinkspanConnector } from './linkspan-resource-manager.js';
import { createLinkspanIngress } from './linkspan-server.js';
import { createLinkspanTcpIngress } from './linkspan-tcp-server.js';
import { connectionEntryDirectory } from './connection-entries.js';
import { readFileSync } from 'node:fs';
import { reconcileConnectorResource, type ConnectorConfig, type ConnectorResource } from '@jokoagent/linkspan-connectors';
import { linkspanProcessIsRetired } from './linkspan-process-identity.js';
import type { EndpointTransport } from '@joko/connection-transport/trust';

/** Each media lease keeps the provider it began with; a settings change cannot reissue its effects. */
export class ServerAccessMedia {
  #turn?: RemoteDesktopIceConfigurationProvider;
  #udp?: RemoteDesktopUdpMappingProvider;
  readonly #preparing = new Set<'turn' | 'udp'>();
  readonly #turnLeases = new Map<string, RemoteDesktopIceConfigurationProvider>();
  readonly #udpLeases = new Map<string, RemoteDesktopUdpMappingProvider | undefined>();
  constructor(readonly options: {
    readonly config: OrchestratorConfig; readonly store: OperationalStore; readonly serverId: string; readonly credentials: CredentialManager;
    readonly fallbackIce: RemoteDesktopIceConfigurationProvider; readonly fetch: typeof fetch;
    readonly isLocalDesktopRoute: (identity: DevicePeerSelectionIdentity) => boolean;
  }) {}
  readonly ice: RemoteDesktopIceConfigurationProvider = {
    getConfiguration: input => {
      let selected = this.#turnLeases.get(input.leaseId);
      if (!selected) { selected = this.#turn ?? this.options.fallbackIce; this.#turnLeases.set(input.leaseId, selected); }
      return selected.getConfiguration(input);
    },
    releaseConfiguration: async leaseId => { const selected = this.#turnLeases.get(leaseId); await selected?.releaseConfiguration?.(leaseId); this.#turnLeases.delete(leaseId); },
    close: async () => { await this.#turn?.close?.(); await this.options.fallbackIce.close?.(); this.#turnLeases.clear(); }
  };
  #udpFor(leaseId: string) { if (!this.#udpLeases.has(leaseId)) this.#udpLeases.set(leaseId, this.#udp); return this.#udpLeases.get(leaseId); }
  readonly udp: RemoteDesktopUdpMappingProvider = {
    mapAnswer: async (input, sdp) => this.#udpFor(input.leaseId)?.mapAnswer(input, sdp) ?? sdp,
    exchangeIce: (input, after, dispatch) => this.#udpFor(input.leaseId)?.exchangeIce(input, after, dispatch) ?? dispatch(after),
    releaseLease: async leaseId => { await this.#udpLeases.get(leaseId)?.releaseLease(leaseId); this.#udpLeases.delete(leaseId); },
    retireLocalCapture: async input => { await this.#udpLeases.get(input.leaseId)?.retireLocalCapture(input); },
    close: async () => { await this.#udp?.close(); this.#udpLeases.clear(); }
  };
  async start(record: AccessRecord, material: AccessMaterial): Promise<AccessHandle> {
    const kind = record.mode === 'turn' ? 'turn' : 'udp';
    if (kind === 'turn' && this.options.config.remoteDesktopIce) return accessError('external_ice_config');
    if (this.#preparing.has(kind)) return accessError('media_singleton');
    this.#preparing.add(kind);
    try { return await this.#activate(record, material); }
    finally { this.#preparing.delete(kind); }
  }
  async #activate(record: AccessRecord, material: AccessMaterial): Promise<AccessHandle> {
    let selected: { close(): Promise<void> };
    let retire: () => Promise<void>;
    if (record.mode === 'turn') {
      if (this.#turn) return accessError('media_singleton');
      const fields = material.fields;
      const turn = new LinkspanRemoteDesktopTurnConfiguration({ store: this.options.store, credentials: this.options.credentials, fetch: this.options.fetch,
        configuration: { provider: record.provider as 'cloudflare' | 'twilio' | 'coturn', keyId: fields['keyId']!, tokenPath: '', ttlSeconds: Number(fields['ttlSeconds'] ?? 3600),
          ...(fields['urls'] ? { urls: fields['urls'].split(/[\r\n]+/u).filter(Boolean) } : {}) }, readToken: async (_path, signal) => { signal.throwIfAborted(); return fields['apiToken']!; } });
      await turn.initialize(); this.#turn = turn; selected = turn;
      retire = async () => {
        await turn.close(); await turn.initialize();
        if (this.options.store.listSettingsByKeyPrefix('service', 'orchestrator', 'runtime.linkspan.turn.').some(({ value }) => {
          const journal = value as { provider?: string; keyId: string; state: string };
          return (journal.provider ?? 'cloudflare') === record.provider && journal.keyId === fields['keyId'] && journal.state !== 'closed';
        })) throw Object.assign(new Error('Original TURN cleanup is unconfirmed.'), { code: 'cleanup_failed' });
      };
    } else {
      if (this.#udp) return accessError('media_singleton');
      const entry = await accessDeployment(this.options.config, record.entryId, record.provider, record.mode, material);
      if (!entry.mediaUdp) return accessError('invalid_configuration');
      const udp = new LinkspanRemoteDesktopUdpMapping({ ...this.options, config: { ...this.options.config, remoteDesktopUdp: { entryId: entry.id } }, configuration: entry.mediaUdp });
      await udp.initialize(); this.#udp = udp; selected = udp;
      retire = async () => {
        await udp.close(); await udp.initialize();
        if (this.options.store.listSettingsByKeyPrefix('service', 'orchestrator', 'runtime.linkspan.media_udp.').some(({ value }) => {
          const journal = value as { entryId: string; state: string }; return journal.entryId === entry.id && journal.state !== 'closed';
        })) throw Object.assign(new Error('Original UDP cleanup is unconfirmed.'), { code: 'cleanup_failed' });
      };
    }
    let active = true;
    return { isActive: () => active, close: async () => {
      await retire(); active = false;
      if (this.#turn === selected) this.#turn = undefined;
      if (this.#udp === selected) this.#udp = undefined;
    } };
  }
}

/** Listeners are lazy and each handle owns exactly the bridge/helper it started. */
interface Publication { readonly publicOrigin?: string; readonly invitationPath?: string; readonly limits?: unknown; readonly endpointTransport?: EndpointTransport }
export function createServerAccessRuntime(application: OrchestratorApplication, backendOrigin: string, onPublished?: (record: AccessRecord, publication: Publication) => void): ServerAccessRuntime {
  // HTTP publishers share the original configured loopback TLS port. A failed
  // candidate releases only its reference; it cannot close a healthy publisher.
  let publicBridge: Promise<{ localOrigin: string; references: number; retiring: boolean; close(): Promise<void> }> | undefined;
  let closingBridge: Promise<void> | undefined;
  const acquirePublicBridge = async (): Promise<{ localOrigin: string; close(): Promise<void> }> => {
    if (closingBridge) await closingBridge;
    const pending = publicBridge ??= (async () => {
      const tls = application.config.tls; if (!tls) return accessError('tls_required');
      const ingress = createLinkspanIngress(application, { backendOrigin, tls: { cert: readFileSync(tls.certificatePath), key: readFileSync(tls.privateKeyPath) } });
      try { return { localOrigin: await ingress.listen({ host: '127.0.0.1', port: application.config.linkspan?.port ?? 0 }), references: 0, retiring: false, close: () => ingress.close() }; }
      catch (error) { await ingress.close(); throw error; }
    })();
    let shared: Awaited<typeof pending>;
    try { shared = await pending; } catch (error) { if (publicBridge === pending) publicBridge = undefined; throw error; }
    if (shared.retiring) return acquirePublicBridge();
    shared.references++;
    let closed = false;
    return { localOrigin: shared.localOrigin, async close() {
      if (closed) return; closed = true;
      if (--shared.references === 0) {
        shared.retiring = true;
        // Keep the closing listener in the chain until its port is released.
        const closing = shared.close(); closingBridge = closing; publicBridge = undefined;
        await closing;
        if (closingBridge === closing) closingBridge = undefined;
      }
    } };
  };
  return {
    async start(record, material, signal) {
      if (record.mode === 'turn' || record.mode === 'udp' || record.mode.startsWith('udp-') || record.mode === 'sdk-udp') {
        if (!application.serverAccessMedia) return accessError('media_unavailable');
        return application.serverAccessMedia.start(record, material);
      }
      const publishedEntryId = record.provider === 'cloudflare' && record.mode === 'quick' ? 'quick:cloudflare' : `linkspan:${record.entryId}`;
      let bridge: { close(): Promise<void> } | undefined;
      let child: AccessHandle & Publication;
      try {
        if (record.provider === 'iroh' || record.provider === 'tailcat') {
          const entry = await accessDeployment(application.config, record.entryId, record.provider, record.mode, material);
          if (entry.connector?.provider !== 'iroh' && entry.connector?.provider !== 'tailcat') return accessError('invalid_configuration');
          child = await startLinkspanSdkIngress(application, { id: record.entryId, displayName: record.name, connector: entry.connector }, { backendOrigin, signal });
        } else {
          const entry = record.provider === 'cloudflare' && record.mode === 'quick' ? undefined : await accessDeployment(application.config, record.entryId, record.provider, record.mode, material);
          const connector = entry?.connector;
          if (connector?.provider === 'iroh' || connector?.provider === 'tailcat') return accessError('invalid_configuration');
          const transport = connector ? linkspanHttpConnectTransport(connector) : undefined;
          let localOrigin: string | undefined, encryptedStreamTarget: { address: '127.0.0.1' | '::1'; port: number } | undefined;
          if (transport) { const tcp = createLinkspanTcpIngress(application, { backendOrigin, signal }); bridge = tcp; encryptedStreamTarget = await tcp.listen(); }
          else {
            const ingress = await acquirePublicBridge(); bridge = ingress; localOrigin = ingress.localOrigin;
          }
          signal.throwIfAborted();
          const originCaPool = application.config.tls?.certificatePath, originServerName = new URL(application.config.publicOrigin).hostname.replace(/^\[|\]$/gu, '');
          if (!connector) child = await startManagedLinkspanConnector(application, { executable: application.config.linkspan?.cloudflaredExecutable ?? bundledCloudflared(), localOrigin: localOrigin!, originCaPool: originCaPool!, originServerName, displayName: record.name, signal });
          else {
            const configuration = (record.reference ? accessManagement(record.provider, record.mode, material.fields, record.reference) : undefined) ?? entry?.management;
            const selected = await resolveManagedLinkspanConnector(application, { entryId: entry!.id, connector,
              ...(configuration ? { configuration } : {}), signal }); signal.throwIfAborted();
            child = await startManagedProviderConnector(application, { id: record.entryId, displayName: record.name, connector: selected }, {
              ...(encryptedStreamTarget ? { encryptedStreamTarget } : { localOrigin: localOrigin!, originCaPool: originCaPool!, originServerName }), signal });
          }
        }
      } catch (error) { await bridge?.close(); throw error; }
      try { onPublished?.(record, child); } catch { /* Console reporting cannot revoke an established, journaled publication. */ }
      return { ...child, publishedEntryId, isActive: () => connectionEntryDirectory(application).entries.some(entry => entry.entryId === publishedEntryId),
        async close() { await child.close(); await bridge?.close(); } };
    },
    async resource(record, material, action, confirmResourceId, signal) {
      const configuration = accessManagement(record.provider, record.mode, material.fields, record.reference!) ?? material.deployment?.management ?? material.deployment?.mediaUdpManagement;
      if (!configuration) return accessError('resource_unavailable');
      const media = record.mode === 'udp', id = material.deploymentId ?? material.deployment?.id ?? record.entryId;
      return manageLinkspanResource(application, { action, entryId: media ? linkspanMediaUdpEntryId(id) : id, configuration, ...(confirmResourceId ? { confirmResourceId } : {}), signal });
    },
    async reconcile(record, material, signal) {
      if (record.mode === 'turn' || record.mode === 'udp' || record.mode.startsWith('udp-') || record.mode === 'sdk-udp') {
        signal.throwIfAborted(); if (!application.serverAccessMedia) return accessError('media_unavailable');
        const handle = await application.serverAccessMedia.start(record, material); await handle.close(); return;
      }
      const sdk = ['iroh', 'tailcat'].includes(record.provider), quick = record.provider === 'cloudflare' && record.mode === 'quick';
      const key = quick ? 'runtime.linkspan.quick' : `runtime.linkspan.${sdk ? 'sdk' : 'connector'}.${record.entryId}`;
      const journal = application.store.findSetting<{ state: string; requestId: string; resource?: ConnectorResource; processId?: number; processIdentity?: string; resourceProcessIdentity?: string; ownerProcessId?: number; ownerProcessIdentity?: string }>('service', 'orchestrator', key)?.value;
      if (!journal || journal.state === 'closed') return;
      const operation = application.store.getOperation(journal.requestId);
      const expectedKind = quick ? 'connection.public.quick.start' : sdk ? 'connection.sdk.listen' : 'connection.public.start';
      if (operation.kind !== expectedKind || operation.connectionId !== undefined || operation.completionMode !== 'external_effect'
        || (operation.body as { serverId?: string; entryId?: string }).serverId !== application.serverId
        || !quick && (operation.body as { entryId?: string }).entryId !== record.entryId) return accessError('query_original_operation');
      let retired = sdk || quick ? journal.processId !== undefined && linkspanProcessIsRetired(journal.processId, journal.processIdentity)
        : record.provider === 'cloudflare' ? journal.processId !== undefined && linkspanProcessIsRetired(journal.processId, journal.resourceProcessIdentity)
          : record.provider !== 'zrok' && (journal.resource?.processId !== undefined ? linkspanProcessIsRetired(journal.resource.processId, journal.resourceProcessIdentity)
            : journal.ownerProcessId !== undefined && linkspanProcessIsRetired(journal.ownerProcessId, journal.ownerProcessIdentity));
      if (!retired && journal.resource && record.provider !== 'cloudflare' && !sdk) {
        const entry = await accessDeployment(application.config, record.entryId, record.provider, record.mode, material);
        retired = (await reconcileConnectorResource(entry.connector as ConnectorConfig, journal.resource, { requestId: journal.requestId, signal, deadline: Date.now() + 10_000 })).state === 'retired';
      }
      signal.throwIfAborted(); if (!retired) return accessError('query_original_operation');
      application.store.transaction(() => {
        if (operation.status === 'started') application.store.completeDeferredEffectOperation(operation.id, operation.bodyHash, () => ({ state: 'closed', reason: 'original_resource_retired' }));
        application.store.setSetting('service', 'orchestrator', key, { ...journal, state: 'closed' });
      });
    }
  };
}

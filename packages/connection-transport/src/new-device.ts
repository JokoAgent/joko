import { normalizeEndpointTransport, type EndpointTransport } from './endpoint-transport.js';
import { endpointOrigin, normalizeEndpointPublicKey } from './trust.js';

export interface IrohRelayInvitationRequest {
  readonly requestId: string;
  readonly recipientEndpointId: string;
}

export interface NewDeviceAuthorizationOptions {
  readonly irohRelay?: IrohRelayInvitationRequest;
  /** Native/Web authority checkpoints only the public receipt, before pairing. */
  readonly onIrohRelayLease?: (expiresAt: number) => Promise<void>;
}

/** Public metadata only: retain unknown attempts across client restarts. */
export interface RetainedIrohRelayRequest extends IrohRelayInvitationRequest {
  readonly nodeEndpointId: string;
  readonly expiresAt?: number;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const endpointId = /^[a-f0-9]{64}$/u;

export function retainIrohRelayRequest(existing: unknown, input: RetainedIrohRelayRequest): RetainedIrohRelayRequest {
  if (!uuid.test(input.requestId) || !endpointId.test(input.nodeEndpointId) || !endpointId.test(input.recipientEndpointId)) throw new Error('A stable request UUID and the new device iroh public key are required.');
  if (existing === undefined || existing === null) return { requestId: input.requestId, nodeEndpointId: input.nodeEndpointId, recipientEndpointId: input.recipientEndpointId };
  if (typeof existing !== 'object' || Array.isArray(existing)) throw new Error('The original relay invitation request is damaged. Recover its result before replacing it.');
  const record = existing as Record<string, unknown>;
  if (Object.keys(record).some(key => !['requestId', 'nodeEndpointId', 'recipientEndpointId', 'expiresAt'].includes(key))
    || typeof record['requestId'] !== 'string' || !uuid.test(record['requestId']) || record['nodeEndpointId'] !== input.nodeEndpointId || record['recipientEndpointId'] !== input.recipientEndpointId
    || record['expiresAt'] !== undefined && (!Number.isSafeInteger(record['expiresAt']) || Number(record['expiresAt']) <= 0)) throw new Error('The original relay invitation request does not match this node and recipient.');
  // A confirmed, expired lease is safe to renew on this new user action. An
  // unknown attempt has no expiry and must retain its original request ID.
  if (typeof record['expiresAt'] === 'number' && record['expiresAt'] <= Date.now()) return { requestId: input.requestId, nodeEndpointId: input.nodeEndpointId, recipientEndpointId: input.recipientEndpointId };
  return { requestId: record['requestId'], nodeEndpointId: input.nodeEndpointId, recipientEndpointId: input.recipientEndpointId,
    ...(record['expiresAt'] === undefined ? {} : { expiresAt: Number(record['expiresAt']) }) };
}

export function requireIrohRelayInvitationRequest(transport: EndpointTransport | undefined, options?: NewDeviceAuthorizationOptions): IrohRelayInvitationRequest | undefined {
  const request = options?.irohRelay;
  if (request === undefined) {
    if (transport?.kind === 'iroh' && transport.relayToken !== undefined) throw new Error('Enter the new device iroh public key to issue its own restricted relay lease.');
    return undefined;
  }
  if (transport?.kind !== 'iroh' || !uuid.test(request.requestId) || !endpointId.test(request.recipientEndpointId)) throw new Error('The relay invitation requires the selected iroh entrance, a retained request UUID and the new device public key.');
  if (request.recipientEndpointId === transport.clientEndpointId) throw new Error('Use the new device public key. This device relay lease cannot be copied to another device.');
  return request;
}

interface RelayInvitationValue {
  readonly requestId: string;
  readonly nodeEndpointId: string;
  readonly recipientEndpointId: string;
  readonly ticket: string;
  readonly relayUrls: readonly string[];
  readonly relayToken: string;
  readonly expiresAt?: { readonly seconds: bigint; readonly nanos: number };
  readonly origin: string;
  readonly serverId: string;
  readonly endpointPublicKey: string;
}

/** Validate a private response against the already verified connection scope. */
export function irohTransportForRecipient(input: {
  readonly transport: Extract<EndpointTransport, { kind: 'iroh' }>;
  readonly origin: string;
  readonly serverId: string;
  readonly endpointPublicKey: string;
  readonly request: IrohRelayInvitationRequest;
  readonly invitation: RelayInvitationValue | undefined;
  readonly allowExpiredReceipt?: boolean;
}): Extract<EndpointTransport, { kind: 'iroh' }> {
  const value = input.invitation;
  const expiresAt = value?.expiresAt === undefined ? NaN : Number(value.expiresAt.seconds) * 1000 + Math.floor(value.expiresAt.nanos / 1_000_000);
  if (value === undefined || value.requestId !== input.request.requestId || value.nodeEndpointId !== input.transport.endpointId
    || value.recipientEndpointId !== input.request.recipientEndpointId || value.serverId !== input.serverId
    || endpointOrigin(value.origin) !== endpointOrigin(input.origin) || normalizeEndpointPublicKey(value.endpointPublicKey) !== normalizeEndpointPublicKey(input.endpointPublicKey)
    || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !input.allowExpiredReceipt && expiresAt <= Date.now() || expiresAt > Date.now() + 86_400_000
    || !Number.isInteger(value.expiresAt?.nanos) || value.expiresAt!.nanos < 0 || value.expiresAt!.nanos >= 1_000_000_000) throw new Error('The private relay invitation did not match the original node, request and new device.');
  const transport = normalizeEndpointTransport({ kind: 'iroh', endpointId: value.nodeEndpointId, ticket: value.ticket,
    clientEndpointId: value.recipientEndpointId, relayUrls: [...value.relayUrls], relayToken: value.relayToken, relayTokenExpiresAt: expiresAt });
  if (transport.kind !== 'iroh') throw new Error('The private relay invitation backend changed.');
  return transport;
}

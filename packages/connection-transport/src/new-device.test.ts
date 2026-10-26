import { describe, expect, it } from 'vitest';
import { irohTransportForRecipient, requireIrohRelayInvitationRequest, retainIrohRelayRequest } from './new-device.js';

const owner = { origin: 'https://recipient-node.example', serverId: 'node', endpointPublicKey: `ed25519:${'a'.repeat(64)}` };
const transport = { kind: 'iroh' as const, endpointId: 'b'.repeat(64), ticket: 'original-iroh-ticket', clientKey: 'c'.repeat(64), clientEndpointId: 'd'.repeat(64), relayUrls: ['https://relay.example'], relayToken: 'A-relay-lease', relayTokenExpiresAt: Date.now() + 3600000 };
const request = { requestId: '00000000-0000-4000-8000-000000000001', recipientEndpointId: 'e'.repeat(64) };
const receipt = () => ({ ...request, nodeEndpointId: transport.endpointId, ticket: 'B-iroh-private-ticket', relayUrls: ['https://relay.example'], relayToken: 'B-only-relay-lease', expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 3600), nanos: 0 }, ...owner });

describe('recipient-bound relay invitations', () => {
  it('requires B public key for a restricted route and never copies A private key or relay lease', () => {
    expect(() => requireIrohRelayInvitationRequest(transport)).toThrow(/new device iroh public key/u);
    expect(() => requireIrohRelayInvitationRequest(transport, { irohRelay: { ...request, recipientEndpointId: transport.clientEndpointId } })).toThrow(/cannot be copied/u);
    expect(requireIrohRelayInvitationRequest(transport, { irohRelay: request })).toEqual(request);
    expect(requireIrohRelayInvitationRequest(undefined)).toBeUndefined();
    const value = irohTransportForRecipient({ ...owner, transport, request, invitation: receipt() });
    expect(value).toMatchObject({ kind: 'iroh', endpointId: transport.endpointId, clientEndpointId: request.recipientEndpointId, relayToken: 'B-only-relay-lease', ticket: 'B-iroh-private-ticket' });
    expect(value).not.toHaveProperty('clientKey');
    expect(JSON.stringify(value)).not.toContain(transport.clientKey);
    expect(JSON.stringify(value)).not.toContain(transport.relayToken);
  });

  it.each(['requestId', 'nodeEndpointId', 'recipientEndpointId', 'serverId', 'origin', 'endpointPublicKey'] as const)('rejects a different %s before using private material', field => {
    const value = { ...receipt(), [field]: field === 'origin' ? 'https://other-node.example' : field === 'endpointPublicKey' ? `ed25519:${'f'.repeat(64)}` : 'f'.repeat(64) };
    expect(() => irohTransportForRecipient({ ...owner, transport, request, invitation: value })).toThrow();
  });

  it('rejects expired, excessive or malformed leases', () => {
    for (const seconds of [BigInt(Math.floor(Date.now() / 1000) - 1), BigInt(Math.ceil(Date.now() / 1000) + 86401)]) {
      expect(() => irohTransportForRecipient({ ...owner, transport, request, invitation: { ...receipt(), expiresAt: { seconds, nanos: 0 } } })).toThrow();
    }
    expect(() => irohTransportForRecipient({ ...owner, transport, request, invitation: { ...receipt(), relayUrls: ['http://relay.example'] } })).toThrow();
    expect(() => irohTransportForRecipient({ ...owner, transport, request, invitation: { ...receipt(), expiresAt: { seconds: 1n, nanos: 1000000000 } } })).toThrow();
  });

  it('retains an unknown request across restart and renews only a confirmed expired lease', () => {
    const original = { ...request, nodeEndpointId: transport.endpointId };
    const replacement = { ...original, requestId: '00000000-0000-4000-8000-000000000002' };
    expect(retainIrohRelayRequest(JSON.parse(JSON.stringify(original)), replacement)).toEqual(original);
    expect(retainIrohRelayRequest({ ...original, expiresAt: Date.now() + 60000 }, replacement)).toEqual({ ...original, expiresAt: expect.any(Number) });
    expect(retainIrohRelayRequest({ ...original, expiresAt: Date.now() - 1 }, replacement)).toEqual(replacement);
    expect(() => retainIrohRelayRequest({ ...original, recipientEndpointId: 'f'.repeat(64) }, replacement)).toThrow(/does not match/u);
    expect(() => retainIrohRelayRequest({ ...original, relayToken: 'must-never-be-public' }, replacement)).toThrow();
  });
});

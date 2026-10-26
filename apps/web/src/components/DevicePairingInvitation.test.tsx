// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { DevicePairingInvitation } from './DevicePairingInvitation.js';
import { translate } from '../i18n.js';
import type { AppController } from '../controller.js';

describe('new device authorization', () => {
  it('retains the recipient request after an unknown result and prevents duplicate button dispatch', async () => {
    const runtime = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }; runtime.IS_REACT_ACT_ENVIRONMENT = true;
    const recipientEndpointId = 'b'.repeat(64);
    const value = { challengeId: 'challenge', humanCode: '1234-5678', expiresAt: Date.now() + 60000, origin: 'https://node.example', serverId: 'node', endpointPublicKey: `ed25519:${'1'.repeat(64)}`, trustedInvitation: '{"version":1}', endpointTransport: { kind: 'iroh' as const, ticket: 'private-iroh-ticket', endpointId: 'a'.repeat(64) } };
    let rejectFirst!: (error: Error) => void;
    const authorizeNewDevice = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; })).mockResolvedValue(value);
    const controller = { state: { activeProfile: { id: 'profile', serverId: 'node', endpointPublicKey: value.endpointPublicKey, origin: value.origin, transportKind: 'iroh' } }, authorizeNewDevice } as unknown as AppController;
    const container = document.body.appendChild(document.createElement('div')), root = createRoot(container);
    try {
      await act(async () => root.render(<DevicePairingInvitation controller={controller} t={(key, values) => translate('en', key, values)} />));
      const recipient = container.querySelector<HTMLInputElement>('input[aria-label="New device iroh public key"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(recipient, recipientEndpointId);
        recipient.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => { const button = container.querySelector('button')!; button.click(); button.click(); });
      expect(authorizeNewDevice).toHaveBeenCalledTimes(1);
      const original = authorizeNewDevice.mock.calls[0]![0];
      expect(original).toEqual({ irohRelay: { recipientEndpointId, requestId: expect.stringMatching(/^[a-f0-9-]{36}$/u) } });
      await act(async () => rejectFirst(new Error('The original relay request is still unknown.')));
      await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
      expect(authorizeNewDevice).toHaveBeenCalledTimes(2);
      expect(authorizeNewDevice.mock.calls[1]![0]).toEqual(original);
      expect(container.querySelector<HTMLInputElement>('input[type="url"]')?.readOnly).toBe(true);
    } finally { await act(async () => root.unmount()); container.remove(); Reflect.deleteProperty(runtime, 'IS_REACT_ACT_ENVIRONMENT'); }
  });

  it('shows the privately issued code and waits for successful server cancellation before removing it', async () => {
    const runtime = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }; runtime.IS_REACT_ACT_ENVIRONMENT = true;
    const value = { challengeId: 'challenge', humanCode: '1234-5678', expiresAt: Date.now() + 60000, origin: 'https://node.example', serverId: 'node', endpointPublicKey: `ed25519:${'1'.repeat(64)}`, trustedInvitation: '{"version":1}' };
    const authorizeNewDevice = vi.fn(async () => value), cancelDevicePairing = vi.fn(async (): Promise<void> => { throw new Error('Cancellation could not be confirmed.'); });
    const controller = { state: { activeProfile: { id: 'profile', serverId: 'node', endpointPublicKey: value.endpointPublicKey } }, authorizeNewDevice, cancelDevicePairing } as unknown as AppController;
    const container = document.body.appendChild(document.createElement('div')), root = createRoot(container);
    try {
      await act(async () => root.render(<DevicePairingInvitation controller={controller} t={(key, values) => translate('en', key, values)} />));
      expect(authorizeNewDevice).not.toHaveBeenCalled();
      await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
      expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe(value.humanCode);
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(value.trustedInvitation);
      await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
      expect(cancelDevicePairing).toHaveBeenCalledWith(value);
      expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe(value.humanCode);
      expect(container.textContent).toContain('Cancellation could not be confirmed.');
      cancelDevicePairing.mockImplementation(async () => undefined);
      await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
      expect(container.querySelector('input')).toBeNull();
    } finally { await act(async () => root.unmount()); container.remove(); Reflect.deleteProperty(runtime, 'IS_REACT_ACT_ENVIRONMENT'); }
  });
});

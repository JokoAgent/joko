// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDeviceInvitation, formatDeviceTarget, parseDeviceInvitation, formatDeviceTransportRequest, type DeviceAuthorizationPort, type DeviceAuthorizationProgress } from '@joko/connection-transport/device-authorization';
import { DeviceAuthorizationState } from '@joko/contracts';
import { DeviceAuthorizationEntry } from './DeviceAuthorizationEntry.js';
import { DeviceAuthorizationSettings } from './DeviceAuthorizationSettings.js';
import type { ConnectionScreenController } from '../connection-contract.js';
import type { AppController } from '../controller.js';
import { translate } from '../i18n.js';
import type { Translator } from './types.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const t: Translator = (key, values) => translate('en', key, values);
const link = formatDeviceInvitation({ origin: 'https://node.example', serverId: 'node', endpointPublicKey: `ed25519:${'a'.repeat(64)}`,
  invitationId: '11111111-1111-4111-8111-111111111111', invitationSecret: 'b'.repeat(64), expiresAt: Date.now() + 600_000 });
const progress: DeviceAuthorizationProgress = { invitationId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222',
  userCode: 'ABCD-EFGH', state: 'pending', deviceName: 'My laptop', platform: 'web', expiresAt: Date.now() + 600_000, origin: 'https://node.example', serverId: 'node' };
let root: Root | undefined, element: HTMLDivElement;
function setup(port: Partial<DeviceAuthorizationPort>) {
  element = document.body.appendChild(document.createElement('div')); root = createRoot(element);
  const api = { start: vi.fn(async () => progress), refresh: vi.fn(async () => undefined), cancel: vi.fn(async () => progress),
    finish: vi.fn(async () => {}), discard: vi.fn(async () => {}), ...port };
  const controller = { state: { profiles: [] }, deviceAuthorization: api } as unknown as ConnectionScreenController;
  return { api, controller };
}
function button(text: string): HTMLButtonElement { return [...element.querySelectorAll('button')].find(value => value.textContent === text)!; }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; element?.remove(); });

describe('request-bound device authorization UI', () => {
  it('retries a failed entrance directory on the same page without requesting authorization', async () => {
    const entries = vi.fn().mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValue([{ id: 'direct', name: 'Direct', provider: 'direct', origin: 'https://node.example', kind: 'https' }]);
    const { api, controller } = setup({ entries });
    await act(async () => root!.render(<DeviceAuthorizationEntry controller={controller} t={t} defaultName="Laptop" initialInvitation={link} />));
    expect(button('Request connection').disabled).toBe(true);
    await act(async () => button('Retry available methods').click());
    expect(entries).toHaveBeenCalledTimes(2); expect(button('Request connection').disabled).toBe(false);
    expect(api.start).not.toHaveBeenCalled();
  });
  it('restores an expired private request, renews it and cancels only its new request ID', async () => {
    const old = { requestId: progress.requestId, kind: 'iroh' as const, publicKey: 'c'.repeat(64), expiresAt: Date.now() - 1 };
    const renewed = { ...old, requestId: '33333333-3333-4333-8333-333333333333', expiresAt: Date.now() + 600_000 };
    const transportRequest = vi.fn(async () => formatDeviceTransportRequest(renewed)), cancelTransportRequest = vi.fn(async () => {});
    const { api, controller } = setup({ pendingTransportRequest: async () => formatDeviceTransportRequest(old), transportRequest, cancelTransportRequest });
    await act(async () => root!.render(<DeviceAuthorizationEntry controller={controller} t={t} defaultName="Laptop" />));
    await act(async () => button('Connect through a private entrance').click());
    expect(element.textContent).toContain('This request expired'); expect(element.querySelector('textarea')).toBeNull();
    await act(async () => button('Create a new request').click());
    expect(transportRequest).toHaveBeenCalledWith('iroh', expect.any(AbortSignal));
    await act(async () => button('Cancel request and choose again').click());
    expect(cancelTransportRequest).toHaveBeenCalledWith(renewed.requestId, expect.any(AbortSignal));
    expect(element.querySelectorAll('.connection-method')).toHaveLength(2); expect(api.start).not.toHaveBeenCalled();
  });
  it('retains an unverified discovery selection and requires an explicit choice for a different invitation', async () => {
    const { api, controller } = setup({}); const clear = vi.fn();
    await act(async () => root!.render(<DeviceAuthorizationEntry controller={controller} t={t} defaultName="Laptop" initialInvitation={link}
      discoveredNode={{ serverId: 'other-node', name: 'Home server', origin: 'http://192.168.1.8' }} onClearDiscovered={clear} />));
    expect(element.textContent).toContain('Home server'); expect(element.textContent).toContain('Discovery is unverified');
    expect(button('Request connection').disabled).toBe(true); expect(api.start).not.toHaveBeenCalled();
    await act(async () => button('Use the node in this invitation').click()); expect(clear).toHaveBeenCalledOnce();
  });
  it('limits a new invitation to the current published entrance and prepares a single private choice', async () => {
    setup({});
    const privateEntry = { entryId: 'private', origin: 'http://127.0.0.1:4318', provider: 'iroh', displayName: 'iroh', transportKind: 'iroh', requiresClientIdentity: true };
    const create = vi.fn(async (_input: unknown) => ({ ...parseDeviceInvitation(link), origin: privateEntry.origin, entries: [privateEntry], authorization: {
      invitationId: '11111111-1111-4111-8111-111111111111', state: DeviceAuthorizationState.INVITED, requestId: '', userCode: '', deviceName: '', platform: '', expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 600), nanos: 0 } } }));
    const controller = { state: { activeProfile: { id: 'owner', origin: privateEntry.origin, transportKind: 'iroh' }, connectionGeneration: 1 },
      deviceAuthorizationOwner: () => ({ list: async () => [], entries: async () => [privateEntry], create }) } as unknown as AppController;
    await act(async () => root!.render(<DeviceAuthorizationSettings controller={controller} t={t} />));
    await act(async () => { const select = element.querySelector('select')!; select.value = 'current'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { button('Add a device').click(); await vi.waitFor(() => expect(create).toHaveBeenCalledOnce()); });
    expect(create.mock.calls[0]?.[0]).toMatchObject({ entryIds: ['private'] });
    expect(element.textContent).toContain('Request link from the new device');
    expect(button('Prepare this invitation').disabled).toBe(true);
  });
  it('opens only the exact requested review and never approves automatically or shows a replacement request', async () => {
    setup({}); const resolve = vi.fn(); let rows = [progress];
    const reviewRequest = { ...parseDeviceInvitation(link), requestId: progress.requestId };
    const controller = { state: { activeProfile: { id: 'owner', ...parseDeviceInvitation(link) }, connectionGeneration: 1 },
      deviceAuthorizationOwner: () => ({ list: async () => rows, resolve }) } as unknown as AppController;
    await act(async () => root!.render(<DeviceAuthorizationSettings controller={controller} t={t} reviewRequest={reviewRequest} />));
    expect(element.textContent).toContain(progress.userCode); expect(resolve).not.toHaveBeenCalled();
    await act(async () => root!.unmount()); root = createRoot(element); rows = [{ ...progress, requestId: '33333333-3333-4333-8333-333333333333' }];
    await act(async () => root!.render(<DeviceAuthorizationSettings controller={controller} t={t} reviewRequest={reviewRequest} />));
    expect(element.textContent).toContain('request is unavailable'); expect(button('Allow connection')).toBeUndefined(); expect(resolve).not.toHaveBeenCalled();
  });
  it('explains an invitation without an available method and does not submit a request', async () => {
    const { api, controller } = setup({ entries: async () => [] });
    await act(async () => root!.render(<DeviceAuthorizationEntry controller={controller} t={t} defaultName="Laptop" initialInvitation={link} />));
    expect(element.textContent).toContain('no connection method available');
    expect(button('Request connection').disabled).toBe(true);
    await act(async () => button('Request connection').click()); expect(api.start).not.toHaveBeenCalled();
  });
  it('resolves an explicitly selected knock without implicitly requesting or approving access', async () => {
    const resolveTarget = vi.fn(async () => link), { api, controller } = setup({ resolveTarget });
    const target = formatDeviceTarget(parseDeviceInvitation(link));
    await act(async () => root!.render(<DeviceAuthorizationEntry controller={controller} t={t} defaultName="Laptop" initialInvitation={target} />));
    expect(resolveTarget).not.toHaveBeenCalled(); expect(button('Request connection')).toBeUndefined();
    await act(async () => element.querySelectorAll<HTMLButtonElement>('.connection-method')[1]!.click());
    await act(async () => button('Continue').click());
    expect(resolveTarget).toHaveBeenCalledWith(target, undefined, expect.any(AbortSignal));
    expect(api.start).not.toHaveBeenCalled(); expect(api.finish).not.toHaveBeenCalled();
    await act(async () => button('Request connection').click()); expect(api.start).toHaveBeenCalledOnce();
  });
  it('keeps approval actionable during a background refresh and ignores the late old list', async () => {
    setup({}); vi.useFakeTimers();
    try {
      let finishPoll: ((rows: DeviceAuthorizationProgress[]) => void) | undefined, calls = 0;
      const approved = { ...progress, state: 'approved' as const };
      const list = async () => ++calls === 2 ? new Promise<DeviceAuthorizationProgress[]>(resolve => { finishPoll = resolve; }) : [calls > 2 ? approved : progress];
      const resolve = vi.fn(async () => approved);
      const controller = { state: { activeProfile: { id: 'owner' }, connectionGeneration: 1 }, deviceAuthorizationOwner: () => ({ list, resolve }) } as unknown as AppController;
      await act(async () => root!.render(<DeviceAuthorizationSettings controller={controller} t={t} />));
      await act(async () => button('Review request').click());
      await act(async () => { vi.advanceTimersByTime(3000); });
      expect(finishPoll).toBeDefined();
      await act(async () => button('Allow connection').click()); expect(resolve).toHaveBeenCalledOnce();
      await act(async () => finishPoll!([progress]));
      expect(button('Allow connection')).toBeUndefined(); expect(button('Cancel request')).toBeDefined();
    } finally { vi.useRealTimers(); }
  });
  it('starts with connection choices, focuses the selected input, and returns without dispatching', async () => {
    const { api, controller } = setup({});
    await act(async () => root!.render(<DeviceAuthorizationEntry controller={controller} t={t} defaultName="Laptop" />));
    expect(element.querySelector('textarea')).toBeNull(); expect(element.querySelector('input')).toBeNull();
    await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Use an invitation link"]')!.click());
    expect(document.activeElement).toBe(element.querySelector('textarea'));
    expect(element.querySelector<HTMLDetailsElement>('.device-authorization__name')!.open).toBe(false);
    await act(async () => button('Back to connection methods').click());
    expect(element.querySelector('textarea')).toBeNull(); expect(api.start).not.toHaveBeenCalled();
  });
  it('keeps paste available after a scanner failure without offering to forget a request that was never made', async () => {
    const { api, controller } = setup({});
    Object.assign(controller, { scanDeviceInvitation: vi.fn(async () => { throw new Error('Permission denied'); }) });
    await act(async () => root!.render(<DeviceAuthorizationEntry controller={controller} t={t} defaultName="Phone" />));
    await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Scan invitation QR code"]')!.click());
    expect(element.textContent).toContain('Paste the invitation link instead');
    expect(button('Forget local request')).toBeUndefined(); expect(api.start).not.toHaveBeenCalled();
    await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Use an invitation link"]')!.click());
    expect(element.querySelector('textarea')).not.toBeNull();
  });
  it('previews a link without dispatching, then starts only once with explicit confirmation', async () => {
    const { api, controller } = setup({});
    await act(async () => root!.render(<DeviceAuthorizationEntry controller={controller} t={t} defaultName="My laptop" initialInvitation={link} />));
    expect(api.start).not.toHaveBeenCalled(); expect(element.textContent).toContain('https://node.example');
    await act(async () => { button('Request connection').click(); button('Request connection').click(); });
    expect(api.start).toHaveBeenCalledOnce(); expect(api.start).toHaveBeenCalledWith(link, 'My laptop', expect.any(AbortSignal), undefined);
    expect(element.textContent).toContain('ABCD-EFGH'); expect(api.finish).not.toHaveBeenCalled();
  });
  it('retains approved identity after a save failure and retries the original request with the automatic-entry choice', async () => {
    const finish = vi.fn().mockRejectedValueOnce(new Error('Protected storage unavailable')).mockResolvedValue(undefined);
    const refresh = vi.fn(async () => ({ ...progress, state: 'approved' as const }));
    const { api, controller } = setup({ refresh, finish });
    await act(async () => root!.render(<DeviceAuthorizationEntry controller={controller} t={t} defaultName="Laptop" automatic />));
    expect(element.textContent).toContain('saving or connecting did not finish'); expect(element.textContent).toContain('ABCD-EFGH');
    await act(async () => button('Retry this request').click());
    expect(refresh).toHaveBeenCalledTimes(2); expect(finish).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenLastCalledWith(expect.any(AbortSignal), true); expect(api.start).not.toHaveBeenCalled();
  });
  it('keeps a pending request after uncertain cancellation and aborts work when its page closes', async () => {
    const cancel = vi.fn(async () => { throw new Error('Disconnected'); });
    const refresh = vi.fn(async () => progress);
    const { api, controller } = setup({ refresh, cancel });
    await act(async () => root!.render(<DeviceAuthorizationEntry controller={controller} t={t} defaultName="Laptop" />));
    await act(async () => button('Cancel request').click());
    expect(element.textContent).toContain('ABCD-EFGH'); expect(element.textContent).toContain('Retry this same request');
    expect(api.discard).not.toHaveBeenCalled();
    const signal = (cancel.mock.calls[0] as unknown as [AbortSignal])[0];
    await act(async () => root!.unmount()); root = undefined;
    expect(signal.aborted).toBe(true);
  });
  it('requires review of the selected exact device before approval and permits cancelling an unclaimed approval', async () => {
    setup({});
    let rows = [progress, { ...progress, invitationId: '33333333-3333-4333-8333-333333333333', requestId: '44444444-4444-4444-8444-444444444444', deviceName: 'Other laptop', userCode: 'JKLM-NPQR' }];
    const resolve = vi.fn(async (invitationId: string, _requestId: string, state: 'approved' | 'denied' | 'cancelled') => {
      rows = rows.map(row => row.invitationId === invitationId ? { ...row, state } : row); return rows.find(row => row.invitationId === invitationId)!;
    });
    const controller = { state: { activeProfile: { id: 'owner', name: 'Node', origin: progress.origin }, connectionGeneration: 1 },
      deviceAuthorizationOwner: () => ({ list: async () => rows, resolve }) } as unknown as AppController;
    await act(async () => root!.render(<DeviceAuthorizationSettings controller={controller} t={t} />));
    expect(button('Allow connection')).toBeUndefined();
    await act(async () => button('Review request').click());
    expect(element.textContent).toContain('ABCD-EFGH'); expect(element.textContent).not.toContain('JKLM-NPQR');
    expect(resolve).not.toHaveBeenCalled();
    await act(async () => button('Allow connection').click());
    expect(resolve).toHaveBeenCalledWith(progress.invitationId, progress.requestId, 'approved');
    await act(async () => button('Cancel request').click());
    expect(resolve).toHaveBeenLastCalledWith(progress.invitationId, progress.requestId, 'cancelled');
  });
  it('requires a separate explicit confirmation to abandon an unreachable request', async () => {
    const { api, controller } = setup({ refresh: vi.fn(async () => { throw new Error('Node unreachable'); }) });
    await act(async () => root!.render(<DeviceAuthorizationEntry controller={controller} t={t} defaultName="Laptop" />));
    await act(async () => button('Forget local request').click());
    expect(api.discard).not.toHaveBeenCalled(); expect(element.textContent).toContain('does not cancel the request');
    await act(async () => button('Forget local request').click());
    expect(api.discard).toHaveBeenCalledWith(true);
  });
  it('can cancel an unused invitation after reopening without retaining its secret', async () => {
    setup({});
    let rows = [{ ...progress, state: 'invited' as const, requestId: '', userCode: '', deviceName: '' }];
    const resolve = vi.fn(async () => { rows = []; return { ...progress, state: 'cancelled' as const }; });
    const controller = { state: { activeProfile: { id: 'owner' }, connectionGeneration: 1 },
      deviceAuthorizationOwner: () => ({ list: async () => rows, resolve }) } as unknown as AppController;
    await act(async () => root!.render(<DeviceAuthorizationSettings controller={controller} t={t} />));
    expect(element.textContent).toContain('Unused invitation'); expect(button('Review request')).toBeUndefined();
    await act(async () => button('Cancel invitation').click());
    expect(resolve).toHaveBeenCalledExactlyOnceWith(progress.invitationId, '', 'cancelled');
    expect(element.textContent).not.toContain('Unused invitation');
  });
});

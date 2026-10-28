// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from '@bufbuild/protobuf';
import { GetMessagingSettingsResponseSchema, ListPartnerMessagingLanesResponseSchema, PartnerMessagingLaneKind,
  PartnerMessagingRestartPhase, PartnerMessagingRestartSchema, SetPartnerMessagingBindingResponseSchema,
  type PartnerMessagingApi, type SetPartnerMessagingBindingResponse } from '@joko/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppController } from '../controller.js';
import type { PartnerProfileView } from '../model.js';
import { PartnerMessagingPanel } from './PartnerMessagingPanel.js';

let root: Root | undefined;
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function button(label: string, scope: ParentNode = document) { const value = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(row => row.textContent === label); expect(value).toBeDefined(); return value!; }
async function fixture(bound = false, options: {
  readonly connectionState?: AppController['state']['connectionState'];
  readonly createApi?: (api: PartnerMessagingApi) => PartnerMessagingApi;
} = {}) {
  const profile = { id: 'partner', displayName: 'Ada', lifecycle: 'active', initializationState: 'ready', canonicalSessionId: 'canonical', revision: 5n } as PartnerProfileView;
  const connection = { connectionId: 'channel', revision: { value: 2n }, generation: 3n };
  const binding = { connectionId: 'channel', revision: bound ? 1n : 0n, connectionGeneration: 3n, ...(bound ? { partnerId: 'partner' } : {}) };
  const settings = create(GetMessagingSettingsResponseSchema, { connections: [connection], partnerBindings: [binding] });
  const restarted = create(PartnerMessagingRestartSchema, { operationId: 'original-operation', connectionId: 'channel', conversationId: 'topic', sessionId: 'lane', sourceGeneration: 1n, phase: PartnerMessagingRestartPhase.READY });
  let first = true;
  const api: PartnerMessagingApi = { ownerKey: 'source', newOperationId: vi.fn(() => 'original-operation'), settings: vi.fn(async () => settings),
    save: vi.fn(async () => { if (first) { first = false; throw new Error('Lost save reply'); } return create(SetPartnerMessagingBindingResponseSchema,
      { connection: { ...connection, generation: 4n }, binding: { ...binding, partnerId: 'partner', revision: 1n, connectionGeneration: 4n } }); }),
    lanes: vi.fn(async () => create(ListPartnerMessagingLanesResponseSchema, { binding,
      lanes: [{ conversationId: 'topic', sessionId: 'lane', generation: 1n, title: 'Original topic', kind: PartnerMessagingLaneKind.TOPIC, canRestart: true }] })),
    restart: vi.fn(async () => { throw new Error('Lost restart reply'); }),
    lookup: vi.fn(async () => ({ ...restarted, phase: PartnerMessagingRestartPhase.CLOSING })), retry: vi.fn(async () => restarted) };
  const createApi = vi.fn((_ownerKey: string) => options.createApi ? options.createApi(api) : api);
  const controller = { state: { ready: true, connectionState: options.connectionState ?? 'connected', connectionGeneration: 1, effectiveLocale: 'en' }, partnerMessagingApi: createApi,
    listPartners: async () => ({ partners: [profile] }) } as unknown as AppController;
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<PartnerMessagingPanel controller={controller} ownerKey="source" connectionId="channel" />); });
  return { api, host, controller, createApi };
}
describe('Partner channel settings', () => {
  it.each(['connecting', 'reconnecting', 'offline'] as const)('waits for the cached source to connect before creating an API while %s', async connectionState => {
    const f = await fixture(false, { connectionState });
    expect(f.createApi).not.toHaveBeenCalled(); expect(f.api.settings).not.toHaveBeenCalled();
    expect(f.host.querySelector('select,[role="alert"]')).toBeNull();
    const connected: AppController = { ...f.controller, state: { ...f.controller.state, connectionState: 'connected' } };
    await act(async () => { root!.render(<PartnerMessagingPanel controller={connected} ownerKey="source" connectionId="channel" />); });
    expect(f.createApi).toHaveBeenCalledOnce(); expect(f.createApi).toHaveBeenCalledWith('source');
    expect(f.api.settings).toHaveBeenCalledOnce(); expect(f.host.querySelector('select')).not.toBeNull();
  });
  it('shows a connected API creation failure and retries it explicitly', async () => {
    let available = false;
    const f = await fixture(false, { createApi: api => { if (!available) throw new Error('The connected channel transport is unavailable.'); return api; } });
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('Could not read message platforms. Refresh to retry.');
    expect(f.api.settings).not.toHaveBeenCalled(); expect(f.host.querySelector('select')).toBeNull();
    available = true;
    await act(async () => button('Refresh').click());
    expect(f.createApi).toHaveBeenCalledTimes(2); expect(f.api.settings).toHaveBeenCalledOnce();
    expect(f.host.querySelector('[role="alert"]')).toBeNull(); expect(f.host.querySelector('select')).not.toBeNull();
  });
  it('retains the exact binding destination, revisions and operation after a lost save reply', async () => {
    const f = await fixture(), select = f.host.querySelector('select')!;
    await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!; setter.call(select, 'partner'); select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => button('Save').click()); expect(f.api.save).toHaveBeenCalledOnce(); expect(select.disabled).toBe(true);
    await act(async () => button('Retry original operation').click()); expect(f.api.save).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.api.save).mock.calls[0]![0]).toEqual(vi.mocked(f.api.save).mock.calls[1]![0]);
    expect(vi.mocked(f.api.save).mock.calls[0]![0]).toMatchObject({ operationId: 'original-operation', expectedConnectionGeneration: 3n,
      expectedBindingRevision: 0n, expectedPartnerRevision: { value: 5n }, destination: { case: 'partnerId', value: 'partner' } });
  });
  it('confirms a lane close and queries the original restart before explicit retry', async () => {
    const f = await fixture(true); await act(async () => button('View conversations').click());
    await act(async () => button('Restart context').click()); expect(f.api.restart).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"],[role="alertdialog"]')!;
    await act(async () => button('Restart context', dialog).click()); expect(f.api.restart).toHaveBeenCalledOnce();
    await act(async () => button('Retry original operation').click());
    expect(f.api.lookup).toHaveBeenCalledWith('original-operation', expect.any(AbortSignal));
    expect(f.api.retry).toHaveBeenCalledWith('original-operation', expect.any(AbortSignal)); expect(f.api.restart).toHaveBeenCalledOnce();
  });
  it('uses the new connection after reconnect while retaining the original unknown binding operation', async () => {
    const f = await fixture(), select = f.host.querySelector('select')!;
    await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!; setter.call(select, 'partner'); select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => button('Save').click());
    const original = vi.mocked(f.api.save).mock.calls[0]![0], nextApi = { ...f.api, save: vi.fn(async () => create(SetPartnerMessagingBindingResponseSchema)) };
    const unavailableApi = vi.fn(() => { throw new Error('The source gateway is reconnecting.'); });
    const reconnecting: AppController = { ...f.controller, state: { ...f.controller.state, connectionState: 'reconnecting', connectionGeneration: 2 }, partnerMessagingApi: unavailableApi };
    await act(async () => { root!.render(<PartnerMessagingPanel controller={reconnecting} ownerKey="source" connectionId="channel" />); });
    expect(unavailableApi).not.toHaveBeenCalled(); expect(f.host.querySelector('select,[role="alert"]')).toBeNull();
    const nextController = { ...f.controller, state: { ...f.controller.state, connectionGeneration: 2 }, partnerMessagingApi: () => nextApi } as unknown as AppController;
    await act(async () => { root!.render(<PartnerMessagingPanel controller={nextController} ownerKey="source" connectionId="channel" />); });
    expect(nextApi.save).not.toHaveBeenCalled();
    await act(async () => button('Retry original operation').click());
    expect(nextApi.save).toHaveBeenCalledWith(original, expect.any(AbortSignal)); expect(f.api.save).toHaveBeenCalledOnce();
  });
  it('aborts the old flight and ignores its late receipt without clearing the unknown operation after reconnect', async () => {
    const f = await fixture(), select = f.host.querySelector('select')!;
    let complete: ((value: SetPartnerMessagingBindingResponse) => void) | undefined, saveSignal: AbortSignal | undefined;
    vi.mocked(f.api.save).mockImplementationOnce((_request, signal) => {
      saveSignal = signal; return new Promise<SetPartnerMessagingBindingResponse>(resolve => { complete = resolve; });
    });
    await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!; setter.call(select, 'partner'); select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => button('Save').click());
    const original = vi.mocked(f.api.save).mock.calls[0]![0];
    const reconnecting: AppController = { ...f.controller, state: { ...f.controller.state, connectionState: 'reconnecting' } };
    await act(async () => { root!.render(<PartnerMessagingPanel controller={reconnecting} ownerKey="source" connectionId="channel" />); });
    expect(saveSignal?.aborted).toBe(true);
    const response = create(SetPartnerMessagingBindingResponseSchema, {
      connection: { connectionId: 'channel', generation: 4n }, binding: { connectionId: 'channel', partnerId: 'partner', revision: 1n, connectionGeneration: 4n }
    });
    const nextApi: PartnerMessagingApi = { ...f.api, save: vi.fn(async () => response) };
    const connected: AppController = { ...f.controller, partnerMessagingApi: () => nextApi };
    await act(async () => { root!.render(<PartnerMessagingPanel controller={connected} ownerKey="source" connectionId="channel" />); });
    await act(async () => complete!(response));
    expect(f.host.querySelector('select')?.disabled).toBe(true); expect(nextApi.save).not.toHaveBeenCalled();
    await act(async () => button('Retry original operation').click());
    expect(nextApi.save).toHaveBeenCalledWith(original, expect.any(AbortSignal));
    expect(f.api.newOperationId).toHaveBeenCalledOnce(); expect(f.api.save).toHaveBeenCalledOnce();
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from '@bufbuild/protobuf';
import { GetMessagingSettingsResponseSchema, ListPartnerMessagingLanesResponseSchema, PartnerMessagingLaneKind,
  PartnerMessagingRestartPhase, PartnerMessagingRestartSchema, SetPartnerMessagingBindingResponseSchema, type PartnerMessagingApi } from '@joko/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppController } from '../controller.js';
import type { PartnerProfileView } from '../model.js';
import { PartnerMessagingPanel } from './PartnerMessagingPanel.js';

let root: Root | undefined;
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function button(label: string, scope: ParentNode = document) { const value = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(row => row.textContent === label); expect(value).toBeDefined(); return value!; }
async function fixture(bound = false) {
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
  const controller = { state: { effectiveLocale: 'en' }, partnerMessagingApi: () => api,
    listPartners: async () => ({ partners: [profile] }) } as unknown as AppController;
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<PartnerMessagingPanel controller={controller} ownerKey="source" connectionId="channel" />); });
  return { api, host };
}
describe('Partner channel settings', () => {
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
});

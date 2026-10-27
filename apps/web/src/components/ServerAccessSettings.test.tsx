// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create } from '@bufbuild/protobuf';
import { GetServerAccessSettingsResponseSchema, ServerAccessEntrySchema } from '@joko/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import type { ServerAccessClient } from '@joko/connection-transport/server-access';
import type { AppController } from '../controller.js';
import { translate } from '../i18n.js';
import { ServerAccessSettings } from './ServerAccessSettings.js';

let root: Root | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); });
const click = async (container: HTMLElement, name: string) => { await act(async () => {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === name); expect(button).toBeTruthy(); button!.click();
}); };
async function mount(api: ServerAccessClient) {
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const controller = { state: { activeProfile: { id: 'owner' }, connectionGeneration: 1 }, serverAccess: () => api } as unknown as AppController;
  await act(async () => root!.render(<ServerAccessSettings controller={controller} t={(key, values) => translate('en', key, values)} />));
  return container;
}

it('keeps configured secrets absent from editing and preserves a draft after a failed save', async () => {
  const entry = create(ServerAccessEntrySchema, { entryId: 'home', name: 'Private relay', provider: 'iroh', mode: 'relay', revision: 'r1', source: 'gui', state: 'saved', configuredSecrets: ['servicesApiSecret'], fields: { relayUrls: 'https://relay.example' } });
  const read = vi.fn(async (requestId?: string) => create(GetServerAccessSettingsResponseSchema, { entries: [entry], operationState: requestId ? 'failed' : '' }));
  const save = vi.fn<ServerAccessClient['save']>(async () => { throw new Error('save_failed'); });
  const container = await mount({ read, save, change: vi.fn() });
  await click(container, 'Edit');
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0]?.[0]).not.toHaveProperty('fields.servicesApiSecret');
  expect(container.querySelector('form')).toBeTruthy(); expect(container.textContent).toContain('configuration was not saved');
});

it('requires an alternate trusted route confirmation before stopping an active entry', async () => {
  const entry = create(ServerAccessEntrySchema, { entryId: 'home', name: 'Private relay', provider: 'iroh', mode: 'relay', revision: 'r1', source: 'gui', state: 'active', enabled: true });
  const change = vi.fn(async () => {}), read = async (requestId?: string) => create(GetServerAccessSettingsResponseSchema, { entries: [entry], operationState: requestId ? 'completed' : '' });
  const container = await mount({ read, save: vi.fn(), change });
  await click(container, 'Stop');
  const confirm = [...container.querySelectorAll('button')].find(button => button.textContent === 'Confirm')!;
  expect(confirm.disabled).toBe(true); expect(change).not.toHaveBeenCalled();
  await act(async () => (container.querySelector('[role="checkbox"]') as HTMLElement).click());
  await click(container, 'Confirm');
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ action: 'stop', expectedRevision: 'r1', confirmDisconnection: true }));
});

it('accepts an enable action during background refresh and ignores the late stale response', async () => {
  vi.useFakeTimers();
  try {
    let entry = create(ServerAccessEntrySchema, { entryId: 'media', name: 'coturn', provider: 'coturn', mode: 'turn', revision: 'r1', source: 'gui', state: 'saved' });
    const read = vi.fn(async (id?: string) => create(GetServerAccessSettingsResponseSchema, { entries: [entry], operationState: id ? 'completed' : '' }));
    const change = vi.fn(async () => { entry = create(ServerAccessEntrySchema, { ...entry, state: 'active', enabled: true }); });
    const container = await mount({ read, save: vi.fn(), change });
    const stale = create(GetServerAccessSettingsResponseSchema, { entries: [entry] });
    let finish!: (value: typeof stale) => void;
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { vi.advanceTimersByTime(3000); });
    await click(container, 'Check and enable');
    expect(change).toHaveBeenCalledOnce(); expect(container.textContent).toContain('Enabled');
    await act(async () => { finish(stale); });
    expect(container.textContent).toContain('Enabled'); expect(container.textContent).not.toContain('Saved · not enabled');
  } finally { await act(async () => root?.unmount()); root = undefined; vi.useRealTimers(); }
});

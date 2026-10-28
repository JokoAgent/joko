// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { ControlDesktopVoiceConversationRequestSchema, ControlDesktopVoiceConversationResponseSchema, DesktopVoiceConversationAction as Action,
  DesktopVoiceConversationPreferenceSchema, type ControlDesktopVoiceConversationRequest } from '@joko/contracts';
import { expect, it, vi } from 'vitest';
import type { AppController } from '../controller.js';
import type { SessionView } from '../model.js';
import { DesktopVoiceConversationPanel } from './DesktopVoiceConversation.js';

it('keeps the original save operation after a lost reply and restores focus when its owning panel closes', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const before = Object.getOwnPropertyDescriptor(window, 'jokoDesktop');
  const saved: ControlDesktopVoiceConversationRequest[] = [];
  let preference = create(DesktopVoiceConversationPreferenceSchema, { revision: 0n, sentencePlayback: true,
    conversation: { backendId: 'backend', providerId: 'provider', modelId: 'tts-1', protocol: 'openai', voice: 'alloy' },
    playback: { backendId: 'backend', providerId: 'provider', modelId: 'tts-1', protocol: 'openai', voice: 'nova' } });
  Object.defineProperty(window, 'jokoDesktop', { configurable: true, value: { voiceConversation: { control: vi.fn(async (_serverId: string, bytes: Uint8Array) => {
    const request = fromBinary(ControlDesktopVoiceConversationRequestSchema, bytes);
    if (request.action === Action.SAVE_PREFERENCE) {
      saved.push(request); preference = create(DesktopVoiceConversationPreferenceSchema, { ...request.preference, revision: 1n });
      if (saved.length === 1) throw new Error('Reply lost after saving.');
    }
    return toBinary(ControlDesktopVoiceConversationResponseSchema, create(ControlDesktopVoiceConversationResponseSchema, { preference,
      models: [{ backendId: 'backend', providerId: 'provider', modelId: 'tts-1', displayName: 'Speech', providerName: 'My BYOK', protocol: 'openai', protocolLocked: true }] }));
  }) } } });
  const trigger = document.createElement('button'); trigger.textContent = 'Open'; document.body.append(trigger); trigger.focus();
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const controller = { state: { effectiveLocale: 'en' } } as unknown as AppController;
  const session = { id: 'task', generation: 1n, name: 'My task' } as SessionView;
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label)!;
  try {
    await act(async () => root.render(<DesktopVoiceConversationPanel controller={controller} session={session} serverId="node" onClose={() => {}} />));
    await act(async () => button('Speech settings').click());
    expect(document.querySelectorAll('fieldset')).toHaveLength(2);
    expect([...document.querySelectorAll<HTMLInputElement>('fieldset input')].some(value => value.value === 'nova')).toBe(true);
    await act(async () => button('Save voice settings').click());
    await act(async () => button('Save voice settings').click());
    expect(saved).toHaveLength(2); expect(saved[1]?.operationId).toBe(saved[0]?.operationId);
    expect(saved[1]?.preference?.revision).toBe(0n); expect(saved[1]?.preference?.playback?.voice).toBe('nova');
    await act(async () => root.unmount());
    expect(document.activeElement).toBe(trigger);
  } finally {
    await act(async () => root.unmount()); container.remove(); trigger.remove();
    if (before) Object.defineProperty(window, 'jokoDesktop', before); else delete (window as { jokoDesktop?: unknown }).jokoDesktop;
  }
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { ControlDesktopVoiceConversationRequestSchema, ControlDesktopVoiceConversationResponseSchema, DesktopVoiceConversationAction as Action,
  DesktopVoiceConversationPreferenceSchema, type ControlDesktopVoiceConversationRequest } from '@joko/contracts';
import { expect, it, vi } from 'vitest';
import type { AppController } from '../controller.js';
import type { SessionView } from '../model.js';
import { WebAudioVoicePcmCapture } from '../voice-input-pcm.js';
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
      if (!request.preference) throw new Error('Missing original voice preference.');
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

it.each(['button', 'speech start'])('reports audible PCM on %s interruption and releases the original two-way call on window loss', async trigger => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const desktop = Object.getOwnPropertyDescriptor(window, 'jokoDesktop');
  const devices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const track = { enabled: true, addEventListener: vi.fn(), stop: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const getUserMedia = vi.fn(async () => stream);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  const decoded = new Float32Array(2400), pcm = new Uint8Array(4800);
  pcm.set([0, 64]);
  let audioTime = 0;
  const allocateBuffer = vi.fn((_channels: number, length: number, rate: number) =>
    ({ duration: length / rate, getChannelData: () => decoded }));
  const output = { start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn() };
  vi.stubGlobal('AudioContext', class {
    state = 'running'; get currentTime() { return audioTime; } destination = {};
    createBuffer = allocateBuffer;
    createBufferSource() { return output; }
    async resume() {}
    async close() {}
  });
  const capture = vi.spyOn(WebAudioVoicePcmCapture.prototype, 'start').mockImplementation(async (_stream, publish) => {
    publish({ audio: Uint8Array.of(42, 0), voiced: true, durationMs: 1 });
  });
  const selection = { backendId: 'pi', providerId: 'my-key', modelId: 'gpt-realtime', protocol: 'openai-realtime', voice: 'marin' };
  const preference = create(DesktopVoiceConversationPreferenceSchema, { realtime: selection, revision: 1n });
  const requests: ControlDesktopVoiceConversationRequest[] = [];
  let callId = '', release = () => {}, finishRead = () => {};
  const detach = vi.fn();
  Object.defineProperty(window, 'jokoDesktop', { configurable: true, value: {
    microphone: { onRelease: (listener: () => void) => { release = listener; return detach; } },
    voiceConversation: { control: async (node: string, bytes: Uint8Array) => {
      expect(node).toBe('original');
      const request = fromBinary(ControlDesktopVoiceConversationRequestSchema, bytes); requests.push(request);
      if (request.action === Action.START) callId = request.callId;
      if (request.action === Action.END) { callId = ''; finishRead(); }
      const firstAudio = request.action === Action.REALTIME_READ && request.audioSequence === 1n;
      if (request.action === Action.REALTIME_READ && !firstAudio) await new Promise<void>(resolve => { finishRead = resolve; });
      const speechStarted = trigger === 'speech start' && request.action === Action.REALTIME_READ && request.audioSequence === 2n;
      return toBinary(ControlDesktopVoiceConversationResponseSchema, create(ControlDesktopVoiceConversationResponseSchema, {
        preference, realtimeModels: [{ ...selection, protocolLocked: true, displayName: 'Realtime', providerName: 'My key' }],
        ...(callId ? { call: { callId, kind: 'realtime' } } : {}), audioSequence: request.audioSequence,
        ...(firstAudio ? { pcm, realtimePlayback: { itemId: 'speaking', contentIndex: 1, sampleOffset: 4800 } } : {}),
        ...(speechStarted ? { audioInterrupted: true, interruptThroughResponse: 1 } : {}), sampleRate: 24_000, accepted: true
      }));
    } }
  } });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const button = (label: string) => {
    const controls = document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-label="Voice conversation"] button');
    const match = [...controls].find(row => row.textContent === label);
    expect(match, label).toBeDefined();
    return match!;
  };
  try {
    await act(async () => root.render(<DesktopVoiceConversationPanel controller={{ state: { effectiveLocale: 'en' } } as unknown as AppController}
      session={{ id: 'owner-task', generation: 4n, name: 'Partner' } as SessionView} serverId="original" onClose={() => {}} />));
    await act(async () => button('Start call').click());
    expect(getUserMedia).toHaveBeenCalledOnce(); expect(capture).toHaveBeenCalledOnce();
    const input = requests.find(row => row.action === Action.REALTIME_INPUT)!;
    expect(input).toMatchObject({ callId, sessionId: 'owner-task', sessionGeneration: 4n, audioSequence: 1n });
    expect(Array.from(input.microphonePcm)).toEqual([42, 0]);
    expect(allocateBuffer).toHaveBeenCalledWith(1, 2400, 24_000);
    expect(decoded[0]).toBe(0.5); expect(output.start).toHaveBeenCalledOnce();
    await act(async () => button('Mute microphone').click()); expect(track.enabled).toBe(false);
    audioTime = 0.05;
    if (trigger === 'button') await act(async () => button('Interrupt reply').click());
    else await act(async () => finishRead());
    expect(output.stop).toHaveBeenCalledOnce();
    expect(requests.find(row => row.action === Action.INTERRUPT)).toMatchObject({ callId: input.callId,
      realtimePlayback: { itemId: 'speaking', contentIndex: 1, sampleOffset: 6000 } });
    expect(requests.find(row => row.action === Action.INTERRUPT)?.interruptThroughResponse).toBe(trigger === 'button' ? undefined : 1);
    await act(async () => release());
    expect(track.stop).toHaveBeenCalledOnce(); expect(detach).toHaveBeenCalledOnce();
    expect(requests.find(row => row.action === Action.END)?.callId).toBe(input.callId);
  } finally {
    await act(async () => root.unmount()); container.remove(); capture.mockRestore(); vi.unstubAllGlobals();
    if (desktop) Object.defineProperty(window, 'jokoDesktop', desktop); else delete (window as { jokoDesktop?: unknown }).jokoDesktop;
    if (devices) Object.defineProperty(navigator, 'mediaDevices', devices); else Reflect.deleteProperty(navigator, 'mediaDevices');
  }
});

it.each([
  ['protocol default', undefined, 3],
  ['unsupported route', { case: 'speedUnsupported', value: true }, undefined],
  ['verified range', { case: 'speedRange', value: { min: 0.5, max: 2 } }, 2],
] as const)('uses the %s for controls, voice discovery, preview and saved selections', async (_label, speedSupport, expectedSpeed) => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const before = Object.getOwnPropertyDescriptor(window, 'jokoDesktop');
  const requests: ControlDesktopVoiceConversationRequest[] = [];
  let preference = create(DesktopVoiceConversationPreferenceSchema, { revision: 0n, sentencePlayback: true,
    conversation: { backendId: 'backend', providerId: 'provider', modelId: 'tts-1', protocol: 'openai', voice: 'alloy', speed: 3 },
    playback: { backendId: 'backend', providerId: 'provider', modelId: 'tts-1', protocol: 'openai', voice: 'nova', speed: 3 } });
  Object.defineProperty(window, 'jokoDesktop', { configurable: true, value: { voiceConversation: { control: vi.fn(async (_serverId: string, bytes: Uint8Array) => {
    const request = fromBinary(ControlDesktopVoiceConversationRequestSchema, bytes);
    requests.push(request);
    if (request.action === Action.START) throw new Error('The controlled preview stops before capturing audio.');
    if (request.action === Action.SAVE_PREFERENCE) preference = create(DesktopVoiceConversationPreferenceSchema, { ...request.preference!, revision: 1n });
    return toBinary(ControlDesktopVoiceConversationResponseSchema, create(ControlDesktopVoiceConversationResponseSchema, { preference,
      models: [{ backendId: 'backend', providerId: 'provider', modelId: 'tts-1', displayName: 'Speech', providerName: 'My BYOK', protocol: 'openai',
        protocolLocked: true, ...(speedSupport ? { speedSupport } : {}) }], voices: { source: 'provider', voices: [] } }));
  }) } } });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const controller = { state: { effectiveLocale: 'en' } } as unknown as AppController;
  const session = { id: 'task', generation: 1n, name: 'My task' } as SessionView;
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label)!;
  try {
    await act(async () => root.render(<DesktopVoiceConversationPanel controller={controller} session={session} serverId="node" onClose={() => {}} />));
    await act(async () => button('Speech settings').click());
    const speeds = [...document.querySelectorAll<HTMLInputElement>('fieldset input[type="number"]')];
    expect(speeds).toHaveLength(expectedSpeed === undefined ? 0 : 2);
    if (expectedSpeed !== undefined) {
      expect(speeds[0]!.value).toBe(String(expectedSpeed));
      expect(speeds[0]!.min).toBe(speedSupport ? '0.5' : '0.25');
      expect(speeds[0]!.max).toBe(speedSupport ? '2' : '4');
    }
    await act(async () => button('Load voices').click());
    expect(requests.find(request => request.action === Action.VOICES)?.selection?.speed).toBe(expectedSpeed);
    await act(async () => button('Preview voice').click());
    expect(requests.find(request => request.action === Action.START)?.selection?.speed).toBe(expectedSpeed);
    await act(async () => button('Save voice settings').click());
    const saved = requests.find(request => request.action === Action.SAVE_PREFERENCE);
    expect(saved).toBeDefined();
    expect(saved!.preference!.conversation!.speed).toBe(expectedSpeed);
    expect(saved!.preference!.playback!.speed).toBe(expectedSpeed);
  } finally {
    await act(async () => root.unmount()); container.remove();
    if (before) Object.defineProperty(window, 'jokoDesktop', before); else delete (window as { jokoDesktop?: unknown }).jokoDesktop;
  }
});

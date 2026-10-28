// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { ControlDesktopVoiceConversationRequestSchema, ControlDesktopVoiceConversationResponseSchema, DesktopVoiceCallRecordSchema, DesktopVoiceCallHandoffSchema,
  DesktopVoiceConversationAction as Action, type ControlDesktopVoiceConversationRequest, type DesktopVoiceCallRecord } from '@joko/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppController } from '../controller.js';
import type { SessionView } from '../model.js';
import { ContinuousVoiceListener, DesktopSpeechPlayer } from '../desktop-voice-conversation.js';
import { DesktopVoiceConversationPanel } from './DesktopVoiceConversation.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('cancels a farewell countdown on new speech and ends only the call after a fresh farewell', async () => {
  vi.useFakeTimers();
  const view = await mountCall();
  try {
    await view.start();
    await act(async () => { view.listener().options.onSpeech(); view.listener().options.onText('farewell-one', 'Goodbye!'); });
    expect(document.body.textContent).toContain('Call ends in 3');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); view.listener().options.onSpeech(); view.listener().options.onEmpty?.(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(view.requests.filter(row => row.action === Action.END)).toHaveLength(0);
    await act(async () => { view.listener().options.onSpeech(); view.listener().options.onText('farewell-two', '再见'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(view.requests.filter(row => row.action === Action.END)).toHaveLength(1);
    expect(view.requests.filter(row => row.action === Action.SUBMIT)).toHaveLength(0);
    expect(view.onClose).toHaveBeenCalledOnce();
  } finally { await view.dispose(); }
});

it('rechecks actual background task activity during the idle countdown', async () => {
  vi.useFakeTimers();
  const view = await mountCall();
  try {
    await view.start();
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(document.body.textContent).toContain('Call ends in');
    view.state.snapshot.backgroundTasks.push({ id: 'child', sessionId: 'task', state: 'running' });
    await view.render();
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    expect(view.requests.filter(row => row.action === Action.END)).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Call ends in');
  } finally { await view.dispose(); }
});

it('waits for the original handoff acceptance before semantic exit and never sends a racing interrupt', async () => {
  vi.useFakeTimers();
  let accept!: (call: DesktopVoiceCallRecord) => void;
  const view = await mountCall(request => request.action === Action.PROMOTE
    ? new Promise<DesktopVoiceCallRecord>(resolve => { accept = resolve; }) : undefined, 'submit_then_exit');
  try {
    await view.start();
    await act(async () => { view.listener().options.onSpeech(); view.listener().options.onText('work-input', 'Finish this work, then end our call.'); });
    expect(view.requests.filter(row => row.action === Action.PROMOTE)).toHaveLength(1);
    expect(view.requests.filter(row => row.action === Action.INTERRUPT)).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(view.requests.filter(row => row.action === Action.END)).toHaveLength(0);
    await act(async () => accept(create(DesktopVoiceCallRecordSchema, { ...view.call(), handoffs: [create(DesktopVoiceCallHandoffSchema, {
      id: 'handoff', inputId: 'work-input', text: 'Finish this work, then end our call.', state: 'accepted', runId: 'original-run', queueItemId: 'original-queue'
    })] })));
    expect(view.requests.filter(row => row.action === Action.END)).toHaveLength(1);
    expect(view.requests.filter(row => row.action === Action.SUBMIT)).toHaveLength(1);
    expect(view.onClose).toHaveBeenCalledOnce();
  } finally { await view.dispose(); }
});

async function mountCall(override?: (request: ControlDesktopVoiceConversationRequest) => Promise<DesktopVoiceCallRecord> | undefined, decision = 'continue') {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const before = Object.getOwnPropertyDescriptor(window, 'jokoDesktop');
  const requests: ControlDesktopVoiceConversationRequest[] = [];
  let active: DesktopVoiceCallRecord | undefined, capture: ContinuousVoiceListener | undefined;
  vi.spyOn(ContinuousVoiceListener.prototype, 'start').mockImplementation(async function (this: ContinuousVoiceListener) {
    capture = this; this.options.onState('listening');
  });
  vi.spyOn(ContinuousVoiceListener.prototype, 'stop').mockImplementation(() => undefined);
  vi.spyOn(DesktopSpeechPlayer.prototype, 'stop').mockImplementation(() => undefined);
  vi.spyOn(DesktopSpeechPlayer.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(DesktopSpeechPlayer.prototype, 'resume').mockImplementation(() => undefined);
  vi.spyOn(DesktopSpeechPlayer.prototype, 'play').mockResolvedValue();
  Object.defineProperty(window, 'jokoDesktop', { configurable: true, value: { voiceConversation: { control: async (_serverId: string, bytes: Uint8Array) => {
    const request = fromBinary(ControlDesktopVoiceConversationRequestSchema, bytes); requests.push(request);
    if (request.action === Action.START) active = create(DesktopVoiceCallRecordSchema, {
      callId: request.callId, sessionId: 'task', sessionGeneration: 1n, kind: 'conversation', startedAtMs: BigInt(Date.now())
    });
    const result = override?.(request);
    const responseCall = result ? await result : active;
    if (request.action === Action.END) active = undefined;
    return toBinary(ControlDesktopVoiceConversationResponseSchema, create(ControlDesktopVoiceConversationResponseSchema, {
      ...(request.action === Action.END ? {} : { call: responseCall }), accepted: true,
      exitDecision: request.action === Action.CLASSIFY_EXIT ? decision : '',
      preference: { conversation: { backendId: 'backend', providerId: 'provider', modelId: 'tts-1', protocol: 'openai', voice: 'alloy' }, sentencePlayback: true }
    }));
  } } } });
  const state = { effectiveLocale: 'en', snapshot: { interactions: [], queueControls: [], queue: [],
    backgroundTasks: [] as Array<{ id: string; sessionId: string; state: string }> } };
  const controller = { state } as unknown as AppController;
  const session = { id: 'task', generation: 1n, name: 'Partner task', state: 'idle' } as SessionView;
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container), onClose = vi.fn();
  const render = async () => { await act(async () => root.render(<DesktopVoiceConversationPanel controller={controller} session={session} serverId="node" onClose={onClose} />)); };
  await render();
  return { requests, state, onClose, render, call: () => active!, listener: () => capture!,
    start: async () => { await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Start call')!.click()); },
    dispose: async () => {
      await act(async () => root.unmount()); container.remove();
      if (before) Object.defineProperty(window, 'jokoDesktop', before); else delete (window as { jokoDesktop?: unknown }).jokoDesktop;
    } };
}

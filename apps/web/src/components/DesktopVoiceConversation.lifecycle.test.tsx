// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { ControlDesktopVoiceConversationRequestSchema, ControlDesktopVoiceConversationResponseSchema, DesktopVoiceCallRecordSchema, DesktopVoiceCallHandoffSchema, DesktopVoiceCallTurnSchema,
  DesktopVoiceConversationAction as Action, type ControlDesktopVoiceConversationRequest, type DesktopVoiceCallRecord } from '@joko/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppController } from '../controller.js';
import type { SessionView } from '../model.js';
import { ContinuousVoiceListener, DesktopSpeechPlayer } from '../desktop-voice-conversation.js';
import { DesktopVoiceConversationPanel } from './DesktopVoiceConversation.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['open', 'resolved'])('retires a pending START when permission is %s at its reply', async permission => {
  vi.useFakeTimers();
  let finish!: (call: DesktopVoiceCallRecord) => void;
  let first = true;
  const view = await mountCall(request => {
    if (request.action !== Action.START || !first) return undefined;
    first = false;
    return new Promise(resolve => { finish = resolve; });
  });
  try {
    await view.start();
    const original = view.call();
    expect(view.requests.filter(row => row.action === Action.START)).toHaveLength(1);
    view.state.snapshot.interactions.push({ sessionId: 'task', generation: 1n, kind: 'permission' });
    await view.render();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    if (permission === 'resolved') {
      view.state.snapshot.interactions.length = 0;
      await view.render();
    }
    await act(async () => finish(original));
    expect(ContinuousVoiceListener.prototype.start).not.toHaveBeenCalled();
    expect(view.requests.filter(row => row.action === Action.END)).toMatchObject([{ callId: original.callId }]);

    view.state.snapshot.interactions.length = 0;
    await view.render();
    await view.start();
    expect(ContinuousVoiceListener.prototype.start).toHaveBeenCalledOnce();
    expect(view.call().callId).not.toBe(original.callId);
  } finally { await view.dispose(); }
});

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

it('retains a read-aloud failure through healthy snapshots until an explicit new attempt', async () => {
  vi.useFakeTimers();
  const view = await mountCall();
  try {
    const player = vi.mocked(DesktopSpeechPlayer.prototype.play);
    player.mockRejectedValueOnce(new Error('Speech provider refused the original text.'));
    const original = 'Read this unchanged text aloud.';
    await view.readAloud(original);
    expect(player).toHaveBeenCalledTimes(1);
    expect(view.requests.some(request => request.action === Action.END)).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Read aloud failed.');
    const snapshots = view.requests.filter(request => request.action === Action.SNAPSHOT).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(view.requests.filter(request => request.action === Action.SNAPSHOT).length).toBeGreaterThan(snapshots);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Read aloud failed.');
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(original);
    expect(player).toHaveBeenCalledTimes(1);

    await view.readAloud();
    expect(player).toHaveBeenCalledTimes(2);
    expect(player.mock.calls.map(([, , , text]) => text)).toEqual([original, original]);
    const starts = view.requests.filter(request => request.action === Action.START);
    expect(starts).toHaveLength(2);
    expect(starts.every(request => request.playbackOnly && request.callId !== '')).toBe(true);
    expect(starts[0]!.callId).not.toBe(starts[1]!.callId);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  } finally { await view.dispose(); }
});

it('retires a pending playback when closing the panel and ignores its late Start reply', async () => {
  let complete!: (call: DesktopVoiceCallRecord) => void;
  let reportPrevious = false;
  let original: DesktopVoiceCallRecord;
  const view = await mountCall(request => {
    if (request.action === Action.START) return new Promise(resolve => { complete = resolve; });
    if (reportPrevious && request.action === Action.SNAPSHOT) return Promise.resolve(original);
    return undefined;
  });
  try {
    await view.readAloud('Close before playback starts.');
    original = view.call();
    const start = view.requests.find(request => request.action === Action.START)!;
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    await view.unmountPanel();
    expect(view.requests.filter(request => request.action === Action.END)).toMatchObject([{
      callId: start.callId, operationId: start.operationId, playbackOnly: true
    }]);
    await act(async () => complete(original));
    expect(DesktopSpeechPlayer.prototype.play).not.toHaveBeenCalled();
    reportPrevious = true;
    await view.render();
    expect([...document.querySelectorAll<HTMLButtonElement>('button')].some(button => button.textContent === 'End call')).toBe(false);
    expect([...document.querySelectorAll<HTMLButtonElement>('button')].some(button => button.textContent === 'Read aloud')).toBe(true);
  } finally { await view.dispose(); }
});

it('ends the original playback lease when stopping while its speech request is in flight', async () => {
  const view = await mountCall();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  vi.mocked(DesktopSpeechPlayer.prototype.play).mockImplementationOnce(() => pending);
  try {
    await view.readAloud('A single playback request.');
    const original = view.call();
    expect(original.kind).toBe('playback');
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Stop playback')!.click());
    expect(view.requests.filter(request => request.action === Action.END)).toMatchObject([{ callId: original.callId }]);
    expect(view.requests.filter(request => request.action === Action.INTERRUPT)).toHaveLength(0);
    await act(async () => finish());
    expect(view.requests.filter(request => request.action === Action.END)).toHaveLength(1);
  } finally { finish(); await view.dispose(); }
});

it('releases paused speech after the original microphone ends and keeps its draft for a new call', async () => {
  vi.useFakeTimers();
  const pcm = new Float32Array(1), scheduled = vi.fn();
  const audio = { currentTime: 0, state: 'suspended', destination: {},
    resume: vi.fn(async () => { audio.state = 'running'; }),
    suspend: vi.fn(async () => { audio.state = 'suspended'; }),
    close: vi.fn(async () => { audio.state = 'closed'; }),
    createBuffer: () => ({ getChannelData: () => pcm }), createBufferSource: () => ({ connect: vi.fn(), start: scheduled }) };
  vi.stubGlobal('AudioContext', function () { return audio; });
  let reply: DesktopVoiceCallRecord | undefined;
  const view = await mountCall(request => request.action === Action.SNAPSHOT && reply
    && (request.callId === reply.callId || request.callId === '') ? Promise.resolve(reply) : undefined);
  try {
    vi.mocked(DesktopSpeechPlayer.prototype.play).mockRestore();
    vi.mocked(DesktopSpeechPlayer.prototype.stop).mockRestore();
    vi.mocked(DesktopSpeechPlayer.prototype.pause).mockRestore();
    vi.mocked(DesktopSpeechPlayer.prototype.resume).mockRestore();
    await view.start();
    const original = view.call();
    reply = create(DesktopVoiceCallRecordSchema, { ...original, turns: [create(DesktopVoiceCallTurnSchema, { id: 'ordinary-reply', role: 'assistant', text: 'Keep this answer.', complete: true })] });
    await act(async () => { await vi.advanceTimersByTimeAsync(850); });
    expect(scheduled).toHaveBeenCalledOnce();
    expect(view.requests.filter(request => request.action === Action.READ_SPEECH)).toMatchObject([{ callId: original.callId }]);
    await act(async () => { view.listener().options.onSpeech(); });
    expect(audio.state).toBe('suspended');
    await act(async () => { view.listener().options.onFailure('Keep my unfinished words.', true); });
    expect(audio.close).toHaveBeenCalledOnce();
    expect(view.requests.filter(request => request.action === Action.END)).toMatchObject([{ callId: original.callId }]);

    const snapshots = view.requests.filter(request => request.action === Action.SNAPSHOT).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(view.requests.filter(request => request.action === Action.SNAPSHOT).length).toBeGreaterThan(snapshots);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('The microphone disconnected.');
    expect(scheduled).toHaveBeenCalledOnce();
    expect(view.requests.filter(request => request.action === Action.SUBMIT)).toEqual([]);
    expect(view.onClose).not.toHaveBeenCalled();
    await view.start();
    expect(view.call().callId).not.toBe(original.callId);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>('.desktop-voice-conversation__input textarea')?.value).toBe('Keep my unfinished words.');
  } finally { await view.dispose(); vi.unstubAllGlobals(); }
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
      callId: request.callId, sessionId: 'task', sessionGeneration: 1n, kind: request.playbackOnly ? 'playback' : 'conversation', startedAtMs: BigInt(Date.now())
    });
    const result = override?.(request);
    const responseCall = result ? await result : active;
    if (request.action === Action.END) active = undefined;
    return toBinary(ControlDesktopVoiceConversationResponseSchema, create(ControlDesktopVoiceConversationResponseSchema, {
      ...(request.action === Action.END ? {} : { call: responseCall }), accepted: true,
      ...(request.action === Action.SPEAK ? { sampleRate: 24_000 } : {}),
      ...(request.action === Action.READ_SPEECH ? { pcm: Uint8Array.of(0, 0), speechDone: true } : {}),
      exitDecision: request.action === Action.CLASSIFY_EXIT ? decision : '',
      models: [{ backendId: 'backend', providerId: 'provider', modelId: 'tts-1', displayName: 'Speech', providerName: 'Local fixture', protocol: 'openai', protocolLocked: true }],
      preference: { conversation: { backendId: 'backend', providerId: 'provider', modelId: 'tts-1', protocol: 'openai', voice: 'alloy' }, sentencePlayback: true }
    }));
  } } } });
  const state = { effectiveLocale: 'en', snapshot: { interactions: [] as Array<{ sessionId: string; generation: bigint; kind: 'permission' }>, queueControls: [], queue: [],
    backgroundTasks: [] as Array<{ id: string; sessionId: string; state: string }> } };
  const controller = { state } as unknown as AppController;
  const session = { id: 'task', generation: 1n, name: 'Partner task', state: 'idle' } as SessionView;
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container), onClose = vi.fn();
  const render = async () => { await act(async () => root.render(<DesktopVoiceConversationPanel controller={controller} session={session} serverId="node" onClose={onClose} />)); };
  await render();
  return { requests, state, onClose, render, unmountPanel: async () => { await act(async () => root.render(null)); },
    call: () => active!, listener: () => capture!,
    start: async () => { await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Start call')!.click()); },
    readAloud: async (text?: string) => {
      if (text !== undefined) await act(async () => {
        const field = document.querySelector<HTMLTextAreaElement>('textarea')!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Read aloud')!.click());
    },
    dispose: async () => {
      await act(async () => root.unmount()); container.remove();
      if (before) Object.defineProperty(window, 'jokoDesktop', before); else delete (window as { jokoDesktop?: unknown }).jokoDesktop;
    } };
}

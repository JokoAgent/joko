import { create, fromBinary, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import { ControlDesktopVoiceConversationRequestSchema, ControlDesktopVoiceConversationResponseSchema,
  DesktopSpeechEncoding, DesktopVoiceConversationAction } from '@joko/contracts';
import { expect, it, vi } from 'vitest';
import { DesktopSpeechPlayer, DesktopVoiceClient, spokenSentences, voiceExitIntent } from './desktop-voice-conversation.js';

it('binds every generated call request to the original server, task and generation and retires late replies', async () => {
  let finish!: (bytes: Uint8Array) => void;
  const control = vi.fn((serverId: string, bytes: Uint8Array) => {
    expect(serverId).toBe('original-node');
    const request = fromBinary(ControlDesktopVoiceConversationRequestSchema, bytes);
    expect(request).toMatchObject({ sessionId: 'original-task', sessionGeneration: 7n, action: DesktopVoiceConversationAction.SUBMIT, callId: 'call-one', inputId: 'original-input' });
    return new Promise<Uint8Array>(resolve => { finish = resolve; });
  });
  const client = new DesktopVoiceClient({ control }, 'original-node', 'original-task', 7n);
  const pending = client.control(DesktopVoiceConversationAction.SUBMIT, { sessionId: 'wrong-task', sessionGeneration: 99n, callId: 'call-one', inputId: 'original-input', text: 'Keep my exact words.' });
  client.close(); client.activate(); finish(toBinary(ControlDesktopVoiceConversationResponseSchema, create(ControlDesktopVoiceConversationResponseSchema, { accepted: true })));
  await expect(pending).rejects.toThrow('retired');
  expect(control).toHaveBeenCalledOnce();
});

it.each([false, true])('decodes complete MP3 bytes and respects playback retirement=%s', async retired => {
  const buffer = { duration: 0.1, numberOfChannels: 2, sampleRate: 44_100 };
  let finishDecode!: (decoded: typeof buffer) => void;
  const context = {
    state: 'running',
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => { context.state = 'closed'; }),
    decodeAudioData: vi.fn((_bytes: ArrayBuffer) => new Promise<typeof buffer>(resolve => { finishDecode = resolve; })),
    createBufferSource: vi.fn(() => source)
  };
  const source = { buffer: null, connect: vi.fn(), start: vi.fn((_at: number) => { context.currentTime = 1; }) };
  vi.stubGlobal('AudioContext', function TestAudioContext() { return context; });
  const player = new DesktopSpeechPlayer();
  try {
    const parts = [new Uint8Array([0xff, 0xfb, 1]), new Uint8Array([2, 3])];
    const reads: string[] = [];
    const client = new DesktopVoiceClient({ control: async (_server, bytes) => {
      const request = fromBinary(ControlDesktopVoiceConversationRequestSchema, bytes);
      expect(request).toMatchObject({ callId: 'call-mp3', speechRequestId: 'mp3-source', sessionId: 'task-mp3', sessionGeneration: 7n });
      const data: MessageInitShape<typeof ControlDesktopVoiceConversationResponseSchema> = { speechEncoding: DesktopSpeechEncoding.MP3 };
      if (request.action === DesktopVoiceConversationAction.SPEAK) data.accepted = true;
      else {
        expect(request.action).toBe(DesktopVoiceConversationAction.READ_SPEECH);
        reads.push(request.operationId);
        const chunk = parts.shift();
        if (chunk) data.encodedSpeech = chunk;
        else data.speechDone = true;
      }
      return toBinary(ControlDesktopVoiceConversationResponseSchema, create(ControlDesktopVoiceConversationResponseSchema, data));
    } }, 'node-mp3', 'task-mp3', 7n);

    const played = player.play(client, 'call-mp3', 'mp3-source', 'Read these words.');
    await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalledOnce());
    expect(context.decodeAudioData.mock.calls[0]?.[0]).toEqual(new Uint8Array([0xff, 0xfb, 1, 2, 3]).buffer);
    expect(reads).toHaveLength(3);
    expect(new Set(reads).size).toBe(3);
    if (retired) player.stop();
    finishDecode(buffer);
    await played;
    if (retired) expect(context.createBufferSource).not.toHaveBeenCalled();
    else {
      expect(source.buffer).toBe(buffer);
      expect(source.connect).toHaveBeenCalledWith(context.destination);
      expect(source.start).toHaveBeenCalledWith(0);
    }
    expect(context.close).toHaveBeenCalledOnce();
  } finally {
    player.stop();
    vi.unstubAllGlobals();
  }
});

it('preserves adjacent English and Chinese sentence punctuation during sentence playback', () => {
  expect(spokenSentences('One?Two!中文。第二句！')).toEqual(['One?', 'Two!', '中文。', '第二句！']);
});
it('recognizes whole-utterance exit controls without swallowing negation, quoted farewells or work', () => {
  expect(voiceExitIntent('结束语音模式。')).toBe('command'); expect(voiceExitIntent('Goodbye!')).toBe('farewell');
  for (const text of ['不要结束语音模式', '他说再见', '帮我做完再结束语音模式', 'What does goodbye mean?', 'Research this and close voice chat']) expect(voiceExitIntent(text)).toBe(null);
});

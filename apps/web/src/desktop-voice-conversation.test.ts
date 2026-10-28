import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { ControlDesktopVoiceConversationRequestSchema, ControlDesktopVoiceConversationResponseSchema, DesktopVoiceConversationAction } from '@joko/contracts';
import { expect, it, vi } from 'vitest';
import { DesktopVoiceClient, spokenSentences, voiceExitIntent } from './desktop-voice-conversation.js';

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

it('preserves adjacent English and Chinese sentence punctuation during sentence playback', () => {
  expect(spokenSentences('One?Two!中文。第二句！')).toEqual(['One?', 'Two!', '中文。', '第二句！']);
});
it('recognizes whole-utterance exit controls without swallowing negation, quoted farewells or work', () => {
  expect(voiceExitIntent('结束语音模式。')).toBe('command'); expect(voiceExitIntent('Goodbye!')).toBe('farewell');
  for (const text of ['不要结束语音模式', '他说再见', '帮我做完再结束语音模式', 'What does goodbye mean?', 'Research this and close voice chat']) expect(voiceExitIntent(text)).toBe(null);
});

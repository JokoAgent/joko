import { expect, it, vi } from 'vitest';
import { classifyVoiceExit } from './semantic-exit.js';

it('sends only the finalized utterance to stateless classification and fails closed for malformed output', async () => {
  const infer = vi.fn(async (system: string, user: string) => { expect(JSON.parse(user)).toBe('Research this, then exit voice chat.'); expect(system).toContain('SUBMIT_THEN_EXIT'); return 'SUBMIT_THEN_EXIT'; });
  expect(await classifyVoiceExit({ text: 'Research this, then exit voice chat.', current: () => true, infer })).toBe('submit_then_exit');
  infer.mockResolvedValue('EXIT because you asked');
  expect(await classifyVoiceExit({ text: 'What does goodbye mean?', current: () => true, infer })).toBe('continue');
});
it('bounds the entire classification and never adopts a late or retired decision', async () => {
  vi.useFakeTimers();
  try {
    let finish!: (value: string) => void, active = true, signal!: AbortSignal;
    const result = classifyVoiceExit({ text: 'I have to go.', current: () => active,
      infer: async (_system, _user, inputSignal) => { signal = inputSignal; return new Promise<string>(resolve => { finish = resolve; }); } });
    await vi.advanceTimersByTimeAsync(2000); expect(await result).toBe('continue'); expect(signal.aborted).toBe(true);
    active = false; finish('EXIT');
    expect(await classifyVoiceExit({ text: 'Bye.', current: () => active, infer: vi.fn() })).toBe('continue');
  } finally { vi.useRealTimers(); }
});

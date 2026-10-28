// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { currentVoiceQuestionTarget, parseVoiceQuestionSelection, registerVoiceQuestionTarget } from './voice-question-bridge.js';
afterEach(() => document.body.replaceChildren());
it('does not extract choices from negations, alternatives or a longer instruction', () => {
  expect(parseVoiceQuestionSelection('选第二个', ['Read', 'Write'])).toEqual({ kind: 'select', indices: [1] });
  expect(parseVoiceQuestionSelection('Read or Write', ['Read', 'Write'])).toEqual({ kind: 'ambiguous' });
  expect(parseVoiceQuestionSelection('Do not choose Read', ['Read', 'Write'])).toEqual({ kind: 'unknown' });
  expect(parseVoiceQuestionSelection('confirm', ['confirm', 'cancel'])).toEqual({ kind: 'select', indices: [0] });
});
it('binds a captured utterance to the exact visible wizard step, node, run and owner', () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const root = document.createElement('form'); document.body.append(root); const receive = vi.fn();
  const input = { serverId: 'node', sessionId: 'task', runId: 'owned-run', stepKey: 'question-one', root, receive };
  const remove = registerVoiceQuestionTarget(input), captured = currentVoiceQuestionTarget('node', 'task', 'owned-run')!;
  expect(currentVoiceQuestionTarget('other-node', 'task', 'owned-run')).toBeUndefined();
  expect(currentVoiceQuestionTarget('node', 'task', 'unrelated-run')).toBeUndefined();
  const next = registerVoiceQuestionTarget({ ...input, stepKey: 'question-two' });
  captured.receive('First'); expect(receive).not.toHaveBeenCalled(); remove();
  currentVoiceQuestionTarget('node', 'task', 'owned-run')!.receive('Second'); expect(receive).toHaveBeenCalledWith('Second');
  const dialog = document.createElement('section'); dialog.setAttribute('aria-modal', 'true'); document.body.append(dialog);
  expect(currentVoiceQuestionTarget('node', 'task', 'owned-run')).toBeUndefined(); dialog.remove();
  root.dataset.questionDictating = 'true'; const inner = document.createElement('div'); inner.dataset.questionDictating = 'true'; root.append(inner);
  expect(currentVoiceQuestionTarget('node', 'task', 'owned-run')).toBeUndefined(); next();
});

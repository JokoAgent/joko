import { expect, it } from 'vitest';
import { splitDiscordText } from './text.js';

it('preserves boundary whitespace, indentation and emoji in long plain messages', () => {
  const text = ('line one  \n    indented 😀 line\n\n' + 'x'.repeat(90) + '   ').repeat(8);
  const chunks = splitDiscordText(text, 120);
  expect(chunks.join('')).toBe(text);
  expect(chunks.every(chunk => chunk.length <= 120)).toBe(true);
  expect(chunks.some(chunk => /[\uD800-\uDBFF]$/u.test(chunk) || /^[\uDC00-\uDFFF]/u.test(chunk))).toBe(false);
});

it('closes and reopens code fences without deleting code indentation', () => {
  const lines = Array.from({ length: 35 }, (_, index) => `    line_${index} = "😀";  \n`);
  const chunks = splitDiscordText('```ts\n' + lines.join('') + '```', 140);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every(chunk => chunk.startsWith('```ts\n') && chunk.endsWith('```') && chunk.length <= 140)).toBe(true);
  const reconstructed = chunks.map(chunk => chunk.slice('```ts\n'.length, -3)).join('');
  expect(reconstructed).toBe(lines.join(''));
});

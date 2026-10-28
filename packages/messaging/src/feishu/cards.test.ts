import { describe, expect, it } from 'vitest';
import { buildFeishuMarkdownCard, FEISHU_CARD_REQUEST_MAXIMUM_BYTES } from './cards.js';

describe('Feishu Markdown replies', () => {
  it('preserves fenced code and task image captions while fitting serialized Unicode text', () => {
    const card = buildFeishuMarkdownCard('`inline`\n```ts\nconst exact = `source`;\n```\n' + '😀中文\\"'.repeat(20000), [{ key: 'actual-image-key', alt: 'diagram.png' }]);
    const json = JSON.stringify(card);
    expect(Buffer.byteLength(JSON.stringify({ content: json }))).toBeLessThanOrEqual(FEISHU_CARD_REQUEST_MAXIMUM_BYTES);
    expect(json).toContain('const exact = `source`;'); expect(json).toContain('actual-image-key'); expect(json).toContain('diagram.png');
    expect(json).not.toContain('`inline`'); expect(json).toContain('[Response truncated]');
    expect(json).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[cdef][0-9a-f]{2})/iu);
  });
  it('does not invent a blank text result for a real image-only answer', () => {
    expect(buildFeishuMarkdownCard('', [{ key: 'owned-image', alt: 'result.png' }])).toMatchObject({ schema: '2.0',
      body: { elements: [{ tag: 'img', img_key: 'owned-image', alt: { content: 'result.png' } }] } });
  });
});

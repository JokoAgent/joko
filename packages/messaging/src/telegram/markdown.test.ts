import { describe, expect, it } from "vitest";
import { renderTelegramMarkdown, stripTelegramHtmlTags } from "./markdown.js";
import { splitTelegramMarkdown } from "./text.js";

describe("Telegram Markdown replies", () => {
  it("renders headings, emphasis, code, quotes and safe links without interpreting literal HTML", () => {
    const source = '# Result\n**Bold** and *italic* and ~~old~~\n> Verify `<b>&`\n[Link](https://example.test/?x=1&y=2)\n![Photo](https://example.test/p.png)\n<script>bad()</script>\n[Local](file:///private)';
    expect(renderTelegramMarkdown(source)).toBe('<b>Result</b>\n<b>Bold</b> and <i>italic</i> and <s>old</s>\n<blockquote>Verify <code>&lt;b&gt;&amp;</code></blockquote>\n<a href="https://example.test/?x=1&amp;y=2">Link</a>\n<a href="https://example.test/p.png">Photo</a>\n&lt;script&gt;bad()&lt;/script&gt;\n[Local](file:///private)');
    expect(stripTelegramHtmlTags('<b>&amp;lt;</b> &lt;literal&gt;')).toBe('&lt; <literal>');
  });

  it("keeps long code indentation and emoji across independently rendered fenced chunks", () => {
    const source = '```ts\n' + '    const value = "😀<&>";\n'.repeat(400) + '```';
    const parts = splitTelegramMarkdown(source);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.length <= 3_000 && part.startsWith('```ts\n') && part.endsWith('```'))).toBe(true);
    const rendered = parts.map(renderTelegramMarkdown);
    expect(rendered.every(part => part.startsWith('<pre><code class="language-ts">') && part.endsWith('</code></pre>'))).toBe(true);
    const visible = rendered.map(stripTelegramHtmlTags).join('\n');
    expect(visible.match(/    const value = "😀<&>";/gu)).toHaveLength(400);
    expect(parts.some(part => /[\uD800-\uDBFF]$/u.test(part) || /^[\uDC00-\uDFFF]/u.test(part))).toBe(false);
    const whitespace = ('text  \n    indented 😀\n\n').repeat(200);
    expect(splitTelegramMarkdown(whitespace).join('')).toBe(whitespace);
  });
});

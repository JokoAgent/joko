// Render the supported Telegram HTML subset. Owned image bytes remain on the original attachment route.
import { escapeTelegramHtml } from './text.js';
interface Segment {
  kind: 'code' | 'text';
  content: string;
}

export function renderTelegramMarkdown(md: string): string {
  const html = splitByCodeFence(md)
    .map((segment) =>
      segment.kind === 'code'
        ? renderFence(segment.content)
        : renderTextSegment(segment.content),
    )
    .join('');
  return html;
}

const TELEGRAM_ENTITY_TEXT: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&amp;': '&',
};

export function stripTelegramHtmlTags(html: string): string {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (!inTag && ch === '<') {
      inTag = true;
    } else if (inTag && ch === '>') {
      inTag = false;
    } else if (!inTag) {
      out += ch;
    }
  }
  return out.replace(/&(?:lt|gt|quot|amp);/g, (entity) => TELEGRAM_ENTITY_TEXT[entity]!);
}

function splitByCodeFence(text: string): Segment[] {
  const segments: Segment[] = [];
  const re = /```[\s\S]*?(?:```|$)/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ kind: 'text', content: text.slice(last, index) });
    segments.push({ kind: 'code', content: match[0] });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ kind: 'text', content: text.slice(last) });
  return segments;
}

function renderFence(fence: string): string {
  const m = fence.match(/^```([^`\n]*)\n?([\s\S]*?)(?:```)?$/);
  const lang = (m?.[1] ?? '').trim();
  const body = m?.[2] ?? '';
  const langAttr = /^[\w+#.-]{1,32}$/.test(lang) ? ` class="language-${lang}"` : '';
  return `<pre><code${langAttr}>${escapeTelegramHtml(body.replace(/\n$/, ''))}</code></pre>`;
}

function renderTextSegment(segment: string): string {
  return segment.split('\n').map(renderLine).join('\n');
}


function renderLine(line: string): string {
  const heading = line.match(/^(#{1,6})[ \t]{1,8}(.*)$/);
  if (heading) return `<b>${renderInline(heading[2]!)}</b>`;
  const quote = line.match(/^>\s?(.*)$/);
  if (quote) return `<blockquote>${renderInline(quote[1]!)}</blockquote>`;
  if (/^[ \t]{0,64}(?:[-*_][ \t]{0,64}){3,64}$/.test(line) && line.trim().length >= 3) {
    return '———';
  }
  return renderInline(line);
}


function renderInline(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
        return `<code>${escapeTelegramHtml(part.slice(1, -1))}</code>`;
      }
      let out = escapeTelegramHtml(part);
      out = out.replace(
        /!\[([^\]]{1,512})\]\((https?:\/\/[^)\s]{1,2048})\)/g,
        (_m, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`,
      );
      out = out.replace(
        /\[([^\]]{1,512})\]\((https?:\/\/[^)\s]{1,2048})\)/g,
        (_m, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`,
      );
      out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      out = out.replace(/__([^_]+)__/g, '<b>$1</b>');
      out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<i>$2</i>');
      out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>');
      return out;
    })
    .join('');
}


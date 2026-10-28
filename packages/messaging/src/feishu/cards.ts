import type { MessagingAddress } from "../types.js";

const ACTION_COMPONENT_LIMIT = 5;
export const FEISHU_CARD_REQUEST_MAXIMUM_BYTES = 30 * 1024;

/** Schema 2.0 Markdown is shared by progress and independently sent finals. */
export function buildFeishuMarkdownCard(text: string, images: readonly { readonly key: string; readonly alt: string }[] = []): unknown {
  const build = (content: string) => ({ schema: '2.0', config: { update_multi: true }, body: { elements: [
    ...(content ? [{ tag: 'markdown', content: stripInlineCode(content) }] : []),
    ...images.map(image => ({ tag: 'img', img_key: image.key, alt: { tag: 'plain_text', content: image.alt } }))
  ] } });
  const size = (card: unknown) => Buffer.byteLength(JSON.stringify({ content: JSON.stringify(card) }), 'utf8');
  const full = build(text);
  if (size(full) <= FEISHU_CARD_REQUEST_MAXIMUM_BYTES) return full;
  const chars = Array.from(text), suffix = '\n\n[Response truncated]';
  let low = 0, high = chars.length, fitted = build(suffix);
  if (size(fitted) > FEISHU_CARD_REQUEST_MAXIMUM_BYTES) throw new Error('Feishu image card exceeds the request limit.');
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), candidate = build(`${chars.slice(0, middle).join('')}${suffix}`);
    if (size(candidate) <= FEISHU_CARD_REQUEST_MAXIMUM_BYTES) { fitted = candidate; low = middle + 1; } else high = middle - 1;
  }
  return fitted;
}

export function buildFeishuInteractionCard(input: {
  readonly address: MessagingAddress;
  readonly text: string;
  readonly buttons: readonly { readonly label: string; readonly actionValue: string }[];
}): unknown {
  const elements: unknown[] = [{
    tag: "div",
    text: { tag: "lark_md", content: stripInlineCode(input.text) }
  }];
  for (let index = 0; index < input.buttons.length; index += ACTION_COMPONENT_LIMIT) {
    elements.push({
      tag: "action",
      actions: input.buttons.slice(index, index + ACTION_COMPONENT_LIMIT).map((button) => ({
        tag: "button",
        text: { tag: "plain_text", content: button.label },
        type: "default",
        value: {
          id: button.actionValue,
          joko_address: {
            channel: input.address.channel,
            connection_id: input.address.connectionId,
            conversation_id: input.address.providerConversationId,
            thread_id: input.address.providerThreadId,
            conversation_kind: input.address.conversationKind
          }
        }
      }))
    });
  }
  return { config: { wide_screen_mode: true, update_multi: true }, elements };
}

export function buildFeishuClosedCard(): unknown {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    elements: [{ tag: "div", text: { tag: "lark_md", content: "This request is closed." } }]
  };
}

function stripInlineCode(value: string): string {
  return value.split(/(```[\s\S]*?```)/gu).map((part, index) => index % 2 === 1
    ? part
    : stripSegmentInlineCode(part)).join("");
}

function stripSegmentInlineCode(value: string): string {
  let output = '', offset = 0;
  while (offset < value.length) {
    const open = value.indexOf('`', offset);
    if (open < 0) { output += value.slice(offset); break; }
    output += value.slice(offset, open);
    let openEnd = open + 1; while (value.charCodeAt(openEnd) === 0x60) openEnd++;
    const close = value.indexOf('`', openEnd);
    if (close < 0) { output += value.slice(open); break; }
    output += value.slice(openEnd, close);
    let closeEnd = close + 1; while (value.charCodeAt(closeEnd) === 0x60) closeEnd++;
    offset = closeEnd;
  }
  return output;
}

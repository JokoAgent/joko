import type { MessagingAddress } from "../types.js";

const ACTION_COMPONENT_LIMIT = 5;

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
    : part.replace(/`+([^`]+)`+/gu, "$1")).join("");
}

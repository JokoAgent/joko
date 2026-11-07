import { MessagingTransportError } from '../types.js';
import { splitMarkdownChunks } from '../markdown-chunks.js';

export const DISCORD_TEXT_LIMIT = 2_000;

export function splitDiscordText(text: string, limit = DISCORD_TEXT_LIMIT): readonly string[] {
  if (!Number.isSafeInteger(limit) || limit < 8 || limit > DISCORD_TEXT_LIMIT) {
    throw new MessagingTransportError('invalid_input', 'Invalid Discord text limit.', { retryable: false, effect: 'none' });
  }
  return splitMarkdownChunks(text, limit);
}

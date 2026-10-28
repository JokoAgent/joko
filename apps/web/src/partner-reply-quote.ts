import { useSyncExternalStore } from 'react';
import type { PartnerReplyQuoteView, TimelineItemView } from './model.js';
import type { PartnerTodo } from '@joko/contracts';

const pending = new Map<string, PartnerReplyQuoteView>(), listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
export const partnerReplyQuoteExcerpt = (value: string) => { const text = value.replace(/\s+/gu, ' ').trim(); return text.length > 280 ? text.slice(0, 279) + '…' : text; };
export function setPendingPartnerReplyQuote(owner: string, value: PartnerReplyQuoteView | undefined): void {
  if (value) { pending.delete(owner); pending.set(owner, value); if (pending.size > 128) pending.delete(pending.keys().next().value!); }
  else pending.delete(owner);
  notify();
}
export function clearSentPartnerReplyQuote(owner: string, value: PartnerReplyQuoteView): void {
  if (pending.get(owner) === value) setPendingPartnerReplyQuote(owner, undefined);
}
export function usePendingPartnerReplyQuote(owner: string): PartnerReplyQuoteView | undefined {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => pending.get(owner), () => undefined);
}
export function partnerReplyQuoteFor(item: TimelineItemView, generation: bigint): PartnerReplyQuoteView | undefined {
  if (!item.sourceEventId || item.streaming || !['user', 'assistant'].includes(item.kind) || item.partnerPrivateOrigin) return undefined;
  return { generation, eventId: item.sourceEventId, messageId: item.messageId ?? item.id, role: item.kind as 'user' | 'assistant',
    excerpt: partnerReplyQuoteExcerpt(item.text ?? '') || item.attachments?.[0]?.fileName || item.attachments?.[0]?.title || '' };
}

export interface PendingPartnerTodoQuote { readonly partnerId: string; readonly todoId: string; readonly revision: bigint; readonly title: string; }
const todos = new Map<string, PendingPartnerTodoQuote>();
export function setPendingPartnerTodoQuote(owner: string, partnerId: string, todo?: PartnerTodo): void {
  if (todo) { todos.delete(owner); todos.set(owner, { partnerId, todoId: todo.id, revision: todo.revision, title: todo.title }); if (todos.size > 128) todos.delete(todos.keys().next().value!); }
  else todos.delete(owner); notify();
}
export function usePendingPartnerTodoQuote(owner: string): PendingPartnerTodoQuote | undefined {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => todos.get(owner), () => undefined);
}
export function clearSentPartnerTodoQuote(owner: string, value: PendingPartnerTodoQuote): void { if (todos.get(owner) === value) setPendingPartnerTodoQuote(owner, value.partnerId); }

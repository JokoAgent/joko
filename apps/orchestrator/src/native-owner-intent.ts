import { redactSecrets, validInlineTextRanges, validInputMentionRanges, type AdapterContext, type PromptInput } from "@joko/core";
import type { OperationalStore } from "@joko/store";

/** Author text from the durable composer envelope. Referenced content and
 * inherited native transcripts are evidence, never a new owner's request. */
export function ownerAuthoredPromptText(input: PromptInput): string {
  const text = input.text, pasted = input.pastedTextRanges ?? [], mentions = input.mentionRanges ?? [];
  if (input.automaticContinuation || input.objectiveContinuation || input.inputHandoffContinuation
    || !validInlineTextRanges(text, pasted) || !validInputMentionRanges(text, input.mentions ?? [], mentions, pasted)) return "";
  const excluded: { start: number; end: number }[] = [...pasted, ...mentions];
  if (input.quotesEncoded) {
    const lines: { text: string; start: number; end: number }[] = [];
    const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/gu;
    for (const match of text.matchAll(pattern)) {
      if (!match[0]) break;
      lines.push({ text: match[0].replace(/[\r\n]+$/u, ""), start: match.index, end: match.index + match[0].length });
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const marker = line.text.trimStart();
      if (marker !== "> <!-- joko-selection-quote -->") continue;
      const prefix = line.text.slice(0, line.text.length - marker.length) + ">";
      let end = line.end;
      while (i + 1 < lines.length && (lines[i + 1]!.text === prefix || lines[i + 1]!.text.startsWith(prefix + " "))) end = lines[++i]!.end;
      excluded.push({ start: line.start, end });
    }
  }
  excluded.sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0, authored = "";
  for (const range of excluded) {
    if (range.start > cursor) authored += text.slice(cursor, range.start);
    cursor = Math.max(cursor, range.end);
  }
  authored += text.slice(cursor);
  if (excluded.length && authored.split(/\r?\n/u).every(line => /^[ \t]*(?:[-+*•](?:[ \t]+\[[ xX]\])?|[1-9]\d*[.)、])?[ \t]*$/u.test(line))) return "";
  return authored;
}

/** Only Queue admissions made in this Session can author intent. A fork may
 * retain native parent history without inheriting its owner's permissions. */
export function readNativeOwnerInstructions(store: OperationalStore, context: Pick<AdapterContext, "sessionId" | "generation" | "operationId">,
  redact: (text: string) => string = redactSecrets): readonly string[] {
  const active = new Set<string>();
  let afterCursor: bigint | undefined, complete = false;
  for (let page = 0; page < 20; page++) {
    const events = store.listEvents({ sessionId: context.sessionId, activeNativeTimeline: true, limit: 500,
      ...(afterCursor === undefined ? {} : { afterCursor }) });
    for (const event of events) {
      const value = event.payload;
      if (value.type === "message_complete" && value.role === "user" && !value.automaticContinuation && !value.objectiveContinuation
        && !value.inputHandoffContinuation && !value.partnerPrivateOrigin && event.operationId) active.add(event.operationId);
    }
    if (events.length < 500) { complete = true; break; }
    afterCursor = events.at(-1)!.globalCursor;
  }
  if (!complete) return [];
  const instructions: { at: number; text: string }[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = store.listQueueItems({ sessionId: context.sessionId, offset, limit: 500 });
    for (const item of page) if (store.getRun(item.runId).descriptor.source === "user"
      && (active.has(item.operationId) && ["backend_accepted", "completed"].includes(item.state)
        || item.operationId === context.operationId && ["dispatching", "backend_accepted", "completed"].includes(item.state))) {
      const text = ownerAuthoredPromptText(item.body);
      if (text.trim()) instructions.push({ at: item.createdAt, text });
    }
    if (page.length < 500) break;
    if (offset >= 10_000) return [];
  }
  const answers = store.listInteractions({ sessionId: context.sessionId, kinds: ["question", "plan_review"], status: "resolved", limit: 65 });
  if (answers.length >= 65) return [];
  for (const answer of answers) if (answer.generation === context.generation && answer.decision
    && ["question", "plan_review"].includes(answer.decision.kind)) instructions.push({ at: answer.resolvedAt ?? answer.createdAt,
      text: JSON.stringify({ interactionContext: answer.payload, ownerAnswer: answer.decision }) });
  const values = instructions.sort((a, b) => a.at - b.at).map(value => redact(value.text));
  return values.length > 64 || values.reduce((size, value) => size + value.length, 0) > 16_000 ? [] : values;
}

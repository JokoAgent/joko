import type { SubagentControlActionView, SubagentTranscriptEntryView } from "../model.js";

export interface SubagentMessageItem {
  readonly kind: "parent" | "subagent";
  readonly id: string;
  readonly content: string;
  readonly occurredAt: number;
  readonly controlAction?: SubagentControlActionView;
}

export interface SubagentToolItem {
  readonly kind: "tool";
  readonly id: string;
  toolName?: string;
  readonly summary: string;
  readonly inputJson?: string;
  result?: string;
  isError: boolean;
  done: boolean;
  readonly occurredAt: number;
}

export type SubagentConversationItem = SubagentMessageItem | SubagentToolItem;

export interface SubagentConversation {
  readonly items: readonly SubagentConversationItem[];
  readonly system: readonly SubagentTranscriptEntryView[];
}

export function buildSubagentConversation(entries: readonly SubagentTranscriptEntryView[]): SubagentConversation {
  const items: SubagentConversationItem[] = [];
  const system: SubagentTranscriptEntryView[] = [];
  const openByCallId = new Map<string, SubagentToolItem>();
  const openAnonymous: SubagentToolItem[] = [];

  for (const entry of entries) {
    if (entry.role === "system") {
      system.push(entry);
      continue;
    }
    if (entry.role !== "tool") {
      items.push({
        kind: entry.role,
        id: entry.id,
        content: entry.content,
        occurredAt: entry.occurredAt,
        ...(entry.controlAction === undefined ? {} : { controlAction: entry.controlAction })
      });
      continue;
    }
    const open = entry.toolCallId === undefined
      ? openAnonymous.at(-1)
      : openByCallId.get(entry.toolCallId);
    if (entry.toolPhase === "update" && open !== undefined) {
      if (entry.content.length > 0) open.result = entry.content;
      if (entry.isError === true) open.isError = true;
      continue;
    }
    if (entry.toolPhase === "end") {
      if (open !== undefined) {
        open.result = entry.content;
        open.isError = entry.isError === true;
        open.done = true;
        if (entry.toolName !== undefined && open.toolName === undefined) open.toolName = entry.toolName;
        if (entry.toolCallId === undefined) openAnonymous.pop();
        else openByCallId.delete(entry.toolCallId);
        continue;
      }
      items.push({
        kind: "tool",
        id: entry.id,
        ...(entry.toolName === undefined ? {} : { toolName: entry.toolName }),
        summary: entry.toolName ?? "",
        result: entry.content,
        isError: entry.isError === true,
        done: true,
        occurredAt: entry.occurredAt
      });
      continue;
    }
    if (entry.toolPhase !== "start") {
      items.push({
        kind: "tool",
        id: entry.id,
        ...(entry.toolName === undefined ? {} : { toolName: entry.toolName }),
        summary: entry.toolName ?? "",
        ...(entry.toolInputJson === undefined ? {} : { inputJson: entry.toolInputJson }),
        result: entry.content,
        isError: entry.isError === true,
        done: true,
        occurredAt: entry.occurredAt
      });
      continue;
    }
    const tool: SubagentToolItem = {
      kind: "tool",
      id: entry.id,
      ...(entry.toolName === undefined ? {} : { toolName: entry.toolName }),
      summary: entry.content,
      ...(entry.toolInputJson === undefined ? {} : { inputJson: entry.toolInputJson }),
      isError: entry.isError === true,
      done: false,
      occurredAt: entry.occurredAt
    };
    items.push(tool);
    if (entry.toolCallId === undefined) openAnonymous.push(tool);
    else openByCallId.set(entry.toolCallId, tool);
  }
  return { items, system };
}

export function mergeSubagentTranscript(
  current: readonly SubagentTranscriptEntryView[],
  incoming: readonly SubagentTranscriptEntryView[]
): readonly SubagentTranscriptEntryView[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

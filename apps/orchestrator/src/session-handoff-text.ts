import { redactSecrets } from "@joko/core";
import type { PersistedEvent } from "@joko/store";

export interface HandoffSourceMessage {
  readonly role: string;
  readonly content: unknown;
  readonly createdAt: number;
  readonly toolUseId?: string;
}
export interface BuildHandoffOptions {
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly sessionId: string;
  readonly mode: "full" | "delta";
  readonly workStateMessages?: HandoffSourceMessage[];
  readonly includeToolResults?: boolean;
}

const RECENT_TURNS = 4;

const RECENT_TEXT_CAP = 2000;

const TOOL_INPUT_CAP = 160;

const DIGEST_BUDGET = 3000;

const DIGEST_LINE_CAP = 120;

const HANDOFF_HARD_CAP = 16000;

const DETAIL_LINES_EDGE_CAP = 20;

const DETAIL_LINES_CHAR_BUDGET = 9000;
const DETAIL_LINE_COMPACT_CAP = 240;

const CHANGED_FILES_CAP = 20;

const COMMANDS_CAP = 10;

const COMMAND_LINE_CAP = 120;

const FILE_EDIT_TOOL_NAMES = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'str_replace_editor',
]);

const COMMAND_TOOL_NAMES = new Set(['Bash', 'shell', 'exec_command', 'local_shell']);

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}…(truncated)`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function extractPlainText(content: unknown): string {
  if (typeof content === 'string') {
    if (content.length === 0) return '';
    const first = content[0];
    if (first === '{' || first === '[') {
      try {
        return extractPlainText(JSON.parse(content));
      } catch {
        return content;
      }
    }
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    return parts.join('\n');
  }
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') {
      return c.text;
    }
    if (typeof c.message === 'string') return c.message;
  }
  return '';
}

interface Turn {
  userText: string;

  detailLines: string[];

  lastAssistantText: string;
}

interface WorkState {
  changedFiles: string[];
  commands: Array<{ command: string; outcome?: string }>;
  failedPaths: string[];
}

function commandTextOf(input: Record<string, unknown>): string {
  const raw = input.command;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string').join(' ');
  return '';
}

function toolUseIdOf(message: HandoffSourceMessage, content?: Record<string, unknown>): string {
  if (typeof message.toolUseId === 'string' && message.toolUseId) return message.toolUseId;
  if (!content) return '';
  return typeof content.toolUseId === 'string'
    ? content.toolUseId
    : typeof content.id === 'string'
      ? content.id
      : '';
}

function extractFailedPathHints(text: string): string[] {
  const hints: string[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/\bFAIL\s+(\S+)/) ?? line.match(/(\S+\.(?:test|spec)\.\w+)/);
    if (!match?.[1]) continue;
    hints.push(truncate(match[1], 80));
    if (hints.length >= 3) break;
  }
  return hints;
}

function extractCommandOutcome(content: Record<string, unknown>): string | undefined {
  if (content.isError === true) return 'failed';
  if (typeof content.exitCode === 'number' && Number.isFinite(content.exitCode)) {
    return `exit ${content.exitCode}`;
  }
  const text = extractPlainText(content.fullText ?? content.output ?? content.content ?? content);
  const exitMatch = text.match(/exit(?:ed)?(?:\s+code)?[:\s]+(-?\d+)/i);
  if (exitMatch) return `exit ${exitMatch[1]}`;
  if (/\b(tests? failed|failing tests|assertionerror)\b/i.test(text)) return 'tests failed';
  if (content.isError === false) return 'ok';
  return undefined;
}

function isFailedOutcome(outcome: string | undefined): boolean {
  if (!outcome) return false;
  if (outcome === 'ok' || outcome === 'exit 0') return false;
  return true;
}

function extractWorkState(messages: HandoffSourceMessage[]): WorkState {
  const files = new Set<string>();
  const commands: Array<{ command: string; outcome?: string }> = [];
  const commandByToolUseId = new Map<string, number>();
  const failedPaths: string[] = [];
  for (const msg of messages) {
    const objectContent =
      msg.content && typeof msg.content === 'object' && !Array.isArray(msg.content)
        ? (msg.content as Record<string, unknown>)
        : undefined;
    if (msg.role === 'tool_use') {
      if (!objectContent) continue;
      const name = typeof objectContent.toolName === 'string' ? objectContent.toolName : '';
      const input = (
        objectContent.input && typeof objectContent.input === 'object'
          ? objectContent.input
          : {}
      ) as Record<string, unknown>;
      if (FILE_EDIT_TOOL_NAMES.has(name)) {
        for (const key of ['file_path', 'path', 'notebook_path']) {
          const v = input[key];
          if (typeof v === 'string' && v) files.add(v);
        }
      } else if (COMMAND_TOOL_NAMES.has(name)) {
        const cmd = commandTextOf(input);
        if (!cmd) continue;
        const entry = { command: truncate(oneLine(cmd), COMMAND_LINE_CAP) };
        const index = commands.push(entry) - 1;
        const toolUseId = toolUseIdOf(msg, objectContent);
        if (toolUseId) commandByToolUseId.set(toolUseId, index);
      }
      continue;
    }
    if (msg.role !== 'tool_result') continue;
    const toolUseId = toolUseIdOf(msg, objectContent);
    const index = toolUseId ? commandByToolUseId.get(toolUseId) : undefined;
    if (index === undefined) continue;
    const outcomeSource =
      objectContent ??
      (typeof msg.content === 'string' ? { fullText: msg.content } : undefined);
    if (!outcomeSource) continue;
    const outcome = extractCommandOutcome(outcomeSource);
    if (!outcome) continue;
    commands[index] = { ...commands[index]!, outcome };
    if (isFailedOutcome(outcome)) {
      const rawText =
        typeof msg.content === 'string'
          ? msg.content
          : extractPlainText(outcomeSource.fullText ?? outcomeSource.output ?? outcomeSource);
      const hints = extractFailedPathHints(rawText);
      if (hints.length > 0) failedPaths.push(...hints);
      else failedPaths.push(`${commands[index]!.command} → ${outcome}`);
    }
  }
  return {
    changedFiles: [...files].slice(-CHANGED_FILES_CAP),
    commands: commands.slice(-COMMANDS_CAP),
    failedPaths: failedPaths.slice(-COMMANDS_CAP),
  };
}

function toolResultText(content: unknown): string {
  let value = content;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return value as string; }
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (item && typeof item === 'object') {
        const block = item as Record<string, unknown>;
        if (block.type === 'image' || block.type === 'input_image' || block.type === 'image_url' ||
          (typeof block.mimeType === 'string' && block.mimeType.startsWith('image/'))) {
          return '[image omitted]';
        }
      }
      return item;
    }) ?? '';
  } catch { return '(result could not be summarized)'; }
}

function splitTurns(messages: HandoffSourceMessage[], includeToolResults = false): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractPlainText(msg.content);
      current = { userText: text, detailLines: [], lastAssistantText: '' };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { userText: '', detailLines: [], lastAssistantText: '' };
      turns.push(current);
    }
    switch (msg.role) {
      case 'assistant': {
        const text = extractPlainText(msg.content);
        if (text) {
          current.detailLines.push(`[Assistant]\n${truncate(text, RECENT_TEXT_CAP)}`);
          current.lastAssistantText = text;
        }
        break;
      }
      case 'tool_use': {
        const c = (msg.content ?? {}) as Record<string, unknown>;
        const name = typeof c.toolName === 'string' ? c.toolName : '(unknown)';
        let inputDigest = '';
        try {
          inputDigest = c.input === undefined ? '' : JSON.stringify(c.input);
        } catch {
          inputDigest = '';
        }
        const id = includeToolResults ? toolUseIdOf(msg, c) : '';
        current.detailLines.push(`[Tool] ${name}${id ? ` (id=${id})` : ''}${inputDigest ? `: ${truncate(inputDigest, TOOL_INPUT_CAP)}` : ''}`);
        break;
      }
      case 'tool_result': {
        if (!includeToolResults) break;
        const c = msg.content && typeof msg.content === 'object' && !Array.isArray(msg.content)
          ? msg.content as Record<string, unknown> : undefined;
        const id = toolUseIdOf(msg, c);
        const text = toolResultText(c?.fullText ?? c?.output ?? c?.content ?? msg.content)
          .replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, '[image omitted]');
        const status = c?.isError === true ? 'failed' : 'recorded; verify outcome from result';
        current.detailLines.push(`[Tool result${id ? ` id=${id}` : ''}; ${status}]\n${truncate(text || '(no text result retained)', 1000)}`);
        break;
      }
      case 'error': {
        const text = extractPlainText(msg.content);
        if (text) current.detailLines.push(`[Error] ${truncate(oneLine(text), 200)}`);
        break;
      }
      case 'ask_user': {
        current.detailLines.push('[Asked the user a question and got an answer]');
        break;
      }
      case 'plan_review': {
        current.detailLines.push('[Submitted a plan for the user to review]');
        break;
      }
      default:
        break;
    }
  }
  return turns;
}

function collapseDetailLines(lines: string[]): string[] {
  const totalChars = lines.reduce((sum, line) => sum + line.length + 1, 0);
  const normalized = totalChars > DETAIL_LINES_CHAR_BUDGET
    ? lines.map((line) => truncate(line, DETAIL_LINE_COMPACT_CAP))
    : lines;
  const kept = DETAIL_LINES_EDGE_CAP * 2;
  if (normalized.length <= kept) return normalized;
  const omitted = normalized.length - kept;
  return [
    ...normalized.slice(0, DETAIL_LINES_EDGE_CAP),
    `(${omitted} tool calls omitted)`,
    ...normalized.slice(-DETAIL_LINES_EDGE_CAP),
  ];
}

export function buildSessionHandoffText(
  messages: HandoffSourceMessage[],
  opts: BuildHandoffOptions,
): string {
  const turns = splitTurns(messages, opts.includeToolResults);
  for (let recentCount = RECENT_TURNS; recentCount >= 1; recentCount--) {
    const text = assembleHandoffText(turns, messages, opts, recentCount);
    if (text.length <= HANDOFF_HARD_CAP || recentCount === 1) {
      return capPreservingTerminator(text, opts);
    }
  }

  return capPreservingTerminator(assembleHandoffText(turns, messages, opts, 1), opts);
}


const HANDOFF_TERMINATOR = "== End of handoff note; the user's new message follows ==";
const RETRIEVAL_SECTION_HEADING = "== Retrieving earlier verbatim history";
function handoffTerminator(_opts: BuildHandoffOptions): string { return HANDOFF_TERMINATOR; }
function capPreservingTerminator(text: string, _opts: BuildHandoffOptions): string {
  if (text.length <= HANDOFF_HARD_CAP) return text;
  const at = text.lastIndexOf(RETRIEVAL_SECTION_HEADING);
  const tail = at >= 0 ? text.slice(at) : HANDOFF_TERMINATOR;
  const room = Math.max(0, HANDOFF_HARD_CAP - tail.length - 2);
  return text.slice(0, room) + "\n\n" + tail;
}
function assembleHandoffText(
  turns: Turn[],
  messages: HandoffSourceMessage[],
  opts: BuildHandoffOptions,
  recentCount: number,
): string {
  const recent = turns.slice(-recentCount);
  const earlier = turns.slice(0, -recentCount);

  const sections: string[] = [];
  if (opts.mode === 'delta') {
    sections.push(
      `[Session handoff · internal context]\n` +
        `You (${opts.toLabel}) worked on this conversation before; it was handed over to the ${opts.fromLabel} engine for a while, and now it is switching back to you. ` +
        `Your memory of the conversation from before you left should still be valid; below is a record of what happened while you were away. ` +
        `Merge it into your understanding and continue naturally in the first person. ` +
        `Do not mention this handoff note to the user, and do not mention the engine switch. ` +
        `Before making any change, check the actual workspace state (e.g. git status / git diff / reading the relevant files): ` +
        `when the record, your own memory, and the workspace disagree, the workspace always wins; ` +
        `when you are unsure about something from while you were away, read the real files and code to confirm rather than guessing from the summary.`,
    );
  } else {
    sections.push(
      `[Session handoff · internal context]\n` +
        `This conversation was previously driven by the ${opts.fromLabel} engine; from here on you (${opts.toLabel}) continue it. ` +
        `Below is the prior record of this conversation — it is the same conversation between you and the user, ` +
        `so continue naturally in the first person. ` +
        `Do not mention this handoff note to the user, and do not say things like "according to the handoff summary/record". ` +
        `Before making any change, check the actual workspace state (e.g. git status / git diff / reading the relevant files): ` +
        `when the record conflicts with the workspace, the workspace always wins; ` +
        `when you are unsure about an earlier detail, read the real files and code to confirm rather than guessing from the summary.`,
    );
  }

  const work = extractWorkState(opts.workStateMessages ?? messages);
  if (work.changedFiles.length > 0 || work.commands.length > 0 || work.failedPaths.length > 0) {
    const lines: string[] = [];
    if (work.changedFiles.length > 0) {
      lines.push('Files changed:');
      for (const f of work.changedFiles) lines.push(`- ${f}`);
    }
    if (work.commands.length > 0) {
      lines.push('Commands (most recent):');
      for (const cmd of work.commands) {
        lines.push(cmd.outcome ? `- ${cmd.command} → ${cmd.outcome}` : `- ${cmd.command}`);
      }
    }
    if (work.failedPaths.length > 0) {
      lines.push('Failed attempts:');
      for (const path of work.failedPaths) lines.push(`- ${path}`);
    }
    sections.push(`== Work ledger (auto-extracted) ==\n${lines.join('\n')}`);
  }

  if (earlier.length > 0) {
    const lines: string[] = [];
    for (const t of earlier) {
      if (t.userText) lines.push(`- User: ${truncate(oneLine(t.userText), DIGEST_LINE_CAP)}`);
      if (t.lastAssistantText) {
        lines.push(`  Reply: ${truncate(oneLine(t.lastAssistantText), DIGEST_LINE_CAP)}`);
      }
    }
    let digest = lines.join('\n');
    if (digest.length > DIGEST_BUDGET) {
      const kept: string[] = [];
      let used = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const cost = lines[i]!.length + 1;
        if (used + cost > DIGEST_BUDGET) break;
        kept.unshift(lines[i]!);
        used += cost;
      }
      digest = `(earlier content omitted)\n${kept.join('\n')}`;
    }
    sections.push(
      opts.mode === 'delta'
        ? `== Earlier progress while you were away ==\n${digest}`
        : `== Earlier conversation index (hints only, not a verified summary) ==\n${digest}`,
    );
  }

  if (recent.length > 0) {
    const blocks: string[] = [];
    for (const t of recent) {
      const parts: string[] = [];
      if (t.userText) parts.push(`[User]\n${truncate(t.userText, RECENT_TEXT_CAP)}`);
      parts.push(...collapseDetailLines(t.detailLines));
      if (parts.length > 0) blocks.push(parts.join('\n'));
    }
    sections.push(
      opts.mode === 'delta'
        ? `== Conversation while you were away ==\n${blocks.join('\n---\n')}`
        : `== Recent conversation ==\n${blocks.join('\n---\n')}`,
    );
  } else if (opts.mode === 'delta') {
    sections.push('== No new messages while you were away ==');
  }

  if (opts.sessionId) {
    sections.push(
      `== Retrieving earlier verbatim history (use when needed) ==\n` +
        `Session id: ${opts.sessionId}\n` +
        `The index above is only a hint. Retrieve earlier verbatim text only when needed (discover the task helper history tools):\n` +
        `1. First: search_chat_history, args {"query":"<keywords>","session_ids":["${opts.sessionId}"],"limit":10}\n` +
        `2. Only if that is not enough: get_chat_history, args {"session_ids":["${opts.sessionId}"],"roles":["user","assistant"],"limit":20}\n` +
        `Page with nextCursor only when hasMore is true and the needed detail is still missing. Never request the default 200-row page and never dump the full history.\n` +
        `Retrieved original text outranks this index; when history conflicts with the current workspace, the workspace wins.`,
    );
  }

  sections.push(handoffTerminator(opts));
  return sections.join('\n\n');
}

/** Only the visible, redacted product projection enters another native runtime. */
export function sessionHandoffMessages(events: readonly PersistedEvent[]): HandoffSourceMessage[] {
  const result: HandoffSourceMessage[] = [];
  const partials = new Map<string, { text: string; at: number }>();
  for (const event of events) {
    const payload = event.payload;
    const key = event.runId ?? "unscoped";
    const base = { createdAt: event.emittedAt };
    if (payload.type === "message_complete") {
      if (payload.automaticContinuation !== undefined || payload.objectiveContinuation !== undefined) continue;
      const text = payload.blocks.flatMap(block => {
        if (block.kind === "text") return [redactSecrets(block.text)];
        if (block.kind === "image") return ["[Image attachment]"];
        if (block.kind === "artifact") return ["[Artifact: " + redactSecrets(block.label) + "]"];
        return [];
      }).join("\n");
      if (payload.role === "assistant") partials.delete(key);
      if (text) result.push({ ...base, role: payload.role, content: text });
    } else if (payload.type === "text_delta") {
      const partial = partials.get(key) ?? { text: "", at: event.emittedAt };
      partial.text += payload.delta; partials.set(key, partial);
    } else if (payload.type === "tool_start") {
      let input: unknown = {};
      try { input = JSON.parse(redactSecrets(payload.input)); } catch { input = { description: redactSecrets(payload.input) }; }
      result.push({ ...base, role: "tool_use", toolUseId: payload.callId,
        content: { toolName: payload.name, input } });
    } else if (payload.type === "tool_result") {
      result.push({ ...base, role: "tool_result", toolUseId: payload.callId,
        content: { fullText: redactSecrets(payload.output), isError: payload.isError } });
    } else if (payload.type === "error") {
      result.push({ ...base, role: "error", content: redactSecrets(payload.error.message) });
    }
  }
  for (const partial of partials.values()) {
    if (partial.text) result.push({ role: "assistant", content: redactSecrets(partial.text), createdAt: partial.at });
  }
  return result.sort((a,b) => a.createdAt - b.createdAt);
}

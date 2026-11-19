export interface AnthropicSseEvent {
  event: string;
  data: Record<string, unknown>;
}

type BlockKind = 'thinking' | 'message' | 'function_call';

interface BlockState {
  blockIndex: number;
  kind: BlockKind;
  opened: boolean;
  argsSent?: number;
  pending?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

const DEFERRABLE_TYPES = new Set([
  'response.output_item.added',
  'response.output_text.delta',
  'response.reasoning_summary_text.delta',
  'response.function_call_arguments.delta',
  'response.output_item.done',
]);

export class ResponsesToClaudeStream {
  private messageStarted = false;
  private finished = false;
  private nextBlockIndex = 0;
  private hasToolUse = false;
  private blocks = new Map<number, BlockState>();
  private openOutputIndex: number | null = null;
  private readonly model: string;
  private readonly signaturePrefix: string;

  constructor(model: string, signaturePrefix: string) {
    this.model = model;
    this.signaturePrefix = signaturePrefix;
  }

  // Keep each tool argument stream and reasoning signature inside one Claude content block.
  private deferred: unknown[] = [];

  private openBlockIsUninterruptible(): boolean {
    if (this.openOutputIndex === null) return false;
    const kind = this.blocks.get(this.openOutputIndex)?.kind;
    return kind === 'function_call' || kind === 'thinking';
  }

  push(ev: unknown): AnthropicSseEvent[] {
    if (this.finished) return [];
    const e = asRecord(ev);
    const type = typeof e.type === 'string' ? e.type : '';
    const out: AnthropicSseEvent[] = [];

    if (this.shouldDefer(e, type)) {
      this.deferred.push(ev);
      return out;
    }
    this.handleEvent(e, type, out);
    this.drainDeferred(out, false);
    return out;
  }

  private shouldDefer(e: Record<string, unknown>, type: string): boolean {
    if (!DEFERRABLE_TYPES.has(type)) return false;
    if (!this.openBlockIsUninterruptible()) return false;
    const outputIndex = typeof e.output_index === 'number' ? e.output_index : null;
    return outputIndex !== this.openOutputIndex;
  }

  private drainDeferred(out: AnthropicSseEvent[], force: boolean): void {
    for (;;) {
      if (this.deferred.length === 0) return;
      let idx = -1;
      if (force) {
        idx = 0;
      } else {
        for (let i = 0; i < this.deferred.length; i++) {
          const e = asRecord(this.deferred[i]);
          if (!this.shouldDefer(e, typeof e.type === 'string' ? e.type : '')) { idx = i; break; }
        }
        if (idx < 0) return;
      }
      const e = asRecord(this.deferred.splice(idx, 1)[0]);
      this.handleEvent(e, typeof e.type === 'string' ? e.type : '', out);
    }
  }

  private handleEvent(e: Record<string, unknown>, type: string, out: AnthropicSseEvent[]): void {
    if (!type && e.error && typeof e.error === 'object') {
      this.emitFailure('The Responses Provider reported a failed request.', out);
      return;
    }
    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        this.ensureMessageStart(e, out);
        break;
      }
      case 'response.output_item.added': {
        this.onItemAdded(e, out);
        break;
      }
      case 'response.output_text.delta': {
        this.onTextDelta(e, out);
        break;
      }
      case 'response.reasoning_summary_text.delta': {
        this.onReasoningSummaryDelta(e, out);
        break;
      }
      case 'response.function_call_arguments.delta': {
        this.onFunctionArgsDelta(e, out);
        break;
      }
      case 'response.output_item.done': {
        this.onItemDone(e, out);
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        this.onCompleted(e, out);
        break;
      }
      case 'response.failed':
      case 'error': {
        this.emitFailure('The Responses Provider reported a failed request.', out);
        break;
      }
      default:
        break;
    }
  }

  fail(message: string): AnthropicSseEvent[] {
    if (this.finished) return [];
    const out: AnthropicSseEvent[] = [];
    this.emitFailure(message, out);
    return out;
  }

  finish(): AnthropicSseEvent[] {
    if (this.finished) return [];
    return this.fail('upstream stream ended before response.completed (stream_truncated)');
  }

  pushJson(raw: unknown): AnthropicSseEvent[] {
    const response = asRecord(raw);
    if (Object.keys(response).length === 0) {
      return this.fail('upstream returned an invalid Responses JSON object');
    }
    if (response.status === 'failed' || response.error) {
      return this.push({ type: 'response.failed', response });
    }
    if (response.status !== 'completed' && response.status !== 'incomplete') {
      return this.fail('upstream returned a non-terminal Responses JSON object');
    }

    const out: AnthropicSseEvent[] = [];
    out.push(...this.push({ type: 'response.created', response }));
    const output = Array.isArray(response.output) ? response.output : [];
    for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
      const item = asRecord(output[outputIndex]);
      const itemType = typeof item.type === 'string' ? item.type : '';
      out.push(...this.push({ type: 'response.output_item.added', output_index: outputIndex, item }));

      if (itemType === 'message') {
        const content = Array.isArray(item.content) ? item.content : [];
        for (const partValue of content) {
          const part = asRecord(partValue);
          if (part.type === 'output_text' && typeof part.text === 'string') {
            out.push(...this.push({
              type: 'response.output_text.delta',
              output_index: outputIndex,
              delta: part.text,
            }));
          }
        }
      } else if (itemType === 'reasoning') {
        const summary = Array.isArray(item.summary) ? item.summary : [];
        for (const partValue of summary) {
          const part = asRecord(partValue);
          if (part.type === 'summary_text' && typeof part.text === 'string') {
            out.push(...this.push({
              type: 'response.reasoning_summary_text.delta',
              output_index: outputIndex,
              delta: part.text,
            }));
          }
        }
      } else if (itemType === 'function_call' && typeof item.arguments === 'string') {
        out.push(...this.push({
          type: 'response.function_call_arguments.delta',
          output_index: outputIndex,
          delta: item.arguments,
        }));
      }

      out.push(...this.push({ type: 'response.output_item.done', output_index: outputIndex, item }));
    }

    const status = response.status === 'incomplete' ? 'response.incomplete' : 'response.completed';
    out.push(...this.push({ type: status, response }));
    return out;
  }

  private ensureMessageStart(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    if (this.messageStarted) return;
    const resp = asRecord(e.response);
    const id = typeof resp.id === 'string' ? resp.id : `msg_${Date.now()}`;

    this.messageStarted = true;
    out.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    });
  }

  private closeOpenBlockForOtherItem(outputIndex: number, out: AnthropicSseEvent[]): void {
    if (this.openOutputIndex === null || this.openOutputIndex === outputIndex) return;
    const st = this.blocks.get(this.openOutputIndex);
    if (st?.opened) {
      out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: st.blockIndex } });
      st.opened = false;
    }
    this.openOutputIndex = null;
  }

  private onItemAdded(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    this.ensureMessageStart(e, out);
    const outputIndex = typeof e.output_index === 'number' ? e.output_index : this.blocks.size;
    if (this.blocks.has(outputIndex)) return;
    const item = asRecord(e.item);
    const itemType = typeof item.type === 'string' ? item.type : '';

    if (itemType === 'reasoning') {
      this.blocks.set(outputIndex, { blockIndex: -1, kind: 'thinking', opened: false });
    } else if (itemType === 'message') {
      this.blocks.set(outputIndex, { blockIndex: -1, kind: 'message', opened: false });
    } else if (itemType === 'function_call') {
      this.closeOpenBlockForOtherItem(outputIndex, out);
      const blockIndex = this.nextBlockIndex++;
      this.blocks.set(outputIndex, { blockIndex, kind: 'function_call', opened: true, argsSent: 0 });
      this.openOutputIndex = outputIndex;
      this.hasToolUse = true;
      out.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: typeof item.call_id === 'string' ? item.call_id : String(item.id ?? `call_${blockIndex}`),
            name: typeof item.name === 'string' ? item.name : '',
            input: {},
          },
        },
      });
    }
  }

  private onTextDelta(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    const outputIndex = typeof e.output_index === 'number' ? e.output_index : -1;
    const st = this.blocks.get(outputIndex);
    const delta = typeof e.delta === 'string' ? e.delta : '';
    if (!st || st.kind !== 'message') return;
    if (!delta) return;
    if (!st.opened) {
      const pending = (st.pending ?? '') + delta;
      if (pending.trim().length === 0) {
        st.pending = pending;
        return;
      }
      st.pending = undefined;
      this.closeOpenBlockForOtherItem(outputIndex, out);
      st.blockIndex = this.nextBlockIndex++;
      st.opened = true;
      this.openOutputIndex = outputIndex;
      out.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index: st.blockIndex, content_block: { type: 'text', text: '' } },
      });
      out.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: st.blockIndex, delta: { type: 'text_delta', text: pending } },
      });
      return;
    }
    out.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: st.blockIndex, delta: { type: 'text_delta', text: delta } },
    });
  }

  private onReasoningSummaryDelta(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    const outputIndex = typeof e.output_index === 'number' ? e.output_index : -1;
    const st = this.blocks.get(outputIndex);
    const delta = typeof e.delta === 'string' ? e.delta : '';
    if (!st || st.kind !== 'thinking') return;
    if (!st.opened) {
      this.closeOpenBlockForOtherItem(outputIndex, out);
      this.openOutputIndex = outputIndex;
      const pending = (st.pending ?? '') + delta;
      if (pending.trim().length === 0) {
        st.pending = pending;
        return;
      }
      st.pending = undefined;
      st.blockIndex = this.nextBlockIndex++;
      st.opened = true;
      out.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index: st.blockIndex, content_block: { type: 'thinking', thinking: '' } },
      });
      out.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: st.blockIndex, delta: { type: 'thinking_delta', thinking: pending } },
      });
      return;
    }
    if (!delta) return;
    out.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: st.blockIndex, delta: { type: 'thinking_delta', thinking: delta } },
    });
  }

  private onFunctionArgsDelta(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    const outputIndex = typeof e.output_index === 'number' ? e.output_index : -1;
    const st = this.blocks.get(outputIndex);
    const delta = typeof e.delta === 'string' ? e.delta : '';
    if (!st || st.kind !== 'function_call' || !st.opened) return;
    if (delta) {
      st.argsSent = (st.argsSent ?? 0) + delta.length;
      out.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: st.blockIndex, delta: { type: 'input_json_delta', partial_json: delta } },
      });
    }
  }

  private onItemDone(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    const outputIndex = typeof e.output_index === 'number' ? e.output_index : -1;
    const st = this.blocks.get(outputIndex);
    if (!st) return;
    const item = asRecord(e.item);
    const rawEncrypted = typeof item.encrypted_content === 'string' ? item.encrypted_content : '';
    const reasoningItemId = st.kind === 'thinking' && typeof item.id === 'string' ? item.id : '';
    const encrypted = rawEncrypted
      ? `${this.signaturePrefix}${reasoningItemId ? `#id=${reasoningItemId}#` : ''}${rawEncrypted}`
      : '';

    if (st.kind === 'thinking') {
      if (st.opened) {
        if (encrypted) {
          out.push({
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: st.blockIndex, delta: { type: 'signature_delta', signature: encrypted } },
          });
        }
        out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: st.blockIndex } });
        st.opened = false;
        if (this.openOutputIndex === outputIndex) this.openOutputIndex = null;
      } else if (encrypted) {
        this.closeOpenBlockForOtherItem(outputIndex, out);
        const blockIndex = this.nextBlockIndex++;
        st.blockIndex = blockIndex;
        out.push({
          event: 'content_block_start',
          data: { type: 'content_block_start', index: blockIndex, content_block: { type: 'redacted_thinking', data: encrypted } },
        });
        out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: blockIndex } });
        st.opened = false;
      }
      st.pending = undefined;
      if (this.openOutputIndex === outputIndex) this.openOutputIndex = null;
    } else if (st.opened) {
      if (st.kind === 'function_call') {
        const fullArgs = typeof item.arguments === 'string' ? item.arguments : '';
        const sent = st.argsSent ?? 0;
        if (fullArgs.length > sent) {
          out.push({
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: st.blockIndex, delta: { type: 'input_json_delta', partial_json: fullArgs.slice(sent) } },
          });
          st.argsSent = fullArgs.length;
        }
      }
      out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: st.blockIndex } });
      st.opened = false;
      if (this.openOutputIndex === outputIndex) this.openOutputIndex = null;
    }
  }

  private onCompleted(e: Record<string, unknown>, out: AnthropicSseEvent[]): void {
    if (this.finished) return;
    this.ensureMessageStart(e, out);
    this.drainDeferred(out, true);
    this.closeAllOpenBlocks(out);

    const resp = asRecord(e.response);
    const usage = mapUsage(resp.usage);
    const stopReason = this.resolveStopReason(resp);
    out.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
        },
      },
    });
    out.push({ event: 'message_stop', data: { type: 'message_stop' } });
    this.finished = true;
  }

  private emitFailure(message: string, out: AnthropicSseEvent[]): void {
    this.deferred = [];
    out.push({
      event: 'error',
      data: { type: 'error', error: { type: 'api_error', message } },
    });
    this.finished = true;
  }

  private closeAllOpenBlocks(out: AnthropicSseEvent[]): void {
    for (const st of this.blocks.values()) {
      if (st.opened && st.blockIndex >= 0) {
        out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: st.blockIndex } });
        st.opened = false;
      }
    }
    this.openOutputIndex = null;
  }

  private resolveStopReason(resp: Record<string, unknown>): string {
    const status = typeof resp.status === 'string' ? resp.status : '';
    if (status === 'incomplete') {
      const details = asRecord(resp.incomplete_details);
      if (details.reason === 'max_output_tokens') return 'max_tokens';
    }
    return this.defaultStopReason();
  }

  private defaultStopReason(): string {
    return this.hasToolUse ? 'tool_use' : 'end_turn';
  }
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function mapUsage(responsesUsage: unknown): AnthropicUsage {
  const u = (responsesUsage ?? {}) as Record<string, unknown>;
  const inputTotal = num(u.input_tokens);
  const inputDetails = (u.input_tokens_details ?? {}) as Record<string, unknown>;
  const cached = num(inputDetails.cached_tokens);
  const cacheWrite = num(inputDetails.cache_write_tokens);
  const output = num(u.output_tokens);
  return {
    input_tokens: Math.max(0, inputTotal - cached - cacheWrite),
    output_tokens: output,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: cacheWrite,
  };
}

interface ContentBlockState {
  index: number;
  block: Record<string, unknown>;
  inputJson: string;
}

type AnthropicMessageCollectionResult =
  | { ok: true; message: Record<string, unknown> }
  | { ok: false; error: { type: string; message: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class AnthropicMessageCollector {
  private message: Record<string, unknown> | null = null;
  private readonly blocks = new Map<number, ContentBlockState>();
  private stopped = false;
  private error: { type: string; message: string } | null = null;

  push(event: { event: string; data: Record<string, unknown> }): void {
    if (this.error || this.stopped) return;

    switch (event.event) {
      case 'message_start':
        this.onMessageStart(event.data);
        break;
      case 'content_block_start':
        this.onBlockStart(event.data);
        break;
      case 'content_block_delta':
        this.onBlockDelta(event.data);
        break;
      case 'content_block_stop':
        this.onBlockStop(event.data);
        break;
      case 'message_delta':
        this.onMessageDelta(event.data);
        break;
      case 'message_stop':
        this.stopped = true;
        break;
      case 'error': {
        const error = isRecord(event.data.error) ? event.data.error : {};
        this.error = {
          type: asString(error.type) || 'api_error',
          message: asString(error.message) || 'upstream response failed',
        };
        break;
      }
      default:
        break;
    }
  }

  finish(): AnthropicMessageCollectionResult {
    if (this.error) return { ok: false, error: this.error };
    if (!this.message || !this.stopped) {
      return {
        ok: false,
        error: {
          type: 'api_error',
          message: 'upstream response did not produce a complete Anthropic message',
        },
      };
    }

    const content = [...this.blocks.values()]
      .sort((a, b) => a.index - b.index)
      .map((state) => state.block);
    if (content.length === 0) {
      return {
        ok: false,
        error: { type: 'api_error', message: 'upstream response contained no content blocks' },
      };
    }
    return { ok: true, message: { ...this.message, content } };
  }

  private onMessageStart(data: Record<string, unknown>): void {
    const message = isRecord(data.message) ? data.message : null;
    if (!message) {
      this.error = { type: 'api_error', message: 'upstream response produced an invalid message_start' };
      return;
    }
    this.message = {
      ...message,
      type: 'message',
      role: 'assistant',
      content: [],
    };
  }

  private onBlockStart(data: Record<string, unknown>): void {
    const index = typeof data.index === 'number' ? data.index : -1;
    const contentBlock = isRecord(data.content_block) ? data.content_block : null;
    if (index < 0 || !contentBlock || this.blocks.has(index)) {
      this.error = { type: 'api_error', message: 'upstream response produced an invalid content block' };
      return;
    }
    this.blocks.set(index, {
      index,
      block: { ...contentBlock },
      inputJson: '',
    });
  }

  private onBlockDelta(data: Record<string, unknown>): void {
    const index = typeof data.index === 'number' ? data.index : -1;
    const state = this.blocks.get(index);
    const delta = isRecord(data.delta) ? data.delta : null;
    if (!state || !delta) {
      this.error = { type: 'api_error', message: 'upstream response produced an orphan content delta' };
      return;
    }

    switch (delta.type) {
      case 'text_delta':
        state.block.text = asString(state.block.text) + asString(delta.text);
        break;
      case 'thinking_delta':
        state.block.thinking = asString(state.block.thinking) + asString(delta.thinking);
        break;
      case 'signature_delta':
        state.block.signature = asString(state.block.signature) + asString(delta.signature);
        break;
      case 'input_json_delta':
        state.inputJson += asString(delta.partial_json);
        break;
      default:
        break;
    }
  }

  private onBlockStop(data: Record<string, unknown>): void {
    const index = typeof data.index === 'number' ? data.index : -1;
    const state = this.blocks.get(index);
    if (!state) {
      this.error = { type: 'api_error', message: 'upstream response stopped an unknown content block' };
      return;
    }
    if (state.block.type !== 'tool_use') return;
    if (!state.inputJson) {
      state.block.input = isRecord(state.block.input) ? state.block.input : {};
      return;
    }
    try {
      state.block.input = JSON.parse(state.inputJson) as unknown;
    } catch {
      this.error = { type: 'api_error', message: 'upstream response produced malformed tool arguments' };
    }
  }

  private onMessageDelta(data: Record<string, unknown>): void {
    if (!this.message) {
      this.error = { type: 'api_error', message: 'upstream response produced message_delta before message_start' };
      return;
    }
    const delta = isRecord(data.delta) ? data.delta : {};
    if ('stop_reason' in delta) this.message.stop_reason = delta.stop_reason ?? null;
    if ('stop_sequence' in delta) this.message.stop_sequence = delta.stop_sequence ?? null;
    if (isRecord(data.usage)) {
      const initialUsage = isRecord(this.message.usage) ? this.message.usage : {};
      this.message.usage = { ...initialUsage, ...data.usage };
    }
  }
}

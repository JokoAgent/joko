import { randomUUID } from 'node:crypto';
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { asLinkspanError, LinkspanError, type LinkspanErrorCode } from '@jokoagent/linkspan-core';
import type { StreamBridgeHost, StreamBridgeRequest } from '@jokoagent/linkspan-core/stream';
import { DesktopMainDocumentOccurrenceAuthority } from './main-document-occurrence.js';

export const DESKTOP_LINKSPAN_CAPTURE = 'joko:linkspan:document';
export const DESKTOP_LINKSPAN_REQUEST = 'joko:linkspan:request';
type Kind = 'iroh' | 'tailcat' | 'http-connect';
type Source = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>;
type Reply = { readonly success: true; readonly value?: unknown } | { readonly success: false; readonly code: LinkspanErrorCode };
interface Entry { readonly host: Promise<StreamBridgeHost>; retired: boolean; closing: boolean }
interface DocumentState {
  readonly authority: DesktopMainDocumentOccurrenceAuthority<WebContents>;
  readonly streams: Map<string, Entry>;
  identities: number;
}

/** Only bounded SDK carrier operations cross IPC; Noise and host authorization stay with the renderer. */
export class DesktopLinkspanHost {
  readonly #documents = new Map<WebContents, DocumentState>();
  #disposed = false;
  constructor(readonly dependencies: {
    readonly assertSource: (event: Source) => void;
    readonly prepare: (kind: Kind) => Promise<void>;
    readonly createHost: (kind: Kind) => Promise<StreamBridgeHost>;
    readonly quitting: () => boolean;
  }) {}

  register(): void {
    ipcMain.on(DESKTOP_LINKSPAN_CAPTURE, (event, claim: unknown) => {
      try { event.returnValue = this.capture(event, claim); }
      catch { event.returnValue = undefined; }
    });
    ipcMain.handle(DESKTOP_LINKSPAN_REQUEST, (event, occurrence: unknown, kind: unknown, message: unknown) => this.request(event, occurrence, kind, message));
  }

  capture(event: Source, claim: unknown): string {
    this.#assertSource(event);
    if (typeof claim !== 'string') throw new LinkspanError('invalid_argument', 'Invalid local document claim.');
    let state = this.#documents.get(event.sender);
    if (state === undefined) {
      if (this.#documents.size >= 128) throw new LinkspanError('resource_exhausted', 'The local document limit was reached.');
      state = { authority: new DesktopMainDocumentOccurrenceAuthority(randomUUID), streams: new Map(), identities: 0 };
      this.#documents.set(event.sender, state);
      const retire = () => this.retire(event.sender);
      event.sender.on('render-process-gone', retire);
      event.sender.once('destroyed', () => { retire(); this.#documents.delete(event.sender); });
      event.sender.on('did-navigate', () => {
        try { this.#assertSource({ sender: event.sender, senderFrame: event.sender.mainFrame }); }
        catch { retire(); }
      });
    }
    const capture = state.authority.capture(event.sender, claim);
    if (capture.retired !== undefined) this.#retireStreams(state);
    return capture.current.occurrence;
  }

  async request(event: Source, occurrence: unknown, value: unknown, input: unknown): Promise<Reply> {
    try {
      this.#assertSource(event);
      const state = this.#documents.get(event.sender);
      const current = () => {
        this.#assertSource(event);
        if (state === undefined || typeof occurrence !== 'string' || !state.authority.isCurrent(event.sender, occurrence)) {
          throw new LinkspanError('closed', 'The original local document retired.');
        }
      };
      current();
      if (value !== 'iroh' && value !== 'tailcat' && value !== 'http-connect') throw new LinkspanError('invalid_argument', 'Invalid selected carrier.');
      const kind = value, message = parseRequest(input), owner = state!;
      if (message.method === 'identity') {
        if (owner.identities >= 4) throw new LinkspanError('resource_exhausted', 'The local identity request limit was reached.');
        owner.identities++;
        let host: StreamBridgeHost | undefined;
        try {
          await this.dependencies.prepare(kind); current();
          host = await this.dependencies.createHost(kind); current();
          const result = await host.request(message); current();
          return { success: true, value: result };
        } finally { owner.identities--; host?.dispose(); }
      }
      const key = `${kind}:${message.streamId}`;
      let entry = owner.streams.get(key);
      if (message.method === 'connect') {
        if (entry !== undefined) throw new LinkspanError('invalid_argument', 'The local stream is already in use.');
        const total = [...this.#documents.values()].reduce((count, item) => count + item.streams.size, 0);
        if (owner.streams.size >= 64 || total >= 128) throw new LinkspanError('resource_exhausted', 'The local connection limit was reached.');
        const selected: Entry = { retired: false, closing: false, host: Promise.resolve().then(async () => {
          current(); await this.dependencies.prepare(kind); current();
          if (selected.retired) throw new LinkspanError('cancelled', 'The original local stream retired.');
          const host = await this.dependencies.createHost(kind);
          try { current(); if (selected.retired) throw new LinkspanError('cancelled', 'The original local stream retired.'); }
          catch (error) { host.dispose(); throw error; }
          return host;
        }) };
        owner.streams.set(key, selected); entry = selected;
      } else if (entry === undefined) {
        if (message.method === 'abort' || message.method === 'close') return { success: true };
        throw new LinkspanError('closed', 'The original local stream is unavailable.');
      }
      const selected = entry;
      if (message.method === 'abort') { this.#retireEntry(owner, key, selected); return { success: true }; }
      if (message.method === 'close') selected.closing = true;
      try {
        const host = await selected.host; current();
        if (selected.retired) throw new LinkspanError('closed', 'The original local stream retired.');
        const result = await host.request(message); current();
        return { success: true, value: result };
      } catch (error) {
        const code = asLinkspanError(error).code;
        if (selected.closing && message.method === 'read' && ['closed', 'cancelled', 'transport_error'].includes(code)) {
          // Native graceful close can reject an outstanding read. Return that
          // error, while the original close owns retirement and its outcome.
          // Source/owner invalidation must still retire the host immediately.
          try { current(); }
          catch (ownerError) { this.#retireEntry(owner, key, selected); throw ownerError; }
        } else this.#retireEntry(owner, key, selected);
        throw error;
      } finally {
        if (message.method === 'close') this.#retireEntry(owner, key, selected);
      }
    } catch (error) { return { success: false, code: asLinkspanError(error).code }; }
  }

  retire(contents: WebContents): void {
    const state = this.#documents.get(contents);
    if (state === undefined) return;
    state.authority.retire(contents); this.#retireStreams(state);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const contents of this.#documents.keys()) this.retire(contents);
    this.#documents.clear();
  }
  #assertSource(event: Source): void {
    if (this.#disposed || this.dependencies.quitting() || event.sender.isDestroyed()) throw new LinkspanError('closed', 'The local connection host stopped.');
    this.dependencies.assertSource(event);
  }
  #retireEntry(state: DocumentState, key: string, entry: Entry): void {
    if (state.streams.get(key) === entry) state.streams.delete(key);
    entry.retired = true;
    void entry.host.then(host => host.dispose(), () => undefined);
  }
  #retireStreams(state: DocumentState): void {
    for (const [key, entry] of state.streams) this.#retireEntry(state, key, entry);
  }
}

function parseRequest(value: unknown): StreamBridgeRequest {
  const invalid = () => new LinkspanError('invalid_argument', 'Invalid local carrier request.');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['method', 'streamId', 'args'].includes(key)) || typeof row['streamId'] !== 'string' || !/^[a-f0-9]{32}$/u.test(row['streamId'])) throw invalid();
  const method = row['method'];
  if (!['connect', 'identity', 'read', 'write', 'abort', 'close'].includes(method as string)) throw invalid();
  if (method === 'write') {
    const bytes = row['args'];
    if (!Array.isArray(bytes) || bytes.length > 128 * 1024 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw invalid();
  } else if (method === 'connect') {
    try { const encoded = JSON.stringify(row['args']); if (!encoded || Buffer.byteLength(encoded) > 32_768) throw invalid(); }
    catch { throw invalid(); }
  } else if (row['args'] !== undefined) throw invalid();
  return row as unknown as StreamBridgeRequest;
}

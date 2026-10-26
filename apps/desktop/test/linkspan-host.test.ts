import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { LinkspanError } from '@jokoagent/linkspan-core';
import { createStreamBridgeHost } from '@jokoagent/linkspan-core/stream';
import type { StreamBridgeHost, StreamBridgeRequest } from '@jokoagent/linkspan-core/stream';
import { expect, it, vi } from 'vitest';
import { DesktopLinkspanHost } from '../src/linkspan-host.js';

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), handle: vi.fn() } }));

function fixture(overrideHost?: StreamBridgeHost) {
  const emitter = Object.assign(new EventEmitter(), { mainFrame: { url: 'joko://app' }, isDestroyed: () => false });
  const contents = emitter as unknown as WebContents;
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const raw: Array<StreamBridgeHost & { messages: StreamBridgeRequest[] }> = [];
  let trusted = true;
  const prepare = vi.fn(async (): Promise<void> => undefined);
  const createHost = vi.fn(async () => {
    if (overrideHost !== undefined) return overrideHost;
    const host = { messages: [] as StreamBridgeRequest[], dispose: vi.fn(), request: vi.fn(async (message: StreamBridgeRequest) => {
      host.messages.push(message);
      if (message.method === 'read') return [1, 2, 255];
      return message.method === 'connect' ? { remoteEndpointId: 'a'.repeat(64) } : undefined;
    }) };
    raw.push(host); return host;
  });
  const bridge = new DesktopLinkspanHost({ prepare, createHost, quitting: () => false, assertSource: source => {
    if (!trusted || source.sender !== contents || source.senderFrame !== contents.mainFrame) throw new Error('untrusted-source');
  } });
  const occurrence = bridge.capture(event, randomUUID());
  return { bridge, event, raw, prepare, createHost, occurrence, emitter, untrust: () => { trusted = false; } };
}

const stream = (number: number) => number.toString(16).padStart(32, '0');
const dial = (id: string): StreamBridgeRequest => ({ method: 'connect', streamId: id, args: { ticket: 'private-ticket', expectedEndpointId: 'a'.repeat(64) } });

it('rejects foreign documents and invalid payloads before loading a selected SDK', async () => {
  const f = fixture();
  expect(await f.bridge.request(f.event, 'stale', 'iroh', dial(stream(1)))).toEqual({ success: false, code: 'closed' });
  expect(await f.bridge.request(f.event, f.occurrence, 'other-provider', dial(stream(1)))).toEqual({ success: false, code: 'invalid_argument' });
  expect(await f.bridge.request(f.event, f.occurrence, 'iroh', { method: 'write', streamId: stream(1), args: new Array(128 * 1024 + 1).fill(0) })).toEqual({ success: false, code: 'invalid_argument' });
  expect(await f.bridge.request(f.event, f.occurrence, 'iroh', { ...dial(stream(1)), arbitraryOperation: true })).toEqual({ success: false, code: 'invalid_argument' });
  f.untrust(); await f.bridge.request(f.event, f.occurrence, 'iroh', dial(stream(1)));
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.createHost).not.toHaveBeenCalled();
  f.bridge.dispose();
});

it('keeps concurrent stream owners independent and disposes all original hosts on document replacement', async () => {
  const f = fixture();
  expect((await f.bridge.request(f.event, f.occurrence, 'iroh', dial(stream(1)))).success).toBe(true);
  expect((await f.bridge.request(f.event, f.occurrence, 'iroh', dial(stream(2)))).success).toBe(true);
  expect(await f.bridge.request(f.event, f.occurrence, 'iroh', { method: 'close', streamId: stream(1) })).toEqual({ success: true, value: undefined });
  expect(f.raw[0]!.dispose).toHaveBeenCalledOnce(); expect(f.raw[1]!.dispose).not.toHaveBeenCalled();
  expect(await f.bridge.request(f.event, f.occurrence, 'iroh', { method: 'read', streamId: stream(2) })).toEqual({ success: true, value: [1, 2, 255] });
  const next = f.bridge.capture(f.event, randomUUID()); expect(next).not.toBe(f.occurrence);
  await vi.waitFor(() => expect(f.raw[1]!.dispose).toHaveBeenCalledOnce());
  expect(await f.bridge.request(f.event, f.occurrence, 'iroh', { method: 'read', streamId: stream(2) })).toEqual({ success: false, code: 'closed' });
  f.bridge.dispose();
});

it('does not create a late host after cancellation or renderer retirement during preparation', async () => {
  const f = fixture(); let release!: () => void;
  f.prepare.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = f.bridge.request(f.event, f.occurrence, 'tailcat', dial(stream(1)));
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
  expect(await f.bridge.request(f.event, f.occurrence, 'tailcat', { method: 'abort', streamId: stream(1) })).toEqual({ success: true });
  release(); expect(await pending).toEqual({ success: false, code: 'cancelled' });
  expect(f.createHost).not.toHaveBeenCalled();
  const second = f.bridge.request(f.event, f.occurrence, 'tailcat', dial(stream(2)));
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(2));
  f.emitter.emit('render-process-gone'); release();
  expect(await second).toEqual({ success: false, code: 'closed' }); expect(f.createHost).not.toHaveBeenCalled();
  f.bridge.dispose();
});

it('reclaims a committed untrusted navigation and returns only stable errors without private payloads', async () => {
  const f = fixture();
  await f.bridge.request(f.event, f.occurrence, 'iroh', dial(stream(1)));
  f.raw[0]!.request = async () => { throw new LinkspanError('identity_mismatch', 'private-ticket and private-key'); };
  expect(await f.bridge.request(f.event, f.occurrence, 'iroh', { method: 'read', streamId: stream(1) })).toEqual({ success: false, code: 'identity_mismatch' });
  await f.bridge.request(f.event, f.occurrence, 'iroh', dial(stream(2)));
  f.untrust(); f.emitter.emit('did-navigate');
  await vi.waitFor(() => expect(f.raw[1]!.dispose).toHaveBeenCalledOnce());
  f.bridge.dispose();
});

it('bounds pending stream owners before loading runtimes', async () => {
  const f = fixture();
  f.prepare.mockImplementation(async () => { throw new LinkspanError('unavailable', 'no selected runtime'); });
  const pending = Array.from({ length: 64 }, (_, index) => f.bridge.request(f.event, f.occurrence, 'iroh', dial(stream(index + 1))));
  expect(await f.bridge.request(f.event, f.occurrence, 'iroh', dial(stream(65)))).toEqual({ success: false, code: 'resource_exhausted' });
  expect((await Promise.all(pending)).every(reply => !reply.success)).toBe(true);
  expect(f.createHost).not.toHaveBeenCalled(); f.bridge.dispose();
});

it.each(['transport_error', 'identity_mismatch'] as const)('keeps close ownership when a pending native read fails with %s', async code => {
  let rejectRead!: (reason: unknown) => void, releaseClose!: () => void, startedRead!: () => void, startedClose!: () => void;
  const readingStarted = new Promise<void>(resolve => { startedRead = resolve; });
  const closingStarted = new Promise<void>(resolve => { startedClose = resolve; });
  const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
  const abort = vi.fn();
  let signal!: AbortSignal;
  const raw = createStreamBridgeHost(async (_args, options) => {
    signal = options.signal!;
    return { remoteEndpointId: 'a'.repeat(64),
      read: () => { startedRead(); return new Promise<Uint8Array | null>((_resolve, reject) => { rejectRead = reject; }); },
      write: async () => {}, abort,
      close: async () => { rejectRead(new LinkspanError(code, 'Controlled pending read failure')); startedClose(); await closeGate; } };
  });
  const f = fixture(raw), id = stream(1);
  try {
    await f.bridge.request(f.event, f.occurrence, 'iroh', dial(id));
    const reading = f.bridge.request(f.event, f.occurrence, 'iroh', { method: 'read', streamId: id });
    await readingStarted;
    const closing = f.bridge.request(f.event, f.occurrence, 'iroh', { method: 'close', streamId: id });
    await closingStarted;
    expect(await reading).toEqual({ success: false, code });
    if (code === 'transport_error') {
      expect(signal.aborted).toBe(false); expect(abort).not.toHaveBeenCalled();
      releaseClose(); expect(await closing).toEqual({ success: true, value: undefined });
    } else {
      expect(await closing).toEqual({ success: false, code: 'cancelled' });
      expect(signal.aborted).toBe(true); expect(abort).toHaveBeenCalled();
    }
  } finally { releaseClose(); f.bridge.dispose(); }
});

it.each(['abort', 'document'] as const)('allows %s retirement to interrupt a pending graceful close', async action => {
  let releaseClose!: () => void, startedClose!: () => void;
  const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
  const closingStarted = new Promise<void>(resolve => { startedClose = resolve; });
  const abort = vi.fn();
  const raw = createStreamBridgeHost(async () => ({ remoteEndpointId: 'a'.repeat(64), read: async () => null, write: async () => {}, abort,
    close: async () => { startedClose(); await closeGate; } }));
  const f = fixture(raw), id = stream(1);
  try {
    await f.bridge.request(f.event, f.occurrence, 'iroh', dial(id));
    const closing = f.bridge.request(f.event, f.occurrence, 'iroh', { method: 'close', streamId: id });
    await closingStarted;
    if (action === 'abort') expect(await f.bridge.request(f.event, f.occurrence, 'iroh', { method: 'abort', streamId: id })).toEqual({ success: true });
    else f.bridge.capture(f.event, randomUUID());
    expect(await closing).toEqual({ success: false, code: 'cancelled' });
    expect(abort).toHaveBeenCalled();
    expect(await f.bridge.request(f.event, f.occurrence, 'iroh', { method: 'read', streamId: id })).toEqual({ success: false, code: 'closed' });
  } finally { releaseClose(); f.bridge.dispose(); }
});

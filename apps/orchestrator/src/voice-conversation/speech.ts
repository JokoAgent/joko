import { MAXIMUM_ENCODED_SPEECH_BYTES } from '@joko/contracts';
import {
  speechAdapter,
  speechRequest,
  speechTextSegments,
  type SpeechConnection,
} from './speech-protocols.js';
import { SpeechError } from './speech-error.js';
export type { SpeechConnection } from './speech-protocols.js';
export type SpeechDiagnostic = {
  stage: 'request' | 'headers' | 'first_pcm' | 'first_encoded' | 'complete' | 'cancelled' | 'error';
  requestId: string;
  protocol: SpeechConnection['protocol'];
  elapsedMs: number;
  bytes: number;
  httpStatus?: number;
  code?: SpeechError['code'] | 'headers_timeout' | 'read_timeout';
};
export type SpeechStartResult = { readonly sampleRate: number } | { readonly encoding: 'mp3' };
interface SpeechReadResult {
  readonly done: boolean;
  readonly pcm: ArrayBuffer;
  readonly encodedSpeech?: ArrayBuffer;
}

const MAXIMUM_SPEECH_CHUNK_BYTES = 1_048_576;

/** Pull-driven speech transport with bounded PCM and encoded responses. */
export class SpeechSynthesisSession {
  private epoch = 0;
  private controller: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private requestId: string | null = null;
  private totalBytes = 0;
  private reading = false;
  private encoded = false;
  private encodedRemainder: Uint8Array | undefined;
  private diagnostic?: (
    stage: SpeechDiagnostic['stage'],
    details?: Pick<SpeechDiagnostic, 'httpStatus' | 'code'>,
  ) => void;

  constructor(
    private readonly deps: {
      connection(): SpeechConnection;
      assertCurrent(): void;
      fetch: typeof fetch;
      diagnostic?(event: SpeechDiagnostic): void;
    },
  ) {}

  async start(input: {
    requestId: string;
    modelId: string;
    voice: string;
    text: string;
    speed?: number;
  }): Promise<SpeechStartResult> {
    this.cancel();
    const epoch = this.epoch;
    this.deps.assertCurrent();
    const connection = this.deps.connection();
    const texts = speechTextSegments(input.text, connection.protocol);
    const requests = texts.map((text) => speechRequest(connection, { ...input, text }));
    const encoded = requests[0]?.encoding === 'mp3';
    this.encoded = encoded;
    const adapter = speechAdapter(connection.protocol);
    const controller = new AbortController();
    this.controller = controller;
    this.requestId = input.requestId;
    const startedAt = Date.now();
    this.diagnostic = (stage, details = {}) =>
      this.deps.diagnostic?.({
        stage,
        requestId: input.requestId,
        protocol: connection.protocol,
        elapsedMs: Date.now() - startedAt,
        bytes: this.totalBytes,
        ...details,
      });
    this.diagnostic('request');
    const open = async (index: number): Promise<ReadableStream<Uint8Array>> => {
      this.deps.assertCurrent();
      if (epoch !== this.epoch || controller.signal.aborted) throw new SpeechError('cancelled');
      const { url, body, headers } = requests[index]!;
      let timedOut = false;
      const timer = setTimeout(() => {
        if (epoch !== this.epoch) return;
        timedOut = true;
        controller.abort();
      }, 30_000);
      let response: Response | undefined;
      try {
        response = await this.deps.fetch(url, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { ...connection.headers, 'Content-Type': 'application/json', ...headers },
          body,
        });
        this.deps.assertCurrent();
        if (epoch !== this.epoch || controller.signal.aborted) throw new SpeechError('cancelled');
        this.diagnostic?.('headers', { httpStatus: response.status });
        if (!response.ok || !response.body) throw new SpeechError('request');
        const contentType = response.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase();
        if (encoded ? contentType !== 'audio/mpeg' : !contentType || !adapter.contentTypes.includes(contentType))
          throw new SpeechError('format');
        if (encoded && Number(response.headers.get('content-length')) > MAXIMUM_ENCODED_SPEECH_BYTES) {
          throw new SpeechError('format');
        }
        return encoded ? response.body : adapter.pcm(response.body);
      } catch (error) {
        if (response?.body && !response.body.locked)
          void response.body.cancel().catch(() => undefined);
        if (timedOut && epoch === this.epoch) {
          this.diagnostic?.('error', { code: 'headers_timeout' });
          // Let start/read own cancellation so a pending read receives the
          // timeout error before cancellation can resolve it as stream EOF.
          throw new SpeechError('timeout');
        }
        throw error instanceof SpeechError ? error : new SpeechError('request');
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const first = await open(0);
      // open() validates before returning; cancel/start can still happen at this
      // await boundary. Never install a stale reader over a replacement request.
      if (epoch !== this.epoch || controller.signal.aborted) {
        void first.cancel().catch(() => undefined);
        throw new SpeechError('cancelled');
      }
      this.reader = sequentialSpeech(first, requests.length, open, encoded, () => {
        if (epoch === this.epoch) this.diagnostic?.('error', { code: 'read_timeout' });
      }).getReader();
      return encoded ? { encoding: 'mp3' } : { sampleRate: 24_000 };
    } catch (error) {
      if (epoch === this.epoch) {
        // Timeouts already identify their phase in diagnostics.
        if (!(error instanceof SpeechError && error.code === 'timeout'))
          this.diagnostic?.('error', {
            code: error instanceof SpeechError ? error.code : 'request',
          });
        this.cancel('failed');
      }
      throw error instanceof SpeechError ? error : new SpeechError('request');
    }
  }

  async read(requestId: string): Promise<SpeechReadResult> {
    try {
      this.deps.assertCurrent();
    } catch (error) {
      this.cancel();
      throw error;
    }
    if (requestId !== this.requestId || !this.reader || this.reading)
      throw new SpeechError('cancelled');
    const reader = this.reader;
    const epoch = this.epoch;
    this.reading = true;
    try {
      if (this.encodedRemainder !== undefined) return this.encodedChunk(this.encodedRemainder, false);
      const result = await reader.read();
      this.deps.assertCurrent();
      if (epoch !== this.epoch) throw new SpeechError('cancelled');
      const value = result.value ?? new Uint8Array();
      const first = this.totalBytes === 0 && value.byteLength > 0;
      this.totalBytes += value.byteLength;
      const tooLarge = this.encoded ? this.totalBytes > MAXIMUM_ENCODED_SPEECH_BYTES
        : value.byteLength > MAXIMUM_SPEECH_CHUNK_BYTES || this.totalBytes > 24_000 * 2 * 600;
      if (tooLarge) {
        throw new SpeechError('format');
      }
      if (first) this.diagnostic?.(this.encoded ? 'first_encoded' : 'first_pcm');
      if (result.done) {
        if (this.totalBytes === 0 || !this.encoded && this.totalBytes % 2 !== 0) throw new SpeechError('format');
        reader.releaseLock();
        this.reader = null;
        this.requestId = null;
        this.diagnostic?.('complete');
        this.diagnostic = undefined;
      }
      return this.encoded ? this.encodedChunk(value, result.done) : { pcm: Uint8Array.from(value).buffer, done: result.done };
    } catch (error) {
      if (epoch === this.epoch) {
        if (!(error instanceof SpeechError && error.code === 'timeout'))
          this.diagnostic?.('error', {
            code: error instanceof SpeechError ? error.code : 'request',
          });
        this.cancel('failed');
      }
      throw error instanceof SpeechError ? error : new SpeechError('request');
    } finally {
      if (epoch === this.epoch) this.reading = false;
    }
  }

  private encodedChunk(value: Uint8Array, done: boolean): SpeechReadResult {
    // Keep the existing per-read size bound even if fetch supplied one large encoded chunk.
    this.encodedRemainder = value.byteLength > MAXIMUM_SPEECH_CHUNK_BYTES ? value.subarray(MAXIMUM_SPEECH_CHUNK_BYTES) : undefined;
    return { pcm: new ArrayBuffer(0), encodedSpeech: Uint8Array.from(value.subarray(0, MAXIMUM_SPEECH_CHUNK_BYTES)).buffer, done };
  }

  cancel(reason: 'interrupted' | 'failed' = 'interrupted'): void {
    if (reason === 'interrupted') this.diagnostic?.('cancelled');
    this.diagnostic = undefined;
    ++this.epoch;
    this.controller?.abort();
    this.controller = null;
    void this.reader?.cancel().catch(() => undefined);
    this.reader = null;
    this.requestId = null;
    this.reading = false;
    this.totalBytes = 0;
    this.encoded = false;
    this.encodedRemainder = undefined;
  }
}

/** Open the next segment only after the current audio is consumed. Cancelling a
 * preview/call aborts its fetch and prevents any remaining billable requests. */
function sequentialSpeech(
  first: ReadableStream<Uint8Array>,
  count: number,
  open: (index: number) => Promise<ReadableStream<Uint8Array>>,
  encoded: boolean,
  onReadTimeout: () => void,
): ReadableStream<Uint8Array> {
  let reader = first.getReader();
  let index = 0;
  let bytes = 0;
  let cancelled = false;
  // Opening a later segment has its own deadline for response headers.
  const read = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            onReadTimeout();
            reject(new SpeechError('timeout'));
          }, 15_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (!cancelled) {
            const result = await read();
            if (cancelled) return;
            if (!result.done) {
              bytes += result.value.byteLength;
              controller.enqueue(result.value);
              return;
            }
            if (bytes === 0 || !encoded && bytes % 2 !== 0) throw new SpeechError('format');
            reader.releaseLock();
            if (++index === count) {
              controller.close();
              return;
            }
            const next = await open(index);
            if (cancelled) {
              await next.cancel();
              return;
            }
            reader = next.getReader();
            bytes = 0;
          }
        } catch (error) {
          void reader.cancel().catch(() => undefined);
          controller.error(error);
        }
      },
      cancel() {
        cancelled = true;
        return reader.cancel().catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

import { afterEach, expect, it, vi } from 'vitest';
import { createSpeechFetch } from './fetch.js';
afterEach(() => vi.unstubAllGlobals());
it('keeps synthesis pull-driven, refuses redirects, and cancels the original response on abort', async () => {
  const cancelled = vi.fn(); let pulls = 0;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.redirect).toBe('error');
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array([1, 2])); }, cancel: cancelled }, { highWaterMark: 0 }),
      { headers: { 'content-type': 'audio/pcm' } });
  });
  vi.stubGlobal('fetch', fetcher);
  const abort = new AbortController(), send = createSpeechFetch(async () => null);
  const response = await send('https://provider.test/v1/audio/speech', { method: 'POST', signal: abort.signal });
  expect(pulls).toBe(0);
  const reader = response.body!.getReader(); expect((await reader.read()).value).toEqual(new Uint8Array([1, 2])); expect(pulls).toBe(1);
  abort.abort(); await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  await expect(reader.read()).rejects.toBeDefined();
});

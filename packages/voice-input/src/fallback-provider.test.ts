import { describe, expect, it, vi } from "vitest";
import { FallbackAsrProvider } from "./fallback-provider.js";
import type { AsrEvent, AsrProvider } from "./types.js";

describe("FallbackAsrProvider", () => {
  it("hides a failed primary and activates the first route whose handshake succeeds", async () => {
    const primary = provider({ startError: new Error("primary unavailable") });
    const backup = provider();
    const events: AsrEvent[] = [];
    const fallback = new FallbackAsrProvider([() => primary, () => backup]);
    fallback.onEvent((event) => events.push(event));

    await fallback.start({ runId: "run-1", mimeType: "audio/pcm", locale: "en" });
    fallback.appendAudio({ data: new ArrayBuffer(4), durationMs: 1, voiced: true });
    await fallback.flushAudio();

    expect(primary.stop).toHaveBeenCalledOnce();
    expect(backup.appendAudio).toHaveBeenCalledOnce();
    expect(events).toEqual([{ type: "connected" }]);
  });

  it("proxies recovery only after a route is active and closes exactly once", async () => {
    const route = provider();
    const fallback = new FallbackAsrProvider([() => route]);
    await fallback.start({ runId: "run-1", mimeType: "audio/pcm" });
    await fallback.recover();
    await fallback.stop();
    await fallback.stop();

    expect(route.recover).toHaveBeenCalledOnce();
    expect(route.stop).toHaveBeenCalledOnce();
  });
});

function provider(options: { readonly startError?: Error } = {}): AsrProvider & Record<string, ReturnType<typeof vi.fn>> {
  let listener: ((event: AsrEvent) => void) | undefined;
  return {
    start: vi.fn(async () => {
      if (options.startError !== undefined) throw options.startError;
      listener?.({ type: "connected" });
    }),
    appendAudio: vi.fn(),
    flushAudio: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    recover: vi.fn(async () => undefined),
    onEvent: vi.fn((value: (event: AsrEvent) => void) => {
      listener = value;
      return () => { if (listener === value) listener = undefined; };
    })
  } as AsrProvider & Record<string, ReturnType<typeof vi.fn>>;
}

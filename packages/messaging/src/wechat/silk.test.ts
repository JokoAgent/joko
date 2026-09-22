import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { encode } from "silk-wasm";

import { decodeWeChatSilk } from "./silk.js";

describe("WeChat bounded SILK decoding", () => {
  it("decodes a real 24 kHz SILK payload into a mono 16-bit WAV", async () => {
    const pcm = Buffer.alloc(24_000 / 10 * 2);
    const silk = await encode(pcm, 24_000);
    const wav = await decodeWeChatSilk(silk.data, new AbortController().signal);
    const header = Buffer.from(wav);
    expect(header.toString("ascii", 0, 4)).toBe("RIFF");
    expect(header.toString("ascii", 8, 12)).toBe("WAVE");
    expect(header.readUInt32LE(24)).toBe(24_000);
    expect(header.readUInt16LE(22)).toBe(1);
    expect(header.readUInt16LE(34)).toBe(16);
    expect(wav.byteLength).toBeGreaterThan(44);
  });

  it("terminates a stalled decoder on deadline or cancellation", async () => {
    const created: FakeWorker[] = [];
    const createWorker = (): Worker => { const worker = new FakeWorker(); created.push(worker); return worker as unknown as Worker; };
    await expect(decodeWeChatSilk(Buffer.from("payload"), new AbortController().signal, { createWorker, timeoutMs: 10 }))
      .rejects.toMatchObject({ code: "malformed_response" });
    expect(created[0]?.terminate).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const pending = decodeWeChatSilk(Buffer.from("payload"), controller.signal, { createWorker });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(created[1]?.terminate).toHaveBeenCalledOnce();
  });
});

class FakeWorker extends EventEmitter {
  readonly terminate = vi.fn(async () => 0);
  postMessage(): void {}
  unref(): this { return this; }
}

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ delay: vi.fn(async () => {}) }));
vi.mock("node:timers/promises", () => ({ setTimeout: runtime.delay }));

const inputUrl = new URL("../scripts/native-build-input.mjs", import.meta.url).href;
const { downloadPinnedInput } = await import(inputUrl) as {
  downloadPinnedInput(url: URL, expectedDigest: string, maximumBytes: number): Promise<Buffer>;
};
const url = new URL("https://artifacts.electronjs.org/headers/dist/v43.6.0/x64/node.lib");
const bytes = Buffer.from("pinned native build input");
const digest = createHash("sha256").update(bytes).digest("hex");
const fetchInput = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchInput.mockReset();
  runtime.delay.mockClear();
  vi.stubGlobal("fetch", fetchInput);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pinned Electron build input downloads", () => {
  it("retries a timed-out request with the same input and a fresh deadline", async () => {
    const deadlines = vi.spyOn(AbortSignal, "timeout");
    fetchInput.mockRejectedValueOnce(new DOMException("Download timed out", "TimeoutError"))
      .mockResolvedValueOnce(new Response(bytes));

    expect(await downloadPinnedInput(url, digest, bytes.length)).toEqual(bytes);
    expect(fetchInput).toHaveBeenCalledTimes(2);
    for (const [requestedUrl, options] of fetchInput.mock.calls) {
      expect(requestedUrl).toBe(url);
      expect(options).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
    }
    expect(deadlines.mock.calls).toEqual([[30_000], [30_000]]);
    expect(fetchInput.mock.calls[0]![1]!.signal).not.toBe(fetchInput.mock.calls[1]![1]!.signal);
    expect(runtime.delay.mock.calls).toEqual([[250]]);
  });

  it("discards a partial body after a reset and verifies only the complete retry", async () => {
    let pulls = 0;
    const interrupted = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(Buffer.from("discard this partial input"));
        else controller.error(new TypeError("terminated", { cause: { code: "ECONNRESET" } }));
      }
    });
    fetchInput.mockResolvedValueOnce(new Response(interrupted)).mockResolvedValueOnce(new Response(bytes));

    expect(await downloadPinnedInput(url, digest, 1024)).toEqual(bytes);
    expect(fetchInput).toHaveBeenCalledTimes(2);
  });

  it("retries a body abort caused by its download deadline", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    fetchInput.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        deadline.abort(new DOMException("Download timed out", "TimeoutError"));
        controller.error(new DOMException("The operation was aborted", "AbortError"));
      }
    }))).mockResolvedValueOnce(new Response(bytes));

    expect(await downloadPinnedInput(url, digest, bytes.length)).toEqual(bytes);
    expect(fetchInput).toHaveBeenCalledTimes(2);
  });

  it.each([429, 500, 502, 503, 504])("cancels HTTP %s before retrying", async status => {
    const cancel = vi.fn();
    fetchInput.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }))
      .mockImplementationOnce(async () => {
        expect(cancel).toHaveBeenCalledOnce();
        return new Response(bytes);
      });

    expect(await downloadPinnedInput(url, digest, bytes.length)).toEqual(bytes);
    expect(fetchInput).toHaveBeenCalledTimes(2);
  });

  it("stops after three transient failures and identifies the failed input", async () => {
    fetchInput.mockRejectedValue(new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }));

    await expect(downloadPinnedInput(url, digest, bytes.length)).rejects.toThrow(`${url.pathname} after 3 attempts`);
    expect(fetchInput).toHaveBeenCalledTimes(3);
    expect(runtime.delay.mock.calls).toEqual([[250], [500]]);
  });

  it.each(["integrity", "size", "redirect", "authorization", "certificate", "abort"])(
    "does not retry a permanent %s failure", async defect => {
      if (defect === "redirect") fetchInput.mockRejectedValue(new TypeError("fetch failed", { cause: new Error("unexpected redirect") }));
      else if (defect === "certificate") fetchInput.mockRejectedValue(new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } }));
      else if (defect === "abort") fetchInput.mockRejectedValue(new DOMException("Cancelled", "AbortError"));
      else fetchInput.mockResolvedValue(new Response(bytes, { status: defect === "authorization" ? 403 : 200 }));

      await expect(downloadPinnedInput(url, defect === "integrity" ? "0".repeat(64) : digest,
        defect === "size" ? bytes.length - 1 : bytes.length)).rejects.toThrow();
      expect(fetchInput).toHaveBeenCalledOnce();
      expect(runtime.delay).not.toHaveBeenCalled();
    }
  );
});

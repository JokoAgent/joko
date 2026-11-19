const MAXIMUM_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_EVENT_CHARACTERS = 1024 * 1024;

/** Read bounded SSE data events or the complete JSON body under the current request authority. */
export async function* readManagedProviderResponse(input: {
  readonly body: ReadableStream<Uint8Array>;
  readonly sse: boolean;
  readonly assertCurrent: () => void;
}): AsyncGenerator<string> {
  const reader = input.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let bytes = 0;
  let ended = false;
  let data: string[] = [];
  let eventCharacters = 0;
  try {
    for (;;) {
      input.assertCurrent();
      const chunk = await reader.read();
      input.assertCurrent();
      if (chunk.done) {
        ended = true;
        pending += decoder.decode();
      } else {
        bytes += chunk.value.byteLength;
        if (bytes > MAXIMUM_RESPONSE_BYTES) throw new Error("The Provider response exceeded its size limit.");
        pending += decoder.decode(chunk.value, { stream: true });
      }
      if (!input.sse) {
        if (ended) { yield pending; return; }
        continue;
      }
      if (ended) pending += "\n\n";
      let start = 0;
      let newline: number;
      while ((newline = pending.indexOf("\n", start)) >= 0) {
        const line = pending.slice(start, newline).replace(/\r$/u, "");
        start = newline + 1;
        if (line === "") {
          if (data.length > 0) yield data.join("\n");
          data = [];
          eventCharacters = 0;
        } else if (line.startsWith("data:")) {
          const value = line.slice(5).replace(/^ /u, "");
          eventCharacters += value.length + 1;
          if (eventCharacters > MAXIMUM_EVENT_CHARACTERS) throw new Error("A Provider stream event exceeded its size limit.");
          data.push(value);
        }
      }
      if (start > 0) pending = pending.slice(start);
      if (pending.length > MAXIMUM_EVENT_CHARACTERS) throw new Error("A Provider stream line exceeded its size limit.");
      if (ended) return;
    }
  } finally {
    if (!ended) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

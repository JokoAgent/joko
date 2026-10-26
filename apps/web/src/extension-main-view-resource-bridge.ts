/** A browser surface can read only media in its own already authorized directory.
 * Requests retain the current pinned connection and the current document epoch. */
export function bindExtensionSurfaceResources(frame: HTMLIFrameElement, input: {
  readonly resourceRoot: string;
  readonly fetch: typeof globalThis.fetch;
  readonly signal: AbortSignal;
  readonly current: () => boolean;
  readonly navigate: (url: string) => void;
}): () => void {
  const owner = frame.ownerDocument.defaultView!, root = new URL(input.resourceRoot);
  let stopped = false;
  const pending = new Set<string>();
  const current = () => !stopped && !input.signal.aborted && frame.isConnected && input.current();
  const reply = (id: string, result: { ok: false } | { ok: true; blob?: Blob; dataUrl?: string }) => {
    if (current()) frame.contentWindow?.postMessage({ type: "joko:extension-resource-result", version: 1, id, ...result }, "*");
  };
  const receive = (event: MessageEvent) => {
    if (!current() || event.source !== frame.contentWindow || event.origin !== "null" || event.data === null || typeof event.data !== "object") return;
    const request = event.data as { type?: string; version?: number; id?: string; kind?: string; url?: string; text?: string };
    if (request.type !== "joko:extension-resource" || request.version !== 1 || typeof request.id !== "string" || !/^resource_[0-9]{1,20}$/u.test(request.id)
      || typeof request.url !== "string" || request.url.length > 4096 || !["media", "navigate", "script", "module", "style", "style-text"].includes(request.kind ?? "") || pending.has(request.id)) return;
    const id = request.id;
    if (request.kind === "style-text" ? typeof request.text !== "string" || request.text.length > 16 * 1024 * 1024 || new TextEncoder().encode(request.text).byteLength > 16 * 1024 * 1024 : request.text !== undefined) { reply(id, { ok: false }); return; }
    let url: URL;
    try {
      url = new URL(request.url);
      if (url.origin !== root.origin || url.username || url.password || url.search || !url.pathname.startsWith(root.pathname)) throw new Error("Resource is outside its surface.");
    } catch { reply(id, { ok: false }); return; }
    if (request.kind === "navigate") {
      if (url.pathname.endsWith(".html")) input.navigate(url.href); else reply(id, { ok: false });
      return;
    }
    if (pending.size >= 64) { reply(id, { ok: false }); return; }
    pending.add(id); url.hash = "";
    const init: RequestInit = request.kind === "style-text" ? { method: "POST", headers: { "content-type": "text/css", "x-joko-isolated-document": "style-text" }, body: request.text, signal: input.signal }
      : request.kind !== "media" ? { headers: { "x-joko-isolated-document": request.kind! }, signal: input.signal } : { signal: input.signal };
    void input.fetch(url.href, init).then(async response => {
      const media = request.kind === "media", stylesheet = request.kind === "style" || request.kind === "style-text";
      const mime = response.headers.get("content-type") ?? "";
      if (!current() || !response.ok || !(media ? /^(?:image|audio|video)\//u.test(mime) : stylesheet ? /^text\/css(?:;|$)/u.test(mime) : /^(?:text|application)\/javascript(?:;|$)/u.test(mime))) {
        await response.body?.cancel(); throw new Error("Surface media is unavailable.");
      }
      const maximum = 256 * 1024 * 1024;
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > maximum) { await response.body?.cancel(); throw new Error("Surface media is too large."); }
      const parts: ArrayBuffer[] = [], reader = response.body?.getReader(); let bytes = 0, complete = false;
      if (reader !== undefined) try {
        for (;;) {
          if (!current()) throw new Error("Surface media retired.");
          const value = await reader.read(); if (value.done) { complete = true; break; }
          bytes += value.value.byteLength;
          if (bytes > maximum) throw new Error("Surface media is too large.");
          parts.push(new Uint8Array(value.value).buffer);
        }
      } finally { if (!complete) await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const blob = new Blob(parts, { type: response.headers.get("content-type")! });
      if (!current() || blob.size > maximum) throw new Error("Surface media changed.");
      if (media) reply(id, { ok: true, blob });
      else {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          const cancel = () => { reader.abort(); reject(new DOMException("Surface document retired.", "AbortError")); };
          input.signal.addEventListener("abort", cancel, { once: true });
          reader.onload = () => { input.signal.removeEventListener("abort", cancel); typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Invalid code resource.")); };
          reader.onerror = () => { input.signal.removeEventListener("abort", cancel); reject(reader.error); };
          reader.readAsDataURL(blob);
        });
        if (current()) reply(id, { ok: true, dataUrl });
      }
    }).catch(() => reply(id, { ok: false })).finally(() => pending.delete(id));
  };
  owner.addEventListener("message", receive);
  const dispose = () => { stopped = true; pending.clear(); owner.removeEventListener("message", receive); input.signal.removeEventListener("abort", dispose); };
  input.signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}

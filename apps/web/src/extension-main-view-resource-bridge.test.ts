// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { bindExtensionSurfaceResources } from "./extension-main-view-resource-bridge.js";

const root = `https://pinned.example/v1/extensions/main-views/extension_surface_${"a".repeat(32)}/${"b".repeat(64)}/`;
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
const settle = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };

it("reads only media in the original surface, keeps navigation scoped and closes rejected bodies", async () => {
  const frame = document.body.appendChild(document.createElement("iframe")), abort = new AbortController();
  const cancel = vi.fn();
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("not-media.txt")
    ? new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/plain" } })
    : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
  const navigate = vi.fn();
  const dispose = bindExtensionSurfaceResources(frame, { resourceRoot: root, signal: abort.signal, fetch: fetcher, current: () => true, navigate });
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  const send = (id: number, kind: string, url: string, source: MessageEventSource = frame.contentWindow!) => window.dispatchEvent(new MessageEvent("message", {
    source, origin: "null", data: { type: "joko:extension-resource", version: 1, id: `resource_${id}`, kind, url }
  }));
  send(1, "media", `${root}icon.png#view`); await settle();
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${root}icon.png`, { signal: abort.signal });
  expect(post.mock.calls[0]?.[0]).toMatchObject({ type: "joko:extension-resource-result", id: "resource_1", ok: true, blob: { size: 3, type: "image/png" } });
  send(2, "media", "https://another.example/private.png");
  send(3, "media", "https://pinned.example/v1/credentials/secret");
  send(4, "media", `${root}icon.png?secret=1`);
  send(5, "media", `${root}icon.png`, window);
  expect(fetcher).toHaveBeenCalledTimes(1);
  send(6, "navigate", `${root}sub/next.html#target`); expect(navigate).toHaveBeenCalledExactlyOnceWith(`${root}sub/next.html#target`);
  send(7, "media", `${root}not-media.txt`); await settle(); expect(cancel).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ id: "resource_7", ok: false }), "*");
  abort.abort(); dispose();
});

it("discards media returned after its original document epoch retires", async () => {
  const frame = document.body.appendChild(document.createElement("iframe")), abort = new AbortController();
  let finish!: (value: Response) => void, current = true;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  const dispose = bindExtensionSurfaceResources(frame, { resourceRoot: root, signal: abort.signal, fetch: fetcher, current: () => current, navigate: vi.fn() });
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow!, origin: "null", data: { type: "joko:extension-resource", version: 1, id: "resource_1", kind: "media", url: `${root}icon.png` } }));
  current = false;
  const cancel = vi.fn(); finish(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "image/png" } }));
  await settle(); expect(cancel).toHaveBeenCalledOnce(); expect(post).not.toHaveBeenCalled();
  abort.abort(); dispose();
});

it("keeps runtime module and CSS transformation requests on the current private surface", async () => {
  const frame = document.body.appendChild(document.createElement("iframe")), abort = new AbortController();
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const stylesheet = new Headers(init?.headers).get("x-joko-isolated-document") === "style-text";
    return new Response(stylesheet ? "body{color:red}" : "export const answer=42;", { headers: { "content-type": stylesheet ? "text/css" : "text/javascript" } });
  });
  const dispose = bindExtensionSurfaceResources(frame, { resourceRoot: root, signal: abort.signal, fetch: fetcher, current: () => true, navigate: vi.fn() });
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  const send = (id: number, kind: string, url: string, text?: string) => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow!, origin: "null",
    data: { type: "joko:extension-resource", version: 1, id: `resource_${id}`, kind, url, ...(text === undefined ? {} : { text }) } }));
  try {
    send(1, "module", `${root}runtime.js`);
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ id: "resource_1", ok: true, dataUrl: expect.stringMatching(/^data:text\/javascript.*;base64,/u) }), "*"));
    expect(fetcher).toHaveBeenCalledWith(`${root}runtime.js`, { headers: { "x-joko-isolated-document": "module" }, signal: abort.signal });
    send(2, "style-text", `${root}index.html`, "body{color:red}");
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ id: "resource_2", ok: true, dataUrl: expect.stringMatching(/^data:text\/css.*;base64,/u) }), "*"));
    expect(fetcher).toHaveBeenCalledWith(`${root}index.html`, { method: "POST", headers: { "content-type": "text/css", "x-joko-isolated-document": "style-text" }, body: "body{color:red}", signal: abort.signal });
    send(3, "style-text", `${root}index.html`);
    send(4, "script", `${root}runtime.js`, "unexpected source");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ id: "resource_3", ok: false }), "*");
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ id: "resource_4", ok: false }), "*");
  } finally { abort.abort(); dispose(); }
});

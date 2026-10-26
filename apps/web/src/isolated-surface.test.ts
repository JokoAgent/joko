// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mountIsolatedSurface } from "./isolated-surface.js";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it("delivers private bytes only once to the exact opaque bootstrap epoch", async () => {
  const frame = document.body.appendChild(document.createElement("iframe"));
  frame.setAttribute("sandbox", "allow-scripts");
  const abort = new AbortController(), failed = vi.fn();
  const dispose = mountIsolatedSurface(frame, Promise.resolve({ html: "private document", policy: "default-src 'none'" }), { signal: abort.signal, failed });
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  const nonce = new URL(frame.src).hash.slice(1);
  const ready = (source: MessageEventSource, origin: string, epoch: string) => window.dispatchEvent(new MessageEvent("message", {
    source, origin, data: { type: "joko:isolated-ready", nonce: epoch }
  }));
  await Promise.resolve();
  ready(window, "null", nonce); ready(frame.contentWindow!, "https://wrong.example", nonce); ready(frame.contentWindow!, "null", "wrong");
  expect(post).not.toHaveBeenCalled();
  ready(frame.contentWindow!, "null", nonce); ready(frame.contentWindow!, "null", nonce);
  expect(post).toHaveBeenCalledExactlyOnceWith({ type: "joko:isolated-document", nonce, html: "private document", policy: "default-src 'none'" }, "*");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts"); expect(frame.src).not.toContain("private");
  dispose(); expect(failed).not.toHaveBeenCalled();
});

it("discards a late document and ready notification after retirement", async () => {
  const frame = document.body.appendChild(document.createElement("iframe"));
  let finish!: (value: { html: string; policy: string }) => void;
  const sourceDocument = new Promise<{ html: string; policy: string }>(resolve => { finish = resolve; });
  const abort = new AbortController(), failed = vi.fn();
  mountIsolatedSurface(frame, sourceDocument, { signal: abort.signal, failed });
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  const nonce = new URL(frame.src).hash.slice(1); abort.abort();
  finish({ html: "late private document", policy: "default-src 'none'" }); await Promise.resolve();
  window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow!, origin: "null", data: { type: "joko:isolated-ready", nonce } }));
  expect(post).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
});

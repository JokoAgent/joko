import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { withHtmlPreviewCsp } from "./mobile-file-html";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

it("puts the document policy and top-realm guard before author code, preserving interaction and standard layout", () => {
  for (const prelude of ["", "\uFEFF", "<!-- <head> -->", "<?xml version='1.0'?><!doctype html>"]) {
    const html = prelude + '<script>window.observed=[navigator.mediaDevices,Navigator.prototype.webkitGetUserMedia,window.RTCPeerConnection];</script>'
      + '<button id="go" onclick="this.textContent=\'done\'">action</button><iframe></iframe>';
    const dom = new JSDOM(withHtmlPreviewCsp(html), { runScripts: "dangerously", beforeParse(window: Window & typeof globalThis) {
      for (const key of ["mediaDevices", "getUserMedia", "webkitGetUserMedia", "mozGetUserMedia"]) {
        Object.defineProperty(window.Navigator.prototype, key, { value: () => undefined, configurable: true });
      }
      Object.defineProperty(window, "RTCPeerConnection", { value: () => undefined, configurable: true });
    } });
    const window = dom.window;
    expect((window as unknown as { observed: unknown[] }).observed).toEqual([undefined, undefined, undefined]);
    expect(window.document.compatMode).toBe("CSS1Compat");
    const policy = window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
    for (const rule of ["connect-src 'none'", "frame-src 'none'", "object-src 'none'", "form-action 'none'", "script-src 'unsafe-inline' data:"]) expect(policy).toContain(rule);
    expect(Object.getOwnPropertyDescriptor(window.Navigator.prototype, "mediaDevices")).toMatchObject({ configurable: false, writable: false });
    expect(window.document.querySelector("iframe")!.contentWindow).toBeNull();
    window.document.getElementById("go")!.click(); expect(window.document.getElementById("go")!.textContent).toBe("done");
    window.close();
  }
});

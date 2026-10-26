/* This file is part of the trusted client distribution. The frame remains opaque. */
(() => {
  "use strict";
  const nonce = location.hash.slice(1);
  const parentOrigin = location.protocol + "//" + location.host;
  if (!/^v1-[a-f0-9]{32}$/.test(nonce) || parent === window) return;
  const escape = value => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const receive = event => {
    const message = event.data;
    if (event.source !== parent || event.origin !== parentOrigin || !message || message.type !== "joko:isolated-document" || message.nonce !== nonce
      || typeof message.html !== "string" || typeof message.policy !== "string" || !message.policy || message.policy.length > 16384) return;
    removeEventListener("message", receive);
    if (typeof message.baseUrl === "string") {
      const logical = new URL(message.baseUrl);
      if (!["http:", "https:"].includes(logical.protocol) || logical.username || logical.password) return;
      Reflect.set(globalThis, Symbol.for("joko.extension.surface.base"), logical.href);
      location.hash = logical.hash;
    }
    // Install the policy before parsing any untrusted byte. document.open keeps
    // the browsing context's existing enforced sandbox and policy container.
    document.open();
    document.write('<!doctype html><meta http-equiv="Content-Security-Policy" content="' + escape(message.policy) + '">' + message.html);
    document.close();
  };
  addEventListener("message", receive);
  parent.postMessage({ type: "joko:isolated-ready", nonce }, "*");
})();

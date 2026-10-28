/** Page-local close vetoes carry no Host capability or persistence authority. */
export const EXTENSION_VIEW_LIFECYCLE_ASSET = "__joko_extension_view__.js";
export const EXTENSION_VIEW_LIFECYCLE_SCRIPT = Buffer.from(String.raw`(() => {
  "use strict";
  const guards = new Set();
  let pending = false;
  Object.defineProperty(window, "jokoView", { value: Object.freeze({
    onBeforeClose(callback) {
      if (typeof callback !== "function" || guards.size >= 16) throw new TypeError("Invalid close handler.");
      guards.add(callback);
      return () => guards.delete(callback);
    }
  }), configurable: false, writable: false });
  window.addEventListener("message", event => {
    const value = event.data;
    if (event.source !== window.parent || !value || typeof value !== "object" || value.type !== "joko:extension-close"
      || value.version !== 1 || typeof value.id !== "string" || !/^close_[0-9a-f]{32}$/.test(value.id)
      || Object.keys(value).sort().join(",") !== "id,type,version" || pending) return;
    pending = true;
    Promise.all([...guards].map(callback => Promise.resolve().then(callback))).then(
      results => results.every(value => value !== false), () => false
    ).then(allowed => window.parent.postMessage({ type: "joko:extension-close-result", version: 1, id: value.id, allowed }, "*"))
      .finally(() => { pending = false; });
  });
  window.parent.postMessage({ type: "joko:extension-close-ready", version: 1 }, "*");
})();`, "utf8");

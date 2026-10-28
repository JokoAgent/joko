import { randomUuid } from "./web-crypto.js";

/** The exact sandboxed frame can veto a user close; expiry/removal still revoke
 * it immediately through the existing surface owner. */
export function bindExtensionViewClose(frame: HTMLIFrameElement, current: () => boolean): { close(): Promise<boolean>; dispose(): void } {
  const owner = frame.ownerDocument.defaultView!;
  let ready = false, stopped = false;
  let pending: { readonly id: string; readonly finish: (allowed: boolean) => void; readonly timer: ReturnType<typeof setTimeout> } | undefined;
  const receive = (event: MessageEvent): void => {
    if (stopped || !current() || event.source !== frame.contentWindow || event.origin !== "null" || event.data === null || typeof event.data !== "object") return;
    const value = event.data;
    if (value.type === "joko:extension-close-ready" && value.version === 1 && Object.keys(value).sort().join(",") === "type,version") { ready = true; return; }
    if (value.type !== "joko:extension-close-result" || value.version !== 1 || typeof value.allowed !== "boolean"
      || pending === undefined || pending.id !== value.id || Object.keys(value).sort().join(",") !== "allowed,id,type,version") return;
    clearTimeout(pending.timer); pending.finish(value.allowed); pending = undefined;
  };
  owner.addEventListener("message", receive);
  return {
    close: async () => {
      if (stopped || !current()) return false;
      if (!ready) return true;
      if (pending !== undefined) return false;
      const id = `close_${randomUuid().replaceAll("-", "")}`;
      return new Promise<boolean>(resolve => {
        const finish = (allowed: boolean): void => resolve(!stopped && current() && allowed);
        const timer = setTimeout(() => { if (pending?.id === id) { pending = undefined; finish(false); } }, 10_000);
        pending = { id, finish, timer };
        frame.contentWindow?.postMessage({ type: "joko:extension-close", version: 1, id }, "*");
      });
    },
    dispose: () => { stopped = true; owner.removeEventListener("message", receive); if (pending) { clearTimeout(pending.timer); pending.finish(false); pending = undefined; } }
  };
}

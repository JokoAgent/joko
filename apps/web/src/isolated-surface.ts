import { randomUuid } from "./web-crypto.js";

export interface IsolatedDocument { readonly html: string; readonly policy: string; readonly baseUrl?: string }

/** The static bootstrap comes from the already trusted UI distribution. Private
 * bytes arrive once, bound to this exact WindowProxy and random frame epoch. */
export function mountIsolatedSurface(frame: HTMLIFrameElement, document: Promise<IsolatedDocument>, options: {
  readonly signal: AbortSignal;
  readonly failed: () => void;
  readonly bootstrapBaseUrl?: string;
}): () => void {
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  const owner = frame.ownerDocument.defaultView!;
  const nonce = `v1-${randomUuid().replaceAll("-", "")}`;
  const url = new URL("./isolated-surface.html", options.bootstrapBaseUrl ?? owner.location.href);
  url.search = ""; url.hash = nonce;
  let ready = false, sent = false, stopped = false;
  let value: IsolatedDocument | undefined;
  const send = () => {
    if (stopped || sent || !ready || value === undefined || options.signal.aborted || !frame.isConnected) return;
    sent = true;
    frame.contentWindow?.postMessage({ type: "joko:isolated-document", nonce, ...value }, "*");
  };
  const receive = (event: MessageEvent) => {
    if (stopped || ready || options.signal.aborted || event.source !== frame.contentWindow || event.origin !== "null"
      || event.data?.type !== "joko:isolated-ready" || event.data?.nonce !== nonce) return;
    ready = true; send();
  };
  const dispose = () => { stopped = true; value = undefined; owner.removeEventListener("message", receive); options.signal.removeEventListener("abort", dispose); };
  owner.addEventListener("message", receive); options.signal.addEventListener("abort", dispose, { once: true });
  frame.src = url.href;
  void document.then(result => { if (!stopped) { value = result; send(); } }).catch(() => { if (!stopped && !options.signal.aborted) options.failed(); });
  return dispose;
}

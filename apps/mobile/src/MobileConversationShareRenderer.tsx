import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { MobileConversationShareSvg } from "./MobileConversationShareSvg";
import { buildMobileConversationShareHtml } from "./mobile-conversation-share-html";
import { exportMobileConversationSharePng, mobileConversationShareHtmlRenderer, type MobileConversationShareRendererHandle } from "./mobile-conversation-share-export";
import type { MobileConversationShareSnapshot } from "./mobile-conversation-share";
import type { MobileConversationShareColors } from "./mobile-conversation-share-layout";
import richRuntime from "./rich-markdown-runtime.richjs";

export const MobileConversationShareRenderer = forwardRef<MobileConversationShareRendererHandle, {
  readonly snapshot: MobileConversationShareSnapshot;
  readonly colors: MobileConversationShareColors;
  readonly width: number;
  readonly dark: boolean;
}>(function MobileConversationShareRenderer(props, ref) {
  const svg = useRef<MobileConversationShareRendererHandle>(null);
  const job = useRef<{ readonly controller: AbortController; readonly promise: Promise<Uint8Array> } | undefined>(undefined);
  useEffect(() => () => { job.current?.controller.abort(); }, []);
  useImperativeHandle(ref, () => ({
    exportPng(signal) {
      signal.throwIfAborted();
      if (job.current) return job.current.promise;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const promise = exportMobileConversationSharePng({
        renderer: mobileConversationShareHtmlRenderer,
        html: () => buildMobileConversationShareHtml(props, richRuntime), width: props.width,
        fallback: (fallbackSignal) => {
          fallbackSignal.throwIfAborted();
          if (!svg.current) throw new Error("The message image renderer is unavailable.");
          return svg.current.exportPng(fallbackSignal);
        }
      }, controller.signal).finally(() => signal.removeEventListener("abort", abort));
      job.current = { controller, promise };
      if (signal.aborted) controller.abort();
      return promise;
    }
  }), [props]);
  return <MobileConversationShareSvg ref={svg} {...props} />;
});

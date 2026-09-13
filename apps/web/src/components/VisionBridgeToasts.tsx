import { useEffect, useState, useSyncExternalStore, type JSX } from "react";
import { Info, TriangleAlert } from "lucide-react";

import { visionBridgeToastStore } from "../vision-bridge-toast-store.js";
import type { Translator } from "./types.js";
import "./vision-bridge-toasts.css";

export function VisionBridgeToasts({ t }: { readonly t: Translator }): JSX.Element | null {
  const toasts = useSyncExternalStore(
    visionBridgeToastStore.subscribe,
    visionBridgeToastStore.getSnapshot,
    visionBridgeToastStore.getSnapshot
  );
  if (toasts.length === 0) return null;
  return <div className="vision-bridge-toasts" aria-live="polite" aria-relevant="additions removals">
    {toasts.map((toast) => <VisionBridgeToastItem toast={toast} t={t} key={`${toast.sessionId}:${toast.eventId}`} />)}
  </div>;
}

function VisionBridgeToastItem({ toast, t }: {
  readonly toast: ReturnType<typeof visionBridgeToastStore.getSnapshot>[number];
  readonly t: Translator;
}): JSX.Element {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return <div
    className={`vision-bridge-toast is-${toast.kind}${entered ? " is-entered" : ""}${toast.exiting === true ? " is-exiting" : ""}`}
    role="status"
    onMouseEnter={() => { if (toast.kind !== "recognizing") visionBridgeToastStore.pause(toast.eventId); }}
    onMouseLeave={() => { if (toast.kind !== "recognizing") visionBridgeToastStore.resume(toast.eventId); }}
  >
    {toast.kind === "recognizing" ? <Info aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
    <span>{toast.kind === "recognizing"
      ? t("chat.visionBridge.analyzing", { count: toast.imageCount ?? 1 })
      : toast.kind === "fallback"
        ? t("chat.visionBridge.fallback")
        : t("chat.visionBridge.unavailable")}</span>
  </div>;
}

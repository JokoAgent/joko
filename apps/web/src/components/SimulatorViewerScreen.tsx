import { useEffect, useRef, useState, type JSX } from "react";
import { MonitorSmartphone } from "lucide-react";
import type { AppController } from "../controller.js";
import type { SimulatorViewerRouteView } from "../model.js";
import type { Translator } from "./types.js";
import { Button } from "./ui.js";

type ScreenState = "paused" | "connecting" | "reconnecting" | "streaming" | "disconnected";

/** One visible, current-route subscription. A new route mounts a fresh screen. */
export function SimulatorViewerScreen({ controller, sessionId, route, enabled, ownerDocument, t }: {
  readonly controller: AppController;
  readonly sessionId: string;
  readonly route: SimulatorViewerRouteView;
  readonly enabled: boolean;
  readonly ownerDocument: Document;
  readonly t: Translator;
}): JSX.Element {
  const [documentVisible, setDocumentVisible] = useState(!ownerDocument.hidden);
  const [state, setState] = useState<ScreenState>("paused");
  const [frameUrl, setFrameUrl] = useState<string>();
  const [retry, setRetry] = useState(0);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  useEffect(() => {
    const update = (): void => setDocumentVisible(!ownerDocument.hidden);
    ownerDocument.addEventListener("visibilitychange", update);
    update();
    return () => ownerDocument.removeEventListener("visibilitychange", update);
  }, [ownerDocument]);

  useEffect(() => {
    if (!enabled || !documentVisible) {
      setState("paused");
      setFrameUrl(undefined);
      return;
    }
    const subscription = new AbortController();
    setState("connecting");
    setFrameUrl(undefined);
    void (async () => {
      try {
        for await (const event of controllerRef.current.watchSimulatorFrames(sessionId, route,
          subscription.signal)) {
          if (subscription.signal.aborted) return;
          if (event.kind === "frame") {
            setFrameUrl(URL.createObjectURL(new Blob([Uint8Array.from(event.jpeg)],
              { type: "image/jpeg" })));
            setState("streaming");
          } else {
            setFrameUrl(undefined);
            setState(event.kind);
          }
        }
        if (!subscription.signal.aborted) { setFrameUrl(undefined); setState("disconnected"); }
      } catch {
        if (!subscription.signal.aborted) { setFrameUrl(undefined); setState("disconnected"); }
      }
    })();
    return () => subscription.abort();
  }, [enabled, documentVisible, sessionId, route.instanceId, route.generation, route.leaseId, retry]);

  useEffect(() => () => { if (frameUrl) URL.revokeObjectURL(frameUrl); }, [frameUrl]);

  const notice = state === "paused" ? t("simulator.streamPaused")
    : state === "connecting" ? t("simulator.streamConnecting")
      : state === "reconnecting" ? t("simulator.streamReconnecting")
        : state === "disconnected" ? t("simulator.streamDisconnected") : "";
  return <div className="simulator-viewer__screen" role="group" aria-label={t("simulator.liveScreen")}>
    {frameUrl && state === "streaming" ? <img src={frameUrl} alt={t("simulator.liveScreen")} />
      : <><MonitorSmartphone aria-hidden="true" /><span role="status">{notice || t("simulator.screenUnavailable")}</span></>}
    {state === "disconnected" && enabled && documentVisible &&
      <Button tone="ghost" onClick={() => setRetry(value => value + 1)}>{t("simulator.streamRetry")}</Button>}
  </div>;
}

import { useEffect, useRef, useState, type JSX } from "react";
import { MonitorSmartphone } from "lucide-react";
import type { AppController } from "../controller.js";
import type { SimulatorViewerRouteView } from "../model.js";
import { createBrowserSimulatorH264DecoderRuntime, SimulatorH264Decoder
} from "../simulator-h264-decoder.js";
import type { Translator } from "./types.js";
import { Button } from "./ui.js";

type ScreenState = "paused" | "connecting" | "reconnecting" | "streaming" | "disconnected";
type VideoQuality = "low" | "balanced" | "high" | "experimental60";
const VIDEO_PROFILES: Record<VideoQuality, { framesPerSecond: number; scalingPercent: number }> = {
  low: { framesPerSecond: 5, scalingPercent: 50 },
  balanced: { framesPerSecond: 20, scalingPercent: 70 },
  high: { framesPerSecond: 30, scalingPercent: 100 },
  experimental60: { framesPerSecond: 60, scalingPercent: 70 }
};

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
  const [presentation, setPresentation] = useState<"jpeg" | "h264" | null>(null);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [quality, setQuality] = useState<VideoQuality>("balanced");
  const [retry, setRetry] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
      setPresentation(null);
      setNativeAvailable(false);
      if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0; }
      return;
    }
    let active = true;
    let subscription: AbortController | undefined;
    const runtime = createBrowserSimulatorH264DecoderRuntime();
    setState("connecting");
    setFrameUrl(undefined);
    setPresentation(null);
    const clear = (): void => {
      setFrameUrl(undefined);
      setPresentation(null);
      if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0; }
    };
    const watch = async (native: boolean): Promise<void> => {
      subscription = new AbortController();
      const current = subscription;
      let fallback = false;
      const decoder = native ? new SimulatorH264Decoder({ runtime,
        renderFrame(frame, width, height) {
          const canvas = canvasRef.current;
          const context = canvas?.getContext("2d");
          if (!canvas || !context) throw new Error("Simulator canvas is unavailable.");
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }
          context.drawImage(frame as CanvasImageSource, 0, 0, width, height);
        },
        onFrameRendered() { if (active && !current.signal.aborted) {
          setFrameUrl(undefined); setPresentation("h264"); setState("streaming");
        } },
        onFallback() { fallback = true; current.abort(); }
      }) : null;
      try {
        for await (const event of controllerRef.current.watchSimulatorFrames(sessionId, route,
          current.signal, { preferNativeH264: native,
            framesPerSecond: VIDEO_PROFILES[quality].framesPerSecond,
            scalingPercent: VIDEO_PROFILES[quality].scalingPercent,
            orientation: "PORTRAIT" })) {
          if (!active || current.signal.aborted) break;
          if (event.kind === "frame") {
            decoder?.close();
            setNativeAvailable(false);
            setFrameUrl(URL.createObjectURL(new Blob([Uint8Array.from(event.jpeg)],
              { type: "image/jpeg" })));
            setPresentation("jpeg");
            setState("streaming");
          } else if (event.kind === "h264") {
            if (!decoder) throw new Error("Unexpected Simulator H.264 frame.");
            setNativeAvailable(true);
            const result = await decoder.decode({ bytes: event.h264, width: event.width,
              height: event.height, timestampMicros: event.timestampMicros,
              keyFrame: event.keyFrame, format: event.format }, route.generation);
            if (result === "fallback") { fallback = true; current.abort(); break; }
          } else {
            clear();
            setState(event.kind);
          }
        }
        if (active && !current.signal.aborted) { clear(); setState("disconnected"); }
      } catch {
        if (active && !current.signal.aborted) { clear(); setState("disconnected"); }
      } finally {
        decoder?.close();
      }
      if (active && fallback) {
        clear();
        setNativeAvailable(false);
        setState("reconnecting");
        await watch(false);
      }
    };
    void watch(runtime !== null);
    return () => { active = false; subscription?.abort();
      if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0; } };
  }, [enabled, documentVisible, sessionId, route.instanceId, route.generation, route.leaseId,
    quality, retry]);

  useEffect(() => () => { if (frameUrl) URL.revokeObjectURL(frameUrl); }, [frameUrl]);

  const notice = state === "paused" ? t("simulator.streamPaused")
    : state === "connecting" ? t("simulator.streamConnecting")
      : state === "reconnecting" ? t("simulator.streamReconnecting")
        : state === "disconnected" ? t("simulator.streamDisconnected") : "";
  return <div className="simulator-viewer__screen" role="group" aria-label={t("simulator.liveScreen")}>
    <canvas ref={canvasRef} aria-label={t("simulator.liveScreen")}
      style={{ display: presentation === "h264" && state === "streaming" ? undefined : "none" }} />
    {frameUrl && presentation === "jpeg" && state === "streaming"
      ? <img src={frameUrl} alt={t("simulator.liveScreen")} />
      : presentation === "h264" && state === "streaming" ? null
        : <><MonitorSmartphone aria-hidden="true" /><span role="status">{notice || t("simulator.screenUnavailable")}</span></>}
    {state === "disconnected" && enabled && documentVisible &&
      <Button tone="ghost" onClick={() => setRetry(value => value + 1)}>{t("simulator.streamRetry")}</Button>}
    {nativeAvailable && enabled && documentVisible && <label className="simulator-viewer__quality">
      {t("simulator.videoQuality")}
      <select value={quality} onChange={event => setQuality(event.target.value as VideoQuality)}>
        <option value="low">{t("simulator.videoLow")}</option>
        <option value="balanced">{t("simulator.videoBalanced")}</option>
        <option value="high">{t("simulator.videoHigh")}</option>
        <option value="experimental60">{t("simulator.videoExperimental60")}</option>
      </select>
    </label>}
  </div>;
}

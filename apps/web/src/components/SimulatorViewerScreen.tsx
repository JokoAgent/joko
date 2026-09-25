import {
  useCallback, useEffect, useRef, useState, type JSX,
  type PointerEvent as ReactPointerEvent
} from "react";
import { AlertTriangle, Keyboard, MonitorSmartphone, Send } from "lucide-react";
import type { AppController } from "../controller.js";
import type { SimulatorViewerInputView, SimulatorViewerRouteView } from "../model.js";
import { createBrowserSimulatorH264DecoderRuntime, SimulatorH264Decoder
} from "../simulator-h264-decoder.js";
import { randomUuid } from "../web-crypto.js";
import type { Translator } from "./types.js";
import { Button } from "./ui.js";

type ScreenState = "paused" | "connecting" | "reconnecting" | "streaming" | "disconnected";
type VideoQuality = "low" | "balanced" | "high" | "experimental60";
type FrameElement = HTMLImageElement | HTMLCanvasElement;
interface PointerGesture {
  readonly pointerId: number;
  readonly target: FrameElement;
  readonly startedAt: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly start: { readonly xRatio: number; readonly yRatio: number };
}

const VIDEO_PROFILES: Record<VideoQuality, { framesPerSecond: number; scalingPercent: number }> = {
  low: { framesPerSecond: 5, scalingPercent: 50 },
  balanced: { framesPerSecond: 20, scalingPercent: 70 },
  high: { framesPerSecond: 30, scalingPercent: 100 },
  experimental60: { framesPerSecond: 60, scalingPercent: 70 }
};
const MJPEG_PROFILES: Record<Exclude<VideoQuality, "experimental60">, {
  framesPerSecond: number; jpegQuality: number; scalingPercent: number }> = {
  low: { framesPerSecond: 5, jpegQuality: 25, scalingPercent: 50 },
  balanced: { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 },
  high: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 }
};

/** One visible, current-route subscription and its exact task-owned input surface. */
export function SimulatorViewerScreen({ controller, sessionId, route, enabled, ownerDocument,
  onReconcile, t }: {
  readonly controller: AppController;
  readonly sessionId: string;
  readonly route: SimulatorViewerRouteView;
  readonly enabled: boolean;
  readonly ownerDocument: Document;
  readonly onReconcile: () => Promise<void>;
  readonly t: Translator;
}): JSX.Element {
  const [documentVisible, setDocumentVisible] = useState(!ownerDocument.hidden);
  const [state, setState] = useState<ScreenState>("paused");
  const [frameUrl, setFrameUrl] = useState<string>();
  const [presentation, setPresentation] = useState<"jpeg" | "h264" | null>(null);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [quality, setQuality] = useState<VideoQuality>("balanced");
  const [retry, setRetry] = useState(0);
  const [frameFresh, setFrameFresh] = useState(false);
  const [inputBusy, setInputBusy] = useState(false);
  const [inputError, setInputError] = useState<string>();
  const [textInput, setTextInput] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerGestureRef = useRef<PointerGesture | undefined>(undefined);
  const inputRequestRef = useRef<AbortController | undefined>(undefined);
  const frameFreshnessTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composingRef = useRef(false);
  const mountedRef = useRef(true);
  const controllerRef = useRef(controller);
  const reconcileRef = useRef(onReconcile);
  controllerRef.current = controller;
  reconcileRef.current = onReconcile;

  const clearFrameFreshness = useCallback((): void => {
    if (frameFreshnessTimerRef.current !== undefined) {
      clearTimeout(frameFreshnessTimerRef.current);
      frameFreshnessTimerRef.current = undefined;
    }
    setFrameFresh(false);
  }, []);
  const markFrameFresh = useCallback((): void => {
    if (frameFreshnessTimerRef.current !== undefined) clearTimeout(frameFreshnessTimerRef.current);
    setFrameFresh(true);
    frameFreshnessTimerRef.current = setTimeout(() => {
      frameFreshnessTimerRef.current = undefined;
      setFrameFresh(false);
    }, 3_000);
  }, []);

  useEffect(() => {
    const update = (): void => setDocumentVisible(!ownerDocument.hidden);
    ownerDocument.addEventListener("visibilitychange", update);
    update();
    return () => ownerDocument.removeEventListener("visibilitychange", update);
  }, [ownerDocument]);

  useEffect(() => {
    if (!enabled || !documentVisible) {
      setState("paused");
      clearFrameFreshness();
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
    clearFrameFreshness();
    setFrameUrl(undefined);
    setPresentation(null);
    const clear = (): void => {
      clearFrameFreshness();
      setFrameUrl(undefined);
      setPresentation(null);
      if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0; }
    };
    const watch = async (native: boolean): Promise<void> => {
      subscription = new AbortController();
      const current = subscription;
      const mjpeg = MJPEG_PROFILES[quality === "experimental60" ? "high" : quality];
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
          markFrameFresh();
        } },
        onFallback() { fallback = true; current.abort(); }
      }) : null;
      try {
        for await (const event of controllerRef.current.watchSimulatorFrames(sessionId, route,
          current.signal, { preferNativeH264: native,
            framesPerSecond: VIDEO_PROFILES[quality].framesPerSecond,
            scalingPercent: VIDEO_PROFILES[quality].scalingPercent,
            orientation: "PORTRAIT", mjpegFramesPerSecond: mjpeg.framesPerSecond,
            jpegQuality: mjpeg.jpegQuality, mjpegScalingPercent: mjpeg.scalingPercent })) {
          if (!active || current.signal.aborted) break;
          if (event.kind === "frame") {
            decoder?.close();
            setNativeAvailable(false);
            setFrameUrl(URL.createObjectURL(new Blob([Uint8Array.from(event.jpeg)],
              { type: "image/jpeg" })));
            setPresentation("jpeg");
            setState("streaming");
            markFrameFresh();
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
    return () => { active = false; subscription?.abort(); clearFrameFreshness();
      if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0; } };
  }, [enabled, documentVisible, sessionId, route.instanceId, route.generation, route.leaseId,
    quality, retry, clearFrameFreshness, markFrameFresh]);

  useEffect(() => () => { if (frameUrl) URL.revokeObjectURL(frameUrl); }, [frameUrl]);

  const releasePointerGesture = useCallback((): void => {
    const gesture = pointerGestureRef.current;
    pointerGestureRef.current = undefined;
    if (!gesture) return;
    try {
      if (gesture.target.hasPointerCapture(gesture.pointerId)) {
        gesture.target.releasePointerCapture(gesture.pointerId);
      }
    } catch { /* The owner may already have released capture during teardown. */ }
  }, []);

  const interactive = enabled && documentVisible && state === "streaming" &&
    presentation !== null && frameFresh;

  useEffect(() => {
    if (!interactive) {
      releasePointerGesture();
      inputRequestRef.current?.abort();
    }
  }, [interactive, releasePointerGesture]);

  useEffect(() => {
    const ownerWindow = ownerDocument.defaultView;
    const loseContext = (): void => releasePointerGesture();
    ownerWindow?.addEventListener("blur", loseContext);
    return () => ownerWindow?.removeEventListener("blur", loseContext);
  }, [ownerDocument, releasePointerGesture]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
    mountedRef.current = false;
    inputRequestRef.current?.abort();
    releasePointerGesture();
    };
  }, [releasePointerGesture]);

  const runInput = useCallback(async (input: SimulatorViewerInputView): Promise<boolean> => {
    if (!interactive || inputBusy || inputRequestRef.current || inputError !== undefined) return false;
    const request = new AbortController();
    inputRequestRef.current = request;
    setInputBusy(true);
    try {
      await controllerRef.current.controlSimulatorViewerInput(sessionId, randomUuid(), route,
        input, request.signal);
      return true;
    } catch (cause) {
      if (!request.signal.aborted && mountedRef.current) {
        setInputError(`${t("simulator.inputUnconfirmed")} ${messageOf(cause)}`);
        await reconcileRef.current().catch(() => undefined);
      }
      return false;
    } finally {
      if (inputRequestRef.current === request) inputRequestRef.current = undefined;
      if (mountedRef.current) setInputBusy(false);
    }
  }, [inputBusy, inputError, interactive, route, sessionId, t]);

  const ratio = (event: ReactPointerEvent<FrameElement>): {
    readonly xRatio: number; readonly yRatio: number } | null => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      xRatio: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      yRatio: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height))
    };
  };

  const onPointerDown = (event: ReactPointerEvent<FrameElement>): void => {
    if (!interactive || inputBusy || inputError !== undefined || pointerGestureRef.current ||
        event.button !== 0) return;
    const start = ratio(event);
    if (!start) return;
    try { event.currentTarget.setPointerCapture(event.pointerId); }
    catch { return; }
    pointerGestureRef.current = { pointerId: event.pointerId, target: event.currentTarget,
      startedAt: performance.now(), startClientX: event.clientX, startClientY: event.clientY, start };
    event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<FrameElement>): void => {
    const gesture = pointerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if ((event.buttons & 1) === 0) {
      releasePointerGesture();
      return;
    }
    event.preventDefault();
  };

  const onPointerUp = (event: ReactPointerEvent<FrameElement>): void => {
    const gesture = pointerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const end = ratio(event);
    const distance = Math.hypot(event.clientX - gesture.startClientX,
      event.clientY - gesture.startClientY);
    const durationMs = Math.round(Math.min(2_000,
      Math.max(100, performance.now() - gesture.startedAt)));
    releasePointerGesture();
    if (end) void runInput(distance < 8
      ? { action: "tap", xRatio: end.xRatio, yRatio: end.yRatio }
      : { action: "swipe", startXRatio: gesture.start.xRatio,
        startYRatio: gesture.start.yRatio, endXRatio: end.xRatio,
        endYRatio: end.yRatio, durationMs });
    event.preventDefault();
  };

  const recoverInput = async (): Promise<void> => {
    if (inputBusy || !enabled) return;
    setInputBusy(true);
    try {
      await reconcileRef.current();
      if (mountedRef.current) setInputError(undefined);
    } catch {
      if (mountedRef.current) setInputError(t("simulator.inputRefreshFailed"));
    } finally {
      if (mountedRef.current) setInputBusy(false);
    }
  };

  const notice = state === "paused" ? t("simulator.streamPaused")
    : state === "connecting" ? t("simulator.streamConnecting")
      : state === "reconnecting" ? t("simulator.streamReconnecting")
        : state === "disconnected" ? t("simulator.streamDisconnected") : "";
  const pointerProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: releasePointerGesture,
    onLostPointerCapture: releasePointerGesture
  };
  const controlsDisabled = !interactive || inputBusy || inputError !== undefined;

  return <div className="simulator-viewer__interaction" role="group"
    aria-label={t("simulator.liveScreen")}>
    <div className="simulator-viewer__screen">
      <canvas ref={canvasRef} role="img" aria-label={t("simulator.liveScreen")}
        title={t("simulator.gestureHint")} aria-disabled={controlsDisabled}
        className="simulator-viewer__frame"
        style={{ display: presentation === "h264" && state === "streaming" ? undefined : "none" }}
        {...pointerProps} />
      {frameUrl && presentation === "jpeg" && state === "streaming"
        ? <img src={frameUrl} alt={t("simulator.liveScreen")} draggable={false}
          title={t("simulator.gestureHint")} aria-disabled={controlsDisabled}
          className="simulator-viewer__frame" {...pointerProps} />
        : presentation === "h264" && state === "streaming" ? null
          : <><MonitorSmartphone aria-hidden="true" /><span role="status">{notice || t("simulator.screenUnavailable")}</span></>}
      {state === "disconnected" && enabled && documentVisible &&
        <Button tone="ghost" onClick={() => setRetry(value => value + 1)}>{t("simulator.streamRetry")}</Button>}
      {presentation !== null && state === "streaming" && enabled && documentVisible &&
        <label className="simulator-viewer__quality">
        {t("simulator.videoQuality")}
        <select value={!nativeAvailable && quality === "experimental60" ? "high" : quality}
          disabled={inputBusy}
          onChange={event => setQuality(event.target.value as VideoQuality)}>
          <option value="low">{t("simulator.videoLow")}</option>
          <option value="balanced">{t("simulator.videoBalanced")}</option>
          <option value="high">{t("simulator.videoHigh")}</option>
          {nativeAvailable && <option value="experimental60">{t("simulator.videoExperimental60")}</option>}
        </select>
      </label>}
    </div>
    {inputError && <div className="simulator-viewer__input-error" role="alert">
      <AlertTriangle aria-hidden="true" /><span>{inputError}</span>
      <Button tone="ghost" disabled={inputBusy || !enabled}
        onClick={() => void recoverInput()}>{t("simulator.inputReview")}</Button>
    </div>}
    <form className="simulator-viewer__keyboard" onSubmit={event => {
      event.preventDefault();
      if (!textInput || controlsDisabled || composingRef.current) return;
      void runInput({ action: "typeText", text: textInput })
        .then(sent => { if (sent && mountedRef.current) setTextInput(""); });
    }}>
      <label><span className="sr-only">{t("simulator.textInputLabel")}</span>
        <Keyboard aria-hidden="true" />
        <input value={textInput} maxLength={10_000} disabled={controlsDisabled}
          aria-label={t("simulator.textInputLabel")}
          placeholder={t("simulator.textInputPlaceholder")}
          onChange={event => setTextInput(event.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }} />
      </label>
      <Button type="submit" disabled={controlsDisabled || textInput.length === 0}>
        <Send aria-hidden="true" />{t("simulator.sendText")}
      </Button>
    </form>
    <p className="simulator-viewer__hint">{t("simulator.gestureHint")}</p>
  </div>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

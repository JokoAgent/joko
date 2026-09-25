import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX,
  type PointerEvent as ReactPointerEvent
} from "react";
import { AlertTriangle, Camera, House, Keyboard, LockKeyhole, MonitorSmartphone,
  RefreshCw, RotateCw, Send, UnlockKeyhole } from "lucide-react";
import type { AppController } from "../controller.js";
import type { SimulatorViewerCommandView, SimulatorViewerControlsView,
  SimulatorViewerNativeRouteView,
  SimulatorViewerInputView, SimulatorViewerRouteView } from "../model.js";
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
  readonly gestureId: string;
  readonly sessionId: string;
  readonly route: SimulatorViewerRouteView;
  readonly beginAbort: AbortController;
  readonly startedAt: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly start: { readonly xRatio: number; readonly yRatio: number };
  last: { readonly xRatio: number; readonly yRatio: number };
  beginState: "pending" | "active" | "unavailable" | "failed";
  sequence: number;
  pendingMove?: { readonly xRatio: number; readonly yRatio: number };
  terminal?: { readonly phase: "end" | "cancel";
    readonly point: { readonly xRatio: number; readonly yRatio: number };
    readonly fallback?: SimulatorViewerInputView };
  pumping: boolean;
  lastDispatchedAt: number;
  watchdog?: ReturnType<typeof setTimeout>;
}
interface ViewerSubscriptionIdentity {
  readonly sessionId: string;
  readonly route: SimulatorViewerRouteView;
  readonly ownerKey: string;
  readonly subscriptionId: string;
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
const INTERACTION_PROFILE_RESTORE_DELAY_MS = 250;
const MIN_FITTED_SCREEN_HEIGHT_PX = 192;

export interface SimulatorScreenSize {
  readonly width: number;
  readonly height: number;
}

export function fitSimulatorScreenSize(viewport: {
  readonly width: number;
  readonly height: number;
} | null, availableWidth: number, availableHeight: number): SimulatorScreenSize | null {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0 ||
      availableWidth <= 0 || availableHeight <= 0) return null;
  const scale = Math.min(availableWidth / viewport.width, availableHeight / viewport.height);
  return { width: viewport.width * scale, height: viewport.height * scale };
}

/** One visible, current-route subscription and its exact task-owned input surface. */
export function SimulatorViewerScreen({ controller, sessionId, route, enabled, controlEnabled = true, ownerDocument,
  viewportRef, onReconcile, t }: {
  readonly controller: AppController;
  readonly sessionId: string;
  readonly route: SimulatorViewerRouteView;
  readonly enabled: boolean;
  readonly controlEnabled?: boolean;
  readonly ownerDocument: Document;
  readonly viewportRef?: { readonly current: HTMLElement | null };
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
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandError, setCommandError] = useState<string>();
  const [clipboardError, setClipboardError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [controls, setControls] = useState<SimulatorViewerControlsView>();
  const [inputFallback, setInputFallback] = useState(false);
  const [streamFps, setStreamFps] = useState(0);
  const [nativeRoute, setNativeRoute] = useState<SimulatorViewerNativeRouteView>("inactive");
  const [nativeRecoveryPending, setNativeRecoveryPending] = useState(false);
  const [nativeRecoveryOutcome, setNativeRecoveryOutcome] = useState<"failed" | "restored">();
  const [textInput, setTextInput] = useState("");
  const [layoutViewport, setLayoutViewport] = useState<{
    readonly ownerKey: string;
    readonly width: number;
    readonly height: number;
  }>();
  const [fittedScreenSize, setFittedScreenSize] = useState<SimulatorScreenSize | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screenSlotRef = useRef<HTMLDivElement>(null);
  const pointerGestureRef = useRef<PointerGesture | undefined>(undefined);
  const inputRequestRef = useRef<AbortController | undefined>(undefined);
  const commandRequestRef = useRef<AbortController | undefined>(undefined);
  const frameRateRef = useRef({ startedAt: 0, frames: 0 });
  const nativeRecoveryRef = useRef(false);
  const qualityRef = useRef<VideoQuality>(quality);
  const activeSubscriptionRef = useRef<ViewerSubscriptionIdentity | undefined>(undefined);
  const interactionProfileRef = useRef<ViewerSubscriptionIdentity | undefined>(undefined);
  const profileRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const profileMutationTailRef = useRef<Promise<void>>(Promise.resolve());
  const ownerKey = `${sessionId}:${route.instanceId}:${route.generation}:${route.leaseId}`;
  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  const frameFreshnessTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composingRef = useRef(false);
  const mountedRef = useRef(true);
  const controllerRef = useRef(controller);
  const reconcileRef = useRef(onReconcile);
  controllerRef.current = controller;
  reconcileRef.current = onReconcile;
  qualityRef.current = quality;

  const resetTelemetry = useCallback((): void => {
    frameRateRef.current = { startedAt: 0, frames: 0 };
    setStreamFps(0);
    setControls(undefined);
    setLayoutViewport(undefined);
    setInputFallback(false);
    setNativeRoute("inactive");
    setNativeRecoveryOutcome(undefined);
  }, []);
  const recordFrame = useCallback((): void => {
    const now = performance.now();
    if (frameRateRef.current.startedAt === 0) frameRateRef.current.startedAt = now;
    frameRateRef.current.frames += 1;
    const elapsed = now - frameRateRef.current.startedAt;
    if (elapsed >= 900) {
      setStreamFps(frameRateRef.current.frames * 1_000 / elapsed);
      frameRateRef.current = { startedAt: now, frames: 0 };
    }
  }, []);

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
      resetTelemetry();
    }, 3_000);
  }, [resetTelemetry]);

  const mutateInteractionProfile = useCallback((identity: ViewerSubscriptionIdentity,
    active: boolean): void => {
    const api = controllerRef.current;
    const mutation = profileMutationTailRef.current.then(async () => {
      await api.setSimulatorViewerInteractionProfile(identity.sessionId,
        identity.route, identity.subscriptionId, active);
    });
    profileMutationTailRef.current = mutation.catch(() => undefined);
  }, []);

  const restoreInteractionProfile = useCallback((immediate = false): void => {
    if (profileRestoreTimerRef.current !== undefined) {
      clearTimeout(profileRestoreTimerRef.current);
      profileRestoreTimerRef.current = undefined;
    }
    const restore = (): void => {
      profileRestoreTimerRef.current = undefined;
      const identity = interactionProfileRef.current;
      if (!identity) return;
      interactionProfileRef.current = undefined;
      mutateInteractionProfile(identity, false);
    };
    if (immediate) restore();
    else profileRestoreTimerRef.current = setTimeout(
      restore, INTERACTION_PROFILE_RESTORE_DELAY_MS);
  }, [mutateInteractionProfile]);

  const beginInteractionProfile = useCallback((): void => {
    if (profileRestoreTimerRef.current !== undefined) {
      clearTimeout(profileRestoreTimerRef.current);
      profileRestoreTimerRef.current = undefined;
    }
    const subscription = activeSubscriptionRef.current;
    if (!subscription || subscription.ownerKey !== ownerKeyRef.current ||
        qualityRef.current !== "low" && qualityRef.current !== "balanced") return;
    const current = interactionProfileRef.current;
    if (current?.subscriptionId === subscription.subscriptionId) return;
    if (current) restoreInteractionProfile(true);
    interactionProfileRef.current = subscription;
    mutateInteractionProfile(subscription, true);
  }, [mutateInteractionProfile, restoreInteractionProfile]);

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
      resetTelemetry();
      nativeRecoveryRef.current = false;
      setNativeRecoveryPending(false);
      setNativeRecoveryOutcome(undefined);
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
    resetTelemetry();
    const clear = (): void => {
      clearFrameFreshness();
      setFrameUrl(undefined);
      setPresentation(null);
      resetTelemetry();
      if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0; }
    };
    const watch = async (native: boolean,
      clientFallbackReason?: "decode_failed"): Promise<void> => {
      subscription = new AbortController();
      const current = subscription;
      const identity: ViewerSubscriptionIdentity = { sessionId, route: { ...route },
        ownerKey, subscriptionId: randomUuid() };
      activeSubscriptionRef.current = identity;
      const mjpeg = MJPEG_PROFILES[quality === "experimental60" ? "high" : quality];
      let fallback = false;
      let decoderFallback = false;
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
          setNativeRoute("active");
          if (nativeRecoveryRef.current) {
            nativeRecoveryRef.current = false;
            setNativeRecoveryPending(false);
            setNativeRecoveryOutcome("restored");
          }
          recordFrame();
          markFrameFresh();
        } },
        onFallback() { fallback = true; decoderFallback = true; current.abort(); }
      }) : null;
      try {
        for await (const event of controllerRef.current.watchSimulatorFrames(sessionId, route,
          current.signal, { subscriptionId: identity.subscriptionId, preferNativeH264: native,
            framesPerSecond: VIDEO_PROFILES[quality].framesPerSecond,
            scalingPercent: VIDEO_PROFILES[quality].scalingPercent,
            orientation: "PORTRAIT", mjpegFramesPerSecond: mjpeg.framesPerSecond,
            jpegQuality: mjpeg.jpegQuality, mjpegScalingPercent: mjpeg.scalingPercent,
            ...(clientFallbackReason ? { clientFallbackReason } : {}) })) {
          if (!active || current.signal.aborted) break;
          if (event.kind === "frame") {
            decoder?.close();
            setNativeAvailable(false);
            setFrameUrl(URL.createObjectURL(new Blob([Uint8Array.from(event.jpeg)],
              { type: "image/jpeg" })));
            setPresentation("jpeg");
            setState("streaming");
            setNativeRoute(event.nativeRoute);
            if (event.nativeRoute !== "active") setNativeRecoveryOutcome(previous =>
              previous === "restored" ? undefined : previous);
            if (nativeRecoveryRef.current) {
              nativeRecoveryRef.current = false;
              setNativeRecoveryPending(false);
              setNativeRecoveryOutcome("failed");
            }
            recordFrame();
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
            setNativeRoute(event.kind === "disconnected" ? "inactive" : event.nativeRoute);
            if (event.kind === "disconnected" && nativeRecoveryRef.current) {
              nativeRecoveryRef.current = false;
              setNativeRecoveryPending(false);
              setNativeRecoveryOutcome("failed");
            }
          }
        }
        if (active && !current.signal.aborted) { clear(); setState("disconnected");
          if (nativeRecoveryRef.current) {
            nativeRecoveryRef.current = false;
            setNativeRecoveryPending(false);
            setNativeRecoveryOutcome("failed");
          }
        }
      } catch {
        if (active && !current.signal.aborted) { clear(); setState("disconnected");
          if (nativeRecoveryRef.current) {
            nativeRecoveryRef.current = false;
            setNativeRecoveryPending(false);
            setNativeRecoveryOutcome("failed");
          }
        }
      } finally {
        decoder?.close();
        if (activeSubscriptionRef.current?.subscriptionId === identity.subscriptionId) {
          activeSubscriptionRef.current = undefined;
        }
        if (interactionProfileRef.current?.subscriptionId === identity.subscriptionId) {
          restoreInteractionProfile(true);
        }
      }
      if (active && fallback) {
        clear();
        setNativeAvailable(false);
        setState("reconnecting");
        await watch(false, decoderFallback ? "decode_failed" : undefined);
      }
    };
    void watch(runtime !== null);
    return () => { active = false; subscription?.abort(); clearFrameFreshness();
      if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0; } };
  }, [enabled, documentVisible, sessionId, ownerKey, route.instanceId, route.generation, route.leaseId,
    quality, retry, clearFrameFreshness, markFrameFresh, recordFrame, resetTelemetry,
    restoreInteractionProfile]);

  useEffect(() => () => { if (frameUrl) URL.revokeObjectURL(frameUrl); }, [frameUrl]);

  const interactive = enabled && controlEnabled && documentVisible && state === "streaming" &&
    presentation !== null && frameFresh;

  useEffect(() => {
    if (!interactive) { setControls(undefined); return; }
    const request = new AbortController();
    const read = async (): Promise<void> => {
      try {
        const next = await controllerRef.current.getSimulatorViewerControls(sessionId, route, request.signal);
        if (!request.signal.aborted && ownerKeyRef.current === ownerKey) {
          setControls(next);
          setLayoutViewport(current => current?.ownerKey === ownerKey &&
            current.width === next.viewportWidth && current.height === next.viewportHeight
            ? current : { ownerKey, width: next.viewportWidth, height: next.viewportHeight });
        }
      } catch { if (!request.signal.aborted) setControls(undefined); }
    };
    void read();
    const timer = setInterval(() => { if (!commandRequestRef.current && !pointerGestureRef.current) void read(); }, 4_000);
    return () => { request.abort(); clearInterval(timer); setControls(undefined); };
  }, [interactive, ownerKey, route, sessionId]);

  useLayoutEffect(() => {
    const viewport = layoutViewport?.ownerKey === ownerKey ? layoutViewport : null;
    if (!enabled || !documentVisible || state !== "streaming" || presentation === null ||
        !viewport || viewport.width <= 0 || viewport.height <= 0) {
      setFittedScreenSize(null);
      return;
    }
    const screenSlot = screenSlotRef.current;
    const panelViewport = viewportRef?.current ??
      screenSlot?.closest<HTMLElement>(".inspector__body") ??
      screenSlot?.closest<HTMLElement>(".simulator-viewer");
    const viewerSection = screenSlot?.closest<HTMLElement>(".simulator-viewer__card") ??
      screenSlot?.closest<HTMLElement>(".simulator-viewer__interaction");
    if (!screenSlot || !panelViewport || !viewerSection) {
      setFittedScreenSize(null);
      return;
    }
    const ownerWindow = ownerDocument.defaultView;
    const update = (): void => {
      const panelHeight = panelViewport.clientHeight;
      const slotWidth = screenSlot.clientWidth;
      if (panelHeight <= 0 || slotWidth <= 0) {
        setFittedScreenSize(null);
        return;
      }
      const sectionRect = viewerSection.getBoundingClientRect();
      const slotRect = screenSlot.getBoundingClientRect();
      const deviceHeaderHeight = Math.max(0, slotRect.top - sectionRect.top);
      const availableHeight = Math.max(MIN_FITTED_SCREEN_HEIGHT_PX,
        panelHeight - deviceHeaderHeight);
      const next = fitSimulatorScreenSize(viewport, slotWidth, availableHeight);
      setFittedScreenSize(current => current && next &&
        Math.abs(current.width - next.width) < 0.5 &&
        Math.abs(current.height - next.height) < 0.5 ? current : next);
    };
    let animationFrame: number | null = null;
    const scheduleUpdate = (): void => {
      if (animationFrame !== null) ownerWindow?.cancelAnimationFrame(animationFrame);
      if (!ownerWindow) { update(); return; }
      animationFrame = ownerWindow.requestAnimationFrame(() => {
        animationFrame = null;
        update();
      });
    };
    update();
    const ResizeObserverCtor = ownerWindow?.ResizeObserver;
    const observer = ResizeObserverCtor ? new ResizeObserverCtor(scheduleUpdate) : null;
    observer?.observe(panelViewport);
    observer?.observe(viewerSection);
    observer?.observe(screenSlot);
    ownerWindow?.addEventListener("resize", scheduleUpdate);
    return () => {
      observer?.disconnect();
      ownerWindow?.removeEventListener("resize", scheduleUpdate);
      if (animationFrame !== null) ownerWindow?.cancelAnimationFrame(animationFrame);
    };
  }, [documentVisible, enabled, layoutViewport, ownerDocument, ownerKey, presentation, state,
    viewportRef]);

  useEffect(() => {
    if (!enabled || !documentVisible) {
      commandRequestRef.current?.abort();
      setCopied(false);
      setClipboardError(undefined);
    }
  }, [enabled, documentVisible]);

  const runInput = useCallback(async (input: SimulatorViewerInputView,
    fallbackAfterUndispatchedBegin = false,
    owner: { readonly sessionId: string; readonly route: SimulatorViewerRouteView } =
      { sessionId, route }): Promise<boolean> => {
    if ((!interactive && !fallbackAfterUndispatchedBegin) ||
        (inputBusy && !fallbackAfterUndispatchedBegin) ||
        inputRequestRef.current || inputError !== undefined || commandBusy ||
        commandError !== undefined) return false;
    const request = new AbortController();
    inputRequestRef.current = request;
    setInputBusy(true);
    try {
      await controllerRef.current.controlSimulatorViewerInput(owner.sessionId, randomUuid(), owner.route,
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
  }, [inputBusy, inputError, interactive, route, sessionId, t, commandBusy, commandError]);

  const ratio = (event: ReactPointerEvent<FrameElement>): {
    readonly xRatio: number; readonly yRatio: number } | null => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      xRatio: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      yRatio: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height))
    };
  };

  const releaseCapture = (gesture: PointerGesture): void => {
    try {
      if (gesture.target.hasPointerCapture(gesture.pointerId)) {
        gesture.target.releasePointerCapture(gesture.pointerId);
      }
    } catch { /* Capture may already have been released during teardown. */ }
  };

  const finishGesture = useCallback((gesture: PointerGesture): void => {
    if (pointerGestureRef.current === gesture) pointerGestureRef.current = undefined;
    if (gesture.watchdog !== undefined) clearTimeout(gesture.watchdog);
    releaseCapture(gesture);
    restoreInteractionProfile();
    if (mountedRef.current) setInputBusy(false);
  }, [restoreInteractionProfile]);

  const unknownGesture = useCallback(async (gesture: PointerGesture, cause: unknown): Promise<void> => {
    if (gesture.beginState === "failed") return;
    gesture.beginState = "failed";
    finishGesture(gesture);
    if (!mountedRef.current) return;
    setInputError(`${t("simulator.inputUnconfirmed")} ${messageOf(cause)}`);
    await reconcileRef.current().catch(() => undefined);
  }, [finishGesture, t]);

  const pumpGesture = useCallback(async (gesture: PointerGesture): Promise<void> => {
    if (gesture.pumping || gesture.beginState !== "active") return;
    gesture.pumping = true;
    const cancelled = (): boolean => gesture.terminal?.phase === "cancel";
    try {
      while (gesture.beginState === "active") {
        if (gesture.sequence >= 4_094) {
          gesture.terminal = { phase: "cancel", point: gesture.last };
          gesture.pendingMove = undefined;
        }
        if (gesture.pendingMove && !cancelled()) {
          const waitMs = Math.max(0, 4 - (performance.now() - gesture.lastDispatchedAt));
          if (waitMs > 0) await new Promise<void>(resolve => setTimeout(resolve, waitMs));
          if (gesture.beginState !== "active" || cancelled()) continue;
          const move = gesture.pendingMove;
          gesture.pendingMove = undefined;
          if (!move) continue;
          gesture.sequence += 1;
          const result = await controllerRef.current.controlSimulatorViewerTouch(
            gesture.sessionId, gesture.route, { gestureId: gesture.gestureId,
              sequence: gesture.sequence, phase: "move", xRatio: move.xRatio,
              yRatio: move.yRatio });
          if (!result.accepted) throw new Error("Simulator touch move was not accepted.");
          gesture.lastDispatchedAt = performance.now();
          continue;
        }
        const terminal = gesture.terminal;
        if (!terminal) break;
        gesture.pendingMove = undefined;
        gesture.sequence += 1;
        const result = await controllerRef.current.controlSimulatorViewerTouch(
          gesture.sessionId, gesture.route, { gestureId: gesture.gestureId,
            sequence: gesture.sequence, phase: terminal.phase,
            xRatio: terminal.point.xRatio, yRatio: terminal.point.yRatio });
        if (!result.accepted) throw new Error("Simulator touch release was not accepted.");
        finishGesture(gesture);
        break;
      }
    } catch (cause) { await unknownGesture(gesture, cause); }
    finally { gesture.pumping = false; }
  }, [finishGesture, unknownGesture]);

  const resetWatchdog = useCallback((gesture: PointerGesture): void => {
    if (gesture.watchdog !== undefined) clearTimeout(gesture.watchdog);
    gesture.watchdog = setTimeout(() => {
      if (pointerGestureRef.current !== gesture || gesture.terminal) return;
      gesture.terminal = { phase: "cancel", point: gesture.last };
      gesture.pendingMove = undefined;
      releaseCapture(gesture);
      if (gesture.beginState === "active") void pumpGesture(gesture);
      else if (gesture.beginState === "pending") {
        gesture.beginAbort.abort();
        void unknownGesture(gesture, new Error("Simulator touch begin timed out."));
      }
      else if (gesture.beginState === "unavailable") finishGesture(gesture);
    }, Math.min(4_500, Math.max(1, 59_000 - (performance.now() - gesture.startedAt))));
  }, [finishGesture, pumpGesture, unknownGesture]);

  const cancelPointerGesture = useCallback((): void => {
    const gesture = pointerGestureRef.current;
    if (!gesture || gesture.terminal) return;
    gesture.terminal = { phase: "cancel", point: gesture.last };
    gesture.pendingMove = undefined;
    releaseCapture(gesture);
    if (gesture.beginState === "active") void pumpGesture(gesture);
    else if (gesture.beginState === "pending") {
      gesture.beginAbort.abort();
      void unknownGesture(gesture, new Error("Simulator touch begin was interrupted."));
    }
    else if (gesture.beginState === "unavailable") finishGesture(gesture);
  }, [finishGesture, pumpGesture, unknownGesture]);

  const abandonPointerGesture = useCallback((): void => {
    const gesture = pointerGestureRef.current;
    if (!gesture) return;
    gesture.beginState = "failed";
    gesture.terminal = { phase: "cancel", point: gesture.last };
    gesture.pendingMove = undefined;
    gesture.beginAbort.abort();
    finishGesture(gesture);
  }, [finishGesture]);

  useEffect(() => {
    if (!interactive) {
      if (enabled && documentVisible && !controlEnabled) abandonPointerGesture();
      else cancelPointerGesture();
      if (!enabled || !documentVisible) inputRequestRef.current?.abort();
    }
  }, [interactive, enabled, controlEnabled, documentVisible, abandonPointerGesture,
    cancelPointerGesture]);

  useEffect(() => {
    const ownerWindow = ownerDocument.defaultView;
    ownerWindow?.addEventListener("blur", cancelPointerGesture);
    return () => ownerWindow?.removeEventListener("blur", cancelPointerGesture);
  }, [ownerDocument, cancelPointerGesture]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inputRequestRef.current?.abort();
      cancelPointerGesture();
      restoreInteractionProfile(true);
    };
  }, [cancelPointerGesture, restoreInteractionProfile]);

  useEffect(() => () => {
    cancelPointerGesture();
    restoreInteractionProfile(true);
  }, [sessionId, route.instanceId, route.generation, route.leaseId,
    cancelPointerGesture, restoreInteractionProfile]);

  const onPointerDown = (event: ReactPointerEvent<FrameElement>): void => {
    if (!interactive || inputBusy || commandBusy || inputError !== undefined ||
        commandError !== undefined || pointerGestureRef.current ||
        event.button !== 0 || !event.isPrimary) return;
    const start = ratio(event);
    if (!start) return;
    try { event.currentTarget.setPointerCapture(event.pointerId); }
    catch { return; }
    const gesture: PointerGesture = { pointerId: event.pointerId, target: event.currentTarget,
      gestureId: randomUuid(), sessionId, route, beginAbort: new AbortController(),
      startedAt: performance.now(),
      startClientX: event.clientX, startClientY: event.clientY, start, last: start,
      beginState: "pending", sequence: 0, pumping: false,
      lastDispatchedAt: performance.now() };
    pointerGestureRef.current = gesture;
    setInputBusy(true);
    beginInteractionProfile();
    resetWatchdog(gesture);
    void (async () => {
      try {
        const result = await controllerRef.current.controlSimulatorViewerTouch(
          gesture.sessionId, gesture.route, { gestureId: gesture.gestureId,
            sequence: 0, phase: "begin", xRatio: start.xRatio, yRatio: start.yRatio },
          gesture.beginAbort.signal);
        if (gesture.beginState === "failed" || pointerGestureRef.current !== gesture) return;
        if (!result.accepted) {
          gesture.beginState = "unavailable";
          setInputFallback(true);
          const terminal = gesture.terminal;
          if (terminal?.phase === "end" && terminal.fallback) {
            await runInput(terminal.fallback, true, gesture);
            finishGesture(gesture);
          } else if (terminal) finishGesture(gesture);
          return;
        }
        gesture.beginState = "active";
        setInputFallback(false);
        void pumpGesture(gesture);
      } catch (cause) { await unknownGesture(gesture, cause); }
    })();
    event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<FrameElement>): void => {
    const gesture = pointerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.terminal) return;
    if ((event.buttons & 1) === 0) { cancelPointerGesture(); return; }
    const point = ratio(event);
    if (!point) { cancelPointerGesture(); return; }
    gesture.last = point;
    gesture.pendingMove = point;
    resetWatchdog(gesture);
    if (gesture.beginState === "active") void pumpGesture(gesture);
    event.preventDefault();
  };

  const onPointerUp = (event: ReactPointerEvent<FrameElement>): void => {
    const gesture = pointerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.terminal) return;
    const end = ratio(event);
    if (!end) { cancelPointerGesture(); return; }
    const distance = Math.hypot(event.clientX - gesture.startClientX,
      event.clientY - gesture.startClientY);
    const durationMs = Math.round(Math.min(2_000,
      Math.max(100, performance.now() - gesture.startedAt)));
    const fallback: SimulatorViewerInputView = distance < 8
      ? { action: "tap", xRatio: end.xRatio, yRatio: end.yRatio }
      : { action: "swipe", startXRatio: gesture.start.xRatio,
        startYRatio: gesture.start.yRatio, endXRatio: end.xRatio,
        endYRatio: end.yRatio, durationMs };
    gesture.last = end;
    gesture.terminal = { phase: "end", point: end, fallback };
    releaseCapture(gesture);
    if (gesture.beginState === "active") void pumpGesture(gesture);
    else if (gesture.beginState === "unavailable") {
      void runInput(fallback, true, gesture).finally(() => finishGesture(gesture));
    }
    event.preventDefault();
  };

  const recoverInput = async (): Promise<void> => {
    if (inputBusy || commandBusy || !enabled || !controlEnabled) return;
    setInputBusy(true);
    try {
      await reconcileRef.current();
      if (mountedRef.current) { setInputError(undefined); setCommandError(undefined); }
    } catch {
      if (mountedRef.current) setCommandError(t("simulator.inputRefreshFailed"));
    } finally {
      if (mountedRef.current) setInputBusy(false);
    }
  };

  const commandUnavailable = !enabled || !controlEnabled || !documentVisible || inputBusy || commandBusy ||
    inputError !== undefined || commandError !== undefined || pointerGestureRef.current !== undefined;
  const nativeRecoverable = nativeRoute === "fallbackUnavailable" ||
    nativeRoute === "fallbackLost" || nativeRoute === "fallbackDecode";
  const nativeFallbackVisible = nativeRecoverable && interactive && presentation === "jpeg";
  const retryNativeRoute = (): void => {
    if (!nativeRecoverable || !interactive || commandUnavailable || nativeRecoveryRef.current) return;
    nativeRecoveryRef.current = true;
    setNativeRecoveryPending(true);
    setNativeRecoveryOutcome(undefined);
    setRetry(value => value + 1);
  };
  const runCommand = async (command: SimulatorViewerCommandView): Promise<void> => {
    if (commandUnavailable || !interactive || commandRequestRef.current) return;
    const request = new AbortController();
    commandRequestRef.current = request;
    const originalOwner = ownerKey;
    setCommandBusy(true);
    setCopied(false);
    setClipboardError(undefined);
    let dispatched = false;
    try {
      let action = command;
      if (action.action === "rotate") {
        const latest = await controllerRef.current.getSimulatorViewerControls(sessionId, route, request.signal);
        if (request.signal.aborted || ownerKeyRef.current !== originalOwner) return;
        setControls(latest);
        action = { action: "rotate", orientation: latest.orientation === "PORTRAIT"
          ? "LANDSCAPE" : "PORTRAIT" };
      }
      dispatched = true;
      await controllerRef.current.controlSimulatorViewerCommand(sessionId, randomUuid(), route,
        action, request.signal);
      if (!request.signal.aborted && ownerKeyRef.current === originalOwner) {
        setControls(undefined);
        try { setControls(await controllerRef.current.getSimulatorViewerControls(sessionId, route,
          request.signal)); }
        catch { /* A completed command can transiently interrupt video; the next frame refreshes state. */ }
      }
    } catch (cause) {
      if (!request.signal.aborted && mountedRef.current && ownerKeyRef.current === originalOwner) {
        setCommandError(`${t(dispatched ? "simulator.actionUnconfirmed"
          : "simulator.inputRefreshFailed")} ${messageOf(cause)}`);
        if (dispatched) await reconcileRef.current().catch(() => undefined);
      }
    } finally {
      if (commandRequestRef.current === request) commandRequestRef.current = undefined;
      if (mountedRef.current) setCommandBusy(false);
    }
  };

  const copyScreenshot = (): void => {
    if (commandUnavailable || commandRequestRef.current) return;
    const clipboard = ownerDocument.defaultView?.navigator.clipboard;
    const ClipboardItemCtor = ownerDocument.defaultView?.ClipboardItem;
    if (!clipboard?.write || !ClipboardItemCtor) {
      setClipboardError(t("simulator.clipboardUnavailable"));
      return;
    }
    const request = new AbortController();
    commandRequestRef.current = request;
    const originalOwner = ownerKey;
    setCommandBusy(true);
    setCopied(false);
    setClipboardError(undefined);
    let captureError: unknown;
    let captureConfirmed = false;
    const image = (async (): Promise<Blob> => {
      try {
        const result = await controllerRef.current.controlSimulatorViewerCommand(sessionId,
          randomUuid(), route, { action: "copyScreenshot" }, request.signal);
        captureConfirmed = true;
        if (!result.screenshotBlobId || request.signal.aborted || ownerKeyRef.current !== originalOwner) {
          throw new Error("Simulator screenshot owner changed before copy.");
        }
        const blobId = result.screenshotBlobId;
        const url = await controllerRef.current.getArtifactUrl(blobId);
        try {
          const response = await fetch(url, { signal: request.signal });
          const blob = await response.blob();
          await requirePng(blob);
          return blob;
        } finally { controllerRef.current.releaseArtifactUrl(blobId); }
      } catch (cause) { captureError = cause; throw cause; }
    })();
    void image.catch(() => undefined);
    let write: Promise<void>;
    try { write = clipboard.write([new ClipboardItemCtor({ "image/png": image })]); }
    catch (cause) { write = Promise.reject(cause); }
    void write.then(() => {
      if (!request.signal.aborted && mountedRef.current && ownerKeyRef.current === originalOwner) {
        setCopied(true);
      }
    }).catch(async (cause: unknown) => {
      await image.catch(() => undefined);
      if (request.signal.aborted || !mountedRef.current || ownerKeyRef.current !== originalOwner) return;
      if (captureError !== undefined && !captureConfirmed) {
        setCommandError(`${t("simulator.actionUnconfirmed")} ${messageOf(captureError)}`);
        await reconcileRef.current().catch(() => undefined);
      } else setClipboardError(`${t("simulator.clipboardFailed")} ${messageOf(
        captureError ?? cause)}`);
    }).finally(() => {
      if (commandRequestRef.current === request) commandRequestRef.current = undefined;
      if (mountedRef.current) setCommandBusy(false);
    });
  };

  const notice = state === "paused" ? t("simulator.streamPaused")
    : state === "connecting" ? t("simulator.streamConnecting")
      : state === "reconnecting" ? t("simulator.streamReconnecting")
        : state === "disconnected" ? t("simulator.streamDisconnected") : "";
  const pointerProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: cancelPointerGesture,
    onLostPointerCapture: cancelPointerGesture
  };
  const controlsDisabled = !interactive || commandUnavailable;

  return <div className="simulator-viewer__interaction" role="group"
    aria-label={t("simulator.liveScreen")}>
    <div className="simulator-viewer__screen" ref={screenSlotRef}>
      <div className={`simulator-viewer__screen-frame${fittedScreenSize ? " is-fitted" : ""}`}
        style={fittedScreenSize ?? undefined}>
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
      </div>
      {presentation !== null && state === "streaming" && enabled && documentVisible &&
        <label className="simulator-viewer__quality">
        {t("simulator.videoQuality")}
        <select value={!nativeAvailable && quality === "experimental60" ? "high" : quality}
          disabled={inputBusy || nativeRecoveryPending}
          onChange={event => setQuality(event.target.value as VideoQuality)}>
          <option value="low">{t("simulator.videoLow")}</option>
          <option value="balanced">{t("simulator.videoBalanced")}</option>
          <option value="high">{t("simulator.videoHigh")}</option>
          {nativeAvailable && <option value="experimental60">{t("simulator.videoExperimental60")}</option>}
        </select>
      </label>}
    </div>
    <div className="simulator-viewer__toolbar" role="group" aria-label={t("simulator.deviceControls")}>
      <Button tone="ghost" disabled={controlsDisabled} onClick={() => void runCommand({ action: "home" })}>
        <House aria-hidden="true" />{t("simulator.home")}</Button>
      <Button tone="ghost" disabled={commandUnavailable} onClick={copyScreenshot}>
        <Camera aria-hidden="true" />{t("simulator.copyScreenshot")}</Button>
      <Button tone="ghost" disabled={controlsDisabled || controls === undefined}
        onClick={() => void runCommand({ action: "rotate", orientation: controls?.orientation === "PORTRAIT"
          ? "LANDSCAPE" : "PORTRAIT" })}>
        <RotateCw aria-hidden="true" />{t("simulator.rotate")}</Button>
      <Button tone="ghost" disabled={controlsDisabled} onClick={() => void runCommand({ action: "lock" })}>
        <LockKeyhole aria-hidden="true" />{t("simulator.lock")}</Button>
      <Button tone="ghost" disabled={controlsDisabled} onClick={() => void runCommand({ action: "unlock" })}>
        <UnlockKeyhole aria-hidden="true" />{t("simulator.unlock")}</Button>
    </div>
    <p className="simulator-viewer__telemetry" role="status">{t("simulator.telemetry", {
      fps: streamFps.toFixed(1),
      size: controls ? `${controls.viewportWidth}×${controls.viewportHeight}` : "—",
      stream: state === "streaming" && presentation === "h264" ? t("simulator.routeH264")
        : state === "streaming" && presentation === "jpeg" ? t("simulator.routeMjpeg")
          : t(`simulator.stream.${state}`),
      input: controls ? controls.nativeTouchAvailable && !inputFallback ? t("simulator.routeNativeTouch")
        : t("simulator.routeWdaInput") : t("simulator.routeUnknown")
    })}</p>
    {controls?.nativeTouchAvailable === true && !controls.multiTouchAvailable && !inputFallback &&
      <p className="simulator-viewer__telemetry" role="status">
        {t("simulator.multiTouchUnavailable")}
      </p>}
    {nativeFallbackVisible && <p className="simulator-viewer__telemetry" role="status">
      {t(`simulator.nativeRoute.${nativeRoute}`)}</p>}
    {(nativeFallbackVisible || nativeRecoveryPending) &&
      <div className="simulator-viewer__native-recovery">
        <span role={nativeRecoveryOutcome === "failed" ? "alert" : "status"}>
          {nativeRecoveryPending ? t("simulator.nativeRecoveryPending")
            : nativeRecoveryOutcome === "failed" ? t("simulator.nativeRecoveryFailed")
              : t("simulator.nativeRecoveryAvailable")}</span>
        <Button tone="ghost" disabled={nativeRecoveryPending || !interactive || commandUnavailable}
          onClick={retryNativeRoute}><RefreshCw aria-hidden="true" />{t("simulator.nativeRecoveryAction")}</Button>
      </div>}
    {nativeRecoveryOutcome === "restored" &&
      <p className="simulator-viewer__feedback" role="status">{t("simulator.nativeRecoveryRestored")}</p>}
    {nativeRecoveryOutcome === "failed" && !nativeFallbackVisible &&
      <p className="simulator-viewer__input-error" role="alert">{t("simulator.nativeRecoveryFailed")}</p>}
    {copied && <p className="simulator-viewer__feedback" role="status">{t("simulator.copied")}</p>}
    {clipboardError && <p className="simulator-viewer__input-error" role="alert">{clipboardError}</p>}
    {(inputError || commandError) && <div className="simulator-viewer__input-error" role="alert">
      <AlertTriangle aria-hidden="true" /><span>{inputError || commandError}</span>
      <Button tone="ghost" disabled={inputBusy || commandBusy || !enabled || !controlEnabled}
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

async function requirePng(blob: Blob): Promise<void> {
  if (blob.type !== "image/png" || blob.size < 8 || blob.size > 32 * 1024 * 1024) {
    throw new Error("Simulator screenshot is not a bounded PNG.");
  }
  const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => signature[index] === byte)) {
    throw new Error("Simulator screenshot PNG signature is invalid.");
  }
}

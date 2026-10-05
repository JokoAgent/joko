import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent
} from "react-native";
import { Image as ExpoImage, type ImageLoadEventData, type ImageProps as ExpoImageProps } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { SvgXml } from "react-native-svg";
import type {
  MobileBurnedImage,
  MobileComposerImageEditorSession
} from "./mobile-composer-image-editor";
import {
  MOBILE_ANNOTATION_MAX_POINTS,
  MOBILE_ANNOTATION_MAX_STROKES,
  MOBILE_ANNOTATION_OUTLINE_COLOR,
  MOBILE_ANNOTATION_OUTLINE_RATIO,
  MOBILE_ANNOTATION_STROKE_COLOR,
  decodeMobileBase64,
  mobileAnnotationDisplayRect,
  mobileAnnotationStrokePath,
  mobileAnnotationStrokeWidth,
  normalizeMobileAnnotationPoint,
  shouldAppendMobileAnnotationPoint,
  type MobileImageAnnotationPoint,
  type MobileImageAnnotationStroke
} from "./mobile-image-annotation";
import {
  MOBILE_LIGHTBOX_DOUBLE_TAP_MILLISECONDS,
  MOBILE_LIGHTBOX_MAX_SCALE,
  MOBILE_LIGHTBOX_MIN_SCALE,
  MOBILE_LIGHTBOX_TAP_DISTANCE,
  clampMobileImageTransform,
  mobileAccessibleZoomTransform,
  mobileContainedImageSize,
  mobileDoubleTapTransform,
  mobileLightboxCanStartDismiss,
  mobileLightboxIsTap,
  mobileLightboxIsZoomed,
  mobileLightboxPointerIntent,
  mobileLightboxShouldDismiss,
  mobileLightboxSwipePageIndex,
  mobilePinchTransform,
  mobileTouchCentroid,
  mobileTouchDistance,
  type MobileImageSize,
  type MobileImageTransform,
  type MobileLightboxPointerIntent,
  type MobileTouchPoint
} from "./mobile-image-lightbox";
import { useMobileAnnotationBurn } from "./use-mobile-annotation-burn";
import { mobileImageGalleryNativeAnimationMatches, type MobileImageGalleryNativeDecode, type MobileImageGalleryDescriptor, type MobileImageGalleryPageSession } from "./mobile-image-gallery";
import type { MobileTimelineImagePreview } from "./mobile-timeline-images";
import type { MobileImageOutputAction, MobileImageOutputRenderedImage } from "./mobile-image-output";
import { mobileImageOutputMediaType } from "./mobile-image-output-format";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";

interface MobileImageLightboxGalleryControls {
  readonly descriptor: MobileImageGalleryDescriptor;
  readonly pageIndex: number;
  readonly pageKey: string;
  readonly preview?: MobileTimelineImagePreview;
  readonly adjacentPreviews?: readonly { readonly pageIndex: number; readonly preview: MobileTimelineImagePreview }[];
  readonly busy: boolean;
  readonly error?: string;
  readonly onRetry: () => void;
  readonly onNativeFailed: (loadId: string, automatically?: boolean) => void;
  readonly onPreviewFailed: (previewId: string) => void;
  readonly onNavigate: (pageIndex: number) => void;
  readonly onAddOriginal: (signal: AbortSignal) => Promise<void>;
  readonly onShareOriginal: (signal: AbortSignal, onDispatch: () => void) => Promise<void>;
  readonly onDecoded: (decoded: MobileImageGalleryNativeDecode) => void;
}

const PreviewImage = ExpoImage as unknown as ComponentType<ExpoImageProps>;

interface MobileImageLightboxBaseProps {
  readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
  readonly onSave: (
    strokes: readonly MobileImageAnnotationStroke[],
    burned: MobileBurnedImage | undefined,
    signal: AbortSignal
  ) => Promise<void>;
  readonly onOutputAction?: (
    action: MobileImageOutputAction,
    decoded: MobileImageGalleryNativeDecode,
    rendered: MobileImageOutputRenderedImage | undefined,
    signal: AbortSignal
  ) => Promise<string | void>;
  readonly onNativeActivityChange?: (active: boolean) => void;
}

type MobileImageLightboxProps = MobileImageLightboxBaseProps & (
  | { readonly session: MobileComposerImageEditorSession; readonly gallery?: never }
  | { readonly session?: MobileImageGalleryPageSession; readonly gallery: MobileImageLightboxGalleryControls }
);

interface ActiveGesture {
  mode: MobileLightboxPointerIntent;
  startedAt: number;
  start: MobileTouchPoint;
  last: MobileTouchPoint;
  initialTransform: MobileImageTransform;
  initialCentroid: MobileTouchPoint;
  initialDistance: number;
  maxDistance: number;
  dismissRejected: boolean;
}

const initialTransform: MobileImageTransform = { scale: 1, translateX: 0, translateY: 0 };
const emptySize: MobileImageSize = { width: 0, height: 0 };

export function MobileImageLightbox({
  session,
  locale,
  gallery,
  onClose,
  onSave,
  onOutputAction,
  onNativeActivityChange
}: MobileImageLightboxProps) {
  const page = gallery?.descriptor.pages[gallery.pageIndex];
  const loadKey = session?.leaseId ?? gallery?.pageKey ?? "";
  const fileName = session?.fileName ?? page?.title ?? "";
  const sourceMediaType = session?.sourceMediaType ?? page?.mediaType ?? "";
  const annotatable = session?.annotatable === true;
  const initialStrokes = useMemo(() => cloneStrokes(session?.initialStrokes ?? []), [loadKey]);
  const [strokes, setStrokes] = useState<readonly MobileImageAnnotationStroke[]>(initialStrokes);
  const [draftStroke, setDraftStroke] = useState<MobileImageAnnotationStroke>();
  const [annotating, setAnnotating] = useState(false);
  const [transform, setTransform] = useState<MobileImageTransform>(initialTransform);
  const [container, setContainer] = useState<MobileImageSize>(emptySize);
  const [natural, setNatural] = useState<MobileImageSize>(emptySize);
  const [decoded, setDecoded] = useState<MobileImageGalleryNativeDecode>();
  const [decodedFor, setDecodedFor] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [outputAction, setOutputAction] = useState<MobileImageOutputAction>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [chromeBusy, setChromeBusy] = useState(false);
  const { burnIn, host } = useMobileAnnotationBurn();
  const strokesRef = useRef(strokes);
  const draftStrokeRef = useRef(draftStroke);
  const annotatingRef = useRef(annotating);
  const transformRef = useRef(transform);
  const containerRef = useRef(container);
  const naturalRef = useRef(natural);
  const decodedRef = useRef(decoded);
  const gestureRef = useRef<ActiveGesture | undefined>(undefined);
  const lastTapRef = useRef<{ readonly at: number; readonly point: MobileTouchPoint } | undefined>(undefined);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dismissResetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dismissY = useRef(new Animated.Value(0)).current;
  const pageX = useRef(new Animated.Value(0)).current;
  const pageAnimationRef = useRef<{ readonly id: object; readonly timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const saveControllerRef = useRef<AbortController | undefined>(undefined);
  const closedRef = useRef(false);
  const nativeActivityRef = useRef(false);
  const sawExpectedInactiveRef = useRef(false);
  const nativeActivityCallbackRef = useRef(onNativeActivityChange);
  const galleryRef = useRef(gallery);
  const closeCallbackRef = useRef(onClose);
  const loadOwnerRef = useRef(loadKey);
  loadOwnerRef.current = loadKey;
  strokesRef.current = strokes;
  draftStrokeRef.current = draftStroke;
  annotatingRef.current = annotating;
  transformRef.current = transform;
  containerRef.current = container;
  naturalRef.current = natural;
  decodedRef.current = decoded;
  galleryRef.current = gallery;
  closeCallbackRef.current = onClose;
  nativeActivityCallbackRef.current = onNativeActivityChange;

  const clearPendingTap = useCallback((clearLast = true) => {
    clearTimeout(tapTimerRef.current);
    tapTimerRef.current = undefined;
    if (clearLast) lastTapRef.current = undefined;
  }, []);
  const resetDismiss = useCallback(() => {
    clearTimeout(dismissResetTimerRef.current);
    dismissResetTimerRef.current = undefined;
    dismissY.stopAnimation();
    dismissY.setValue(0);
  }, [dismissY]);
  const resetPage = useCallback(() => {
    if (pageAnimationRef.current) clearTimeout(pageAnimationRef.current.timer);
    pageAnimationRef.current = undefined;
    pageX.stopAnimation(); pageX.setValue(0);
  }, [pageX]);
  const cancelGesture = useCallback(() => {
    clearPendingTap();
    resetDismiss();
    resetPage();
    gestureRef.current = undefined;
    setChromeBusy(false);
    draftStrokeRef.current = undefined;
    setDraftStroke(undefined);
  }, [clearPendingTap, resetDismiss, resetPage]);
  const canInteract = useCallback(() => !closedRef.current && loadOwnerRef.current === loadKey
    && AppState.currentState === "active" && !saveControllerRef.current && !nativeActivityRef.current && !pageAnimationRef.current, [loadKey]);

  useEffect(() => {
    cancelGesture();
    saveControllerRef.current?.abort();
    saveControllerRef.current = undefined;
    const nextStrokes = cloneStrokes(initialStrokes);
    strokesRef.current = nextStrokes;
    draftStrokeRef.current = undefined;
    annotatingRef.current = false;
    transformRef.current = initialTransform;
    naturalRef.current = emptySize;
    gestureRef.current = undefined;
    lastTapRef.current = undefined;
    closedRef.current = false;
    setStrokes(nextStrokes);
    setDraftStroke(undefined);
    setAnnotating(false);
    setTransform(initialTransform);
    setNatural(emptySize);
    decodedRef.current = undefined;
    nativeActivityRef.current = false;
    sawExpectedInactiveRef.current = false;
    nativeActivityCallbackRef.current?.(false);
    setDecoded(undefined);
    setDecodedFor(undefined);
    setBusy(false);
    setOutputAction(undefined);
    setNotice("");
    setError("");
  }, [loadKey, cancelGesture]);

  const backdrop = gallery?.preview;
  useEffect(() => {
    if (!decodedRef.current && backdrop) {
      const size = { width: backdrop.width, height: backdrop.height }; naturalRef.current = size; setNatural(size);
    }
  }, [loadKey, backdrop?.leaseId]);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    cancelGesture();
    saveControllerRef.current?.abort();
    if (nativeActivityRef.current) {
      nativeActivityRef.current = false;
      nativeActivityCallbackRef.current?.(false);
    }
    closeCallbackRef.current();
  }, [cancelGesture]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      setForeground(status === "active");
      if (status === "active") return;
      cancelGesture();
      if (nativeActivityRef.current) {
        sawExpectedInactiveRef.current = true;
        return;
      }
      close();
    });
    return () => {
      closedRef.current = true;
      clearPendingTap();
      resetDismiss();
      resetPage();
      gestureRef.current = undefined;
      subscription.remove();
      saveControllerRef.current?.abort();
      if (nativeActivityRef.current) {
        nativeActivityRef.current = false;
        nativeActivityCallbackRef.current?.(false);
      }
    };
  }, [close, cancelGesture, clearPendingTap, resetDismiss, resetPage]);

  useEffect(() => {
    const next = clampMobileImageTransform(transformRef.current, container, natural);
    transformRef.current = next;
    setTransform(next);
  }, [container, natural]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: canInteract,
    onMoveShouldSetPanResponder: canInteract,
    onPanResponderGrant: (event) => {
      if (!canInteract()) return;
      clearPendingTap(false);
      resetDismiss();
      resetPage();
      setError("");
      const points = responderTouches(event);
      const first = points[0] ?? { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
      const intent = mobileLightboxPointerIntent(annotatingRef.current && annotatable, points.length || 1);
      if (intent === "transform") {
        clearPendingTap();
        setChromeBusy(true);
        const centroid = mobileTouchCentroid(points.slice(0, 2));
        gestureRef.current = {
          mode: "transform",
          startedAt: Date.now(),
          start: centroid,
          last: centroid,
          initialTransform: transformRef.current,
          initialCentroid: centroid,
          initialDistance: mobileTouchDistance(points[0]!, points[1]!),
          maxDistance: 0,
          dismissRejected: true
        };
        return;
      }
      const base: ActiveGesture = {
        mode: "pan",
        startedAt: Date.now(),
        start: first,
        last: first,
        initialTransform: transformRef.current,
        initialCentroid: first,
        initialDistance: 0,
        maxDistance: 0,
        dismissRejected: false
      };
      if (intent === "draw") {
        const point = annotationPoint(first, containerRef.current, naturalRef.current, transformRef.current);
        const existingPoints = strokePointCount(strokesRef.current);
        if (!point || strokesRef.current.length >= MOBILE_ANNOTATION_MAX_STROKES
          || existingPoints >= MOBILE_ANNOTATION_MAX_POINTS) {
          if (point) setError(mobileMessage(locale, "image.annotationLimit"));
          gestureRef.current = { ...base, mode: "idle" };
          return;
        }
        const next = { points: [point] };
        draftStrokeRef.current = next;
        setDraftStroke(next);
        gestureRef.current = { ...base, mode: "draw" };
        return;
      }
      gestureRef.current = base;
    },
    onPanResponderMove: (event, gestureState) => {
      if (loadOwnerRef.current !== loadKey) return;
      if (!canInteract()) { cancelGesture(); return; }
      const touches = responderTouches(event);
      let active = gestureRef.current;
      if (!active) return;
      if (touches.length >= 2) {
        setChromeBusy(true);
        const points = touches.slice(0, 2);
        const centroid = mobileTouchCentroid(points);
        const distance = mobileTouchDistance(points[0]!, points[1]!);
        if (active.mode !== "transform") {
          clearPendingTap();
          resetDismiss();
          resetPage();
          draftStrokeRef.current = undefined;
          setDraftStroke(undefined);
          active = {
            mode: "transform",
            startedAt: active.startedAt,
            start: centroid,
            last: centroid,
            initialTransform: transformRef.current,
            initialCentroid: centroid,
            initialDistance: distance,
            maxDistance: active.maxDistance,
            dismissRejected: true
          };
          gestureRef.current = active;
          return;
        }
        const next = mobilePinchTransform({
          initial: active.initialTransform,
          initialCentroid: active.initialCentroid,
          initialDistance: active.initialDistance,
          centroid,
          distance,
          container: containerRef.current,
          natural: naturalRef.current
        });
        active.last = centroid;
        transformRef.current = next;
        setTransform(next);
        return;
      }
      const point = touches[0] ?? {
        x: active.start.x + gestureState.dx,
        y: active.start.y + gestureState.dy
      };
      active.last = point;
      active.maxDistance = Math.max(active.maxDistance, Math.hypot(gestureState.dx, gestureState.dy), mobileTouchDistance(active.start, point));
      if (active.maxDistance > MOBILE_LIGHTBOX_TAP_DISTANCE) clearPendingTap();
      if (active.mode === "draw") {
        const normalized = annotationPoint(point, containerRef.current, naturalRef.current, transformRef.current);
        const draft = draftStrokeRef.current;
        if (!normalized || !draft || !shouldAppendMobileAnnotationPoint(draft, normalized)) return;
        if (strokePointCount(strokesRef.current) + draft.points.length >= MOBILE_ANNOTATION_MAX_POINTS) {
          setError(mobileMessage(locale, "image.annotationLimit"));
          return;
        }
        const next = { points: [...draft.points, normalized] };
        draftStrokeRef.current = next;
        setDraftStroke(next);
        return;
      }
      if (active.mode === "pan") {
        if (mobileLightboxIsZoomed(transformRef.current.scale) && active.maxDistance >= 1) setChromeBusy(true);
        if (Math.abs(gestureState.dx) > 12) active.dismissRejected = true;
        const activeGallery = galleryRef.current;
        if (!annotatingRef.current && !mobileLightboxIsZoomed(transformRef.current.scale) && activeGallery
          && activeGallery.descriptor.pages.length > 1 && Math.abs(gestureState.dx) > 12
          && Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.2) active.mode = "page";
        if (active.mode === "page") {
          clearPendingTap(); setChromeBusy(true);
          const hasPage = gestureState.dx < 0 ? activeGallery!.pageIndex + 1 < activeGallery!.descriptor.pages.length : activeGallery!.pageIndex > 0;
          pageX.setValue(Math.max(-containerRef.current.width, Math.min(containerRef.current.width, gestureState.dx * (hasPage ? 1 : 0.25))));
          return;
        }
        if (!active.dismissRejected && !annotatingRef.current
          && mobileLightboxCanStartDismiss(gestureState.dx, gestureState.dy, transformRef.current.scale)) {
          active.mode = "dismiss";
          dismissY.setValue(gestureState.dy);
          return;
        }
        const next = clampMobileImageTransform({
          scale: active.initialTransform.scale,
          translateX: active.initialTransform.translateX + gestureState.dx,
          translateY: active.initialTransform.translateY + gestureState.dy
        }, containerRef.current, naturalRef.current);
        transformRef.current = next;
        setTransform(next);
      } else if (active.mode === "dismiss") {
        dismissY.setValue(gestureState.dy);
      } else if (active.mode === "page") {
        const current = galleryRef.current!;
        const hasPage = gestureState.dx < 0 ? current.pageIndex + 1 < current.descriptor.pages.length : current.pageIndex > 0;
        pageX.setValue(Math.max(-containerRef.current.width, Math.min(containerRef.current.width, gestureState.dx * (hasPage ? 1 : 0.25))));
      }
    },
    onPanResponderRelease: (_event, gestureState) => {
      if (loadOwnerRef.current !== loadKey) return;
      if (!canInteract()) { cancelGesture(); return; }
      const active = gestureRef.current;
      gestureRef.current = undefined;
      setChromeBusy(false);
      if (!active) return;
      if (active.mode === "page") {
        const current = galleryRef.current!;
        const nextPage = mobileLightboxSwipePageIndex({ currentIndex: current.pageIndex, pageCount: current.descriptor.pages.length,
          translationX: gestureState.dx, translationY: gestureState.dy, velocityX: gestureState.vx * 1_000,
          scale: transformRef.current.scale, annotating: annotatingRef.current });
        const id = {};
        const timer = setTimeout(() => { if (pageAnimationRef.current?.id === id) { resetPage(); setChromeBusy(false); } }, 1_000);
        pageAnimationRef.current = { id, timer }; setChromeBusy(true);
        const animation = nextPage === undefined
          ? Animated.spring(pageX, { toValue: 0, damping: 20, stiffness: 240, useNativeDriver: true })
          : Animated.timing(pageX, { toValue: nextPage < current.pageIndex ? containerRef.current.width : -containerRef.current.width,
            duration: 180, useNativeDriver: true });
        animation.start(({ finished }) => {
          if (pageAnimationRef.current?.id !== id || loadOwnerRef.current !== loadKey) return;
          resetPage(); setChromeBusy(false);
          if (finished && nextPage !== undefined && canInteract() && galleryRef.current?.pageKey === current.pageKey) current.onNavigate(nextPage);
        });
        return;
      }
      if (active.mode === "dismiss") {
        clearPendingTap();
        // PanResponder velocity is points per millisecond; the dismissal threshold uses points per second.
        if (mobileLightboxShouldDismiss(gestureState.dy, gestureState.vy * 1_000, transformRef.current.scale)) {
          close();
        } else {
          Animated.spring(dismissY, { toValue: 0, damping: 20, stiffness: 240, useNativeDriver: true }).start();
          const deadline = setTimeout(() => {
            if (dismissResetTimerRef.current === deadline && loadOwnerRef.current === loadKey && !closedRef.current) resetDismiss();
          }, 1_000);
          dismissResetTimerRef.current = deadline;
        }
        return;
      }
      if (active.mode === "draw") {
        const draft = draftStrokeRef.current;
        draftStrokeRef.current = undefined;
        setDraftStroke(undefined);
        if (draft?.points.length) {
          const next = [...strokesRef.current, draft];
          strokesRef.current = next;
          setStrokes(next);
        }
        return;
      }
      if (active.mode !== "pan") {
        lastTapRef.current = undefined;
        return;
      }
      const activeGallery = galleryRef.current;
      const nextPage = activeGallery ? mobileLightboxSwipePageIndex({
        currentIndex: activeGallery.pageIndex,
        pageCount: activeGallery.descriptor.pages.length,
        translationX: gestureState.dx,
        translationY: gestureState.dy,
        scale: transformRef.current.scale,
        annotating: annotatingRef.current
      }) : undefined;
      if (nextPage !== undefined && activeGallery) {
        cancelGesture();
        strokesRef.current = cloneStrokes(initialStrokes);
        draftStrokeRef.current = undefined;
        annotatingRef.current = false;
        transformRef.current = initialTransform;
        setStrokes(strokesRef.current);
        setDraftStroke(undefined);
        setAnnotating(false);
        setTransform(initialTransform);
        activeGallery.onNavigate(nextPage);
        return;
      }
      const now = Date.now();
      const distance = Math.max(active.maxDistance, Math.hypot(gestureState.dx, gestureState.dy));
      if (!mobileLightboxIsTap(active.startedAt, now, distance)) {
        lastTapRef.current = undefined;
        return;
      }
      const tap = active.last;
      const previous = lastTapRef.current;
      if (previous && now - previous.at <= MOBILE_LIGHTBOX_DOUBLE_TAP_MILLISECONDS
        && Math.hypot(tap.x - previous.point.x, tap.y - previous.point.y) <= MOBILE_LIGHTBOX_TAP_DISTANCE * 2) {
        const next = mobileDoubleTapTransform(
          transformRef.current,
          tap,
          containerRef.current,
          naturalRef.current
        );
        transformRef.current = next;
        setTransform(next);
        clearPendingTap();
      } else {
        const pending = { at: now, point: tap };
        lastTapRef.current = pending;
        if (!annotatingRef.current && !mobileLightboxIsZoomed(transformRef.current.scale)) {
          tapTimerRef.current = setTimeout(() => {
            if (!canInteract() || gestureRef.current || lastTapRef.current !== pending
              || annotatingRef.current || mobileLightboxIsZoomed(transformRef.current.scale)) return;
            clearPendingTap();
            close();
          }, MOBILE_LIGHTBOX_DOUBLE_TAP_MILLISECONDS);
        }
      }
    },
    onPanResponderTerminate: () => {
      if (loadOwnerRef.current === loadKey) cancelGesture();
    }
  }), [locale, annotatable, initialStrokes, canInteract, cancelGesture, clearPendingTap, resetDismiss, resetPage, dismissY, pageX, close, loadKey]);

  const displayed = mobileContainedImageSize(container, natural);
  const paths = [...strokes, ...(draftStroke ? [draftStroke] : [])];
  const dirty = !annotationStrokesEqual(strokes, initialStrokes);
  const interactionBusy = busy || gallery?.busy === true;
  const visibleError = error || gallery?.error || "";
  const drawingReady = session !== undefined && decodedFor === loadKey && decoded !== undefined && natural.width > 0 && natural.height > 0
    && container.width > 0 && container.height > 0;
  const gallerySession = gallery ? session : undefined;
  const originalOnly = session?.originalOnly === true || session?.animated === true || gallerySession?.expectedAnimated === true
    || mobileImageOutputMediaType(sourceMediaType) === undefined;
  const canAnnotate = annotatable && session?.originalOnly !== true && session?.animated !== true
    && gallerySession?.expectedAnimated !== true && decoded?.isAnimated !== true;
  const outputReady = drawingReady && !originalOnly && decoded?.isAnimated === false
    && mobileImageOutputMediaType(sourceMediaType) !== undefined;
  useEffect(() => {
    if (!gallery || !session || gallery.busy || decodedFor === loadKey) return;
    const deadline = setTimeout(() => {
      if (!closedRef.current && loadOwnerRef.current === loadKey) galleryRef.current?.onNativeFailed(session.leaseId, false);
    }, 12_000);
    return () => clearTimeout(deadline);
  }, [loadKey, decodedFor, gallery?.busy]);
  const updateContainer = (event: LayoutChangeEvent): void => {
    if (closedRef.current || loadOwnerRef.current !== loadKey) return;
    const next = {
      width: event.nativeEvent.layout.width,
      height: event.nativeEvent.layout.height
    };
    if (next.width !== containerRef.current.width || next.height !== containerRef.current.height) cancelGesture();
    containerRef.current = next;
    setContainer(next);
  };
  const zoom = (delta: number): void => {
    cancelGesture();
    const next = mobileAccessibleZoomTransform(
      transformRef.current,
      delta,
      containerRef.current,
      naturalRef.current
    );
    transformRef.current = next;
    setTransform(next);
  };
  const resetTransform = (): void => {
    cancelGesture();
    transformRef.current = initialTransform;
    setTransform(initialTransform);
  };
  const undo = (): void => {
    cancelGesture();
    const next = strokesRef.current.slice(0, -1);
    strokesRef.current = next;
    draftStrokeRef.current = undefined;
    setDraftStroke(undefined);
    setStrokes(next);
    setError("");
  };
  const discard = (): void => {
    cancelGesture();
    const next = cloneStrokes(initialStrokes);
    strokesRef.current = next;
    draftStrokeRef.current = undefined;
    setDraftStroke(undefined);
    setStrokes(next);
    setAnnotating(false);
    setError("");
  };
  const navigate = (pageIndex: number): void => {
    if (!gallery || busy || pageIndex < 0 || pageIndex >= gallery.descriptor.pages.length
      || pageIndex === gallery.pageIndex) return;
    cancelGesture();
    const next = cloneStrokes(initialStrokes);
    strokesRef.current = next;
    draftStrokeRef.current = undefined;
    annotatingRef.current = false;
    transformRef.current = initialTransform;
    setStrokes(next);
    setDraftStroke(undefined);
    setAnnotating(false);
    setTransform(initialTransform);
    setError("");
    gallery.onNavigate(pageIndex);
  };
  const addOriginal = async (): Promise<void> => {
    if (!gallery || saveControllerRef.current || !gallerySession?.addable || !drawingReady) return;
    cancelGesture();
    const controller = new AbortController();
    saveControllerRef.current = controller;
    setBusy(true);
    setError("");
    try {
      await gallery.onAddOriginal(controller.signal);
      controller.signal.throwIfAborted();
      if (saveControllerRef.current === controller) {
        saveControllerRef.current = undefined;
        setBusy(false);
      }
      close();
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : mobileMessage(locale, "image.galleryAddError"));
      }
    } finally {
      if (saveControllerRef.current === controller) {
        saveControllerRef.current = undefined;
        setBusy(false);
      }
    }
  };
  const save = async (): Promise<void> => {
    if (!session || saveControllerRef.current || !dirty || gallery?.busy || !canAnnotate) return;
    cancelGesture();
    const controller = new AbortController();
    saveControllerRef.current = controller;
    setBusy(true);
    setError("");
    try {
      const exactStrokes = cloneStrokes(strokesRef.current);
      let burned: MobileBurnedImage | undefined;
      if (exactStrokes.length > 0) {
        const result = await burnIn({
          base64: session.sourceBase64,
          mediaType: session.sourceMediaType,
          strokes: exactStrokes
        });
        controller.signal.throwIfAborted();
        burned = {
          bytes: decodeMobileBase64(result.base64, session.maximumBytes),
          mediaType: result.mediaType,
          width: result.width,
          height: result.height
        };
      }
      await onSave(exactStrokes, burned, controller.signal);
      controller.signal.throwIfAborted();
      if (saveControllerRef.current === controller) {
        saveControllerRef.current = undefined;
        setBusy(false);
      }
      close();
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : mobileMessage(locale, "image.annotationSaveError"));
      }
    } finally {
      if (saveControllerRef.current === controller) {
        saveControllerRef.current = undefined;
        setBusy(false);
      }
    }
  };
  const output = async (action: MobileImageOutputAction): Promise<void> => {
    const exactDecoded = decodedRef.current;
    const originalShare = action === "share" && originalOnly && gallery?.onShareOriginal;
    if (!session || (!originalShare && (!onOutputAction || !outputReady)) || saveControllerRef.current || !exactDecoded
      || !drawingReady || gallery?.busy) return;
    cancelGesture();
    const controller = new AbortController();
    saveControllerRef.current = controller;
    setBusy(true);
    setOutputAction(action);
    setNotice("");
    setError("");
    const invokesNativeUi = action === "save" || action === "share";
    const nativeDispatch = (): void => {
      controller.signal.throwIfAborted();
      if (closedRef.current || loadOwnerRef.current !== session.leaseId || AppState.currentState !== "active") {
        throw new Error(mobileMessage(locale, "image.outputError"));
      }
      nativeActivityRef.current = true;
      sawExpectedInactiveRef.current = false;
      nativeActivityCallbackRef.current?.(true);
    };
    try {
      const exactStrokes = originalShare ? [] : cloneStrokes(strokesRef.current);
      const sourceMediaType = session.sourceMediaType.trim().toLowerCase();
      const requiresRender = !originalShare && (exactStrokes.length > 0
        || action === "copy" && sourceMediaType !== "image/jpeg" && sourceMediaType !== "image/png");
      let rendered: MobileImageOutputRenderedImage | undefined;
      if (requiresRender) {
        const result = await burnIn({
          base64: session.sourceBase64,
          mediaType: session.sourceMediaType,
          strokes: exactStrokes
        });
        controller.signal.throwIfAborted();
        rendered = {
          bytes: decodeMobileBase64(result.base64, MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES),
          mediaType: result.mediaType,
          width: result.width,
          height: result.height
        };
      }
      if (invokesNativeUi && !originalShare) nativeDispatch();
      const message = originalShare ? await originalShare(controller.signal, nativeDispatch)
        : await onOutputAction!(action, exactDecoded, rendered, controller.signal);
      controller.signal.throwIfAborted();
      setNotice(message || imageOutputSuccessMessage(action, locale));
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : mobileMessage(locale, "image.outputError"));
      }
    } finally {
      if (invokesNativeUi && nativeActivityRef.current) {
        nativeActivityRef.current = false;
        nativeActivityCallbackRef.current?.(false);
      }
      if (saveControllerRef.current === controller) {
        saveControllerRef.current = undefined;
        setBusy(false);
        setOutputAction(undefined);
      }
      if (sawExpectedInactiveRef.current) close();
    }
  };

  return <Modal visible transparent animationType="fade" presentationStyle="overFullScreen" statusBarTranslucent
    onRequestClose={close} supportedOrientations={["portrait", "landscape"]}>
    <View style={styles.root}>
      <Animated.View pointerEvents="none" style={[styles.backdrop, { opacity: dismissY.interpolate({
        inputRange: [-300, 0, 300], outputRange: [0.4, 1, 0.4], extrapolate: "clamp"
      }) }]} />
      <View accessibilityRole="image" accessibilityLabel={mobileMessage(locale, "image.previewLabel", { name: fileName })}
        style={styles.canvas} onLayout={updateContainer} {...panResponder.panHandlers}>
        <Animated.View pointerEvents="none" style={[styles.pageStrip, { transform: [{ translateX: pageX }] }]}>
        {gallery && [-1, 1].map((delta) => {
          const index = gallery.pageIndex + delta; const neighbor = gallery.descriptor.pages[index];
          if (!neighbor) return null;
          const preview = gallery.adjacentPreviews?.find((item) => item.pageIndex === index)?.preview;
          return <View key={neighbor.pageId} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
            style={[styles.adjacentPage, { left: delta * container.width, width: container.width }]}>
            {preview ? <PreviewImage key={preview.leaseId} accessible={false} source={{ uri: preview.uri }} contentFit="contain"
              cachePolicy="none" autoplay={false} style={styles.image}
              onError={() => { if (!closedRef.current && loadOwnerRef.current === loadKey
                && galleryRef.current?.adjacentPreviews?.some((item) => item.pageIndex === index && item.preview.leaseId === preview.leaseId)) galleryRef.current.onPreviewFailed(preview.leaseId); }} />
              : <View style={styles.adjacentLoading}><ActivityIndicator color="#ff9800" /><Text numberOfLines={1} style={styles.meta}>{neighbor.title}</Text></View>}
          </View>;
        })}
        {displayed.width > 0 && displayed.height > 0 && <Animated.View pointerEvents="none" style={[
          styles.imagePosition,
          {
            width: displayed.width,
            height: displayed.height,
            left: (container.width - displayed.width) / 2 + transform.translateX,
            top: (container.height - displayed.height) / 2 + transform.translateY,
            transform: [{ translateY: dismissY }, { scale: dismissY.interpolate({
              inputRange: [-300, 0, 300], outputRange: [0.9, 1, 0.9], extrapolate: "clamp"
            }) }]
          }
        ]}>
          <View style={[styles.imageScale, { transform: [{ scale: transform.scale }] }]}>
            {backdrop && !drawingReady && <PreviewImage key={backdrop.leaseId} accessible={false} source={{ uri: backdrop.uri }} contentFit="fill"
              cachePolicy="none" autoplay={foreground && !closedRef.current} style={styles.image}
              onError={() => { if (!closedRef.current && galleryRef.current?.preview?.leaseId === backdrop.leaseId) galleryRef.current.onPreviewFailed(backdrop.leaseId); }} />}
            {session && <PreviewImage key={session.leaseId} accessible={false} source={{ uri: session.previewUri }} contentFit="fill"
              cachePolicy="none" style={[styles.image, { opacity: drawingReady ? 1 : 0 }]}
              autoplay={foreground && !closedRef.current && gallery?.busy !== true}
              onLoad={(event: ImageLoadEventData) => {
                if (closedRef.current || loadOwnerRef.current !== session.leaseId || galleryRef.current?.busy) return;
                const { width, height, mediaType, isAnimated } = event.source;
                try {
                  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
                    throw new Error(mobileMessage(locale, "image.decoderDimensions"));
                  }
                  if (gallery) {
                    if (width !== gallerySession?.expectedWidthPixels || height !== gallerySession?.expectedHeightPixels
                      || !mobileImageGalleryNativeAnimationMatches(session.sourceMediaType, gallerySession.expectedAnimated, isAnimated)) {
                      throw new Error(mobileMessage(locale, "image.galleryMetadata"));
                    }
                    gallery.onDecoded({ width, height, mediaType, isAnimated });
                  }
                  const next = { width, height };
                  naturalRef.current = next;
                  setNatural(next);
                  const exactDecoded = { width, height, mediaType, isAnimated };
                  decodedRef.current = exactDecoded;
                  setDecoded(exactDecoded);
                  setDecodedFor(loadKey);
                  setError("");
                } catch (failure) {
                  decodedRef.current = undefined;
                  setDecoded(undefined);
                  setError(failure instanceof Error ? failure.message : mobileMessage(locale, "image.verifyError"));
                  gallery?.onNativeFailed(session.leaseId, false);
                }
              }}
              onError={() => {
                if (closedRef.current || loadOwnerRef.current !== session.leaseId || galleryRef.current?.busy) return;
                decodedRef.current = undefined;
                setDecoded(undefined);
                setError(mobileMessage(locale, "image.displayError"));
                gallery?.onNativeFailed(session.leaseId);
              }} />}
            {natural.width > 0 && natural.height > 0 && paths.length > 0 && <View
              pointerEvents="none" style={styles.annotation}>
              <SvgXml xml={annotationSvgXml(paths, natural)} width="100%" height="100%" />
            </View>}
          </View>
        </Animated.View>}
        {!drawingReady && !visibleError && <View pointerEvents="none" style={styles.loading}>
          <ActivityIndicator color="#ff9800" />
        </View>}
        </Animated.View>
      </View>
      <Animated.View testID="image-lightbox-chrome" pointerEvents={chromeBusy ? "none" : "box-none"}
        accessibilityElementsHidden={chromeBusy} importantForAccessibility={chromeBusy ? "no-hide-descendants" : "auto"}
        style={[styles.chrome, { opacity: chromeBusy ? 0 : dismissY.interpolate({
          inputRange: [-300, 0, 300], outputRange: [0.4, 1, 0.4], extrapolate: "clamp"
        }) }]}>
      <SafeAreaView pointerEvents="box-none" style={styles.chromeSafeArea} edges={["top", "right", "bottom", "left"]}>
      <View style={styles.header}>
        <ToolButton label={mobileMessage(locale, "image.close")} onPress={close} disabled={false} />
        <View pointerEvents="none" style={styles.heading}>
          <Text numberOfLines={1} style={styles.fileName}>{fileName}</Text>
          <Text style={styles.meta}>{gallery
            ? mobileMessage(locale, "image.galleryMeta", {
              source: gallery.descriptor.sourceLabel,
              index: gallery.pageIndex + 1,
              count: gallery.descriptor.pages.length,
              scale: transform.scale.toFixed(1)
            })
            : mobileMessage(locale, "image.zoomMeta", { scale: transform.scale.toFixed(1) })}</Text>
        </View>
      </View>
      <View pointerEvents="box-none" style={styles.footer}>
      {visibleError !== "" && <Text accessibilityRole="alert" style={styles.error}>{visibleError}</Text>}
      {notice !== "" && <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}
      <View style={styles.toolbar}>
        {gallery && <ToolButton label={mobileMessage(locale, "image.previous")} onPress={() => navigate(gallery.pageIndex - 1)}
          disabled={busy || gallery.pageIndex === 0} />}
        {gallery && <Text accessibilityLiveRegion="polite" style={styles.pageCount}>
          {gallery.pageIndex + 1} / {gallery.descriptor.pages.length}
        </Text>}
        {gallery && <ToolButton label={mobileMessage(locale, "image.next")} onPress={() => navigate(gallery.pageIndex + 1)}
          disabled={busy || gallery.pageIndex + 1 >= gallery.descriptor.pages.length} />}
        {gallery && visibleError && <ToolButton label={mobileMessage(locale, "image.previewRetry", { name: fileName })}
          onPress={() => { cancelGesture(); gallery.onRetry(); }} disabled={busy || gallery.busy} />}
        {onOutputAction && !originalOnly && <ToolButton label={mobileMessage(locale, outputAction === "copy" ? "image.copying" : "image.copy")}
          onPress={() => void output("copy")} disabled={interactionBusy || !outputReady} />}
        {onOutputAction && !originalOnly && <ToolButton label={mobileMessage(locale, outputAction === "save" ? "image.saving" : "image.save")}
          onPress={() => void output("save")} disabled={interactionBusy || !outputReady} />}
        {(originalOnly ? gallery?.onShareOriginal : onOutputAction) && <ToolButton label={mobileMessage(locale, outputAction === "share" ? "image.sharing" : "image.share")}
          onPress={() => void output("share")} disabled={interactionBusy || !(originalOnly ? drawingReady : outputReady)} />}
        <ToolButton label={mobileMessage(locale, "image.zoomOut")} onPress={() => zoom(-0.5)}
          disabled={interactionBusy || transform.scale <= MOBILE_LIGHTBOX_MIN_SCALE} />
        <ToolButton label={mobileMessage(locale, "image.zoomIn")} onPress={() => zoom(0.5)}
          disabled={interactionBusy || transform.scale >= MOBILE_LIGHTBOX_MAX_SCALE} />
        <ToolButton label={mobileMessage(locale, "image.reset")} onPress={resetTransform}
          disabled={interactionBusy || transform.scale === 1 && transform.translateX === 0 && transform.translateY === 0} />
        {gallery && gallerySession?.addable && <ToolButton label={mobileMessage(locale, busy ? "image.adding" : "image.addOriginal")}
          onPress={() => void addOriginal()} disabled={interactionBusy || !drawingReady} emphasized />}
        {canAnnotate && <ToolButton label={mobileMessage(locale, "image.annotate")} selected={annotating}
          onPress={() => { cancelGesture(); annotatingRef.current = !annotatingRef.current; setAnnotating(annotatingRef.current); setError(""); }} disabled={interactionBusy || !drawingReady} />}
        {canAnnotate && <ToolButton label={mobileMessage(locale, "image.undo")} onPress={undo} disabled={interactionBusy || strokes.length === 0} />}
        {canAnnotate && <ToolButton label={mobileMessage(locale, "common.discard")} onPress={discard} disabled={interactionBusy || !dirty} />}
        {canAnnotate && <ToolButton label={mobileMessage(locale, busy ? "common.saving" : gallery ? "image.addMarked" : "common.save")}
          onPress={() => void save()} disabled={interactionBusy || !dirty || !drawingReady} emphasized />}
      </View>
      {annotating && <Text accessibilityLiveRegion="polite" style={styles.hint}>
        {mobileMessage(locale, "image.drawHint")}
      </Text>}
      </View>
    </SafeAreaView>
      </Animated.View>
      {host}
    </View>
  </Modal>;
}

function ToolButton({ label, disabled, selected, emphasized, onPress }: {
  readonly label: string;
  readonly disabled: boolean;
  readonly selected?: boolean;
  readonly emphasized?: boolean;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
    style={[styles.toolButton, selected && styles.toolSelected, emphasized && styles.toolEmphasized,
      disabled && styles.disabled]}>
    <Text style={[styles.toolText, emphasized && styles.toolEmphasizedText]}>{label}</Text>
  </Pressable>;
}

function responderTouches(event: GestureResponderEvent): MobileTouchPoint[] {
  return [...event.nativeEvent.touches].map((touch) => ({
    x: touch.locationX,
    y: touch.locationY
  }));
}

function annotationPoint(
  point: MobileImageAnnotationPoint,
  container: MobileImageSize,
  natural: MobileImageSize,
  transform: MobileImageTransform
): MobileImageAnnotationPoint | undefined {
  const rect = mobileAnnotationDisplayRect({
    containerWidth: container.width,
    containerHeight: container.height,
    naturalWidth: natural.width,
    naturalHeight: natural.height,
    translateX: transform.translateX,
    translateY: transform.translateY,
    scale: transform.scale
  });
  return rect ? normalizeMobileAnnotationPoint(point, rect) : undefined;
}

function strokePointCount(strokes: readonly MobileImageAnnotationStroke[]): number {
  return strokes.reduce((count, stroke) => count + stroke.points.length, 0);
}

function imageOutputSuccessMessage(action: MobileImageOutputAction, locale: MobileSupportedLocale): string {
  return mobileMessage(locale, action === "copy" ? "image.copied"
    : action === "save" ? "image.saved" : "image.shared");
}

function cloneStrokes(strokes: readonly MobileImageAnnotationStroke[]): MobileImageAnnotationStroke[] {
  return strokes.map((stroke) => ({ points: stroke.points.map((point) => ({ ...point })) }));
}

function annotationStrokesEqual(
  left: readonly MobileImageAnnotationStroke[],
  right: readonly MobileImageAnnotationStroke[]
): boolean {
  return left.length === right.length && left.every((stroke, index) => {
    const other = right[index];
    return other !== undefined && stroke.points.length === other.points.length
      && stroke.points.every((point, pointIndex) => {
        const candidate = other.points[pointIndex];
        return candidate !== undefined && point.x === candidate.x && point.y === candidate.y;
      });
  });
}

function annotationSvgXml(
  strokes: readonly MobileImageAnnotationStroke[],
  natural: MobileImageSize
): string {
  const strokeWidth = mobileAnnotationStrokeWidth(natural.width, natural.height);
  const paths = strokes.map((stroke) => {
    const path = mobileAnnotationStrokePath(stroke, natural.width, natural.height);
    return `<path d="${path}" fill="none" stroke="${MOBILE_ANNOTATION_OUTLINE_COLOR}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${strokeWidth * MOBILE_ANNOTATION_OUTLINE_RATIO}"/>`
      + `<path d="${path}" fill="none" stroke="${MOBILE_ANNOTATION_STROKE_COLOR}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${strokeWidth}"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${natural.width} ${natural.height}">${paths}</svg>`;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { position: "absolute", inset: 0, backgroundColor: "#050607" },
  chrome: { position: "absolute", inset: 0 },
  chromeSafeArea: { flex: 1, justifyContent: "space-between" },
  footer: { backgroundColor: "#050607b3" },
  header: { minHeight: 64, paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#050607b3" },
  heading: { flex: 1, minWidth: 0 },
  fileName: { color: "#f7f6f3", fontSize: 16, lineHeight: 21, fontWeight: "700" },
  meta: { color: "#adb6b7", fontSize: 12, lineHeight: 17 },
  canvas: { flex: 1, overflow: "hidden" },
  pageStrip: { position: "absolute", inset: 0 },
  adjacentPage: { position: "absolute", top: 0, bottom: 0 },
  adjacentLoading: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  imagePosition: { position: "absolute" },
  imageScale: { flex: 1 },
  image: { position: "absolute", inset: 0 },
  annotation: { position: "absolute", inset: 0 },
  loading: { position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" },
  error: { color: "#ff9c87", paddingHorizontal: 16, paddingVertical: 8, fontSize: 14, lineHeight: 20 },
  notice: { color: "#9ed7ad", paddingHorizontal: 16, paddingVertical: 8, fontSize: 14, lineHeight: 20 },
  toolbar: { minHeight: 64, paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
  pageCount: { color: "#f7f6f3", minHeight: 44, minWidth: 52, textAlign: "center", textAlignVertical: "center",
    paddingHorizontal: 6, paddingVertical: 12, fontSize: 14, lineHeight: 18, fontWeight: "700" },
  toolButton: { minHeight: 44, borderWidth: 1, borderColor: "#566064", borderRadius: 22,
    paddingHorizontal: 14, alignItems: "center", justifyContent: "center", backgroundColor: "#171b1e" },
  toolSelected: { borderColor: "#ff9800", backgroundColor: "#3c2b14" },
  toolEmphasized: { borderColor: "#ff9800", backgroundColor: "#ff9800" },
  toolText: { color: "#f7f6f3", fontSize: 14, lineHeight: 18, fontWeight: "700" },
  toolEmphasizedText: { color: "#2b2316" },
  disabled: { opacity: 0.45 },
  hint: { color: "#adb6b7", paddingHorizontal: 16, paddingBottom: 8, textAlign: "center", fontSize: 12, lineHeight: 17 }
});

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent
} from "react-native";
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
  mobileLightboxIsTap,
  mobileLightboxPointerIntent,
  mobilePinchTransform,
  mobileTouchCentroid,
  mobileTouchDistance,
  type MobileImageSize,
  type MobileImageTransform,
  type MobileLightboxPointerIntent,
  type MobileTouchPoint
} from "./mobile-image-lightbox";
import { useMobileAnnotationBurn } from "./use-mobile-annotation-burn";

interface MobileImageLightboxProps {
  readonly session: MobileComposerImageEditorSession;
  readonly onClose: () => void;
  readonly onSave: (
    strokes: readonly MobileImageAnnotationStroke[],
    burned: MobileBurnedImage | undefined,
    signal: AbortSignal
  ) => Promise<void>;
}

interface ActiveGesture {
  mode: MobileLightboxPointerIntent;
  startedAt: number;
  start: MobileTouchPoint;
  last: MobileTouchPoint;
  initialTransform: MobileImageTransform;
  initialCentroid: MobileTouchPoint;
  initialDistance: number;
}

const initialTransform: MobileImageTransform = { scale: 1, translateX: 0, translateY: 0 };
const emptySize: MobileImageSize = { width: 0, height: 0 };

export function MobileImageLightbox({ session, onClose, onSave }: MobileImageLightboxProps) {
  const initialStrokes = useMemo(() => cloneStrokes(session.initialStrokes), [session.leaseId]);
  const [strokes, setStrokes] = useState<readonly MobileImageAnnotationStroke[]>(initialStrokes);
  const [draftStroke, setDraftStroke] = useState<MobileImageAnnotationStroke>();
  const [annotating, setAnnotating] = useState(false);
  const [transform, setTransform] = useState<MobileImageTransform>(initialTransform);
  const [container, setContainer] = useState<MobileImageSize>(emptySize);
  const [natural, setNatural] = useState<MobileImageSize>(emptySize);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { burnIn, host } = useMobileAnnotationBurn();
  const strokesRef = useRef(strokes);
  const draftStrokeRef = useRef(draftStroke);
  const annotatingRef = useRef(annotating);
  const transformRef = useRef(transform);
  const containerRef = useRef(container);
  const naturalRef = useRef(natural);
  const gestureRef = useRef<ActiveGesture | undefined>(undefined);
  const lastTapRef = useRef<{ readonly at: number; readonly point: MobileTouchPoint } | undefined>(undefined);
  const saveControllerRef = useRef<AbortController | undefined>(undefined);
  const closedRef = useRef(false);
  strokesRef.current = strokes;
  draftStrokeRef.current = draftStroke;
  annotatingRef.current = annotating;
  transformRef.current = transform;
  containerRef.current = container;
  naturalRef.current = natural;

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    saveControllerRef.current?.abort();
    onClose();
  }, [onClose]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      if (status !== "active") close();
    });
    return () => {
      subscription.remove();
      saveControllerRef.current?.abort();
    };
  }, [close]);

  useEffect(() => {
    const next = clampMobileImageTransform(transformRef.current, container, natural);
    transformRef.current = next;
    setTransform(next);
  }, [container, natural]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !saveControllerRef.current,
    onMoveShouldSetPanResponder: () => !saveControllerRef.current,
    onPanResponderGrant: (event) => {
      setError("");
      const points = responderTouches(event);
      const first = points[0] ?? { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
      const intent = mobileLightboxPointerIntent(annotatingRef.current && session.annotatable, points.length || 1);
      if (intent === "transform") {
        const centroid = mobileTouchCentroid(points.slice(0, 2));
        gestureRef.current = {
          mode: "transform",
          startedAt: Date.now(),
          start: centroid,
          last: centroid,
          initialTransform: transformRef.current,
          initialCentroid: centroid,
          initialDistance: mobileTouchDistance(points[0]!, points[1]!)
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
        initialDistance: 0
      };
      if (intent === "draw") {
        const point = annotationPoint(first, containerRef.current, naturalRef.current, transformRef.current);
        const existingPoints = strokePointCount(strokesRef.current);
        if (!point || strokesRef.current.length >= MOBILE_ANNOTATION_MAX_STROKES
          || existingPoints >= MOBILE_ANNOTATION_MAX_POINTS) {
          if (point) setError("This annotation has reached its drawing limit.");
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
      const touches = responderTouches(event);
      let active = gestureRef.current;
      if (!active) return;
      if (touches.length >= 2) {
        const points = touches.slice(0, 2);
        const centroid = mobileTouchCentroid(points);
        const distance = mobileTouchDistance(points[0]!, points[1]!);
        if (active.mode !== "transform") {
          draftStrokeRef.current = undefined;
          setDraftStroke(undefined);
          active = {
            mode: "transform",
            startedAt: active.startedAt,
            start: centroid,
            last: centroid,
            initialTransform: transformRef.current,
            initialCentroid: centroid,
            initialDistance: distance
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
      if (active.mode === "draw") {
        const normalized = annotationPoint(point, containerRef.current, naturalRef.current, transformRef.current);
        const draft = draftStrokeRef.current;
        if (!normalized || !draft || !shouldAppendMobileAnnotationPoint(draft, normalized)) return;
        if (strokePointCount(strokesRef.current) + draft.points.length >= MOBILE_ANNOTATION_MAX_POINTS) {
          setError("This annotation has reached its drawing limit.");
          return;
        }
        const next = { points: [...draft.points, normalized] };
        draftStrokeRef.current = next;
        setDraftStroke(next);
        return;
      }
      if (active.mode === "pan") {
        const next = clampMobileImageTransform({
          scale: active.initialTransform.scale,
          translateX: active.initialTransform.translateX + gestureState.dx,
          translateY: active.initialTransform.translateY + gestureState.dy
        }, containerRef.current, naturalRef.current);
        transformRef.current = next;
        setTransform(next);
      }
    },
    onPanResponderRelease: (_event, gestureState) => {
      const active = gestureRef.current;
      gestureRef.current = undefined;
      if (!active) return;
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
      const now = Date.now();
      const distance = Math.hypot(gestureState.dx, gestureState.dy);
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
        lastTapRef.current = undefined;
      } else {
        lastTapRef.current = { at: now, point: tap };
      }
    },
    onPanResponderTerminate: () => {
      gestureRef.current = undefined;
      draftStrokeRef.current = undefined;
      setDraftStroke(undefined);
      lastTapRef.current = undefined;
    }
  }), [session.annotatable]);

  const displayed = mobileContainedImageSize(container, natural);
  const paths = [...strokes, ...(draftStroke ? [draftStroke] : [])];
  const dirty = !annotationStrokesEqual(strokes, initialStrokes);
  const drawingReady = natural.width > 0 && natural.height > 0 && container.width > 0 && container.height > 0;
  const updateContainer = (event: LayoutChangeEvent): void => {
    const next = {
      width: event.nativeEvent.layout.width,
      height: event.nativeEvent.layout.height
    };
    containerRef.current = next;
    setContainer(next);
  };
  const zoom = (delta: number): void => {
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
    transformRef.current = initialTransform;
    setTransform(initialTransform);
  };
  const undo = (): void => {
    const next = strokesRef.current.slice(0, -1);
    strokesRef.current = next;
    draftStrokeRef.current = undefined;
    setDraftStroke(undefined);
    setStrokes(next);
    setError("");
  };
  const discard = (): void => {
    const next = cloneStrokes(initialStrokes);
    strokesRef.current = next;
    draftStrokeRef.current = undefined;
    setDraftStroke(undefined);
    setStrokes(next);
    setAnnotating(false);
    setError("");
  };
  const save = async (): Promise<void> => {
    if (saveControllerRef.current || !dirty) return;
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
        setError(failure instanceof Error ? failure.message : "The annotated image could not be saved.");
      }
    } finally {
      if (saveControllerRef.current === controller) {
        saveControllerRef.current = undefined;
        setBusy(false);
      }
    }
  };

  return <Modal visible animationType="fade" presentationStyle="fullScreen" statusBarTranslucent
    onRequestClose={close} supportedOrientations={["portrait", "landscape"]}>
    <SafeAreaView style={styles.root} edges={["top", "right", "bottom", "left"]}>
      <View style={styles.header}>
        <ToolButton label="Close" onPress={close} disabled={false} />
        <View style={styles.heading}>
          <Text numberOfLines={1} style={styles.fileName}>{session.fileName}</Text>
          <Text style={styles.meta}>{transform.scale.toFixed(1)}× · pinch or double-tap to zoom</Text>
        </View>
      </View>
      <View accessibilityRole="image" accessibilityLabel={`Image preview ${session.fileName}`}
        style={styles.canvas} onLayout={updateContainer} {...panResponder.panHandlers}>
        {displayed.width > 0 && displayed.height > 0 && <View pointerEvents="none" style={[
          styles.imagePosition,
          {
            width: displayed.width,
            height: displayed.height,
            left: (container.width - displayed.width) / 2 + transform.translateX,
            top: (container.height - displayed.height) / 2 + transform.translateY
          }
        ]}>
          <View style={[styles.imageScale, { transform: [{ scale: transform.scale }] }]}>
            <Image accessible={false} source={{ uri: session.previewUri }} resizeMode="stretch" style={styles.image}
              onLoad={(event) => {
                const width = event.nativeEvent.source.width;
                const height = event.nativeEvent.source.height;
                if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
                  const next = { width, height };
                  naturalRef.current = next;
                  setNatural(next);
                  setError("");
                }
              }}
              onError={() => setError("The image preview could not be displayed.")} />
            {natural.width > 0 && natural.height > 0 && paths.length > 0 && <View
              pointerEvents="none" style={styles.annotation}>
              <SvgXml xml={annotationSvgXml(paths, natural)} width="100%" height="100%" />
            </View>}
          </View>
        </View>}
        {!drawingReady && !error && <View pointerEvents="none" style={styles.loading}>
          <ActivityIndicator color="#ff9800" />
        </View>}
      </View>
      {error !== "" && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <View style={styles.toolbar}>
        <ToolButton label="Zoom out" onPress={() => zoom(-0.5)}
          disabled={busy || transform.scale <= MOBILE_LIGHTBOX_MIN_SCALE} />
        <ToolButton label="Zoom in" onPress={() => zoom(0.5)}
          disabled={busy || transform.scale >= MOBILE_LIGHTBOX_MAX_SCALE} />
        <ToolButton label="Reset" onPress={resetTransform}
          disabled={busy || transform.scale === 1 && transform.translateX === 0 && transform.translateY === 0} />
        {session.annotatable && <ToolButton label="Annotate" selected={annotating}
          onPress={() => { setAnnotating((value) => !value); setError(""); }} disabled={busy || !drawingReady} />}
        {session.annotatable && <ToolButton label="Undo" onPress={undo} disabled={busy || strokes.length === 0} />}
        {session.annotatable && <ToolButton label="Discard" onPress={discard} disabled={busy || !dirty} />}
        {session.annotatable && <ToolButton label={busy ? "Saving…" : "Save"}
          onPress={() => void save()} disabled={busy || !dirty || !drawingReady} emphasized />}
      </View>
      {annotating && <Text accessibilityLiveRegion="polite" style={styles.hint}>
        Draw with one finger. Use two fingers to move and zoom.
      </Text>}
      {host}
    </SafeAreaView>
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
  root: { flex: 1, backgroundColor: "#050607" },
  header: { minHeight: 64, paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 12 },
  heading: { flex: 1, minWidth: 0 },
  fileName: { color: "#f7f6f3", fontSize: 16, lineHeight: 21, fontWeight: "700" },
  meta: { color: "#adb6b7", fontSize: 12, lineHeight: 17 },
  canvas: { flex: 1, overflow: "hidden" },
  imagePosition: { position: "absolute" },
  imageScale: { flex: 1 },
  image: { position: "absolute", inset: 0 },
  annotation: { position: "absolute", inset: 0 },
  loading: { position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" },
  error: { color: "#ff9c87", paddingHorizontal: 16, paddingVertical: 8, fontSize: 14, lineHeight: 20 },
  toolbar: { minHeight: 64, paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
  toolButton: { minHeight: 44, borderWidth: 1, borderColor: "#566064", borderRadius: 22,
    paddingHorizontal: 14, alignItems: "center", justifyContent: "center", backgroundColor: "#171b1e" },
  toolSelected: { borderColor: "#ff9800", backgroundColor: "#3c2b14" },
  toolEmphasized: { borderColor: "#ff9800", backgroundColor: "#ff9800" },
  toolText: { color: "#f7f6f3", fontSize: 14, lineHeight: 18, fontWeight: "700" },
  toolEmphasizedText: { color: "#2b2316" },
  disabled: { opacity: 0.45 },
  hint: { color: "#adb6b7", paddingHorizontal: 16, paddingBottom: 8, textAlign: "center", fontSize: 12, lineHeight: 17 }
});

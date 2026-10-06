import { useEffect, useRef, useState, type RefObject } from "react";
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { Image, type ImageLoadEventData } from "expo-image";
import type { MobileClient } from "./mobile-client";
import type { MobileImageGalleryPageSummary } from "./mobile-image-gallery";
import type { MobileTimelineImagePreview } from "./mobile-timeline-images";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

interface Props {
  readonly client: Pick<MobileClient, "prepareTimelineImagePreview" | "confirmTimelineImagePreview" | "releaseTimelineImagePreview">;
  readonly page: MobileImageGalleryPageSummary;
  readonly eventId: string;
  readonly ownerKey?: string;
  readonly eligible: boolean;
  readonly viewportPulse: number;
  readonly viewportRef: RefObject<View | null>;
  readonly maximumWidth: number;
  readonly openLabel: string;
  readonly disabled: boolean;
  readonly locale: MobileSupportedLocale;
  readonly colors: { readonly accent: string; readonly muted: string; readonly background: string };
  readonly onOpen: () => void;
}

export function MobileTimelineImage(props: Props) {
  const { client, page, eventId, ownerKey, eligible, viewportPulse, viewportRef, maximumWidth, openLabel, disabled, locale, colors, onOpen } = props;
  const viewRef = useRef<View>(null);
  const [layoutPulse, setLayoutPulse] = useState(0);
  const [visibility, setVisibility] = useState({ sourceKey: "", visible: false });
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [preview, setPreview] = useState<MobileTimelineImagePreview>();
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [attempt, setAttempt] = useState(0);
  const activeRef = useRef<{ controller: AbortController; preview?: MobileTimelineImagePreview } | undefined>(undefined);
  const sourceKey = JSON.stringify([ownerKey, eventId, page.pageId, page.sha256Hex, page.byteSize, page.mediaType, page.widthPixels, page.heightPixels]);
  const [stateSource, setStateSource] = useState(sourceKey);
  const visible = visibility.sourceKey === sourceKey && visibility.visible;
  const automaticRetryRef = useRef(false);
  useEffect(() => { automaticRetryRef.current = false; }, [sourceKey]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") activeRef.current?.controller.abort();
      setForeground(state === "active");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!eligible || !foreground || !ownerKey || !viewRef.current || !viewportRef.current) { setVisibility({ sourceKey, visible: false }); return; }
    let cancelled = false;
    const deadline = setTimeout(() => { cancelled = true; setVisibility({ sourceKey, visible: false }); }, 200);
    viewportRef.current.measureInWindow((vx, vy, vw, vh) => {
      if (cancelled) return;
      viewRef.current?.measureInWindow((x, y, width, height) => {
        if (cancelled) return;
        clearTimeout(deadline);
        const valid = [vx, vy, vw, vh, x, y, width, height].every(Number.isFinite) && vw > 0 && vh > 0 && width > 0 && height > 0;
        const intersects = valid && x < vx + vw && x + width > vx && y < vy + vh && y + height > vy;
        setVisibility((previous) => previous.sourceKey === sourceKey && previous.visible === intersects ? previous : { sourceKey, visible: intersects });
      });
    });
    return () => { cancelled = true; clearTimeout(deadline); };
  }, [eligible, foreground, ownerKey, sourceKey, viewportPulse, layoutPulse, viewportRef]);

  useEffect(() => {
    setPreview(undefined); setStateSource(sourceKey);
    if (!visible || !foreground || !eligible || !ownerKey) { setPhase("idle"); return; }
    const active: NonNullable<typeof activeRef.current> = { controller: new AbortController() };
    activeRef.current = active; setPhase("loading");
    void client.prepareTimelineImagePreview(eventId, page.pageId, active.controller.signal).then((image) => {
      if (active.controller.signal.aborted || activeRef.current !== active) { client.releaseTimelineImagePreview(image.leaseId); return; }
      active.preview = image; setPreview(image);
    }, () => { if (!active.controller.signal.aborted && activeRef.current === active) setPhase("error"); });
    return () => {
      active.controller.abort(); if (active.preview) client.releaseTimelineImagePreview(active.preview.leaseId);
      if (activeRef.current === active) activeRef.current = undefined;
    };
  }, [sourceKey, visible, foreground, eligible, ownerKey, attempt, client, eventId, page.pageId]);

  const current = stateSource === sourceKey ? preview : undefined;
  const currentPhase = stateSource === sourceKey ? phase : "idle";
  const width = current?.width ?? page.widthPixels; const height = current?.height ?? page.heightPixels;
  const limit = Math.max(44, Math.min(280, maximumWidth));
  const fit = width && height ? Math.min(limit / width, 180 / height, 1) : undefined;
  const imageFrame = { width: fit && width ? width * fit : limit, height: fit && height ? height * fit : 180 };
  const frame = { width: Math.max(44, imageFrame.width), height: Math.max(44, imageFrame.height) };
  const fail = (retryAutomatically = false) => {
    const active = activeRef.current;
    if (!active?.preview || active.controller.signal.aborted || active.preview !== current) return;
    client.releaseTimelineImagePreview(active.preview.leaseId, true); active.preview = undefined;
    setPreview(undefined); setPhase("error");
    if (retryAutomatically && !automaticRetryRef.current) { automaticRetryRef.current = true; setAttempt((value) => value + 1); }
  };
  useEffect(() => {
    if (!current || currentPhase !== "loading") return;
    const deadline = setTimeout(() => fail(), 12_000);
    return () => clearTimeout(deadline);
  }, [current?.leaseId, currentPhase]);
  return <View ref={viewRef} collapsable={false} onLayout={() => setLayoutPulse((value) => value + 1)} style={styles.wrap}>
    <Pressable accessibilityRole="imagebutton" accessibilityLabel={openLabel}
      accessibilityHint={mobileMessage(locale, "task.openImageHint")} accessibilityState={{ disabled, busy: currentPhase === "loading" }}
      disabled={disabled} onPress={onOpen} style={[styles.frame, frame, { backgroundColor: colors.background }]}>
      {current && <Image key={current.leaseId} source={{ uri: current.uri }} accessible={false} contentFit="fill" cachePolicy="none"
        autoplay={foreground && visible && eligible} style={[styles.image, imageFrame]}
        onLoad={(event: ImageLoadEventData) => {
          const active = activeRef.current;
          if (!active || active.controller.signal.aborted || active.preview !== current) return;
          try { client.confirmTimelineImagePreview(current.leaseId, event.source); setPhase("ready"); }
          catch { fail(); }
        }} onError={() => fail(true)} />}
      {currentPhase === "loading" && <View pointerEvents="none" style={styles.placeholder}>
        <ActivityIndicator color={colors.accent} /><Text style={[styles.caption, { color: colors.muted }]}>{mobileMessage(locale, "image.previewLoading")}</Text>
      </View>}
      {(currentPhase === "idle" || currentPhase === "error") && <View pointerEvents="none" style={styles.placeholder}>
        <Text style={[styles.caption, { color: colors.muted }]} numberOfLines={2}>{currentPhase === "error" ? mobileMessage(locale, "image.previewFailed") : page.title}</Text>
      </View>}
    </Pressable>
    {currentPhase === "error" && foreground && eligible && ownerKey && <Pressable accessibilityRole="button"
      accessibilityLabel={mobileMessage(locale, "image.previewRetry", { name: page.title })} onPress={() => setAttempt((value) => value + 1)} style={styles.retry}>
      <Text style={[styles.caption, { color: colors.accent }]}>{mobileMessage(locale, "common.retry")}</Text>
    </Pressable>}
  </View>;
}

const styles = StyleSheet.create({ wrap: { alignItems: "flex-start" }, frame: { minWidth: 44, minHeight: 44, borderRadius: 12, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  image: { borderRadius: 12, overflow: "hidden" },
  placeholder: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center", gap: 8, padding: 8 },
  retry: { minHeight: 44, minWidth: 44, justifyContent: "center", paddingHorizontal: 8 }, caption: { fontSize: 12, lineHeight: 18 } });

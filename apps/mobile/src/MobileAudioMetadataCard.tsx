import { memo, useEffect, useRef, useState } from "react";
import { AppState, Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileAudioMetadataDuration, mobileAudioMetadataSourceKey, type MobileAudioMetadataView } from "./mobile-audio-metadata";
import { mobileAudioMetadataMessage } from "./mobile-audio-metadata-messages";

export type MobileAudioArtworkState = { readonly state: "placeholder" | "loading" | "error" }
  | { readonly state: "ready"; readonly uri: string; readonly sourceKey: string };

export interface MobileAudioMetadataCardProps {
  readonly metadata: MobileAudioMetadataView;
  readonly ownerKey: string;
  readonly actualDuration?: number | null;
  readonly artwork: MobileAudioArtworkState;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly enabled: boolean;
  readonly onCopyDescription: (text: string, signal: AbortSignal) => Promise<void>;
  readonly onArtworkDecoded?: (sourceKey: string, width: number, height: number) => void;
  readonly onArtworkError?: (sourceKey: string) => void;
}

type CopyStatus = "pending" | "copied" | "failed";
interface CopyRequest { readonly scopeKey: string; readonly controller: AbortController }

/** Canonical information and its independently leased cover; the audio player remains a sibling. */
export const MobileAudioMetadataCard = memo(function MobileAudioMetadataCard({
  metadata, ownerKey, actualDuration, artwork, colors, locale, enabled, onCopyDescription, onArtworkDecoded, onArtworkError
}: MobileAudioMetadataCardProps) {
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const foregroundRef = useRef(foreground);
  const mounted = useRef(true);
  const copyRequest = useRef<CopyRequest | undefined>(undefined);
  const [copyStatus, setCopyStatus] = useState<{ readonly scopeKey: string; readonly status: CopyStatus }>();
  const [failedArtwork, setFailedArtwork] = useState<string>();
  const metadataKey = mobileAudioMetadataSourceKey(metadata);
  const scopeKey = JSON.stringify([ownerKey, metadataKey]);
  const interactive = enabled && foreground;
  const currentScope = useRef({ scopeKey, interactive }); currentScope.current = { scopeKey, interactive };
  const soundEffect = metadata.kind === "sound_effect";
  const description = soundEffect ? "" : metadata.description;
  const copyAvailable = description.trim().length > 0;
  const status = copyStatus?.scopeKey === scopeKey ? copyStatus.status : undefined;
  const title = metadata.title.trim() ? metadata.title : mobileAudioMetadataMessage(locale, soundEffect ? "untitledEffect" : "untitled");
  const duration = mobileAudioMetadataDuration(metadata, actualDuration);
  const artworkKey = interactive && !soundEffect && artwork.state === "ready"
    ? JSON.stringify([ownerKey, metadataKey, artwork.sourceKey, artwork.uri]) : undefined;
  const showArtwork = artworkKey !== undefined && failedArtwork !== artworkKey;
  const currentArtwork = useRef<string | undefined>(undefined); currentArtwork.current = showArtwork ? artworkKey : undefined;

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      const active = state === "active";
      foregroundRef.current = active;
      if (!active) {
        currentArtwork.current = undefined;
        copyRequest.current?.controller.abort(); copyRequest.current = undefined;
        setCopyStatus(undefined);
      }
      setForeground(active);
    });
    return () => {
      mounted.current = false; currentArtwork.current = undefined;
      copyRequest.current?.controller.abort(); copyRequest.current = undefined;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (copyRequest.current && (copyRequest.current.scopeKey !== scopeKey || !interactive)) {
      copyRequest.current.controller.abort(); copyRequest.current = undefined;
      setCopyStatus(undefined);
    }
  }, [interactive, scopeKey]);

  const copyDescription = async (): Promise<void> => {
    if (!mounted.current || !foregroundRef.current || !interactive || !currentScope.current.interactive
      || currentScope.current.scopeKey !== scopeKey || !copyAvailable || copyRequest.current) return;
    const request: CopyRequest = { scopeKey, controller: new AbortController() };
    copyRequest.current = request; setCopyStatus({ scopeKey, status: "pending" });
    const current = (): boolean => mounted.current && foregroundRef.current && currentScope.current.interactive
      && currentScope.current.scopeKey === request.scopeKey && copyRequest.current === request && !request.controller.signal.aborted;
    try {
      await onCopyDescription(description, request.controller.signal);
      if (current()) setCopyStatus({ scopeKey, status: "copied" });
    } catch {
      if (current()) setCopyStatus({ scopeKey, status: "failed" });
    } finally {
      if (copyRequest.current === request) copyRequest.current = undefined;
    }
  };

  const artworkFailed = !soundEffect && (artwork.state === "error" || artworkKey !== undefined && failedArtwork === artworkKey);
  const artworkLoading = interactive && !soundEffect && artwork.state === "loading";
  const artworkLabel = mobileAudioMetadataMessage(locale, soundEffect ? "sound_effect"
    : artworkFailed ? "artworkFailed" : artworkLoading ? "artworkLoading" : "artworkMissing");
  const ownsArtwork = (): boolean => mounted.current && foregroundRef.current && artworkKey !== undefined && currentArtwork.current === artworkKey;
  const failArtwork = (): void => {
    if (!ownsArtwork() || artwork.state !== "ready") return;
    currentArtwork.current = undefined; setFailedArtwork(artworkKey); onArtworkError?.(artwork.sourceKey);
  };

  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={styles.heading}>
      {showArtwork && artwork.state === "ready" ? <Image key={artworkKey} source={{ uri: artwork.uri }} resizeMode="cover"
        accessibilityLabel={metadata.artwork?.alt || mobileAudioMetadataMessage(locale, "artwork")}
        style={[styles.artwork, { backgroundColor: colors.background, borderColor: colors.border }]}
        onLoad={(event) => {
          if (!ownsArtwork()) return;
          const { width, height } = event.nativeEvent.source;
          if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) { failArtwork(); return; }
          onArtworkDecoded?.(artwork.sourceKey, width, height);
        }} onError={failArtwork} />
        : <View accessible accessibilityRole="image" accessibilityLabel={artworkLabel} accessibilityState={{ busy: artworkLoading }}
          style={[styles.artwork, styles.placeholder, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.glyph, { color: colors.muted }]}>{soundEffect ? "≋" : "♪"}</Text>
        </View>}
      <View style={styles.fill}>
        <Text selectable style={[styles.title, { color: colors.ink }]}>{title}</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{mobileAudioMetadataMessage(locale, metadata.kind)}</Text>
        {duration !== undefined && <Text style={[styles.caption, { color: colors.muted }]}>
          {mobileAudioMetadataMessage(locale, "duration", { duration: `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")}` })}
        </Text>}
      </View>
    </View>
    {copyAvailable && <>
      <Text selectable style={[styles.description, { color: colors.muted }]}>{description}</Text>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel={mobileAudioMetadataMessage(locale, "copyDescription")}
          accessibilityState={{ busy: status === "pending", disabled: !interactive || status === "pending" }}
          disabled={!interactive || status === "pending"} onPress={() => { void copyDescription(); }}
          style={[styles.copy, { borderColor: colors.border }]}>
          <Text style={[styles.copyLabel, { color: colors.ink }]}>{mobileAudioMetadataMessage(locale, "copyDescription")}</Text>
        </Pressable>
      </View>
    </>}
    {status && copyAvailable && <Text accessibilityRole={status === "failed" ? "alert" : "text"} accessibilityLiveRegion="polite"
      style={[styles.feedback, { color: status === "failed" ? colors.negative : colors.muted }]}>
      {mobileAudioMetadataMessage(locale, status === "pending" ? "copying" : status === "copied" ? "copied" : "copyFailed")}
    </Text>}
  </View>;
});

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, minWidth: 0, padding: 12, gap: 10 },
  heading: { flexDirection: "row", alignItems: "flex-start", gap: 12, minWidth: 0 },
  artwork: { width: 72, height: 72, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  placeholder: { alignItems: "center", justifyContent: "center" }, glyph: { fontSize: 30 },
  fill: { flex: 1, minWidth: 0, gap: 3 }, title: { fontSize: 15, lineHeight: 22, fontWeight: "600" },
  caption: { fontSize: 12, lineHeight: 18 }, description: { fontSize: 13, lineHeight: 21 },
  actions: { alignItems: "flex-end" }, copy: { minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  copyLabel: { fontSize: 13, lineHeight: 20 }, feedback: { fontSize: 12, lineHeight: 18 }
});

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Platform, StyleSheet, Text, View } from "react-native";
import { Image, type ImageLoadEventData } from "expo-image";
import { mobileFilesThumbnailKind, type MobileFilesThumbnailAccess, type MobileFilesThumbnailPreview } from "./mobile-files-thumbnails";
import type { MobileFilesComposerSource } from "./workspace-files";

export function MobileFileThumbnail({ client, source, ownerKey, scopeKey, enabled, grid, colors, children }: {
  readonly client?: MobileFilesThumbnailAccess; readonly source: MobileFilesComposerSource; readonly ownerKey?: string; readonly scopeKey: string;
  readonly enabled: boolean; readonly grid: boolean; readonly colors: { readonly surface: string; readonly border: string; readonly muted: string };
  readonly children: ReactNode;
}) {
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [prepared, setPrepared] = useState<{ readonly source: object; readonly scopeKey: string; readonly preview: MobileFilesThumbnailPreview }>();
  const [loaded, setLoaded] = useState<string>();
  const activeRef = useRef<{ readonly controller: AbortController; preview?: MobileFilesThumbnailPreview } | undefined>(undefined);
  const reference = source.kind === "workspace-entry" ? source.entry : source.kind === "artifact" ? source.artifact : source.result;
  const kind = mobileFilesThumbnailKind(source);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") activeRef.current?.controller.abort();
      setForeground(state === "active");
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    setPrepared(undefined); setLoaded(undefined);
    if (!client || !ownerKey || !kind || !enabled || !foreground) return;
    const active = { controller: new AbortController(), preview: undefined as MobileFilesThumbnailPreview | undefined }; activeRef.current = active;
    const timer = setTimeout(() => {
      void client.prepareFilesThumbnail(ownerKey, source, active.controller.signal).then((preview) => {
        if (active.controller.signal.aborted || activeRef.current !== active) { client.releaseFilesThumbnail(preview.leaseId); return; }
        active.preview = preview; setPrepared({ source: reference, scopeKey, preview });
      }, () => { /* Decorative reads leave the type placeholder available. */ });
    }, 200);
    return () => {
      clearTimeout(timer); active.controller.abort(); if (active.preview) client.releaseFilesThumbnail(active.preview.leaseId);
      if (activeRef.current === active) activeRef.current = undefined;
    };
  }, [client, ownerKey, reference, scopeKey, kind, enabled, foreground]);
  const current = enabled && foreground && prepared?.source === reference && prepared.scopeKey === scopeKey ? prepared.preview : undefined;
  const content = current?.content;
  const fail = () => {
    const active = activeRef.current; if (!client || !active || active.controller.signal.aborted || active.preview !== current || !current) return;
    client.releaseFilesThumbnail(current.leaseId, true); active.preview = undefined; setPrepared(undefined); setLoaded(undefined);
  };
  useEffect(() => {
    if (!current || content?.kind !== "image" || loaded === current.leaseId) return;
    const timer = setTimeout(fail, 12_000); return () => clearTimeout(timer);
  }, [current?.leaseId, content?.kind, loaded]);
  return <View accessible={false} importantForAccessibility="no-hide-descendants" pointerEvents="none" style={styles.fill}>
    {content?.kind === "image" && client && <Image key={current!.leaseId} source={{ uri: content.uri }} accessible={false} contentFit="cover" cachePolicy="none" autoplay={false}
      style={[styles.image, { borderColor: colors.border }, !grid && styles.smallImage, loaded !== current!.leaseId && styles.hidden]}
      onLoad={(event: ImageLoadEventData) => {
        const active = activeRef.current; if (!active || active.controller.signal.aborted || active.preview !== current) return;
        try { client.confirmFilesThumbnail(current!.leaseId, event.source); setLoaded(current!.leaseId); } catch { fail(); }
      }} onError={fail} />}
    {content?.kind === "text" ? <View style={[styles.paper, { backgroundColor: colors.surface, borderColor: colors.border }, !grid && styles.smallPaper]}>
      <Text allowFontScaling={false} numberOfLines={14} style={[styles.snippet, { color: colors.muted }, !grid && styles.smallSnippet]}>{content.text}</Text>
    </View> : (content?.kind !== "image" || loaded !== current?.leaseId) && (kind ? <View style={[styles.paper, { backgroundColor: colors.surface, borderColor: colors.border }, !grid && styles.smallPaper]}>
      {[88, 70, 82, 92, 68, 79, 58, 88].map((width, index) => <View key={index} style={[styles.line, { backgroundColor: colors.border, width: `${width}%` }, !grid && styles.smallLine]} />)}
    </View> : children)}
  </View>;
}
const styles = StyleSheet.create({ fill: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center", position: "relative" },
  image: { position: "absolute", width: "92%", height: 104, borderRadius: 2, borderWidth: 1 }, smallImage: { width: "100%", height: "100%" },
  hidden: { opacity: 0 }, paper: { position: "absolute", width: 80, maxWidth: "90%", height: 104, maxHeight: "95%", borderRadius: 2, borderWidth: 1,
    paddingHorizontal: 8, paddingVertical: 9, overflow: "hidden", gap: 4 },
  smallPaper: { width: "90%", height: "90%", paddingHorizontal: 3, paddingVertical: 3, gap: 3 }, snippet: { fontSize: 4, lineHeight: 6, fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) },
  smallSnippet: { fontSize: 3.5, lineHeight: 4 }, line: { height: 2, borderRadius: 1 }, smallLine: { height: 1 } });

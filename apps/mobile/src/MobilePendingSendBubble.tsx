import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, Image, StyleSheet, Text, View } from "react-native";
import type { MobilePendingSendProgress } from "./mobile-pending-send";
import { mobilePendingSendText } from "./mobile-pending-send";
import type { MobileAttachmentFiles } from "./mobile-attachment-files";
import type { MobileComposerAttachment } from "./mobile-attachments";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export function MobilePendingSendBubble({ progress, colors, locale, files, profileId, children }: {
  readonly progress: MobilePendingSendProgress; readonly locale: MobileSupportedLocale;
  readonly colors: { readonly ink: string; readonly muted: string; readonly accent: string; readonly border: string; readonly brandBackground: string; readonly negative: string };
  readonly files: Pick<MobileAttachmentFiles, "readOwnedBytes">; readonly profileId: string; readonly children?: ReactNode;
}) {
  const [visible, setVisible] = useState(Date.now() >= progress.sentAt + 300);
  useEffect(() => {
    const remaining = progress.sentAt + 300 - Date.now(); if (remaining <= 0) { setVisible(true); return; }
    setVisible(false); const timer = setTimeout(() => setVisible(true), remaining); return () => clearTimeout(timer);
  }, [progress.sentAt]);
  const failed = progress.phase === "failed", unknown = progress.phase === "unknown";
  const status = mobileMessage(locale, progress.phase === "waiting" ? "task.outboxQueued" : unknown ? "task.operationUnknown"
    : failed ? "task.outboxFailed" : progress.phase === "uploading" ? "task.pendingUploading" : progress.phase === "preparing" ? "task.pendingPreparing"
      : progress.phase === "queued" ? "task.queued" : "common.sending");
  const text = mobilePendingSendText(progress.input);
  return <View style={styles.root} testID="task.pending-send">
    <View style={styles.line}>
      <View style={styles.indicator}>{(visible || failed || unknown) && (failed || unknown ? <Text style={{ color: failed ? colors.negative : colors.muted }}>!</Text>
        : <ActivityIndicator size="small" color={colors.muted} />)}</View>
      <View style={[styles.bubble, { backgroundColor: colors.brandBackground, borderColor: colors.border }]}>
        {progress.input.replyQuote && <Text numberOfLines={3} style={{ color: colors.muted }}>{progress.input.replyQuote.excerpt}</Text>}
        {progress.input.todoQuote && <Text numberOfLines={3} style={{ color: colors.muted }}>{progress.input.todoQuote.title}</Text>}
        {!!text && <Text selectable style={[styles.body, { color: colors.ink }]}>{text}</Text>}
        {progress.input.attachments.map(attachment => <View key={attachment.attachmentId} style={styles.attachment}>
          {attachment.kind === "image" && <PendingImage files={files} profileId={profileId} attachment={attachment} />}
          <Text numberOfLines={2} style={{ color: failed && progress.attachmentId === attachment.attachmentId ? colors.negative : colors.ink }}>{attachment.fileName}</Text>
          <Text style={[styles.note, { color: failed && progress.attachmentId === attachment.attachmentId ? colors.negative : colors.muted }]}>
            {mobileMessage(locale, attachment.state === "uploaded" ? "attachments.uploaded"
              : failed && progress.attachmentId === attachment.attachmentId ? "task.pendingAttachmentFailed"
              : progress.phase === "uploading" && progress.attachmentId === attachment.attachmentId ? "task.pendingUploading" : "attachments.ready")}
          </Text>
        </View>)}
      </View>
    </View>
    {(visible || failed || unknown) && <Text accessibilityLiveRegion="polite" style={[styles.status, { color: failed ? colors.negative : colors.muted }]}>
      {status}{progress.phase === "uploading" ? ` ${progress.input.attachments.filter(item => item.state === "uploaded").length}/${progress.input.attachments.length}` : ""}
      {failed && progress.error ? ` · ${progress.error}` : ""}
    </Text>}
    {children}
  </View>;
}

function PendingImage({ files, profileId, attachment }: { readonly files: Pick<MobileAttachmentFiles, "readOwnedBytes">;
  readonly profileId: string; readonly attachment: MobileComposerAttachment }) {
  const [source, setSource] = useState<{ key: string; uri: string }>();
  const key = JSON.stringify([profileId, attachment.attachmentId, attachment.sha256Hex, attachment.byteSize]);
  useEffect(() => {
    if (attachment.kind !== "image" || AppState.currentState !== "active") return;
    let retired = false;
    const listener = AppState.addEventListener("change", state => { if (state !== "active") { retired = true; setSource(undefined); } });
    void files.readOwnedBytes(profileId, attachment.attachmentId, attachment.byteSize, attachment.sha256Hex).then(value => {
      if (!retired) setSource({ key, uri: value.uri });
    }).catch(() => undefined);
    return () => { retired = true; listener.remove(); };
  }, [attachment.attachmentId, attachment.byteSize, attachment.kind, attachment.sha256Hex, files, key, profileId]);
  return source?.key === key ? <Image source={{ uri: source.uri }} accessibilityLabel={attachment.fileName} style={styles.image} resizeMode="contain" /> : null;
}
const styles = StyleSheet.create({ root: { alignSelf: "flex-end", maxWidth: "100%", gap: 4 }, line: { flexDirection: "row", alignItems: "center", gap: 8 },
  indicator: { width: 20, alignItems: "center" }, bubble: { padding: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, maxWidth: "90%", gap: 8 },
  body: { fontSize: 16, lineHeight: 23 }, attachment: { gap: 3 }, image: { width: 180, height: 140 }, note: { fontSize: 12, lineHeight: 17 },
  status: { paddingLeft: 28, paddingHorizontal: 4, fontSize: 12, lineHeight: 18 } });

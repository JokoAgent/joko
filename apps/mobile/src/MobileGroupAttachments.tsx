import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image as ExpoImage, type ImageProps, type ImageLoadEventData } from "expo-image";
import { PartnerGroupAttachmentCategory, partnerGroupMessages, type PartnerGroupAttachment, type PartnerGroupMessage, type PartnerGroupSummary } from "@joko/contracts";
import type { MobileGroupAttachmentTransport } from "./mobile-partner-groups";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileComposerImageEditorSession } from "./mobile-composer-image-editor";
import type { MobileImageGalleryDescriptor, MobileImageGalleryPageSession } from "./mobile-image-gallery";
import type { MobileFilesThumbnailPreview } from "./mobile-files-thumbnails";
import { MobileImageLightbox } from "./MobileImageLightbox";
import { mobileImageOutput } from "./mobile-image-output";
import { mobileMessage } from "./mobile-messages";
import { MobilePdfViewer } from "./MobilePdfViewer";
import { MobileMediaPlayer } from "./MobileMediaPlayer";
import { MobileModelViewer } from "./MobileModelViewer";
import { MobileFileTextPreview } from "./MobileFileTextPreview";
import type { MobileGroupFilePreview } from "./mobile-partner-group-media";

const PreviewImage = ExpoImage as unknown as ComponentType<ImageProps>;
export function MobileGroupAttachments({ group, message, transport, colors, locale }: { group: PartnerGroupSummary; message: PartnerGroupMessage; transport?: MobileGroupAttachmentTransport; colors: MobilePartnersColors; locale: MobileSupportedLocale }) {
  const m = partnerGroupMessages(locale), images = useMemo(() => message.attachments.filter(item => item.category === PartnerGroupAttachmentCategory.IMAGE && item.blob), [message.attachments]);
  const [index, setIndex] = useState<number>(), [retry, setRetry] = useState(0), [error, setError] = useState<string>();
  const [file, setFile] = useState<{ id: string; blobId: string; sha256Hex: string; owner: string }>();
  const [loaded, setLoaded] = useState<{ index: number; session: MobileComposerImageEditorSession; transport: MobileGroupAttachmentTransport }>();
  useEffect(() => { setLoaded(undefined); setError(undefined); const attachment = index === undefined ? undefined : images[index];
    if (!attachment || !transport) return; const controller = new AbortController(); let session: MobileComposerImageEditorSession | undefined;
    void transport.prepareMediaImage(group, message, attachment, controller.signal).then(value => {
      session = value; if (controller.signal.aborted) transport.closeMediaImage(value.leaseId); else setLoaded({ index: index!, session: value, transport });
    }).catch(failure => { if (!controller.signal.aborted) setError(String(failure)); });
    return () => { controller.abort(); if (session) transport.closeMediaImage(session.leaseId); };
  }, [index, retry, transport?.ownerKey, message.id]);
  const selected = index === undefined ? undefined : images[index], descriptor: MobileImageGalleryDescriptor = { leaseId: `${transport?.ownerKey}:${message.id}`, sourceKind: "timeline", sourceLabel: group.name,
    initialIndex: index ?? 0, pages: images.map(item => ({ pageId: item.id, title: item.name, mediaType: item.blob!.mediaType as MobileImageGalleryDescriptor["pages"][number]["mediaType"], byteSize: Number(item.blob!.byteSize), sha256Hex: item.blob!.sha256Hex })) };
  const current = loaded?.index === index ? loaded : undefined;
  const session: MobileImageGalleryPageSession | undefined = current && selected ? { ...current.session, galleryLeaseId: descriptor.leaseId, pageId: selected.id, pageIndex: index!, pageCount: images.length,
    sourceKind: "timeline", sourceLabel: group.name, expectedWidthPixels: current.session.expectedWidthPixels!, expectedHeightPixels: current.session.expectedHeightPixels!, expectedAnimated: current.session.animated === true, addable: false } : undefined;
  const fail = () => { if (current) current.transport.closeMediaImage(current.session.leaseId); setLoaded(undefined); setError(mobileMessage(locale, "image.decoderDimensions")); };
  const document = transport && file?.owner === transport.ownerKey
    ? message.attachments.find(item => item.id === file.id && item.blob !== undefined
      && item.blob.blobId === file.blobId && item.blob.sha256Hex === file.sha256Hex) : undefined;
  useEffect(() => { if (!document) setFile(undefined); }, [document === undefined]);
  return <View style={styles.attachments}>{message.attachments.map(attachment => attachment.category === PartnerGroupAttachmentCategory.IMAGE && transport && attachment.blob
    ? <GroupThumbnail key={attachment.id} group={group} message={message} attachment={attachment} transport={transport} colors={colors} locale={locale} onOpen={() => setIndex(images.findIndex(item => item.id === attachment.id))} />
    : <Pressable key={attachment.id} accessibilityRole="button" accessibilityLabel={attachment.name}
      disabled={!transport || !attachment.blob} accessibilityState={{ disabled: !transport || !attachment.blob }}
      onPress={() => { if (transport && attachment.blob) setFile({ id: attachment.id, blobId: attachment.blob.blobId,
        sha256Hex: attachment.blob.sha256Hex, owner: transport.ownerKey }); }}
      style={[styles.file, { borderColor: colors.border }]}><Text style={{ color: colors.ink }}>{attachment.name}</Text></Pressable>)}
    {document && transport && <GroupFilePreview key={JSON.stringify([transport.ownerKey, group.id, message.id, document.id, document.blob?.sha256Hex])}
      group={group} message={message} attachment={document} transport={transport} colors={colors} locale={locale} close={() => setFile(undefined)} />}
    {index !== undefined && <MobileImageLightbox session={session} locale={locale} onClose={() => setIndex(undefined)} onSave={async () => { throw new Error(m.unavailable); }}
      gallery={{ descriptor, pageIndex: index, pageKey: `${descriptor.leaseId}:${selected?.id}:${retry}`, busy: !current && !error, error, onRetry: () => setRetry(value => value + 1),
        onNativeFailed: fail, onPreviewFailed: fail, onNavigate: next => { if (next >= 0 && next < images.length) setIndex(next); },
        onDecoded: decoded => { if (!current) throw new Error(m.unavailable); current.transport.confirmMediaImage(current.session.leaseId, decoded); },
        onAddOriginal: async () => { throw new Error(m.unavailable); }, onShareOriginal: async (signal, onDispatch) => {
          if (!current) throw new Error(m.unavailable); await current.transport.shareMediaOriginal(current.session.leaseId, signal, onDispatch); } }}
      onOutputAction={async (action, decoded, rendered, signal) => { if (!current) throw new Error(m.unavailable);
        const output = await current.transport.prepareMediaOutput(current.session.leaseId, decoded, signal); await mobileImageOutput.perform(action, output.source, rendered, signal, output.assertCurrent);
        return mobileMessage(locale, action === "copy" ? "image.copied" : action === "save" ? "image.saved" : "image.shared"); }} />}
  </View>;
}

function GroupFilePreview({ group, message, attachment, transport, colors, locale, close }: {
  group: PartnerGroupSummary; message: PartnerGroupMessage; attachment: PartnerGroupAttachment;
  transport: MobileGroupAttachmentTransport; colors: MobilePartnersColors; locale: MobileSupportedLocale; close(): void;
}) {
  const [preview, setPreview] = useState<MobileGroupFilePreview>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [shareFailed, setShareFailed] = useState(false);
  const shareFlight = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    let owned: MobileGroupFilePreview | undefined;
    setFailed(false);
    setPreview(undefined);
    void transport.prepareMediaFile(group, message, attachment, controller.signal).then(value => {
      if (controller.signal.aborted) return transport.releaseMediaFile(value);
      owned = value;
      setPreview(value);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => {
      controller.abort();
      if (owned) void transport.releaseMediaFile(owned).catch(() => undefined);
    };
  }, [transport, group.id, message.id, attachment.id, attachment.blob?.blobId, retry]);
  useEffect(() => () => shareFlight.current?.abort(), []);
  const share = () => {
    if (shareFlight.current) return;
    const controller = new AbortController();
    shareFlight.current = controller;
    setSharing(true);
    setShareFailed(false);
    void transport.shareMediaFile(group, message, attachment, controller.signal)
      .catch(() => { if (!controller.signal.aborted) setShareFailed(true); })
      .finally(() => {
        shareFlight.current = undefined;
        if (!controller.signal.aborted) setSharing(false);
      });
  };
  const button = (label: string, action: () => void, disabled = false) =>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={action} style={styles.fileControl}>
      <Text style={{ color: disabled ? colors.muted : colors.accent }}>{label}</Text>
    </Pressable>;
  return <Modal visible presentationStyle="fullScreen" onRequestClose={close}>
    <SafeAreaView accessibilityViewIsModal style={[styles.fileViewer, { backgroundColor: colors.background }]}>
      <View style={[styles.fileToolbar, { borderColor: colors.border }]}>
        {button(mobileMessage(locale, "common.close"), close)}
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.fileTitle, { color: colors.ink }]}>{attachment.name}</Text>
        {button(mobileMessage(locale, sharing ? "image.sharing" : "common.share"), share, sharing)}
      </View>
      {shareFailed && <Text accessibilityRole="alert" style={[styles.fileNotice, { color: colors.negative }]}>{partnerGroupMessages(locale).unavailable}</Text>}
      {failed ? <View style={styles.fileNotice}>
        <Text accessibilityRole="alert" style={{ color: colors.negative }}>{partnerGroupMessages(locale).unavailable}</Text>
        {button(mobileMessage(locale, "common.retry"), () => setRetry(value => value + 1))}
      </View> : preview?.kind === "text" ? <MobileFileTextPreview preview={preview} locale={locale} colors={colors} />
        : preview?.kind === "pdf" ? <MobilePdfViewer style={styles.fileViewer} {...colors} title={attachment.name} locale={locale}
          fileName={preview.pdf.fileName} byteSize={preview.pdf.localByteSize} instanceId={preview.pdf.leaseId}
          uri={preview.pdf.uri} sha256Hex={preview.pdf.sha256Hex} />
        : preview?.kind === "media" ? <MobileMediaPlayer key={preview.media.leaseId} style={styles.fileViewer}
          background={colors.background} border={colors.border} ink={colors.ink} surface={colors.surface}
          instanceId={preview.media.leaseId} kind={preview.media.mediaKind} locale={locale} mediaType={preview.media.mediaType}
          title={attachment.name} uri={preview.media.uri} />
        : preview?.kind === "model" ? <MobileModelViewer key={preview.model.leaseId} style={styles.fileViewer}
          background={colors.background} border={colors.border} ink={colors.ink} surface={colors.surface}
          accent={colors.accent} muted={colors.muted} lease={preview.model} locale={locale} title={attachment.name} />
        : preview?.kind === "unsupported" ? <Text style={[styles.fileNotice, { color: colors.muted }]}>{mobileMessage(locale, "task.fileFallback")}</Text>
        : <ActivityIndicator accessibilityLabel={mobileMessage(locale, "preview.loadingExact")} color={colors.accent} style={styles.fileNotice} />}
    </SafeAreaView>
  </Modal>;
}
function GroupThumbnail({ group, message, attachment, transport, colors, locale, onOpen }: { group: PartnerGroupSummary; message: PartnerGroupMessage; attachment: PartnerGroupAttachment; transport: MobileGroupAttachmentTransport; colors: MobilePartnersColors; locale: MobileSupportedLocale; onOpen(): void }) {
  const [preview, setPreview] = useState<MobileFilesThumbnailPreview>(), [failed, setFailed] = useState(false);
  useEffect(() => { const controller = new AbortController(); let lease: MobileFilesThumbnailPreview | undefined; setFailed(false); setPreview(undefined);
    void transport.prepareMediaThumbnail(group, message, attachment, controller.signal).then(value => { lease = value; if (controller.signal.aborted) transport.releaseMediaThumbnail(value.leaseId); else setPreview(value); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (lease) transport.releaseMediaThumbnail(lease.leaseId); };
  }, [transport.ownerKey, attachment.id, attachment.blob?.sha256Hex]);
  const content = !failed && preview?.content?.kind === "image" ? preview.content : undefined;
  return <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "task.openImage", { name: attachment.name, index: message.attachments.indexOf(attachment) + 1, count: message.attachments.length })} onPress={onOpen} style={[styles.image, { borderColor: colors.border }]}>
    {content && <PreviewImage source={{ uri: content.uri }} contentFit="contain" cachePolicy="none" style={{ width: 180, height: Math.max(48, Math.min(220, 180 * content.height / content.width)) }}
      onLoad={(event: ImageLoadEventData) => { if (!preview) return; try { transport.confirmMediaThumbnail(preview.leaseId, event.source); } catch { setFailed(true); } }}
      onError={() => { if (preview) transport.releaseMediaThumbnail(preview.leaseId, true); setFailed(true); }} />}
    <Text style={{ color: colors.ink }}>{attachment.name}</Text>{failed && <Text style={{ color: colors.muted }}>{mobileMessage(locale, "image.previewFailed")}</Text>}
  </Pressable>;
}
const styles = StyleSheet.create({
  attachments: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  image: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 6, gap: 4 },
  file: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 10, minHeight: 44 },
  fileViewer: { flex: 1 },
  fileToolbar: { flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8 },
  fileTitle: { flex: 1, textAlign: "center", fontWeight: "600" },
  fileControl: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, justifyContent: "center", alignItems: "center" },
  fileNotice: { margin: 16 }
});

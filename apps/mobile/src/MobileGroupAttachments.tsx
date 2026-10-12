import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
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

const PreviewImage = ExpoImage as unknown as ComponentType<ImageProps>;
export function MobileGroupAttachments({ group, message, transport, colors, locale }: { group: PartnerGroupSummary; message: PartnerGroupMessage; transport?: MobileGroupAttachmentTransport; colors: MobilePartnersColors; locale: MobileSupportedLocale }) {
  const m = partnerGroupMessages(locale), images = useMemo(() => message.attachments.filter(item => item.category === PartnerGroupAttachmentCategory.IMAGE && item.blob), [message.attachments]);
  const [index, setIndex] = useState<number>(), [retry, setRetry] = useState(0), [error, setError] = useState<string>();
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
  return <View style={styles.attachments}>{message.attachments.map(attachment => attachment.category === PartnerGroupAttachmentCategory.IMAGE && transport
    ? <GroupThumbnail key={attachment.id} group={group} message={message} attachment={attachment} transport={transport} colors={colors} locale={locale} onOpen={() => setIndex(images.findIndex(item => item.id === attachment.id))} />
    : <Pressable key={attachment.id} accessibilityRole="button" accessibilityLabel={attachment.name} onPress={() => Alert.alert(attachment.name, m.readOnlyFiles)} style={[styles.file, { borderColor: colors.border }]}><Text style={{ color: colors.ink }}>{attachment.name}</Text></Pressable>)}
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
const styles = StyleSheet.create({ attachments: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, image: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 6, gap: 4 }, file: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 10, minHeight: 44 } });

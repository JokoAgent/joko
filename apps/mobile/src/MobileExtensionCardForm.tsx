import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { WebView } from "react-native-webview";
import { applyMailInlineEdits, mailInlineBindingScript, mailInlineDocument, mailInlineRefreshScript, mailPreviewImages,
  visibleMailAttachments, canInsertMailImage, insertMailImage, removeMailAttachment, extensionCardFieldMaxValue, type ExtensionCardFormField } from "@joko/contracts";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import { mobileExtensionCardMessages } from "./mobile-extension-card-messages";
import { MobileExtensionCardRecipients } from "./MobileExtensionCardRecipients";
type Colors = MobileInteractionSheetColors & { readonly dark: boolean };
export function MobileExtensionCardFields({ fields, values, colors, copy, disabled, foreground, onChange, images = [], onAttachment }: {
  fields: ExtensionCardFormField[]; values: Record<string, string>; colors: Colors; copy: ReturnType<typeof mobileExtensionCardMessages>;
  disabled: boolean; foreground: boolean; onChange(values: Record<string, string>): void; images?: { cid: string; url: string }[];
  onAttachment?: (inline: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const recipients = fields.filter(field => field.kind === "recipients");
  return <View style={styles.fields}>
    {recipients.length > 0 && <MobileExtensionCardRecipients fields={recipients} values={values} colors={colors} disabled={disabled} expandLabel={copy.fields} collapseLabel={copy.collapse}
      onChange={(name, value) => onChange({ ...values, [name]: value })} />}
    {fields.map(field => {
      if (field.kind === "hidden" || field.kind === "recipients") return null;
      if (field.kind === "mail-html") return foreground ? <MobileExtensionMailPreview key={field.name} html={values[field.name] ?? field.value} images={[...images, ...mailPreviewImages(values)]} disabled={disabled}
        onChange={(html, text) => { const plain = field.name === "quoteHtml" ? "quote" : "body"; onChange({ ...values, [field.name]: html, ...(plain in values ? { [plain]: text } : {}) }); }} /> : null;
      if (field.kind === "mail-attachments") return <View style={styles.attachments} key={field.name}>{visibleMailAttachments(values, field.name).map(file => <View key={file.key} style={[styles.attachment, { borderColor: colors.border }]}>
        <Text numberOfLines={2} style={[styles.attachmentName, { color: colors.ink }]}>{file.filename}</Text>
        {!disabled && canInsertMailImage(values, file) && <Pressable style={styles.control} onPress={() => onChange(insertMailImage(values, field.name, file.key))}><Text style={{ color: colors.accent }}>{copy.insert}</Text></Pressable>}
        {!disabled && <Pressable accessibilityRole="button" accessibilityLabel={`${copy.remove} ${file.filename}`} style={styles.control} onPress={() => onChange(removeMailAttachment(values, field.name, file.key))}><Text style={{ color: colors.muted }}>×</Text></Pressable>}
      </View>)}{!disabled && onAttachment && <>
        <Pressable accessibilityRole="button" style={styles.control} onPress={() => onAttachment(false)}><Text style={{ color: colors.accent }}>{copy.attachFile}</Text></Pressable>
        {typeof values.bodyHtml === "string" && <Pressable accessibilityRole="button" style={styles.control} onPress={() => onAttachment(true)}><Text style={{ color: colors.accent }}>{copy.insert}</Text></Pressable>}
      </>}</View>;
      return <View key={field.name} style={[field.multiline ? styles.multiline : styles.field, { borderColor: colors.border }]}>
        {field.collapsed ? <Pressable style={styles.control} onPress={() => setCollapsed(previous => ({ ...previous, [field.name]: !(previous[field.name] ?? true) }))}><Text style={[styles.label, { color: colors.muted }]}>{field.label}</Text></Pressable>
          : !field.multiline && <Text style={[styles.label, { color: colors.muted }]}>{field.label}</Text>}
        {(!field.collapsed || collapsed[field.name] === false) && <TextInput accessibilityLabel={field.label} editable={!disabled} value={values[field.name] ?? field.value}
          multiline={field.multiline} maxLength={extensionCardFieldMaxValue(field.name)} style={[styles.input, field.multiline && styles.bodyInput, { color: colors.ink }]}
          onChangeText={value => onChange({ ...values, [field.name]: value })} />}
      </View>;
    })}
  </View>;
}
let nextDocument = 0;
export function MobileExtensionMailPreview({ html, images, disabled, onChange }: { html: string; images: { cid: string; url: string }[]; disabled: boolean; onChange(html: string, text: string): void }) {
  const web = useRef<WebView>(null), settled = useRef(false);
  const [initialRevision] = useState(() => ++nextDocument);
  const model = useRef({ source: html, received: html, emitted: html, edits: {} as Record<string, string>, revision: initialRevision });
  if (model.current.received !== html) {
    if (html !== model.current.emitted) model.current = { source: html, received: html, emitted: html, edits: {}, revision: ++nextDocument };
    else model.current.received = html;
  }
  const revision = model.current.revision, source = useMemo(() => ({ baseUrl: "about:blank", html: mailInlineDocument(model.current.source, images) }), [revision]);
  const lastSource = useRef(source); if (lastSource.current !== source) { lastSource.current = source; settled.current = false; }
  const refresh = mailInlineRefreshScript(!disabled, images);
  useEffect(() => { web.current?.injectJavaScript(refresh); }, [refresh]);
  return <WebView key={revision} ref={web} source={source} originWhitelist={["*"]} javaScriptEnabled style={{ height: 280 }}
    onShouldStartLoadWithRequest={request => !settled.current && request.url === "about:blank"} scrollEnabled keyboardDisplayRequiresUserAction
    onLoadEnd={() => { settled.current = true; web.current?.injectJavaScript(mailInlineBindingScript(revision) + refresh); }}
    javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows={false} allowFileAccess={false} allowFileAccessFromFileURLs={false}
    allowUniversalAccessFromFileURLs={false} mediaCapturePermissionGrantType="deny" sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} domStorageEnabled={false} incognito cacheEnabled={false}
    onMessage={event => {
      if (disabled || AppState.currentState !== "active" || event.nativeEvent.data.length > 100_000) return;
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.type !== "mail-text" || data.documentId !== revision || typeof data.id !== "string" || typeof data.text !== "string") return;
        const edits = { ...model.current.edits, [data.id]: data.text }, result = applyMailInlineEdits(model.current.source, edits);
        if (!result) return;
        model.current.edits = edits; model.current.emitted = result.html; onChange(result.html, result.text);
      } catch { /* Only a known source span may change draft text. */ }
    }} />;
}
const styles = StyleSheet.create({ fill: { flex: 1 }, card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: "hidden", marginVertical: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44, paddingHorizontal: 16, paddingVertical: 4 }, title: { flex: 1, fontSize: 13, fontWeight: "500" },
  control: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, alignItems: "center", justifyContent: "center", alignSelf: "flex-end" }, notice: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 12 },
  failure: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16 }, failureText: { flex: 1, fontSize: 12, lineHeight: 18 },
  fields: { paddingHorizontal: 12 }, field: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth }, label: { fontSize: 12 },
  input: { flex: 1, minWidth: 0, padding: 8, fontSize: 14, lineHeight: 21 }, multiline: { paddingVertical: 8 }, bodyInput: { minHeight: 120, textAlignVertical: "top" },
  prompt: { minHeight: 160, margin: 16, padding: 12, borderWidth: 1, borderRadius: 8, fontSize: 16, textAlignVertical: "top" },
  chips: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 }, chip: { maxWidth: 160, borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, paddingHorizontal: 8, paddingVertical: 4 }, chipText: { fontSize: 12 },
  attachments: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingVertical: 8 }, attachment: { flexDirection: "row", alignItems: "center", maxWidth: "100%", borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingLeft: 8 }, attachmentName: { flexShrink: 1, fontSize: 12 }
});

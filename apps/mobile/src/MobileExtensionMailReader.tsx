import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { mailMessageFields, mailPreviewImages, parseMailMessage, resolveExtensionCardMedia, extensionCardInlineImages, type MailMessage } from "@joko/contracts";
import type { MobileExtensionCardApi } from "./mobile-extension-card-api";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { MobileExtensionCardFields } from "./MobileExtensionCardForm";
import { mobileExtensionCardMessages } from "./mobile-extension-card-messages";

const Context = createContext<((url: string) => Promise<boolean>) | undefined>(undefined);
export function useMobileMailLink() { return useContext(Context); }
export function MobileExtensionMailReaderProvider({ ownerKey, sessionId, bind, colors, locale, children }: {
  readonly ownerKey: string; readonly sessionId?: string; readonly bind: (sessionId: string) => MobileExtensionCardApi | undefined;
  readonly colors: MobileInteractionSheetColors & { readonly dark: boolean }; readonly locale: MobileSupportedLocale; readonly children: ReactNode;
}) {
  const latest = useRef(ownerKey); latest.current = ownerKey;
  const lifetime = useRef(new AbortController()), sequence = useRef(0), copy = mobileExtensionCardMessages(locale);
  const [view, setView] = useState<{ url: string; loading: boolean; message?: MailMessage; media?: Record<string, string>; error?: string }>();
  const [threadFor, setThreadFor] = useState<string>();
  const api = useMemo(() => sessionId ? bind(sessionId) : undefined, [ownerKey, sessionId]);
  const close = () => { sequence.current++; setView(undefined); };
  useEffect(() => { const abort = new AbortController(); lifetime.current = abort; close();
    const listener = AppState.addEventListener("change", state => { if (state !== "active") close(); });
    return () => { abort.abort(); sequence.current++; listener.remove(); };
  }, [ownerKey, sessionId]);
  const current = () => { lifetime.current.signal.throwIfAborted(); if (latest.current !== ownerKey || AppState.currentState !== "active") throw new Error("Mail owner changed."); };
  const load = async (url: string) => {
    if (!api || !sessionId) return;
    const request = ++sequence.current;
    try {
      current(); setView({ url, loading: true });
      const result = await api.previewMail({ sessionId, url, read: true, opened: true }, { signal: lifetime.current.signal }); current();
      if (request !== sequence.current) return;
      const message = result.messageJson ? parseMailMessage(JSON.parse(result.messageJson)) : null;
      setView({ url, loading: false, ...(message ? { message } : { error: result.error === "MAIL_PROVIDER_AMBIGUOUS" ? copy.mailAmbiguous : copy.mailFailed }) });
      if (message && result.extensionId) {
        const uris = mailPreviewImages({ attachmentItems: JSON.stringify(message.attachments) }).map(image => image.url);
        const media = await resolveExtensionCardMedia(uris, async uri => (await api.readMedia({ sessionId, extensionId: result.extensionId, uri }, { signal: lifetime.current.signal })).dataUrl, lifetime.current.signal);
        current(); if (request === sequence.current) setView({ url, loading: false, message, media });
      }
    } catch { if (!lifetime.current.signal.aborted && latest.current === ownerKey && request === sequence.current && AppState.currentState === "active") setView({ url, loading: false, error: copy.mailFailed }); }
  };
  const open = async (url: string): Promise<boolean> => {
    if (!api || !sessionId || !url.startsWith("https://")) return false;
    const attempt = ++sequence.current;
    current(); const result = await api.previewMail({ sessionId, url, read: false }, { signal: lifetime.current.signal }); current();
    if (attempt !== sequence.current) return true;
    if (!result.supported) return false;
    void load(url); return true;
  };
  const labels: Record<string, string> = { to: copy.mailTo, cc: copy.mailCc, bcc: copy.mailBcc, subject: copy.mailSubject };
  const fields = view?.message ? mailMessageFields(view.message, name => labels[name] ?? name) : [];
  return <Context.Provider value={open}>{children}<Modal visible={Boolean(view)} animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.surface }]}>
      <View style={styles.header}><Text numberOfLines={2} style={[styles.title, { color: colors.ink }]}>{view?.message?.subject || copy.preview}</Text>
        <Pressable accessibilityRole="button" style={styles.control} onPress={close}><Text style={{ color: colors.muted }}>{copy.close}</Text></Pressable>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled">
        {view?.loading && <ActivityIndicator color={colors.accent} />}
        {view?.error && <View accessibilityRole="alert" style={styles.meta}><Text style={{ color: colors.negative }}>{view.error}</Text><Pressable accessibilityRole="button" style={styles.control} onPress={() => { if (view) void load(view.url); }}><Text style={{ color: colors.accent }}>{copy.retry}</Text></Pressable></View>}
        {view?.message && <>
          <Text style={[styles.meta, { color: colors.muted }]}>{view.message.from}{"\n"}{view.message.date}</Text>
          {(view.message.conversationUnavailable || view.message.markReadFailed) && <Text style={[styles.meta, { color: colors.muted }]}>{copy.mailPartial}</Text>}
          <MobileExtensionCardFields fields={fields} values={Object.fromEntries(fields.map(field => [field.name, field.value]))} colors={colors} copy={copy} disabled foreground
            images={extensionCardInlineImages(mailPreviewImages({ attachmentItems: JSON.stringify(view.message.attachments) }), view.media ?? {})} onChange={() => {}} />
          {view.message.conversation && <View style={styles.meta}><Pressable accessibilityRole="button" accessibilityState={{ expanded: threadFor === view.message.messageId }} style={styles.control} onPress={() => setThreadFor(previous => previous === view.message?.messageId ? undefined : view.message?.messageId)}><Text style={{ color: colors.muted }}>{copy.mailThread} ({view.message.conversation.messages.length})</Text></Pressable>
            {threadFor === view.message.messageId && view.message.conversation.messages.map(message => <Pressable accessibilityRole="button" disabled={message.messageId === view.message?.messageId} key={message.messageId}
              style={[styles.thread, { borderColor: colors.border }]} onPress={() => void load(message.url)}><Text style={{ color: colors.ink }}>{message.from}</Text><Text style={{ color: colors.muted }}>{message.date}</Text><Text style={{ color: colors.ink }}>{message.subject}</Text><Text numberOfLines={2} style={{ color: colors.muted }}>{message.snippet}</Text></Pressable>)}
          </View>}
        </>}
        {view && <Pressable accessibilityRole="link" style={styles.control} onPress={() => { const url = view.url; current(); void Linking.openURL(url).catch(() => { if (latest.current === ownerKey) setView(previous => previous ? { ...previous, error: copy.mailFailed } : previous); }); }}><Text style={{ color: colors.accent }}>{copy.mailOriginal}</Text></Pressable>}
      </ScrollView>
    </SafeAreaView>
  </Modal></Context.Provider>;
}
const styles = StyleSheet.create({ fill: { flex: 1 }, header: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12 }, title: { flex: 1, fontSize: 16, fontWeight: "500" },
  control: { minHeight: 44, paddingHorizontal: 12, justifyContent: "center" }, meta: { padding: 12, fontSize: 12, lineHeight: 18 }, thread: { paddingVertical: 12, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth }
});

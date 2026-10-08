import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import {
  MobileRemoteDesktopController,
  type MobileRemoteDesktopInputMode,
  type MobileRemoteDesktopTransport
} from "./remote-desktop-controller";
import {
  mobileRemoteDesktopCopy,
  mobileRemoteDesktopNoticeLabel,
  mobileRemoteDesktopStatusLabel
} from "./remote-desktop-presentation";
import { remoteDesktopViewerCommand, remoteDesktopViewerHtml } from "./remote-desktop-viewer";

export interface MobileRemoteDesktopColors {
  readonly background: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly negative: string;
}

export function MobileRemoteDesktopScreen({ transport, preferredDeviceId, interactive, foreground, online, colors, locale, onClose }: {
  readonly transport?: MobileRemoteDesktopTransport;
  readonly preferredDeviceId?: string;
  readonly interactive: boolean;
  readonly foreground: boolean;
  readonly online: boolean;
  readonly colors: MobileRemoteDesktopColors;
  readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
}) {
  const copy = mobileRemoteDesktopCopy(locale);
  if (!transport) return <Unavailable colors={colors} title={copy.title} message={copy.revoked}
    back={copy.back} onClose={onClose} />;
  return <RemoteDesktopSession key={`${transport.ownerKey}/${preferredDeviceId ?? "picker"}`}
    transport={transport} preferredDeviceId={preferredDeviceId} interactive={interactive}
    foreground={foreground} online={online}
    colors={colors} locale={locale} onClose={onClose} />;
}

function RemoteDesktopSession({ transport, preferredDeviceId, interactive, foreground, online, colors, locale, onClose }: {
  readonly transport: MobileRemoteDesktopTransport;
  readonly preferredDeviceId?: string;
  readonly interactive: boolean;
  readonly foreground: boolean;
  readonly online: boolean;
  readonly colors: MobileRemoteDesktopColors;
  readonly locale: MobileSupportedLocale;
  readonly onClose: () => void;
}) {
  const copy = mobileRemoteDesktopCopy(locale);
  const controller = useMemo(() => new MobileRemoteDesktopController(transport, preferredDeviceId),
    [transport.ownerKey, preferredDeviceId]);
  const snapshot = useSyncExternalStore(controller.subscribe, () => controller.snapshot);
  const webView = useRef<WebView>(null);
  const html = useMemo(() => remoteDesktopViewerHtml(colors.background, colors.ink), [colors.background, colors.ink]);
  useEffect(() => {
    controller.setViewerSink((message) => webView.current?.injectJavaScript(remoteDesktopViewerCommand(message)));
    return () => controller.setViewerSink(() => undefined);
  }, [controller]);
  useEffect(() => {
    void controller.open();
    return () => { void controller.close(); };
  }, [controller]);
  useEffect(() => controller.setForeground(foreground), [controller, foreground]);
  useEffect(() => controller.setInteractive(interactive), [controller, interactive]);
  useEffect(() => controller.setOnline(online), [controller, online]);
  const status = mobileRemoteDesktopStatusLabel(snapshot, copy);
  const notice = mobileRemoteDesktopNoticeLabel(snapshot.notice, copy);
  const selection = snapshot.status === "select-host" || snapshot.status === "select-display";
  const terminal = ["unsupported", "permission", "revoked", "busy", "stopped", "error"].includes(snapshot.status);
  return <View style={[styles.root, { backgroundColor: colors.background }]}>
    <View style={[styles.header, { borderColor: colors.border, backgroundColor: colors.background }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={copy.back} onPress={onClose}
        style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
        <Text style={[styles.backText, { color: colors.ink }]}>‹</Text>
      </Pressable>
      <View style={styles.heading}>
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: colors.ink }]}>
          {snapshot.host?.displayName || copy.title}
        </Text>
        <Text accessibilityLiveRegion="polite" numberOfLines={2} style={[styles.caption,
          { color: snapshot.status === "error" || snapshot.status === "revoked" ? colors.negative : colors.muted }]}>
          {notice && notice !== status ? `${status} · ${notice}` : status}
        </Text>
      </View>
      {snapshot.status === "live" && <Text style={[styles.badge, { color: colors.ink, borderColor: colors.border }]}>
        {snapshot.controlling ? copy.control : copy.view}
      </Text>}
    </View>
    <View style={[styles.viewer, { backgroundColor: colors.background }]}>
      <WebView ref={webView} source={{ html, baseUrl: "about:blank" }} originWhitelist={["about:blank"]}
        javaScriptEnabled domStorageEnabled={false} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false}
        allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never" mediaPlaybackRequiresUserAction={false} allowsInlineMediaPlayback
        setSupportMultipleWindows={false} onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
        onMessage={(event) => controller.viewerMessage(event.nativeEvent.data)}
        onError={() => { controller.viewerProcessLost(); webView.current?.reload(); }}
        onContentProcessDidTerminate={() => { controller.viewerProcessLost(); webView.current?.reload(); }}
        onRenderProcessGone={() => { controller.viewerProcessLost(); webView.current?.reload(); return true; }}
        style={styles.webView} />
      {(selection || terminal || snapshot.status === "loading") && <View style={[styles.overlay,
        { backgroundColor: `${colors.background}ee` }]}>
        {snapshot.status === "loading" ? <><ActivityIndicator color={colors.accent} />
          <Text style={[styles.message, { color: colors.muted }]}>{copy.connecting}</Text></> :
          snapshot.status === "select-host" ? <SelectionList title={copy.chooseDesktop}
            items={snapshot.hosts.map((host) => ({ id: host.route?.targetDeviceId ?? host.displayName,
              label: host.displayName, detail: host.platform }))} colors={colors}
            onSelect={(id) => { const host = snapshot.hosts.find((candidate) => candidate.route?.targetDeviceId === id); if (host) void controller.selectHost(host); }} /> :
          snapshot.status === "select-display" ? <SelectionList title={copy.chooseDisplay}
            items={(snapshot.capabilities?.displays ?? []).map((display) => ({ id: display.displayId,
              label: display.name, detail: `${display.width} × ${display.height}` }))} colors={colors}
            onSelect={(id) => void controller.selectDisplay(id)} /> : <>
            <Text accessibilityRole="alert" style={[styles.message, { color: colors.ink }]}>{notice ?? status}</Text>
            <View style={styles.overlayActions}>
              {snapshot.status === "permission" && <Button label={copy.permissionGuide} colors={colors}
                onPress={() => void controller.refreshPermissions(true)} />}
              {snapshot.status === "busy" && snapshot.takeoverAvailable && <Button label={copy.takeover} colors={colors}
                onPress={() => void controller.takeover()} />}
              {snapshot.status !== "revoked" && <Button label={copy.retry} colors={colors}
                onPress={() => void controller.retry()} />}
            </View>
          </>}
      </View>}
      {(snapshot.status === "connecting" || snapshot.status === "reconnecting" || snapshot.status === "offline")
        && <View pointerEvents="none" style={[styles.floatingStatus, { backgroundColor: `${colors.surface}e8`, borderColor: colors.border }]}>
          {snapshot.status !== "offline" && <ActivityIndicator size="small" color={colors.accent} />}
          <Text style={[styles.caption, styles.flex, { color: colors.muted }]}>{status}</Text>
        </View>}
    </View>
    <View style={[styles.controls, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.controlRow}>
        <Button label={snapshot.controlling ? copy.view : copy.control} colors={colors}
          selected={snapshot.controlling} disabled={snapshot.status !== "live" || !snapshot.capabilities?.canControl}
          onPress={() => void controller.setControl(!snapshot.controlling)} />
        {(["touch", "trackpad", "pan"] as const).map((mode) => <Button key={mode}
          label={mode === "touch" ? copy.touch : mode === "trackpad" ? copy.trackpad : copy.pan}
          colors={colors} selected={snapshot.inputMode === mode} disabled={snapshot.status !== "live"}
          onPress={() => controller.setInputMode(mode)} />)}
      </View>
      <View style={styles.controlRow}>
        <Button label={copy.left} colors={colors} disabled={!snapshot.controlling} onPress={() => controller.click(0)} />
        <Button label={copy.right} colors={colors} disabled={!snapshot.controlling} onPress={() => controller.click(2)} />
        <Button label={copy.keyboard} colors={colors} disabled={!snapshot.controlling} onPress={() => controller.showKeyboard()} />
        <Button label={copy.release} colors={colors} disabled={!snapshot.controlling} onPress={() => controller.releaseInput()} />
        <Button label={copy.fit} colors={colors} disabled={!snapshot.hasFrame} onPress={() => controller.fit()} />
      </View>
    </View>
  </View>;
}

function SelectionList({ title, items, colors, onSelect }: {
  readonly title: string;
  readonly items: readonly { readonly id: string; readonly label: string; readonly detail: string }[];
  readonly colors: MobileRemoteDesktopColors;
  readonly onSelect: (id: string) => void;
}) {
  return <View style={styles.selection}>
    <Text accessibilityRole="header" style={[styles.selectionTitle, { color: colors.ink }]}>{title}</Text>
    <ScrollView contentContainerStyle={styles.selectionList}>
      {items.map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={item.label}
        onPress={() => onSelect(item.id)} style={({ pressed }) => [styles.selectionItem,
          { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}>
        <View style={styles.flex}><Text style={[styles.label, { color: colors.ink }]}>{item.label}</Text>
          <Text style={[styles.caption, { color: colors.muted }]}>{item.detail}</Text></View>
        <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
      </Pressable>)}
    </ScrollView>
  </View>;
}

function Button({ label, colors, disabled = false, selected = false, onPress }: {
  readonly label: string;
  readonly colors: MobileRemoteDesktopColors;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, { borderColor: selected ? colors.accent : colors.border,
      backgroundColor: selected ? `${colors.accent}22` : colors.background }, disabled && styles.disabled, pressed && styles.pressed]}>
    <Text numberOfLines={1} style={[styles.buttonText, { color: disabled ? colors.muted : selected ? colors.accent : colors.ink }]}>{label}</Text>
  </Pressable>;
}

function Unavailable({ colors, title, message, back, onClose }: {
  readonly colors: MobileRemoteDesktopColors; readonly title: string; readonly message: string;
  readonly back: string; readonly onClose: () => void;
}) {
  return <View style={[styles.root, styles.center, { backgroundColor: colors.background }]}>
    <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{title}</Text>
    <Text accessibilityRole="alert" style={[styles.message, { color: colors.muted }]}>{message}</Text>
    <Button label={back} colors={colors} onPress={onClose} />
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, flex: { flex: 1 }, center: { alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  header: { minHeight: 62, paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row", alignItems: "center", gap: 8 },
  back: { width: 44, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 22 },
  backText: { fontSize: 32, lineHeight: 36 }, heading: { flex: 1, minWidth: 0 },
  title: { fontSize: 18, lineHeight: 24, fontWeight: "700" }, caption: { fontSize: 12, lineHeight: 17 },
  badge: { fontSize: 12, fontWeight: "700", borderWidth: StyleSheet.hairlineWidth, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 5 },
  viewer: { flex: 1, minHeight: 0, overflow: "hidden" }, webView: { flex: 1, backgroundColor: "transparent" },
  overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
    alignItems: "center", justifyContent: "center", gap: 14, padding: 22 },
  overlayActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
  message: { fontSize: 15, lineHeight: 22, textAlign: "center" },
  floatingStatus: { position: "absolute", top: 12, left: 12, right: 12, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 9 },
  controls: { borderTopWidth: StyleSheet.hairlineWidth, padding: 8, gap: 7 },
  controlRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "center" },
  button: { minHeight: 36, minWidth: 52, maxWidth: 160, paddingHorizontal: 11, paddingVertical: 7,
    alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 10 },
  buttonText: { fontSize: 12, lineHeight: 17, fontWeight: "600" },
  selection: { width: "100%", maxWidth: 520, maxHeight: "85%", gap: 12 },
  selectionTitle: { fontSize: 20, lineHeight: 27, fontWeight: "700", textAlign: "center" },
  selectionList: { gap: 8, paddingBottom: 8 },
  selectionItem: { minHeight: 58, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 12,
    flexDirection: "row", alignItems: "center", gap: 8 },
  label: { fontSize: 15, lineHeight: 21, fontWeight: "600" }, chevron: { fontSize: 25 },
  disabled: { opacity: 0.42 }, pressed: { opacity: 0.65 }
});

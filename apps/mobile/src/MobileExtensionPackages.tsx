import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Pressable, Text, View } from "react-native";
import { mobileExtensionKey, type MobileExtension, type MobileExtensionCatalog, type MobileExtensionTransport } from "./mobile-extensions";
import type { MobileExtensionPackagePreview } from "./mobile-extension-packages";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

export function MobileExtensionPackages({ extension, transport, colors, locale, disabled, onChanged }: {
  readonly extension: MobileExtension;
  readonly transport: MobileExtensionTransport;
  readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale;
  readonly disabled: boolean;
  readonly onChanged: (catalog: MobileExtensionCatalog) => void;
}) {
  const identity = `${transport.ownerKey}:${mobileExtensionKey(extension)}`;
  const live = useRef({ identity, transport, onChanged, disabled }); live.current = { identity, transport, onChanged, disabled };
  const request = useRef<AbortController | undefined>(undefined);
  const [preview, setPreview] = useState<MobileExtensionPackagePreview>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [foreground, setForeground] = useState(AppState.currentState !== "background" && AppState.currentState !== "inactive");
  const foregroundRef = useRef(foreground); foregroundRef.current = foreground;
  useEffect(() => {
    request.current?.abort(); setPreview(undefined); setFailure(undefined); setBusy(false);
    return () => request.current?.abort();
  }, [identity]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", state => {
      foregroundRef.current = state === "active"; setForeground(state === "active");
      if (state !== "active") { request.current?.abort(); setPreview(undefined); setBusy(false); }
    });
    return () => listener.remove();
  }, []);
  const current = (abort: AbortController) => !abort.signal.aborted && foregroundRef.current && live.current.identity === identity;
  const run = (work: (active: MobileExtensionTransport, signal: AbortSignal) => Promise<MobileExtensionCatalog>) => {
    if (busy || disabled || !foregroundRef.current) return;
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setBusy(true); setFailure(undefined);
    void work(live.current.transport, abort.signal).then(catalog => {
      if (current(abort)) { setPreview(undefined); live.current.onChanged(catalog); }
    }, error => { if (current(abort)) setFailure((error instanceof Error ? error.message : String(error)).slice(0, 1_024)); })
      .finally(() => { if (current(abort)) setBusy(false); });
  };
  const prepare = (backendId: string) => {
    if (busy || disabled || !foregroundRef.current || !transport.previewPackage) return;
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setBusy(true); setFailure(undefined); setPreview(undefined);
    void transport.previewPackage(extension, backendId, abort.signal).then(value => { if (current(abort)) setPreview(value); },
      error => { if (current(abort)) setFailure((error instanceof Error ? error.message : String(error)).slice(0, 1_024)); })
      .finally(() => { if (current(abort)) setBusy(false); });
  };
  const confirm = (remove: boolean) => {
    if (busy || disabled || !foregroundRef.current || (!remove && !preview)) return;
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    const expires = Date.now() + 60_000;
    const shown = preview;
    // A native confirmation never transfers its authority to another node,
    // refreshed installation, foreground occurrence or package preview.
    const stillCurrent = () => current(abort) && !live.current.disabled && request.current === abort && Date.now() < expires;
    const action = remove ? "remove" : shown!.action;
    Alert.alert(mobileMessage(locale, `extension.package.${action}`), remove
      ? mobileMessage(locale, "extension.package.removeBody", { name: extension.name })
      : shown!.sourceReplacement
        ? mobileMessage(locale, "extension.package.replaceBody", { source: shown!.currentResource?.source ?? "", name: extension.name })
        : mobileMessage(locale, "extension.package.confirmBody", { name: extension.name }), [
      { text: mobileMessage(locale, "common.cancel"), style: "cancel", onPress: () => abort.abort() },
      { text: mobileMessage(locale, `extension.package.${action}`), style: remove || shown?.sourceReplacement ? "destructive" : "default",
        onPress: () => {
          if (!stillCurrent()) return;
          run((active, signal) => remove
            ? active.removePackage!(extension, signal)
            : active.adoptPackage!(extension, shown!, shown!.sourceReplacement, signal));
        } }
    ], { cancelable: true, onDismiss: () => abort.abort() });
  };
  const button = (key: Parameters<typeof mobileMessage>[1], press: () => void, label = mobileMessage(locale, key), itemKey: string = key) => <Pressable key={itemKey}
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy || !foreground }}
    disabled={disabled || busy || !foreground} onPress={press} style={{ padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 10 }}>
    <Text style={{ color: colors.ink }}>{label}</Text>
  </Pressable>;
  if (!transport.previewPackage && !transport.removePackage) return null;
  return <View testID="extensions.package" style={{ gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12 }}>
    <Text style={{ color: colors.ink, fontWeight: "600" }}>{mobileMessage(locale, "extension.package.title")}</Text>
    {transport.previewPackage && (!extension.installed || extension.updateAvailable) && (transport.packageBackends?.() ?? []).map(backend =>
      button(`extension.package.${extension.installed ? "update" : "install"}`, () => prepare(backend.backendId),
        `${mobileMessage(locale, `extension.package.${extension.installed ? "update" : "install"}`)} · ${backend.name}`, backend.backendId))}
    {preview && <View testID="extensions.package.preview" style={{ gap: 8 }}>
      <Text style={{ color: colors.ink }}>{preview.packageName} · {preview.installedVersion ?? "—"} → {preview.availableVersion ?? "—"}</Text>
      <Text style={{ color: colors.muted }}>{mobileMessage(locale, preview.preservesEnabled ? "extension.package.preservesEnabled" : "extension.package.installsDisabled")}</Text>
      {preview.content.map((item, index) => <Text key={index} style={{ color: colors.ink }}>{item}</Text>)}
      {preview.disabledLifecycleScripts.length > 0 && <Text style={{ color: colors.muted }}>{mobileMessage(locale,
        "extension.package.scriptsDisabled", { scripts: preview.disabledLifecycleScripts.join(", ") })}</Text>}
      {button(`extension.package.${preview.action}`, () => confirm(false))}
      {button("common.cancel", () => setPreview(undefined))}
    </View>}
    {extension.installed && extension.owner.kind === "resource" && transport.removePackage
      && button("extension.package.remove", () => confirm(true))}
    {busy && <ActivityIndicator color={colors.accent} />}
    {failure && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{failure}</Text>}
  </View>;
}

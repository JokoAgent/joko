import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { PermissionMode, encodeModelSpeed, decodeModelSpeed, type ExtensionTaskPreferences, type ExtensionTaskRoute } from "@joko/contracts";
import { MobileModelSpeedControl } from "./MobileModelSpeedControl";
import type { MobileExtension, MobileExtensionTransport } from "./mobile-extensions";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

const key = (route: ExtensionTaskRoute) => JSON.stringify([route.backendId, route.providerId, route.modelId]);
export function MobileExtensionTaskPreferences({ extension, transport, colors, locale, disabled }: {
  readonly extension: MobileExtension; readonly transport: MobileExtensionTransport; readonly colors: MobilePartnersColors;
  readonly locale: MobileSupportedLocale; readonly disabled: boolean;
}) {
  const [state, setState] = useState<ExtensionTaskPreferences>(), [model, setModel] = useState<ExtensionTaskRoute>();
  const [permission, setPermission] = useState(PermissionMode.ASK), [expanded, setExpanded] = useState(false), [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const lifetime = useMemo(() => ({ abort: new AbortController(), busy: false }), [transport.ownerKey, extension.extensionId]);
  useEffect(() => { if (lifetime.abort.signal.aborted) lifetime.abort = new AbortController(); return () => lifetime.abort.abort(); }, [lifetime]);
  useEffect(() => {
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, lifetime.abort.signal]);
    void transport.getTaskPreferences?.(extension, signal).then(value => { if (!signal.aborted) { setState(value); setModel(value.model); setPermission(value.permissionMode); } }).catch(() => { if (!signal.aborted) setState(undefined); });
    return () => abort.abort();
  }, [transport, extension.extensionId, extension.revision, lifetime]);
  if (!state || !state.showPreferences && !state.writeRequests.length || state.extensionId !== extension.extensionId) return null;
  const zh = locale === "zh-CN", selected = state.models.find(value => value.route && model && key(value.route) === key(model));
  const label = (en: string, cn: string) => zh ? cn : en;
  const action = (title: string, press: () => void, active = false) => <Pressable key={title} accessibilityRole="button" accessibilityState={{ disabled: disabled || busy, selected: active }} disabled={disabled || busy}
    onPress={press} style={[styles.action, { borderColor: colors.border, backgroundColor: colors.surface }]}><Text style={{ color: colors.ink }}>{active ? "✓ " : ""}{title}</Text></Pressable>;
  return <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]} testID="extensions.task-preferences">
    {state.showPreferences && <><Text style={[styles.title, { color: colors.ink }]}>{label("Model & tasks", "模型与任务")}</Text>
    {action(model ? `${selected?.name ?? model.modelId} · ${model.providerId}` : label("Follow default", "跟随默认"), () => setExpanded(value => !value))}
    {expanded && <ScrollView style={styles.choices} nestedScrollEnabled>
      {action(label("Follow default", "跟随默认"), () => { setModel(undefined); setExpanded(false); }, !model)}
      {state.models.map(value => value.route && action(`${value.name} · ${value.route.backendId} · ${value.route.providerId}`, () => { setModel(value.route); setExpanded(false); }, !!model && key(model) === key(value.route)))}
    </ScrollView>}
    {model && <><Text style={{ color: colors.muted }}>{label("Reasoning effort", "思考强度")}</Text><View style={styles.row}>{selected?.efforts.map(effort => action(effort, () => setModel({ ...model, effort }), model.effort === effort))}</View>
      <MobileModelSpeedControl value={decodeModelSpeed(model)} supportsFast={selected?.supportsFastMode === true} supportsUltrafast={selected?.supportsUltrafastMode}
        disabled={disabled || busy} colors={colors} locale={locale} onChange={speed => setModel({ ...model, ...encodeModelSpeed(speed) })} /></>}
    {state.tasksAvailable && <><Text style={{ color: colors.muted }}>{label("Task permissions", "任务权限")}</Text><View style={styles.row}>
      {action(label("Ask before changes", "修改前询问"), () => setPermission(PermissionMode.ASK), permission === PermissionMode.ASK)}
      {action(label("Accept file edits", "允许文件编辑"), () => setPermission(PermissionMode.ACCEPT_EDITS), permission === PermissionMode.ACCEPT_EDITS)}
      {action(label("Automatic approval", "自动审批"), () => setPermission(PermissionMode.AUTO), permission === PermissionMode.AUTO)}</View></>}
    {action(label("Save", "保存"), () => {
      if (lifetime.busy || !transport.setTaskPreferences) return; lifetime.busy = true; setBusy(true); setError(false);
      void transport.setTaskPreferences(extension, state, model, permission, lifetime.abort.signal).then(value => { if (!lifetime.abort.signal.aborted) setState(value); })
        .catch(() => { if (!lifetime.abort.signal.aborted) setError(true); }).finally(() => { lifetime.busy = false; if (!lifetime.abort.signal.aborted) setBusy(false); });
    })}</>}
    {state.writeRequests.map(request => action(`${label("Retry permission", "重试权限请求")} · ${request.title}`, () => {
      if (lifetime.busy || !transport.retryTaskWriteAccess) return; lifetime.busy = true; setBusy(true); setError(false);
      void transport.retryTaskWriteAccess(extension, request.taskId, lifetime.abort.signal).then(value => { if (!lifetime.abort.signal.aborted) setState(value); })
        .catch(() => { if (!lifetime.abort.signal.aborted) setError(true); }).finally(() => { lifetime.busy = false; if (!lifetime.abort.signal.aborted) setBusy(false); });
    }))}
    {error && <Text accessibilityRole="alert" style={{ color: colors.ink }}>{label("Could not save. Refresh and try again.", "保存失败，请刷新后重试。")}</Text>}
  </View>;
}
const styles = StyleSheet.create({ card: { padding: 16, gap: 12, borderWidth: 1, borderRadius: 16 }, title: { fontSize: 18, fontWeight: "600" },
  action: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, minHeight: 44 }, row: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, choices: { maxHeight: 280 } });

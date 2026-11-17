import { createContext, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { taskActivityMessages, type TaskActivityDevice, type TaskActivityState } from "@joko/contracts";
import { followTaskActivity, type TaskActivityPort } from "@joko/connection-transport";
import type { MobileClient, MobileState } from "./mobile-client";

type Colors = { readonly ink: string; readonly surface: string; readonly accent: string; readonly border: string };
interface ActivityContext {
  readonly port?: TaskActivityPort;
  readonly generation: bigint;
  readonly preferenceKey: string;
  readonly devices: readonly TaskActivityDevice[];
  readonly inlineCount: number;
  readonly inline: (delta: number) => void;
  readonly locale: string;
  readonly colors: Colors;
  readonly busy: boolean;
  readonly manage: () => void;
  readonly confirm: (device: TaskActivityDevice) => void;
}
const Activity = createContext<ActivityContext | undefined>(undefined);
const collapsed = new Map<string, boolean>();
const empty: readonly TaskActivityDevice[] = Object.freeze([]);

export function MobileTaskActivityProvider({ client, state, foreground, locale, colors, onManage, children }: PropsWithChildren<{
  readonly client: Partial<Pick<MobileClient, "taskActivity" | "taskActivityOwnerKey">>;
  readonly state: MobileState; readonly foreground: boolean; readonly locale: string; readonly colors: Colors; readonly onManage: () => void;
}>) {
  const owner = foreground ? client.taskActivityOwnerKey?.() : undefined;
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const port = useMemo(() => owner ? client.taskActivity?.() : undefined, [owner, client]);
  const [projection, setProjection] = useState<{ readonly owner: string; readonly value?: TaskActivityState }>();
  const [inlineCount, setInlineCount] = useState(0), [busy, setBusy] = useState(false);
  const flight = useRef<object | undefined>(undefined);
  const inline = useMemo(() => (delta: number) => setInlineCount(count => count + delta), []);
  const generation = state.owner?.generation ?? 0n;
  const profile = state.saved.find(value => value.profileId === state.activeProfileId);
  const preferenceKey = JSON.stringify([state.node?.serverId, state.origin, state.activeProfileId, profile?.endpointPublicKey]);
  useEffect(() => {
    setProjection(undefined);
    if (!owner || !port) return;
    const abort = new AbortController();
    void followTaskActivity(port, [], generation, abort.signal, value => {
      if (!abort.signal.aborted && ownerRef.current === owner) setProjection({ owner, value });
    });
    return () => abort.abort();
  }, [owner, port, generation]);
  useEffect(() => { flight.current = undefined; setBusy(false); }, [owner]);
  useEffect(() => { ownerRef.current = owner; return () => { ownerRef.current = undefined; }; }, [owner]);
  const devices = projection !== undefined && projection.owner === owner ? projection.value?.activeDevices.filter(device => device.deviceId !== profile?.deviceId) ?? empty : empty;
  const m = taskActivityMessages(locale);
  const confirm = (device: TaskActivityDevice) => {
    if (!port || !owner || flight.current) return;
    // Both the Device and the node connection are fixed before native async UI.
    const target = { ...device }, targetPort = port, targetOwner = owner;
    Alert.alert(m.title, m.body(target.displayName), [
      { text: m.cancel, style: "cancel" },
      { text: m.revoke, style: "destructive", onPress: () => {
        if (ownerRef.current !== targetOwner || flight.current) return;
        const token = {}; flight.current = token; setBusy(true);
        void targetPort.revoke(target.deviceId).catch(() => {
          if (ownerRef.current === targetOwner && flight.current === token) Alert.alert(m.failed, undefined, [
            { text: m.cancel, style: "cancel" }, { text: m.manage, onPress: () => { if (ownerRef.current === targetOwner) onManage(); } }
          ]);
        }).finally(() => { if (ownerRef.current === targetOwner && flight.current === token) { flight.current = undefined; setBusy(false); } });
      } }
    ]);
  };
  return <Activity.Provider value={{ port, generation, preferenceKey, devices, inlineCount, inline, locale, colors, busy, manage: onManage, confirm }}>
    {children}
  </Activity.Provider>;
}

export function useMobileTaskActivityView(sessionId: string | undefined): void {
  const context = useContext(Activity), port = context?.port, generation = context?.generation;
  useEffect(() => {
    if (!port || generation === undefined || !sessionId) return;
    const abort = new AbortController();
    void followTaskActivity(port, [sessionId], generation, abort.signal, () => {});
    return () => abort.abort();
  }, [port, generation, sessionId]);
}

export function MobileTaskActivityBanner({ sessionId }: { readonly sessionId?: string }) {
  const context = useContext(Activity);
  const [folded, setFolded] = useState<{ readonly key: string; readonly value: boolean }>();
  const inline = context?.inline;
  useEffect(() => { if (!sessionId || !inline) return; inline(1); return () => inline(-1); }, [sessionId, inline]);
  if (!context || !context.devices.length || !sessionId && context.inlineCount > 0) return null;
  const m = taskActivityMessages(context.locale), first = context.devices[0]!;
  const label = m.label(first.displayName, context.devices.length);
  const key = JSON.stringify([context.preferenceKey, sessionId]);
  const isCollapsed = sessionId !== undefined && (folded?.key === key ? folded.value : collapsed.get(key) === true);
  const fold = (value: boolean) => {
    collapsed.delete(key); collapsed.set(key, value);
    if (collapsed.size > 512) collapsed.delete(collapsed.keys().next().value!);
    setFolded({ key, value });
  };
  const button = (text: string, action: () => void, visible = text) => <Pressable accessibilityRole="button" accessibilityLabel={text}
    disabled={context.busy} accessibilityState={{ disabled: context.busy }} onPress={action}
    style={{ minHeight: 44, minWidth: 44, justifyContent: "center", paddingHorizontal: 8 }}><Text style={{ color: context.colors.accent }}>{visible}</Text></Pressable>;
  return <View pointerEvents="box-none" style={sessionId ? { alignItems: "center", paddingHorizontal: 8 }
    : { position: "absolute", left: 16, right: 16, bottom: 16, zIndex: 20, alignItems: "center" }}>
    <View style={{ flexDirection: "row", alignItems: "center", maxWidth: "100%", borderWidth: 1, borderRadius: 16,
      borderColor: context.colors.border, backgroundColor: context.colors.surface, paddingHorizontal: 8 }}>
      {isCollapsed ? button(`${m.expand}: ${label}`, () => fold(false), "●") : <>
        <Text accessibilityLiveRegion="polite" accessibilityHint={context.devices.map(device => device.displayName).join(" · ")}
          style={{ color: context.colors.ink, flexShrink: 1 }} numberOfLines={2}>{label}</Text>
        {button(context.devices.length === 1 ? m.revoke : m.manage, () => context.devices.length === 1 ? context.confirm({ ...first }) : context.manage())}
        {sessionId && button(m.collapse, () => fold(true), "⌄")}
      </>}
    </View>
  </View>;
}

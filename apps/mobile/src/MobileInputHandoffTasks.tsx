import { useEffect, useRef, useState } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import type { Session } from "@joko/contracts";
import type { MobileInputHandoffTask, MobileInputHandoffTasksApi } from "./mobile-input-handoff";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileInputHandoffText } from "./mobile-input-handoff-text";

/** Home advertises only a fixed attention label and the already-owned task title. */
export function MobileInputHandoffTasks(props: { readonly api: MobileInputHandoffTasksApi; readonly sessions: readonly Session[];
  readonly colors: MobileInteractionSheetColors; readonly locale: MobileSupportedLocale; readonly onOpen: (sessionId: string) => void }) {
  const [foreground, setForeground] = useState(AppState.currentState === "active"), [result, setResult] = useState<{ readonly ownerKey: string; readonly tasks: readonly MobileInputHandoffTask[] }>(), current = useRef(props);
  current.current = props;
  useEffect(() => {
    const app = AppState.addEventListener("change", state => { setForeground(state === "active"); if (state !== "active") setResult(undefined); }); return () => app.remove();
  }, []);
  useEffect(() => {
    if (!foreground) return; const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const key = props.api.ownerKey; setResult(undefined);
    const active = () => !abort.signal.aborted && current.current.api.ownerKey === key && current.current.api.isCurrent() && AppState.currentState === "active";
    const read = async () => {
      if (!active()) return;
      try { const value = await current.current.api.list(abort.signal); if (active()) setResult({ ownerKey: key, tasks: value }); }
      catch { if (active()) setResult(undefined); }
      finally { if (active()) timer = setTimeout(() => { void read(); }, 2000); }
    };
    const app = AppState.addEventListener("change", state => { if (state !== "active") { abort.abort(); clearTimeout(timer); } }); void read();
    return () => { abort.abort(); clearTimeout(timer); app.remove(); };
  }, [props.api.ownerKey, foreground]);
  const tasks = result?.ownerKey === props.api.ownerKey ? result.tasks : [];
  const sessions = props.sessions.filter(session => !session.archived && tasks.some(task => task.sessionId === session.sessionId && task.generation === session.nativeBinding?.runtimeGeneration));
  if (!foreground || !props.api.isCurrent() || !sessions.length) return null;
  return <View style={{ marginHorizontal: 16, marginBottom: 8, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: props.colors.border, backgroundColor: props.colors.brandBackground, gap: 8 }}>
    <Text accessibilityLiveRegion="polite" style={{ color: props.colors.ink, fontWeight: "600" }}>{mobileInputHandoffText(props.locale, "title")}</Text>
    {sessions.map(session => <Pressable key={session.sessionId} accessibilityRole="button" accessibilityLabel={`${mobileInputHandoffText(props.locale, "openTask")} · ${session.displayName}`}
      style={{ minHeight: 44, justifyContent: "center" }} onPress={() => { if (AppState.currentState === "active" && props.api.isCurrent()) props.onOpen(session.sessionId); }}>
      <Text style={{ color: props.colors.accent }}>{session.displayName || mobileInputHandoffText(props.locale, "openTask")}</Text>
    </Pressable>)}
  </View>;
}

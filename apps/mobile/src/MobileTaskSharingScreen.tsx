import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { parseTaskShareInvitation, type JoinedTaskShare, type ListTaskSharesResponse, type TaskShare, type TaskSharingApi } from "@joko/contracts";
import type { MobileClient, MobileState } from "./mobile-client";
import type { MobilePlainStorageDriver } from "./connection-storage";
import type { MobileSettingsColors } from "./MobileSettingsScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

export function mobileTaskSharingCopy(locale: MobileSupportedLocale) {
  const language = locale.startsWith("zh") ? "zh" : locale;
  const labels = {
    en: { title: "Shared tasks", owned: "Shared by you", joined: "Joined", join: "Join task", invitation: "Invitation link", name: "Your display name",
      preview: "Preview invitation", paste: "Paste invitation", share: "Share this task", invite: "Generate and copy invitation", members: "Participants", remove: "Remove participant",
      leave: "Leave task", end: "End sharing", endAll: "End all sharing", cancel: "Cancel", confirm: "Confirm", retry: "Refresh", back: "Back", open: "Open task",
      empty: "No shared tasks.", connect: "Connect to your Home node to manage shared tasks.", unknown: "The result is unknown. Check the original action; it was not resent.",
      check: "Check action status", copied: "Invitation copied.", generated: "The invitation was generated, but its link was not received. Explicitly generate a new invitation to replace it.",
      pending: "Pending actions", ended: "Access ended", active: "Active", failed: "Failed", reconnect: "Reconnect", creating: "Working…", choose: "Choose a task to share", joinedOk: "Joined this task.",
      warning: "Invited participants can view and control this task. You can remove them or end sharing.", backend: "Backend", thinking: "Thinking", enabled: "On", disabled: "Off" },
    zh: { title: "共享任务", owned: "我发起的", joined: "我加入的", join: "加入任务", invitation: "邀请链接", name: "你的显示名称",
      preview: "预览邀请", paste: "粘贴邀请", share: "共享此任务", invite: "生成并复制邀请", members: "参与者", remove: "移除参与者",
      leave: "离开任务", end: "结束共享", endAll: "结束全部共享", cancel: "取消", confirm: "确认", retry: "刷新", back: "返回", open: "打开任务",
      empty: "暂无共享任务。", connect: "连接到你的 Home 节点以管理共享任务。", unknown: "结果尚未确认。请核对原操作，系统没有重新发送。",
      check: "核对操作状态", copied: "已复制邀请。", generated: "邀请已生成，但未收到链接。请明确重新生成邀请，替换旧邀请。",
      pending: "待确认操作", ended: "访问已结束", active: "有效", failed: "失败", reconnect: "重新连接", creating: "处理中…", choose: "选择要共享的任务", joinedOk: "已加入任务。",
      warning: "受邀参与者可以观看和控制此任务。你可以移除参与者或结束共享。", backend: "Backend", thinking: "思考", enabled: "开", disabled: "关" },
    ja: { title: "共有タスク", owned: "自分が共有", joined: "参加中", join: "タスクに参加", invitation: "招待リンク", name: "表示名",
      preview: "招待を確認", paste: "招待を貼り付け", share: "このタスクを共有", invite: "招待を作成してコピー", members: "参加者", remove: "参加者を削除",
      leave: "タスクから退出", end: "共有を終了", endAll: "すべての共有を終了", cancel: "キャンセル", confirm: "確認", retry: "更新", back: "戻る", open: "タスクを開く",
      empty: "共有タスクはありません。", connect: "Home ノードに接続してください。", unknown: "結果は未確認です。元の操作を確認してください。再送信はしていません。",
      check: "操作結果を確認", copied: "招待をコピーしました。", generated: "招待は作成されましたが、リンクを受信できませんでした。新しい招待を明示的に作成してください。",
      pending: "未確認の操作", ended: "アクセス終了", active: "有効", failed: "失敗", reconnect: "再接続", creating: "処理中…", choose: "共有するタスクを選択", joinedOk: "タスクに参加しました。",
      warning: "参加者はこのタスクを表示・操作できます。参加者の削除や共有の終了が可能です。", backend: "Backend", thinking: "思考", enabled: "オン", disabled: "オフ" },
    ko: { title: "공유 작업", owned: "내가 공유", joined: "참여 중", join: "작업 참여", invitation: "초대 링크", name: "표시 이름",
      preview: "초대 확인", paste: "초대 붙여넣기", share: "이 작업 공유", invite: "초대 생성 및 복사", members: "참여자", remove: "참여자 제거",
      leave: "작업 나가기", end: "공유 종료", endAll: "모든 공유 종료", cancel: "취소", confirm: "확인", retry: "새로 고침", back: "뒤로", open: "작업 열기",
      empty: "공유 작업이 없습니다.", connect: "Home 노드에 연결하세요.", unknown: "결과를 확인할 수 없습니다. 원래 작업의 상태를 확인하세요. 자동으로 재전송하지 않았습니다.",
      check: "작업 상태 확인", copied: "초대를 복사했습니다.", generated: "초대가 생성되었지만 링크를 받지 못했습니다. 새 초대를 명시적으로 생성하세요.",
      pending: "확인 대기 작업", ended: "접근 종료", active: "활성", failed: "실패", reconnect: "다시 연결", creating: "처리 중…", choose: "공유할 작업 선택", joinedOk: "작업에 참여했습니다.",
      warning: "초대된 참여자는 작업을 보고 제어할 수 있습니다. 참여자를 제거하거나 공유를 종료할 수 있습니다.", backend: "Backend", thinking: "사고", enabled: "켜짐", disabled: "꺼짐" }
  }[language === "zh" || language === "ja" || language === "ko" ? language : "en"];
  const controls = { en: ["Stop", "Resume", "Steer"], zh: ["停止", "继续", "即时引导"], ja: ["停止", "再開", "指示を追加"], ko: ["중지", "계속", "즉시 지시"] }[language === "zh" || language === "ja" || language === "ko" ? language : "en"];
  return { ...labels, stop: controls[0]!, resume: controls[1]!, steer: controls[2]! };
}

type Action = { readonly operationId: string; readonly kind: "create" | "invite" | "remove" | "end" | "endAll" | "leave" | "join" };
export function MobileTaskSharingScreen({ client, state, colors, locale, foreground, storage, invitation: incoming,
  onInvitationConsumed, onBack, onOpenTask, initialSessionId, leaveJoinId, onLeavePromptConsumed }: {
  readonly client: MobileClient; readonly state: MobileState; readonly colors: MobileSettingsColors;
  readonly locale: MobileSupportedLocale; readonly foreground: boolean;
  readonly storage: Pick<MobilePlainStorageDriver, "getItem" | "setItem">;
  readonly invitation?: string; readonly onInvitationConsumed: () => void; readonly onBack: () => void;
  readonly onOpenTask: () => void; readonly initialSessionId?: string;
  readonly leaveJoinId?: string; readonly onLeavePromptConsumed?: () => void;
}) {
  const t = mobileTaskSharingCopy(locale), api = client.taskSharingApi();
  const ownerKey = client.taskSharingOwnerKey();
  const [catalog, setCatalog] = useState<ListTaskSharesResponse>();
  const [tab, setTab] = useState<"owned" | "joined">(leaveJoinId ? "joined" : "owned");
  const [invitation, setInvitation] = useState(incoming ?? ""), [displayName, setDisplayName] = useState("");
  const [preview, setPreview] = useState<TaskShare>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [actions, setActions] = useState<readonly Action[]>([]);
  const [actionsLoaded, setActionsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState(initialSessionId);
  const controller = useRef<AbortController | undefined>(undefined), refresh = useRef<() => Promise<void>>(async () => {});
  const currentOwner = useRef(ownerKey); currentOwner.current = ownerKey;
  const storageKey = `joko.mobile.shared-task.actions.v1:${ownerKey ?? ""}`;
  const actionsRef = useRef(actions); actionsRef.current = actions;
  useEffect(() => { if (incoming) { setInvitation(incoming); setPreview(undefined); onInvitationConsumed(); } }, [incoming, onInvitationConsumed]);
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    setCatalog(undefined); setActions([]); setActionsLoaded(false); setBusy(false); setError(""); setNotice("");
    if (!api || !ownerKey || !foreground) return () => abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined, flight: Promise<void> | undefined;
    const read = (): Promise<void> => flight ??= (async () => {
      try {
        const result = await api.list(AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]));
        if (!abort.signal.aborted && currentOwner.current === ownerKey) { setCatalog(result); setError(""); }
      } catch (failure) { if (!abort.signal.aborted && currentOwner.current === ownerKey) setError(errorText(failure)); }
      finally {
        flight = undefined;
        if (!abort.signal.aborted) { if (timer) clearTimeout(timer); timer = setTimeout(() => void read(), 5_000); }
      }
    })();
    refresh.current = read;
    void storage.getItem(storageKey).then(raw => {
      if (abort.signal.aborted) return;
      if (!raw) { setActionsLoaded(true); return; }
      try {
        const value: unknown = JSON.parse(raw);
        if (Array.isArray(value) && value.length <= 64 && value.every(item => item && typeof item.operationId === "string"
          && /^[A-Za-z0-9_.:-]{1,128}$/u.test(item.operationId) && ["create", "invite", "remove", "end", "endAll", "leave", "join"].includes(item.kind))) {
          setActions(value as Action[]); actionsRef.current = value as Action[]; setActionsLoaded(true);
        } else setError("The retained shared task action list could not be read.");
      } catch { setError("The retained shared task action list could not be read."); }
    }).catch(failure => { if (!abort.signal.aborted) setError(errorText(failure)); });
    void read();
    return () => { abort.abort(); if (timer) clearTimeout(timer); refresh.current = async () => {}; };
  }, [ownerKey, foreground, storage, storageKey]);
  const retain = async (next: readonly Action[]) => {
    await storage.setItem(storageKey, JSON.stringify(next));
    if (currentOwner.current === ownerKey && !controller.current?.signal.aborted) { actionsRef.current = next; setActions(next); }
  };
  const run = async (kind: Action["kind"], invoke: (api: TaskSharingApi, operationId: string, signal: AbortSignal) => Promise<void>) => {
    if (!api || !ownerKey || currentOwner.current !== ownerKey || busy || !actionsLoaded || !controller.current || controller.current.signal.aborted) return;
    if (actionsRef.current.length) { setError(t.unknown); return false; }
    const signal = controller.current.signal, operationId = client.newTaskSharingActionId();
    setBusy(true); setError(""); setNotice("");
    try {
      await retain([...actionsRef.current, { operationId, kind }].slice(-64)); signal.throwIfAborted();
      await invoke(api, operationId, signal); signal.throwIfAborted();
      if (currentOwner.current !== ownerKey) return;
      await retain(actionsRef.current.filter(action => action.operationId !== operationId));
      await refresh.current();
      return true;
    } catch (failure) { if (!signal.aborted && currentOwner.current === ownerKey) setError(`${t.unknown} ${errorText(failure)}`); return false; }
    finally { if (!signal.aborted && currentOwner.current === ownerKey) setBusy(false); }
  };
  const confirm = (title: string, callback: () => void) => Alert.alert(title, t.warning, [
    { text: t.cancel, style: "cancel" }, { text: t.confirm, style: "destructive", onPress: callback }
  ]);
  useEffect(() => {
    if (!leaveJoinId || !actionsLoaded || actions.length || !catalog?.joined.some(item => item.joinId === leaveJoinId)) return;
    setTab("joined"); onLeavePromptConsumed?.();
    confirm(t.leave, () => void run("leave", async (service, operationId, signal) => {
      const result = await service.leave(operationId, leaveJoinId, signal);
      if (result.operationId !== operationId) throw new Error("The leave receipt belongs to another action.");
    }));
  }, [leaveJoinId, actionsLoaded, actions.length, catalog, ownerKey]);
  const button = (label: string, action: () => void, disabled = busy) => <Pressable accessibilityRole="button" accessibilityState={{ disabled }}
    disabled={disabled} onPress={action} style={{ paddingVertical: 12, paddingHorizontal: 8, opacity: disabled ? 0.5 : 1 }}>
    <Text style={{ color: colors.accent }}>{label}</Text></Pressable>;
  const lookup = async (action: Action) => {
    if (!api || currentOwner.current !== ownerKey || !controller.current || busy) return;
    const signal = controller.current.signal; setBusy(true); setError("");
    try {
      if (action.kind === "join") {
        const response = await api.lookupJoin(action.operationId, signal);
        if (response.intent?.operationId !== action.operationId) throw new Error("The join receipt belongs to another action.");
        if (response.intent.status === "joined" || response.intent.status === "failed") {
          await retain(actionsRef.current.filter(item => item.operationId !== action.operationId));
          setNotice(response.intent.status === "joined" ? t.joinedOk : t.failed);
        } else setError(t.unknown);
      } else {
        const receipt = await api.lookupAction(action.operationId, signal);
        if (receipt.status === "applied" || receipt.status === "failed") {
          await retain(actionsRef.current.filter(item => item.operationId !== action.operationId));
          setNotice(action.kind === "invite" && receipt.status === "applied" ? t.generated : receipt.status === "failed" ? t.failed : t.active);
        } else setError(t.unknown);
      }
      await refresh.current();
    } catch (failure) { if (!signal.aborted) setError(errorText(failure)); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const openJoined = async (joined: JoinedTaskShare) => {
    if (currentOwner.current !== ownerKey || controller.current?.signal.aborted) return;
    setBusy(true); setError("");
    try { await client.openJoinedTask(joined); if (currentOwner.current === ownerKey) onOpenTask(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };
  const inputStyle = { color: colors.ink, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 12 };
  return <ScrollView contentContainerStyle={{ padding: 16, gap: 12, backgroundColor: colors.background }} keyboardShouldPersistTaps="handled">
    {button(t.back, onBack, false)}<Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 24 }}>{t.title}</Text>
    {!api ? <Text style={{ color: colors.muted }}>{t.connect}</Text> : <>
      <View style={{ flexDirection: "row" }}>{button(`${tab === "owned" ? "✓ " : ""}${t.owned}`, () => setTab("owned"), false)}
        {button(`${tab === "joined" ? "✓ " : ""}${t.joined}`, () => setTab("joined"), false)}{button(t.retry, () => void refresh.current())}</View>
      {tab === "owned" ? <>
        <Text style={{ color: colors.muted }}>{t.choose}</Text>
        {(state.owner?.sessions ?? []).filter(session => !session.archived).map(session => <View key={session.sessionId}>
          {button(`${selectedId === session.sessionId ? "✓ " : ""}${session.displayName || session.sessionId}`, () => setSelectedId(session.sessionId))}</View>)}
        {button(t.share, () => confirm(t.share, () => void run("create", async (service, operationId, signal) => {
          const result = await service.create(operationId, selectedId!, signal);
          if (result.operationId !== operationId) throw new Error("The sharing receipt belongs to another action.");
        })), busy || !selectedId)}
        {(catalog?.owned ?? []).map(share => <View key={share.shareId} style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 12 }}>
          <Text style={{ color: colors.ink }}>{share.title || share.sessionId} · {share.status === "active" ? t.active : t.ended}</Text>
          {button(t.open, () => void client.select(share.sessionId).then(onOpenTask).catch(failure => setError(errorText(failure))))}
          {share.status === "active" && <>
            {button(t.invite, () => void run("invite", async (service, operationId, signal) => {
              const result = await service.invite(operationId, share.shareId, signal);
              if (result.operationId !== operationId || result.share?.shareId !== share.shareId || !result.invitation) throw new Error("The invitation receipt is incomplete.");
              parseTaskShareInvitation(result.invitation); signal.throwIfAborted(); await Clipboard.setStringAsync(result.invitation); signal.throwIfAborted(); setNotice(t.copied);
            }))}
            <Text style={{ color: colors.muted }}>{t.members}</Text>
            {share.members.map(member => <View key={`${member.memberId}/${member.memberGeneration}`}>
              <Text style={{ color: colors.ink }}>{member.displayName} · {member.status === "active" ? t.active : t.ended}</Text>
              {member.status === "active" && button(t.remove, () => confirm(t.remove, () => void run("remove", async (service, operationId, signal) => {
                const result = await service.remove(operationId, share.shareId, member.memberId, member.memberGeneration, signal);
                if (result.operationId !== operationId) throw new Error("The participant receipt belongs to another action.");
              })))}
            </View>)}
            {button(t.end, () => confirm(t.end, () => void run("end", async (service, operationId, signal) => {
              const result = await service.end(operationId, share.shareId, signal); if (result.operationId !== operationId) throw new Error("The sharing receipt belongs to another action.");
            })))}
          </>}
        </View>)}
        {button(t.endAll, () => { const ids = (catalog?.owned ?? []).filter(item => item.status === "active").map(item => item.shareId);
          confirm(t.endAll, () => void run("endAll", async (service, operationId, signal) => {
            const result = await service.endAll(operationId, ids, signal); if (result.operationId !== operationId) throw new Error("The sharing receipt belongs to another action.");
            if (result.failedShareIds.length) setError(`${t.failed}: ${result.failedShareIds.length}`);
          })); }, busy || !(catalog?.owned.some(item => item.status === "active")))}
      </> : <>
        {(catalog?.joined ?? []).map(joined => <View key={joined.joinId} style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 12 }}>
          <Text style={{ color: colors.ink }}>{joined.share?.title || joined.share?.sessionId} · {joined.status === "active" ? t.active : joined.status === "disconnected" ? t.reconnect : t.ended}</Text>
          {button(joined.status === "active" ? t.open : t.reconnect, () => void openJoined(joined), busy || !["active", "disconnected"].includes(joined.status))}
          {button(t.leave, () => confirm(t.leave, () => void run("leave", async (service, operationId, signal) => {
            const result = await service.leave(operationId, joined.joinId, signal); if (result.operationId !== operationId) throw new Error("The leave receipt belongs to another action.");
          })), busy || joined.status === "left")}
        </View>)}
      </>}
      {catalog && !(tab === "owned" ? catalog.owned : catalog.joined).length && <Text style={{ color: colors.muted }}>{t.empty}</Text>}
      <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 20 }}>{t.join}</Text>
      <TextInput accessibilityLabel={t.invitation} value={invitation} onChangeText={value => { setInvitation(value); setPreview(undefined); }}
        maxLength={8192} autoCapitalize="none" autoCorrect={false} style={inputStyle} editable={!busy} />
      {button(t.paste, () => void Clipboard.getStringAsync().then(value => { parseTaskShareInvitation(value); setInvitation(value); setPreview(undefined); }).catch(failure => setError(errorText(failure))))}
      <TextInput accessibilityLabel={t.name} placeholder={t.name} value={displayName} onChangeText={setDisplayName} maxLength={120} style={inputStyle} editable={!busy} />
      {button(t.preview, () => { if (!api || !controller.current) return; setBusy(true); setError("");
        void api.preview(invitation, controller.current.signal).then(result => setPreview(result.share)).catch(failure => setError(errorText(failure))).finally(() => setBusy(false));
      }, busy || !invitation)}
      {preview && <><Text style={{ color: colors.ink }}>{preview.title || preview.sessionId} · {preview.hostOrigin}</Text><Text style={{ color: colors.muted }}>{t.warning}</Text>
        {button(t.join, () => { let accepted: JoinedTaskShare | undefined;
          void run("join", async (service, operationId, signal) => {
          const result = await service.join(operationId, invitation, displayName.trim(), signal);
          if (result.intent?.operationId !== operationId) throw new Error("The join receipt belongs to another action.");
          if (result.intent.status !== "joined" || !result.intent.joined) throw new Error(t.unknown);
          accepted = result.intent.joined; setInvitation(""); setPreview(undefined); setTab("joined");
        }).then(confirmed => { if (confirmed && accepted) void openJoined(accepted); });
        }, busy || !displayName.trim())}</>}
      {!!actions.length && <Text style={{ color: colors.ink }}>{t.pending}</Text>}
      {actions.map(action => <View key={action.operationId}><Text selectable style={{ color: colors.muted }}>{action.operationId}</Text>{button(t.check, () => void lookup(action))}</View>)}
    </>}
    {busy && <Text style={{ color: colors.muted }}>{t.creating}</Text>}
    {!!notice && <Text accessibilityLiveRegion="polite" style={{ color: colors.ink }}>{notice}</Text>}
    {!!error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{error}</Text>}
  </ScrollView>;
}

export function MobileSharedTaskEntries({ client, colors, locale, foreground, onOpen }: {
  readonly client: MobileClient; readonly colors: MobileSettingsColors; readonly locale: MobileSupportedLocale;
  readonly foreground: boolean; readonly onOpen: () => void;
}) {
  const [joined, setJoined] = useState<readonly JoinedTaskShare[]>([]), [error, setError] = useState("");
  const owner = client.taskSharingOwnerKey(), t = mobileTaskSharingCopy(locale);
  const currentOwner = useRef(owner); currentOwner.current = owner;
  useEffect(() => {
    const api = client.taskSharingApi(), abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    setJoined([]); setError("");
    if (!api || !foreground) return () => abort.abort();
    const read = async () => {
      try { const result = await api.list(AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]));
        if (!abort.signal.aborted) { setJoined(result.joined.filter(item => ["active", "disconnected"].includes(item.status))); setError(""); }
      } catch (failure) { if (!abort.signal.aborted) setError(errorText(failure)); }
      if (!abort.signal.aborted) timer = setTimeout(() => void read(), 5_000);
    };
    void read(); return () => { abort.abort(); if (timer) clearTimeout(timer); };
  }, [owner, foreground]);
  if (!joined.length && !error) return null;
  return <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
    <Text style={{ color: colors.muted }}>{t.joined}</Text>
    {joined.map(item => <Pressable key={item.joinId} accessibilityRole="button" onPress={() => {
      if (currentOwner.current !== owner) return;
      void client.openJoinedTask(item).then(onOpen).catch(failure => setError(errorText(failure)));
    }} style={{ paddingVertical: 10 }}><Text style={{ color: colors.accent }}>{item.share?.title || item.share?.sessionId}</Text></Pressable>)}
    {!!error && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{error}</Text>}
  </View>;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : "The shared task request failed."; }

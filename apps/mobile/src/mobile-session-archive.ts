import { Alert } from "react-native";
import type { MobileClient } from "./mobile-client";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

const copy = {
  en: { warning: "Active automations bound to this task: {count}. They stay enabled and may run again after archiving.", dirty: "The workspace has uncommitted changes. Its exact state will be preserved for restoration." },
  "zh-CN": { warning: "此任务仍有 {count} 个启用的绑定自动化。归档后它们仍可能继续执行。", dirty: "工作区有未提交的改动，将保留原状态供恢复。" },
  "zh-TW": { warning: "此任務仍有 {count} 個啟用的綁定自動化。封存後它們仍可能繼續執行。", dirty: "工作區有未提交的變更，將保留原狀態供還原。" },
  ja: { warning: "このタスクに紐づく有効な自動化: {count}。アーカイブ後も実行される可能性があります。", dirty: "ワークスペースに未コミットの変更があります。復元用に現在の状態を保存します。" },
  ko: { warning: "이 작업에 연결된 활성 자동화: {count}. 보관 후에도 실행될 수 있습니다.", dirty: "작업 공간에 커밋하지 않은 변경 사항이 있습니다. 복원할 수 있도록 현재 상태를 보존합니다." }
};

/** Both task-list and header actions use the original preview and mutation owner. */
export async function archiveMobileSession(client: MobileClient, sessionId: string, locale: MobileSupportedLocale,
  isCurrent: () => boolean = () => true): Promise<boolean> {
  const request = await client.prepareSessionArchive(sessionId);
  if (!isCurrent()) return false;
  const { preview } = request;
  if (preview.dirty || preview.activeBoundScheduleCount > 0) {
    const text = copy[locale];
    const body = [preview.dirty ? text.dirty : "", preview.activeBoundScheduleCount > 0
      ? text.warning.replace("{count}", String(preview.activeBoundScheduleCount)) : "", ...preview.activeBoundScheduleNames].filter(Boolean).join("\n\n");
    const confirmed = await new Promise<boolean>((resolve) => Alert.alert(mobileMessage(locale, "common.archive"), body, [
      { text: mobileMessage(locale, "common.cancel"), style: "cancel", onPress: () => resolve(false) },
      { text: mobileMessage(locale, "common.archive"), onPress: () => resolve(true) }
    ], { cancelable: true, onDismiss: () => resolve(false) }));
    if (!confirmed || !isCurrent()) return false;
  }
  return request.archive();
}

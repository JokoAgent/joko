import type { MobileSupportedLocale } from "./mobile-locale-preference";

const rows = [
  ["title", "Plan {completed}/{total}", "计划 {completed}/{total}", "計畫 {completed}/{total}", "計画 {completed}/{total}", "계획 {completed}/{total}"],
  ["expand", "Expand plan", "展开计划", "展開計畫", "計画を展開", "계획 펼치기"],
  ["collapse", "Collapse plan", "收起计划", "收合計畫", "計画を折りたたむ", "계획 접기"],
  ["pending", "Pending", "待处理", "待處理", "未着手", "대기 중"],
  ["inProgress", "In progress", "进行中", "進行中", "進行中", "진행 중"],
  ["completed", "Completed", "已完成", "已完成", "完了", "완료"],
  ["sealed", "This plan's turn completed.", "此计划所属回合已完成。", "此計畫所屬回合已完成。", "この計画のターンは完了しました。", "이 계획의 턴이 완료되었습니다."],
  ["aborted", "This plan's turn stopped.", "此计划所属回合已停止。", "此計畫所屬回合已停止。", "この計画のターンは停止しました。", "이 계획의 턴이 중지되었습니다."],
  ["failed", "This plan's turn failed.", "此计划所属回合失败。", "此計畫所屬回合失敗。", "この計画のターンは失敗しました。", "이 계획의 턴이 실패했습니다."]
] as const;
export type MobilePlanMessageKey = typeof rows[number][0];
const columns: Readonly<Record<MobileSupportedLocale, number>> = { en: 1, "zh-CN": 2, "zh-TW": 3, ja: 4, ko: 5 };
export function mobilePlanMessage(locale: MobileSupportedLocale, key: MobilePlanMessageKey,
  values: Readonly<Record<string, number>> = {}): string {
  return rows.find((row) => row[0] === key)![columns[locale]]!.replace(/\{([a-z]+)\}/gu,
    (token, name: string) => values[name] === undefined ? token : String(values[name]));
}

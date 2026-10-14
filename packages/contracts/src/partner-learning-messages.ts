import type { PartnerLearningRow } from "./partner-learning-presentation.js";

const messages = {
  en: { memory: "Memory saved: {title}", skillCreated: "Skill created: {title}", skillUpdated: "Skill updated: {title}" },
  "zh-CN": { memory: "已保存记忆：{title}", skillCreated: "已创建技能：{title}", skillUpdated: "已更新技能：{title}" },
  "zh-TW": { memory: "已儲存記憶：{title}", skillCreated: "已建立技能：{title}", skillUpdated: "已更新技能：{title}" },
  ja: { memory: "記憶を保存しました：{title}", skillCreated: "スキルを作成しました：{title}", skillUpdated: "スキルを更新しました：{title}" },
  ko: { memory: "기억 저장: {title}", skillCreated: "스킬 생성: {title}", skillUpdated: "스킬 업데이트: {title}" }
} as const;

export function partnerLearningMessage(locale: string, row: PartnerLearningRow): string {
  const copy = messages[locale as keyof typeof messages] ?? messages.en;
  return copy[row.kind === "memory" ? "memory" : row.action === "created" ? "skillCreated" : "skillUpdated"].replace("{title}", () => row.title);
}

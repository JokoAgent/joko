import type { MobileSupportedLocale } from "./mobile-locale-preference";

const rows = [
  ["generic", "Audio", "音频", "音訊", "音声", "오디오"],
  ["music", "Music", "音乐", "音樂", "音楽", "음악"],
  ["sound_effect", "Sound effect", "音效", "音效", "効果音", "효과음"],
  ["untitled", "Untitled audio", "未命名音频", "未命名音訊", "無題の音声", "제목 없는 오디오"],
  ["untitledEffect", "Untitled sound effect", "未命名音效", "未命名音效", "無題の効果音", "제목 없는 효과음"],
  ["copyDescription", "Copy description", "复制说明", "複製說明", "説明をコピー", "설명 복사"],
  ["copying", "Copying description…", "正在复制说明…", "正在複製說明…", "説明をコピー中…", "설명 복사 중…"],
  ["copied", "Description copied", "已复制说明", "已複製說明", "説明をコピーしました", "설명을 복사했습니다"],
  ["copyFailed", "Could not copy description", "无法复制说明", "無法複製說明", "説明をコピーできませんでした", "설명을 복사할 수 없습니다"],
  ["duration", "Duration {duration}", "时长 {duration}", "長度 {duration}", "長さ {duration}", "길이 {duration}"],
  ["artworkMissing", "No cover artwork", "无封面", "無封面", "カバー画像なし", "커버 이미지 없음"],
  ["artworkLoading", "Loading cover artwork", "正在加载封面", "正在載入封面", "カバー画像を読み込み中", "커버 이미지 로딩 중"],
  ["artworkFailed", "Cover artwork unavailable", "封面不可用", "封面無法使用", "カバー画像を表示できません", "커버 이미지를 사용할 수 없습니다"],
  ["artwork", "Cover artwork", "封面", "封面", "カバー画像", "커버 이미지"]
] as const;
export type MobileAudioMetadataMessageKey = typeof rows[number][0];
const columns: Readonly<Record<MobileSupportedLocale, number>> = { en: 1, "zh-CN": 2, "zh-TW": 3, ja: 4, ko: 5 };

export function mobileAudioMetadataMessage(locale: MobileSupportedLocale, key: MobileAudioMetadataMessageKey,
  values: Readonly<Record<string, string>> = {}): string {
  return rows.find((row) => row[0] === key)![columns[locale]]!.replace(/\{([a-z]+)\}/gu,
    (token, name: string) => values[name] ?? token);
}

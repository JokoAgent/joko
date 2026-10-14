import type { MobileSupportedLocale } from "./mobile-locale-preference";

const messages = {
  en: { title: "Account limits", reading: "Reading account limits…", unavailable: "Account limits unavailable", stale: "Last known account limits",
    primary: "Primary window", secondary: "Secondary window", minutes: "{minutes} min window", remaining: "{percent}% remaining", reset: "Resets {time}",
    observed: "Observed {time}", freshness: "Observation time unavailable", plan: "Plan {plan}", exhausted: "Account limit reached",
    extra: "Extra usage", enabled: "Enabled", disabled: "Disabled", reportedCredits: "Reported credits {used} / {limit}", credits: "Credits",
    unlimited: "Unlimited", available: "Available", none: "No available credits", resetCredits: "Reset credits: {count}", expiry: "Earliest expiry {time}" },
  "zh-CN": { title: "账户额度", reading: "正在读取账户额度…", unavailable: "账户额度暂不可用", stale: "最近已知账户额度",
    primary: "主窗口", secondary: "次窗口", minutes: "{minutes} 分钟窗口", remaining: "剩余 {percent}%", reset: "{time}重置",
    observed: "观测于{time}", freshness: "观测时间不可用", plan: "套餐 {plan}", exhausted: "账户额度已用尽",
    extra: "额外用量", enabled: "已启用", disabled: "未启用", reportedCredits: "已报告额度 {used} / {limit}", credits: "额度",
    unlimited: "无限", available: "可用", none: "没有可用额度", resetCredits: "重置额度：{count}", expiry: "最早于{time}到期" },
  ja: { title: "アカウント上限", reading: "アカウント上限を取得中…", unavailable: "アカウント上限を取得できません", stale: "最後に確認したアカウント上限",
    primary: "主ウィンドウ", secondary: "副ウィンドウ", minutes: "{minutes} 分のウィンドウ", remaining: "残り {percent}%", reset: "{time}にリセット",
    observed: "確認日時 {time}", freshness: "確認日時不明", plan: "プラン {plan}", exhausted: "アカウント上限に達しました",
    extra: "追加使用量", enabled: "有効", disabled: "無効", reportedCredits: "報告されたクレジット {used} / {limit}", credits: "クレジット",
    unlimited: "無制限", available: "利用可能", none: "利用可能なクレジットなし", resetCredits: "リセットクレジット：{count}", expiry: "最短有効期限 {time}" },
  ko: { title: "계정 한도", reading: "계정 한도를 읽는 중…", unavailable: "계정 한도를 확인할 수 없음", stale: "마지막으로 확인한 계정 한도",
    primary: "기본 구간", secondary: "보조 구간", minutes: "{minutes}분 구간", remaining: "{percent}% 남음", reset: "{time}에 초기화",
    observed: "관측 시간 {time}", freshness: "관측 시간 없음", plan: "요금제 {plan}", exhausted: "계정 한도에 도달함",
    extra: "추가 사용량", enabled: "사용", disabled: "사용 안 함", reportedCredits: "보고된 크레딧 {used} / {limit}", credits: "크레딧",
    unlimited: "무제한", available: "사용 가능", none: "사용 가능한 크레딧 없음", resetCredits: "초기화 크레딧: {count}", expiry: "가장 빠른 만료 {time}" },
  "zh-TW": { title: "帳戶額度", reading: "正在讀取帳戶額度…", unavailable: "帳戶額度暫不可用", stale: "最近已知帳戶額度",
    primary: "主視窗", secondary: "次視窗", minutes: "{minutes} 分鐘視窗", remaining: "剩餘 {percent}%", reset: "{time}重置",
    observed: "觀測於{time}", freshness: "觀測時間不可用", plan: "方案 {plan}", exhausted: "帳戶額度已用盡",
    extra: "額外用量", enabled: "已啟用", disabled: "未啟用", reportedCredits: "已報告額度 {used} / {limit}", credits: "額度",
    unlimited: "無限", available: "可用", none: "沒有可用額度", resetCredits: "重置額度：{count}", expiry: "最早於{time}到期" }
} as const;

export function mobileAccountUsageCopy(locale: MobileSupportedLocale) { return messages[locale]; }

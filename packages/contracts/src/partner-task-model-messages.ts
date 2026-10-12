const en = { title: "Task model", inherit: "Use primary model", inheriting: "Following the current primary model", choose: "Choose task model",
  effort: "Task model effort", fast: "Task model Fast mode", unavailable: "Unavailable", help: "Applies to new independent tasks. Existing tasks keep their model." };
type Messages = Readonly<typeof en>;
const messages: Readonly<Record<string, Messages>> = {
  en,
  "zh-CN": { title: "任务模型", inherit: "使用主模型", inheriting: "跟随当前主模型", choose: "选择任务模型", effort: "任务模型思考强度", fast: "任务模型快速模式", unavailable: "不可用", help: "用于新建独立任务。已有任务保留原模型。" },
  "zh-TW": { title: "任務模型", inherit: "使用主模型", inheriting: "跟隨目前主模型", choose: "選擇任務模型", effort: "任務模型思考強度", fast: "任務模型快速模式", unavailable: "無法使用", help: "用於新建獨立任務。現有任務保留原模型。" },
  ja: { title: "タスクモデル", inherit: "メインモデルを使用", inheriting: "現在のメインモデルを使用", choose: "タスクモデルを選択", effort: "タスクモデルの推論強度", fast: "タスクモデルの高速モード", unavailable: "利用不可", help: "新しい独立タスクに適用されます。既存タスクのモデルは変わりません。" },
  ko: { title: "작업 모델", inherit: "주 모델 사용", inheriting: "현재 주 모델 사용 중", choose: "작업 모델 선택", effort: "작업 모델 추론 강도", fast: "작업 모델 빠른 모드", unavailable: "사용 불가", help: "새 독립 작업에 적용됩니다. 기존 작업의 모델은 유지됩니다." }
};
export function partnerTaskModelMessages(locale: string): Messages { return messages[locale] ?? en; }

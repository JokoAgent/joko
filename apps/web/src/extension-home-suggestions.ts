import type { ExtensionCatalogEntryView } from "./model.js";
import {
  HOME_SUGGESTION_BATCH_SIZE,
  HOME_SUGGESTION_CATALOG,
  type HomeSuggestionCandidate,
  type HomeSuggestionId,
  type HomeSuggestionVisibleCount,
  homeSuggestionLabelKey,
  homeSuggestionPromptKey,
  randomCategoryOrder,
  selectHomeSuggestionBatch,
  shuffled
} from "./home-suggestions.js";

export interface ExtensionRecommendationDescriptorView {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
  readonly command?: string;
  readonly locales?: Partial<Record<"en" | "zh-CN", {
    readonly label: string;
    readonly prompt: string;
  }>>;
}

export type ExtensionCatalogEntryWithRecommendations = ExtensionCatalogEntryView & {
  readonly recommendations?: readonly ExtensionRecommendationDescriptorView[];
};

export interface HomeTaskSuggestion extends HomeSuggestionCandidate {
  readonly label: string;
  readonly prompt: string;
  readonly builtinId?: HomeSuggestionId;
  readonly extensionId?: string;
  readonly recommendationId?: string;
  readonly extensionRevision?: bigint;
  readonly owner?: ExtensionCatalogEntryView["owner"];
  readonly command?: string;
  readonly needsInstall?: boolean;
  readonly guide?: "install" | "enable" | "setup";
}

export interface HomeTaskHints {
  readonly newlyInstalledId?: string | null;
  readonly recentIds?: readonly string[];
}

export interface HomeTaskBatch {
  readonly items: readonly HomeTaskSuggestion[];
  readonly seenIds: readonly string[];
  /** Largest number of prepared rows that has actually been displayed. */
  readonly displayedCount: HomeSuggestionVisibleCount;
}

type HomeSuggestionTranslationKey =
  | ReturnType<typeof homeSuggestionLabelKey>
  | ReturnType<typeof homeSuggestionPromptKey>;

/** The host owns quota categories; Extension authors cannot manufacture them. */
export function extensionSuggestionCategory(item: ExtensionRecommendationDescriptorView): string {
  const localized = Object.values(item.locales ?? {}).flatMap((entry) => entry === undefined
    ? []
    : [entry.label, entry.prompt]);
  const text = [item.label, item.prompt, ...localized].join(" ").toLocaleLowerCase("en-US");
  const rules: readonly [RegExp, string][] = [
    [/email|e-mail|inbox|mail\b|邮件|郵件|メール|메일/u, "email"],
    [/photo|album|image|照片|相册|相冊|画像|写真|사진|앨범/u, "photos"],
    [/calendar|meeting|schedule|日历|日曆|会议|會議|会議|일정|캘린더/u, "calendar"],
    [/daily|every day|monitor|每天|每日|盯|監視|모니터|매일/u, "automation"],
    [/code|repo|pull request|bug|\bgit\b|commit|代码|代碼|项目|專案|审查.*改动|審查.*改動|未提交|コード|コミット|코드|커밋/u, "development"],
    [/document|spreadsheet|file|整理|文档|文件|文書|문서|파일/u, "documents"],
    [/game|build|create|游戏|遊戲|制作|製作|ゲーム|게임/u, "create"],
    [/computer|disk|network|电脑|電腦|网速|網速|パソコン|컴퓨터/u, "computer"]
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] ?? "extensionTasks";
}

export function buildHomeTaskCatalog(
  entries: readonly ExtensionCatalogEntryWithRecommendations[],
  locale: string,
  t: (key: HomeSuggestionTranslationKey) => string
): HomeTaskSuggestion[] {
  const catalog: HomeTaskSuggestion[] = HOME_SUGGESTION_CATALOG.map(({ id, category }) => ({
    id,
    category,
    builtinId: id,
    label: t(homeSuggestionLabelKey(id)),
    prompt: t(homeSuggestionPromptKey(id))
  }));
  for (const extension of entries) {
    const guide = extensionGuide(extension);
    for (const recommendation of extension.recommendations ?? []) {
      const localized = localizeExtensionRecommendation(recommendation, locale);
      catalog.push({
        id: `extension:${extension.id}:${recommendation.id}`,
        category: extensionSuggestionCategory(recommendation),
        extensionId: extension.id,
        recommendationId: recommendation.id,
        extensionRevision: extension.revision,
        owner: extension.owner,
        ...(recommendation.command === undefined ? {} : { command: recommendation.command }),
        label: localized.label,
        prompt: localized.prompt,
        ...(guide === undefined ? {} : { guide }),
        ...(guide === "install" ? { needsInstall: true } : {})
      });
    }
  }
  return catalog;
}

/**
 * Draws one Extension ticket per Extension before ranking. This prevents an
 * author from gaining more home-page weight by publishing more tasks.
 */
export function nextHomeTaskBatch(
  catalog: readonly HomeTaskSuggestion[],
  hints: HomeTaskHints = {},
  previous: HomeTaskBatch | null = null,
  visibleCount: HomeSuggestionVisibleCount = HOME_SUGGESTION_BATCH_SIZE,
  random: () => number = Math.random
): HomeTaskBatch {
  const previousIds = new Set(previous?.items.slice(0, previous.displayedCount).map(({ id }) => id));
  const currentIds = new Set(catalog.map(({ id }) => id));
  const seen = new Set(
    [...(previous?.seenIds ?? []), ...previousIds].filter((id) => currentIds.has(id))
  );
  if (catalog.length > 0 && seen.size === catalog.length) seen.clear();

  const extensionGroups = new Map<string, HomeTaskSuggestion[]>();
  const candidates = catalog.filter((item) => {
    if (item.extensionId === undefined) return true;
    const group = extensionGroups.get(item.extensionId) ?? [];
    group.push(item);
    extensionGroups.set(item.extensionId, group);
    return false;
  });
  for (const group of extensionGroups.values()) {
    const fresh = group.filter(({ id }) => !seen.has(id) && !previousIds.has(id));
    const alternatives = group.filter(({ id }) => !previousIds.has(id));
    candidates.push(shuffled(fresh.length > 0 ? fresh : alternatives.length > 0 ? alternatives : group, random)[0]!);
  }

  const available = candidates.filter(({ id }) => !previousIds.has(id));
  const ranked = [
    ...randomCategoryOrder(available.filter(({ id }) => !seen.has(id)), random),
    ...randomCategoryOrder(available.filter(({ id }) => seen.has(id)), random)
  ];
  const pinned = typeof hints.newlyInstalledId === "string"
    ? candidates.find(({ extensionId, needsInstall }) =>
        extensionId === hints.newlyInstalledId && needsInstall !== true)
    : undefined;
  const recentIds = new Set((hints.recentIds ?? []).slice(0, 5));
  const recent = ranked.filter(({ extensionId }) => extensionId !== undefined && recentIds.has(extensionId));
  if (recent.length > 0 && random() < 0.35) ranked.unshift(shuffled(recent, random)[0]!);

  let items = selectHomeSuggestionBatch(ranked, {
    ...(pinned === undefined ? {} : { pinnedId: pinned.id }),
    fallback: randomCategoryOrder(candidates.filter(({ id }) => previousIds.has(id)), random)
  });
  if (items.length > 1 && items.every(({ extensionId }) => extensionId !== undefined)) {
    const fallback = ranked.find((candidate) =>
      candidate.builtinId !== undefined
      && !items.some(({ category }) => category === candidate.category));
    if (fallback !== undefined) items = [...items.slice(0, -1), fallback];
  }
  if (items.slice(0, 2).length === 2 && items.slice(0, 2).every(({ extensionId }) => extensionId !== undefined)) {
    const builtinIndex = items.findIndex(({ builtinId }) => builtinId !== undefined);
    if (builtinIndex > 1) {
      const mutable = [...items];
      [mutable[1], mutable[builtinIndex]] = [mutable[builtinIndex]!, mutable[1]!];
      items = mutable;
    }
  }
  return { items, seenIds: [...seen], displayedCount: visibleCount };
}

export function markHomeTaskBatchDisplayed(
  state: HomeTaskBatch,
  visibleCount: HomeSuggestionVisibleCount
): HomeTaskBatch {
  return visibleCount <= state.displayedCount ? state : { ...state, displayedCount: visibleCount };
}

export function visibleHomeTaskSuggestions(
  state: HomeTaskBatch,
  visibleCount: HomeSuggestionVisibleCount
): readonly HomeTaskSuggestion[] {
  return state.items.slice(0, visibleCount);
}

function localizeExtensionRecommendation(
  item: ExtensionRecommendationDescriptorView,
  locale: string
): { readonly label: string; readonly prompt: string } {
  const translated = item.locales?.[locale as "en" | "zh-CN"] ?? item.locales?.en;
  return translated ?? { label: item.label, prompt: item.prompt };
}

function extensionGuide(
  extension: ExtensionCatalogEntryView
): HomeTaskSuggestion["guide"] {
  if (!extension.installed || extension.owner.kind === "source") return "install";
  if (!extension.enabled) return "enable";
  if (extension.setup.state !== "ready" && extension.setup.state !== "notRequired") return "setup";
  return undefined;
}

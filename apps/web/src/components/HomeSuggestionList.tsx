import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  BookOpen,
  CalendarCheck,
  Code2,
  Eye,
  EyeOff,
  FileText,
  FolderDown,
  FolderGit2,
  Folders,
  Gamepad2,
  Gauge,
  Hammer,
  HardDrive,
  Images,
  MessageSquarePlus,
  Newspaper,
  Puzzle,
  Receipt,
  Shuffle,
  Sparkles,
  TrendingUp,
  Wallet,
  Wifi,
  type LucideIcon
} from "lucide-react";
import {
  HOME_SUGGESTION_BATCH_SIZE,
  HOME_SUGGESTION_NARROW_COUNT,
  type HomeSuggestionId,
  type HomeSuggestionVisibleCount,
  isHomeSuggestionsHidden,
  setHomeSuggestionsHidden
} from "../home-suggestions.js";
import {
  buildHomeTaskCatalog,
  type ExtensionCatalogEntryWithRecommendations,
  type HomeTaskHints,
  type HomeTaskSuggestion,
  markHomeTaskBatchDisplayed,
  nextHomeTaskBatch,
  visibleHomeTaskSuggestions
} from "../extension-home-suggestions.js";
import type { Translator } from "./types.js";

const HOME_SUGGESTION_NARROW_QUERY = "(max-width: 820px)";
const EMPTY_EXTENSION_ENTRIES: readonly ExtensionCatalogEntryWithRecommendations[] = [];
const EMPTY_HINTS: HomeTaskHints = {};

const ICONS: Record<HomeSuggestionId, LucideIcon> = {
  storageUsage: HardDrive,
  whySlow: Gauge,
  downloadsDesktop: FolderDown,
  diagnoseNetwork: Wifi,
  unusedApps: AppWindow,
  stockDigest: TrendingUp,
  morningBrief: Newspaper,
  watchWebpage: Eye,
  expenseTracker: Wallet,
  kidsGame: Gamepad2,
  habitTracker: CalendarCheck,
  recentDocs: FileText,
  subscriptionSpend: Receipt,
  organizeFolder: Folders,
  photoTimeline: Images,
  photoAlbumPage: Images,
  uncommittedChanges: FolderGit2,
  exploreRepo: BookOpen,
  initAgentDoc: FileText,
  listCodeProjects: Code2,
  devEnvironment: Hammer,
  makeExtension: Puzzle,
  sendProductFeedback: MessageSquarePlus,
  exploreProductSource: Code2,
  discoverCapabilities: Sparkles
};

export interface HomeSuggestionListProps {
  readonly t: Translator;
  readonly disabled: boolean;
  readonly onSelect: (id: HomeSuggestionId) => void;
  readonly extensionEntries?: readonly ExtensionCatalogEntryWithRecommendations[];
  readonly locale?: string;
  readonly hints?: HomeTaskHints;
  readonly onExtensionSelect?: (suggestion: HomeTaskSuggestion) => void;
}

/** Task starters remain presentation-only; submission is owned by NewSessionPage. */
export function HomeSuggestionList({
  t,
  disabled,
  onSelect,
  extensionEntries = EMPTY_EXTENSION_ENTRIES,
  locale = "en",
  hints = EMPTY_HINTS,
  onExtensionSelect
}: HomeSuggestionListProps) {
  const titleId = useId();
  const [narrow, setNarrow] = useState(readNarrowViewport);
  const visibleCount: HomeSuggestionVisibleCount = narrow
    ? HOME_SUGGESTION_NARROW_COUNT
    : HOME_SUGGESTION_BATCH_SIZE;
  const catalog = useMemo(
    () => buildHomeTaskCatalog(onExtensionSelect === undefined ? EMPTY_EXTENSION_ENTRIES : extensionEntries, locale, t),
    [extensionEntries, locale, onExtensionSelect, t]
  );
  const catalogIdentity = homeTaskCatalogIdentity(catalog, hints);
  const catalogIdentityRef = useRef(catalogIdentity);
  const [batch, setBatch] = useState(() => nextHomeTaskBatch(catalog, hints, null, visibleCount));
  const [hidden, setHidden] = useState(isHomeSuggestionsHidden);
  const [interactionPending, setInteractionPending] = useState(false);
  const activationPending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (catalogIdentityRef.current === catalogIdentity) return;
    catalogIdentityRef.current = catalogIdentity;
    setBatch((current) => nextHomeTaskBatch(catalog, hints, current, visibleCount));
  }, [catalog, catalogIdentity, hints, visibleCount]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(HOME_SUGGESTION_NARROW_QUERY);
    const apply = (matches: boolean): void => {
      const count = matches ? HOME_SUGGESTION_NARROW_COUNT : HOME_SUGGESTION_BATCH_SIZE;
      setNarrow(matches);
      setBatch((current) => markHomeTaskBatchDisplayed(current, count));
    };
    apply(query.matches);
    const change = (event: MediaQueryListEvent): void => apply(event.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);

  const activateOnce = (action: () => void): void => {
    if (disabled || activationPending.current) return;
    activationPending.current = true;
    setInteractionPending(true);
    try {
      action();
    } finally {
      queueMicrotask(() => {
        activationPending.current = false;
        if (mounted.current) setInteractionPending(false);
      });
    }
  };

  if (hidden) return null;

  const unavailable = disabled || interactionPending;
  const suggestions = visibleHomeTaskSuggestions(batch, visibleCount);

  return <section
    className="home-suggestion-list"
    data-testid="home-suggestions"
    aria-labelledby={titleId}
    aria-busy={interactionPending || undefined}
  >
    <header className="home-suggestion-list__header">
      <h2 id={titleId}>{t("newTask.homeSuggestions.title")}</h2>
      <div className="home-suggestion-list__actions">
        <button
          className="home-suggestion-list__action"
          type="button"
          data-testid="home-suggestions-shuffle"
          disabled={unavailable}
          onClick={() => activateOnce(() => setBatch((current) => nextHomeTaskBatch(catalog, hints, current, visibleCount)))}
        >
          <Shuffle aria-hidden="true" />
          <span>{t("newTask.homeSuggestions.shuffle")}</span>
        </button>
        <button
          className="home-suggestion-list__action"
          type="button"
          data-testid="home-suggestions-dismiss"
          disabled={unavailable}
          onClick={() => activateOnce(() => {
            setHomeSuggestionsHidden(true);
            setHidden(true);
          })}
        >
          <EyeOff aria-hidden="true" />
          <span>{t("newTask.homeSuggestions.dismiss")}</span>
        </button>
      </div>
    </header>
    <ul className="home-suggestion-list__grid">
      {suggestions.map((suggestion) => {
        const Icon = suggestion.builtinId === undefined ? Puzzle : ICONS[suggestion.builtinId];
        return <li key={suggestion.id}>
          <button
            className="home-suggestion-list__suggestion"
            type="button"
            data-testid={`home-suggestion-${suggestion.id}`}
            data-home-suggestion-id={suggestion.id}
            {...(suggestion.extensionId === undefined ? {} : { "data-home-extension-id": suggestion.extensionId })}
            disabled={unavailable}
            onClick={() => activateOnce(() => {
              if (suggestion.builtinId !== undefined) onSelect(suggestion.builtinId);
              else onExtensionSelect?.(suggestion);
            })}
          >
            <span className="home-suggestion-list__icon"><Icon aria-hidden="true" /></span>
            <span>{suggestion.label}</span>
          </button>
        </li>;
      })}
    </ul>
  </section>;
}

function homeTaskCatalogIdentity(catalog: readonly HomeTaskSuggestion[], hints: HomeTaskHints): string {
  return JSON.stringify({
    newlyInstalledId: hints.newlyInstalledId ?? null,
    recentIds: (hints.recentIds ?? []).slice(0, 5),
    items: catalog.map((item) => ({
      id: item.id,
      category: item.category,
      label: item.label,
      prompt: item.prompt,
      extensionRevision: item.extensionRevision?.toString(10),
      command: item.command,
      guide: item.guide,
      owner: item.owner === undefined
        ? undefined
        : item.owner.kind === "resource"
          ? [item.owner.kind, item.owner.resourceId, item.owner.discoveredRevision, item.owner.resourceRevision.toString(10)]
          : item.owner.kind === "mcp"
            ? [item.owner.kind, item.owner.serverId, item.owner.serverRevision.toString(10)]
            : [item.owner.kind, item.owner.sourceId, item.owner.sourceRevision.toString(10), item.owner.entryId, item.owner.contentRevision]
    }))
  });
}

function readNarrowViewport(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(HOME_SUGGESTION_NARROW_QUERY).matches;
}

import { useEffect, useId, useRef, useState } from "react";
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
  homeSuggestionLabelKey,
  isHomeSuggestionsHidden,
  markHomeSuggestionBatchDisplayed,
  nextHomeSuggestionBatch,
  setHomeSuggestionsHidden,
  visibleHomeSuggestionIds
} from "../home-suggestions.js";
import type { Translator } from "./types.js";

const HOME_SUGGESTION_NARROW_QUERY = "(max-width: 820px)";

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
}

/** Built-in task starters; prompt submission remains owned by NewSessionPage. */
export function HomeSuggestionList({ t, disabled, onSelect }: HomeSuggestionListProps) {
  const titleId = useId();
  const [narrow, setNarrow] = useState(readNarrowViewport);
  const visibleCount: HomeSuggestionVisibleCount = narrow
    ? HOME_SUGGESTION_NARROW_COUNT
    : HOME_SUGGESTION_BATCH_SIZE;
  const [batch, setBatch] = useState(() => nextHomeSuggestionBatch(null, visibleCount));
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
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(HOME_SUGGESTION_NARROW_QUERY);
    const apply = (matches: boolean): void => {
      const count = matches ? HOME_SUGGESTION_NARROW_COUNT : HOME_SUGGESTION_BATCH_SIZE;
      setNarrow(matches);
      setBatch((current) => markHomeSuggestionBatchDisplayed(current, count));
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
  const ids = visibleHomeSuggestionIds(batch, visibleCount);

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
          onClick={() => activateOnce(() => setBatch((current) => nextHomeSuggestionBatch(current, visibleCount)))}
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
      {ids.map((id) => {
        const Icon = ICONS[id];
        return <li key={id}>
          <button
            className="home-suggestion-list__suggestion"
            type="button"
            data-testid={`home-suggestion-${id}`}
            data-home-suggestion-id={id}
            disabled={unavailable}
            onClick={() => activateOnce(() => onSelect(id))}
          >
            <span className="home-suggestion-list__icon"><Icon aria-hidden="true" /></span>
            <span>{t(homeSuggestionLabelKey(id))}</span>
          </button>
        </li>;
      })}
    </ul>
  </section>;
}

function readNarrowViewport(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(HOME_SUGGESTION_NARROW_QUERY).matches;
}

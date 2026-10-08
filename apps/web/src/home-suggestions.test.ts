import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HOME_SUGGESTION_BATCH_SIZE,
  HOME_SUGGESTION_CATALOG,
  HOME_SUGGESTION_IDS,
  HOME_SUGGESTION_NARROW_COUNT,
  homeSuggestionLabelKey,
  homeSuggestionPromptKey,
  isHomeSuggestionsHidden,
  markHomeSuggestionBatchDisplayed,
  nextHomeSuggestionBatch,
  selectHomeSuggestionBatch,
  setHomeSuggestionsHidden,
  visibleHomeSuggestionIds
} from "./home-suggestions.js";

describe("home suggestions", () => {
  const memory = new Map<string, string>();

  beforeEach(() => {
    memory.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value); },
      removeItem: (key: string) => { memory.delete(key); }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("provides 25 reviewed topics across eight broad categories", () => {
    expect(HOME_SUGGESTION_IDS).toHaveLength(25);
    expect(new Set(HOME_SUGGESTION_IDS).size).toBe(25);
    expect(new Set(HOME_SUGGESTION_CATALOG.map(({ category }) => category)).size).toBe(8);
    expect(HOME_SUGGESTION_NARROW_COUNT).toBe(2);
    expect(HOME_SUGGESTION_BATCH_SIZE).toBe(4);
  });

  it.each([HOME_SUGGESTION_NARROW_COUNT, HOME_SUGGESTION_BATCH_SIZE] as const)(
    "draws %i distinct visible categories without adjacent repeats or hidden-topic starvation",
    (size) => {
      for (const seed of [0, 1, 42, 2026]) {
        let value = seed;
        const random = (): number => {
          value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
          return value / 2 ** 32;
        };
        let state = nextHomeSuggestionBatch(null, size, random);
        const seen = new Set<string>();
        for (let index = 0; index < HOME_SUGGESTION_IDS.length; index += 1) {
          const visible = visibleHomeSuggestionIds(state, size);
          expect(visible).toHaveLength(size);
          const categories = visible.map(
            (id) => HOME_SUGGESTION_CATALOG.find((entry) => entry.id === id)!.category
          );
          expect(new Set(categories).size).toBe(size);
          visible.forEach((id) => seen.add(id));
          const next = nextHomeSuggestionBatch(state, size, random);
          expect(next.ids.some((id) => visible.includes(id))).toBe(false);
          state = next;
        }
        expect(seen).toEqual(new Set(HOME_SUGGESTION_IDS));
      }
    }
  );

  it("uses the injected random source for fresh openings", () => {
    const first = nextHomeSuggestionBatch(null, 4, () => 0);
    const another = nextHomeSuggestionBatch(null, 4, () => 0.999);
    expect(first.ids).not.toEqual(another.ids);
    expect(first.seenIds).toEqual([]);
  });

  it("counts only visible topics as seen for a narrow batch", () => {
    const previous = nextHomeSuggestionBatch(null, 2, () => 0);
    expect(previous.ids).toHaveLength(4);
    const next = nextHomeSuggestionBatch(previous, 2, () => 0.999);
    expect(next.seenIds).toEqual(previous.ids.slice(0, 2));
  });

  it("keeps a prepared batch stable while widening and shrinking", () => {
    const narrow = nextHomeSuggestionBatch(null, 2, () => 0);
    const widened = markHomeSuggestionBatchDisplayed(narrow, 4);
    const shrunk = markHomeSuggestionBatchDisplayed(widened, 2);

    expect(widened.ids).toBe(narrow.ids);
    expect(widened.displayedCount).toBe(4);
    expect(visibleHomeSuggestionIds(widened, 4)).toEqual(narrow.ids);
    expect(shrunk).toBe(widened);

    const next = nextHomeSuggestionBatch(shrunk, 2, () => 0.5);
    expect(next.seenIds).toEqual(narrow.ids);
    expect(next.ids.some((id) => narrow.ids.includes(id))).toBe(false);
  });

  it("remembers all four topics when a wide batch is followed by a narrow draw", () => {
    const previous = nextHomeSuggestionBatch(null, 4, () => 0);
    const next = nextHomeSuggestionBatch(previous, 2, () => 0);
    expect(next.seenIds).toEqual(previous.ids);
    expect(next.ids.some((id) => previous.ids.includes(id))).toBe(false);
    expect(next.displayedCount).toBe(2);
  });

  it("prioritizes the final unseen topic and resets history after all topics were shown", () => {
    const previous = {
      ids: HOME_SUGGESTION_IDS.slice(0, 4),
      seenIds: HOME_SUGGESTION_IDS.filter((id) => id !== "photoAlbumPage"),
      displayedCount: 4 as const
    };
    expect(nextHomeSuggestionBatch(previous, 4, () => 0).ids[0]).toBe("photoAlbumPage");
    const reset = nextHomeSuggestionBatch(
      { ...previous, seenIds: [...HOME_SUGGESTION_IDS] },
      4,
      () => 0
    );
    expect(reset.seenIds).toEqual([]);
    expect(reset.ids.some((id) => previous.ids.includes(id))).toBe(false);
  });

  it("applies category and extension quotas independently", () => {
    const candidates = [
      { id: "mail:inbox", category: "email", extensionId: "mail" },
      { id: "mail:receipts", category: "documents", extensionId: "mail" },
      { id: "other-mail:reply", category: "email", extensionId: "other-mail" },
      { id: "summarize", category: "documents" },
      { id: "cleanup", category: "computer" },
      { id: "build", category: "create" }
    ];
    expect(selectHomeSuggestionBatch(candidates).map(({ id }) => id)).toEqual([
      "mail:inbox",
      "summarize",
      "cleanup",
      "build"
    ]);
  });

  it("allows only one Extension action guide regardless of its step", () => {
    const candidates = [
      { id: "install", category: "email", extensionId: "mail", needsInstall: true, guide: "install" as const },
      { id: "enable", category: "photos", extensionId: "photos", guide: "enable" as const },
      { id: "setup", category: "calendar", extensionId: "calendar", guide: "setup" as const },
      { id: "cleanup", category: "computer" },
      { id: "build", category: "create" },
      { id: "documents", category: "documents" }
    ];
    expect(selectHomeSuggestionBatch(candidates).map(({ id }) => id)).toEqual([
      "install",
      "cleanup",
      "build",
      "documents"
    ]);
  });

  it("does not relax category quotas merely to fill a batch", () => {
    const candidates = HOME_SUGGESTION_CATALOG.filter(({ category }) => category === "computer");
    expect(selectHomeSuggestionBatch(candidates)).toEqual([candidates[0]]);
    expect(selectHomeSuggestionBatch([])).toEqual([]);
  });

  it("builds Joko new-task keys for labels and submitted prompts", () => {
    expect(homeSuggestionLabelKey("whySlow")).toBe("newTask.homeSuggestions.whySlow.label");
    expect(homeSuggestionPromptKey("whySlow")).toBe("newTask.homeSuggestions.whySlow.prompt");
  });

  it("persists dismissal without throwing", () => {
    expect(isHomeSuggestionsHidden()).toBe(false);
    setHomeSuggestionsHidden(true);
    expect(isHomeSuggestionsHidden()).toBe(true);
    setHomeSuggestionsHidden(false);
    expect(isHomeSuggestionsHidden()).toBe(false);
  });

  it("fails closed when local storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); }
    });
    expect(isHomeSuggestionsHidden()).toBe(false);
    expect(() => setHomeSuggestionsHidden(true)).not.toThrow();
    expect(() => setHomeSuggestionsHidden(false)).not.toThrow();
  });
});

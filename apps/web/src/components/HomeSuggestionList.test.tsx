// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOME_SUGGESTIONS_HIDDEN_KEY, type HomeSuggestionId } from "../home-suggestions.js";
import { HomeSuggestionList } from "./HomeSuggestionList.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];
const t: Translator = (key) => key;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("HomeSuggestionList", () => {
  it("renders a stable four-item first batch and exposes native keyboard buttons", async () => {
    installMatchMedia(false);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onSelect = vi.fn<(id: HomeSuggestionId) => void>();
    const { container } = await renderList({ onSelect });

    const suggestions = suggestionButtons(container);
    expect(suggestions).toHaveLength(4);
    expect(new Set(suggestions.map((button) => button.dataset.homeSuggestionId)).size).toBe(4);
    expect(container.querySelector("h2")?.textContent).toBe("newTask.homeSuggestions.title");
    expect(action(container, "home-suggestions-shuffle").textContent).toContain("newTask.homeSuggestions.shuffle");
    expect(action(container, "home-suggestions-dismiss").textContent).toContain("newTask.homeSuggestions.dismiss");
    expect([...container.querySelectorAll("button")].every((button) => button.type === "button")).toBe(true);

    suggestions[0]!.focus();
    expect(document.activeElement).toBe(suggestions[0]);
    await act(async () => suggestions[0]!.click());
    expect(onSelect).toHaveBeenCalledWith(suggestions[0]!.dataset.homeSuggestionId);
  });

  it("uses matchMedia for two narrow items and preserves the prepared batch while resizing", async () => {
    const media = installMatchMedia(false);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { container } = await renderList();
    const wide = suggestionIds(container);
    expect(wide).toHaveLength(4);

    await act(async () => media.set(true));
    expect(suggestionIds(container)).toEqual(wide.slice(0, 2));

    await act(async () => media.set(false));
    expect(suggestionIds(container)).toEqual(wide);
    expect(media.matchMedia).toHaveBeenCalledWith("(max-width: 820px)");
  });

  it("draws a fresh batch and never repeats a click in the same activation turn", async () => {
    installMatchMedia(false);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onSelect = vi.fn<(id: HomeSuggestionId) => void>();
    const { container } = await renderList({ onSelect });
    const first = suggestionButtons(container)[0]!;

    await act(async () => {
      first.click();
      first.click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);

    const previous = suggestionIds(container);
    await act(async () => action(container, "home-suggestions-shuffle").click());
    const current = suggestionIds(container);
    expect(current).toHaveLength(4);
    expect(current.some((id) => previous.includes(id))).toBe(false);
  });

  it("disables every action without selecting, shuffling, or dismissing", async () => {
    installMatchMedia(false);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onSelect = vi.fn<(id: HomeSuggestionId) => void>();
    const { container } = await renderList({ disabled: true, onSelect });
    const before = suggestionIds(container);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.every((button) => button.disabled)).toBe(true);

    buttons.forEach((button) => button.click());
    expect(onSelect).not.toHaveBeenCalled();
    expect(suggestionIds(container)).toEqual(before);
    expect(container.querySelector('[data-testid="home-suggestions"]')).not.toBeNull();
    expect(localStorage.getItem(HOME_SUGGESTIONS_HIDDEN_KEY)).toBeNull();
  });

  it("persists Don't show again and starts future mounts hidden", async () => {
    installMatchMedia(false);
    const first = await renderList();
    await act(async () => action(first.container, "home-suggestions-dismiss").click());

    expect(localStorage.getItem(HOME_SUGGESTIONS_HIDDEN_KEY)).toBe("1");
    expect(first.container.querySelector('[data-testid="home-suggestions"]')).toBeNull();
    const next = await renderList();
    expect(next.container.querySelector('[data-testid="home-suggestions"]')).toBeNull();
  });

  it("stays hidden for the current mount when storage rejects dismissal", async () => {
    installMatchMedia(false);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { container } = await renderList();
    await act(async () => action(container, "home-suggestions-dismiss").click());

    expect(container.querySelector('[data-testid="home-suggestions"]')).toBeNull();
  });
});

async function renderList({
  disabled = false,
  onSelect = vi.fn<(id: HomeSuggestionId) => void>()
}: {
  readonly disabled?: boolean;
  readonly onSelect?: (id: HomeSuggestionId) => void;
} = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<HomeSuggestionList t={t} disabled={disabled} onSelect={onSelect} />));
  return { container, root };
}

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    get matches() { return matches; },
    media: "(max-width: 820px)",
    onchange: null,
    addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => { listeners.add(listener); },
    removeEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => { listeners.delete(listener); },
    addListener: (listener: (event: MediaQueryListEvent) => void) => { listeners.add(listener); },
    removeListener: (listener: (event: MediaQueryListEvent) => void) => { listeners.delete(listener); },
    dispatchEvent: () => true
  } as unknown as MediaQueryList;
  const matchMedia = vi.fn(() => query);
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    matchMedia,
    set(value: boolean): void {
      matches = value;
      const event = { matches, media: query.media } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    }
  };
}

function suggestionButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("[data-home-suggestion-id]")];
}

function suggestionIds(container: HTMLElement): string[] {
  return suggestionButtons(container).map((button) => button.dataset.homeSuggestionId!);
}

function action(container: HTMLElement, testId: string): HTMLButtonElement {
  const value = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (value === null) throw new Error(`Expected ${testId}.`);
  return value;
}

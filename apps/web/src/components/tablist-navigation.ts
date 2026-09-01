import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export type TablistOrientation = "horizontal" | "vertical";

export function moveTablistSelection(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  orientation: TablistOrientation
): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return false;
  const tablist = event.currentTarget.closest<HTMLElement>('[role="tablist"]');
  const tabs = tablist === null
    ? []
    : [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter((tab) => !tab.disabled);
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0 || tabs.length === 0) return false;

  const previousKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : event.key === previousKey
        ? (currentIndex - 1 + tabs.length) % tabs.length
        : event.key === nextKey
          ? (currentIndex + 1) % tabs.length
          : undefined;
  if (nextIndex === undefined) return false;

  event.preventDefault();
  const next = tabs[nextIndex];
  next?.focus();
  next?.click();
  return next !== undefined;
}

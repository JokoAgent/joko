import { useEffect } from "react";
import type { RefObject } from "react";
import type { SettingsSearchEntry } from "./settings-search.js";
import type { Translator } from "./types.js";

function displayed(element: HTMLElement, container: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (node === container) return true;
  }
  return false;
}

export function resolveSettingsSearchTarget(container: HTMLElement, entry: SettingsSearchEntry, t: Translator): HTMLElement | null {
  const exact = entry.targetId === undefined ? null : container.ownerDocument.getElementById(entry.targetId);
  if (exact !== null && container.contains(exact) && displayed(exact, container)) return exact;
  const scope = container.ownerDocument.getElementById(entry.fallbackTargetId);
  if (scope === null || !container.contains(scope) || !displayed(scope, container)) return null;
  const label = t(entry.titleKey);
  // Match declared labels, never control values or arbitrary setting content.
  const matches = [...scope.querySelectorAll<HTMLElement>("h2,h3,h4,strong,label,legend,[aria-label]")]
    .filter((element) => (element.textContent?.trim() === label || element.getAttribute("aria-label") === label) && displayed(element, scope));
  const destinations = new Set(matches.map((element) => element.closest<HTMLElement>(".setting-row,.appearance-font-family,.appearance-font-size,.field,.personalization-section,.settings-card,section,header") ?? element));
  return destinations.size === 1 ? [...destinations][0]! : scope;
}

/** A single owned frame and highlight lifetime for selections, deep links and repeat activation. */
export function useSettingsSearchTarget(
  entry: SettingsSearchEntry | undefined,
  scrollRef: RefObject<HTMLDivElement | null>,
  navigationKey: string,
  t: Translator
): void {
  useEffect(() => {
    const container = scrollRef.current;
    if (entry === undefined || container === null) return;
    let target: HTMLElement | null = null;
    let timer: number | undefined;
    let priorTabIndex: string | null = null;
    const frame = window.requestAnimationFrame(() => {
      target = resolveSettingsSearchTarget(container, entry, t);
      if (target === null) return;
      const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTo?.({ top: Math.max(0, top - 8), behavior: typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      priorTabIndex = target.getAttribute("tabindex");
      if (priorTabIndex === null) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
      target.classList.add("settings-search-target-highlight");
      timer = window.setTimeout(() => target?.classList.remove("settings-search-target-highlight"), 1600);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timer !== undefined) window.clearTimeout(timer);
      if (target !== null) {
        target.classList.remove("settings-search-target-highlight");
        if (priorTabIndex === null) target.removeAttribute("tabindex");
      }
    };
  }, [entry, navigationKey, scrollRef, t]);
}

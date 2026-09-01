import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

const TOP_FUDGE_PX = 8;
const IDLE_HIDE_MS = 3_000;
const DIRECTION_DEAD_ZONE_PX = 1;
const NAVIGATION_KEYS = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "]);

export function usePreviousUserMessageJump({ scrollRef, userMessageIds, resetKey }: {
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly userMessageIds: readonly string[];
  readonly resetKey: string;
}): { readonly displayId: string | null; readonly suppressAfterClick: () => void } {
  const [computedId, setComputedId] = useState<string | null>(null);
  const [suppressed, setSuppressed] = useState(false);
  const [idleHidden, setIdleHidden] = useState(false);
  const [scrollingDown, setScrollingDown] = useState(false);
  const frameRef = useRef<number | undefined>(undefined);
  const idleTimerRef = useRef<number | undefined>(undefined);
  const lastScrollTopRef = useRef(0);
  const idsRef = useRef(userMessageIds);
  idsRef.current = userMessageIds;

  useEffect(() => {
    setComputedId(null);
    setSuppressed(false);
    setIdleHidden(false);
    setScrollingDown(false);
    lastScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
  }, [resetKey, scrollRef]);

  const compute = useCallback((): void => {
    frameRef.current = undefined;
    const root = scrollRef.current;
    if (root === null) return;
    const threshold = root.getBoundingClientRect().top + TOP_FUDGE_PX;
    let target: string | null = null;
    for (let index = idsRef.current.length - 1; index >= 0; index -= 1) {
      const id = idsRef.current[index];
      if (id === undefined) continue;
      const element = [...root.querySelectorAll<HTMLElement>("[data-user-msg-id]")].find((candidate) => candidate.dataset.userMsgId === id);
      if (element !== undefined && element.getBoundingClientRect().bottom < threshold) {
        target = id;
        break;
      }
    }
    setComputedId((current) => current === target ? current : target);
  }, [scrollRef]);

  const scheduleCompute = useCallback((): void => {
    if (frameRef.current !== undefined) return;
    frameRef.current = window.requestAnimationFrame(compute);
  }, [compute]);

  const resetIdle = useCallback((): void => {
    if (idleTimerRef.current !== undefined) window.clearTimeout(idleTimerRef.current);
    setIdleHidden(false);
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = undefined;
      setIdleHidden(true);
    }, IDLE_HIDE_MS);
  }, []);

  const revealAfterUserIntent = useCallback((): void => setSuppressed(false), []);

  useEffect(() => {
    const root = scrollRef.current;
    if (root === null) return;
    lastScrollTopRef.current = root.scrollTop;
    const onScroll = (): void => {
      const delta = root.scrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = root.scrollTop;
      if (delta > DIRECTION_DEAD_ZONE_PX) setScrollingDown(true);
      else if (delta < -DIRECTION_DEAD_ZONE_PX) setScrollingDown(false);
      resetIdle();
      scheduleCompute();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (NAVIGATION_KEYS.has(event.key) && !(event.key === " " && isEditableTarget(event.target))) revealAfterUserIntent();
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("wheel", revealAfterUserIntent, { passive: true });
    root.addEventListener("touchstart", revealAfterUserIntent, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleCompute);
    observer?.observe(root);
    if (observer === undefined) window.addEventListener("resize", scheduleCompute);
    scheduleCompute();
    return () => {
      root.removeEventListener("scroll", onScroll);
      root.removeEventListener("wheel", revealAfterUserIntent);
      root.removeEventListener("touchstart", revealAfterUserIntent);
      window.removeEventListener("keydown", onKeyDown);
      observer?.disconnect();
      if (observer === undefined) window.removeEventListener("resize", scheduleCompute);
      if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current);
      if (idleTimerRef.current !== undefined) window.clearTimeout(idleTimerRef.current);
    };
  }, [resetIdle, revealAfterUserIntent, scheduleCompute, scrollRef]);

  useEffect(scheduleCompute, [scheduleCompute, userMessageIds]);
  const suppressAfterClick = useCallback((): void => setSuppressed(true), []);
  return { displayId: suppressed || idleHidden || scrollingDown ? null : computedId, suppressAfterClick };
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return element?.closest("input, textarea, [contenteditable='true']") !== null;
}

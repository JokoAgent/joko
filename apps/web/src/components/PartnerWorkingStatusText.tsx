import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";

const MIN_INTERVAL_MS = 1000;

/** Mount only for a current working lifecycle; terminal states bypass cadence. */
export function PartnerWorkingStatusText({ text }: { readonly text: string }): JSX.Element {
  const reducedMotion = useReducedMotion();
  const element = useRef<HTMLSpanElement>(null);
  const [displayed, setDisplayed] = useState(text);
  const [fading, setFading] = useState(false);
  const state = useRef({ displayed: text, latest: text, changedAt: performance.now(), fading: false, reducedMotion,
    timer: undefined as ReturnType<typeof setTimeout> | undefined });
  useLayoutEffect(() => {
    const current = state.current;
    current.latest = text; current.reducedMotion = reducedMotion;
    const commitLatest = (): void => {
      current.timer = undefined; current.displayed = current.latest; current.changedAt = performance.now(); current.fading = false;
      setDisplayed(current.displayed); setFading(false);
    };
    const beginTransition = (): void => {
      current.timer = undefined;
      if (current.latest === current.displayed) return;
      const token = element.current ? getComputedStyle(element.current).getPropertyValue("--partner-working-fade").trim() : "";
      const duration = Number.parseFloat(token) * (token.endsWith("ms") ? 1 : 1000);
      if (current.reducedMotion || !Number.isFinite(duration) || duration <= 0) { commitLatest(); return; }
      current.fading = true; setFading(true); current.timer = setTimeout(commitLatest, duration);
    };
    if (text === current.displayed) {
      clearTimeout(current.timer); current.timer = undefined; current.fading = false; setFading(false);
    } else if (current.fading) {
      if (reducedMotion) { clearTimeout(current.timer); commitLatest(); }
    } else if (current.timer === undefined) {
      current.timer = setTimeout(beginTransition, Math.max(0, current.changedAt + MIN_INTERVAL_MS - performance.now()));
    }
  }, [text, reducedMotion]);
  useLayoutEffect(() => () => clearTimeout(state.current.timer), []);
  return <span ref={element} className="partner-working-text" style={{ opacity: fading && !reducedMotion ? 0 : 1 }}>{displayed}</span>;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

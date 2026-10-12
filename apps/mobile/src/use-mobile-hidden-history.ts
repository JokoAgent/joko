import { useEffect, useRef, useState } from "react";

export const MOBILE_HIDDEN_HISTORY_LIMIT = 20;
export interface MobileHiddenHistoryInput {
  readonly scope: string;
  readonly enabled: boolean;
  readonly visibleCount: number;
  readonly hasEarlier: boolean;
  readonly loading: boolean;
  readonly cursor: string | undefined;
}
export interface MobileHiddenHistoryState {
  readonly scope: string;
  readonly pages: number;
  readonly cursor?: string;
  readonly exhausted: boolean;
}
export function planMobileHiddenHistory(previous: MobileHiddenHistoryState,
  input: MobileHiddenHistoryInput): { readonly state: MobileHiddenHistoryState; readonly load: boolean } {
  const state = previous.scope === input.scope ? previous : { scope: input.scope, pages: 0, exhausted: false };
  if (!input.enabled || input.visibleCount > 0 || !input.hasEarlier || input.loading || state.exhausted) return { state, load: false };
  if (state.pages >= MOBILE_HIDDEN_HISTORY_LIMIT || state.pages > 0 && state.cursor === input.cursor) {
    return { state: { ...state, exhausted: true }, load: false };
  }
  return { state: { ...state, pages: state.pages + 1, cursor: input.cursor }, load: true };
}

export function useMobileHiddenHistory(input: MobileHiddenHistoryInput, loadEarlier: () => Promise<void>): boolean {
  const state = useRef<MobileHiddenHistoryState>({ scope: input.scope, pages: 0, exhausted: false });
  const loader = useRef(loadEarlier); loader.current = loadEarlier;
  const scope = useRef(input.scope); scope.current = input.scope;
  const [exhausted, setExhausted] = useState<string>();
  useEffect(() => {
    const next = planMobileHiddenHistory(state.current, input); state.current = next.state;
    if (next.state.exhausted) setExhausted(input.scope);
    if (next.load) void loader.current().catch(() => {
      if (scope.current !== input.scope) return;
      state.current = { ...state.current, exhausted: true }; setExhausted(input.scope);
    });
  }, [input.scope, input.enabled, input.visibleCount, input.hasEarlier, input.loading, input.cursor]);
  return input.enabled && input.visibleCount === 0 && input.hasEarlier && exhausted !== input.scope;
}

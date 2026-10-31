/** Exact percentage tiers from a route's effective ceiling; a default choice keeps inheritance. */
export interface SessionContextBudgetBounds {
  readonly defaultWindow?: number;
  readonly maximumWindow?: number;
  readonly modelLimit?: number;
}
export function contextBudgetCeiling(bounds: SessionContextBudgetBounds): number | undefined {
  const positive = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value > 0;
  const caps = [bounds.maximumWindow, bounds.modelLimit].filter(positive);
  return caps.length ? Math.min(...caps) : positive(bounds.defaultWindow) ? bounds.defaultWindow : undefined;
}
export function contextBudgetOptions(bounds: SessionContextBudgetBounds): readonly { readonly tokens: number; readonly isDefault: boolean }[] {
  const base = contextBudgetCeiling(bounds); if (!base) return [];
  const routeDefault = bounds.defaultWindow ? Math.min(bounds.defaultWindow, base) : undefined;
  const tiers = [25, 50, 100].map(percent => Math.round(base * percent / 100)).filter(tokens => tokens >= 200_000 && tokens !== routeDefault).slice(-2);
  return [...new Set([...tiers, ...(routeDefault ? [routeDefault] : [])])].sort((a, b) => a - b).map(tokens => ({ tokens, isDefault: tokens === routeDefault }));
}

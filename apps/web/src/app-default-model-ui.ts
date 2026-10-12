import type { AppDefaultModelRouteValue } from "@joko/contracts";
export interface AppDefaultModelUiPort {
  watchAppDefaultModel(uiOwnerId: string, signal: AbortSignal): AsyncIterable<{ readonly ready: boolean; readonly requestId: string }>;
  syncAppDefaultModel(uiOwnerId: string, mirror: { readonly current?: AppDefaultModelRouteValue; readonly hiddenRouteIds: readonly string[];
    readonly tuning: readonly AppDefaultModelRouteValue[]; readonly visibleRouteIds?: readonly string[]; readonly confirmedRequestId?: string }, signal: AbortSignal): Promise<boolean>;
  claimAppDefaultModel(uiOwnerId: string, requestId: string, signal: AbortSignal): Promise<{ readonly remainingMs: number;
    readonly expected?: AppDefaultModelRouteValue; readonly requested: AppDefaultModelRouteValue }>;
}

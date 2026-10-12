export interface AppDefaultModelRouteValue {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort: string;
  readonly fastMode: boolean;
}

export function appDefaultModelRouteId(route: Pick<AppDefaultModelRouteValue, "backendId" | "providerId" | "modelId">): string {
  return JSON.stringify([route.backendId, route.providerId, route.modelId]);
}

export function sameAppDefaultModelRoute(a: AppDefaultModelRouteValue | undefined, b: AppDefaultModelRouteValue | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && appDefaultModelRouteId(a) === appDefaultModelRouteId(b)
    && a.effort === b.effort && a.fastMode === b.fastMode;
}

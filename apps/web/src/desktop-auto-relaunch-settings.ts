import { useCallback, useEffect, useRef, useState } from "react";

const DESKTOP_UPDATE_CAPABILITY = "app.update" satisfies JokoDesktopCapability;

type DesktopAutoRelaunchApi = Pick<
  JokoDesktopApi["updates"],
  "getAutoRelaunchSettings" | "setAutoRelaunchOnIdle" | "resetAutoRelaunchSettings" | "onAutoRelaunchSettings"
>;

export type DesktopAutoRelaunchSettingsError = "load" | "save" | "reset";

export interface DesktopAutoRelaunchSettingsState extends JokoDesktopAutoRelaunchSettings {
  readonly available: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error?: DesktopAutoRelaunchSettingsError;
}

const DEFAULT_SETTINGS: JokoDesktopAutoRelaunchSettings = Object.freeze({
  autoRelaunchOnIdle: false,
  isCustomized: false,
  defaultAutoRelaunchOnIdle: false
});

const UNAVAILABLE_STATE: DesktopAutoRelaunchSettingsState = Object.freeze({
  ...DEFAULT_SETTINGS,
  available: false,
  loading: false,
  saving: false
});

const LOADING_STATE: DesktopAutoRelaunchSettingsState = Object.freeze({
  ...DEFAULT_SETTINGS,
  available: true,
  loading: true,
  saving: false
});

export function desktopAutoRelaunchApi(): DesktopAutoRelaunchApi | undefined {
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  if (
    desktop === undefined
    || !Array.isArray(desktop.capabilities)
    || !desktop.capabilities.includes(DESKTOP_UPDATE_CAPABILITY)
  ) return undefined;
  const updates = desktop.updates;
  return typeof updates?.getAutoRelaunchSettings === "function"
    && typeof updates.setAutoRelaunchOnIdle === "function"
    && typeof updates.resetAutoRelaunchSettings === "function"
    && typeof updates.onAutoRelaunchSettings === "function"
    ? updates
    : undefined;
}

export function useDesktopAutoRelaunchSettings(): {
  readonly state: DesktopAutoRelaunchSettingsState;
  readonly reload: () => Promise<void>;
  readonly setAutoRelaunchOnIdle: (enabled: boolean) => Promise<void>;
  readonly reset: () => Promise<void>;
} {
  const initialApi = desktopAutoRelaunchApi();
  const [state, setState] = useState<DesktopAutoRelaunchSettingsState>(
    initialApi === undefined ? UNAVAILABLE_STATE : LOADING_STATE
  );
  const activeApiRef = useRef<DesktopAutoRelaunchApi | undefined>(undefined);
  const requestEpochRef = useRef(0);
  const settingsRevisionRef = useRef(0);
  const ownerEpochRef = useRef(0);
  const confirmedRef = useRef<JokoDesktopAutoRelaunchSettings | undefined>(undefined);
  const mutationFlightRef = useRef<object | undefined>(undefined);

  const requestSettings = useCallback(async (initialRevision?: number): Promise<void> => {
    const api = activeApiRef.current;
    if (api === undefined || mutationFlightRef.current !== undefined) return;
    const requestEpoch = ++requestEpochRef.current;
    const settingsRevision = initialRevision ?? settingsRevisionRef.current;
    if (settingsRevisionRef.current === settingsRevision) {
      setState((current) => ({ ...current, loading: confirmedRef.current === undefined, error: undefined }));
    }
    try {
      const settings = normalizeSettings(await api.getAutoRelaunchSettings());
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)
        || settingsRevisionRef.current !== settingsRevision) return;
      confirmedRef.current = settings;
      setState(readyState(settings));
    } catch {
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)
        || settingsRevisionRef.current !== settingsRevision) return;
      setState((current) => ({ ...current, loading: false, error: "load" }));
    }
  }, []);

  useEffect(() => {
    const api = desktopAutoRelaunchApi();
    activeApiRef.current = api;
    const ownerEpoch = ++ownerEpochRef.current;
    confirmedRef.current = undefined;
    mutationFlightRef.current = undefined;
    settingsRevisionRef.current += 1;
    const initialRevision = settingsRevisionRef.current;
    requestEpochRef.current += 1;
    let unsubscribe: (() => void) | undefined;
    if (api === undefined) {
      setState(UNAVAILABLE_STATE);
    } else {
      setState(LOADING_STATE);
      try {
        unsubscribe = api.onAutoRelaunchSettings((payload) => {
          if (activeApiRef.current !== api || ownerEpochRef.current !== ownerEpoch) return;
          let settings: JokoDesktopAutoRelaunchSettings;
          try {
            settings = normalizeSettings(payload);
          } catch {
            return;
          }
          settingsRevisionRef.current += 1;
          confirmedRef.current = settings;
          setState({ ...readyState(settings), saving: mutationFlightRef.current !== undefined });
        });
        void requestSettings(initialRevision);
      } catch {
        setState({ ...LOADING_STATE, loading: false, error: "load" });
      }
    }
    return () => {
      ownerEpochRef.current += 1;
      if (activeApiRef.current === api) activeApiRef.current = undefined;
      requestEpochRef.current += 1;
      mutationFlightRef.current = undefined;
      try {
        unsubscribe?.();
      } catch {
        // Observer cleanup cannot fail the component's retirement.
      }
    };
  }, [initialApi, requestSettings]);

  const mutate = useCallback(async (
    operation: (api: DesktopAutoRelaunchApi) => Promise<JokoDesktopAutoRelaunchSettings>,
    error: "save" | "reset"
  ): Promise<void> => {
    const api = activeApiRef.current;
    if (api === undefined || confirmedRef.current === undefined || mutationFlightRef.current !== undefined) return;
    const flight = {};
    mutationFlightRef.current = flight;
    const requestEpoch = ++requestEpochRef.current;
    const settingsRevision = settingsRevisionRef.current;
    setState((current) => current.available
      ? { ...current, loading: false, saving: true, error: undefined }
      : current);
    try {
      const settings = normalizeSettings(await operation(api));
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)
        || settingsRevisionRef.current !== settingsRevision) return;
      confirmedRef.current = settings;
      setState({ ...readyState(settings), saving: true });
    } catch {
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
      const recoveryRevision = settingsRevisionRef.current;
      try {
        const settings = normalizeSettings(await api.getAutoRelaunchSettings());
        if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
        if (settingsRevisionRef.current === recoveryRevision) {
          confirmedRef.current = settings;
          setState({ ...readyState(settings), saving: true, error });
        } else {
          setState((current) => ({ ...current, error }));
        }
      } catch {
        if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
        setState((current) => ({
          ...current,
          error: settingsRevisionRef.current === recoveryRevision ? "load" : error
        }));
      }
    } finally {
      if (mutationFlightRef.current === flight) mutationFlightRef.current = undefined;
      if (requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) {
        setState((current) => ({ ...current, saving: false }));
      }
    }
  }, []);

  const setAutoRelaunchOnIdle = useCallback((enabled: boolean): Promise<void> =>
    mutate((api) => api.setAutoRelaunchOnIdle(enabled), "save"), [mutate]);
  const reset = useCallback((): Promise<void> =>
    mutate((api) => api.resetAutoRelaunchSettings(), "reset"), [mutate]);

  return { state, reload: requestSettings, setAutoRelaunchOnIdle, reset };
}

function requestIsCurrent(
  api: DesktopAutoRelaunchApi,
  requestEpoch: number,
  activeApiRef: { readonly current: DesktopAutoRelaunchApi | undefined },
  requestEpochRef: { readonly current: number }
): boolean {
  return activeApiRef.current === api && requestEpochRef.current === requestEpoch;
}

function readyState(settings: JokoDesktopAutoRelaunchSettings): DesktopAutoRelaunchSettingsState {
  return {
    ...settings,
    available: true,
    loading: false,
    saving: false
  };
}

function normalizeSettings(value: unknown): JokoDesktopAutoRelaunchSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid idle update settings.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "autoRelaunchOnIdle,defaultAutoRelaunchOnIdle,isCustomized"
    || typeof record["autoRelaunchOnIdle"] !== "boolean"
    || typeof record["defaultAutoRelaunchOnIdle"] !== "boolean"
    || typeof record["isCustomized"] !== "boolean") throw new TypeError("Invalid idle update settings.");
  return {
    autoRelaunchOnIdle: record["autoRelaunchOnIdle"],
    defaultAutoRelaunchOnIdle: record["defaultAutoRelaunchOnIdle"],
    isCustomized: record["isCustomized"]
  };
}

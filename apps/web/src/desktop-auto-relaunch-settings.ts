import { useCallback, useEffect, useRef, useState } from "react";

const DESKTOP_UPDATE_CAPABILITY = "app.update" satisfies JokoDesktopCapability;

type DesktopAutoRelaunchApi = Pick<
  JokoDesktopApi["updates"],
  "getAutoRelaunchSettings" | "setAutoRelaunchOnIdle" | "resetAutoRelaunchSettings"
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

/**
 * Auto-relaunch is a narrower surface than the update banner. A mixed-version
 * preload may support update checks without settings, so require all three
 * settings methods here without taking the existing update UI away.
 */
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

  const requestSettings = useCallback(async (): Promise<void> => {
    const api = activeApiRef.current;
    if (api === undefined) return;
    const requestEpoch = ++requestEpochRef.current;
    setState(LOADING_STATE);
    try {
      const settings = await api.getAutoRelaunchSettings();
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
      setState(readyState(settings));
    } catch {
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
      setState({ ...LOADING_STATE, loading: false, error: "load" });
    }
  }, []);

  useEffect(() => {
    const api = desktopAutoRelaunchApi();
    activeApiRef.current = api;
    if (api === undefined) {
      requestEpochRef.current += 1;
      setState(UNAVAILABLE_STATE);
    } else {
      void requestSettings();
    }
    return () => {
      if (activeApiRef.current === api) activeApiRef.current = undefined;
      requestEpochRef.current += 1;
    };
  }, [initialApi, requestSettings]);

  const setAutoRelaunchOnIdle = useCallback(async (enabled: boolean): Promise<void> => {
    const api = activeApiRef.current;
    if (api === undefined) return;
    const requestEpoch = ++requestEpochRef.current;
    setState((current) => current.available
      ? { ...current, loading: false, saving: true, error: undefined }
      : current);
    try {
      const settings = await api.setAutoRelaunchOnIdle(enabled);
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
      setState(readyState(settings));
    } catch {
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
      setState((current) => ({ ...current, saving: false, error: "save" }));
    }
  }, []);

  const reset = useCallback(async (): Promise<void> => {
    const api = activeApiRef.current;
    if (api === undefined) return;
    const requestEpoch = ++requestEpochRef.current;
    setState((current) => current.available
      ? { ...current, loading: false, saving: true, error: undefined }
      : current);
    try {
      const settings = await api.resetAutoRelaunchSettings();
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
      setState(readyState(settings));
    } catch {
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
      setState((current) => ({ ...current, saving: false, error: "reset" }));
    }
  }, []);

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
    autoRelaunchOnIdle: settings.autoRelaunchOnIdle === true,
    isCustomized: settings.isCustomized === true,
    defaultAutoRelaunchOnIdle: settings.defaultAutoRelaunchOnIdle === true,
    available: true,
    loading: false,
    saving: false
  };
}

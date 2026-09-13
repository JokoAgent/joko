import { useCallback, useEffect, useRef, useState } from "react";

const DESKTOP_UPDATE_CAPABILITY = "app.update" satisfies JokoDesktopCapability;

type DesktopBetaChannelApi = Pick<
  JokoDesktopApi["updates"],
  | "getChannelSettings"
  | "setBetaChannelEnabled"
  | "resetChannelSettings"
  | "probeBetaChannel"
  | "relaunchForChannelChange"
  | "onChannelSettings"
>;

export type DesktopBetaChannelError = "load" | "unavailable" | "save" | "reset" | "relaunch";
export type DesktopBetaChannelNotice = "disabled";
export type DesktopBetaChannelRestartPrompt = "restart" | "busy";

export interface DesktopBetaChannelState extends JokoDesktopUpdateChannelSettings {
  readonly available: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly restarting: boolean;
  readonly error?: DesktopBetaChannelError;
  readonly notice?: DesktopBetaChannelNotice;
  readonly restartPrompt?: DesktopBetaChannelRestartPrompt;
}

const DEFAULT_SETTINGS: JokoDesktopUpdateChannelSettings = Object.freeze({
  enableBeta: false,
  isCustomized: false,
  defaultEnableBeta: false
});

const UNAVAILABLE_STATE: DesktopBetaChannelState = Object.freeze({
  ...DEFAULT_SETTINGS,
  available: false,
  loading: false,
  saving: false,
  restarting: false
});

const LOADING_STATE: DesktopBetaChannelState = Object.freeze({
  ...DEFAULT_SETTINGS,
  available: true,
  loading: true,
  saving: false,
  restarting: false
});

interface PendingRequest {
  readonly epoch: number;
  readonly expectedEnableBeta: boolean;
  readonly observedMatch?: true;
}

export function desktopBetaChannelApi(): DesktopBetaChannelApi | undefined {
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  if (
    desktop === undefined
    || !Array.isArray(desktop.capabilities)
    || !desktop.capabilities.includes(DESKTOP_UPDATE_CAPABILITY)
  ) return undefined;
  const updates = desktop.updates;
  return typeof updates?.getChannelSettings === "function"
    && typeof updates.setBetaChannelEnabled === "function"
    && typeof updates.resetChannelSettings === "function"
    && typeof updates.probeBetaChannel === "function"
    && typeof updates.relaunchForChannelChange === "function"
    && typeof updates.onChannelSettings === "function"
    ? updates
    : undefined;
}

export function useDesktopBetaChannelSettings(): {
  readonly state: DesktopBetaChannelState;
  readonly reload: () => Promise<void>;
  readonly setEnableBeta: (enabled: boolean) => Promise<void>;
  readonly reset: () => Promise<void>;
  readonly dismissRestart: () => void;
  readonly relaunch: (allowBusy: boolean) => Promise<void>;
} {
  const initialApi = desktopBetaChannelApi();
  const [state, setState] = useState<DesktopBetaChannelState>(
    initialApi === undefined ? UNAVAILABLE_STATE : LOADING_STATE
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const activeApiRef = useRef<DesktopBetaChannelApi | undefined>(undefined);
  const requestEpochRef = useRef(0);
  const pendingRequestRef = useRef<PendingRequest | undefined>(undefined);
  const latestSettingsRef = useRef<JokoDesktopUpdateChannelSettings>(DEFAULT_SETTINGS);
  const settingsRevisionRef = useRef(0);

  const requestSettings = useCallback(async (): Promise<void> => {
    const api = activeApiRef.current;
    if (api === undefined) return;
    const requestEpoch = ++requestEpochRef.current;
    const settingsRevision = settingsRevisionRef.current;
    pendingRequestRef.current = undefined;
    setState(LOADING_STATE);
    try {
      const settings = normalizeSettings(await api.getChannelSettings());
      if (settings === undefined) {
        if (
          requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)
          && settingsRevisionRef.current === settingsRevision
        ) {
          setState({ ...LOADING_STATE, loading: false, error: "load" });
        }
        return;
      }
      if (
        !requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)
        || settingsRevisionRef.current !== settingsRevision
      ) return;
      latestSettingsRef.current = settings;
      setState(readyState(settings));
    } catch {
      if (
        !requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)
        || settingsRevisionRef.current !== settingsRevision
      ) return;
      setState({ ...LOADING_STATE, loading: false, error: "load" });
    }
  }, []);

  useEffect(() => {
    const api = desktopBetaChannelApi();
    activeApiRef.current = api;
    if (api === undefined) {
      requestEpochRef.current += 1;
      pendingRequestRef.current = undefined;
      setState(UNAVAILABLE_STATE);
      return () => undefined;
    }

    let unsubscribe: (() => void) | undefined;
    // Start hydration before subscribing so even a synchronous initial push
    // is newer than (and therefore supersedes) the get response.
    void requestSettings();
    try {
      unsubscribe = api.onChannelSettings((payload) => {
        if (activeApiRef.current !== api) return;
        const settings = normalizeSettings(payload);
        if (settings === undefined) {
          requestEpochRef.current += 1;
          pendingRequestRef.current = undefined;
          setState({ ...LOADING_STATE, loading: false, error: "load" });
          return;
        }
        settingsRevisionRef.current += 1;
        latestSettingsRef.current = settings;
        const pending = pendingRequestRef.current;
        if (pending !== undefined && pending.expectedEnableBeta !== settings.enableBeta) {
          requestEpochRef.current += 1;
          pendingRequestRef.current = undefined;
        } else if (pending !== undefined) {
          pendingRequestRef.current = { ...pending, observedMatch: true };
        }
        const requestStillPending = pendingRequestRef.current !== undefined;
        setState((current) => ({
          ...readyState(settings),
          saving: requestStillPending && current.saving,
          restarting: requestStillPending && current.restarting,
          restartPrompt: settings.enableBeta ? current.restartPrompt : undefined
        }));
      });
    } catch {
      requestEpochRef.current += 1;
      setState({ ...LOADING_STATE, loading: false, error: "load" });
      return () => {
        if (activeApiRef.current === api) activeApiRef.current = undefined;
        requestEpochRef.current += 1;
        pendingRequestRef.current = undefined;
      };
    }
    return () => {
      if (activeApiRef.current === api) activeApiRef.current = undefined;
      requestEpochRef.current += 1;
      pendingRequestRef.current = undefined;
      try {
        unsubscribe?.();
      } catch {
        // Observation cleanup must not make an unmount fail.
      }
    };
  }, [initialApi, requestSettings]);

  const setEnableBeta = useCallback(async (enabled: boolean): Promise<void> => {
    const api = activeApiRef.current;
    if (api === undefined) return;
    const requestEpoch = ++requestEpochRef.current;
    pendingRequestRef.current = { epoch: requestEpoch, expectedEnableBeta: enabled };
    setState((current) => current.available
      ? {
        ...current,
        loading: false,
        saving: true,
        restarting: false,
        error: undefined,
        notice: undefined,
        restartPrompt: undefined
      }
      : current);

    if (enabled) {
      try {
        const result = await api.probeBetaChannel();
        if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
        if (result?.available !== true) {
          finishPendingRequest(requestEpoch, pendingRequestRef);
          setState((current) => ({ ...current, saving: false, error: "unavailable" }));
          return;
        }
      } catch {
        if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
        finishPendingRequest(requestEpoch, pendingRequestRef);
        setState((current) => ({ ...current, saving: false, error: "unavailable" }));
        return;
      }
    }

    try {
      const returnedSettings = normalizeSettings(await api.setBetaChannelEnabled(enabled));
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
      const settings = observedSettings(requestEpoch, pendingRequestRef, latestSettingsRef)
        ?? returnedSettings;
      finishPendingRequest(requestEpoch, pendingRequestRef);
      if (settings === undefined || settings.enableBeta !== enabled) {
        setState((current) => ({ ...current, saving: false, error: "save" }));
        return;
      }
      latestSettingsRef.current = settings;
      setState({
        ...readyState(settings),
        notice: enabled ? undefined : "disabled",
        restartPrompt: enabled ? "restart" : undefined
      });
    } catch {
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
      const settings = observedSettings(requestEpoch, pendingRequestRef, latestSettingsRef);
      finishPendingRequest(requestEpoch, pendingRequestRef);
      if (settings !== undefined && settings.enableBeta === enabled) {
        setState({
          ...readyState(settings),
          notice: enabled ? undefined : "disabled",
          restartPrompt: enabled ? "restart" : undefined
        });
        return;
      }
      setState((current) => ({ ...current, saving: false, error: "save" }));
    }
  }, []);

  const reset = useCallback(async (): Promise<void> => {
    const api = activeApiRef.current;
    if (api === undefined) return;
    const expectedEnableBeta = stateRef.current.defaultEnableBeta;
    const previousEnableBeta = stateRef.current.enableBeta;
    const requestEpoch = ++requestEpochRef.current;
    pendingRequestRef.current = { epoch: requestEpoch, expectedEnableBeta };
    setState((current) => current.available
      ? { ...current, saving: true, error: undefined, notice: undefined, restartPrompt: undefined }
      : current);
    if (expectedEnableBeta) {
      try {
        const result = await api.probeBetaChannel();
        if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
        if (result?.available !== true) {
          finishPendingRequest(requestEpoch, pendingRequestRef);
          setState((current) => ({ ...current, saving: false, error: "unavailable" }));
          return;
        }
      } catch {
        if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
        finishPendingRequest(requestEpoch, pendingRequestRef);
        setState((current) => ({ ...current, saving: false, error: "unavailable" }));
        return;
      }
    }
    try {
      const returnedSettings = normalizeSettings(await api.resetChannelSettings());
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
      const settings = observedSettings(requestEpoch, pendingRequestRef, latestSettingsRef)
        ?? returnedSettings;
      finishPendingRequest(requestEpoch, pendingRequestRef);
      if (settings === undefined) {
        setState((current) => ({ ...current, saving: false, error: "reset" }));
        return;
      }
      latestSettingsRef.current = settings;
      setState({
        ...readyState(settings),
        notice: previousEnableBeta && !settings.enableBeta ? "disabled" : undefined,
        restartPrompt: !previousEnableBeta && settings.enableBeta ? "restart" : undefined
      });
    } catch {
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
      const settings = observedSettings(requestEpoch, pendingRequestRef, latestSettingsRef);
      finishPendingRequest(requestEpoch, pendingRequestRef);
      if (settings !== undefined) {
        setState({
          ...readyState(settings),
          notice: previousEnableBeta && !settings.enableBeta ? "disabled" : undefined,
          restartPrompt: !previousEnableBeta && settings.enableBeta ? "restart" : undefined
        });
        return;
      }
      setState((current) => ({ ...current, saving: false, error: "reset" }));
    }
  }, []);

  const dismissRestart = useCallback((): void => {
    if (stateRef.current.restarting) return;
    requestEpochRef.current += 1;
    pendingRequestRef.current = undefined;
    setState((current) => ({ ...current, error: undefined, restartPrompt: undefined }));
  }, []);

  const relaunch = useCallback(async (allowBusy: boolean): Promise<void> => {
    const api = activeApiRef.current;
    const prompt = stateRef.current.restartPrompt;
    if (
      api === undefined
      || (allowBusy ? prompt !== "busy" : prompt !== "restart")
      || stateRef.current.restarting
    ) return;
    const requestEpoch = ++requestEpochRef.current;
    pendingRequestRef.current = {
      epoch: requestEpoch,
      expectedEnableBeta: stateRef.current.enableBeta
    };
    setState((current) => ({ ...current, restarting: true, error: undefined }));
    try {
      const result = await api.relaunchForChannelChange({ allowBusy });
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
      finishPendingRequest(requestEpoch, pendingRequestRef);
      if (result.accepted) return;
      if (!allowBusy && result.reason === "busy") {
        setState((current) => ({ ...current, restarting: false, restartPrompt: "busy" }));
        return;
      }
      setState((current) => ({ ...current, restarting: false, error: "relaunch" }));
    } catch {
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
      finishPendingRequest(requestEpoch, pendingRequestRef);
      setState((current) => ({ ...current, restarting: false, error: "relaunch" }));
    }
  }, []);

  return { state, reload: requestSettings, setEnableBeta, reset, dismissRestart, relaunch };
}

function normalizeSettings(settings: JokoDesktopUpdateChannelSettings): JokoDesktopUpdateChannelSettings | undefined {
  if (
    typeof settings?.enableBeta !== "boolean"
    || typeof settings.isCustomized !== "boolean"
    || typeof settings.defaultEnableBeta !== "boolean"
  ) return undefined;
  return {
    enableBeta: settings.enableBeta,
    isCustomized: settings.isCustomized,
    defaultEnableBeta: settings.defaultEnableBeta
  };
}

function readyState(settings: JokoDesktopUpdateChannelSettings): DesktopBetaChannelState {
  return {
    ...settings,
    available: true,
    loading: false,
    saving: false,
    restarting: false
  };
}

function requestIsCurrent(
  api: DesktopBetaChannelApi,
  requestEpoch: number,
  activeApiRef: { readonly current: DesktopBetaChannelApi | undefined },
  requestEpochRef: { readonly current: number }
): boolean {
  return activeApiRef.current === api && requestEpochRef.current === requestEpoch;
}

function finishPendingRequest(
  requestEpoch: number,
  pendingRequestRef: { current: PendingRequest | undefined }
): void {
  if (pendingRequestRef.current?.epoch === requestEpoch) pendingRequestRef.current = undefined;
}

function observedSettings(
  requestEpoch: number,
  pendingRequestRef: { readonly current: PendingRequest | undefined },
  latestSettingsRef: { readonly current: JokoDesktopUpdateChannelSettings }
): JokoDesktopUpdateChannelSettings | undefined {
  const pending = pendingRequestRef.current;
  return pending?.epoch === requestEpoch && pending.observedMatch === true
    ? latestSettingsRef.current
    : undefined;
}

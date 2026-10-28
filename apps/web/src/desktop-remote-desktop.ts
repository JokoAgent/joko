import { useCallback, useEffect, useRef, useState } from "react";

const DESKTOP_REMOTE_DESKTOP_CAPABILITY = "remote.desktopHost" satisfies JokoDesktopCapability;

type DesktopRemoteDesktopApi = Pick<
  JokoDesktopApi["remoteDesktop"],
  "getState" | "setEnabled" | "configureWindowsSupport" | "disconnect" | "showPermissionGuide" | "onStateChanged"
>;

export type DesktopRemoteDesktopError = "load" | "save" | "disconnect" | "permissions" | "windowsSupport";

export interface DesktopRemoteDesktopState extends JokoDesktopRemoteDesktopSnapshot {
  readonly available: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error?: DesktopRemoteDesktopError;
}

const EMPTY_SNAPSHOT: JokoDesktopRemoteDesktopSnapshot = Object.freeze({
  enabled: false,
  active: false,
  controlling: false,
  permissions: Object.freeze({ screenRecording: "unknown", accessibility: "unknown" })
});

const UNAVAILABLE_STATE: DesktopRemoteDesktopState = Object.freeze({
  ...EMPTY_SNAPSHOT,
  available: false,
  loading: false,
  saving: false
});

const LOADING_STATE: DesktopRemoteDesktopState = Object.freeze({
  ...EMPTY_SNAPSHOT,
  available: true,
  loading: true,
  saving: false
});

export function desktopRemoteDesktopApi(): DesktopRemoteDesktopApi | undefined {
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  if (desktop === undefined
    || !Array.isArray(desktop.capabilities)
    || !desktop.capabilities.includes(DESKTOP_REMOTE_DESKTOP_CAPABILITY)) return undefined;
  const api = desktop.remoteDesktop;
  return typeof api?.getState === "function"
    && typeof api.setEnabled === "function"
    && typeof api.configureWindowsSupport === "function"
    && typeof api.disconnect === "function"
    && typeof api.showPermissionGuide === "function"
    && typeof api.onStateChanged === "function"
    ? api
    : undefined;
}

export function useDesktopRemoteDesktop(refreshWindowsSupport = false): {
  readonly state: DesktopRemoteDesktopState;
  readonly reload: () => Promise<void>;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  readonly configureWindowsSupport: (enabled: boolean) => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly showPermissionGuide: () => Promise<void>;
} {
  const initialApi = desktopRemoteDesktopApi();
  const [state, setState] = useState<DesktopRemoteDesktopState>(
    initialApi === undefined ? UNAVAILABLE_STATE : LOADING_STATE
  );
  const activeApiRef = useRef<DesktopRemoteDesktopApi | undefined>(undefined);
  const requestEpochRef = useRef(0);
  const snapshotRevisionRef = useRef(0);
  const ownerEpochRef = useRef(0);
  const confirmedRef = useRef<JokoDesktopRemoteDesktopSnapshot | undefined>(undefined);
  const mutationFlightRef = useRef<object | undefined>(undefined);
  const readFlightRef = useRef<object | undefined>(undefined);

  const reload = useCallback(async (initialRevision?: number, background = false): Promise<void> => {
    const api = activeApiRef.current;
    if (api === undefined || mutationFlightRef.current !== undefined || (background && readFlightRef.current !== undefined)) return;
    const readFlight = {};
    readFlightRef.current = readFlight;
    const requestEpoch = ++requestEpochRef.current;
    const snapshotRevision = initialRevision ?? snapshotRevisionRef.current;
    if (!background && snapshotRevisionRef.current === snapshotRevision) {
      setState((current) => current.available
        ? { ...current, loading: confirmedRef.current === undefined, error: undefined }
        : current);
    }
    try {
      const snapshot = normalizeSnapshot(await (refreshWindowsSupport ? api.getState(true) : api.getState()));
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)
        || snapshotRevisionRef.current !== snapshotRevision) return;
      confirmedRef.current = snapshot;
      setState((current) => ({ ...readyState(snapshot), ...(background && current.error !== undefined ? { error: current.error } : {}) }));
    } catch {
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)
        || snapshotRevisionRef.current !== snapshotRevision) return;
      if (!background) setState((current) => ({ ...current, loading: false, saving: false, error: "load" }));
    } finally {
      if (readFlightRef.current === readFlight) readFlightRef.current = undefined;
    }
  }, [refreshWindowsSupport]);

  useEffect(() => {
    const api = desktopRemoteDesktopApi();
    activeApiRef.current = api;
    const ownerEpoch = ++ownerEpochRef.current;
    confirmedRef.current = undefined;
    mutationFlightRef.current = undefined;
    readFlightRef.current = undefined;
    snapshotRevisionRef.current += 1;
    const initialRevision = snapshotRevisionRef.current;
    requestEpochRef.current += 1;
    let unsubscribe: (() => void) | undefined;
    if (api === undefined) {
      setState(UNAVAILABLE_STATE);
    } else {
      setState(LOADING_STATE);
      try {
        unsubscribe = api.onStateChanged((payload) => {
          if (activeApiRef.current !== api || ownerEpochRef.current !== ownerEpoch) return;
          let snapshot: JokoDesktopRemoteDesktopSnapshot;
          try {
            snapshot = normalizeSnapshot(payload);
          } catch {
            return;
          }
          snapshotRevisionRef.current += 1;
          confirmedRef.current = snapshot;
          setState({ ...readyState(snapshot), saving: mutationFlightRef.current !== undefined });
        });
        void reload(initialRevision);
      } catch {
        setState({ ...LOADING_STATE, loading: false, error: "load" });
      }
    }
    return () => {
      ownerEpochRef.current += 1;
      if (activeApiRef.current === api) activeApiRef.current = undefined;
      requestEpochRef.current += 1;
      mutationFlightRef.current = undefined;
      readFlightRef.current = undefined;
      try {
        unsubscribe?.();
      } catch {
        // Observer cleanup cannot fail the component's retirement.
      }
    };
  }, [initialApi, reload]);

  useEffect(() => {
    if (!refreshWindowsSupport || initialApi === undefined) return;
    const timer = window.setInterval(() => { void reload(undefined, true); }, 2_000);
    return () => window.clearInterval(timer);
  }, [initialApi, refreshWindowsSupport, reload]);

  const mutate = useCallback(async (
    operation: (api: DesktopRemoteDesktopApi) => Promise<JokoDesktopRemoteDesktopSnapshot>,
    error: Exclude<DesktopRemoteDesktopError, "load">
  ): Promise<void> => {
    const api = activeApiRef.current;
    if (api === undefined || confirmedRef.current === undefined || mutationFlightRef.current !== undefined) return;
    const flight = {};
    mutationFlightRef.current = flight;
    const requestEpoch = ++requestEpochRef.current;
    const snapshotRevision = snapshotRevisionRef.current;
    setState((current) => current.available
      ? { ...current, loading: false, saving: true, error: undefined }
      : current);
    try {
      const snapshot = normalizeSnapshot(await operation(api));
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
      const hasNewerSnapshot = snapshotRevisionRef.current !== snapshotRevision;
      if (hasNewerSnapshot && error !== "windowsSupport") return;
      const adopted = hasNewerSnapshot && confirmedRef.current !== undefined
        ? { ...confirmedRef.current, ...(snapshot.windowsSupport === undefined ? {} : { windowsSupport: snapshot.windowsSupport,
          windowsSupportDiagnostic: snapshot.windowsSupportDiagnostic }) }
        : snapshot;
      confirmedRef.current = adopted;
      setState({ ...readyState(adopted), saving: true });
    } catch {
      if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)
        || (snapshotRevisionRef.current !== snapshotRevision && error !== "windowsSupport")) return;
      const recoveryRevision = snapshotRevisionRef.current;
      try {
        const snapshot = normalizeSnapshot(await (refreshWindowsSupport ? api.getState(true) : api.getState()));
        if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
        if (snapshotRevisionRef.current === recoveryRevision) {
          confirmedRef.current = snapshot;
          setState({ ...readyState(snapshot), saving: true, error });
        } else if (error === "windowsSupport") {
          setState((current) => ({ ...current, saving: true, error }));
        }
      } catch {
        if (!requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) return;
        setState((current) => ({
          ...current,
          error: snapshotRevisionRef.current === recoveryRevision ? "load" : error
        }));
      }
    } finally {
      if (mutationFlightRef.current === flight) mutationFlightRef.current = undefined;
      if (requestIsCurrent(api, requestEpoch, activeApiRef, requestEpochRef)) {
        setState((current) => ({ ...current, saving: false }));
      }
    }
  }, [refreshWindowsSupport]);

  const setEnabled = useCallback((enabled: boolean): Promise<void> =>
    mutate((api) => api.setEnabled(enabled), "save"), [mutate]);
  const configureWindowsSupport = useCallback((enabled: boolean): Promise<void> =>
    mutate((api) => api.configureWindowsSupport(enabled), "windowsSupport"), [mutate]);
  const disconnect = useCallback((): Promise<void> =>
    mutate((api) => api.disconnect(), "disconnect"), [mutate]);
  const showPermissionGuide = useCallback((): Promise<void> => mutate(async (api) => {
    const permissions = normalizePermissions(await api.showPermissionGuide());
    const snapshot = confirmedRef.current;
    if (snapshot === undefined) throw new TypeError("Remote Desktop state is not loaded.");
    return { ...snapshot, permissions };
  }, "permissions"), [mutate]);

  return { state, reload, setEnabled, configureWindowsSupport, disconnect, showPermissionGuide };
}

function requestIsCurrent(
  api: DesktopRemoteDesktopApi,
  requestEpoch: number,
  activeApiRef: { readonly current: DesktopRemoteDesktopApi | undefined },
  requestEpochRef: { readonly current: number }
): boolean {
  return activeApiRef.current === api && requestEpochRef.current === requestEpoch;
}

function readyState(snapshot: JokoDesktopRemoteDesktopSnapshot): DesktopRemoteDesktopState {
  return { ...snapshot, available: true, loading: false, saving: false };
}

function normalizeSnapshot(value: unknown): JokoDesktopRemoteDesktopSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid Remote Desktop state.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["enabled"] !== "boolean"
    || typeof record["active"] !== "boolean"
    || typeof record["controlling"] !== "boolean") {
    throw new TypeError("Invalid Remote Desktop state.");
  }
  const controllerDeviceId = optionalIdentity(record["controllerDeviceId"]);
  const displayId = optionalIdentity(record["displayId"]);
  const windowsSupport = record["windowsSupport"];
  const windowsSupportDiagnostic = Object.hasOwn(record, "windowsSupportDiagnostic")
    ? normalizeWindowsSupportDiagnostic(record["windowsSupportDiagnostic"]) : undefined;
  if ((Object.hasOwn(record, "windowsSupport") && !isWindowsSupport(windowsSupport))
    || (windowsSupportDiagnostic !== undefined && !isWindowsSupport(windowsSupport))) {
    throw new TypeError("Invalid Remote Desktop service support.");
  }
  if ((!record["active"] && record["controlling"])
    || (record["active"] && (controllerDeviceId === undefined || displayId === undefined))) {
    throw new TypeError("Invalid Remote Desktop state.");
  }
  return {
    enabled: record["enabled"],
    active: record["active"],
    controlling: record["controlling"],
    ...(controllerDeviceId === undefined ? {} : { controllerDeviceId }),
    ...(displayId === undefined ? {} : { displayId }),
    ...(isWindowsSupport(windowsSupport) ? { windowsSupport } : {}),
    ...(windowsSupportDiagnostic === undefined ? {} : { windowsSupportDiagnostic }),
    permissions: normalizePermissions(record["permissions"])
  };
}

function isWindowsSupport(value: unknown): value is JokoDesktopRemoteDesktopWindowsSupport {
  return value === "ready" || value === "missing" || value === "installRequired" || value === "unavailable";
}

function normalizeWindowsSupportDiagnostic(value: unknown): NonNullable<JokoDesktopRemoteDesktopSnapshot["windowsSupportDiagnostic"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid Windows setup diagnostic.");
  const record = value as Record<string, unknown>;
  const child = Object.hasOwn(record, "childStep");
  const step = (candidate: unknown): candidate is string => typeof candidate === "string" && /^[a-z][a-z-]{0,31}$/u.test(candidate);
  if (Object.keys(record).sort().join(",") !== (child ? "childStep,osError,step" : "osError,step")
    || !step(record["step"]) || (child && !step(record["childStep"]))
    || typeof record["osError"] !== "number" || !Number.isSafeInteger(record["osError"])
    || record["osError"] < 0 || record["osError"] > 0x00ff_ffff) throw new TypeError("Invalid Windows setup diagnostic.");
  return { step: record["step"], osError: record["osError"], ...(child ? { childStep: record["childStep"] as string } : {}) };
}

function normalizePermissions(value: unknown): JokoDesktopRemoteDesktopPermissions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid Remote Desktop permissions.");
  }
  const record = value as Record<string, unknown>;
  if (!isPermissionStatus(record["screenRecording"]) || !isPermissionStatus(record["accessibility"])) {
    throw new TypeError("Invalid Remote Desktop permissions.");
  }
  return { screenRecording: record["screenRecording"], accessibility: record["accessibility"] };
}

function optionalIdentity(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError("Invalid Remote Desktop identity.");
  }
  return value;
}

function isPermissionStatus(value: unknown): value is JokoDesktopRemoteDesktopPermissionStatus {
  return value === "granted" || value === "missing" || value === "unknown" || value === "notRequired";
}

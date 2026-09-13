import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";

import { desktopUpdateApi, useDesktopUpdateStatus } from "../desktop-update.js";
import type { MessageKey } from "../i18n.js";
import {
  acquireStartupUpdateInteractionBarrier,
  isStartupUpdateInteractionBlocked
} from "../startup-update-interaction.js";
import type { Translator } from "./types.js";

export const STARTUP_UPDATE_MIN_VISIBLE_MS = 3_000;
export const STARTUP_UPDATE_READY_VISIBLE_MS = 1_500;

type StartupUpdatePresentation =
  | { readonly phase: "checking" }
  | {
    readonly phase: "downloading";
    readonly version: string;
    readonly progress: number;
    readonly transferred: number;
    readonly total: number;
    readonly bytesPerSecond: number;
  }
  | { readonly phase: "ready"; readonly version: string }
  | { readonly phase: "relaunch-error"; readonly version: string }
  | { readonly phase: "error"; readonly errorKind: JokoDesktopUpdateErrorKind; readonly version?: string };

interface StartupUpdateBackgroundState {
  readonly inert: boolean;
  readonly hadInertAttribute: boolean;
  readonly inertAttribute: string | null;
  readonly hadAriaHiddenAttribute: boolean;
  readonly ariaHiddenAttribute: string | null;
}

export function StartupUpdateOverlay({ t }: { readonly t: Translator }): JSX.Element | null {
  const status = useDesktopUpdateStatus();
  const statusPresentation = useMemo(() => startupUpdatePresentation(status), [status]);
  const [relaunchErrorVersion, setRelaunchErrorVersion] = useState<string>();
  const livePresentation = useMemo<StartupUpdatePresentation | undefined>(() => (
    status?.startup === true
      && status.status === "ready"
      && relaunchErrorVersion === status.version
      ? { phase: "relaunch-error", version: status.version }
      : statusPresentation
  ), [relaunchErrorVersion, status, statusPresentation]);
  const [heldPresentation, setHeldPresentation] = useState<StartupUpdatePresentation>();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<MessageKey>();
  const visibleSinceRef = useRef<number | undefined>(undefined);
  const readySinceRef = useRef<number | undefined>(undefined);
  const previousLivePhaseRef = useRef<string | undefined>(undefined);
  const relaunchAttemptedRef = useRef(false);
  const mountedRef = useRef(false);
  const statusRef = useRef<JokoDesktopUpdateStatus | undefined>(status);
  const actionEpochRef = useRef(0);
  const actionInFlightRef = useRef(false);
  const actionKey = startupUpdateActionKey(status);
  const actionKeyRef = useRef<string | undefined>(undefined);
  const overlayRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const progressRef = useRef<{ readonly version: string; readonly value: number } | undefined>(undefined);
  const presentation = livePresentation ?? heldPresentation;
  const interactionBlocked = presentation !== undefined;

  const now = Date.now();
  if (livePresentation !== undefined && visibleSinceRef.current === undefined) {
    visibleSinceRef.current = now;
  }
  const livePhaseKey = livePresentation === undefined
    ? undefined
    : livePresentation.phase === "ready"
      ? `ready\0${livePresentation.version}`
      : livePresentation.phase;
  if (livePresentation?.phase === "ready") {
    if (previousLivePhaseRef.current !== livePhaseKey) readySinceRef.current = now;
  } else if (livePresentation !== undefined) {
    readySinceRef.current = undefined;
  }
  if (livePresentation !== undefined) previousLivePhaseRef.current = livePhaseKey;

  if (actionKeyRef.current !== actionKey) {
    actionEpochRef.current += 1;
    actionInFlightRef.current = false;
  }
  actionKeyRef.current = actionKey;
  statusRef.current = status;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      actionEpochRef.current += 1;
      actionInFlightRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const blockKeydown = (event: KeyboardEvent): void => {
      if (!isStartupUpdateInteractionBlocked()) return;
      const allowedTarget = startupUpdateTargetIsAllowed(event.target, overlayRef.current);
      const activationKey = event.key === "Tab" || event.key === "Enter" || event.key === " " || event.key === "Spacebar";
      if (allowedTarget && activationKey && !event.metaKey && !event.ctrlKey && !event.altKey) return;
      stopStartupUpdateEvent(event);
    };
    const blockBackgroundEvent = (event: Event): void => {
      if (
        !isStartupUpdateInteractionBlocked()
        || startupUpdateTargetIsAllowed(event.target, overlayRef.current)
      ) return;
      stopStartupUpdateEvent(event);
    };
    const fenceFocus = (event: FocusEvent): void => {
      if (
        !isStartupUpdateInteractionBlocked()
        || startupUpdateTargetIsAllowed(event.target, overlayRef.current)
      ) return;
      event.stopImmediatePropagation();
      focusStartupUpdateSurface(overlayRef.current, retryRef.current);
    };
    window.addEventListener("keydown", blockKeydown, true);
    window.addEventListener("pointerdown", blockBackgroundEvent, true);
    window.addEventListener("click", blockBackgroundEvent, true);
    window.addEventListener("submit", blockBackgroundEvent, true);
    window.addEventListener("focusin", fenceFocus, true);
    return () => {
      window.removeEventListener("keydown", blockKeydown, true);
      window.removeEventListener("pointerdown", blockBackgroundEvent, true);
      window.removeEventListener("click", blockBackgroundEvent, true);
      window.removeEventListener("submit", blockBackgroundEvent, true);
      window.removeEventListener("focusin", fenceFocus, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (!interactionBlocked) return;
    const overlay = overlayRef.current;
    const releaseInteractionBarrier = acquireStartupUpdateInteractionBarrier();
    const backgroundStates = new Map<HTMLElement, StartupUpdateBackgroundState>();
    const makeBackgroundInert = (element: HTMLElement): void => {
      if (backgroundStates.has(element)) return;
      backgroundStates.set(element, captureStartupUpdateBackgroundState(element));
      element.inert = true;
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
    };
    const discoverBackgroundApps = (node: Node): void => {
      if (!(node instanceof Element)) return;
      if (node.matches(".app")) makeBackgroundInert(node as HTMLElement);
      for (const app of node.querySelectorAll<HTMLElement>(".app")) makeBackgroundInert(app);
    };
    for (const app of document.querySelectorAll<HTMLElement>(".app")) makeBackgroundInert(app);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) discoverBackgroundApps(node);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const activeElement = document.activeElement;
    const previousBackgroundFocus = activeElement instanceof HTMLElement
      && !startupUpdateTargetIsAllowed(activeElement, overlay)
      ? activeElement
      : undefined;
    if (!startupUpdateTargetIsAllowed(activeElement, overlay)) {
      focusStartupUpdateSurface(overlay, retryRef.current);
    }

    return () => {
      observer.disconnect();
      for (const [element, state] of backgroundStates) restoreStartupUpdateBackgroundState(element, state);
      releaseInteractionBarrier();
      const currentFocus = document.activeElement;
      if (
        previousBackgroundFocus?.isConnected === true
        && (currentFocus === document.body || currentFocus === null || (currentFocus instanceof Node && overlay?.contains(currentFocus) === true))
      ) previousBackgroundFocus.focus({ preventScroll: true });
    };
  }, [interactionBlocked]);

  useLayoutEffect(() => {
    if (
      interactionBlocked
      && !startupUpdateTargetIsAllowed(document.activeElement, overlayRef.current)
    ) focusStartupUpdateSurface(overlayRef.current, retryRef.current);
  }, [interactionBlocked, presentation?.phase]);

  useEffect(() => {
    if (livePresentation !== undefined) {
      setHeldPresentation(livePresentation);
      return;
    }
    if (heldPresentation === undefined) return;
    const deadline = Math.max(
      (visibleSinceRef.current ?? Date.now()) + STARTUP_UPDATE_MIN_VISIBLE_MS,
      readySinceRef.current === undefined ? 0 : readySinceRef.current + STARTUP_UPDATE_READY_VISIBLE_MS
    );
    const delay = Math.max(0, deadline - Date.now());
    const timer = window.setTimeout(() => {
      setHeldPresentation(undefined);
      visibleSinceRef.current = undefined;
      readySinceRef.current = undefined;
      previousLivePhaseRef.current = undefined;
      progressRef.current = undefined;
    }, delay);
    return () => window.clearTimeout(timer);
  }, [heldPresentation, livePresentation]);

  useEffect(() => {
    setRetrying(false);
    setRetryError(undefined);
    setRelaunchErrorVersion(undefined);
  }, [actionKey]);

  useEffect(() => {
    if (livePresentation?.phase !== "ready" || relaunchAttemptedRef.current) return;
    const version = livePresentation.version;
    const deadline = Math.max(
      (visibleSinceRef.current ?? Date.now()) + STARTUP_UPDATE_MIN_VISIBLE_MS,
      (readySinceRef.current ?? Date.now()) + STARTUP_UPDATE_READY_VISIBLE_MS
    );
    const timer = window.setTimeout(() => {
      const current = statusRef.current;
      if (
        relaunchAttemptedRef.current
        || current?.startup !== true
        || current.status !== "ready"
        || current.version !== version
      ) return;
      relaunchAttemptedRef.current = true;
      const epoch = actionEpochRef.current;
      const readyKey = startupUpdateActionKey(current);
      const exposeFailure = (): void => {
        if (!startupUpdateActionIsCurrent(epoch, readyKey, mountedRef, actionEpochRef, statusRef)) return;
        setRetryError(undefined);
        setRelaunchErrorVersion(version);
      };
      const updates = desktopUpdateApi();
      if (updates === undefined || typeof updates.relaunchStartup !== "function") {
        exposeFailure();
        return;
      }
      // Automatic relaunch remains one-shot. A transport rejection or typed
      // refusal becomes an explicit, user-driven retry instead of either an
      // automatic loop or a permanently unactionable ready screen.
      void updates.relaunchStartup().then((result) => {
        if (!result.accepted) exposeFailure();
      }).catch(exposeFailure);
    }, Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [livePhaseKey]);

  const retry = useCallback(async (): Promise<void> => {
    const failed = statusRef.current;
    if (actionInFlightRef.current || failed?.startup !== true || failed.status !== "error") return;
    const updates = desktopUpdateApi();
    if (updates === undefined || typeof updates.retryStartup !== "function") {
      setRetryError("desktop.startupUpdateRetryFailed");
      return;
    }
    const epoch = ++actionEpochRef.current;
    const failedKey = startupUpdateActionKey(failed);
    actionInFlightRef.current = true;
    setRetrying(true);
    setRetryError(undefined);
    try {
      // Startup retry is main-owned: it binds manifest discovery and download
      // to the exact startup candidate. Generic checks cannot safely release
      // the startup gate or distinguish an older ready artifact.
      const result = await updates.retryStartup();
      if (!startupUpdateActionIsCurrent(epoch, failedKey, mountedRef, actionEpochRef, statusRef)) return;
      if (result.status === "failed") setRetryError("desktop.startupUpdateRetryFailed");
    } catch {
      if (startupUpdateActionIsCurrent(epoch, failedKey, mountedRef, actionEpochRef, statusRef)) {
        setRetryError("desktop.startupUpdateRetryFailed");
      }
    } finally {
      if (mountedRef.current && actionEpochRef.current === epoch) {
        actionInFlightRef.current = false;
        setRetrying(false);
      }
    }
  }, []);

  const retryRelaunch = useCallback(async (): Promise<void> => {
    const ready = statusRef.current;
    if (
      actionInFlightRef.current
      || ready?.startup !== true
      || ready.status !== "ready"
      || relaunchErrorVersion !== ready.version
    ) return;
    const updates = desktopUpdateApi();
    if (updates === undefined || typeof updates.relaunchStartup !== "function") {
      setRetryError("desktop.startupUpdateRelaunchFailed");
      return;
    }
    const epoch = ++actionEpochRef.current;
    const readyKey = startupUpdateActionKey(ready);
    actionInFlightRef.current = true;
    setRetrying(true);
    setRetryError(undefined);
    try {
      const result = await updates.relaunchStartup();
      if (!startupUpdateActionIsCurrent(epoch, readyKey, mountedRef, actionEpochRef, statusRef)) return;
      if (!result.accepted) setRetryError("desktop.startupUpdateRelaunchFailed");
    } catch {
      if (startupUpdateActionIsCurrent(epoch, readyKey, mountedRef, actionEpochRef, statusRef)) {
        setRetryError("desktop.startupUpdateRelaunchFailed");
      }
    } finally {
      if (mountedRef.current && actionEpochRef.current === epoch) {
        actionInFlightRef.current = false;
        setRetrying(false);
      }
    }
  }, [relaunchErrorVersion]);

  const live = livePresentation !== undefined;
  useEffect(() => {
    if (live && (presentation?.phase === "error" || presentation?.phase === "relaunch-error")) {
      retryRef.current?.focus();
    }
  }, [live, presentation?.phase]);

  if (presentation === undefined) return null;

  const title = startupUpdateTitle(presentation, t);
  const progress = presentation.phase === "downloading"
    ? monotonicStartupProgress(presentation, progressRef)
    : undefined;
  const progressSpeed = presentation.phase === "downloading" && presentation.bytesPerSecond > 0
    ? `${formatStartupUpdateBytes(presentation.bytesPerSecond)}/s`
    : undefined;
  const progressAmounts = presentation.phase === "downloading"
    && presentation.transferred > 0
    && presentation.total > 0
    ? {
      transferred: formatStartupUpdateBytes(presentation.transferred),
      total: formatStartupUpdateBytes(presentation.total)
    }
    : undefined;
  const failed = presentation.phase === "error" || presentation.phase === "relaunch-error";
  const failureMessage = presentation.phase === "relaunch-error"
    ? t(retryError ?? "desktop.startupUpdateRelaunchFailed")
    : t(retryError ?? "desktop.startupUpdateFailed");
  return (
    <div
      ref={overlayRef}
      className="startup-update-overlay"
      data-phase={presentation.phase}
      role="dialog"
      tabIndex={-1}
      aria-modal="true"
      aria-labelledby="startup-update-title"
      aria-describedby={failed ? "startup-update-error" : undefined}
    >
      <div className="startup-update-overlay__brand" aria-hidden="true" />
      <section
        className="startup-update-overlay__panel"
        role={failed ? "alert" : "status"}
        aria-live={failed ? "assertive" : "polite"}
        aria-busy={!failed || retrying}
      >
        <h1 id="startup-update-title">{title}</h1>
        {!failed && <span className="startup-update-overlay__spinner" aria-hidden="true" />}
        {progress !== undefined && (
          <>
            <div
              className="startup-update-overlay__progress"
              role="progressbar"
              aria-label={t("desktop.startupUpdateProgressAria", { progress })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <span style={{ width: `${progress}%` }} />
            </div>
            <p className="startup-update-overlay__stats">
              <span>{progress}%</span>
              {progressSpeed !== undefined && <>
                <span aria-hidden="true">·</span>
                <span aria-label={t("desktop.startupUpdateSpeedAria", { speed: progressSpeed })}>{progressSpeed}</span>
              </>}
              {progressAmounts !== undefined && <>
                <span aria-hidden="true">·</span>
                <span aria-label={t("desktop.startupUpdateTransferredAria", progressAmounts)}>
                  {progressAmounts.transferred} / {progressAmounts.total}
                </span>
              </>}
            </p>
          </>
        )}
        {failed && (
          <>
            <p id="startup-update-error" className="startup-update-overlay__error">
              {failureMessage}
            </p>
            <button
              ref={retryRef}
              type="button"
              className="button button--primary"
              disabled={!live || retrying}
              onClick={() => {
                void (presentation.phase === "relaunch-error" ? retryRelaunch() : retry());
              }}
            >
              {retrying ? t("desktop.startupUpdateRetrying") : t("common.retry")}
            </button>
          </>
        )}
      </section>
    </div>
  );
}

function startupUpdatePresentation(status: JokoDesktopUpdateStatus | undefined): StartupUpdatePresentation | undefined {
  if (status?.startup !== true) return undefined;
  if (status.status === "checking") return { phase: "checking" };
  if (status.status === "downloading") {
    return {
      phase: "downloading",
      version: status.version,
      progress: status.progress,
      transferred: status.transferred,
      total: status.total,
      bytesPerSecond: status.bytesPerSecond
    };
  }
  if (status.status === "superseding") {
    return {
      phase: "downloading",
      version: status.nextVersion,
      progress: status.progress,
      transferred: status.transferred,
      total: status.total,
      bytesPerSecond: status.bytesPerSecond
    };
  }
  if (status.status === "ready") return { phase: "ready", version: status.version };
  if (status.status === "error") {
    return {
      phase: "error",
      errorKind: status.errorKind,
      ...(status.version === undefined ? {} : { version: status.version })
    };
  }
  return undefined;
}

function startupUpdateTitle(presentation: StartupUpdatePresentation, t: Translator): string {
  if (presentation.phase === "checking") return t("desktop.startupUpdateChecking");
  if (presentation.phase === "downloading") return t("desktop.startupUpdateDownloading");
  if (presentation.phase === "ready") return t("desktop.startupUpdateReady");
  return t("desktop.startupUpdateErrorTitle");
}

function monotonicStartupProgress(
  presentation: Extract<StartupUpdatePresentation, { readonly phase: "downloading" }>,
  progressRef: { current: { readonly version: string; readonly value: number } | undefined }
): number {
  const next = Math.min(100, Math.max(0, Math.round(presentation.progress)));
  if (progressRef.current?.version !== presentation.version) {
    progressRef.current = { version: presentation.version, value: next };
    return next;
  }
  const value = Math.max(progressRef.current.value, next);
  progressRef.current = { version: presentation.version, value };
  return value;
}

function formatStartupUpdateBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function startupUpdateActionKey(status: JokoDesktopUpdateStatus | undefined): string | undefined {
  if (status?.startup !== true) return undefined;
  if (status.status === "error") return `error\0${status.errorKind}\0${status.version ?? ""}`;
  if (status.status === "ready" || status.status === "downloading") return `${status.status}\0${status.version}`;
  if (status.status === "superseding") return `superseding\0${status.version}\0${status.nextVersion}`;
  return status.status;
}

function startupUpdateActionIsCurrent(
  epoch: number,
  failedKey: string | undefined,
  mountedRef: { readonly current: boolean },
  epochRef: { readonly current: number },
  statusRef: { readonly current: JokoDesktopUpdateStatus | undefined }
): boolean {
  return mountedRef.current
    && epochRef.current === epoch
    && startupUpdateActionKey(statusRef.current) === failedKey;
}

function startupUpdateTargetIsAllowed(target: EventTarget | null, overlay: HTMLElement | null): boolean {
  if (!(target instanceof Node)) return false;
  if (overlay?.contains(target) === true) return true;
  return target instanceof Element && target.closest(".desktop-window-controls") !== null;
}

function stopStartupUpdateEvent(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function focusStartupUpdateSurface(
  overlay: HTMLElement | null,
  retry: HTMLButtonElement | null
): void {
  const target = retry?.disabled === false ? retry : overlay;
  target?.focus({ preventScroll: true });
}

function captureStartupUpdateBackgroundState(element: HTMLElement): StartupUpdateBackgroundState {
  return {
    inert: element.inert === true,
    hadInertAttribute: element.hasAttribute("inert"),
    inertAttribute: element.getAttribute("inert"),
    hadAriaHiddenAttribute: element.hasAttribute("aria-hidden"),
    ariaHiddenAttribute: element.getAttribute("aria-hidden")
  };
}

function restoreStartupUpdateBackgroundState(
  element: HTMLElement,
  state: StartupUpdateBackgroundState
): void {
  element.inert = state.inert;
  restoreExactAttribute(element, "inert", state.hadInertAttribute, state.inertAttribute);
  restoreExactAttribute(element, "aria-hidden", state.hadAriaHiddenAttribute, state.ariaHiddenAttribute);
}

function restoreExactAttribute(
  element: HTMLElement,
  name: string,
  existed: boolean,
  value: string | null
): void {
  if (existed) element.setAttribute(name, value ?? "");
  else element.removeAttribute(name);
}

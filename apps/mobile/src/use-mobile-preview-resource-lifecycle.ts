import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  createMobilePreviewResourceLifecycle,
  type MobilePreviewRecoveryDecision
} from "./mobile-preview-resource-lifecycle";
import {
  mobileResourcePressureSupported,
  subscribeMobileResourcePressure
} from "./mobile-resource-pressure";

export type MobilePreviewResourcePhase = "active" | "suspended" | "recovering" | "failed";
export type MobilePreviewResourceFailure = "unavailable" | "recovery-exhausted";

export interface MobilePreviewResourceBinding {
  readonly phase: MobilePreviewResourcePhase;
  readonly rendererGeneration: number;
  readonly rendererMounted: boolean;
  readonly rendererToken: string;
  ownsRenderer(token: string): boolean;
  onRendererReady(token: string): void;
  onRendererProcessLost(token: string): boolean;
}

export function useMobilePreviewResourceLifecycle({
  ownerKey,
  releaseRenderer,
  reportFailure
}: {
  readonly ownerKey: string;
  readonly releaseRenderer: () => void;
  readonly reportFailure: (failure: MobilePreviewResourceFailure) => void;
}): MobilePreviewResourceBinding {
  const supported = mobileResourcePressureSupported();
  const initialForeground = AppState.currentState === "active";
  const lifecycleRef = useRef(createMobilePreviewResourceLifecycle(initialForeground));
  const ownerRef = useRef(ownerKey);
  const foregroundRef = useRef(initialForeground);
  const generationRef = useRef(0);
  const rendererMountedRef = useRef(supported && initialForeground);
  const phaseRef = useRef<MobilePreviewResourcePhase>(supported
    ? initialForeground ? "active" : "suspended"
    : "failed");
  const tokenRef = useRef(rendererToken(ownerKey, 0));
  const failureReportedRef = useRef<MobilePreviewResourceFailure | undefined>(undefined);
  const aliveRef = useRef(true);
  const [, render] = useState(0);

  if (ownerRef.current !== ownerKey) {
    ownerRef.current = ownerKey;
    generationRef.current += 1;
    tokenRef.current = rendererToken(ownerKey, generationRef.current);
    lifecycleRef.current.reset(foregroundRef.current);
    if (!supported) lifecycleRef.current.onUnavailable();
    rendererMountedRef.current = supported && foregroundRef.current;
    phaseRef.current = supported
      ? foregroundRef.current ? "active" : "suspended"
      : "failed";
    failureReportedRef.current = undefined;
  }

  const refresh = useCallback(() => {
    if (aliveRef.current) render((value) => value + 1);
  }, []);

  const fail = useCallback((failure: MobilePreviewResourceFailure) => {
    rendererMountedRef.current = false;
    phaseRef.current = "failed";
    if (failureReportedRef.current !== failure) {
      failureReportedRef.current = failure;
      reportFailure(failure);
    }
    refresh();
  }, [refresh, reportFailure]);

  const retireRenderer = useCallback(() => {
    generationRef.current += 1;
    tokenRef.current = rendererToken(ownerRef.current, generationRef.current);
    rendererMountedRef.current = false;
    releaseRenderer();
  }, [releaseRenderer]);

  const applyRecovery = useCallback((decision: MobilePreviewRecoveryDecision) => {
    if (decision === "failed") {
      fail("recovery-exhausted");
      return;
    }
    if (decision === "wait") {
      rendererMountedRef.current = false;
      phaseRef.current = "suspended";
      refresh();
      return;
    }
    rendererMountedRef.current = true;
    phaseRef.current = "recovering";
    refresh();
  }, [fail, refresh]);

  useEffect(() => {
    aliveRef.current = true;
    if (!supported) {
      lifecycleRef.current.onUnavailable();
      releaseRenderer();
      fail("unavailable");
      return () => { aliveRef.current = false; };
    }
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      const foreground = state === "active";
      foregroundRef.current = foreground;
      if (!foreground) {
        lifecycleRef.current.onNotForeground();
        retireRenderer();
        phaseRef.current = "suspended";
        refresh();
        return;
      }
      const decision = lifecycleRef.current.onForeground();
      if (decision) applyRecovery(decision);
    });
    const pressureSubscription = subscribeMobileResourcePressure(() => {
      retireRenderer();
      applyRecovery(lifecycleRef.current.onResourcePressure(foregroundRef.current));
    });
    if (!pressureSubscription) {
      lifecycleRef.current.onUnavailable();
      retireRenderer();
      fail("unavailable");
    }
    return () => {
      aliveRef.current = false;
      appStateSubscription.remove();
      pressureSubscription?.remove();
    };
  }, [applyRecovery, fail, refresh, releaseRenderer, retireRenderer, supported]);

  const ownsRenderer = useCallback((token: string): boolean => token === tokenRef.current
    && rendererMountedRef.current && foregroundRef.current && phaseRef.current !== "failed", []);

  const onRendererReady = useCallback((token: string) => {
    if (!ownsRenderer(token)) return;
    lifecycleRef.current.onRendererReady();
    phaseRef.current = "active";
    failureReportedRef.current = undefined;
    refresh();
  }, [ownsRenderer, refresh]);

  const onRendererProcessLost = useCallback((token: string): boolean => {
    if (!ownsRenderer(token)) return true;
    retireRenderer();
    applyRecovery(lifecycleRef.current.onProcessLost(foregroundRef.current));
    return true;
  }, [applyRecovery, ownsRenderer, retireRenderer]);

  return {
    phase: phaseRef.current,
    rendererGeneration: generationRef.current,
    rendererMounted: rendererMountedRef.current,
    rendererToken: tokenRef.current,
    ownsRenderer,
    onRendererReady,
    onRendererProcessLost
  };
}

function rendererToken(ownerKey: string, generation: number): string {
  return `${ownerKey}\u0000${generation.toString(10)}`;
}

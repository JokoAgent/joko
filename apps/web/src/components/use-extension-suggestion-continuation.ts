import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AppController, AppRoute } from "../controller.js";
import {
  advancePendingExtensionSuggestion,
  extensionSuggestionApplicable,
  resolvePendingExtensionSuggestion,
  sameExtensionRecommendation,
  sameExtensionSuggestionOwner,
  type ExtensionSuggestionAdvanceProof
} from "../extension-suggestion-handoff.js";
import type {
  AppSnapshot,
  ExtensionCatalogEntryView,
  PendingExtensionSuggestionView
} from "../model.js";
import { pendingExtensionSuggestionContext } from "../new-session-suggestion-context.js";

export type ExtensionSuggestionContinuationStage =
  | "idle"
  | "loading"
  | "install"
  | "enable"
  | "setup"
  | "ready"
  | "error"
  | "expired";

export interface ExtensionSuggestionContinuationState {
  readonly stage: ExtensionSuggestionContinuationStage;
  readonly pending?: PendingExtensionSuggestionView;
  readonly extension?: ExtensionCatalogEntryView;
  readonly error?: string;
}

interface PendingAdvanceAttempt {
  readonly expected: PendingExtensionSuggestionView;
  readonly proof: ExtensionSuggestionAdvanceProof;
  readonly load: () => Promise<ExtensionCatalogEntryView>;
}

interface ContinuationLifetime {
  readonly ownerKey: string;
  readonly nonce?: string;
  readonly selectedId?: string;
  readonly generation: number;
}

export function useExtensionSuggestionContinuation({ controller, snapshot, nonce, selectedId }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly nonce?: string;
  readonly selectedId?: string;
}): {
  readonly state: ExtensionSuggestionContinuationState;
  readonly retry: () => void;
  readonly cancel: () => void;
  readonly continueToNewTask: () => void;
  readonly advanceAfterMutation: (
    expected: PendingExtensionSuggestionView,
    proof: ExtensionSuggestionAdvanceProof,
    load: () => Promise<ExtensionCatalogEntryView>
  ) => Promise<void>;
} {
  const [state, setState] = useState<ExtensionSuggestionContinuationState>({
    stage: nonce === undefined ? "idle" : "loading"
  });
  const mounted = useRef(false);
  const requestGeneration = useRef(0);
  const lifetimeGeneration = useRef(0);
  const lifetime = useRef<ContinuationLifetime | undefined>(undefined);
  const pendingRef = useRef<PendingExtensionSuggestionView | undefined>(undefined);
  const preservedNonce = useRef<string | undefined>(undefined);
  const advanceAttempt = useRef<PendingAdvanceAttempt | undefined>(undefined);
  const waitingResourceProjection = useRef<string | undefined>(undefined);
  const controllerRef = useRef(controller);
  const snapshotRef = useRef(snapshot);
  const selectedIdRef = useRef(selectedId);
  controllerRef.current = controller;
  snapshotRef.current = snapshot;
  selectedIdRef.current = selectedId;
  const ownerKey = JSON.stringify([
    controller.state.activeProfile?.serverId ?? "",
    controller.state.activeProfile?.id ?? "",
    controller.state.connectionState,
    controller.state.connectionGeneration ?? 0
  ]);

  const expire = useCallback(async (pending: PendingExtensionSuggestionView): Promise<void> => {
    const expiryLifetime = lifetime.current;
    advanceAttempt.current = undefined;
    waitingResourceProjection.current = undefined;
    try {
      const cleared = await controllerRef.current.compareAndSetPendingExtensionSuggestion(pending);
      if (!cleared) {
        if (mounted.current && lifetime.current === expiryLifetime) {
          pendingRef.current = pending;
          setState({ stage: "error", pending });
        }
        return;
      }
    } catch (cause) {
      if (mounted.current && lifetime.current === expiryLifetime) {
        pendingRef.current = pending;
        setState({ stage: "error", pending, error: errorMessage(cause) });
      }
      return;
    }
    if (pendingRef.current?.nonce === pending.nonce) pendingRef.current = undefined;
    if (mounted.current && lifetime.current === expiryLifetime) setState({ stage: "expired" });
  }, []);

  const hydrate = useCallback(async (): Promise<void> => {
    const currentNonce = nonce;
    const request = ++requestGeneration.current;
    advanceAttempt.current = undefined;
    waitingResourceProjection.current = undefined;
    if (pendingRef.current?.nonce !== currentNonce) pendingRef.current = undefined;
    if (currentNonce === undefined) {
      if (mounted.current) setState({ stage: "idle" });
      return;
    }
    if (mounted.current) setState((current) => ({
      stage: "loading",
      ...(current.pending?.nonce === currentNonce ? { pending: current.pending } : {})
    }));
    let pending: PendingExtensionSuggestionView | undefined;
    try {
      pending = await controllerRef.current.readPendingExtensionSuggestion(currentNonce);
      if (!requestIsCurrent(request, currentNonce, requestGeneration, lifetime)) return;
      if (pending === undefined) {
        pendingRef.current = undefined;
        if (mounted.current) setState({ stage: "expired" });
        return;
      }
      pendingRef.current = pending;
      const currentSnapshot = snapshotRef.current;
      if (selectedIdRef.current !== pending.extensionId
        || pendingExtensionSuggestionContext(controllerRef.current, currentSnapshot, pending) !== pending.contextKey) {
        await expire(pending);
        return;
      }
      const catalog = await controllerRef.current.getExtension(
        pending.extensionId,
        pending.runtimeSessionId
      );
      if (!requestIsCurrent(request, currentNonce, requestGeneration, lifetime)) return;
      const extension = catalog.extensions.find((candidate) => candidate.id === pending?.extensionId);
      const stage = extension === undefined
        ? undefined
        : extensionSuggestionContinuationStage(pending, extension, currentSnapshot);
      if (extension === undefined || stage === undefined) {
        await expire(pending);
        return;
      }
      if (mounted.current) setState({ stage, pending, extension });
    } catch (cause) {
      if (!requestIsCurrent(request, currentNonce, requestGeneration, lifetime)) return;
      if (mounted.current) setState({
        stage: "error",
        ...(pending === undefined ? {} : { pending }),
        error: errorMessage(cause)
      });
    }
  }, [expire, nonce]);

  const runAdvanceAttempt = useCallback(async (attempt: PendingAdvanceAttempt): Promise<void> => {
    const operationLifetime = lifetime.current;
    const operationController = controllerRef.current;
    const request = ++requestGeneration.current;
    const ownerIsCurrent = (pending: PendingExtensionSuggestionView): boolean => mounted.current
      && requestGeneration.current === request
      && lifetime.current === operationLifetime
      && selectedIdRef.current === pending.extensionId;
    const contextIsCurrent = (pending: PendingExtensionSuggestionView): boolean => ownerIsCurrent(pending)
      && pendingExtensionSuggestionContext(controllerRef.current, snapshotRef.current, pending) === pending.contextKey;
    if (!ownerIsCurrent(attempt.expected) || pendingRef.current !== attempt.expected) return;
    advanceAttempt.current = attempt;
    if (mounted.current) setState((current) => ({
      stage: "loading",
      pending: attempt.expected,
      ...(current.extension === undefined ? {} : { extension: current.extension })
    }));
    let extension: ExtensionCatalogEntryView;
    try {
      if (!ownerIsCurrent(attempt.expected) || pendingRef.current !== attempt.expected) return;
      if (!contextIsCurrent(attempt.expected)) {
        await expire(attempt.expected);
        return;
      }
      extension = await attempt.load();
      if (!ownerIsCurrent(attempt.expected) || pendingRef.current !== attempt.expected) return;
      if (!contextIsCurrent(attempt.expected)) {
        await expire(attempt.expected);
        return;
      }
      const currentSnapshot = snapshotRef.current;
      const applicabilityContext = {
        backendId: attempt.expected.backendId,
        ...(attempt.expected.targetId === undefined ? {} : { targetId: attempt.expected.targetId }),
        resources: currentSnapshot.resources
      };
      if (!extensionSuggestionApplicable(extension, applicabilityContext)) {
        const currentOwner = extension.owner;
        const adoptionProjectionPending = attempt.expected.owner.kind === "source"
          && attempt.proof.kind === "packageAdoption"
          && currentOwner.kind === "resource"
          && !currentSnapshot.resources.some((resource) => resource.id === currentOwner.resourceId);
        if (adoptionProjectionPending) {
          waitingResourceProjection.current = resourceProjectionKey(currentSnapshot);
          if (mounted.current) setState({ stage: "error", pending: attempt.expected });
        } else await expire(attempt.expected);
        return;
      }
      const advanced = advancePendingExtensionSuggestion(attempt.expected, extension, attempt.proof, applicabilityContext);
      if (advanced === undefined) {
        await expire(attempt.expected);
        return;
      }
      const changed = await operationController.compareAndSetPendingExtensionSuggestion(attempt.expected, advanced);
      if (!contextIsCurrent(attempt.expected) || pendingRef.current !== attempt.expected) {
        if (changed) await operationController.compareAndSetPendingExtensionSuggestion(advanced).catch(() => false);
        return;
      }
      if (!changed) {
        advanceAttempt.current = undefined;
        await hydrate();
        return;
      }
      advanceAttempt.current = undefined;
      waitingResourceProjection.current = undefined;
      pendingRef.current = advanced;
      const stage = pendingExtensionSuggestionContext(controllerRef.current, currentSnapshot, advanced) === advanced.contextKey
        ? extensionSuggestionContinuationStage(advanced, extension, currentSnapshot)
        : undefined;
      if (stage === undefined) {
        await expire(advanced);
        return;
      }
      if (mounted.current) setState({ stage, pending: advanced, extension });
    } catch (cause) {
      if (ownerIsCurrent(attempt.expected) && pendingRef.current === attempt.expected) setState({
        stage: "error",
        pending: attempt.expected,
        error: errorMessage(cause)
      });
    }
  }, [expire, hydrate]);

  useEffect(() => {
    mounted.current = true;
    const currentLifetimeController = controllerRef.current;
    const currentLifetime: ContinuationLifetime = {
      ownerKey,
      nonce,
      selectedId,
      generation: ++lifetimeGeneration.current
    };
    lifetime.current = currentLifetime;
    void hydrate();
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
      const captured = pendingRef.current;
      queueMicrotask(() => {
        const active = lifetime.current;
        const strictModeReplay = active !== undefined
          && active.generation !== currentLifetime.generation
          && active.ownerKey === ownerKey
          && active.nonce === nonce
          && active.selectedId === selectedId;
        if (strictModeReplay || nonce === undefined || preservedNonce.current === nonce) return;
        void (async () => {
          const pending = captured ?? await currentLifetimeController.readPendingExtensionSuggestion(nonce).catch(() => undefined);
          if (pending !== undefined) await currentLifetimeController.compareAndSetPendingExtensionSuggestion(pending).catch(() => false);
        })();
      });
    };
  }, [hydrate, nonce, ownerKey, selectedId]);

  const liveContext = useMemo(() => state.pending === undefined
    ? undefined
    : pendingExtensionSuggestionContext(controller, snapshot, state.pending), [controller, snapshot, state.pending]);
  useEffect(() => {
    const pending = state.pending;
    if (pending === undefined || state.stage === "loading" || state.stage === "error" || state.stage === "expired" || state.stage === "idle"
      || liveContext === pending.contextKey) return;
    void expire(pending);
  }, [expire, liveContext, state.pending, state.stage]);
  const currentResourceProjection = useMemo(() => resourceProjectionKey(snapshot), [snapshot.resources]);
  useEffect(() => {
    const attempt = advanceAttempt.current;
    const waiting = waitingResourceProjection.current;
    if (state.stage !== "error" || attempt === undefined || waiting === undefined || waiting === currentResourceProjection) return;
    waitingResourceProjection.current = undefined;
    void runAdvanceAttempt(attempt);
  }, [currentResourceProjection, runAdvanceAttempt, state.stage]);

  const retry = (): void => {
    const attempt = advanceAttempt.current;
    if (attempt === undefined) void hydrate();
    else void runAdvanceAttempt(attempt);
  };
  const cancel = (): void => {
    const pending = pendingRef.current;
    if (pending === undefined) return;
    const request = ++requestGeneration.current;
    setState({ stage: "loading", pending });
    void controller.compareAndSetPendingExtensionSuggestion(pending).then((cleared) => {
      if (!mounted.current || request !== requestGeneration.current) return;
      if (!cleared) {
        void hydrate();
        return;
      }
      pendingRef.current = undefined;
      advanceAttempt.current = undefined;
      waitingResourceProjection.current = undefined;
      controller.navigate(extensionSuggestionNewSessionRoute(pending));
    }).catch((cause: unknown) => {
      if (mounted.current && request === requestGeneration.current) {
        setState({ stage: "error", pending, error: errorMessage(cause) });
      }
    });
  };
  const continueToNewTask = (): void => {
    const pending = pendingRef.current;
    if (pending === undefined || state.stage !== "ready") return;
    preservedNonce.current = pending.nonce;
    controller.navigate(extensionSuggestionNewSessionRoute(pending, true));
  };

  return {
    state,
    retry,
    cancel,
    continueToNewTask,
    advanceAfterMutation: async (expected, proof, load) => {
      await runAdvanceAttempt({ expected, proof, load });
    }
  };
}

/** Classifies only the exact projection persisted in the one-shot handoff. */
export function extensionSuggestionContinuationStage(
  pending: PendingExtensionSuggestionView,
  extension: ExtensionCatalogEntryView,
  snapshot: Pick<AppSnapshot, "targets" | "resources">
): Exclude<ExtensionSuggestionContinuationStage, "idle" | "loading" | "error" | "expired"> | undefined {
  if (extension.id !== pending.extensionId
    || extension.revision.toString(10) !== pending.extensionRevision
    || !sameExtensionSuggestionOwner(extension.owner, pending.owner)
    || !extension.recommendations?.some((candidate) => sameExtensionRecommendation(candidate, pending.recommendation))) return undefined;
  if (pending.phase === "ready") {
    return resolvePendingExtensionSuggestion(pending, {
      revision: extension.revision,
      extensions: [extension],
      recoveredFromCorruption: false
    }, {
      backendId: pending.backendId,
      ...(pending.targetId === undefined ? {} : { targetId: pending.targetId }),
      targets: snapshot.targets,
      resources: snapshot.resources
    }) === undefined ? undefined : "ready";
  }
  if (!extensionSuggestionApplicable(extension, {
    backendId: pending.backendId,
    ...(pending.targetId === undefined ? {} : { targetId: pending.targetId }),
    resources: snapshot.resources
  })) return undefined;
  if (extension.owner.kind === "source") {
    return !extension.installed && extension.installState !== "installing" ? "install" : undefined;
  }
  if (!extension.installed) return undefined;
  if (!extension.enabled) return "enable";
  if (extension.setup.state !== "ready" && extension.setup.state !== "notRequired") return "setup";
  return undefined;
}

export function extensionSuggestionNewSessionRoute(
  pending: PendingExtensionSuggestionView,
  preserveRecommendation = false
): Extract<AppRoute, { readonly kind: "newSession" }> {
  const selection = pending.draft.selection;
  return {
    kind: "newSession",
    ...(selection.kind === "target" ? { targetId: selection.targetId }
      : selection.kind === "dialogue" ? { dialogueBackendId: selection.backendId }
        : {}),
    ...(preserveRecommendation ? { recommendationNonce: pending.nonce } : {})
  };
}

function requestIsCurrent(
  request: number,
  nonce: string,
  requests: { readonly current: number },
  owner: { readonly current: ContinuationLifetime | undefined }
): boolean {
  return requests.current === request && owner.current?.nonce === nonce;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim() !== "" ? cause.message : "The Extension suggestion could not be loaded.";
}

function resourceProjectionKey(snapshot: Pick<AppSnapshot, "resources">): string {
  return JSON.stringify(snapshot.resources.map((resource) => [
    resource.id,
    resource.backendId,
    resource.targetId ?? "",
    resource.discoveredRevision,
    resource.state
  ]));
}

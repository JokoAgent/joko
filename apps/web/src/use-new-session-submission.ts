import { useCallback, useLayoutEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AppController, AppRoute } from "./controller.js";
import type { ComposerDraft } from "./model.js";
import {
  createDelayedSessionFromFirstInput,
  type DelayedNewSessionDraft,
  type FirstInputAcceptance,
  type NewSessionSubmissionOwner
} from "./new-session-flow.js";
import { recentProjectForTarget } from "./recent-projects.js";

interface SubmissionView {
  observe(controller: AppController): void;
  retire(): void;
}

export interface NewSessionAcceptanceOwner {
  readonly serverId: string;
  readonly profileId: string;
  readonly connectionGeneration: number;
}

/** Keep accepted input on its original connection while presentation follows only its own navigation. */
export function useNewSessionSubmission(
  controller: AppController,
  setError: Dispatch<SetStateAction<string | undefined>>,
  setBusy: Dispatch<SetStateAction<string | undefined>>,
  describeError: (error: unknown) => string,
  onFirstInputAccepted?: (acceptance: FirstInputAcceptance, owner: NewSessionAcceptanceOwner) => void
): (draft: DelayedNewSessionDraft, input: ComposerDraft, owner: NewSessionSubmissionOwner) => Promise<void> {
  const currentController = useRef(controller);
  const acceptedObserver = useRef(onFirstInputAccepted);
  const activeView = useRef<SubmissionView | undefined>(undefined);
  const sequence = useRef(0);
  useLayoutEffect(() => {
    currentController.current = controller;
    acceptedObserver.current = onFirstInputAccepted;
    activeView.current?.observe(controller);
  });
  useLayoutEffect(() => () => activeView.current?.retire(), []);

  return useCallback(async (draft, input, owner) => {
    const original = currentController.current;
    const recentProject = draft.selection.kind === "target" && original.state.snapshot !== undefined
      ? recentProjectForTarget(original.state.snapshot, draft.selection.targetId)
      : undefined;
    const doc = owner.ownerDocument;
    const win = doc.defaultView;
    const sourceProfile = original.state.activeProfile;
    const sourceConnectionGeneration = original.state.connectionGeneration;
    owner.signal.throwIfAborted();
    if (!owner.isCurrent() || original.state.route.kind !== "newSession"
      || original.state.connectionState !== "connected" || sourceProfile === undefined
      || sourceConnectionGeneration === undefined || win === null || win.closed || win.document !== doc) {
      throw new DOMException("The initiating draft is no longer available.", "AbortError");
    }
    const acceptanceOwner: NewSessionAcceptanceOwner = {
      serverId: sourceProfile.serverId,
      profileId: sourceProfile.id,
      connectionGeneration: sourceConnectionGeneration
    };
    activeView.current?.observe(original);
    if (activeView.current !== undefined) throw new Error("Task creation is already in progress.");
    const actionKey = `create-session:${++sequence.current}`;
    let live = true;
    let route: AppRoute = original.state.route;
    let navigationRevision = original.state.navigationRevision;
    let expectedSession: string | undefined;
    let revealed = false;
    const effectLifetime = new AbortController();
    const clearBusy = (): void => setBusy((value) => value === actionKey ? undefined : value);
    const view: SubmissionView = {
      retire() {
        if (!live) return;
        live = false;
        effectLifetime.abort();
        win.removeEventListener("pagehide", view.retire);
        owner.signal.removeEventListener("abort", sourceRetired);
        if (activeView.current === view) activeView.current = undefined;
        clearBusy();
      },
      observe(current) {
        if (!live) return;
        const currentProfile = current.state.activeProfile;
        if (current.send !== original.send || current.state.connectionState !== "connected"
          || currentProfile === undefined
          || currentProfile.id !== acceptanceOwner.profileId
          || currentProfile.serverId !== acceptanceOwner.serverId
          || current.state.connectionGeneration !== acceptanceOwner.connectionGeneration) {
          view.retire();
          return;
        }
        const next = current.state.route;
        if (next !== route || current.state.navigationRevision !== navigationRevision) {
          if (expectedSession !== undefined && next.kind === "session" && next.sessionId === expectedSession
            && (next.profileId === undefined || next.profileId === original.state.activeProfile?.id)) {
            route = next;
            navigationRevision = current.state.navigationRevision;
            expectedSession = undefined;
            revealed = true;
          } else view.retire();
        }
        if (!revealed && expectedSession === undefined && !owner.isCurrent()) view.retire();
      }
    };
    const sourceRetired = (): void => { if (!revealed && expectedSession === undefined) view.retire(); };
    const isCurrent = (): boolean => {
      view.observe(currentController.current);
      return live && !win.closed && win.document === doc && (revealed || owner.isCurrent());
    };
    activeView.current = view;
    win.addEventListener("pagehide", view.retire);
    owner.signal.addEventListener("abort", sourceRetired, { once: true });
    setError(undefined);
    setBusy(actionKey);
    try {
      await createDelayedSessionFromFirstInput(original, draft, input, async (sessionId) => {
        // Session creation is durable even if its initiating view retired before the response.
        if (recentProject !== undefined && typeof original.recordRecentProject === "function") {
          try { void original.recordRecentProject(recentProject).catch(() => undefined); } catch { /* Local history must not block durable input. */ }
        }
        if (!isCurrent()) return;
        try {
          await original.clearNewSessionDraft();
        } catch (error) {
          if (isCurrent()) setError(describeError(error));
        }
        if (!isCurrent()) return;
        expectedSession = sessionId;
        original.navigate({ kind: "session", sessionId });
      }, undefined, {
        beforeFirstInput: owner.beforeFirstInput,
        disposition: owner.firstInputDisposition,
        signal: effectLifetime.signal,
        onAccepted: (acceptance) => {
          try { owner.onFirstInputAccepted?.(acceptance); } catch { /* Usage history cannot block accepted-input presentation. */ }
          try { acceptedObserver.current?.(acceptance, acceptanceOwner); } catch { /* Shell presentation cannot undo accepted input. */ }
          if (acceptance.kind !== "learned" || !isCurrent()) return;
          const distillationSessionId = acceptance.run.distillationSessionId;
          expectedSession = distillationSessionId;
          original.navigate({ kind: "session", sessionId: distillationSessionId });
        }
      });
    } catch (error) {
      if (isCurrent()) setError(describeError(error));
      throw error;
    } finally {
      view.retire();
    }
  }, [setBusy, setError, describeError]);
}

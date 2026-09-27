import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { AppController } from "../controller.js";
import {
  collectRuntimeProcessDiagnostics,
  runtimeProcessDiagnosticsErrorMessage,
  runtimeProcessDiagnosticsOwner,
  runtimeProcessDiagnosticsOwnerKey,
  sameRuntimeProcessDiagnosticsOwner,
  terminateRuntimeProcessWithCurrentFence
} from "../runtime-process-diagnostics.js";

export function RuntimeProcessMonitorBroker({ controller }: {
  readonly controller: AppController;
}): JSX.Element | null {
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const pendingRef = useRef(new Map<string, AbortController>());
  const owner = runtimeProcessDiagnosticsOwner(controller.state);
  const ownerKey = runtimeProcessDiagnosticsOwnerKey(owner);
  const priorOwnerRef = useRef<DesktopRuntimeProcessMonitorOwner | undefined>(undefined);

  useEffect(() => {
    for (const pending of pendingRef.current.values()) pending.abort();
    pendingRef.current.clear();
    const previous = priorOwnerRef.current;
    priorOwnerRef.current = owner;
    if (previous !== undefined && !sameRuntimeProcessDiagnosticsOwner(previous, owner)) {
      void window.jokoDesktop?.runtimeProcessMonitor.retire(previous).catch(() => undefined);
    }
  }, [ownerKey]);

  useEffect(() => {
    const api = window.jokoDesktop?.runtimeProcessMonitor;
    if (api === undefined || typeof api.onRequest !== "function" || typeof api.respond !== "function") return;
    return api.onRequest((request) => {
      const initialController = controllerRef.current;
      const initialOwner = runtimeProcessDiagnosticsOwner(initialController.state);
      if (!sameRuntimeProcessDiagnosticsOwner(initialOwner, request.owner)) {
        void respond(api, request, { kind: "error", message: "The runtime process monitor owner is no longer current." })
          .catch(() => undefined);
        return;
      }
      const abort = new AbortController();
      pendingRef.current.get(request.requestId)?.abort();
      pendingRef.current.set(request.requestId, abort);
      void (async () => {
        try {
          const action = request.action;
          if (action.kind === "refresh") {
            const result = await collectRuntimeProcessDiagnostics(
              initialController,
              initialController.state.snapshot,
              initialController.state.preferences.locale,
              abort.signal
            );
            if (!ownerStillCurrent(controllerRef.current, request.owner)) {
              throw new Error("The runtime process monitor owner changed while loading.");
            }
            await respond(api, request, {
              kind: "snapshot",
              locale: result.locale,
              backends: result.backends.map((backend): DesktopRuntimeProcessMonitorBackend => backend.state === "ready"
                ? {
                    backendId: backend.backendId,
                    backendGeneration: backend.backendGeneration,
                    backendName: backend.backendName,
                    usageSupported: backend.usageSupported,
                    terminateSupported: backend.terminateSupported,
                    state: "ready",
                    capturedAt: backend.capturedAt,
                    processes: backend.processes
                  }
                : {
                    backendId: backend.backendId,
                    backendGeneration: backend.backendGeneration,
                    backendName: backend.backendName,
                    usageSupported: backend.usageSupported,
                    terminateSupported: backend.terminateSupported,
                    state: "error",
                    error: backend.error ?? "Runtime process usage could not be loaded."
                  }),
              sessions: result.sessions
            });
            return;
          }
          await terminateRuntimeProcessWithCurrentFence(
            initialController,
            initialController.state.snapshot,
            action.process,
            action.backendGeneration,
            abort.signal,
            () => ownerStillCurrent(controllerRef.current, request.owner)
              && currentBackendGeneration(controllerRef.current, action.process.backendId) === action.backendGeneration
          );
          if (!ownerStillCurrent(controllerRef.current, request.owner)) {
            throw new Error("The runtime process monitor owner changed while terminating.");
          }
          await respond(api, request, { kind: "terminated" });
        } catch (error: unknown) {
          if (abort.signal.aborted) return;
          await respond(api, request, {
            kind: "error",
            message: runtimeProcessDiagnosticsErrorMessage(error)
          }).catch(() => undefined);
        } finally {
          if (pendingRef.current.get(request.requestId) === abort) pendingRef.current.delete(request.requestId);
        }
      })();
    });
  }, []);

  useEffect(() => () => {
    for (const pending of pendingRef.current.values()) pending.abort();
    pendingRef.current.clear();
  }, []);

  return null;
}

function ownerStillCurrent(controller: AppController, owner: DesktopRuntimeProcessMonitorOwner): boolean {
  return sameRuntimeProcessDiagnosticsOwner(runtimeProcessDiagnosticsOwner(controller.state), owner);
}

function currentBackendGeneration(controller: AppController, backendId: string): string | undefined {
  const generation = controller.state.snapshot.backends.find((backend) => backend.id === backendId)?.instanceGeneration;
  return generation !== undefined && Number.isSafeInteger(generation) && generation > 0 ? String(generation) : undefined;
}

async function respond(
  api: JokoDesktopApi["runtimeProcessMonitor"],
  request: DesktopRuntimeProcessMonitorRequest,
  result: DesktopRuntimeProcessMonitorResponse["result"]
): Promise<void> {
  await api.respond(Object.freeze({
    version: 1,
    requestId: request.requestId,
    owner: request.owner,
    result
  }));
}

import { createClient, type Transport } from "@connectrpc/connect";
import { SessionService, type OperationMutation, type TaskShareRuntimeControl } from "@joko/contracts";

export interface SessionRuntimeModelSelection {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort?: string;
  readonly fastMode: boolean;
}
export interface SessionRuntimeGatewayPort {
  capture(): { readonly transport: Transport; readonly signal: AbortSignal; readonly assertCurrent: () => void };
  submit(payload: OperationMutation["payload"]): Promise<unknown>;
}

/** Reads the runtime-control generation, which is independent of the native
 * Session generation. A stale/failed change is never silently replayed. */
export function createSessionRuntimeGateway(port: SessionRuntimeGatewayPort) {
  const read = async (sessionId: string): Promise<TaskShareRuntimeControl> => {
    const scope = port.capture(); scope.assertCurrent();
    const result = await createClient(SessionService, scope.transport).getSessionRuntimeControl({ sessionId }, { signal: scope.signal });
    scope.assertCurrent();
    if (!result.control) throw new Error("The task runtime selection is unavailable.");
    return result.control;
  };
  return {
    getSessionRuntimeControl: read,
    setRuntimeModel: async (sessionId: string, selection: SessionRuntimeModelSelection): Promise<void> => {
      const scope = port.capture(); scope.assertCurrent();
      const control = await createClient(SessionService, scope.transport).getSessionRuntimeControl({ sessionId }, { signal: scope.signal });
      scope.assertCurrent();
      if (!control.control || control.control.handoffState === "unknown") throw new Error("The previous runtime handoff needs to be recovered.");
      await port.submit({ case: "setSessionRuntime", value: { $typeName: "joko.v1.SetSessionRuntimeMutation", sessionId,
        expectedRuntimeGeneration: control.control.generation, backendId: selection.backendId,
        providerId: selection.providerId, modelId: selection.modelId, effort: selection.effort ?? "", fastMode: selection.fastMode } });
      scope.assertCurrent();
    }
  };
}

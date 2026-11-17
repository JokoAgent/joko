import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { TaskActivityService, type TaskActivityState } from "@joko/contracts";

/** Bound to one authenticated owner connection occurrence. Guests have no port. */
export interface TaskActivityPort {
  watch(viewedSessionIds: readonly string[], signal: AbortSignal): AsyncIterable<TaskActivityState>;
  revoke(deviceId: string): Promise<void>;
}

export async function* streamTaskActivity(transport: Transport, viewedSessionIds: readonly string[], signal: AbortSignal) {
  for await (const response of createClient(TaskActivityService, transport).watchTaskActivity({ viewedSessionIds: [...viewedSessionIds] }, { signal })) {
    signal.throwIfAborted();
    if (response.state === undefined) throw new Error("The task activity projection is unavailable.");
    yield response.state;
  }
}

/** Reopen only a read-only activity subscription; it has no durable event cursor
 * or mutation to replay. A lost stream clears its last activity projection. */
export async function followTaskActivity(port: TaskActivityPort, viewedSessionIds: readonly string[], generation: bigint,
  signal: AbortSignal, changed: (state: TaskActivityState | undefined) => void): Promise<void> {
  let revision = -1n, delay = 350;
  while (!signal.aborted) {
    try {
      for await (const state of port.watch(viewedSessionIds, signal)) {
        if (signal.aborted) return;
        if (state.generation !== generation) throw new Error("The task activity service generation changed.");
        if (state.revision < revision) continue;
        revision = state.revision; delay = 350;
        changed(state);
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ConnectError && [Code.Unauthenticated, Code.PermissionDenied, Code.Unimplemented,
        Code.InvalidArgument, Code.NotFound].includes(error.code)) { changed(undefined); return; }
    }
    if (signal.aborted) return;
    changed(undefined);
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, delay);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
    delay = Math.min(delay * 2, 5_000);
  }
}

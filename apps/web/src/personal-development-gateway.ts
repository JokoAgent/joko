import { createClient, type Transport } from "@connectrpc/connect";
import { PersonalDevelopmentService, type PersonalDevelopmentState, type GetPersonalDevelopmentStateResponse } from "@joko/contracts";
import type { PersonalDevelopmentApi, PersonalDevelopmentSnapshot } from "./personal-development-api.js";

const OBSERVATION_INTERVAL_MS = 1_000;
const STATE_READ_TIMEOUT_MS = 5_000;
type ObservationWake = (state?: PersonalDevelopmentState) => void;
const observationWakes = new WeakMap<Transport, Set<ObservationWake>>();

/** Only confirmed receipts from this exact live transport can wake its readers. */
function wakeObservations(transport: Transport, state?: PersonalDevelopmentState): void {
  for (const wake of observationWakes.get(transport) ?? []) wake(state);
}

/** Generated public surface only; native host commands remain Main-owned. */
export function createPersonalDevelopmentGateway(transport: Transport, connectionSignal: AbortSignal): PersonalDevelopmentApi {
  const client = createClient(PersonalDevelopmentService, transport);
  const signalFor = (signal?: AbortSignal) => AbortSignal.any([connectionSignal, ...(signal === undefined ? [] : [signal])]);
  const state = (value: PersonalDevelopmentState | undefined) => {
    if (value !== undefined && (value.generation < 0n || value.environment === undefined || value.source === undefined || value.versions === undefined)) {
      throw new Error("Personal development status is incomplete.");
    }
    return value;
  };
  const snapshot = (value: GetPersonalDevelopmentStateResponse): PersonalDevelopmentSnapshot => ({ available: value.available, unavailableReason: value.unavailableReason, state: state(value.state) });
  const read = async (signal?: AbortSignal): Promise<PersonalDevelopmentSnapshot> => {
    const request = new AbortController(), scope = signalFor(AbortSignal.any([request.signal, ...(signal === undefined ? [] : [signal])]));
    const page = typeof window === "undefined" ? undefined : window;
    const retire = () => request.abort();
    page?.addEventListener("pagehide", retire, { once: true });
    const timer = setTimeout(() => request.abort(new DOMException("Personal development state timed out.", "TimeoutError")), STATE_READ_TIMEOUT_MS);
    let abort: (() => void) | undefined;
    try {
      scope.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(scope.reason);
        scope.addEventListener("abort", abort, { once: true });
      });
      const result = await Promise.race([client.getPersonalDevelopmentState({}, { signal: scope, timeoutMs: STATE_READ_TIMEOUT_MS }), cancelled]);
      scope.throwIfAborted();
      return snapshot(result);
    } finally {
      clearTimeout(timer);
      if (abort !== undefined) scope.removeEventListener("abort", abort);
      page?.removeEventListener("pagehide", retire);
    }
  };
  return {
    getPersonalDevelopment: read,
    async watchPersonalDevelopment(afterGeneration, onUpdate, signal) {
      const lifetime = new AbortController(), scope = signalFor(AbortSignal.any([lifetime.signal, signal]));
      const page = typeof window === "undefined" ? undefined : window;
      const retire = () => lifetime.abort();
      page?.addEventListener("pagehide", retire, { once: true });
      let generation = afterGeneration, requested = false, wakeWait: (() => void) | undefined;
      const accept = (value: PersonalDevelopmentSnapshot): void => {
        if (scope.aborted) return;
        if (!value.available) { onUpdate(value); return; }
        if (value.state === undefined || value.state.generation <= generation) return;
        generation = value.state.generation;
        onUpdate(value);
      };
      const wake: ObservationWake = value => {
        if (scope.aborted) return;
        if (value !== undefined) accept({ available: true, unavailableReason: "", state: value });
        requested = true;
        wakeWait?.();
      };
      let readers = observationWakes.get(transport);
      if (readers === undefined) { readers = new Set(); observationWakes.set(transport, readers); }
      readers.add(wake);
      try {
        while (!scope.aborted) {
          requested = false;
          try {
            const value = await read(scope);
            if (scope.aborted) return;
            accept(value);
            if (!value.available) return;
          } catch {
            if (scope.aborted) return;
            // A failed read can be retried; it never resubmits an effect.
          }
          if (scope.aborted) return;
          if (!requested) await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); scope.removeEventListener("abort", finish); if (wakeWait === finish) wakeWait = undefined; resolve(); };
            const timer = setTimeout(finish, OBSERVATION_INTERVAL_MS);
            wakeWait = finish;
            scope.addEventListener("abort", finish, { once: true });
            if (scope.aborted || requested) finish();
          });
        }
      } finally {
        readers.delete(wake);
        if (readers.size === 0) observationWakes.delete(transport);
        wakeWait?.();
        page?.removeEventListener("pagehide", retire);
      }
    },
    async runPersonalDevelopmentAction(action, operationId, signal) {
      const scope = signalFor(signal); const result = await client.runPersonalDevelopmentAction({ operationId, action }, { signal: scope }); scope.throwIfAborted();
      if (result.operationId !== operationId) throw new Error("Personal development returned another action's receipt.");
      const accepted = state(result.state); wakeObservations(transport, accepted); return accepted;
    },
    async startPersonalDevelopmentTask(draft, operationId, signal) {
      const scope = signalFor(signal); const result = await client.startPersonalDevelopmentTask({ ...draft, operationId }, { signal: scope }); scope.throwIfAborted();
      if (result.operationId !== operationId || !result.taskId) throw new Error("Personal development task receipt is incomplete.");
      const accepted = state(result.state); wakeObservations(transport, accepted);
      return { taskId: result.taskId, ...(result.sessionId === "" ? {} : { sessionId: result.sessionId }), state: accepted };
    },
    async controlPersonalDevelopmentTask(taskId, action, message, operationId, signal) {
      const scope = signalFor(signal); const result = await client.controlPersonalDevelopmentTask({ operationId, taskId, action, message }, { signal: scope }); scope.throwIfAborted();
      if (result.operationId !== operationId) throw new Error("Personal development returned another task action's receipt.");
      const accepted = state(result.state); wakeObservations(transport, accepted); return accepted;
    },
    async startPersonalDevelopmentDoctor(draft, operationId, signal) {
      const scope = signalFor(signal), result = await client.startPersonalDevelopmentDoctor({ ...draft, operationId }, { signal: scope }); scope.throwIfAborted();
      if (result.operationId !== operationId || result.report === undefined || !result.report.runId || result.report.mode !== draft.mode) throw new Error("Personal development report is incomplete.");
      wakeObservations(transport); return result.report;
    },
    async controlPersonalDevelopmentDoctor(runId, action, operationId, signal) {
      const scope = signalFor(signal), result = await client.controlPersonalDevelopmentDoctor({ runId, action, operationId }, { signal: scope }); scope.throwIfAborted();
      if (result.operationId !== operationId || result.report?.runId !== runId) throw new Error("Personal development returned another report's receipt.");
      wakeObservations(transport); return result.report;
    }
  };
}

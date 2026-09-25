import type { SimulatorInstanceRoute, SimulatorOwnershipRegistry,
  SimulatorTaskScope } from "./ios-simulator-ownership.js";

export type SimulatorMutationSource = "agent" | "user";

export interface SimulatorMutationState {
  readonly instanceId: string;
  readonly activeSource: SimulatorMutationSource | null;
  readonly lastSource: SimulatorMutationSource | null;
  readonly queuedAgentMutations: number;
  readonly agentPaused: boolean;
  readonly takeoverPending: boolean;
}

interface MutableMutationState {
  activeSource: SimulatorMutationSource | null;
  lastSource: SimulatorMutationSource | null;
  queuedAgentMutations: number;
  agentPaused: boolean;
  takeoverEpoch: number;
}

export class SimulatorMutationArbitrationError extends Error {
  constructor(readonly code: "AGENT_MUTATION_PAUSED" | "DEVICE_BUSY" |
    "MUTATION_CANCELLED" | "SIMULATOR_HOST_CLOSED", message: string) {
    super(message);
  }
}

/** Process-local source arbitration layered outside every durable Simulator effect. */
export class SimulatorMutationArbiter {
  readonly #ownership: Pick<SimulatorOwnershipRegistry, "requireRoute">;
  readonly #states = new Map<string, MutableMutationState>();
  readonly #active = new Map<string, {
    readonly source: SimulatorMutationSource;
    readonly controller: AbortController;
  }>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #onAgentMutationStart: ((instanceId: string) => void) | undefined;
  readonly #onTakeover: ((instanceId: string) => void) | undefined;
  #closed = false;

  constructor(ownership: Pick<SimulatorOwnershipRegistry, "requireRoute">, options: {
    readonly onAgentMutationStart?: (instanceId: string) => void;
    readonly onTakeover?: (instanceId: string) => void;
  } = {}) {
    this.#ownership = ownership;
    this.#onAgentMutationStart = options.onAgentMutationStart;
    this.#onTakeover = options.onTakeover;
  }

  state(scope: SimulatorTaskScope, route: SimulatorInstanceRoute): SimulatorMutationState {
    this.#ownership.requireRoute(scope, route);
    return this.#snapshot(route.instanceId, this.#state(route.instanceId));
  }

  takeover(scope: SimulatorTaskScope, route: SimulatorInstanceRoute): SimulatorMutationState {
    this.#requireOpen();
    this.#ownership.requireRoute(scope, route);
    const state = this.#state(route.instanceId);
    state.agentPaused = true;
    state.takeoverEpoch += 1;
    const active = this.#active.get(route.instanceId);
    if (active?.source === "agent") active.controller.abort();
    this.#onTakeover?.(route.instanceId);
    return this.#snapshot(route.instanceId, state);
  }

  resume(scope: SimulatorTaskScope, route: SimulatorInstanceRoute): SimulatorMutationState {
    this.#requireOpen();
    this.#ownership.requireRoute(scope, route);
    const state = this.#state(route.instanceId);
    if (state.agentPaused &&
        (state.activeSource === "agent" || state.queuedAgentMutations > 0)) {
      throw new SimulatorMutationArbitrationError("DEVICE_BUSY",
        "Simulator takeover is still waiting for Agent actions to drain.");
    }
    state.agentPaused = false;
    return this.#snapshot(route.instanceId, state);
  }

  runAgent<T>(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#run(scope, route, "agent", task, signal);
  }

  runUser<T>(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#run(scope, route, "user", task, signal);
  }

  abortInstance(instanceId: string): void {
    const state = this.#states.get(instanceId);
    if (state) state.takeoverEpoch += 1;
    this.#active.get(instanceId)?.controller.abort();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const [instanceId, state] of this.#states) {
      state.takeoverEpoch += 1;
      this.#active.get(instanceId)?.controller.abort();
    }
    await Promise.all([...this.#tails.values()]);
    this.#active.clear();
    this.#tails.clear();
    this.#states.clear();
  }

  async #run<T>(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    source: SimulatorMutationSource, task: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal): Promise<T> {
    this.#requireOpen();
    signal?.throwIfAborted();
    this.#ownership.requireRoute(scope, route);
    const state = this.#state(route.instanceId);
    if (source === "agent") {
      if (state.agentPaused) throw new SimulatorMutationArbitrationError(
        "AGENT_MUTATION_PAUSED", "Simulator input is paused because the user took control.");
      state.queuedAgentMutations += 1;
    } else if (state.activeSource === "agent" || state.queuedAgentMutations > 0) {
      throw new SimulatorMutationArbitrationError("DEVICE_BUSY",
        "An Agent is currently using this Simulator. Take control before interacting.");
    }
    const expectedTakeoverEpoch = state.takeoverEpoch;
    return this.#serialize(route.instanceId, async () => {
      if (source === "agent") {
        state.queuedAgentMutations = Math.max(0, state.queuedAgentMutations - 1);
        if (this.#closed || state.agentPaused || state.takeoverEpoch !== expectedTakeoverEpoch ||
            signal?.aborted) throw new SimulatorMutationArbitrationError("MUTATION_CANCELLED",
          "The queued Simulator action was cancelled because control changed.");
      } else if (this.#closed || state.takeoverEpoch !== expectedTakeoverEpoch || signal?.aborted) {
        throw new SimulatorMutationArbitrationError("MUTATION_CANCELLED",
          "The queued Simulator action was cancelled because its owner changed.");
      } else if (state.activeSource === "agent" || state.queuedAgentMutations > 0) {
        throw new SimulatorMutationArbitrationError("DEVICE_BUSY",
          "An Agent is currently using this Simulator. Take control before interacting.");
      }
      this.#ownership.requireRoute(scope, route);
      state.activeSource = source;
      const controller = new AbortController();
      const active = { source, controller } as const;
      this.#active.set(route.instanceId, active);
      try {
        if (source === "agent") this.#onAgentMutationStart?.(route.instanceId);
        const effectiveSignal = signal === undefined ? controller.signal
          : AbortSignal.any([signal, controller.signal]);
        // Once admitted, the owning coordinator decides whether an abort means definitely
        // cancelled, outcome unknown, or confirmed success. Never overwrite that durable result.
        return await task(effectiveSignal);
      } finally {
        if (this.#active.get(route.instanceId) === active) this.#active.delete(route.instanceId);
        state.activeSource = null;
        state.lastSource = source;
      }
    });
  }

  #serialize<T>(instanceId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(instanceId) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(instanceId, tail);
    void tail.then(() => {
      if (this.#tails.get(instanceId) === tail) this.#tails.delete(instanceId);
    });
    return result;
  }

  #state(instanceId: string): MutableMutationState {
    const current = this.#states.get(instanceId);
    if (current) return current;
    const created: MutableMutationState = { activeSource: null, lastSource: null,
      queuedAgentMutations: 0, agentPaused: false, takeoverEpoch: 0 };
    this.#states.set(instanceId, created);
    return created;
  }

  #snapshot(instanceId: string, state: MutableMutationState): SimulatorMutationState {
    return { instanceId, activeSource: state.activeSource, lastSource: state.lastSource,
      queuedAgentMutations: state.queuedAgentMutations, agentPaused: state.agentPaused,
      takeoverPending: state.agentPaused &&
        (state.activeSource === "agent" || state.queuedAgentMutations > 0) };
  }

  #requireOpen(): void {
    if (this.#closed) throw new SimulatorMutationArbitrationError("SIMULATOR_HOST_CLOSED",
      "Simulator mutation arbitration is no longer available.");
  }
}

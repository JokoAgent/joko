import {
  DEDICATED_HARDWARE_MODEL_IDS,
  cloneDedicatedHardwareSettings,
  isDedicatedHardwareModelId,
  parseDedicatedHardwareSettings,
  type DedicatedHardwareModelId
} from "./settings.js";
import {
  parseDedicatedHardwareLightingState,
  parseDedicatedHardwareUtilityMessage,
  parseDedicatedHardwareUtilityRequest,
  type DedicatedHardwareConnectionReason,
  type DedicatedHardwareConnectionSnapshot,
  type DedicatedHardwareDesiredState,
  type DedicatedHardwareLightingState,
  type DedicatedHardwareInputEvent,
  type DedicatedHardwareSdkIdentity,
  type DedicatedHardwareUtilityMessage,
  type DedicatedHardwareUtilityRequest
} from "./protocol.js";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const GRACEFUL_STOP_TIMEOUT_MS = 5_000;
const KEYMAP_RECOVERY_TIMEOUT_MS = 30_000;
const STABLE_RESET_MS = 10_000;
const MINIMUM_RESTART_DELAY_MS = 500;
const MAXIMUM_RESTART_DELAY_MS = 10_000;
const CRASH_BREAKER_THRESHOLD = 5;

export interface DedicatedHardwareUtilityConnection {
  readonly send: (request: DedicatedHardwareUtilityRequest) => void;
  readonly terminate: () => void | Promise<void>;
}

export interface DedicatedHardwareUtilityFactory {
  readonly spawn: (options: {
    readonly generation: number;
    readonly onMessage: (message: unknown) => void;
    readonly onExit: () => void;
  }) => Promise<DedicatedHardwareUtilityConnection>;
}

export interface DedicatedHardwareHostClock {
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface DedicatedHardwareHostClient {
  readonly getConnectionState: (model: DedicatedHardwareModelId) => DedicatedHardwareConnectionSnapshot;
  readonly setDesiredState: (model: DedicatedHardwareModelId, desired: DedicatedHardwareDesiredState) => void;
  readonly setLightingState: (model: DedicatedHardwareModelId, state: DedicatedHardwareLightingState) => void;
  readonly probe: (model: DedicatedHardwareModelId) => boolean;
  readonly inspectCreatorKeymapRecovery: () => Promise<DedicatedHardwareConnectionSnapshot>;
  readonly recoverCreatorKeymap: () => Promise<DedicatedHardwareConnectionSnapshot>;
  readonly retry: () => void;
  readonly stop: () => Promise<void>;
  readonly subscribeConnectionState: (
    listener: (model: DedicatedHardwareModelId, state: DedicatedHardwareConnectionSnapshot) => void
  ) => () => void;
  readonly subscribeInput: (
    listener: (model: DedicatedHardwareModelId, sequence: number, input: DedicatedHardwareInputEvent) => void
  ) => () => void;
}

const DEFAULT_CLOCK: DedicatedHardwareHostClock = Object.freeze({
  setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
  clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout)
});

export function createDedicatedHardwareHostClient(options: {
  readonly factory: DedicatedHardwareUtilityFactory;
  readonly resolveSdkIdentity: () => Promise<DedicatedHardwareSdkIdentity>;
  readonly keymapBackupDirectory: string;
  readonly clock?: DedicatedHardwareHostClock;
}): DedicatedHardwareHostClient {
  const clock = options.clock ?? DEFAULT_CLOCK;
  const desired = new Map<DedicatedHardwareModelId, DedicatedHardwareDesiredState>();
  const lighting = new Map<DedicatedHardwareModelId, DedicatedHardwareLightingState>();
  const lightingPending = new Map<DedicatedHardwareModelId, string>();
  const lightingSent = new Map<DedicatedHardwareModelId, string>();
  const states = new Map<DedicatedHardwareModelId, DedicatedHardwareConnectionSnapshot>(
    DEDICATED_HARDWARE_MODEL_IDS.map((model) => [model, emptyState(model, "disabled", null)])
  );
  const stateListeners = new Set<(model: DedicatedHardwareModelId, state: DedicatedHardwareConnectionSnapshot) => void>();
  const inputListeners = new Set<(
    model: DedicatedHardwareModelId,
    sequence: number,
    input: DedicatedHardwareInputEvent
  ) => void>();
  const inputSequences = new Map<DedicatedHardwareModelId, number>();

  let generation = 0;
  let requestSequence = 0;
  let connection: DedicatedHardwareUtilityConnection | undefined;
  let sdkIdentity: DedicatedHardwareSdkIdentity | undefined;
  let starting = false;
  let ready = false;
  let permanentlyStopped = false;
  let permissionPaused = false;
  let breakerOpen = false;
  let restartAfterStop = false;
  let crashCount = 0;
  let plannedExit: "off" | "pause" | "restart" | "stop" | undefined;
  let handshakeRequestId: string | undefined;
  let shutdownRequestId: string | undefined;
  let handshakeTimer: unknown;
  let stableTimer: unknown;
  let restartTimer: unknown;
  let gracefulTimer: unknown;
  let keymapRecoveryTimer: unknown;
  let stopPromise: Promise<void> | undefined;
  let resolveStop: (() => void) | undefined;
  let keymapRecovery: {
    readonly promise: Promise<DedicatedHardwareConnectionSnapshot>;
    readonly resolve: (state: DedicatedHardwareConnectionSnapshot) => void;
    readonly reject: (error: Error) => void;
    requestId?: string;
  } | undefined;
  let keymapInspection: {
    readonly promise: Promise<DedicatedHardwareConnectionSnapshot>;
    readonly resolve: (state: DedicatedHardwareConnectionSnapshot) => void;
    readonly reject: (error: Error) => void;
    requestId?: string;
  } | undefined;
  let keymapInspectionTimer: unknown;

  const publish = (model: DedicatedHardwareModelId, next: DedicatedHardwareConnectionSnapshot): void => {
    const prior = states.get(model);
    if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(next)) return;
    states.set(model, next);
    for (const listener of stateListeners) {
      try { listener(model, { ...next }); } catch { /* A renderer observer cannot own the host. */ }
    }
  };

  const projectEnabled = (
    status: DedicatedHardwareConnectionSnapshot["status"],
    reason: DedicatedHardwareConnectionReason
  ): void => {
    for (const model of DEDICATED_HARDWARE_MODEL_IDS) {
      const keymap = states.get(model)?.keymap;
      if (desired.get(model)?.settings.enabled === true) publish(model, emptyState(model, status, reason, keymap));
      else publish(model, emptyState(model, "disabled", null, keymap));
    }
  };

  const clearTimer = (name: "handshake" | "stable" | "restart" | "graceful" | "keymap-recovery" | "keymap-inspection"): void => {
    const handle = name === "handshake" ? handshakeTimer
      : name === "stable" ? stableTimer
        : name === "restart" ? restartTimer
          : name === "graceful" ? gracefulTimer
            : name === "keymap-recovery" ? keymapRecoveryTimer
              : keymapInspectionTimer;
    if (handle !== undefined) clock.clearTimeout(handle);
    if (name === "handshake") handshakeTimer = undefined;
    if (name === "stable") stableTimer = undefined;
    if (name === "restart") restartTimer = undefined;
    if (name === "graceful") gracefulTimer = undefined;
    if (name === "keymap-recovery") keymapRecoveryTimer = undefined;
    if (name === "keymap-inspection") keymapInspectionTimer = undefined;
  };

  const clearRuntimeTimers = (): void => {
    clearTimer("handshake");
    clearTimer("stable");
    clearTimer("graceful");
  };

  const nextRequestId = (): string => {
    requestSequence += 1;
    return `g${generation}:${requestSequence}`;
  };

  const send = (request: DedicatedHardwareUtilityRequest): boolean => {
    const parsed = parseDedicatedHardwareUtilityRequest(request);
    if (parsed === undefined) {
      handleFailure(generation, "host-crash");
      return false;
    }
    if (connection === undefined) return false;
    try {
      connection.send(parsed);
      return true;
    } catch {
      handleFailure(generation, "host-crash");
      return false;
    }
  };

  const sendDesiredState = (model: DedicatedHardwareModelId): boolean => {
    const value = desired.get(model);
    if (value === undefined) return true;
    return send({
      version: 1,
      generation,
      requestId: nextRequestId(),
      kind: "set-desired-state",
      model,
      settings: value.settings,
      preview: value.preview
    });
  };

  const hasEnabledModel = (): boolean => DEDICATED_HARDWARE_MODEL_IDS.some(
    (model) => desired.get(model)?.settings.enabled === true
  );

  const resetLightingDelivery = (): void => {
    lightingPending.clear();
    lightingSent.clear();
  };

  const sendLightingState = (model: DedicatedHardwareModelId): void => {
    const value = lighting.get(model);
    if (value === undefined || !ready || connection === undefined || plannedExit !== undefined || permanentlyStopped ||
        desired.get(model)?.settings.enabled !== true || lightingPending.has(model)) return;
    const key = JSON.stringify(value);
    if (lightingSent.get(model) === key) return;
    const requestId = nextRequestId();
    lightingPending.set(model, requestId);
    lightingSent.set(model, key);
    send({ version: 1, generation, requestId, kind: "set-lighting-state", model, state: value });
  };

  const finishKeymapRecovery = (error?: Error): void => {
    const pending = keymapRecovery;
    if (pending === undefined) return;
    clearTimer("keymap-recovery");
    keymapRecovery = undefined;
    if (error !== undefined) pending.reject(error);
    else pending.resolve({ ...states.get("creator-micro-2")! });
  };

  const finishKeymapInspection = (error?: Error): void => {
    const pending = keymapInspection;
    if (pending === undefined) return;
    clearTimer("keymap-inspection");
    keymapInspection = undefined;
    if (error !== undefined) pending.reject(error);
    else pending.resolve({ ...states.get("creator-micro-2")! });
  };

  const sendKeymapInspection = (): boolean => {
    if (!ready || plannedExit !== undefined || keymapInspection === undefined ||
        keymapInspection.requestId !== undefined) return false;
    const requestId = nextRequestId();
    keymapInspection.requestId = requestId;
    if (!send({
      version: 1,
      generation,
      requestId,
      kind: "inspect-keymap",
      model: "creator-micro-2"
    })) {
      finishKeymapInspection(new Error("Dedicated hardware keymap inspection could not be dispatched."));
      return false;
    }
    return true;
  };

  const sendKeymapRecovery = (): boolean => {
    if (!ready || plannedExit !== undefined || keymapRecovery === undefined ||
        keymapRecovery.requestId !== undefined) return false;
    const requestId = nextRequestId();
    keymapRecovery.requestId = requestId;
    if (!send({
      version: 1,
      generation,
      requestId,
      kind: "recover-keymap",
      model: "creator-micro-2"
    })) {
      finishKeymapRecovery(new Error("Dedicated hardware keymap recovery could not be dispatched."));
      return false;
    }
    return true;
  };

  const terminate = (target: DedicatedHardwareUtilityConnection | undefined): void => {
    if (target === undefined) return;
    try {
      const result = target.terminate();
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Termination is a fence, not a recoverable action to replay.
    }
  };

  const finishStopPromise = (): void => {
    if (!permanentlyStopped) return;
    resolveStop?.();
    resolveStop = undefined;
  };

  const finishPlannedExit = (ownerGeneration: number): void => {
    if (ownerGeneration !== generation || plannedExit === undefined) return;
    const mode = plannedExit;
    const oldConnection = connection;
    clearRuntimeTimers();
    connection = undefined;
    starting = false;
    ready = false;
    plannedExit = undefined;
    handshakeRequestId = undefined;
    shutdownRequestId = undefined;
    inputSequences.clear();
    resetLightingDelivery();
    if (keymapRecovery !== undefined) keymapRecovery.requestId = undefined;
    if (keymapInspection !== undefined) keymapInspection.requestId = undefined;
    const creator = states.get("creator-micro-2");
    if (creator !== undefined) publish("creator-micro-2", {
      ...creator,
      keymap: keymapAfterHostExit(creator.keymap)
    });
    generation += 1;
    terminate(oldConnection);
    if (mode === "off" || mode === "stop") projectEnabled("disabled", null);
    if (mode === "restart" || restartAfterStop) {
      restartAfterStop = false;
      ensureRunning();
    }
    finishStopPromise();
  };

  const beginPlannedExit = (mode: "off" | "pause" | "restart" | "stop"): void => {
    clearTimer("restart");
    if (mode === "stop") {
      finishKeymapRecovery(new Error("Dedicated hardware input stopped during keymap recovery."));
      finishKeymapInspection(new Error("Dedicated hardware input stopped during keymap inspection."));
    }
    if (plannedExit !== undefined) {
      if (mode === "stop") plannedExit = "stop";
      else if (mode === "restart") restartAfterStop = true;
      return;
    }
    plannedExit = mode;
    resetLightingDelivery();
    if (connection === undefined) {
      generation += 1;
      starting = false;
      ready = false;
      plannedExit = undefined;
      if (mode === "off" || mode === "stop") projectEnabled("disabled", null);
      if (mode === "restart" || restartAfterStop) {
        restartAfterStop = false;
        ensureRunning();
      }
      finishStopPromise();
      return;
    }
    const ownerGeneration = generation;
    shutdownRequestId = nextRequestId();
    send({ version: 1, generation, requestId: shutdownRequestId, kind: "shutdown" });
    gracefulTimer = clock.setTimeout(() => finishPlannedExit(ownerGeneration), GRACEFUL_STOP_TIMEOUT_MS);
  };

  const scheduleRestart = (): void => {
    if (restartTimer !== undefined || permanentlyStopped || permissionPaused || breakerOpen || !hasEnabledModel()) return;
    const delay = Math.min(MAXIMUM_RESTART_DELAY_MS, MINIMUM_RESTART_DELAY_MS * (2 ** Math.max(0, crashCount - 1)));
    restartTimer = clock.setTimeout(() => {
      restartTimer = undefined;
      ensureRunning();
    }, delay);
  };

  function handleFailure(
    ownerGeneration: number,
    reason: Extract<DedicatedHardwareConnectionReason, "connection-timeout" | "host-crash">
  ): void {
    if (ownerGeneration !== generation || permanentlyStopped || plannedExit !== undefined) return;
    finishKeymapRecovery(new Error("Dedicated hardware host failed during keymap recovery."));
    finishKeymapInspection(new Error("Dedicated hardware host failed during keymap inspection."));
    const oldConnection = connection;
    clearRuntimeTimers();
    connection = undefined;
    starting = false;
    ready = false;
    handshakeRequestId = undefined;
    shutdownRequestId = undefined;
    inputSequences.clear();
    resetLightingDelivery();
    const creator = states.get("creator-micro-2");
    if (creator !== undefined) publish("creator-micro-2", {
      ...creator,
      keymap: keymapAfterHostExit(creator.keymap)
    });
    generation += 1;
    terminate(oldConnection);
    if (!hasEnabledModel()) {
      projectEnabled("disabled", null);
      return;
    }
    crashCount += 1;
    if (crashCount > CRASH_BREAKER_THRESHOLD) {
      breakerOpen = true;
      projectEnabled("unavailable", "host-crash");
      return;
    }
    projectEnabled("error", reason);
    scheduleRestart();
  }

  const onMessage = (ownerGeneration: number, raw: unknown): void => {
    if (ownerGeneration !== generation) return;
    const message = parseDedicatedHardwareUtilityMessage(raw);
    if (message === undefined || message.generation !== ownerGeneration) {
      handleFailure(ownerGeneration, "host-crash");
      return;
    }
    if (message.kind === "ready") {
      if (ready || message.requestId !== handshakeRequestId || connection === undefined) {
        handleFailure(ownerGeneration, "host-crash");
        return;
      }
      clearTimer("handshake");
      ready = true;
      starting = false;
      handshakeRequestId = undefined;
      if (sdkIdentity?.kind === "unavailable") projectEnabled("unavailable", "sdk-unavailable");
      for (const model of DEDICATED_HARDWARE_MODEL_IDS) {
        if (!sendDesiredState(model)) return;
      }
      sendKeymapInspection();
      sendKeymapRecovery();
      for (const model of DEDICATED_HARDWARE_MODEL_IDS) sendLightingState(model);
      stableTimer = clock.setTimeout(() => {
        if (ownerGeneration === generation && ready) crashCount = 0;
      }, STABLE_RESET_MS);
      return;
    }
    if (!ready) {
      handleFailure(ownerGeneration, "host-crash");
      return;
    }
    if (message.kind === "state") {
      const projectedKeymap = preserveKnownKeymapRecovery(states.get(message.model)?.keymap, message.keymap);
      if (desired.get(message.model)?.settings.enabled !== true) {
        publish(message.model, emptyState(message.model, "disabled", null, projectedKeymap));
        return;
      }
      if (sdkIdentity?.kind === "unavailable") {
        publish(message.model, emptyState(message.model, "unavailable", "sdk-unavailable", projectedKeymap));
        return;
      }
      if (message.reason === "permission-required") {
        for (const model of DEDICATED_HARDWARE_MODEL_IDS) {
          if (desired.get(model)?.settings.enabled !== true) {
            publish(model, emptyState(model, "disabled", null, states.get(model)?.keymap));
          } else if (model === message.model) {
            publish(model, { ...connectionStateFromMessage(message), keymap: projectedKeymap });
          } else {
            publish(model, emptyState(model, "error", "permission-required", states.get(model)?.keymap));
          }
        }
        permissionPaused = true;
        finishKeymapRecovery(new Error("Dedicated hardware permission is required for keymap recovery."));
        finishKeymapInspection(new Error("Dedicated hardware permission is required for keymap inspection."));
        beginPlannedExit("pause");
        return;
      }
      publish(message.model, { ...connectionStateFromMessage(message), keymap: projectedKeymap });
      return;
    }
    if (message.kind === "ack") {
      for (const model of DEDICATED_HARDWARE_MODEL_IDS) {
        if (lightingPending.get(model) !== message.requestId) continue;
        lightingPending.delete(model);
        sendLightingState(model);
        return;
      }
      if (keymapInspection?.requestId === message.requestId) {
        finishKeymapInspection();
        if (!hasEnabledModel() && keymapRecovery === undefined) beginPlannedExit("off");
        return;
      }
      if (keymapRecovery?.requestId !== message.requestId) return;
      const state = states.get("creator-micro-2")!;
      const succeeded = (state.keymap?.phase === "idle" && state.keymap.backupAvailable === false &&
          state.keymap.failure === null) ||
        (state.keymap?.phase === "occupied" && state.keymap.backupAvailable && state.keymap.failure === null);
      finishKeymapRecovery(succeeded
        ? undefined
        : new Error("Dedicated hardware keymap recovery remains required."));
      if (!hasEnabledModel() && keymapInspection === undefined) beginPlannedExit("off");
      return;
    }
    if (message.kind === "input") {
      if (plannedExit !== undefined || sdkIdentity?.kind === "unavailable" ||
          desired.get(message.model)?.settings.enabled !== true) return;
      const prior = inputSequences.get(message.model);
      if (prior !== undefined && message.sequence <= prior) return;
      inputSequences.set(message.model, message.sequence);
      for (const listener of inputListeners) {
        try { listener(message.model, message.sequence, { ...message.input }); } catch { /* Observer isolation. */ }
      }
      return;
    }
    if (message.kind === "stopped") {
      if (plannedExit === undefined || message.requestId !== shutdownRequestId) {
        handleFailure(ownerGeneration, "host-crash");
        return;
      }
      finishPlannedExit(ownerGeneration);
    }
  };

  const ensureRunning = (): void => {
    if (permanentlyStopped || starting || connection !== undefined || restartTimer !== undefined ||
        plannedExit !== undefined || permissionPaused || breakerOpen ||
        (!hasEnabledModel() && keymapRecovery === undefined && keymapInspection === undefined)) return;
    starting = true;
    const ownerGeneration = ++generation;
    projectEnabled("connecting", null);
    handshakeTimer = clock.setTimeout(
      () => handleFailure(ownerGeneration, "connection-timeout"),
      HANDSHAKE_TIMEOUT_MS
    );
    void options.resolveSdkIdentity().then(async (resolvedSdk) => {
      if (ownerGeneration !== generation || !starting || permanentlyStopped ||
          (!hasEnabledModel() && keymapRecovery === undefined && keymapInspection === undefined)) return;
      sdkIdentity = resolvedSdk;
      let created: DedicatedHardwareUtilityConnection;
      try {
        created = await options.factory.spawn({
          generation: ownerGeneration,
          onMessage: (message) => onMessage(ownerGeneration, message),
          onExit: () => {
            if (ownerGeneration !== generation) return;
            if (plannedExit !== undefined) finishPlannedExit(ownerGeneration);
            else handleFailure(ownerGeneration, "host-crash");
          }
        });
      } catch {
        handleFailure(ownerGeneration, "host-crash");
        return;
      }
      if (ownerGeneration !== generation || !starting || permanentlyStopped ||
          (!hasEnabledModel() && keymapRecovery === undefined && keymapInspection === undefined)) {
        terminate(created);
        return;
      }
      connection = created;
      handshakeRequestId = nextRequestId();
      const handshake: DedicatedHardwareUtilityRequest = {
        version: 1,
        generation: ownerGeneration,
        requestId: handshakeRequestId,
        kind: "handshake",
        sdk: resolvedSdk,
        keymapBackupDirectory: options.keymapBackupDirectory
      };
      if (!send(handshake)) return;
    }).catch(() => handleFailure(ownerGeneration, "host-crash"));
  };

  const client: DedicatedHardwareHostClient = {
    getConnectionState: (model) => {
      assertModel(model);
      return { ...states.get(model)! };
    },
    setDesiredState: (model, next) => {
      assertModel(model);
      const settings = parseDedicatedHardwareSettings(next.settings);
      if (settings === undefined || typeof next.preview !== "boolean") {
        throw new TypeError("Invalid dedicated hardware desired state.");
      }
      const canonical: DedicatedHardwareDesiredState = {
        settings: cloneDedicatedHardwareSettings(settings),
        preview: next.preview
      };
      desired.set(model, canonical);
      if (!canonical.settings.enabled) {
        lightingSent.delete(model);
        publish(model, emptyState(model, "disabled", null, states.get(model)?.keymap));
        if (ready) sendDesiredState(model);
        if (!hasEnabledModel() && keymapRecovery === undefined && keymapInspection === undefined) {
          beginPlannedExit("off");
        }
        return;
      }
      if (ready && plannedExit === undefined) {
        if (!sendDesiredState(model)) return;
        sendLightingState(model);
        if (sdkIdentity?.kind === "unavailable") {
          publish(model, emptyState(model, "unavailable", "sdk-unavailable", states.get(model)?.keymap));
        }
      } else if (plannedExit !== undefined) {
        restartAfterStop = true;
      } else {
        ensureRunning();
      }
    },
    setLightingState: (model, next) => {
      assertModel(model);
      const canonical = parseDedicatedHardwareLightingState(next);
      if (canonical === undefined) throw new TypeError("Invalid dedicated hardware lighting state.");
      lighting.set(model, canonical);
      sendLightingState(model);
    },
    probe: (model) => {
      assertModel(model);
      if (!ready || plannedExit !== undefined || desired.get(model)?.settings.enabled !== true) return false;
      return send({ version: 1, generation, requestId: nextRequestId(), kind: "probe", model });
    },
    inspectCreatorKeymapRecovery: () => {
      if (permanentlyStopped) {
        return Promise.reject(new Error("Dedicated hardware input is stopped."));
      }
      if (keymapInspection !== undefined) return keymapInspection.promise;
      let resolve!: (value: DedicatedHardwareConnectionSnapshot) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<DedicatedHardwareConnectionSnapshot>((accept, decline) => {
        resolve = accept;
        reject = decline;
      });
      const pending = { promise, resolve, reject };
      keymapInspection = pending;
      keymapInspectionTimer = clock.setTimeout(() => {
        if (keymapInspection !== pending) return;
        finishKeymapInspection(new Error("Dedicated hardware keymap inspection timed out."));
        if (!hasEnabledModel() && keymapRecovery === undefined) beginPlannedExit("off");
      }, KEYMAP_RECOVERY_TIMEOUT_MS);
      permissionPaused = false;
      breakerOpen = false;
      crashCount = 0;
      clearTimer("restart");
      if (ready && plannedExit === undefined) sendKeymapInspection();
      else if (plannedExit !== undefined) restartAfterStop = true;
      else ensureRunning();
      return promise;
    },
    recoverCreatorKeymap: () => {
      const state = states.get("creator-micro-2")!;
      if (state.keymap?.backupAvailable !== true) {
        return Promise.reject(new Error("Dedicated hardware keymap recovery is not required."));
      }
      if (permanentlyStopped) {
        return Promise.reject(new Error("Dedicated hardware input is stopped."));
      }
      if (keymapRecovery !== undefined) return keymapRecovery.promise;
      let resolve!: (value: DedicatedHardwareConnectionSnapshot) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<DedicatedHardwareConnectionSnapshot>((accept, decline) => {
        resolve = accept;
        reject = decline;
      });
      const pending = { promise, resolve, reject };
      keymapRecovery = pending;
      keymapRecoveryTimer = clock.setTimeout(() => {
        if (keymapRecovery !== pending) return;
        finishKeymapRecovery(new Error("Dedicated hardware keymap recovery timed out."));
        if (!hasEnabledModel() && keymapInspection === undefined) beginPlannedExit("off");
      }, KEYMAP_RECOVERY_TIMEOUT_MS);
      permissionPaused = false;
      breakerOpen = false;
      crashCount = 0;
      clearTimer("restart");
      if (ready && plannedExit === undefined) sendKeymapRecovery();
      else if (plannedExit !== undefined) restartAfterStop = true;
      else ensureRunning();
      return promise;
    },
    retry: () => {
      if (permanentlyStopped || !hasEnabledModel()) return;
      permissionPaused = false;
      breakerOpen = false;
      crashCount = 0;
      clearTimer("restart");
      if (connection !== undefined || starting) beginPlannedExit("restart");
      else ensureRunning();
    },
    stop: () => {
      if (stopPromise !== undefined) return stopPromise;
      stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
      permanentlyStopped = true;
      clearTimer("restart");
      beginPlannedExit("stop");
      return stopPromise;
    },
    subscribeConnectionState: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    subscribeInput: (listener) => {
      inputListeners.add(listener);
      return () => inputListeners.delete(listener);
    }
  };
  return Object.freeze(client);
}

function emptyState(
  model: DedicatedHardwareModelId,
  status: DedicatedHardwareConnectionSnapshot["status"],
  reason: DedicatedHardwareConnectionReason,
  keymap: DedicatedHardwareConnectionSnapshot["keymap"] | undefined = undefined
): DedicatedHardwareConnectionSnapshot {
  return {
    model,
    status,
    reason,
    devicePresent: null,
    transport: null,
    firmwareVersion: null,
    batteryPercent: null,
    charging: null,
    inputPermission: "unknown",
    keymap: model === "creator-micro-2"
      ? keymap ?? { phase: "unavailable", backupAvailable: null, failure: null }
      : null
  };
}

function connectionStateFromMessage(
  message: Extract<DedicatedHardwareUtilityMessage, { kind: "state" }>
): DedicatedHardwareConnectionSnapshot {
  return {
    model: message.model,
    status: message.status,
    reason: message.reason,
    devicePresent: message.devicePresent,
    transport: message.transport,
    firmwareVersion: message.firmwareVersion,
    batteryPercent: message.batteryPercent,
    charging: message.charging,
    inputPermission: message.inputPermission,
    keymap: message.keymap
  };
}

function keymapAfterHostExit(
  keymap: DedicatedHardwareConnectionSnapshot["keymap"]
): DedicatedHardwareConnectionSnapshot["keymap"] {
  if (keymap === null || keymap.phase === "unavailable" || keymap.phase === "idle" || keymap.phase === "error") {
    return keymap;
  }
  return { phase: "error", backupAvailable: true, failure: "recovery-required" };
}

function preserveKnownKeymapRecovery(
  prior: DedicatedHardwareConnectionSnapshot["keymap"] | undefined,
  incoming: DedicatedHardwareConnectionSnapshot["keymap"]
): DedicatedHardwareConnectionSnapshot["keymap"] {
  if (prior?.backupAvailable === true && incoming?.phase === "unavailable") {
    return prior.phase === "error"
      ? prior
      : { phase: "error", backupAvailable: true, failure: "recovery-required" };
  }
  return incoming;
}

function assertModel(model: DedicatedHardwareModelId): void {
  if (!isDedicatedHardwareModelId(model)) throw new TypeError("Unknown dedicated hardware model.");
}

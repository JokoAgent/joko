import {
  DEDICATED_HARDWARE_MODEL_IDS,
  type DedicatedHardwareModelId
} from "./settings.js";
import {
  createDedicatedHardwareKeymapController,
  isDedicatedHardwareKeymapDeviceFirmwareIdentity,
  type DedicatedHardwareKeymapBackupStore,
  type DedicatedHardwareKeymapController,
  type DedicatedHardwareKeymapDeviceAdapter,
  type DedicatedHardwareKeymapState
} from "./keymap-controller.js";
import {
  parseDedicatedHardwareUtilityMessage,
  parseDedicatedHardwareUtilityRequest,
  type DedicatedHardwareConnectionSnapshot,
  type DedicatedHardwareDesiredState,
  type DedicatedHardwareLightingState,
  type DedicatedHardwareInputEvent,
  type DedicatedHardwareKeymapSnapshot,
  type DedicatedHardwareSdkIdentity,
  type DedicatedHardwareUtilityDeviceSnapshot,
  type DedicatedHardwareUtilityMessage
} from "./protocol.js";

export interface DedicatedHardwareUtilityAdapterSink {
  readonly publishState: (state: DedicatedHardwareUtilityDeviceSnapshot) => void;
  readonly publishInput: (model: DedicatedHardwareModelId, input: DedicatedHardwareInputEvent) => void;
}

export interface DedicatedHardwareUtilityAdapter {
  /** Low-level device effects. The utility handler exclusively owns backup/rollback/recovery sequencing. */
  readonly creatorKeymap: DedicatedHardwareKeymapDeviceAdapter;
  readonly setDesiredState: (
    model: DedicatedHardwareModelId,
    desired: DedicatedHardwareDesiredState
  ) => Promise<DedicatedHardwareUtilityDeviceSnapshot>;
  readonly setLightingState: (model: DedicatedHardwareModelId, state: DedicatedHardwareLightingState) => void;
  readonly probe: (model: DedicatedHardwareModelId) => Promise<DedicatedHardwareUtilityDeviceSnapshot>;
  readonly stop: () => Promise<void>;
}

export type DedicatedHardwareUtilityHandlerResult = "continue" | "stopped" | "terminate";

export interface DedicatedHardwareUtilityRequestHandler {
  readonly handle: (value: unknown) => Promise<DedicatedHardwareUtilityHandlerResult>;
}

export function createDedicatedHardwareUtilityRequestHandler(options: {
  readonly postMessage: (message: DedicatedHardwareUtilityMessage) => void;
  readonly loadStagedAdapter: (
    identity: Extract<DedicatedHardwareSdkIdentity, { kind: "staged" }>,
    sink: DedicatedHardwareUtilityAdapterSink
  ) => Promise<DedicatedHardwareUtilityAdapter>;
  readonly openKeymapBackupStore: (directory: string) => Promise<DedicatedHardwareKeymapBackupStore>;
}): DedicatedHardwareUtilityRequestHandler {
  let generation: number | undefined;
  let lastRequestSequence = 0;
  let adapter: DedicatedHardwareUtilityAdapter | undefined;
  let keymap: DedicatedHardwareKeymapController | undefined;
  let keymapBackupStore: DedicatedHardwareKeymapBackupStore | undefined;
  let retainedKeymapState: DedicatedHardwareKeymapSnapshot | undefined;
  let unsubscribeKeymap: (() => void) | undefined;
  let unavailable = false;
  let creatorDesired: DedicatedHardwareDesiredState | undefined;
  let creatorInputForcedDisabled = false;
  let creatorInputConnected = false;
  let ready = false;
  let closed = false;
  let tail = Promise.resolve<DedicatedHardwareUtilityHandlerResult>("continue");
  let adapterStateTail = Promise.resolve();
  const inputSequences = new Map<DedicatedHardwareModelId, number>();
  const pendingStates = new Map<DedicatedHardwareModelId, DedicatedHardwareUtilityDeviceSnapshot>();
  const deviceStates = new Map<DedicatedHardwareModelId, DedicatedHardwareUtilityDeviceSnapshot>();

  const post = (message: DedicatedHardwareUtilityMessage): void => {
    const parsed = parseDedicatedHardwareUtilityMessage(message);
    if (parsed === undefined) throw new Error("Invalid dedicated hardware utility output.");
    options.postMessage(parsed);
  };

  const postState = (state: DedicatedHardwareConnectionSnapshot): void => {
    if (generation === undefined) throw new Error("Utility handshake is incomplete.");
    post({ version: 1, generation, kind: "state", ...state });
  };

  const keymapSnapshot = (model: DedicatedHardwareModelId): DedicatedHardwareKeymapSnapshot | null => {
    if (model !== "creator-micro-2") return null;
    if (keymap === undefined) return retainedKeymapState ?? unavailableKeymap();
    return projectKeymap(keymap.getState());
  };

  const postDeviceState = (state: DedicatedHardwareUtilityDeviceSnapshot): void => {
    deviceStates.set(state.model, { ...state });
    if (!ready) {
      pendingStates.set(state.model, { ...state });
      return;
    }
    postState({ ...publicDeviceState(state), keymap: keymapSnapshot(state.model) });
  };

  const publishCurrentKeymap = (): void => {
    if (!ready) return;
    const state = deviceStates.get("creator-micro-2") ?? disabledDeviceState("creator-micro-2");
    postState({ ...publicDeviceState(state), keymap: keymapSnapshot("creator-micro-2") });
  };

  const unavailableState = (model: DedicatedHardwareModelId): DedicatedHardwareConnectionSnapshot => ({
    model,
    status: "unavailable",
    reason: "sdk-unavailable",
    devicePresent: null,
    transport: null,
    firmwareVersion: null,
    batteryPercent: null,
    charging: null,
    inputPermission: "unknown",
    keymap: model === "creator-micro-2" ? keymapSnapshot(model) : null
  });

  const disabledState = (model: DedicatedHardwareModelId): DedicatedHardwareConnectionSnapshot => ({
    ...unavailableState(model),
    status: "disabled",
    reason: null
  });

  const failedState = (model: DedicatedHardwareModelId): DedicatedHardwareConnectionSnapshot => ({
    ...unavailableState(model),
    status: "error",
    reason: "device-disconnected",
    keymap: keymapSnapshot(model)
  });

  const releaseCreatorKeymap = async (): Promise<void> => {
    if (keymap === undefined || keymap.getState().phase === "idle") return;
    await keymap.release();
  };

  const acceptAdapterState = (
    state: DedicatedHardwareUtilityDeviceSnapshot,
    allowCreatorOccupy = true
  ): Promise<void> => {
    if (state.model === "creator-micro-2") creatorInputConnected = false;
    const operation = adapterStateTail.then(async () => {
      deviceStates.set(state.model, { ...state });
      if (state.model === "creator-micro-2" && keymap !== undefined) {
        if (state.status === "connected" &&
            !isDedicatedHardwareKeymapDeviceFirmwareIdentity(state.keymapDeviceFirmwareIdentity)) {
          throw new Error("Connected Creator hardware omitted its device-firmware identity.");
        }
        const phase = keymap.getState().phase;
        if (allowCreatorOccupy && !creatorInputForcedDisabled && state.status === "connected" &&
            creatorDesired?.settings.enabled === true &&
            (phase === "idle" || phase === "occupied" ||
              (phase === "error" && keymap.getState().backupAvailable === false &&
                (keymap.getState().failure === "apply" || keymap.getState().failure === "transform")))) {
          await keymap.occupy(
            creatorDesired.settings.layout.taskKeys,
            state.keymapDeviceFirmwareIdentity!
          ).catch(() => undefined);
        } else if (state.status !== "connected" && phase === "occupied") {
          await releaseCreatorKeymap().catch(() => undefined);
        }
      }
      postDeviceState(state);
      if (state.model === "creator-micro-2") {
        creatorInputConnected = state.status === "connected" && creatorDesired?.settings.enabled === true &&
          !creatorInputForcedDisabled && keymap?.getState().phase === "occupied";
      }
    });
    adapterStateTail = operation.catch(() => undefined);
    return operation;
  };

  const sink: DedicatedHardwareUtilityAdapterSink = Object.freeze({
    publishState: (state: DedicatedHardwareUtilityDeviceSnapshot) => {
      if (closed || generation === undefined) return;
      if (state.model === "creator-micro-2") creatorInputConnected = false;
      void acceptAdapterState(state);
    },
    publishInput: (model: DedicatedHardwareModelId, input: DedicatedHardwareInputEvent) => {
      if (closed || generation === undefined || !ready) return;
      if (model === "creator-micro-2" &&
          (!creatorInputConnected || creatorDesired?.settings.enabled !== true || creatorInputForcedDisabled ||
            keymap?.getState().phase !== "occupied")) return;
      const sequence = (inputSequences.get(model) ?? -1) + 1;
      inputSequences.set(model, sequence);
      post({ version: 1, generation, kind: "input", model, sequence, input });
    }
  });

  const handleOne = async (raw: unknown): Promise<DedicatedHardwareUtilityHandlerResult> => {
    if (closed) return "terminate";
    const request = parseDedicatedHardwareUtilityRequest(raw);
    if (request === undefined || !validRequestOrder(request.generation, request.requestId, generation, lastRequestSequence)) {
      closed = true;
      return "terminate";
    }
    const requestSequence = requestSequenceOf(request.requestId)!;

    if (request.kind === "handshake") {
      if (generation !== undefined) {
        closed = true;
        return "terminate";
      }
      generation = request.generation;
      lastRequestSequence = requestSequence;
      try {
        keymapBackupStore = await options.openKeymapBackupStore(request.keymapBackupDirectory);
        const retained = await keymapBackupStore.listBackups();
        retainedKeymapState = retained.length === 0
          ? undefined
          : { phase: "error", backupAvailable: true, failure: "recovery-required" };
      } catch {
        keymapBackupStore = undefined;
        retainedKeymapState = { phase: "error", backupAvailable: true, failure: "read" };
      }
      if (request.sdk.kind === "staged") {
        try {
          adapter = await options.loadStagedAdapter(request.sdk, sink);
          if (!isAdapter(adapter) || keymapBackupStore === undefined) {
            adapter = undefined;
          } else {
            keymap = createDedicatedHardwareKeymapController({
              ...adapter.creatorKeymap,
              ...keymapBackupStore
            });
            unsubscribeKeymap = keymap.subscribe(() => publishCurrentKeymap());
            await keymap.initialize().catch(() => undefined);
            retainedKeymapState = undefined;
          }
        } catch {
          adapter = undefined;
          keymap = undefined;
          unsubscribeKeymap?.();
          unsubscribeKeymap = undefined;
        }
      }
      unavailable = adapter === undefined;
      post({
        version: 1,
        generation,
        requestId: request.requestId,
        kind: "ready"
      });
      ready = true;
      if (unavailable) {
        pendingStates.clear();
        for (const model of DEDICATED_HARDWARE_MODEL_IDS) postState(unavailableState(model));
      } else {
        for (const model of DEDICATED_HARDWARE_MODEL_IDS) {
          postDeviceState(pendingStates.get(model) ?? disabledDeviceState(model));
        }
        pendingStates.clear();
      }
      return "continue";
    }

    if (generation === undefined || request.generation !== generation) {
      closed = true;
      return "terminate";
    }
    lastRequestSequence = requestSequence;

    if (request.kind === "set-desired-state") {
      if (unavailable || adapter === undefined) {
        post({ version: 1, generation, requestId: request.requestId, kind: "ack" });
        postState(request.settings.enabled ? unavailableState(request.model) : disabledState(request.model));
        return "continue";
      }
      try {
        if (request.model === "creator-micro-2") {
          creatorDesired = {
            settings: request.settings,
            preview: request.preview
          };
          creatorInputForcedDisabled = false;
          creatorInputConnected = false;
        }
        if (request.model === "creator-micro-2" && !request.settings.enabled) {
          await releaseCreatorKeymap().catch(() => undefined);
        }
        const state = await adapter.setDesiredState(request.model, {
          settings: request.settings,
          preview: request.preview
        });
        if (state.model !== request.model) throw new Error("Adapter returned the wrong model.");
        await acceptAdapterState(state);
        post({ version: 1, generation, requestId: request.requestId, kind: "ack" });
      } catch {
        postState(failedState(request.model));
      }
      return "continue";
    }

    if (request.kind === "set-lighting-state") {
      if (!unavailable && adapter !== undefined) adapter.setLightingState(request.model, request.state);
      post({ version: 1, generation, requestId: request.requestId, kind: "ack" });
      return "continue";
    }

    if (request.kind === "probe") {
      if (unavailable || adapter === undefined) {
        post({ version: 1, generation, requestId: request.requestId, kind: "ack" });
        postState(unavailableState(request.model));
        return "continue";
      }
      try {
        const state = await adapter.probe(request.model);
        if (state.model !== request.model) throw new Error("Adapter returned the wrong model.");
        await acceptAdapterState(state);
        post({ version: 1, generation, requestId: request.requestId, kind: "ack" });
      } catch {
        postState(failedState(request.model));
      }
      return "continue";
    }

    if (request.kind === "inspect-keymap") {
      const state = deviceStates.get(request.model) ?? disabledDeviceState(request.model);
      postState({ ...publicDeviceState(state), keymap: keymapSnapshot(request.model) });
      post({ version: 1, generation, requestId: request.requestId, kind: "ack" });
      return "continue";
    }

    if (request.kind === "recover-keymap") {
      creatorInputConnected = false;
      if (unavailable || adapter === undefined || keymap === undefined) {
        postState(unavailableState(request.model));
        post({ version: 1, generation, requestId: request.requestId, kind: "ack" });
        return "continue";
      }
      let restored = false;
      try {
        await keymap.recover();
        restored = true;
      } catch {
        // The controller already published the exact retained recovery state.
      }
      const current = deviceStates.get(request.model);
      if (restored && creatorDesired?.settings.enabled === true && current?.status === "connected" &&
          isDedicatedHardwareKeymapDeviceFirmwareIdentity(current.keymapDeviceFirmwareIdentity)) {
        await keymap.occupy(
          creatorDesired.settings.layout.taskKeys,
          current.keymapDeviceFirmwareIdentity
        ).catch(() => undefined);
        if (keymap.getState().phase !== "occupied") {
          creatorInputForcedDisabled = true;
          try {
            const disabled = await adapter.setDesiredState("creator-micro-2", {
              settings: { ...creatorDesired.settings, enabled: false },
              preview: false
            });
            if (disabled.model !== "creator-micro-2") throw new Error("Adapter returned the wrong model.");
            await acceptAdapterState(disabled, false);
          } catch {
            // The keymap state remains the fail-closed authority if low-level disable cannot be confirmed.
          }
        } else {
          creatorInputForcedDisabled = false;
          creatorInputConnected = true;
        }
      }
      publishCurrentKeymap();
      post({ version: 1, generation, requestId: request.requestId, kind: "ack" });
      return "continue";
    }

    closed = true;
    await adapterStateTail.catch(() => undefined);
    try {
      await releaseCreatorKeymap();
    } catch {
      // Planned shutdown must finish; the durable backup remains explicit recovery authority.
    }
    unsubscribeKeymap?.();
    unsubscribeKeymap = undefined;
    if (adapter !== undefined) {
      try {
        await adapter.stop();
      } catch {
        return "terminate";
      }
    }
    post({ version: 1, generation, requestId: request.requestId, kind: "stopped" });
    return "stopped";
  };

  return Object.freeze({
    handle: (value: unknown) => {
      const running = tail.then(() => handleOne(value), () => handleOne(value));
      tail = running;
      return running;
    }
  });
}

function validRequestOrder(
  requestGeneration: number,
  requestId: string,
  activeGeneration: number | undefined,
  priorSequence: number
): boolean {
  if (activeGeneration !== undefined && requestGeneration !== activeGeneration) return false;
  const match = /^g([1-9][0-9]*):([1-9][0-9]*)$/u.exec(requestId);
  if (match === null || Number(match[1]) !== requestGeneration) return false;
  const sequence = Number(match[2]);
  return Number.isSafeInteger(sequence) && sequence > priorSequence;
}

function requestSequenceOf(requestId: string): number | undefined {
  const match = /^g[1-9][0-9]*:([1-9][0-9]*)$/u.exec(requestId);
  if (match === null) return undefined;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

function isAdapter(value: unknown): value is DedicatedHardwareUtilityAdapter {
  return typeof value === "object" && value !== null &&
    isKeymapAdapter((value as DedicatedHardwareUtilityAdapter).creatorKeymap) &&
    typeof (value as DedicatedHardwareUtilityAdapter).setDesiredState === "function" &&
    typeof (value as DedicatedHardwareUtilityAdapter).setLightingState === "function" &&
    typeof (value as DedicatedHardwareUtilityAdapter).probe === "function" &&
    typeof (value as DedicatedHardwareUtilityAdapter).stop === "function";
}

function isKeymapAdapter(value: unknown): value is DedicatedHardwareKeymapDeviceAdapter {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as DedicatedHardwareKeymapDeviceAdapter;
  return typeof candidate.readDeviceFirmwareIdentity === "function" &&
    typeof candidate.readCurrent === "function" &&
    typeof candidate.buildManaged === "function" &&
    typeof candidate.writeCurrent === "function" &&
    typeof candidate.reload === "function";
}

function projectKeymap(state: DedicatedHardwareKeymapState): DedicatedHardwareKeymapSnapshot {
  return {
    phase: state.phase,
    backupAvailable: state.backupAvailable,
    failure: state.failure
  };
}

function unavailableKeymap(): DedicatedHardwareKeymapSnapshot {
  return { phase: "unavailable", backupAvailable: null, failure: null };
}

function disabledDeviceState(model: DedicatedHardwareModelId): DedicatedHardwareUtilityDeviceSnapshot {
  return {
    model,
    status: "disabled",
    reason: null,
    devicePresent: null,
    transport: null,
    firmwareVersion: null,
    batteryPercent: null,
    charging: null,
    inputPermission: "unknown",
    keymapDeviceFirmwareIdentity: null
  };
}

function publicDeviceState(
  state: DedicatedHardwareUtilityDeviceSnapshot
): Omit<DedicatedHardwareConnectionSnapshot, "keymap"> {
  const { keymapDeviceFirmwareIdentity: identity, ...projected } = state;
  if (state.model === "codex-micro" && identity !== null) {
    throw new Error("Codex Micro cannot publish a Creator keymap identity.");
  }
  if (identity !== null && !isDedicatedHardwareKeymapDeviceFirmwareIdentity(identity)) {
    throw new Error("Dedicated hardware keymap identity is invalid.");
  }
  return projected;
}

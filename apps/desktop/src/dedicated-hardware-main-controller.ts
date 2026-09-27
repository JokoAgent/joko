import {
  DEDICATED_HARDWARE_MODEL_IDS,
  cloneDedicatedHardwareSettings,
  parseDedicatedHardwareSettings,
  type DedicatedHardwareModelId,
  type DedicatedHardwareSettings
} from "./dedicated-hardware/settings.js";
import type {
  DedicatedHardwareConnectionSnapshot,
  DedicatedHardwareInputEvent
} from "./dedicated-hardware/protocol.js";
import {
  parseDedicatedHardwareTaskCatalog,
  selectDedicatedHardwareTaskSlots,
  type DedicatedHardwareSelectedTaskSlot,
  type DedicatedHardwareTaskCatalog,
  type DedicatedHardwareTaskSlotSelection
} from "./dedicated-hardware/task-catalog.js";
import {
  dedicatedHardwareSettingsStateError,
  type DedicatedHardwareSettingsRead,
  type DedicatedHardwareSettingsStore
} from "./dedicated-hardware/settings-store.js";
import type { DedicatedHardwareHostClient } from "./dedicated-hardware/host-client.js";

export interface DedicatedHardwareProjectedTaskSlot {
  readonly slot: number;
  readonly sessionId: string | null;
  readonly title: string | null;
}

export interface DedicatedHardwareProjectedModelState extends DedicatedHardwareConnectionSnapshot {
  readonly settingsError: "invalid" | "unavailable" | null;
  readonly settings: DedicatedHardwareSettings;
  readonly taskSlots: readonly DedicatedHardwareProjectedTaskSlot[];
}

export interface DedicatedHardwareProjectedState {
  readonly version: 1;
  readonly models: Readonly<Record<DedicatedHardwareModelId, DedicatedHardwareProjectedModelState>>;
}

export type DedicatedHardwarePreviewInput = Readonly<{
  version: 1;
  model: DedicatedHardwareModelId;
} & DedicatedHardwareInputEvent>;

export interface DedicatedHardwarePhysicalInputController {
  readonly updateModel: (
    model: DedicatedHardwareModelId,
    state: {
      readonly settings: DedicatedHardwareSettings;
      readonly taskSlots: DedicatedHardwareTaskSlotSelection;
    }
  ) => void;
  readonly handleInput: (model: DedicatedHardwareModelId, input: DedicatedHardwareInputEvent) => void;
  readonly setPreview: (model: DedicatedHardwareModelId, enabled: boolean) => void;
  readonly cancelModel: (model: DedicatedHardwareModelId) => void;
  readonly cancelAll: () => void;
}

export interface DedicatedHardwareMainController<Owner> {
  readonly initialize: () => Promise<DedicatedHardwareProjectedState>;
  readonly snapshot: () => DedicatedHardwareProjectedState;
  readonly setSettings: (
    model: DedicatedHardwareModelId,
    settings: DedicatedHardwareSettings
  ) => Promise<DedicatedHardwareProjectedState>;
  readonly resetSettings: (
    model: DedicatedHardwareModelId,
    scope: "layout" | "all"
  ) => Promise<DedicatedHardwareProjectedState>;
  readonly publishTasks: (catalog: unknown) => DedicatedHardwareProjectedState;
  readonly setPreview: (model: DedicatedHardwareModelId, owner: Owner, enabled: boolean) => void;
  readonly retireOwner: (owner: Owner) => void;
  readonly probe: (model: DedicatedHardwareModelId) => boolean;
  readonly recoverKeymap: (model: "creator-micro-2") => Promise<DedicatedHardwareProjectedState>;
  readonly dispose: () => Promise<void>;
}

const EMPTY_CATALOG: DedicatedHardwareTaskCatalog = Object.freeze({
  version: 1,
  profileId: "unavailable",
  serverId: "unavailable",
  connectionGeneration: "0",
  snapshotRevision: "0",
  tasks: Object.freeze([])
});

export function createDedicatedHardwareMainController<Owner>(options: {
  readonly store: DedicatedHardwareSettingsStore;
  readonly host: DedicatedHardwareHostClient;
  readonly input: DedicatedHardwarePhysicalInputController;
  readonly ownersEqual?: (left: Owner, right: Owner) => boolean;
  readonly onStateChanged?: (state: DedicatedHardwareProjectedState) => void;
  readonly onPreviewInput?: (owner: Owner, input: DedicatedHardwarePreviewInput) => void;
}): DedicatedHardwareMainController<Owner> {
  const ownersEqual = options.ownersEqual ?? Object.is;
  const reads = new Map<DedicatedHardwareModelId, DedicatedHardwareSettingsRead>();
  const connections = new Map<DedicatedHardwareModelId, DedicatedHardwareConnectionSnapshot>();
  const selections = new Map<DedicatedHardwareModelId, DedicatedHardwareTaskSlotSelection>();
  let catalog = EMPTY_CATALOG;
  let preview: { readonly model: DedicatedHardwareModelId; readonly owner: Owner } | undefined;
  let initialized = false;
  let disposed = false;
  let unsubscribeState: (() => void) | undefined;
  let unsubscribeInput: (() => void) | undefined;

  const recomputeModel = (model: DedicatedHardwareModelId): void => {
    const read = reads.get(model);
    if (read === undefined) return;
    const selection = selectDedicatedHardwareTaskSlots(read.settings, catalog);
    selections.set(model, padTaskSelection(selection));
    options.input.updateModel(model, {
      settings: cloneDedicatedHardwareSettings(read.settings),
      taskSlots: padTaskSelection(selection)
    });
  };

  const publishState = (): DedicatedHardwareProjectedState => {
    const state = projectState();
    try { options.onStateChanged?.(state); } catch { /* Renderer observers cannot own the hardware state. */ }
    return state;
  };

  const projectState = (): DedicatedHardwareProjectedState => {
    assertReady();
    const models = {} as Record<DedicatedHardwareModelId, DedicatedHardwareProjectedModelState>;
    for (const model of DEDICATED_HARDWARE_MODEL_IDS) {
      const read = reads.get(model)!;
      const connection = connections.get(model) ?? options.host.getConnectionState(model);
      const slots = selections.get(model)?.slots ?? emptyTaskSlots();
      models[model] = Object.freeze({
        ...connection,
        settingsError: dedicatedHardwareSettingsStateError(read),
        settings: cloneDedicatedHardwareSettings(read.settings),
        taskSlots: Object.freeze(slots.map((slot) => Object.freeze({
          slot: slot.slot,
          sessionId: slot.sessionId,
          title: slot.title
        })))
      });
    }
    return Object.freeze({ version: 1, models: Object.freeze(models) });
  };

  const applyRead = (model: DedicatedHardwareModelId, read: DedicatedHardwareSettingsRead): void => {
    reads.set(model, cloneRead(read));
    recomputeModel(model);
    options.host.setDesiredState(model, {
      settings: cloneDedicatedHardwareSettings(read.settings),
      preview: preview?.model === model
    });
  };

  const cancelModelInput = (model: DedicatedHardwareModelId): void => {
    options.input.cancelModel(model);
  };

  const retireModelPreview = (model: DedicatedHardwareModelId): void => {
    if (preview?.model === model) {
      preview = undefined;
      options.input.setPreview(model, false);
      const read = reads.get(model);
      if (read !== undefined) options.host.setDesiredState(model, { settings: read.settings, preview: false });
    }
  };

  const initialize = async (): Promise<DedicatedHardwareProjectedState> => {
    if (disposed) throw new Error("Dedicated hardware controller is disposed.");
    if (initialized) return projectState();
    const initial = await options.store.initialize();
    for (const model of DEDICATED_HARDWARE_MODEL_IDS) {
      reads.set(model, cloneRead(initial[model]));
      connections.set(model, options.host.getConnectionState(model));
    }
    initialized = true;
    for (const model of DEDICATED_HARDWARE_MODEL_IDS) {
      recomputeModel(model);
      const read = reads.get(model)!;
      options.host.setDesiredState(model, { settings: read.settings, preview: false });
    }
    unsubscribeState = options.host.subscribeConnectionState((model, connection) => {
      if (disposed) return;
      connections.set(model, { ...connection });
      if (connection.status !== "connected") {
        cancelModelInput(model);
        retireModelPreview(model);
      }
      publishState();
    });
    unsubscribeInput = options.host.subscribeInput((model, _sequence, input) => {
      if (disposed || connections.get(model)?.status !== "connected") return;
      const activePreview = preview;
      if (activePreview?.model === model) {
        options.input.handleInput(model, input);
        try {
          options.onPreviewInput?.(activePreview.owner, Object.freeze({ version: 1, model, ...input }));
        } catch {
          // A renderer preview cannot make the physical input path actionable.
        }
        return;
      }
      options.input.handleInput(model, input);
    });
    const inspected = await options.host.inspectCreatorKeymapRecovery().catch(() => undefined);
    if (inspected !== undefined && !disposed) {
      connections.set("creator-micro-2", { ...inspected });
    }
    return projectState();
  };

  const controller: DedicatedHardwareMainController<Owner> = {
    initialize,
    snapshot: projectState,
    setSettings: async (model, settings) => {
      assertReady();
      const parsed = parseDedicatedHardwareSettings(settings);
      if (parsed === undefined) throw new TypeError("Invalid dedicated hardware settings.");
      const prior = reads.get(model)!;
      const next = await options.store.save(model, parsed);
      if (requiresCancellation(prior.settings, next.settings)) cancelModelInput(model);
      if (!next.settings.enabled) retireModelPreview(model);
      applyRead(model, next);
      return publishState();
    },
    resetSettings: async (model, scope) => {
      assertReady();
      if (scope !== "layout" && scope !== "all") throw new TypeError("Invalid dedicated hardware reset scope.");
      cancelModelInput(model);
      const next = await options.store.reset(model, scope);
      if (!next.settings.enabled) retireModelPreview(model);
      applyRead(model, next);
      return publishState();
    },
    publishTasks: (value) => {
      assertReady();
      const parsed = parseDedicatedHardwareTaskCatalog(value);
      if (parsed === undefined) throw new TypeError("Invalid dedicated hardware task catalog.");
      if (!catalogMayAdvance(catalog, parsed)) return projectState();
      if (JSON.stringify(parsed) === JSON.stringify(catalog)) return projectState();
      catalog = parsed;
      for (const model of DEDICATED_HARDWARE_MODEL_IDS) recomputeModel(model);
      return publishState();
    },
    setPreview: (model, owner, enabled) => {
      assertReady();
      const read = reads.get(model)!;
      if (!read.settings.enabled || connections.get(model)?.status !== "connected") {
        throw new Error("Dedicated hardware preview requires a connected enabled device.");
      }
      if (enabled) {
        const current = preview;
        if (current !== undefined && (!ownersEqual(current.owner, owner) || current.model !== model)) {
          throw new Error("Dedicated hardware preview is already owned by another scope.");
        }
        if (current !== undefined) return;
        options.input.setPreview(model, true);
        preview = Object.freeze({ model, owner });
        options.host.setDesiredState(model, { settings: read.settings, preview: true });
        return;
      }
      if (preview === undefined) return;
      if (!ownersEqual(preview.owner, owner) || preview.model !== model) {
        throw new Error("Dedicated hardware preview can only be stopped by its owner.");
      }
      preview = undefined;
      options.input.setPreview(model, false);
      options.host.setDesiredState(model, { settings: read.settings, preview: false });
    },
    retireOwner: (owner) => {
      if (preview === undefined || !ownersEqual(preview.owner, owner)) return;
      const model = preview.model;
      preview = undefined;
      options.input.setPreview(model, false);
      const read = reads.get(model);
      if (read !== undefined) options.host.setDesiredState(model, { settings: read.settings, preview: false });
    },
    probe: (model) => {
      assertReady();
      if (options.host.probe(model)) return true;
      if (!reads.get(model)!.settings.enabled) return false;
      options.host.retry();
      return true;
    },
    recoverKeymap: async (model) => {
      assertReady();
      if (model !== "creator-micro-2") throw new TypeError("Keymap recovery is only available for Creator Micro 2.");
      const recovered = await options.host.recoverCreatorKeymap();
      connections.set("creator-micro-2", { ...recovered });
      return publishState();
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      unsubscribeState?.();
      unsubscribeInput?.();
      unsubscribeState = undefined;
      unsubscribeInput = undefined;
      preview = undefined;
      for (const model of DEDICATED_HARDWARE_MODEL_IDS) options.input.setPreview(model, false);
      options.input.cancelAll();
      await options.host.stop();
    }
  };
  return Object.freeze(controller);

  function assertReady(): void {
    if (!initialized || disposed) throw new Error("Dedicated hardware controller is unavailable.");
  }
}

function requiresCancellation(
  prior: DedicatedHardwareSettings,
  next: DedicatedHardwareSettings
): boolean {
  return prior.enabled !== next.enabled
    || JSON.stringify(prior.layout) !== JSON.stringify(next.layout)
    || prior.taskSource !== next.taskSource
    || prior.singleTapTaskKeys !== next.singleTapTaskKeys
    || JSON.stringify(prior.customTaskSlots) !== JSON.stringify(next.customTaskSlots);
}

function padTaskSelection(selection: DedicatedHardwareTaskSlotSelection): DedicatedHardwareTaskSlotSelection {
  const slots: DedicatedHardwareSelectedTaskSlot[] = [];
  for (let slot = 0; slot < 6; slot += 1) {
    const selected = selection.slots.find((candidate) => candidate.slot === slot);
    slots.push(selected ?? Object.freeze({
      slot,
      sessionId: null,
      sessionGeneration: null,
      targetId: null,
      title: null,
      binding: null
    }));
  }
  return Object.freeze({ ...selection, slots: Object.freeze(slots) });
}

function emptyTaskSlots(): readonly DedicatedHardwareSelectedTaskSlot[] {
  return padTaskSelection({ ...EMPTY_CATALOG, slots: [] }).slots;
}

function cloneRead(value: DedicatedHardwareSettingsRead): DedicatedHardwareSettingsRead {
  return value.error === undefined
    ? { settings: cloneDedicatedHardwareSettings(value.settings) }
    : { settings: cloneDedicatedHardwareSettings(value.settings), error: value.error };
}

function catalogMayAdvance(
  prior: DedicatedHardwareTaskCatalog,
  next: DedicatedHardwareTaskCatalog
): boolean {
  if (prior === EMPTY_CATALOG || prior.profileId !== next.profileId || prior.serverId !== next.serverId) return true;
  const generation = compareDecimal(next.connectionGeneration, prior.connectionGeneration);
  if (generation !== 0) return generation > 0;
  return compareDecimal(next.snapshotRevision, prior.snapshotRevision) >= 0;
}

function compareDecimal(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

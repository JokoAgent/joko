import type { AppSnapshot, BackendView, ModelView, NewSessionDraftSelection, PermissionMode, TargetView } from "../model.js";
import { isRoutableConversationModel } from "../model-capabilities.js";
import { advertisedPermissionModes } from "./backend-control-capabilities.js";

export interface NewSessionExecutionOptions {
  readonly availableModels: readonly ModelView[];
  readonly selectedModel?: ModelView;
  readonly modelSwitchSupported: boolean;
  readonly modelSelectable: boolean;
  readonly effortSupported: boolean;
  readonly effortSelectable: boolean;
  readonly fastModeSupported: boolean;
  readonly fastModeSelectable: boolean;
  readonly permissionModes: readonly PermissionMode[];
  readonly permissionSelectable: boolean;
  readonly planModeSupported: boolean;
}

type BackendNewTaskSettings = AppSnapshot["settings"]["backendSettings"];

export function resolveNewSessionExecutionOptions(backend: BackendView | undefined, models: readonly ModelView[], modelKey: string): NewSessionExecutionOptions {
  const availableModels = backend === undefined
    ? []
    : models.filter((model) => model.backendId === backend.id && isRoutableConversationModel(model));
  const modelSwitchSupported = backend?.capabilities.get("model.switch")?.supported === true;
  const selectedModel = modelSwitchSupported ? availableModels.find((model) => modelKeyFor(model.providerId, model.modelId) === modelKey) : undefined;
  const effortSupported = backend?.capabilities.get("model.effort")?.supported === true;
  const fastModeSupported = backend?.capabilities.get("model.fast_mode")?.supported === true;
  const permissionModes = newSessionPermissionModes(backend);
  return {
    availableModels,
    ...(selectedModel === undefined ? {} : { selectedModel }),
    modelSwitchSupported,
    modelSelectable: modelSwitchSupported && availableModels.length > 0,
    effortSupported,
    effortSelectable: effortSupported && (selectedModel?.efforts.length ?? 0) > 0,
    fastModeSupported,
    fastModeSelectable: fastModeSupported && selectedModel?.supportsFast === true,
    permissionModes,
    permissionSelectable: backend?.capabilities.get("permission.modes")?.supported === true && permissionModes.length > 1,
    planModeSupported: backend?.capabilities.get("plan_mode")?.supported === true
  };
}

export function newSessionTargets(
  targets: readonly TargetView[],
  settings: BackendNewTaskSettings
): readonly TargetView[] {
  return targets.filter((target) => !target.archived && backendAcceptsNewTasks(target.backendId, settings));
}

export function dialogueBackends(
  backends: readonly BackendView[],
  settings?: BackendNewTaskSettings
): readonly BackendView[] {
  return backends.filter((backend) => backend.health !== "unavailable"
    && backend.capabilities.get("input.text")?.supported === true
    && (settings === undefined || backendAcceptsNewTasks(backend.id, settings)));
}

export function newSessionSelectionValue(selection: NewSessionDraftSelection): string {
  return selection.kind === "target" ? `target:${selection.targetId}` : `dialogue:${selection.backendId}`;
}

export function parseNewSessionSelection(
  value: string,
  targets: readonly TargetView[],
  backends: readonly BackendView[]
): NewSessionDraftSelection | undefined {
  const separator = value.indexOf(":");
  if (separator < 0) return undefined;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (kind === "target" && targets.some((target) => target.id === id && !target.archived)) return { kind: "target", targetId: id };
  if (kind === "dialogue" && dialogueBackends(backends).some((backend) => backend.id === id)) return { kind: "dialogue", backendId: id };
  return undefined;
}

export function defaultNewSessionSelection(
  targets: readonly TargetView[],
  backends: readonly BackendView[]
): NewSessionDraftSelection | undefined {
  const target = targets.find((candidate) => !candidate.archived);
  if (target !== undefined) return { kind: "target", targetId: target.id };
  const backend = dialogueBackends(backends)[0];
  return backend === undefined ? undefined : { kind: "dialogue", backendId: backend.id };
}

function newSessionPermissionModes(backend: AppSnapshot["backends"][number] | undefined): readonly PermissionMode[] {
  const modes = advertisedPermissionModes(backend);
  // Ask remains the safe creation default. Other modes require an exact
  // option advertised by the current Backend instance.
  return modes.length > 0 ? modes : ["ask"];
}

function modelKeyFor(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function backendAcceptsNewTasks(backendId: string, settings: BackendNewTaskSettings): boolean {
  return settings.find((setting) => setting.backendId === backendId)?.enabled ?? true;
}

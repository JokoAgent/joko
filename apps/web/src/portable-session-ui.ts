import type {
  AppSnapshot,
  PortableSessionExecutionSelection,
  PortableSessionTargetOption,
  SessionView
} from "./model.js";
import { resolveNewSessionExecutionOptions } from "./components/new-session-options.js";

export const PORTABLE_SESSION_MEDIA_TYPE = "application/vnd.joko.session";

type PortableSessionSnapshot = Pick<AppSnapshot, "backends" | "models" | "settings" | "targets" | "workspaces">;

export function portableSessionExportSupported(
  session: SessionView,
  snapshot: Pick<AppSnapshot, "backends">
): boolean {
  if (session.remoteWorkspace === true) return false;
  return snapshot.backends
    .find((backend) => backend.id === session.backendId)
    ?.capabilities.get("session.portable_transfer")?.supported === true;
}

export function portableSessionTargetOptions(
  snapshot: PortableSessionSnapshot,
  worktreeSupportedTargetIds: ReadonlySet<string> = new Set()
): readonly PortableSessionTargetOption[] {
  return snapshot.targets.flatMap((target) => {
    if (target.archived) return [];
    const backend = snapshot.backends.find((candidate) => candidate.id === target.backendId);
    if (backend?.health === "unavailable"
      || backend?.capabilities.get("session.portable_transfer")?.supported !== true) return [];
    const workspace = snapshot.workspaces.find((candidate) => candidate.id === target.workspaceId);
    if (workspace === undefined) return [];
    return [{
      id: target.id,
      label: target.name === target.workspaceName
        ? target.name
        : `${target.name} · ${target.workspaceName}`,
      worktreeSupported: worktreeSupportedTargetIds.has(target.id)
    }];
  });
}

export function portableSessionWorktreeProbeTargetIds(snapshot: PortableSessionSnapshot): readonly string[] {
  const compatible = new Set(portableSessionTargetOptions(snapshot).map((target) => target.id));
  return snapshot.targets.flatMap((target) => {
    if (!compatible.has(target.id) || target.remoteWorkspace !== undefined) return [];
    const workspace = snapshot.workspaces.find((candidate) => candidate.id === target.workspaceId);
    return workspace?.kind === "userProject" ? [target.id] : [];
  });
}

export function portableSessionExecutionForTarget(
  snapshot: PortableSessionSnapshot,
  targetId: string
): PortableSessionExecutionSelection | undefined {
  const target = snapshot.targets.find((candidate) => candidate.id === targetId && !candidate.archived);
  if (target === undefined) return undefined;
  const backend = snapshot.backends.find((candidate) => candidate.id === target.backendId);
  if (backend === undefined || backend.health === "unavailable"
    || backend.capabilities.get("session.portable_transfer")?.supported !== true) return undefined;

  const defaults = snapshot.settings.backendSettings.find((candidate) => candidate.backendId === backend.id);
  const availableOptions = resolveNewSessionExecutionOptions(backend, snapshot.models, "");
  const preferredModel = defaults?.model === undefined
    ? availableOptions.availableModels[0]
    : availableOptions.availableModels.find((model) => model.providerId === defaults.model?.providerId
      && model.modelId === defaults.model.modelId);
  const modelKey = preferredModel === undefined ? "" : `${preferredModel.providerId}\u0000${preferredModel.modelId}`;
  const options = resolveNewSessionExecutionOptions(backend, snapshot.models, modelKey);
  const selectedModel = options.modelSwitchSupported ? options.selectedModel : undefined;
  if (options.modelSwitchSupported && selectedModel === undefined) return undefined;
  const preferredEffort = defaults?.model?.effort;
  const effort = options.effortSelectable
    ? preferredEffort !== undefined && selectedModel?.efforts.includes(preferredEffort) === true
      ? preferredEffort
      : selectedModel?.efforts[0]
    : undefined;
  const defaultPermission = defaults?.permissionMode ?? snapshot.settings.policy.defaultMode;
  return {
    ...(selectedModel === undefined ? {} : {
      providerId: selectedModel.providerId,
      modelId: selectedModel.modelId
    }),
    ...(effort === undefined ? {} : { effort }),
    fastMode: options.fastModeSelectable && (defaults?.model?.fastMode ?? false),
    permissionMode: options.permissionModes.includes(defaultPermission)
      ? defaultPermission
      : options.permissionModes[0] ?? "ask",
    planMode: options.planModeSupported && (defaults?.planMode ?? false)
  };
}

export function browserFileFromDesktopFile(file: JokoDesktopFile): File {
  return new File([Uint8Array.from(file.bytes)], file.name, {
    type: file.mediaType || PORTABLE_SESSION_MEDIA_TYPE
  });
}

export function isPortableSessionFile(file: Pick<File, "name">): boolean {
  return file.name.toLocaleLowerCase("en-US").endsWith(".jshare");
}

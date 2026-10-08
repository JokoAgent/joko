import {
  McpServerState,
  ResourceState,
  SessionState,
  TargetState,
  type Snapshot
} from "@joko/contracts";
import {
  markMobileComposerSlashCommand,
  normalizeMobileComposerDraft,
  replaceMobileComposerRange,
  type MobileComposerDraft
} from "./mobile-composer-document";
import {
  mobileExtensionOwnerKey,
  type MobileExtension,
  type MobileExtensionCommand,
  type MobileExtensionTaskChoice
} from "./mobile-extensions";

interface MobileExtensionUseAuthority {
  readonly backendId?: string;
  readonly targetId?: string;
}

/** A task-use action may only start from a complete, enabled Extension projection. */
export function mobileExtensionUseReady(extension: MobileExtension): boolean {
  return extension.installed
    && (extension.installState === "installed" || extension.installState === "updateAvailable")
    && extension.enabled
    && extension.useSupported
    && extension.owner.kind !== "source"
    && (extension.setup.state === "ready" || extension.setup.state === "notRequired");
}

/** Revalidates the exact displayed Extension and the command advertised by a
 * fresh runtime-scoped detail. Existing-task handoffs deliberately replace the
 * advertising Session with the selected destination Session. */
export function resolveMobileExtensionUseCommand(
  expected: MobileExtension,
  command: MobileExtensionCommand,
  current: MobileExtension,
  runtimeSessionId: string
): MobileExtensionCommand {
  if (!mobileExtensionUseReady(expected) || !mobileExtensionUseReady(current)
    || expected.extensionId !== current.extensionId
    || expected.revision !== current.revision
    || mobileExtensionOwnerKey(expected.owner) !== mobileExtensionOwnerKey(current.owner)
    || !validIdentity(runtimeSessionId)
    || !validCommandName(command.name)
    || command.description.length > 2_048) {
    throw new Error("The Extension command changed or is no longer available.");
  }
  const matches = current.commands.filter((candidate) => candidate.name === command.name
    && candidate.description === command.description && candidate.sessionId === runtimeSessionId);
  if (matches.length !== 1) throw new Error("The selected Extension command is not loaded in this task runtime.");
  return matches[0]!;
}

/** Returns only live task runtimes to which the exact Extension owner applies. */
export function projectMobileExtensionTaskChoices(
  snapshot: Snapshot | undefined,
  extension: MobileExtension
): readonly MobileExtensionTaskChoice[] {
  let authority: MobileExtensionUseAuthority;
  try {
    authority = mobileExtensionUseAuthority(snapshot, extension);
  } catch {
    return [];
  }
  if (!snapshot) return [];
  const targets = new Map(snapshot.targets.map((target) => [target.targetId, target] as const));
  return snapshot.sessions.filter((session) => {
    const target = targets.get(session.targetId);
    return !session.archived && (session.state === SessionState.IDLE
      || session.state === SessionState.RUNNING
      || session.state === SessionState.WAITING
      || session.state === SessionState.DETACHED
      || session.state === SessionState.RECOVERING)
      && session.nativeBinding?.runtimeGeneration !== undefined
      && session.nativeBinding.runtimeGeneration > 0n
      && target?.state === TargetState.ACTIVE
      && (authority.backendId === undefined || session.backendId === authority.backendId)
      && (authority.targetId === undefined || session.targetId === authority.targetId);
  }).map((session) => ({
    sessionId: session.sessionId,
    displayName: session.displayName,
    targetName: targets.get(session.targetId)?.displayName ?? ""
  })).sort((left, right) => left.displayName.localeCompare(right.displayName, "en", { sensitivity: "base" })
    || left.targetName.localeCompare(right.targetName, "en", { sensitivity: "base" })
    || left.sessionId.localeCompare(right.sessionId, "en"));
}

/** Resource-owned Extensions route new tasks to their exact project. Global
 * Resource and MCP owners retain the user's current new-task selection. */
export function mobileExtensionNewTaskTarget(
  snapshot: Snapshot | undefined,
  extension: MobileExtension
): string | undefined {
  return mobileExtensionUseAuthority(snapshot, extension).targetId;
}

export function assertMobileExtensionTaskChoice(
  snapshot: Snapshot | undefined,
  extension: MobileExtension,
  sessionId: string
): MobileExtensionTaskChoice {
  if (!validIdentity(sessionId)) throw new Error("Select a current task for this Extension command.");
  const matches = projectMobileExtensionTaskChoices(snapshot, extension)
    .filter((candidate) => candidate.sessionId === sessionId);
  if (matches.length !== 1) throw new Error("The selected task is no longer available for this Extension command.");
  return matches[0]!;
}

/** Places the command in the leading slash-command slot while preserving every
 * other structured range and attachment. New-task drafts keep it as plain text
 * because they do not own a runtime command catalog before Session creation. */
export function applyMobileExtensionUseCommand(
  draft: MobileComposerDraft,
  commandName: string,
  selectedRuntimeCommand: boolean
): MobileComposerDraft {
  if (!validCommandName(commandName)) throw new Error("The Extension command name is invalid.");
  const current = normalizeMobileComposerDraft(draft);
  const desired = `/${commandName}`;
  const leading = /^\/[^\s/]+/u.exec(current.text)?.[0];
  if (leading === desired && !selectedRuntimeCommand) return current;
  const to = leading?.length ?? 0;
  const replacement = leading === undefined ? `${desired} ` : desired;
  const result = replaceMobileComposerRange(current, { start: 0, end: to }, replacement).draft;
  return selectedRuntimeCommand ? markMobileComposerSlashCommand(result, 0, desired) : result;
}

function mobileExtensionUseAuthority(
  snapshot: Snapshot | undefined,
  extension: MobileExtension
): MobileExtensionUseAuthority {
  if (!snapshot || !mobileExtensionUseReady(extension)) {
    throw new Error("The Extension is not ready for task use.");
  }
  const owner = extension.owner;
  if (owner.kind === "source") throw new Error("Install this Extension before using it in a task.");
  if (owner.kind === "mcp") {
    const servers = snapshot.mcpServers.filter((server) => server.mcpServerId === owner.serverId
      && server.version?.revision?.value === owner.serverRevision
      && server.enabled
      && (server.state === McpServerState.CONNECTED || server.state === McpServerState.DEGRADED));
    if (servers.length !== 1) throw new Error("The Extension MCP owner is no longer current.");
    return {};
  }
  const resources = snapshot.resources.filter((resource) => resource.resourceId === owner.resourceId
    && resource.discoveredRevision === owner.discoveredRevision
    && resource.entityVersion?.revision?.value === owner.resourceRevision
    && resource.enabled
    && resource.state !== ResourceState.DISABLED
    && resource.state !== ResourceState.ERROR
    && resource.state !== ResourceState.REMOVED);
  if (resources.length !== 1) throw new Error("The Extension Resource owner is no longer current.");
  const resource = resources[0]!;
  if (!validIdentity(resource.backendId)) throw new Error("The Extension Resource Backend is unavailable.");
  if (resource.targetId === "") return { backendId: resource.backendId };
  const targets = snapshot.targets.filter((target) => target.targetId === resource.targetId
    && target.backendId === resource.backendId && target.state === TargetState.ACTIVE);
  if (targets.length !== 1) throw new Error("The Extension Resource project is no longer available.");
  return { backendId: resource.backendId, targetId: resource.targetId };
}

function validCommandName(value: string): boolean {
  return value.length > 0 && value.length <= 160 && value === value.trim()
    && !/[\s/\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 512 && value === value.trim()
    && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

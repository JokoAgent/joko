import type { Capability, TargetDescriptor } from "./types.js";

export const SESSION_REWIND_SERVICE_NODE_ONLY_OPTION = "service_node_only" as const;

export function nativeStartScopeOptionsAreValid(capability: Capability): boolean {
  const options = capability.options ?? [];
  return options.length === 0
    || (options.length === 1 && options[0] === SESSION_REWIND_SERVICE_NODE_ONLY_OPTION);
}

export function supportsNativeStartNavigation(
  capability: Capability | undefined,
  target: Pick<TargetDescriptor, "remoteWorkspace"> | undefined
): boolean {
  if (capability?.supported !== true || !nativeStartScopeOptionsAreValid(capability)) return false;
  return (capability.options?.length ?? 0) === 0
    || (target !== undefined && target.remoteWorkspace === undefined);
}

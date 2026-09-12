import type { CapabilityView, ComposerMentionDraft, SessionResourceView } from "./model.js";

export interface ComposerMentionPolicy {
  readonly files: boolean;
  readonly directories: boolean;
  readonly lineRanges: boolean;
  readonly resources: boolean;
  readonly artifacts: boolean;
  readonly sessions: boolean;
}

/** Every structured mention kind requires an explicit option in the current profile. */
export function resolveComposerMentionPolicy(capability: CapabilityView | undefined): ComposerMentionPolicy {
  const allows = (option: string): boolean => capability?.supported === true && capability.options.includes(option);
  return {
    files: allows("workspace_file"),
    directories: allows("workspace_directory"),
    lineRanges: allows("workspace_file") && allows("workspace_line_range"),
    resources: allows("resource"),
    artifacts: allows("artifact"),
    sessions: allows("session")
  };
}

export function composerMentionsAllowed(
  mentions: readonly ComposerMentionDraft[],
  policy: ComposerMentionPolicy,
  resources: readonly SessionResourceView[]
): boolean {
  return mentions.every((mention) => {
    // Message references become Joko-owned text links, not Backend mention input.
    if (mention.kind === "message") return true;
    if (mention.kind === "artifact") return policy.artifacts;
    if (mention.kind === "session") return policy.sessions;
    if (mention.kind === "resource") return policy.resources && resources.some((resource) =>
      resource.id === mention.reference
      && resource.discoveredRevision === mention.discoveredRevision
      && resource.resourceVersion === mention.resourceVersion
      && resource.runtimeGeneration === mention.runtimeGeneration);
    return mention.directory === true ? policy.directories : policy.files && (mention.lineRange === undefined || policy.lineRanges);
  });
}

import type {
  ExtensionCatalogEntryView,
  ExtensionCatalogView,
  ExtensionPackagePreviewView,
  ExtensionRecommendationView,
  PendingExtensionSuggestionView,
  ResourceView,
  TargetView
} from "./model.js";

export interface LocalizedExtensionRecommendation {
  readonly label: string;
  readonly prompt: string;
}

export type ExtensionSuggestionAdvanceProof =
  | { readonly kind: "packageAdoption"; readonly preview: ExtensionPackagePreviewView }
  | { readonly kind: "catalogMutation"; readonly previous: ExtensionCatalogEntryView };

export interface ExtensionSuggestionApplicabilityContext {
  readonly backendId: string;
  readonly targetId?: string;
  readonly resources: readonly ResourceView[];
}

export function normalizeExtensionRecommendation(value: unknown): ExtensionRecommendationView | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["id", "label", "prompt", "command", "locales"].includes(key))
    || typeof record["id"] !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(record["id"])
    || !validRecommendationLabel(record["label"])
    || !validRecommendationPrompt(record["prompt"])
    || record["command"] !== undefined && !validRecommendationCommand(record["command"])) return undefined;
  const rawLocales = record["locales"];
  if (rawLocales !== undefined && (rawLocales === null || typeof rawLocales !== "object" || Array.isArray(rawLocales))) return undefined;
  const locales: Partial<Record<"en" | "zh-CN", { readonly label: string; readonly prompt: string }>> = {};
  if (rawLocales !== undefined) {
    for (const [locale, raw] of Object.entries(rawLocales as Record<string, unknown>)) {
      if ((locale !== "en" && locale !== "zh-CN") || raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const localized = raw as Record<string, unknown>;
      if (Object.keys(localized).some((key) => key !== "label" && key !== "prompt")
        || !validRecommendationLabel(localized["label"])
        || !validRecommendationPrompt(localized["prompt"])) return undefined;
      locales[locale] = { label: localized["label"], prompt: localized["prompt"] };
    }
  }
  return {
    id: record["id"],
    label: record["label"],
    prompt: record["prompt"],
    ...(record["command"] === undefined ? {} : { command: record["command"] as string }),
    ...(rawLocales === undefined ? {} : { locales })
  };
}

export function localizeExtensionRecommendation(
  recommendation: ExtensionRecommendationView,
  locale: string
): LocalizedExtensionRecommendation {
  const localized = (locale === "en" || locale === "zh-CN" ? recommendation.locales?.[locale] : undefined)
    ?? recommendation.locales?.en;
  return {
    label: localized?.label ?? recommendation.label,
    prompt: localized?.prompt ?? recommendation.prompt
  };
}

export function sameExtensionRecommendation(
  left: ExtensionRecommendationView,
  right: ExtensionRecommendationView
): boolean {
  if (left.id !== right.id || left.label !== right.label || left.prompt !== right.prompt || left.command !== right.command) return false;
  if ((left.locales === undefined) !== (right.locales === undefined)) return false;
  return sameLocalizedRecommendation(left.locales?.en, right.locales?.en)
    && sameLocalizedRecommendation(left.locales?.["zh-CN"], right.locales?.["zh-CN"]);
}

export function serializeExtensionSuggestionOwner(
  owner: ExtensionCatalogEntryView["owner"]
): PendingExtensionSuggestionView["owner"] {
  switch (owner.kind) {
    case "resource":
      return {
        kind: "resource",
        resourceId: owner.resourceId,
        discoveredRevision: owner.discoveredRevision,
        resourceRevision: owner.resourceRevision.toString(10)
      };
    case "mcp":
      return {
        kind: "mcp",
        serverId: owner.serverId,
        serverRevision: owner.serverRevision.toString(10)
      };
    case "source":
      return {
        kind: "source",
        sourceId: owner.sourceId,
        sourceRevision: owner.sourceRevision.toString(10),
        entryId: owner.entryId,
        contentRevision: owner.contentRevision
      };
  }
}

export function sameExtensionSuggestionOwner(
  current: ExtensionCatalogEntryView["owner"],
  persisted: PendingExtensionSuggestionView["owner"]
): boolean {
  if (current.kind !== persisted.kind) return false;
  if (current.kind === "resource" && persisted.kind === "resource") {
    return current.resourceId === persisted.resourceId
      && current.discoveredRevision === persisted.discoveredRevision
      && current.resourceRevision.toString(10) === persisted.resourceRevision;
  }
  if (current.kind === "mcp" && persisted.kind === "mcp") {
    return current.serverId === persisted.serverId
      && current.serverRevision.toString(10) === persisted.serverRevision;
  }
  return current.kind === "source" && persisted.kind === "source"
    && current.sourceId === persisted.sourceId
    && current.sourceRevision.toString(10) === persisted.sourceRevision
    && current.entryId === persisted.entryId
    && current.contentRevision === persisted.contentRevision;
}

/** Source entries are selectable only because installation explicitly binds
 * them to the chosen backend. Installed entries fail closed unless their exact
 * Resource generation is global or belongs to the selected project. */
export function extensionSuggestionApplicable(
  extension: ExtensionCatalogEntryView,
  context: ExtensionSuggestionApplicabilityContext
): boolean {
  if (extension.owner.kind === "source") return true;
  if (extension.owner.kind !== "resource") return false;
  const owner = extension.owner;
  return context.resources.some((resource) => resource.id === owner.resourceId
    && resource.discoveredRevision === owner.discoveredRevision
    && resource.backendId === context.backendId
    && resource.state !== "removed"
    && (resource.targetId === undefined || resource.targetId === context.targetId));
}

/** Resolve only an exact, ready descriptor. Command recommendations additionally
 * need the same live runtime command and a session on the selected backend/target. */
export function resolvePendingExtensionSuggestion(
  pending: PendingExtensionSuggestionView,
  catalog: ExtensionCatalogView,
  context: {
    readonly backendId: string;
    readonly targetId?: string;
    readonly targets: readonly TargetView[];
    readonly resources: readonly ResourceView[];
  }
): ExtensionCatalogEntryView | undefined {
  if (pending.phase !== "ready") return undefined;
  const extension = catalog.extensions.find((candidate) => candidate.id === pending.extensionId);
  if (extension === undefined
    || extension.revision.toString(10) !== pending.extensionRevision
    || !sameExtensionSuggestionOwner(extension.owner, pending.owner)
    || !extension.recommendations?.some((candidate) => sameExtensionRecommendation(candidate, pending.recommendation))
    || !extensionSuggestionApplicable(extension, context)
    || !extensionReadyForSuggestion(extension)) return undefined;

  if (pending.backendId !== context.backendId || pending.targetId !== context.targetId) return undefined;
  const targetMatches = pending.targetId === undefined
    || context.targets.some((target) => target.id === pending.targetId && target.backendId === pending.backendId);
  if (!targetMatches) return undefined;

  if (pending.recommendation.command === undefined) {
    return extension;
  }
  // A first task has no runtime yet. Its create-before-send boundary re-reads
  // this exact descriptor against the newly created runtime before dispatch.
  if (pending.runtimeSessionId === undefined) return extension;
  if (!extension.useSupported
    || !extension.commands.some((command) => command.name === pending.recommendation.command
      && command.sessionId === pending.runtimeSessionId)) return undefined;
  return extension;
}

export function extensionSuggestionPrompt(
  extension: Pick<ExtensionCatalogEntryView, "id" | "name">,
  recommendation: Pick<ExtensionRecommendationView, "command">,
  prompt: string
): string {
  return recommendation.command === undefined
    ? `${prompt}\n\nUse the "${extension.name}" Extension (${extension.id}) to complete this task.`
    : `/${recommendation.command}${prompt.length === 0 ? "" : ` ${prompt}`}`;
}

/** Advance only after the caller's successful, explicitly fenced mutation.
 * Catalog refreshes do not carry an advance proof and must never call this. */
export function advancePendingExtensionSuggestion(
  expected: PendingExtensionSuggestionView,
  extension: ExtensionCatalogEntryView,
  proof: ExtensionSuggestionAdvanceProof,
  context: ExtensionSuggestionApplicabilityContext
): PendingExtensionSuggestionView | undefined {
  if (expected.phase !== "setup" || extension.id !== expected.extensionId
    || extension.revision <= BigInt(expected.extensionRevision)
    || !extension.installed
    || !extensionSuggestionApplicable(extension, context)
    || !extension.recommendations?.some((candidate) => sameExtensionRecommendation(candidate, expected.recommendation))) return undefined;

  if (expected.owner.kind === "source") {
    if (proof.kind !== "packageAdoption"
      || proof.preview.action !== "install"
      || proof.preview.extensionId !== expected.extensionId
      || proof.preview.extensionRevision.toString(10) !== expected.extensionRevision
      || proof.preview.backendId !== expected.backendId
      || extension.owner.kind !== "resource"
      || proof.preview.resourceId !== extension.owner.resourceId) return undefined;
  } else {
    if (proof.kind !== "catalogMutation"
      || proof.previous.id !== expected.extensionId
      || proof.previous.revision.toString(10) !== expected.extensionRevision
      || !sameExtensionSuggestionOwner(proof.previous.owner, expected.owner)
      || !proof.previous.recommendations?.some((candidate) => sameExtensionRecommendation(candidate, expected.recommendation))
      || !sameMutableOwner(expected.owner, extension.owner)) return undefined;
  }

  const ready = extensionReadyForSuggestion(extension)
    && (expected.recommendation.command === undefined
      ? true
      : expected.runtimeSessionId === undefined
        ? true
        : expected.runtimeSessionId !== undefined
        && extension.useSupported
        && extension.commands.some((command) => command.name === expected.recommendation.command
          && command.sessionId === expected.runtimeSessionId));
  return {
    ...expected,
    phase: ready ? "ready" : "setup",
    extensionRevision: extension.revision.toString(10),
    owner: serializeExtensionSuggestionOwner(extension.owner)
  };
}

function extensionReadyForSuggestion(extension: ExtensionCatalogEntryView): boolean {
  return extension.installed
    && extension.enabled
    && (extension.setup.state === "ready" || extension.setup.state === "notRequired");
}

function sameMutableOwner(
  previous: Exclude<PendingExtensionSuggestionView["owner"], { readonly kind: "source" }>,
  current: ExtensionCatalogEntryView["owner"]
): boolean {
  if (previous.kind === "resource" && current.kind === "resource") {
    return previous.resourceId === current.resourceId
      && previous.discoveredRevision === current.discoveredRevision
      && current.resourceRevision >= BigInt(previous.resourceRevision);
  }
  return previous.kind === "mcp" && current.kind === "mcp"
    && previous.serverId === current.serverId
    && current.serverRevision >= BigInt(previous.serverRevision);
}

function sameLocalizedRecommendation(
  left: { readonly label: string; readonly prompt: string } | undefined,
  right: { readonly label: string; readonly prompt: string } | undefined
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.label === right.label && left.prompt === right.prompt;
}

function validRecommendationLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 120
    && value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function validRecommendationPrompt(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8_000
    && value.trim().length > 0 && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function validRecommendationCommand(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
}

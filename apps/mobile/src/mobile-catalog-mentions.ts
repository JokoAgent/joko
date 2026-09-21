import {
  ArtifactKind,
  CapabilitySupport,
  ResourceKind,
  TargetState,
  capabilityNames,
  type Artifact,
  type BackendDescriptor,
  type Session,
  type SessionResource,
  type Snapshot
} from "@joko/contracts";
import {
  normalizeMobileComposerDraft,
  type MobileComposerArtifactMention,
  type MobileComposerDraft,
  type MobileComposerResourceMention
} from "./mobile-composer-document";

export interface MobileCatalogMentionPolicy {
  readonly resources: boolean;
  readonly artifacts: boolean;
}

export interface MobileArtifactSource {
  readonly sessionId: string;
  readonly displayText: string;
}

export interface MobileCatalogMentionControls {
  readonly authorityKey: string;
  readonly surfaceOwnerKey: string;
  readonly sessionId: string;
  readonly backendId: string;
  readonly targetId: string;
  readonly runtimeGeneration: string;
  readonly policy: MobileCatalogMentionPolicy;
  readonly artifactSources: readonly MobileArtifactSource[];
}

export interface MobileResourceMentionCandidate {
  readonly kind: "resource";
  readonly resourceId: string;
  readonly displayText: string;
  readonly discoveredRevision: string;
  readonly resourceVersion: string;
  readonly runtimeGeneration: string;
  readonly resourceKind: ResourceKind;
  readonly version?: string;
}

export interface MobileArtifactMentionCandidate {
  readonly kind: "artifact";
  readonly artifactId: string;
  readonly sourceSessionId: string;
  readonly displayText: string;
  readonly sourceDisplayText: string;
  readonly artifactKind: ArtifactKind;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: string;
}

export type MobileCatalogMentionCandidate = MobileResourceMentionCandidate | MobileArtifactMentionCandidate;

export interface MobileResourceMentionCatalog {
  readonly items: readonly MobileResourceMentionCandidate[];
}

export interface MobileArtifactMentionCatalog {
  readonly items: readonly MobileArtifactMentionCandidate[];
  readonly revision: string;
}

export interface MobileCatalogMentionCatalog {
  readonly resources?: MobileResourceMentionCatalog;
  readonly artifacts?: MobileArtifactMentionCatalog;
}

export interface MobileCatalogMentionResults {
  readonly items: readonly MobileCatalogMentionCandidate[];
  readonly truncated: boolean;
}

const maximumVisibleResults = 500;
const maximumDisplayCharacters = 256;

export function createMobileCatalogMentionControls(
  authorityKey: string | undefined,
  owner: Snapshot | undefined,
  detail: Snapshot | undefined,
  selectedId: string | undefined
): MobileCatalogMentionControls | undefined {
  if (!authorityKey || !owner || !detail || !validIdentity(selectedId, 1_024)
    || owner.generation !== detail.generation) return undefined;
  const ownerSession = unique(owner.sessions, (item) => item.sessionId === selectedId);
  const detailSession = unique(detail.sessions, (item) => item.sessionId === selectedId);
  if (!ownerSession || !detailSession || ownerSession.backendId !== detailSession.backendId
    || ownerSession.targetId !== detailSession.targetId
    || entityKey(ownerSession.version) !== entityKey(detailSession.version)) return undefined;
  const generation = detailSession.nativeBinding?.runtimeGeneration;
  if (!generation || generation < 1n || ownerSession.nativeBinding?.runtimeGeneration !== generation
    || detailSession.version?.generation !== generation) return undefined;

  const ownerBackend = unique(owner.backends, (item) => item.backendId === detailSession.backendId);
  const detailBackend = unique(detail.backends, (item) => item.backendId === detailSession.backendId);
  const ownerTarget = unique(owner.targets, (item) => item.targetId === detailSession.targetId);
  const detailTarget = unique(detail.targets, (item) => item.targetId === detailSession.targetId);
  if (!ownerBackend || !detailBackend || !ownerTarget || !detailTarget
    || ownerTarget.backendId !== detailSession.backendId || detailTarget.backendId !== detailSession.backendId
    || ownerTarget.state !== TargetState.ACTIVE || detailTarget.state !== TargetState.ACTIVE
    || entityKey(ownerTarget.version) !== entityKey(detailTarget.version)) return undefined;
  const ownerPolicy = mobileCatalogMentionPolicy(ownerBackend);
  const detailPolicy = mobileCatalogMentionPolicy(detailBackend);
  if (!ownerPolicy || !detailPolicy || !samePolicy(ownerPolicy, detailPolicy)) return undefined;

  const sourceGroups = groupBy(owner.sessions.filter((item) => validIdentity(item.sessionId, 1_024)), (item) => item.sessionId);
  if ([...sourceGroups.values()].some((sessions) => sessions.length !== 1)) return undefined;
  const artifactSources = [...sourceGroups.values()].map(([session]) => ({
    sessionId: session!.sessionId,
    displayText: safeDisplayText(session!)
  })).sort((left, right) => left.displayText.localeCompare(right.displayText, "en")
    || left.sessionId.localeCompare(right.sessionId, "en"));
  if (ownerPolicy.artifacts && !artifactSources.some((source) => source.sessionId === selectedId)) return undefined;

  const surfaceOwnerKey = [
    authorityKey,
    "catalog-mentions",
    detailSession.sessionId,
    detailSession.backendId,
    detailSession.targetId,
    generation.toString(10),
    ownerPolicy.resources ? "resource" : "",
    ownerPolicy.artifacts ? "artifact" : "",
    ...artifactSources.map((source) => {
      const session = sourceGroups.get(source.sessionId)![0]!;
      return [source.sessionId, source.displayText, session.state.toString(10), entityKey(session.version)].join("\u001e");
    })
  ].join("\u001f");
  return {
    authorityKey,
    surfaceOwnerKey,
    sessionId: detailSession.sessionId,
    backendId: detailSession.backendId,
    targetId: detailSession.targetId,
    runtimeGeneration: generation.toString(10),
    policy: detailPolicy,
    artifactSources
  };
}

export function mobileCatalogMentionPolicy(
  backend: BackendDescriptor | undefined
): MobileCatalogMentionPolicy | undefined {
  const capabilities = backend?.capabilities?.capabilities.filter((item) => item.name === capabilityNames.inputMention) ?? [];
  if (capabilities.length !== 1 || capabilities[0]!.support !== CapabilitySupport.SUPPORTED) return undefined;
  const options = capabilities[0]!.options?.kind.case === "input"
    ? capabilities[0]!.options.kind.value.mediaTypes
    : [];
  if (options.length === 0 || new Set(options).size !== options.length) return undefined;
  const policy = { resources: options.includes("resource"), artifacts: options.includes("artifact") };
  return policy.resources || policy.artifacts ? policy : undefined;
}

export function projectMobileResourceMentionCatalog(
  controls: MobileCatalogMentionControls,
  resources: readonly SessionResource[]
): MobileResourceMentionCatalog {
  if (!controls.policy.resources) throw new Error("This Backend does not support Resource references.");
  const items = resources.map((resource): MobileResourceMentionCandidate => {
    if (resource.sessionId !== controls.sessionId
      || resource.runtimeGeneration.toString(10) !== controls.runtimeGeneration
      || !validIdentity(resource.resourceId) || !validIdentity(resource.discoveredRevision)
      || resource.resourceVersion < 1n || !resourceMentionKind(resource.kind)) {
      throw new Error("The Joko node returned a Resource reference outside the current task runtime.");
    }
    return {
      kind: "resource",
      resourceId: resource.resourceId,
      displayText: safeCandidateLabel([resource.name, resource.resourceId], "Resource"),
      discoveredRevision: resource.discoveredRevision,
      resourceVersion: resource.resourceVersion.toString(10),
      runtimeGeneration: resource.runtimeGeneration.toString(10),
      resourceKind: resource.kind,
      ...(resource.version.trim() === "" ? {} : { version: safeMetadataText(resource.version, "Resource version label") })
    };
  }).sort(compareCandidates);
  if (new Set(items.map((item) => item.resourceId)).size !== items.length) {
    throw new Error("The Joko node returned duplicate Resource reference identities.");
  }
  return { items };
}

export function projectMobileArtifactMentionCatalog(
  controls: MobileCatalogMentionControls,
  artifacts: readonly Artifact[],
  revision: string
): MobileArtifactMentionCatalog {
  if (!controls.policy.artifacts) throw new Error("This Backend does not support Artifact references.");
  if (!validIdentity(revision)) throw new Error("The Joko node returned an unfenced Artifact reference catalog.");
  const sources = new Map(controls.artifactSources.map((source) => [source.sessionId, source]));
  const identities = new Set<string>();
  const items = artifacts.map((artifact): MobileArtifactMentionCandidate => {
    const source = sources.get(artifact.sessionId);
    const blob = artifact.blob;
    const identity = `${artifact.sessionId}\u0000${artifact.artifactId}`;
    if (!source || !validIdentity(artifact.artifactId) || identities.has(identity) || !artifactMentionKind(artifact.kind)
      || !blob || !validIdentity(blob.blobId) || !validMetadataText(blob.mediaType)
      || blob.byteSize < 0n || blob.byteSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("The Joko node returned an invalid Artifact reference candidate.");
    }
    identities.add(identity);
    return {
      kind: "artifact",
      artifactId: artifact.artifactId,
      sourceSessionId: artifact.sessionId,
      displayText: safeCandidateLabel([artifact.title, blob.fileName, artifact.artifactId], "Artifact"),
      sourceDisplayText: source.displayText,
      artifactKind: artifact.kind,
      fileName: safeMetadataText(blob.fileName || artifact.title || "Artifact", "Artifact file name"),
      mediaType: safeMetadataText(blob.mediaType, "Artifact media type"),
      byteSize: blob.byteSize.toString(10)
    };
  }).sort(compareCandidates);
  return { items, revision };
}

export function filterMobileCatalogMentionCandidates(
  catalog: MobileCatalogMentionCatalog,
  query: string
): MobileCatalogMentionResults {
  const all = [...(catalog.resources?.items ?? []), ...(catalog.artifacts?.items ?? [])];
  const needle = query.trim().toLocaleLowerCase();
  const matches = needle === "" ? all : all.filter((candidate) => searchableCandidateText(candidate)
    .toLocaleLowerCase().includes(needle));
  return { items: matches.slice(0, maximumVisibleResults), truncated: matches.length > maximumVisibleResults };
}

export function assertMobileCatalogMentionCandidate(
  controls: MobileCatalogMentionControls | undefined,
  catalog: MobileCatalogMentionCatalog,
  value: MobileCatalogMentionCandidate
): MobileCatalogMentionCandidate {
  if (!controls) throw new Error("The catalog reference owner changed. Reopen the reference list and try again.");
  if (value.kind === "resource") {
    if (!controls.policy.resources) throw new Error("This Backend no longer supports Resource references.");
    const matches = (catalog.resources?.items ?? []).filter((item) => item.resourceId === value.resourceId);
    const current = matches.length === 1 ? matches[0] : undefined;
    if (!current || current.discoveredRevision !== value.discoveredRevision
      || current.resourceVersion !== value.resourceVersion || current.runtimeGeneration !== value.runtimeGeneration) {
      throw new Error("The selected Resource is no longer loaded with the same runtime identity.");
    }
    return current;
  }
  if (!controls.policy.artifacts) throw new Error("This Backend no longer supports Artifact references.");
  const matches = (catalog.artifacts?.items ?? []).filter((item) => item.artifactId === value.artifactId
    && item.sourceSessionId === value.sourceSessionId);
  if (matches.length !== 1) throw new Error("The selected Artifact is no longer available in its original task.");
  return matches[0]!;
}

export function assertMobileCatalogMentionDraft(
  controls: MobileCatalogMentionControls | undefined,
  draft: MobileComposerDraft
): MobileComposerDraft {
  const exact = normalizeMobileComposerDraft(draft);
  const mentions = exact.mentions.filter((mention) => mention.kind === "resource" || mention.kind === "artifact");
  if (mentions.length === 0) return exact;
  if (!controls) throw new Error("This Backend no longer supports catalog references. The draft was retained.");
  const sources = new Set(controls.artifactSources.map((source) => source.sessionId));
  for (const mention of mentions) {
    if (mention.kind === "resource") {
      if (!controls.policy.resources) throw new Error("This Backend no longer supports Resource references. The draft was retained.");
      if (mention.runtimeGeneration !== controls.runtimeGeneration) {
        throw new Error("A Resource reference belongs to an earlier task runtime. Remove or replace it before sending.");
      }
    } else {
      if (!controls.policy.artifacts) throw new Error("This Backend no longer supports Artifact references. The draft was retained.");
      if (!sources.has(mention.sourceSessionId)) {
        throw new Error("An Artifact source task is no longer available. Remove or replace that reference before sending.");
      }
    }
  }
  return exact;
}

export function assertMobileCatalogMentionDraftCatalog(
  controls: MobileCatalogMentionControls | undefined,
  catalog: MobileCatalogMentionCatalog,
  draft: MobileComposerDraft
): MobileComposerDraft {
  const exact = assertMobileCatalogMentionDraft(controls, draft);
  if (!controls) return exact;
  for (const mention of exact.mentions) {
    if (mention.kind === "resource") assertResourceDraftMention(catalog, mention);
    if (mention.kind === "artifact") assertArtifactDraftMention(catalog, mention);
  }
  return exact;
}

function assertResourceDraftMention(
  catalog: MobileCatalogMentionCatalog,
  mention: MobileComposerResourceMention
): void {
  const matches = (catalog.resources?.items ?? []).filter((item) => item.resourceId === mention.resourceId);
  const current = matches.length === 1 ? matches[0] : undefined;
  if (!current || current.discoveredRevision !== mention.discoveredRevision
    || current.resourceVersion !== mention.resourceVersion || current.runtimeGeneration !== mention.runtimeGeneration) {
    throw new Error("A referenced Resource is no longer loaded with the same runtime identity. The draft was retained.");
  }
}

function assertArtifactDraftMention(
  catalog: MobileCatalogMentionCatalog,
  mention: MobileComposerArtifactMention
): void {
  const matches = (catalog.artifacts?.items ?? []).filter((item) => item.artifactId === mention.artifactId
    && item.sourceSessionId === mention.sourceSessionId);
  if (matches.length !== 1) {
    throw new Error("A referenced Artifact is no longer available in its original task. The draft was retained.");
  }
}

function searchableCandidateText(candidate: MobileCatalogMentionCandidate): string {
  return candidate.kind === "resource"
    ? [candidate.displayText, candidate.resourceId, resourceKindLabel(candidate.resourceKind), candidate.version ?? ""].join("\u0000")
    : [candidate.displayText, candidate.artifactId, candidate.sourceDisplayText, candidate.sourceSessionId,
        candidate.fileName, candidate.mediaType, artifactKindLabel(candidate.artifactKind)].join("\u0000");
}

function compareCandidates(left: MobileCatalogMentionCandidate, right: MobileCatalogMentionCandidate): number {
  return left.displayText.localeCompare(right.displayText, "en")
    || left.kind.localeCompare(right.kind, "en")
    || (left.kind === "resource" ? left.resourceId : `${left.sourceSessionId}\u0000${left.artifactId}`)
      .localeCompare(right.kind === "resource" ? right.resourceId : `${right.sourceSessionId}\u0000${right.artifactId}`, "en");
}

function resourceMentionKind(value: ResourceKind): boolean {
  return value === ResourceKind.EXTENSION || value === ResourceKind.SKILL
    || value === ResourceKind.PROMPT_TEMPLATE || value === ResourceKind.PACKAGE;
}

function artifactMentionKind(value: ArtifactKind): boolean {
  return value === ArtifactKind.FILE || value === ArtifactKind.IMAGE || value === ArtifactKind.EXPORT
    || value === ArtifactKind.TOOL_RESULT || value === ArtifactKind.DIAGNOSTICS || value === ArtifactKind.DIFF;
}

export function resourceKindLabel(value: ResourceKind): string {
  if (value === ResourceKind.EXTENSION) return "Extension";
  if (value === ResourceKind.SKILL) return "Skill";
  if (value === ResourceKind.PROMPT_TEMPLATE) return "Prompt";
  if (value === ResourceKind.PACKAGE) return "Package";
  return "Resource";
}

export function artifactKindLabel(value: ArtifactKind): string {
  if (value === ArtifactKind.IMAGE) return "Image";
  if (value === ArtifactKind.EXPORT) return "Export";
  if (value === ArtifactKind.TOOL_RESULT) return "Tool result";
  if (value === ArtifactKind.DIAGNOSTICS) return "Diagnostics";
  if (value === ArtifactKind.DIFF) return "Diff";
  return "File";
}

function safeDisplayText(session: Session): string {
  return safeCandidateLabel([session.displayName, session.sessionId], "Task");
}

function safeCandidateLabel(values: readonly string[], fallback: string): string {
  for (const value of values) {
    const exact = value.trim();
    if (exact && exact.length <= maximumDisplayCharacters && !/[\u0000-\u001f\u007f]/u.test(exact)) return exact;
  }
  return fallback;
}

function safeMetadataText(value: string, label: string): string {
  if (!validMetadataText(value)) throw new Error(`The Joko node returned an invalid ${label}.`);
  return value;
}

function validMetadataText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4_096
    && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function validIdentity(value: unknown, maximum = 4_096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim()
    && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function unique<T>(values: readonly T[], matches: (value: T) => boolean): T | undefined {
  const selected = values.filter(matches);
  return selected.length === 1 ? selected[0] : undefined;
}

function groupBy<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) groups.set(keyOf(value), [...(groups.get(keyOf(value)) ?? []), value]);
  return groups;
}

function entityKey(version: {
  readonly generation: bigint;
  readonly revision?: { readonly value: bigint; readonly etag: string };
} | undefined): string {
  return [
    version?.generation.toString(10) ?? "",
    version?.revision?.value.toString(10) ?? "",
    version?.revision?.etag ?? ""
  ].join("\u001e");
}

function samePolicy(left: MobileCatalogMentionPolicy, right: MobileCatalogMentionPolicy): boolean {
  return left.resources === right.resources && left.artifacts === right.artifacts;
}

export const mobileCatalogMentionTesting = { maximumVisibleResults };

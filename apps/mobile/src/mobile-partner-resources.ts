import {
  ArtifactKind,
  PartnerSessionRole,
  type ListPartnerSessionsResponse
} from "@joko/contracts";
import type { ArtifactCatalogSnapshot } from "./network";
import {
  assertMobileCanonicalPartnerSession,
  type MobilePartner
} from "./mobile-partner-private";

const SAFE_TEXT = /^[^\u0000-\u001f\u007f\u2028\u2029]{1,4096}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface MobilePartnerResourceArtifact {
  readonly artifactId: string;
  readonly title: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly createdAt: number;
}

export interface MobilePartnerResourceSession {
  readonly sessionId: string;
  readonly displayName: string;
  readonly profileVersion: number;
  readonly createdAt: number;
  readonly lastActivityAt?: number;
}

export interface MobilePartnerResourcePreview {
  readonly resourceKey: string;
  readonly partner: MobilePartner;
  readonly session: MobilePartnerResourceSession;
  readonly artifacts: readonly MobilePartnerResourceArtifact[];
  readonly artifactRevision: string;
}

export interface MobilePartnerResourceTransport {
  readonly ownerKey: string;
  list(signal: AbortSignal): Promise<readonly MobilePartner[]>;
  preview(partnerId: string, signal: AbortSignal): Promise<MobilePartnerResourcePreview>;
  open(preview: MobilePartnerResourcePreview, signal: AbortSignal): Promise<string>;
}

export function mobilePartnerResourceKey(partner: MobilePartner): string {
  return [
    partner.partnerId,
    String(partner.profileVersion),
    partner.canonicalSessionId ?? "",
    partner.lifecycle,
    partner.initializationState
  ].join("\u001f");
}

export function projectMobilePartnerResourcePreview(
  partner: MobilePartner,
  response: ListPartnerSessionsResponse,
  catalog: ArtifactCatalogSnapshot
): MobilePartnerResourcePreview {
  const sessionId = partner.canonicalSessionId;
  if (!sessionId) throw new Error("This Partner does not have a canonical task.");
  assertMobileCanonicalPartnerSession(partner, sessionId, response);
  const sessions = response.sessions.filter((candidate) => candidate.sessionId === sessionId);
  const session = sessions[0]!;
  if (session.role !== PartnerSessionRole.CANONICAL
    || session.profileVersion !== BigInt(partner.profileVersion)) {
    throw new Error("The Partner task no longer matches this Resource.");
  }
  const createdAt = timestamp(session.createdAt, "Partner task creation time");
  const lastActivityAt = session.lastActivityAt === undefined
    ? undefined : timestamp(session.lastActivityAt, "Partner task activity time");
  if (lastActivityAt !== undefined && lastActivityAt < createdAt) {
    throw new Error("The Joko node returned inconsistent Partner task activity.");
  }
  if (!safeText(session.displayName) || !safeIdentity(catalog.revision)) {
    throw new Error("The Joko node returned an invalid Partner Resource preview.");
  }
  const identities = new Set<string>();
  const artifacts = catalog.artifacts.map((artifact): MobilePartnerResourceArtifact => {
    const blob = artifact.blob;
    const artifactCreatedAt = timestamp(artifact.createdAt, "Partner Artifact creation time");
    if (artifact.sessionId !== sessionId || !safeIdentity(artifact.artifactId)
      || identities.has(artifact.artifactId) || !artifactKind(artifact.kind)
      || !blob || !safeIdentity(blob.blobId) || !safeText(blob.fileName)
      || !safeText(blob.mediaType) || !SHA256.test(blob.sha256Hex)
      || blob.byteSize < 0n || blob.byteSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("The Joko node returned an invalid Partner Artifact preview.");
    }
    identities.add(artifact.artifactId);
    const title = artifact.title.trim() || blob.fileName;
    if (!safeText(title)) throw new Error("The Joko node returned an invalid Partner Artifact title.");
    return {
      artifactId: artifact.artifactId,
      title,
      fileName: blob.fileName,
      mediaType: blob.mediaType,
      byteSize: Number(blob.byteSize),
      createdAt: artifactCreatedAt
    };
  }).sort((left, right) => right.createdAt - left.createdAt
    || left.title.localeCompare(right.title, "en")
    || left.artifactId.localeCompare(right.artifactId, "en"));
  return {
    resourceKey: mobilePartnerResourceKey(partner),
    partner,
    session: {
      sessionId,
      displayName: session.displayName,
      profileVersion: partner.profileVersion,
      createdAt,
      ...(lastActivityAt === undefined ? {} : { lastActivityAt })
    },
    artifacts,
    artifactRevision: catalog.revision
  };
}

export function filterMobilePartnerResources(
  partners: readonly MobilePartner[],
  query: string
): readonly MobilePartner[] {
  const needle = query.trim().normalize("NFKC").toLocaleLowerCase();
  if (!needle) return partners;
  return partners.filter((partner) => partner.displayName.normalize("NFKC").toLocaleLowerCase().includes(needle));
}

function safeIdentity(value: string): boolean {
  return value === value.trim() && value.length > 0 && value.length <= 4_096 && SAFE_TEXT.test(value);
}

function safeText(value: string): boolean {
  return value === value.trim() && SAFE_TEXT.test(value);
}

function timestamp(
  value: { readonly seconds: bigint; readonly nanos: number } | undefined,
  label: string
): number {
  if (!value || value.seconds < 0n
    || value.seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000))
    || !Number.isSafeInteger(value.nanos) || value.nanos < 0 || value.nanos > 999_999_999) {
    throw new Error(`The Joko node returned an invalid ${label}.`);
  }
  const milliseconds = Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`The Joko node returned an invalid ${label}.`);
  return milliseconds;
}

function artifactKind(value: ArtifactKind): boolean {
  return value === ArtifactKind.FILE || value === ArtifactKind.IMAGE || value === ArtifactKind.EXPORT
    || value === ArtifactKind.TOOL_RESULT || value === ArtifactKind.DIAGNOSTICS || value === ArtifactKind.DIFF;
}

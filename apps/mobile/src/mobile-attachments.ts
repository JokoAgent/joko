import {
  CapabilitySupport,
  capabilityNames,
  type BackendDescriptor
} from "@joko/contracts";
import { normalizeMediaType } from "./workspace-files";

export type MobileComposerAttachmentKind = "image" | "file";

interface MobileComposerAttachmentBase {
  readonly attachmentId: string;
  readonly kind: MobileComposerAttachmentKind;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
  readonly capturedAtUnixMs: number;
}

export interface MobileLocalComposerAttachment extends MobileComposerAttachmentBase {
  readonly state: "local";
}

export interface MobileUploadedComposerAttachment extends MobileComposerAttachmentBase {
  readonly state: "uploaded";
  readonly blobId: string;
}

export type MobileComposerAttachment = MobileLocalComposerAttachment | MobileUploadedComposerAttachment;

export interface MobileAttachmentPolicy {
  readonly images: boolean;
  readonly files: boolean;
  readonly maximumItems: number;
  readonly maximumBytes: number;
  readonly imageMediaTypes: readonly string[];
  readonly fileMediaTypes: readonly string[];
}

export interface MobileAttachmentControls {
  readonly profileId: string;
  readonly surfaceOwnerKey: string;
  readonly policy: MobileAttachmentPolicy;
}

export interface MobilePickedAttachmentCandidate {
  readonly uri: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
}

export const MOBILE_MAXIMUM_ATTACHMENTS = 20;
export const MOBILE_MAXIMUM_ATTACHMENT_BYTES = 30 * 1024 * 1024;

export function resolveMobileAttachmentPolicy(
  backend: BackendDescriptor | undefined,
  modelSupportsImages = false
): MobileAttachmentPolicy | undefined {
  const image = supportedInputCapability(backend, capabilityNames.inputImage);
  const file = supportedInputCapability(backend, capabilityNames.inputFile);
  const images = image !== undefined && modelSupportsImages;
  const files = file !== undefined;
  if (!images && !files) return undefined;
  const active = [images ? image : undefined, files ? file : undefined].filter(
    (candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined
  );
  const itemLimits = active.flatMap((capability) => {
    const value = capability.options?.kind.case === "input" ? capability.options.kind.value.maximumItems : 0;
    return value > 0 ? [value] : [];
  });
  const byteLimits = active.flatMap((capability) => {
    const value = capability.options?.kind.case === "input" ? capability.options.kind.value.maximumBytes : 0n;
    return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? [Number(value)] : [];
  });
  return {
    images,
    files,
    maximumItems: Math.min(MOBILE_MAXIMUM_ATTACHMENTS, ...itemLimits),
    maximumBytes: Math.min(MOBILE_MAXIMUM_ATTACHMENT_BYTES, ...byteLimits),
    imageMediaTypes: images ? inputMediaTypes(image) : [],
    fileMediaTypes: files ? inputMediaTypes(file) : []
  };
}

export function mobileAttachmentPickerMediaTypes(policy: MobileAttachmentPolicy): readonly string[] {
  const exact = normalizeMobileAttachmentPolicy(policy);
  if (exact.files && exact.fileMediaTypes.length === 0) return ["*/*"];
  const mediaTypes = new Set<string>();
  if (exact.images) {
    for (const value of exact.imageMediaTypes.length === 0 ? ["image/*"] : exact.imageMediaTypes) mediaTypes.add(value);
  }
  if (exact.files) {
    for (const value of exact.fileMediaTypes) mediaTypes.add(value);
  }
  return [...mediaTypes];
}

export function classifyMobileAttachment(
  mediaType: string,
  policy: MobileAttachmentPolicy
): MobileComposerAttachmentKind {
  const exact = normalizeMobileAttachmentPolicy(policy);
  const normalized = normalizeAttachmentMediaType(mediaType);
  if (normalized.startsWith("image/")) {
    if (exact.images && mediaTypeAllowed(normalized, exact.imageMediaTypes, true)) return "image";
    throw new Error("The selected image type is not supported by this Backend and model.");
  }
  if (exact.files && mediaTypeAllowed(normalized, exact.fileMediaTypes, false)) return "file";
  throw new Error("The selected file type is not supported by this Backend.");
}

export function assertMobileAttachmentCandidate(
  candidate: Omit<MobilePickedAttachmentCandidate, "uri">,
  policy: MobileAttachmentPolicy
): { readonly kind: MobileComposerAttachmentKind; readonly fileName: string; readonly mediaType: string } {
  const exact = normalizeMobileAttachmentPolicy(policy);
  const fileName = normalizeMobileAttachmentFileName(candidate.fileName);
  const mediaType = normalizeAttachmentMediaType(candidate.mediaType);
  if (!Number.isSafeInteger(candidate.byteSize) || candidate.byteSize <= 0) {
    throw new Error(`${fileName} is empty or has an invalid size.`);
  }
  if (candidate.byteSize > exact.maximumBytes) {
    throw new Error(`${fileName} exceeds the ${formatMobileAttachmentBytes(exact.maximumBytes)} attachment limit.`);
  }
  return { kind: classifyMobileAttachment(mediaType, exact), fileName, mediaType };
}

export function normalizeMobileComposerAttachment(value: MobileComposerAttachment): MobileComposerAttachment {
  if (!value || typeof value !== "object" || (value.state !== "local" && value.state !== "uploaded")
    || (value.kind !== "image" && value.kind !== "file")) {
    throw new Error("The local Joko attachment is invalid.");
  }
  assertAttachmentId(value.attachmentId);
  const fileName = normalizeMobileAttachmentFileName(value.fileName);
  const mediaType = normalizeAttachmentMediaType(value.mediaType);
  if (value.kind === "image" && !mediaType.startsWith("image/")) {
    throw new Error("The local Joko image attachment has an invalid media type.");
  }
  if (!Number.isSafeInteger(value.byteSize) || value.byteSize <= 0
    || value.byteSize > MOBILE_MAXIMUM_ATTACHMENT_BYTES) {
    throw new Error("The local Joko attachment has an invalid byte size.");
  }
  if (!/^[0-9a-f]{64}$/u.test(value.sha256Hex)) {
    throw new Error("The local Joko attachment has an invalid SHA-256 identity.");
  }
  if (!Number.isSafeInteger(value.capturedAtUnixMs) || value.capturedAtUnixMs < 0) {
    throw new Error("The local Joko attachment has an invalid capture time.");
  }
  const base = {
    attachmentId: value.attachmentId,
    kind: value.kind,
    fileName,
    mediaType,
    byteSize: value.byteSize,
    sha256Hex: value.sha256Hex,
    capturedAtUnixMs: value.capturedAtUnixMs
  };
  if (value.state === "local") return { state: "local", ...base };
  assertBlobId(value.blobId);
  return { state: "uploaded", ...base, blobId: value.blobId };
}

export function cloneMobileComposerAttachment(value: MobileComposerAttachment): MobileComposerAttachment {
  return { ...normalizeMobileComposerAttachment(value) };
}

export function mobileComposerAttachmentsEqual(
  left: MobileComposerAttachment,
  right: MobileComposerAttachment
): boolean {
  const first = normalizeMobileComposerAttachment(left);
  const second = normalizeMobileComposerAttachment(right);
  return first.state === second.state && first.attachmentId === second.attachmentId
    && first.kind === second.kind && first.fileName === second.fileName
    && first.mediaType === second.mediaType && first.byteSize === second.byteSize
    && first.sha256Hex === second.sha256Hex && first.capturedAtUnixMs === second.capturedAtUnixMs
    && (first.state === "local" || second.state === "local" || first.blobId === second.blobId);
}

export function assertMobileAttachmentPolicy(
  attachments: readonly MobileComposerAttachment[],
  policy: MobileAttachmentPolicy
): readonly MobileComposerAttachment[] {
  const exact = normalizeMobileAttachmentPolicy(policy);
  if (attachments.length > exact.maximumItems) {
    throw new Error(`A task message can include at most ${exact.maximumItems} attachments.`);
  }
  return attachments.map((attachment) => {
    const normalized = normalizeMobileComposerAttachment(attachment);
    if (normalized.byteSize > exact.maximumBytes) {
      throw new Error(`${normalized.fileName} exceeds the ${formatMobileAttachmentBytes(exact.maximumBytes)} attachment limit.`);
    }
    const expected = classifyMobileAttachment(normalized.mediaType, exact);
    if (normalized.kind !== expected) {
      throw new Error(`${normalized.fileName} no longer matches the current attachment capability.`);
    }
    return normalized;
  });
}

export function appendMobileComposerAttachments(
  current: readonly MobileComposerAttachment[],
  additions: readonly MobileComposerAttachment[],
  policy: MobileAttachmentPolicy
): readonly MobileComposerAttachment[] {
  const exact = [...current, ...additions].map(normalizeMobileComposerAttachment);
  const ids = new Set<string>();
  for (const attachment of exact) {
    if (ids.has(attachment.attachmentId)) throw new Error("The selected attachment is already in this draft.");
    ids.add(attachment.attachmentId);
  }
  return assertMobileAttachmentPolicy(exact, policy).map(cloneMobileComposerAttachment);
}

export function replaceMobileComposerAttachment(
  attachments: readonly MobileComposerAttachment[],
  attachmentId: string,
  replacement: MobileComposerAttachment
): readonly MobileComposerAttachment[] {
  assertAttachmentId(attachmentId);
  const exact = normalizeMobileComposerAttachment(replacement);
  if (exact.attachmentId !== attachmentId) throw new Error("The committed attachment identity changed.");
  let replaced = false;
  const next = attachments.map((candidate) => {
    const current = normalizeMobileComposerAttachment(candidate);
    if (current.attachmentId !== attachmentId) return current;
    if (replaced) throw new Error("The local Joko attachment identity is duplicated.");
    replaced = true;
    return exact;
  });
  if (!replaced) throw new Error("The selected attachment is no longer in this draft.");
  return next;
}

export function removeMobileComposerAttachment(
  attachments: readonly MobileComposerAttachment[],
  attachmentId: string
): { readonly attachments: readonly MobileComposerAttachment[]; readonly removed: MobileComposerAttachment } {
  assertAttachmentId(attachmentId);
  const exact = attachments.map(normalizeMobileComposerAttachment);
  const matches = exact.filter((candidate) => candidate.attachmentId === attachmentId);
  if (matches.length !== 1) throw new Error("The selected attachment is no longer in this draft.");
  return {
    attachments: exact.filter((candidate) => candidate.attachmentId !== attachmentId),
    removed: cloneMobileComposerAttachment(matches[0]!)
  };
}

export function normalizeMobileAttachmentFileName(value: string): string {
  if (typeof value !== "string") throw new Error("The selected attachment has no valid file name.");
  const leaf = value.split(/[\\/]/u).at(-1)?.trim() ?? "";
  if (!leaf || leaf === "." || leaf === ".." || leaf.length > 512 || /[\u0000-\u001f\u007f]/u.test(leaf)) {
    throw new Error("The selected attachment has no valid file name.");
  }
  return leaf;
}

export function normalizeAttachmentMediaType(value: string): string {
  const normalized = normalizeMediaType(typeof value === "string" ? value : "");
  if (!normalized) return "application/octet-stream";
  if (!/^(?:\*|[a-z0-9!#$&^_.+-]+)\/(?:\*|[a-z0-9!#$&^_.+-]+)$/u.test(normalized)) {
    throw new Error("The selected attachment has an invalid media type.");
  }
  return normalized;
}

export function formatMobileAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeMobileAttachmentPolicy(value: MobileAttachmentPolicy): MobileAttachmentPolicy {
  if (!value || typeof value !== "object" || (!value.images && !value.files)
    || !Number.isSafeInteger(value.maximumItems) || value.maximumItems < 1
    || value.maximumItems > MOBILE_MAXIMUM_ATTACHMENTS
    || !Number.isSafeInteger(value.maximumBytes) || value.maximumBytes < 1
    || value.maximumBytes > MOBILE_MAXIMUM_ATTACHMENT_BYTES
    || !Array.isArray(value.imageMediaTypes) || !Array.isArray(value.fileMediaTypes)) {
    throw new Error("The current Joko attachment capability is invalid.");
  }
  return {
    images: value.images,
    files: value.files,
    maximumItems: value.maximumItems,
    maximumBytes: value.maximumBytes,
    imageMediaTypes: normalizeMediaTypeList(value.imageMediaTypes),
    fileMediaTypes: normalizeMediaTypeList(value.fileMediaTypes)
  };
}

function supportedInputCapability(backend: BackendDescriptor | undefined, name: string) {
  const matches = backend?.capabilities?.capabilities.filter((candidate) => candidate.name === name) ?? [];
  if (matches.length !== 1 || matches[0]!.support !== CapabilitySupport.SUPPORTED
    || matches[0]!.options?.kind.case !== "input") return undefined;
  const options = matches[0]!.options.kind.value;
  if (!Number.isSafeInteger(options.maximumItems) || options.maximumItems < 0
    || options.maximumBytes < 0n) return undefined;
  try { normalizeMediaTypeList(options.mediaTypes); }
  catch { return undefined; }
  return matches[0];
}

function inputMediaTypes(capability: NonNullable<ReturnType<typeof supportedInputCapability>>): readonly string[] {
  return capability.options?.kind.case === "input"
    ? normalizeMediaTypeList(capability.options.kind.value.mediaTypes)
    : [];
}

function normalizeMediaTypeList(values: readonly string[]): readonly string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const candidate = normalizeAttachmentMediaType(value);
    if (candidate !== "application/octet-stream" || value.trim() !== "") normalized.add(candidate);
  }
  return [...normalized].sort();
}

function mediaTypeAllowed(mediaType: string, configured: readonly string[], imageOnly: boolean): boolean {
  if (imageOnly && !mediaType.startsWith("image/")) return false;
  if (configured.length === 0) return true;
  return configured.some((candidate) => candidate === "*/*" || candidate === mediaType
    || candidate.endsWith("/*") && mediaType.startsWith(candidate.slice(0, -1)));
}

function assertAttachmentId(value: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) {
    throw new Error("The local Joko attachment identity is invalid.");
  }
}

function assertBlobId(value: string): void {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("The committed Joko Blob identity is invalid.");
  }
}

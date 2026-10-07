import { MobileAttachmentFiles } from "./mobile-attachment-files";
import {
  appendMobileComposerAttachments,
  MOBILE_MAXIMUM_ATTACHMENT_BYTES,
  type MobileAttachmentPolicy,
  type MobileComposerAttachment,
  type MobileLocalComposerAttachment
} from "./mobile-attachments";
import type { MobileComposerDraft } from "./mobile-composer-document";
import {
  mobileImageExtensionForMediaType,
  mobileImageMediaTypeAccepted,
  selectMobileImageImportMediaType
} from "./mobile-image-attachment";
import {
  assertMobileImageGalleryDimensions
} from "./mobile-image-gallery";
import { inspectMobileImageOutputBytes } from "./mobile-image-output-format";
import { inspectMobileGifBytes } from "./mobile-image-gif";
import {
  mobileComposerPastedImageMediaTypes,
  mobileComposerRichProtocolLimits,
  type MobileComposerPastedImageMediaType
} from "./mobile-composer-rich-input-protocol";

export interface MobileComposerPastedImagePayload {
  readonly base64: string;
  readonly mediaType: MobileComposerPastedImageMediaType;
  readonly name: string;
}

export interface MobileComposerImagePasteConverter {
  convert(
    bytes: Uint8Array,
    mediaType: MobileComposerPastedImageMediaType,
    targetMediaType: "image/jpeg" | "image/png",
    signal?: AbortSignal
  ): Promise<Uint8Array>;
}

export interface MobileComposerImagePasteSnapshot<TDraft> {
  readonly revision: number;
  readonly draft?: TDraft;
}

export interface MobileComposerImagePasteCommitOptions<TSnapshotDraft, TDraft> {
  readonly buildDraft: (input: MobileComposerDraft) => TDraft;
  readonly files: MobileAttachmentFiles;
  readonly flush: () => Promise<void>;
  readonly imagePaste: MobileComposerImagePaste;
  readonly input: MobileComposerDraft;
  readonly newId: () => string;
  readonly payloads: readonly MobileComposerPastedImagePayload[];
  readonly policy: MobileAttachmentPolicy;
  readonly profileId: string;
  readonly readBackMatches: (draft: TDraft) => boolean;
  readonly saveIfRevision: (draft: TDraft, expectedRevision: number) => boolean;
  readonly signal?: AbortSignal;
  readonly snapshot: Promise<MobileComposerImagePasteSnapshot<TSnapshotDraft>>;
  readonly snapshotMatches: (draft: TSnapshotDraft | undefined) => boolean;
  readonly validateAuthority: () => Promise<void> | void;
}

export interface MobileComposerImagePasteCommitResult<TDraft> {
  readonly draft: TDraft;
  readonly input: MobileComposerDraft;
}

interface VerifiedPastedImage {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mediaType: MobileComposerPastedImageMediaType | "image/jpeg";
}

const supportedMediaTypes = new Set<string>(mobileComposerPastedImageMediaTypes);
const composerPasteCacheDirectory = "joko-composer-paste";
let temporaryFileSequence = 0;

export class MobileComposerImagePaste {
  constructor(
    private readonly files: MobileAttachmentFiles,
    private readonly converter: MobileComposerImagePasteConverter = expoMobileComposerImagePasteConverter
  ) {}

  async stage(
    profileId: string,
    current: readonly MobileComposerAttachment[],
    policy: MobileAttachmentPolicy,
    payloads: readonly MobileComposerPastedImagePayload[],
    newId: () => string,
    signal?: AbortSignal
  ): Promise<readonly MobileLocalComposerAttachment[]> {
    signal?.throwIfAborted();
    if (!Array.isArray(payloads) || payloads.length < 1
      || payloads.length > mobileComposerRichProtocolLimits.maximumPastedImageCount) {
      throw new Error("The clipboard image batch has an invalid item count.");
    }
    if (current.length + payloads.length > policy.maximumItems) {
      throw new Error(`A task message can include at most ${policy.maximumItems} attachments.`);
    }
    const verified: VerifiedPastedImage[] = [];
    for (let index = 0; index < payloads.length; index += 1) {
      signal?.throwIfAborted();
      const payload = payloads[index];
      if (!payload || typeof payload !== "object" || !supportedMediaTypes.has(payload.mediaType)
        || typeof payload.name !== "string" || payload.name.length < 1
        || payload.name.length > mobileComposerRichProtocolLimits.maximumPastedImageNameCharacters
        || /[\u0000-\u001f\u007f]/u.test(payload.name)) {
        throw new Error("The clipboard image declaration is invalid.");
      }
      const sourceBytes = decodeMobileComposerPastedImageBase64(payload.base64);
      inspectMobileComposerPastedImageBytes(sourceBytes, payload.mediaType);
      if (mobileImageMediaTypeAccepted(payload.mediaType, policy)) {
        if (sourceBytes.byteLength > policy.maximumBytes) {
          throw new Error(`Pasted image ${index + 1} exceeds this task's attachment byte limit.`);
        }
        verified.push({
          bytes: sourceBytes,
          fileName: pastedImageFileName(index, payload.mediaType),
          mediaType: payload.mediaType
        });
        continue;
      }
      const targetMediaType = selectMobileImageImportMediaType(policy);
      if (targetMediaType === undefined) {
        throw new Error(`Pasted image ${index + 1} is not accepted by the current Backend and model.`);
      }
      let converted: Uint8Array;
      try { converted = await this.converter.convert(sourceBytes, payload.mediaType, targetMediaType, signal); }
      catch {
        signal?.throwIfAborted();
        throw new Error(`Pasted image ${index + 1} could not be converted to an accepted ${targetMediaType === "image/png" ? "PNG" : "JPEG"}.`);
      }
      signal?.throwIfAborted();
      if (!(converted instanceof Uint8Array) || converted.byteLength < 1
        || converted.byteLength > policy.maximumBytes) {
        throw new Error(`Converted pasted image ${index + 1} exceeds this task's attachment byte limit.`);
      }
      inspectMobileComposerPastedImageBytes(converted, targetMediaType);
      verified.push({ bytes: converted, fileName: pastedImageFileName(index, targetMediaType), mediaType: targetMediaType });
    }

    const staged: MobileLocalComposerAttachment[] = [];
    try {
      for (const image of verified) {
        signal?.throwIfAborted();
        const sha256Hex = await this.files.digestOwnedBytes(image.bytes, signal);
        const attachment = await this.files.stageVerifiedBytes(
          profileId,
          [...current, ...staged],
          policy,
          {
            bytes: image.bytes,
            fileName: image.fileName,
            mediaType: image.mediaType,
            byteSize: image.bytes.byteLength,
            sha256Hex
          },
          newId,
          signal
        );
        staged.push(attachment);
      }
      return staged.map((attachment) => ({ ...attachment }));
    } catch (failure) {
      await Promise.all(staged.map((attachment) => this.files.remove(profileId, attachment).catch(() => undefined)));
      throw failure;
    }
  }
}

export async function commitMobileComposerImagePaste<TSnapshotDraft, TDraft>(
  options: MobileComposerImagePasteCommitOptions<TSnapshotDraft, TDraft>
): Promise<MobileComposerImagePasteCommitResult<TDraft>> {
  options.signal?.throwIfAborted();
  const snapshot = await options.snapshot;
  options.signal?.throwIfAborted();
  if (!options.snapshotMatches(snapshot.draft)) {
    throw new Error("The composer draft changed before the clipboard images were staged. Paste them again.");
  }

  let staged: readonly MobileLocalComposerAttachment[] = [];
  let committed = false;
  try {
    staged = await options.imagePaste.stage(
      options.profileId,
      options.input.attachments,
      options.policy,
      options.payloads,
      options.newId,
      options.signal
    );
    options.signal?.throwIfAborted();
    await options.validateAuthority();
    options.signal?.throwIfAborted();
    const input = {
      ...options.input,
      attachments: appendMobileComposerAttachments(options.input.attachments, staged, options.policy)
    };
    const draft = options.buildDraft(input);
    if (!options.saveIfRevision(draft, snapshot.revision)) {
      throw new Error("The composer draft changed while the clipboard images were being prepared. Paste them again.");
    }
    committed = true;
    await options.flush();
    if (!options.readBackMatches(draft)) {
      throw new Error("The pasted images could not be confirmed in the retained composer draft.");
    }
    return { draft, input };
  } catch (failure) {
    if (!committed) {
      await Promise.all(staged.map((attachment) => options.files.remove(options.profileId, attachment)
        .catch(() => undefined)));
    }
    throw failure;
  }
}

export function decodeMobileComposerPastedImageBase64(value: string): Uint8Array {
  if (typeof value !== "string" || value.length < 4
    || value.length > mobileComposerRichProtocolLimits.maximumPastedImageBase64Characters
    || value.length % 4 !== 0) {
    throw new Error("The clipboard image base64 payload is invalid.");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const byteLength = value.length / 4 * 3 - padding;
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MOBILE_MAXIMUM_ATTACHMENT_BYTES) {
    throw new Error("The clipboard image exceeds the local attachment byte limit.");
  }
  const output = new Uint8Array(byteLength);
  let write = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const last = offset + 4 === value.length;
    const first = base64Value(value.charCodeAt(offset));
    const second = base64Value(value.charCodeAt(offset + 1));
    const thirdCharacter = value[offset + 2];
    const fourthCharacter = value[offset + 3];
    const thirdPadding = thirdCharacter === "=";
    const fourthPadding = fourthCharacter === "=";
    const third = thirdPadding ? 0 : base64Value(value.charCodeAt(offset + 2));
    const fourth = fourthPadding ? 0 : base64Value(value.charCodeAt(offset + 3));
    if (first < 0 || second < 0 || third < 0 || fourth < 0
      || !last && (thirdPadding || fourthPadding)
      || thirdPadding && !fourthPadding
      || thirdPadding && (second & 0x0f) !== 0
      || fourthPadding && !thirdPadding && (third & 0x03) !== 0) {
      throw new Error("The clipboard image base64 payload is not canonical.");
    }
    if (write < byteLength) output[write++] = first << 2 | second >>> 4;
    if (!thirdPadding && write < byteLength) output[write++] = (second & 0x0f) << 4 | third >>> 2;
    if (!fourthPadding && write < byteLength) output[write++] = (third & 0x03) << 6 | fourth;
  }
  if (write !== byteLength) throw new Error("The clipboard image base64 payload length is invalid.");
  return output;
}

export function inspectMobileComposerPastedImageBytes(
  bytes: Uint8Array,
  expectedMediaType: MobileComposerPastedImageMediaType | "image/jpeg"
): { readonly width: number; readonly height: number } {
  if (expectedMediaType !== "image/gif") {
    const inspected = inspectMobileImageOutputBytes(bytes, expectedMediaType);
    return { width: inspected.width, height: inspected.height };
  }
  if (bytes.byteLength > MOBILE_MAXIMUM_ATTACHMENT_BYTES) throw new Error("The clipboard GIF exceeds the attachment limit.");
  const { width, height } = inspectMobileGifBytes(bytes);
  assertMobileImageGalleryDimensions(width, height);
  return { width, height };
}

function pastedImageFileName(index: number, mediaType: MobileComposerPastedImageMediaType | "image/jpeg"): string {
  return `pasted-image-${index + 1}.${mobileImageExtensionForMediaType(mediaType)}`;
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

const expoMobileComposerImagePasteConverter: MobileComposerImagePasteConverter = {
  async convert(bytes, mediaType, targetMediaType, signal) {
    signal?.throwIfAborted();
    const { Directory, File, Paths } = await import("expo-file-system");
    const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
    signal?.throwIfAborted();
    const directory = new Directory(Paths.cache, composerPasteCacheDirectory);
    directory.create({ idempotent: true, intermediates: true });
    const sequence = ++temporaryFileSequence;
    const source = new File(
      directory,
      `source-${Date.now()}-${sequence}.${mobileImageExtensionForMediaType(mediaType)}`
    );
    if (source.exists) throw new Error("The temporary pasted-image identity is already in use.");
    let context: ReturnType<typeof ImageManipulator.manipulate> | undefined;
    let image: Awaited<ReturnType<ReturnType<typeof ImageManipulator.manipulate>["renderAsync"]>> | undefined;
    let output: { readonly exists: boolean; bytes(): Promise<Uint8Array>; delete(): void } | undefined;
    try {
      source.create();
      source.write(bytes);
      context = ImageManipulator.manipulate(source.uri);
      image = await context.renderAsync();
      signal?.throwIfAborted();
      assertMobileImageGalleryDimensions(image.width, image.height);
      const saved = await image.saveAsync({
        compress: targetMediaType === "image/png" ? 1 : 0.9,
        format: targetMediaType === "image/png" ? SaveFormat.PNG : SaveFormat.JPEG
      });
      output = new File(saved.uri);
      signal?.throwIfAborted();
      if (!output.exists) throw new Error("The converted pasted image is missing.");
      const converted = Uint8Array.from(await output.bytes());
      signal?.throwIfAborted();
      inspectMobileImageOutputBytes(converted, targetMediaType, { width: image.width, height: image.height });
      return converted;
    } finally {
      try { image?.release(); }
      finally {
        try { context?.release(); }
        finally {
          try { if (output?.exists) output.delete(); }
          finally { if (source.exists) source.delete(); }
        }
      }
    }
  }
};

export const mobileComposerImagePasteTesting = { composerPasteCacheDirectory };

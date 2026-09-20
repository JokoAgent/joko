import {
  appendMobileComposerAttachments,
  assertMobileAttachmentCandidate,
  mobileAttachmentPickerMediaTypes,
  normalizeMobileComposerAttachment,
  type MobileAttachmentPolicy,
  type MobileComposerAttachment,
  type MobileLocalComposerAttachment,
  type MobilePickedAttachmentCandidate
} from "./mobile-attachments";

export interface MobileAttachmentFileDriver {
  pick(mediaTypes: readonly string[]): Promise<{
    readonly canceled: boolean;
    readonly files: readonly MobilePickedAttachmentCandidate[];
  }>;
  stage(profileId: string, attachmentId: string, sourceUri: string): Promise<MobileAttachmentFileSnapshot>;
  read(profileId: string, attachmentId: string): Promise<MobileAttachmentFileSnapshot>;
  remove(profileId: string, attachmentId: string): Promise<void>;
  clearProfile(profileId: string): Promise<void>;
}

export interface MobileAttachmentFileSnapshot {
  readonly uri: string;
  readonly byteSize: number;
  readonly bytes: Uint8Array;
}

export interface MobileVerifiedAttachmentUpload {
  readonly uri: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
}

type DigestBytes = (bytes: Uint8Array) => Promise<string>;

export class MobileAttachmentFiles {
  constructor(
    private readonly driver: MobileAttachmentFileDriver = expoMobileAttachmentFileDriver,
    private readonly digestBytes: DigestBytes = sha256Hex,
    private readonly now: () => number = Date.now
  ) {}

  async pickAndStage(
    profileId: string,
    current: readonly MobileComposerAttachment[],
    policy: MobileAttachmentPolicy,
    newId: () => string,
    signal?: AbortSignal
  ): Promise<readonly MobileLocalComposerAttachment[]> {
    assertProfileId(profileId);
    signal?.throwIfAborted();
    const picked = await this.driver.pick(mobileAttachmentPickerMediaTypes(policy));
    signal?.throwIfAborted();
    if (picked.canceled) return [];
    if (picked.files.length === 0) throw new Error("The system picker returned no attachment.");
    if (current.length + picked.files.length > policy.maximumItems) {
      throw new Error(`A task message can include at most ${policy.maximumItems} attachments.`);
    }
    const existingIds = new Set(current.map((attachment) => normalizeMobileComposerAttachment(attachment).attachmentId));
    const staged: MobileLocalComposerAttachment[] = [];
    const stagedIds: string[] = [];
    try {
      for (const candidate of picked.files) {
        signal?.throwIfAborted();
        if (!candidate.uri || typeof candidate.uri !== "string") {
          throw new Error("The system picker returned an unreadable attachment.");
        }
        const metadata = assertMobileAttachmentCandidate(candidate, policy);
        const attachmentId = newId();
        assertAttachmentId(attachmentId);
        if (existingIds.has(attachmentId)) throw new Error("The new attachment identity is already in use.");
        existingIds.add(attachmentId);
        const snapshot = await this.driver.stage(profileId, attachmentId, candidate.uri);
        stagedIds.push(attachmentId);
        signal?.throwIfAborted();
        assertSnapshot(snapshot);
        if (snapshot.byteSize !== candidate.byteSize || snapshot.bytes.byteLength !== candidate.byteSize) {
          throw new Error(`${metadata.fileName} changed while it was being copied into Joko.`);
        }
        const sha256Hex = await this.digestBytes(snapshot.bytes);
        signal?.throwIfAborted();
        if (!/^[0-9a-f]{64}$/u.test(sha256Hex)) throw new Error("The attachment SHA-256 result is invalid.");
        staged.push(normalizeMobileComposerAttachment({
          state: "local",
          attachmentId,
          kind: metadata.kind,
          fileName: metadata.fileName,
          mediaType: metadata.mediaType,
          byteSize: snapshot.byteSize,
          sha256Hex,
          capturedAtUnixMs: this.now()
        }) as MobileLocalComposerAttachment);
      }
      appendMobileComposerAttachments(current, staged, policy);
      return staged.map((attachment) => ({ ...attachment }));
    } catch (error) {
      await Promise.all(stagedIds.map((attachmentId) => this.driver.remove(profileId, attachmentId)
        .catch(() => undefined)));
      throw error;
    }
  }

  async verifyForUpload(
    profileId: string,
    attachment: MobileLocalComposerAttachment,
    signal?: AbortSignal
  ): Promise<MobileVerifiedAttachmentUpload> {
    assertProfileId(profileId);
    const exact = normalizeMobileComposerAttachment(attachment);
    if (exact.state !== "local") throw new Error("Only a staged local attachment can be uploaded.");
    signal?.throwIfAborted();
    const snapshot = await this.driver.read(profileId, exact.attachmentId);
    signal?.throwIfAborted();
    assertSnapshot(snapshot);
    if (snapshot.byteSize !== exact.byteSize || snapshot.bytes.byteLength !== exact.byteSize) {
      throw new Error(`${exact.fileName} changed after it was staged.`);
    }
    const sha256Hex = await this.digestBytes(snapshot.bytes);
    signal?.throwIfAborted();
    if (sha256Hex !== exact.sha256Hex) throw new Error(`${exact.fileName} failed its staged SHA-256 check.`);
    return {
      uri: snapshot.uri,
      fileName: exact.fileName,
      mediaType: exact.mediaType,
      byteSize: exact.byteSize,
      sha256Hex: exact.sha256Hex
    };
  }

  async remove(profileId: string, attachment: MobileComposerAttachment): Promise<void> {
    assertProfileId(profileId);
    const exact = normalizeMobileComposerAttachment(attachment);
    if (exact.state === "local") await this.driver.remove(profileId, exact.attachmentId);
  }

  async clearProfile(profileId: string): Promise<void> {
    assertProfileId(profileId);
    await this.driver.clearProfile(profileId);
  }
}

const expoMobileAttachmentFileDriver: MobileAttachmentFileDriver = {
  async pick(mediaTypes) {
    const { File } = await import("expo-file-system");
    const result = await File.pickFileAsync({
      multipleFiles: true,
      mimeTypes: [...mediaTypes]
    });
    if (result.canceled) return { canceled: true, files: [] };
    return {
      canceled: false,
      files: result.result.map((file) => ({
        uri: file.uri,
        fileName: file.name,
        mediaType: file.type || "application/octet-stream",
        byteSize: file.size
      }))
    };
  },
  async stage(profileId, attachmentId, sourceUri) {
    const { Directory, File, Paths } = await import("expo-file-system");
    const directory = new Directory(Paths.document, attachmentRootDirectory, profileId);
    directory.create({ idempotent: true, intermediates: true });
    const destination = new File(directory, attachmentId);
    if (destination.exists) throw new Error("The new attachment file identity is already in use.");
    try {
      await new File(sourceUri).copy(destination);
      return await expoFileSnapshot(destination);
    } catch (error) {
      if (destination.exists) destination.delete();
      throw error;
    }
  },
  async read(profileId, attachmentId) {
    const { Directory, File, Paths } = await import("expo-file-system");
    const file = new File(new Directory(Paths.document, attachmentRootDirectory, profileId), attachmentId);
    if (!file.exists) throw new Error("The staged attachment bytes are no longer available on this device.");
    return expoFileSnapshot(file);
  },
  async remove(profileId, attachmentId) {
    const { Directory, File, Paths } = await import("expo-file-system");
    const file = new File(new Directory(Paths.document, attachmentRootDirectory, profileId), attachmentId);
    if (file.exists) file.delete();
  },
  async clearProfile(profileId) {
    const { Directory, Paths } = await import("expo-file-system");
    const directory = new Directory(Paths.document, attachmentRootDirectory, profileId);
    if (directory.exists) directory.delete();
  }
};

const attachmentRootDirectory = "joko-mobile-attachments";

async function expoFileSnapshot(file: {
  readonly uri: string;
  readonly size: number;
  bytes(): Promise<Uint8Array>;
}): Promise<MobileAttachmentFileSnapshot> {
  const byteSize = file.size;
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) throw new Error("The staged attachment has an invalid size.");
  const bytes = await file.bytes();
  return { uri: file.uri, byteSize, bytes };
}

function assertSnapshot(value: MobileAttachmentFileSnapshot): void {
  if (!value || typeof value !== "object" || typeof value.uri !== "string" || !value.uri
    || !Number.isSafeInteger(value.byteSize) || value.byteSize <= 0
    || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength !== value.byteSize) {
    throw new Error("The staged attachment bytes are invalid.");
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { CryptoDigestAlgorithm, digest } = await import("expo-crypto");
  const value = new Uint8Array(await digest(
    CryptoDigestAlgorithm.SHA256,
    Uint8Array.from(bytes).buffer
  ));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertProfileId(value: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) {
    throw new Error("The local Joko connection profile identity is invalid.");
  }
}

function assertAttachmentId(value: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) {
    throw new Error("The local Joko attachment identity is invalid.");
  }
}

export const mobileAttachmentFileTesting = {
  attachmentRootDirectory
};

import { create } from "@bufbuild/protobuf";
import {
  BackendDescriptorSchema,
  CapabilityManifestSchema,
  CapabilityOptionsSchema,
  CapabilitySchema,
  CapabilitySupport,
  InputCapabilityOptionsSchema,
  capabilityNames
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  appendMobileComposerAttachments,
  assertMobileAttachmentCandidate,
  assertMobileAttachmentPolicy,
  classifyMobileAttachment,
  mobileAttachmentPickerMediaTypes,
  mobileComposerAttachmentStorageIds,
  mobileComposerAttachmentsEqual,
  removeMobileComposerAttachment,
  replaceMobileComposerAttachment,
  replaceMobileComposerAttachmentSlot,
  resolveMobileAttachmentPolicy,
  type MobileAttachmentPolicy,
  type MobileLocalComposerAttachment,
  type MobileUploadedComposerAttachment
} from "./mobile-attachments";

const backend = create(BackendDescriptorSchema, {
  backendId: "backend",
  capabilities: create(CapabilityManifestSchema, {
    capabilities: [
      create(CapabilitySchema, {
        name: capabilityNames.inputImage,
        support: CapabilitySupport.SUPPORTED,
        options: create(CapabilityOptionsSchema, {
          kind: { case: "input", value: create(InputCapabilityOptionsSchema, {
            mediaTypes: ["image/jpeg", "image/png"],
            maximumBytes: 10_000n,
            maximumItems: 5
          }) }
        })
      }),
      create(CapabilitySchema, {
        name: capabilityNames.inputFile,
        support: CapabilitySupport.SUPPORTED,
        options: create(CapabilityOptionsSchema, {
          kind: { case: "input", value: create(InputCapabilityOptionsSchema, {
            mediaTypes: ["application/pdf", "text/plain"],
            maximumBytes: 8_000n,
            maximumItems: 3
          }) }
        })
      })
    ]
  })
});

const policy: MobileAttachmentPolicy = {
  images: true,
  files: true,
  maximumItems: 2,
  maximumBytes: 1_024,
  imageMediaTypes: ["image/png"],
  fileMediaTypes: ["application/pdf"]
};

const localImage = {
  state: "local",
  attachmentId: "image-one",
  kind: "image",
  fileName: "pixel.png",
  mediaType: "image/png",
  byteSize: 4,
  sha256Hex: "a".repeat(64),
  capturedAtUnixMs: 100
} satisfies MobileLocalComposerAttachment;

const localFile = {
  state: "local",
  attachmentId: "file-one",
  kind: "file",
  fileName: "proof.pdf",
  mediaType: "application/pdf",
  byteSize: 7,
  sha256Hex: "b".repeat(64),
  capturedAtUnixMs: 101
} satisfies MobileLocalComposerAttachment;

describe("mobile attachment capability and draft identity", () => {
  it("derives the strict shared item/byte bounds and exact picker media types from supported capabilities", () => {
    expect(resolveMobileAttachmentPolicy(backend, true)).toEqual({
      images: true,
      files: true,
      maximumItems: 3,
      maximumBytes: 8_000,
      imageMediaTypes: ["image/jpeg", "image/png"],
      fileMediaTypes: ["application/pdf", "text/plain"]
    });
    expect(mobileAttachmentPickerMediaTypes(resolveMobileAttachmentPolicy(backend, true)!)).toEqual([
      "image/jpeg", "image/png", "application/pdf", "text/plain"
    ]);
    expect(resolveMobileAttachmentPolicy(backend)).toEqual({
      images: false,
      files: true,
      maximumItems: 3,
      maximumBytes: 8_000,
      imageMediaTypes: [],
      fileMediaTypes: ["application/pdf", "text/plain"]
    });
  });

  it("fails closed on missing, wrong, duplicated, or malformed typed input capability options", () => {
    const capability = backend.capabilities!.capabilities[0]!;
    const descriptor = (values: readonly (typeof capability)[]) => create(BackendDescriptorSchema, {
      backendId: "backend",
      capabilities: create(CapabilityManifestSchema, { capabilities: [...values] })
    });

    expect(resolveMobileAttachmentPolicy(descriptor([
      create(CapabilitySchema, {
        name: capabilityNames.inputImage,
        support: CapabilitySupport.SUPPORTED
      })
    ]), true)).toBeUndefined();
    expect(resolveMobileAttachmentPolicy(descriptor([
      create(CapabilitySchema, {
        name: capabilityNames.inputFile,
        support: CapabilitySupport.SUPPORTED,
        options: create(CapabilityOptionsSchema, {
          kind: { case: "model", value: { providerAware: true } }
        })
      })
    ]))).toBeUndefined();
    expect(resolveMobileAttachmentPolicy(descriptor([capability, capability]), true)).toBeUndefined();
    expect(resolveMobileAttachmentPolicy(descriptor([
      create(CapabilitySchema, {
        name: capabilityNames.inputFile,
        support: CapabilitySupport.SUPPORTED,
        options: create(CapabilityOptionsSchema, {
          kind: { case: "input", value: create(InputCapabilityOptionsSchema, {
            mediaTypes: ["not a media type"]
          }) }
        })
      })
    ]))).toBeUndefined();
  });

  it("classifies only admitted MIME types, normalizes picker metadata, and rejects invalid sizes", () => {
    expect(classifyMobileAttachment("IMAGE/PNG; charset=binary", policy)).toBe("image");
    expect(classifyMobileAttachment("application/pdf", policy)).toBe("file");
    expect(assertMobileAttachmentCandidate({
      fileName: "folder\\proof.pdf",
      mediaType: "APPLICATION/PDF",
      byteSize: 512
    }, policy)).toEqual({ kind: "file", fileName: "proof.pdf", mediaType: "application/pdf" });
    expect(() => classifyMobileAttachment("image/jpeg", policy)).toThrow(/image type is not supported/u);
    expect(() => classifyMobileAttachment("image/png", {
      ...policy,
      images: false,
      files: true,
      fileMediaTypes: []
    })).toThrow(/Backend and model/u);
    expect(() => classifyMobileAttachment("text/plain", policy)).toThrow(/file type is not supported/u);
    expect(() => assertMobileAttachmentCandidate({
      fileName: "too-large.pdf", mediaType: "application/pdf", byteSize: 1_025
    }, policy)).toThrow(/attachment limit/u);
    expect(() => assertMobileAttachmentCandidate({
      fileName: "empty.pdf", mediaType: "application/pdf", byteSize: 0
    }, policy)).toThrow(/empty or has an invalid size/u);
  });

  it("preserves ordered identities across append, upload replacement, and exact removal", () => {
    const appended = appendMobileComposerAttachments([], [localImage, localFile], policy);
    expect(appended.map((attachment) => attachment.attachmentId)).toEqual(["image-one", "file-one"]);
    const uploaded = {
      ...localImage,
      state: "uploaded",
      blobId: "blob-image-one"
    } satisfies MobileUploadedComposerAttachment;
    const replaced = replaceMobileComposerAttachment(appended, localImage.attachmentId, uploaded);
    expect(replaced).toEqual([uploaded, localFile]);
    expect(mobileComposerAttachmentsEqual(replaced[0]!, uploaded)).toBe(true);
    const removed = removeMobileComposerAttachment(replaced, localFile.attachmentId);
    expect(removed).toEqual({ attachments: [uploaded], removed: localFile });

    expect(() => appendMobileComposerAttachments([localImage], [localImage], policy)).toThrow(/already in this draft/u);
    expect(() => appendMobileComposerAttachments(appended, [{ ...localFile, attachmentId: "file-two" }], policy))
      .toThrow(/at most 2 attachments/u);
    expect(() => assertMobileAttachmentPolicy([{ ...localFile, mediaType: "text/plain" }], policy))
      .toThrow(/file type is not supported/u);
  });

  it("retains normalized annotation source truth while atomically replacing one visible slot", () => {
    const annotated = {
      ...localImage,
      attachmentId: "image-annotated",
      fileName: "pixel-annotated.png",
      sha256Hex: "c".repeat(64),
      annotation: {
        source: {
          storageId: "annotation-source-one",
          fileName: localImage.fileName,
          mediaType: localImage.mediaType,
          byteSize: localImage.byteSize,
          sha256Hex: localImage.sha256Hex,
          capturedAtUnixMs: localImage.capturedAtUnixMs
        },
        strokes: [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] }]
      }
    } satisfies MobileLocalComposerAttachment;
    const replaced = replaceMobileComposerAttachmentSlot([localImage, localFile], localImage, annotated);
    expect(replaced).toEqual([annotated, localFile]);
    expect(mobileComposerAttachmentsEqual(replaced[0]!, annotated)).toBe(true);
    expect(mobileComposerAttachmentStorageIds([annotated, localFile])).toEqual([
      "image-annotated", "annotation-source-one", "file-one"
    ]);
    expect(() => replaceMobileComposerAttachmentSlot([localImage], { ...localImage, byteSize: 5 }, annotated))
      .toThrow(/changed/u);
    expect(() => assertMobileAttachmentPolicy([{ ...annotated, annotation: {
      ...annotated.annotation,
      source: { ...annotated.annotation.source, storageId: annotated.attachmentId }
    } }], policy)).toThrow(/isolated/u);
    expect(() => assertMobileAttachmentPolicy([annotated, {
      ...localFile,
      attachmentId: annotated.annotation.source.storageId
    }], policy)).toThrow(/every visible attachment/u);
    expect(() => assertMobileAttachmentPolicy([annotated, {
      ...annotated,
      attachmentId: "image-annotated-two"
    }], policy)).toThrow(/source identity is duplicated/u);
  });
});

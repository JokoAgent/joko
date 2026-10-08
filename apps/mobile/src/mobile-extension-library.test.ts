import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import {
  ExtensionLibraryGraceEntrySchema,
  ExtensionLibraryLocationKind,
  ExtensionLibraryLocationSchema,
  ExtensionLibraryLocationValidationSchema,
  ExtensionLibraryOverviewSchema,
  ExtensionLibraryState,
  ExtensionLibraryTrashEntrySchema,
  ExtensionLibraryUnavailableReason,
  RevisionSchema
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  mobileExtensionLibraryReady,
  mobileExtensionLibrarySupported,
  normalizeMobileExtensionLibraryCandidate,
  projectMobileExtensionLibraryGraceList,
  projectMobileExtensionLibraryLocationValidation,
  projectMobileExtensionLibraryOverview,
  projectMobileExtensionLibraryTrashList,
  sameMobileExtensionLibrarySnapshot
} from "./mobile-extension-library";
import type { MobileExtension } from "./mobile-extensions";

const extensionId = `extension_${"1".repeat(32)}`;

describe("mobile Extension Library projection", () => {
  it("requires a current Resource-owned installed capability and distinguishes recovery access from active readiness", () => {
    const extension = fixtureExtension();
    expect(mobileExtensionLibrarySupported(extension)).toBe(true);
    expect(mobileExtensionLibraryReady(extension)).toBe(true);
    expect(mobileExtensionLibraryReady({ ...extension, enabled: false })).toBe(false);
    expect(mobileExtensionLibrarySupported({ ...extension, owner: {
      kind: "mcp", serverId: "server", serverRevision: 1n
    } })).toBe(false);
    expect(mobileExtensionLibrarySupported({ ...extension, library: undefined })).toBe(false);
  });

  it("projects exact overview, location and warning state while rejecting unknown or cross-Extension authority", () => {
    const overview = create(ExtensionLibraryOverviewSchema, {
      extensionId,
      name: "Workspace Notes",
      state: ExtensionLibraryState.READ_ONLY,
      unavailableReason: ExtensionLibraryUnavailableReason.UNSPECIFIED,
      location: create(ExtensionLibraryLocationSchema, {
        kind: ExtensionLibraryLocationKind.CUSTOM,
        path: "D:\\Libraries\\Notes",
        generation: create(RevisionSchema, { value: 8n })
      }),
      files: 4,
      bytes: 2_048n,
      diskFreeBytes: 8_192n,
      softLimitBytes: 4_096n,
      softLimitExceeded: false,
      orphaned: false,
      trashCount: 1,
      graceCount: 2,
      operation: { operationId: `library_migration_${"2".repeat(32)}`, phase: "copying" }
    });
    expect(projectMobileExtensionLibraryOverview(overview, extensionId)).toMatchObject({
      extensionId,
      state: "readOnly",
      location: { kind: "custom", generation: 8n },
      operation: { phase: "copying" }
    });
    expect(() => projectMobileExtensionLibraryOverview(overview, `extension_${"3".repeat(32)}`)).toThrow(/invalid/u);
    expect(() => projectMobileExtensionLibraryOverview({
      ...overview,
      state: ExtensionLibraryState.UNAVAILABLE,
      unavailableReason: ExtensionLibraryUnavailableReason.UNSPECIFIED
    }, extensionId)).toThrow(/invalid/u);
    expect(() => projectMobileExtensionLibraryOverview({
      ...overview,
      state: 99 as ExtensionLibraryState
    }, extensionId)).toThrow(/state/u);

    const validation = projectMobileExtensionLibraryLocationValidation(create(ExtensionLibraryLocationValidationSchema, {
      libraryRoot: "D:\\Libraries\\Notes\\extension-root",
      warnings: ["cloud_sync_location"],
      diskFreeBytes: 9_999n
    }));
    expect(validation).toEqual({
      libraryRoot: "D:\\Libraries\\Notes\\extension-root",
      warnings: ["cloud_sync_location"],
      diskFreeBytes: 9_999n
    });
    expect(() => projectMobileExtensionLibraryLocationValidation(create(ExtensionLibraryLocationValidationSchema, {
      libraryRoot: "D:\\Library",
      warnings: ["cloud_sync_location", "cloud_sync_location"]
    }))).toThrow(/warnings/u);
  });

  it("binds recovery entries to the exact Extension and retention window and rejects duplicates", () => {
    const trash = create(ExtensionLibraryTrashEntrySchema, {
      trashId: `library_trash_${"4".repeat(32)}`,
      extensionId,
      name: "Workspace Notes",
      deletedAt: { seconds: 10n },
      expiresAt: { seconds: 20n },
      files: 3,
      bytes: 42n
    });
    const grace = create(ExtensionLibraryGraceEntrySchema, {
      graceId: `library_grace_${"5".repeat(32)}`,
      extensionId,
      name: "Workspace Notes",
      createdAt: { seconds: 30n },
      expiresAt: { seconds: 40n },
      files: 3,
      bytes: 42n
    });
    expect(projectMobileExtensionLibraryTrashList([trash], extensionId)[0]).toMatchObject({
      id: trash.trashId,
      deletedAt: 10_000
    });
    expect(projectMobileExtensionLibraryGraceList([grace], extensionId)[0]).toMatchObject({
      id: grace.graceId,
      createdAt: 30_000
    });
    expect(() => projectMobileExtensionLibraryTrashList([trash, trash], extensionId)).toThrow(/trash list/u);
    expect(() => projectMobileExtensionLibraryGraceList([{ ...grace, extensionId: `extension_${"6".repeat(32)}` }], extensionId))
      .toThrow(/grace record/u);
    expect(() => projectMobileExtensionLibraryTrashList([{
      ...trash,
      expiresAt: create(TimestampSchema, { seconds: 5n })
    }], extensionId))
      .toThrow(/retention/u);
    expect(() => projectMobileExtensionLibraryTrashList([{
      ...trash,
      expiresAt: create(TimestampSchema, { seconds: 8_640_000_000_001n })
    }], extensionId)).toThrow(/expiry/u);
  });

  it("normalizes remote candidates and compares complete recovery snapshots independent of list order", () => {
    expect(normalizeMobileExtensionLibraryCandidate("  /srv/joko  ")).toBe("/srv/joko");
    expect(() => normalizeMobileExtensionLibraryCandidate(" \0 ")).toThrow(/valid parent/u);
    const first = {
      trash: [recoveryTrash("1"), recoveryTrash("2")],
      grace: [recoveryGrace("3")]
    };
    const reordered = {
      trash: [first.trash[1]!, first.trash[0]!],
      grace: first.grace
    };
    expect(sameMobileExtensionLibrarySnapshot(first, reordered)).toBe(true);
    expect(sameMobileExtensionLibrarySnapshot(first, {
      ...reordered,
      trash: [{ ...reordered.trash[0]!, bytes: 99n }, reordered.trash[1]!]
    })).toBe(false);
  });
});

function fixtureExtension(): MobileExtension {
  return {
    extensionId,
    revision: 4n,
    owner: {
      kind: "resource",
      resourceId: "resource-notes",
      discoveredRevision: `sha256:${"a".repeat(64)}`,
      resourceRevision: 3n
    },
    source: "local",
    installed: true,
    installState: "installed",
    name: "Workspace Notes",
    description: "Notes",
    enabled: true,
    sidebarSupported: false,
    sidebarVisible: false,
    library: { schemaVersion: 1 },
    tools: [],
    permissions: [],
    commands: [],
    setup: { state: "notRequired", revision: 0n, fields: [] },
    useSupported: false,
    updateAvailable: false
  };
}

function recoveryTrash(seed: string) {
  return {
    id: `library_trash_${seed.repeat(32)}`,
    extensionId,
    name: `Trash ${seed}`,
    deletedAt: 1_000,
    expiresAt: 2_000,
    files: 1,
    bytes: 2n
  };
}

function recoveryGrace(seed: string) {
  return {
    id: `library_grace_${seed.repeat(32)}`,
    extensionId,
    name: `Grace ${seed}`,
    createdAt: 1_000,
    expiresAt: 2_000,
    files: 1,
    bytes: 2n
  };
}

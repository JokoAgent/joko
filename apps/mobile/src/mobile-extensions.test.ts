import { create } from "@bufbuild/protobuf";
import {
  ExtensionCatalogEntrySchema,
  ExtensionCatalogSource,
  ExtensionInstallState,
  ExtensionLibraryDescriptorSchema,
  ExtensionMainViewDescriptorSchema,
  ExtensionMainViewIcon,
  ExtensionOwnerSchema,
  ExtensionPermissionDescriptorSchema,
  ExtensionResourceOwnerSchema,
  ExtensionSetupDescriptorSchema,
  ExtensionSetupFieldDescriptorSchema,
  ExtensionSetupFieldKind,
  ExtensionSetupState,
  ExtensionToolDescriptorSchema,
  ExtensionCommandDescriptorSchema,
  RevisionSchema,
  type ExtensionCatalogEntry
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  collectMobileExtensionCatalog,
  filterMobileExtensions,
  mobileExtensionKey,
  projectMobileExtension,
  type MobileExtensionCatalogPage
} from "./mobile-extensions";

describe("mobile Extension catalog projection", () => {
  it("projects the current installed descriptor and searchable detail without executable material", () => {
    const extension = projectMobileExtension(fixture(1));

    expect(extension).toMatchObject({
      extensionId: "extension_00000000000000000000000000000001",
      revision: 1n,
      owner: { kind: "resource", resourceId: "resource-1", resourceRevision: 3n },
      source: "local",
      installed: true,
      installState: "updateAvailable",
      name: "Review Mail",
      version: "1.4.0",
      author: "Joko Labs",
      enabled: true,
      sidebarSupported: true,
      sidebarVisible: true,
      mainView: { title: "Mail", icon: "layout" },
      library: { schemaVersion: 1 },
      setup: { state: "ready", revision: 0n },
      useSupported: true,
      updateAvailable: true
    });
    expect(extension.tools).toEqual([{ name: "search", description: "Search mail", requiresPermission: true }]);
    expect(extension.permissions).toEqual([expect.objectContaining({ permissionId: "mail.read", granted: true })]);
    expect(extension.commands).toEqual([{ name: "review", description: "Review mail", sessionId: "" }]);
    expect(filterMobileExtensions([extension], "joko labs")).toEqual([extension]);
    expect(filterMobileExtensions([extension], "calendar")).toEqual([]);
  });

  it.each([
    ["unknown install state", (value: ExtensionCatalogEntry) => { value.installState = 99 as ExtensionInstallState; }],
    ["missing owner", (value: ExtensionCatalogEntry) => { value.owner = undefined; }],
    ["duplicate tools", (value: ExtensionCatalogEntry) => { value.tools.push(value.tools[0]!); }],
    ["unknown setup field", (value: ExtensionCatalogEntry) => { value.setup!.fields[0]!.kind = 99 as ExtensionSetupFieldKind; }],
    ["inconsistent main view", (value: ExtensionCatalogEntry) => { value.sidebarSupported = false; }],
    ["unknown Library schema", (value: ExtensionCatalogEntry) => { value.library!.schemaVersion = 2; }]
  ])("rejects %s", (_name, mutate) => {
    const value = fixture(1);
    mutate(value);
    expect(() => projectMobileExtension(value)).toThrow(/invalid Extension/u);
  });

  it("binds the visible row key to revision, owner, state, and enabled status", () => {
    const first = projectMobileExtension(fixture(1));
    const changed = projectMobileExtension(fixture(1));
    changed.owner.kind === "resource" && Object.assign(changed.owner, { resourceRevision: 4n });

    expect(mobileExtensionKey(first)).not.toBe(mobileExtensionKey(changed));
  });
});

describe("mobile Extension catalog pagination", () => {
  it("restarts the complete read once after revision drift", async () => {
    const controller = new AbortController();
    const requests: string[] = [];
    let call = 0;
    const catalog = await collectMobileExtensionCatalog(async (pageToken) => {
      requests.push(pageToken);
      call += 1;
      const secondPage = pageToken === "next";
      const retry = call > 2;
      return page(secondPage ? fixture(2, "Archive Mail") : fixture(1), {
        revision: retry ? 9n : secondPage ? 8n : 7n,
        nextPageToken: secondPage ? "" : "next",
        totalSize: 2
      });
    }, controller.signal);

    expect(requests).toEqual(["", "next", "", "next"]);
    expect(catalog.revision).toBe(9n);
    expect(catalog.extensions.map((extension) => extension.name)).toEqual(["Archive Mail", "Review Mail"]);
  });

  it("accepts the authoritative empty revision-zero catalog", async () => {
    const catalog = await collectMobileExtensionCatalog(async () => ({
      revision: 0n,
      recoveredFromCorruption: false,
      extensions: [],
      nextPageToken: "",
      totalSize: 0
    }), new AbortController().signal);

    expect(catalog).toEqual({ revision: 0n, recoveredFromCorruption: false, extensions: [] });
  });

  it("rejects duplicate identities, cyclic tokens, and inconsistent totals", async () => {
    await expect(collectMobileExtensionCatalog(async () => ({
      revision: 3n,
      recoveredFromCorruption: false,
      extensions: [fixture(1), fixture(1)],
      nextPageToken: "",
      totalSize: 2
    }), new AbortController().signal)).rejects.toThrow(/installed Extension catalog entry/u);

    await expect(collectMobileExtensionCatalog(async (pageToken) => pageToken === ""
      ? page(fixture(1), { revision: 3n, nextPageToken: "next", totalSize: 2 })
      : page(fixture(2), { revision: 3n, nextPageToken: "next", totalSize: 2 }),
    new AbortController().signal)).rejects.toThrow(/page cycle/u);

    await expect(collectMobileExtensionCatalog(async () => page(fixture(1), {
      revision: 3n,
      nextPageToken: "",
      totalSize: 2
    }), new AbortController().signal)).rejects.toThrow(/completeness/u);
  });
});

function page(extension: ExtensionCatalogEntry, input: {
  readonly revision: bigint;
  readonly nextPageToken: string;
  readonly totalSize: number;
}): MobileExtensionCatalogPage {
  return {
    revision: input.revision,
    recoveredFromCorruption: false,
    extensions: [extension],
    nextPageToken: input.nextPageToken,
    totalSize: input.totalSize
  };
}

function fixture(index: number, name = "Review Mail"): ExtensionCatalogEntry {
  return create(ExtensionCatalogEntrySchema, {
    extensionId: `extension_${index.toString(16).padStart(32, "0")}`,
    revision: create(RevisionSchema, { value: BigInt(index) }),
    owner: create(ExtensionOwnerSchema, {
      kind: {
        case: "resource",
        value: create(ExtensionResourceOwnerSchema, {
          resourceId: `resource-${index}`,
          discoveredRevision: `sha256:${index.toString(16).padStart(64, "0")}`,
          resourceVersion: create(RevisionSchema, { value: 3n })
        })
      }
    }),
    source: ExtensionCatalogSource.LOCAL,
    installed: true,
    installState: ExtensionInstallState.UPDATE_AVAILABLE,
    name,
    version: "1.4.0",
    author: "Joko Labs",
    description: "Review messages that need attention.",
    enabled: true,
    sidebarSupported: true,
    sidebarVisible: true,
    mainView: create(ExtensionMainViewDescriptorSchema, { title: "Mail", icon: ExtensionMainViewIcon.LAYOUT }),
    library: create(ExtensionLibraryDescriptorSchema, { schemaVersion: 1 }),
    tools: [create(ExtensionToolDescriptorSchema, {
      name: "search",
      description: "Search mail",
      requiresPermission: true
    })],
    permissions: [create(ExtensionPermissionDescriptorSchema, {
      permissionId: "mail.read",
      label: "Read mail",
      description: "Reads selected mail.",
      required: true,
      granted: true
    })],
    commands: [create(ExtensionCommandDescriptorSchema, {
      name: "review",
      description: "Review mail",
      sessionId: ""
    })],
    setup: create(ExtensionSetupDescriptorSchema, {
      state: ExtensionSetupState.READY,
      revision: create(RevisionSchema, { value: 0n }),
      fields: [create(ExtensionSetupFieldDescriptorSchema, {
        fieldId: "region",
        label: "Region",
        description: "Mail region",
        kind: ExtensionSetupFieldKind.TEXT,
        required: true,
        configured: true,
        options: ["east", "west"]
      })]
    }),
    useSupported: true
  });
}

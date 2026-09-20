import { create } from "@bufbuild/protobuf";
import {
  ArtifactKind,
  ArtifactSchema,
  BackendDescriptorSchema,
  BlobRefSchema,
  CapabilityManifestSchema,
  CapabilityOptionsSchema,
  CapabilitySchema,
  CapabilitySupport,
  EntityVersionSchema,
  InputCapabilityOptionsSchema,
  NativeSessionBindingSchema,
  ResourceKind,
  RevisionSchema,
  SessionResourceSchema,
  SessionSchema,
  SessionState,
  SnapshotSchema,
  TargetSchema,
  TargetState,
  capabilityNames,
  type Snapshot
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  insertMobileArtifactMention,
  insertMobileResourceMention,
  plainTextMobileComposerDraft
} from "./mobile-composer-document";
import {
  assertMobileCatalogMentionCandidate,
  assertMobileCatalogMentionDraft,
  assertMobileCatalogMentionDraftCatalog,
  createMobileCatalogMentionControls,
  filterMobileCatalogMentionCandidates,
  mobileCatalogMentionPolicy,
  projectMobileArtifactMentionCatalog,
  projectMobileResourceMentionCatalog
} from "./mobile-catalog-mentions";

function mentionCapability(options: readonly string[], support = CapabilitySupport.SUPPORTED) {
  return create(CapabilitySchema, {
    name: capabilityNames.inputMention,
    support,
    options: create(CapabilityOptionsSchema, {
      kind: { case: "input", value: create(InputCapabilityOptionsSchema, { mediaTypes: [...options] }) }
    })
  });
}

function snapshot(options: readonly string[] = ["resource", "artifact"]): Snapshot {
  const version = create(EntityVersionSchema, {
    generation: 8n,
    revision: create(RevisionSchema, { value: 9n, etag: "r9" })
  });
  return create(SnapshotSchema, {
    generation: 1n,
    backends: [create(BackendDescriptorSchema, {
      backendId: "backend",
      version: "backend-v1",
      entityVersion: version,
      capabilities: create(CapabilityManifestSchema, {
        revision: create(RevisionSchema, { value: 4n, etag: "cap-r4" }),
        capabilities: [mentionCapability(options)]
      })
    })],
    targets: [create(TargetSchema, {
      targetId: "target", backendId: "backend", state: TargetState.ACTIVE, version
    })],
    sessions: [
      create(SessionSchema, {
        sessionId: "session", backendId: "backend", targetId: "target", displayName: "Current task",
        state: SessionState.IDLE, nativeBinding: { runtimeGeneration: 8n }, version
      }),
      create(SessionSchema, {
        sessionId: "source", backendId: "backend", targetId: "target", displayName: "Archived source",
        state: SessionState.CLOSED, nativeBinding: { runtimeGeneration: 8n }, version
      })
    ]
  });
}

describe("mobile Resource and Artifact mention ownership", () => {
  it("derives Resource and Artifact support only from unique explicit options", () => {
    const backend = (options: readonly string[], support?: CapabilitySupport) => create(BackendDescriptorSchema, {
      backendId: "backend",
      capabilities: create(CapabilityManifestSchema, { capabilities: [mentionCapability(options, support)] })
    });

    expect(mobileCatalogMentionPolicy(backend(["resource"]))).toEqual({ resources: true, artifacts: false });
    expect(mobileCatalogMentionPolicy(backend(["artifact"]))).toEqual({ resources: false, artifacts: true });
    expect(mobileCatalogMentionPolicy(backend(["resource", "artifact"]))).toEqual({ resources: true, artifacts: true });
    expect(mobileCatalogMentionPolicy(backend([]))).toBeUndefined();
    expect(mobileCatalogMentionPolicy(backend(["resource", "resource"]))).toBeUndefined();
    expect(mobileCatalogMentionPolicy(backend(["resource"], CapabilitySupport.UPSTREAM_MISSING))).toBeUndefined();
    expect(mobileCatalogMentionPolicy(create(BackendDescriptorSchema, {
      backendId: "backend",
      capabilities: create(CapabilityManifestSchema, {
        capabilities: [mentionCapability(["resource"]), mentionCapability(["artifact"])]
      })
    }))).toBeUndefined();
  });

  it("opens only for an exact current runtime and retains closed but undeleted Artifact source tasks", () => {
    const owner = snapshot();
    const controls = createMobileCatalogMentionControls("authority", owner, owner, "session");
    expect(controls).toMatchObject({
      authorityKey: "authority", sessionId: "session", backendId: "backend", targetId: "target",
      runtimeGeneration: "8", policy: { resources: true, artifacts: true },
      artifactSources: [
        { sessionId: "source", displayText: "Archived source" },
        { sessionId: "session", displayText: "Current task" }
      ]
    });
    expect(createMobileCatalogMentionControls("authority", owner, create(SnapshotSchema, {
      ...owner,
      sessions: owner.sessions.map((session) => session.sessionId === "session"
        ? create(SessionSchema, { ...session, nativeBinding: create(NativeSessionBindingSchema, { runtimeGeneration: 9n }) })
        : session)
    }), "session")).toBeUndefined();
    expect(createMobileCatalogMentionControls("authority", owner, create(SnapshotSchema, {
      ...owner, generation: 2n
    }), "session")).toBeUndefined();
  });

  it("projects exact live Resource and stable cross-task Artifact catalogs and searches their identities", () => {
    const owner = snapshot();
    const controls = createMobileCatalogMentionControls("authority", owner, owner, "session")!;
    const resourceCatalog = projectMobileResourceMentionCatalog(controls, [create(SessionResourceSchema, {
      sessionId: "session", resourceId: "skill-one", kind: ResourceKind.SKILL, name: "Release helper",
      version: "1.2.3", discoveredRevision: "sha256:skill", resourceVersion: 7n, runtimeGeneration: 8n
    })]);
    const sourceArtifact = create(ArtifactSchema, {
      artifactId: "report", sessionId: "source", kind: ArtifactKind.TOOL_RESULT, title: "Release report",
      blob: create(BlobRefSchema, {
        blobId: "blob-report", fileName: "report.txt", mediaType: "text/plain", byteSize: 42n,
        sha256Hex: "a".repeat(64)
      }),
      createdAt: { seconds: 1n }
    });
    const currentArtifact = create(ArtifactSchema, {
      ...sourceArtifact,
      sessionId: "session",
      blob: create(BlobRefSchema, { ...sourceArtifact.blob!, blobId: "blob-current-report" })
    });
    const artifactCatalog = projectMobileArtifactMentionCatalog(controls, [sourceArtifact, currentArtifact], "artifact-r4");

    expect(resourceCatalog.items).toMatchObject([{
      kind: "resource", resourceId: "skill-one", discoveredRevision: "sha256:skill",
      resourceVersion: "7", runtimeGeneration: "8", resourceKind: ResourceKind.SKILL
    }]);
    expect(artifactCatalog.items.map((item) => [item.artifactId, item.sourceSessionId])).toEqual([
      ["report", "session"],
      ["report", "source"]
    ]);
    expect(artifactCatalog.items[1]).toMatchObject({
      kind: "artifact", artifactId: "report", sourceSessionId: "source", sourceDisplayText: "Archived source",
      artifactKind: ArtifactKind.TOOL_RESULT, fileName: "report.txt", mediaType: "text/plain", byteSize: "42"
    });
    expect(filterMobileCatalogMentionCandidates({ resources: resourceCatalog, artifacts: artifactCatalog }, "archived"))
      .toMatchObject({ items: [{ kind: "artifact", artifactId: "report" }], truncated: false });
    expect(filterMobileCatalogMentionCandidates({ resources: resourceCatalog, artifacts: artifactCatalog }, "skill-one"))
      .toMatchObject({ items: [{ kind: "resource", resourceId: "skill-one" }], truncated: false });
    expect(() => projectMobileResourceMentionCatalog(controls, [create(SessionResourceSchema, {
      sessionId: "session", resourceId: "skill-one", kind: ResourceKind.SKILL, name: "Skill",
      discoveredRevision: "revision", resourceVersion: 1n, runtimeGeneration: 7n
    })])).toThrow(/outside the current task runtime/u);
    expect(() => projectMobileArtifactMentionCatalog(controls, [create(ArtifactSchema, {
      artifactId: "report", sessionId: "deleted", kind: ArtifactKind.FILE,
      blob: { blobId: "blob", fileName: "report", mediaType: "text/plain", byteSize: 1n }
    })], "artifact-r5")).toThrow(/invalid Artifact reference candidate/u);
  });

  it("revalidates selection and every retained draft authority against fresh catalogs", () => {
    const owner = snapshot();
    const controls = createMobileCatalogMentionControls("authority", owner, owner, "session")!;
    const resources = projectMobileResourceMentionCatalog(controls, [create(SessionResourceSchema, {
      sessionId: "session", resourceId: "resource", kind: ResourceKind.PROMPT_TEMPLATE, name: "Same label",
      discoveredRevision: "revision", resourceVersion: 3n, runtimeGeneration: 8n
    })]);
    const artifacts = projectMobileArtifactMentionCatalog(controls, [create(ArtifactSchema, {
      artifactId: "artifact", sessionId: "source", kind: ArtifactKind.FILE, title: "Same label",
      blob: create(BlobRefSchema, {
        blobId: "blob", fileName: "same.txt", mediaType: "text/plain", byteSize: 1n, sha256Hex: "b".repeat(64)
      }),
      createdAt: { seconds: 1n }
    })], "artifact-r1");
    const catalog = { resources, artifacts };
    const resourceCandidate = resources.items[0]!;
    const artifactCandidate = artifacts.items[0]!;
    expect(assertMobileCatalogMentionCandidate(controls, catalog, resourceCandidate)).toBe(resourceCandidate);
    expect(assertMobileCatalogMentionCandidate(controls, catalog, artifactCandidate)).toBe(artifactCandidate);

    const withResource = insertMobileResourceMention(plainTextMobileComposerDraft("Use "), { start: 4, end: 4 },
      resourceCandidate, "resource-occurrence");
    const draft = insertMobileArtifactMention(withResource.draft, withResource.selection,
      artifactCandidate, "artifact-occurrence").draft;
    expect(assertMobileCatalogMentionDraft(controls, draft)).toEqual(draft);
    expect(assertMobileCatalogMentionDraftCatalog(controls, catalog, draft)).toEqual(draft);
    expect(() => assertMobileCatalogMentionDraft(undefined, draft)).toThrow(/draft was retained/u);
    expect(() => assertMobileCatalogMentionDraftCatalog(controls, {
      resources: projectMobileResourceMentionCatalog(controls, [create(SessionResourceSchema, {
        sessionId: "session", resourceId: "resource", kind: ResourceKind.PROMPT_TEMPLATE, name: "Same label",
        discoveredRevision: "new-revision", resourceVersion: 4n, runtimeGeneration: 8n
      })]),
      artifacts
    }, draft)).toThrow(/same runtime identity/u);
    expect(() => assertMobileCatalogMentionDraftCatalog(controls, { resources, artifacts: { items: [], revision: "next" } }, draft))
      .toThrow(/original task/u);
  });
});

import { create } from "@bufbuild/protobuf";
import {
  BackendDescriptorSchema,
  CapabilityManifestSchema,
  CapabilitySchema,
  CapabilitySupport,
  ConnectionSchema,
  ConnectionState,
  DeviceKind,
  DeviceSchema,
  EntityVersionSchema,
  NativeEntryKind,
  NativeSessionTreeNodeSchema,
  NativeSessionTreeSchema,
  RevisionSchema,
  ReviewRunSchema,
  RunSchema,
  RunState,
  SessionSchema,
  SessionState,
  SnapshotSchema,
  TargetSchema,
  TargetState,
  capabilityNames,
  nativeSessionTreeWireFields,
  type NativeSessionTree,
  type NativeSessionTreeNestedNode,
  type Snapshot
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  assertMobileNativeTreeNavigation,
  projectMobileNativeTree,
  resolveMobileNativeTreeControls
} from "./mobile-native-tree";

const identity = {
  profileId: "profile",
  connectionId: "connection",
  deviceId: "device",
  serverId: "server"
};

describe("mobile native Session tree", () => {
  it("projects the stable native order, active path, and branch indentation", () => {
    const { owner, detail } = snapshots();
    const controls = resolveMobileNativeTreeControls(identity, owner, detail, "session");
    expect(controls).toMatchObject({ canNavigate: true, surfaceOwnerKey: expect.any(String) });

    const tree = projectMobileNativeTree(controls!, nativeTree([
      treeNode("root", "", NativeEntryKind.USER_MESSAGE, "Initial prompt", false, [
        treeNode("branch-a", "root", NativeEntryKind.ASSISTANT_MESSAGE, "First answer", false, [
          treeNode("current", "branch-a", NativeEntryKind.TOOL_RESULT, "Current tool result", true)
        ]),
        treeNode("branch-b", "root", NativeEntryKind.BRANCH_SUMMARY, "Alternate summary", false)
      ])
    ], "current"));

    expect(tree).toMatchObject({
      sessionId: "session",
      activeEntryId: "current",
      revisionValue: 9n,
      revisionEtag: "session-r9"
    });
    expect(tree.rows.map((row) => ({
      id: row.entryId,
      kind: row.kind,
      role: row.role,
      active: row.active,
      activePath: row.activePath,
      depth: row.branchDepth,
      branching: row.branching
    }))).toEqual([
      { id: "root", kind: "message", role: "user", active: false, activePath: true, depth: 0, branching: true },
      { id: "branch-a", kind: "message", role: "assistant", active: false, activePath: true, depth: 1, branching: false },
      { id: "current", kind: "message", role: "tool", active: true, activePath: true, depth: 2, branching: false },
      { id: "branch-b", kind: "summary", role: undefined, active: false, activePath: false, depth: 1, branching: false }
    ]);
  });

  it("keeps tree reading available while blocking unsupported, busy, and review navigation", () => {
    const noRewind = snapshots({ rewind: false });
    expect(resolveMobileNativeTreeControls(identity, noRewind.owner, noRewind.detail, "session"))
      .toMatchObject({ canNavigate: false, navigationUnavailableReason: expect.stringMatching(/does not advertise/u) });

    const busy = snapshots({ runState: RunState.RUNNING });
    expect(resolveMobileNativeTreeControls(identity, busy.owner, busy.detail, "session"))
      .toMatchObject({ canNavigate: false, navigationUnavailableReason: expect.stringMatching(/activity/u) });

    const review = snapshots({ reviewReadOnly: true });
    expect(resolveMobileNativeTreeControls(identity, review.owner, review.detail, "session"))
      .toMatchObject({ canNavigate: false, navigationUnavailableReason: expect.stringMatching(/review/u) });
  });

  it("fails closed on owner/detail drift and ambiguous tree capability authority", () => {
    const current = snapshots();
    const driftedDetail = create(SnapshotSchema, { ...current.detail, generation: current.detail.generation + 1n });
    expect(resolveMobileNativeTreeControls(identity, current.owner, driftedDetail, "session")).toBeUndefined();

    const currentManifest = current.owner.backends[0]!.capabilities!;
    const duplicateBackend = create(BackendDescriptorSchema, {
      ...current.owner.backends[0]!,
      capabilities: create(CapabilityManifestSchema, {
        schemaVersion: currentManifest.schemaVersion,
        revision: currentManifest.revision,
        capabilities: [
          ...currentManifest.capabilities,
          create(CapabilitySchema, { name: capabilityNames.sessionTree, support: CapabilitySupport.SUPPORTED })
        ]
      })
    });
    const ambiguousOwner = create(SnapshotSchema, { ...current.owner, backends: [duplicateBackend] });
    const ambiguousDetail = create(SnapshotSchema, { ...current.detail, backends: [duplicateBackend] });
    expect(resolveMobileNativeTreeControls(identity, ambiguousOwner, ambiguousDetail, "session")).toBeUndefined();

    const staleSession = create(SnapshotSchema, {
      ...current.owner,
      sessions: [create(SessionSchema, {
        ...current.owner.sessions[0]!,
        version: create(EntityVersionSchema, {
          revision: create(RevisionSchema, { value: 8n, etag: "session-r8" }),
          generation: 8n
        })
      })]
    });
    expect(resolveMobileNativeTreeControls(identity, staleSession, current.detail, "session")).toBeUndefined();
  });

  it("rejects stale, inconsistent, malformed, and over-depth native trees", () => {
    const { owner, detail } = snapshots();
    const controls = resolveMobileNativeTreeControls(identity, owner, detail, "session")!;
    const root = treeNode("root", "", NativeEntryKind.USER_MESSAGE, "Root", true);

    expect(() => projectMobileNativeTree(controls, nativeTree([root], "root", 8n, "session-r8")))
      .toThrow(/different task revision/u);
    expect(() => projectMobileNativeTree(controls, nativeTree([
      treeNode("root", "wrong-parent", NativeEntryKind.USER_MESSAGE, "Root", true)
    ], "root"))).toThrow(/invalid native tree node/u);
    expect(() => projectMobileNativeTree(controls, nativeTree([
      treeNode("root", "", NativeEntryKind.USER_MESSAGE, "Root", false)
    ], "root"))).toThrow(/inconsistent native tree activity/u);
    expect(() => projectMobileNativeTree(controls, nativeTree([
      treeNode("root", "", NativeEntryKind.USER_MESSAGE, "Root", true, [], { seconds: -1n })
    ], "root"))).toThrow(/invalid native tree node/u);

    let deep = treeNode("entry-65", "entry-64", NativeEntryKind.CUSTOM, "Deep", true);
    for (let depth = 64; depth >= 0; depth -= 1) {
      deep = treeNode(`entry-${depth}`, depth === 0 ? "" : `entry-${depth - 1}`,
        NativeEntryKind.CUSTOM, `Depth ${depth}`, false, [deep]);
    }
    expect(() => projectMobileNativeTree(controls, nativeTree([deep], "entry-65")))
      .toThrow(/display limit/u);
  });

  it("validates the current tree and keeps summarization explicit", () => {
    const { owner, detail } = snapshots();
    const controls = resolveMobileNativeTreeControls(identity, owner, detail, "session")!;
    const tree = projectMobileNativeTree(controls, nativeTree([
      treeNode("root", "", NativeEntryKind.USER_MESSAGE, "Root", false, [
        treeNode("current", "root", NativeEntryKind.ASSISTANT_MESSAGE, "Current", true),
        treeNode("alternate", "root", NativeEntryKind.ASSISTANT_MESSAGE, "Alternate", false)
      ])
    ], "current"));

    expect(assertMobileNativeTreeNavigation(controls, tree, "alternate", true, "  Preserve tests  "))
      .toEqual({ entryId: "alternate", summarize: true, customInstructions: "Preserve tests" });
    expect(assertMobileNativeTreeNavigation(controls, tree, "alternate", false, "must not be sent"))
      .toEqual({ entryId: "alternate", summarize: false, customInstructions: "" });
    expect(() => assertMobileNativeTreeNavigation(controls, tree, "current", false, ""))
      .toThrow(/already active/u);
    expect(() => assertMobileNativeTreeNavigation(controls, tree, "missing", false, ""))
      .toThrow(/current native branch tree/u);
    expect(() => assertMobileNativeTreeNavigation(controls, tree, "alternate", true, "x".repeat(4001)))
      .toThrow(/4000/u);

    const changed = snapshots({ detailRevision: 32n });
    const changedControls = resolveMobileNativeTreeControls(identity, changed.owner, changed.detail, "session")!;
    expect(() => assertMobileNativeTreeNavigation(changedControls, tree, "alternate", false, ""))
      .toThrow(/tree changed/u);
  });
});

function snapshots(input: {
  readonly rewind?: boolean;
  readonly runState?: RunState;
  readonly reviewReadOnly?: boolean;
  readonly detailRevision?: bigint;
} = {}): { readonly owner: Snapshot; readonly detail: Snapshot } {
  const session = create(SessionSchema, {
    sessionId: "session",
    backendId: "backend",
    targetId: "target",
    displayName: "Task",
    state: SessionState.IDLE,
    nativeBinding: { backendId: "backend", opaqueReference: "native", runtimeGeneration: 8n, runtimeAttached: true },
    version: { revision: { value: 9n, etag: "session-r9" }, generation: 8n }
  });
  const backend = create(BackendDescriptorSchema, {
    backendId: "backend",
    displayName: "Backend",
    capabilities: create(CapabilityManifestSchema, {
      schemaVersion: "1",
      revision: { value: 4n, etag: "capabilities-r4" },
      capabilities: [
        create(CapabilitySchema, { name: capabilityNames.sessionTree, support: CapabilitySupport.SUPPORTED }),
        create(CapabilitySchema, { name: capabilityNames.sessionRewind,
          support: input.rewind === false ? CapabilitySupport.UPSTREAM_MISSING : CapabilitySupport.SUPPORTED })
      ]
    }),
    entityVersion: { revision: { value: 3n, etag: "backend-r3" }, generation: 2n }
  });
  const target = create(TargetSchema, {
    targetId: "target", backendId: "backend", displayName: "Target", state: TargetState.ACTIVE,
    version: { revision: { value: 2n, etag: "target-r2" }, generation: 1n }
  });
  const common = {
    generation: 5n,
    server: { serverId: "server" },
    sessions: [session],
    backends: [backend],
    targets: [target]
  };
  return {
    owner: create(SnapshotSchema, {
      ...common,
      snapshotId: "owner",
      revision: { value: 30n, etag: "owner-r30" },
      scope: { kind: { case: "owner", value: {} } },
      connections: [create(ConnectionSchema, {
        connectionId: "connection", connectionProfileId: "profile", deviceId: "device",
        state: ConnectionState.CONNECTED, version: { revision: { value: 7n } }
      })],
      devices: [create(DeviceSchema, {
        deviceId: "device", displayName: "Phone", kind: DeviceKind.MOBILE,
        connectionIds: ["connection"], version: { revision: { value: 8n } }
      })]
    }),
    detail: create(SnapshotSchema, {
      ...common,
      snapshotId: "detail",
      revision: { value: input.detailRevision ?? 31n, etag: `detail-r${input.detailRevision ?? 31n}` },
      scope: { kind: { case: "session", value: { sessionId: "session", recentTimelineItems: 120 } } },
      ...(input.runState === undefined ? {} : { runs: [create(RunSchema, {
        runId: "run", sessionId: "session", state: input.runState,
        version: { revision: { value: 10n }, generation: 8n }
      })] }),
      ...(input.reviewReadOnly ? { reviewRuns: [create(ReviewRunSchema, {
        reviewRunId: "review", sourceSessionId: "source", reviewerSessionId: "session",
        revision: { value: 11n }
      })] } : {})
    })
  };
}

function nativeTree(
  roots: readonly NativeSessionTreeNestedNode[],
  activeEntryId: string,
  revision = 9n,
  etag = "session-r9"
): NativeSessionTree {
  return create(NativeSessionTreeSchema, {
    sessionId: "session",
    activeEntryId,
    revision: { value: revision, etag },
    ...nativeSessionTreeWireFields(roots)
  });
}

function treeNode(
  entryId: string,
  parentEntryId: string,
  kind: NativeEntryKind,
  summary: string,
  active: boolean,
  children: readonly NativeSessionTreeNestedNode[] = [],
  createdAt: { readonly seconds: bigint; readonly nanos?: number } = { seconds: 1n }
): NativeSessionTreeNestedNode {
  return {
    ...create(NativeSessionTreeNodeSchema, {
      entryId,
      parentEntryId,
      kind,
      summary,
      active,
      createdAt
    }),
    children: [...children]
  };
}

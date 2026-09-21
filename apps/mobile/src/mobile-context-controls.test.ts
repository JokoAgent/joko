import { create } from "@bufbuild/protobuf";
import {
  BackendDescriptorSchema,
  CapabilityManifestSchema,
  CapabilitySchema,
  CapabilitySupport,
  CompactionState,
  ConnectionSchema,
  ConnectionState,
  ContextUsageSchema,
  DeviceKind,
  DeviceSchema,
  EntityVersionSchema,
  EventSchema,
  ReviewRunSchema,
  RunSchema,
  RunState,
  RevisionSchema,
  SessionSchema,
  SessionState,
  SnapshotSchema,
  TargetSchema,
  TargetState,
  UsageSchema,
  capabilityNames,
  type ContextUsage,
  type Event,
  type Session,
  type Snapshot
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  assertMobileContextCompact,
  formatMobileContextTokens,
  resolveMobileContextControls
} from "./mobile-context-controls";

const identity = {
  profileId: "profile",
  connectionId: "connection",
  deviceId: "device",
  serverId: "server"
};

describe("mobile context controls", () => {
  it("projects exact typed usage and manual compaction authority", () => {
    const { owner, detail } = snapshots();
    const controls = resolveMobileContextControls(identity, owner, detail, "session");

    expect(controls).toMatchObject({
      usageSupported: true,
      compactSupported: true,
      canCompact: true,
      usage: {
        usedTokens: 50_000n,
        contextWindowTokens: 100_000n,
        reservedTokens: 50_000n,
        utilizationRatio: 0.5,
        percent: 50,
        measuredAtMs: 123_000,
        cumulative: {
          inputTokens: 40_000n,
          outputTokens: 5_000n,
          cacheReadTokens: 4_000n,
          cacheWriteTokens: 1_000n,
          totalTokens: 50_000n
        }
      }
    });
    expect(assertMobileContextCompact(controls!)).toBe(controls?.session);
    expect(formatMobileContextTokens(999n)).toBe("999");
    expect(formatMobileContextTokens(1_250n)).toBe("1.3K");
    expect(formatMobileContextTokens(2_000_000n)).toBe("2M");
  });

  it("keeps missing usage explicit and blocks active, busy, and review compaction", () => {
    const missing = snapshots({ context: undefined });
    const missingControls = resolveMobileContextControls(identity, missing.owner, missing.detail, "session");
    expect(missingControls).toMatchObject({
      usageSupported: true,
      compactSupported: true,
      canCompact: false,
      compactUnavailableReason: "Current context usage is unavailable."
    });
    expect(missingControls?.usage).toBeUndefined();

    const active = snapshots({ compacting: true });
    const activeControls = resolveMobileContextControls(identity, active.owner, active.detail, "session");
    expect(activeControls).toMatchObject({ canCompact: false, activeCompaction: { compactionId: "active" } });
    expect(() => assertMobileContextCompact(activeControls!)).toThrow(/already compacting/u);

    const busy = snapshots({ runState: RunState.RUNNING });
    expect(resolveMobileContextControls(identity, busy.owner, busy.detail, "session"))
      .toMatchObject({ canCompact: false, compactUnavailableReason: expect.stringMatching(/activity/u) });

    const review = snapshots({ reviewReadOnly: true });
    expect(resolveMobileContextControls(identity, review.owner, review.detail, "session"))
      .toMatchObject({ canCompact: false, compactUnavailableReason: expect.stringMatching(/review/u) });
  });

  it("derives current-generation active compaction and ignores completed or retired generations", () => {
    const started = compactionEvent("compact-current", CompactionState.STARTED, 10n, 8n);
    const completed = compactionEvent("compact-current", CompactionState.COMPLETED, 11n, 8n);
    const retired = compactionEvent("compact-retired", CompactionState.STARTED, 9n, 7n);
    const active = snapshots({ timeline: [retired, started] });
    expect(resolveMobileContextControls(identity, active.owner, active.detail, "session")).toMatchObject({
      canCompact: false,
      activeCompaction: { compactionId: "compact-current", automatic: false, reason: "manual", tokensBefore: 50_000n }
    });

    const terminal = snapshots({ timeline: [retired, started, completed] });
    expect(resolveMobileContextControls(identity, terminal.owner, terminal.detail, "session"))
      .toMatchObject({ canCompact: true });
  });

  it("fails closed on malformed usage, missing typed options, and authority drift", () => {
    const malformed = snapshots({ context: usage({ utilizationRatio: 0.9 }) });
    expect(resolveMobileContextControls(identity, malformed.owner, malformed.detail, "session")).toBeUndefined();
    const inconsistentBoundary = snapshots({ context: usage({ reservedTokens: 49_999n }) });
    expect(resolveMobileContextControls(identity, inconsistentBoundary.owner, inconsistentBoundary.detail, "session"))
      .toBeUndefined();
    const emptyBoundary = snapshots({ context: usage({
      usedTokens: 0n, contextWindowTokens: 0n, reservedTokens: 0n, utilizationRatio: 0
    }) });
    expect(resolveMobileContextControls(identity, emptyBoundary.owner, emptyBoundary.detail, "session")).toBeUndefined();

    const untyped = snapshots({ typedCapabilities: false });
    expect(resolveMobileContextControls(identity, untyped.owner, untyped.detail, "session")).toBeUndefined();

    const current = snapshots();
    const drifted = create(SnapshotSchema, { ...current.detail, generation: current.detail.generation + 1n });
    expect(resolveMobileContextControls(identity, current.owner, drifted, "session")).toBeUndefined();
    const duplicate = create(SnapshotSchema, {
      ...current.owner,
      connections: [...current.owner.connections, current.owner.connections[0]!]
    });
    expect(resolveMobileContextControls(identity, duplicate, current.detail, "session")).toBeUndefined();
    const staleSessionOwner = create(SnapshotSchema, {
      ...current.owner,
      sessions: [create(SessionSchema, {
        ...current.owner.sessions[0]!,
        version: create(EntityVersionSchema, {
          revision: create(RevisionSchema, { value: 8n, etag: "session-r8" }), generation: 8n
        })
      })]
    });
    expect(resolveMobileContextControls(identity, staleSessionOwner, current.detail, "session")).toBeUndefined();
    const staleTargetOwner = create(SnapshotSchema, {
      ...current.owner,
      targets: [create(TargetSchema, {
        ...current.owner.targets[0]!,
        version: create(EntityVersionSchema, {
          revision: create(RevisionSchema, { value: 1n }), generation: 0n
        })
      })]
    });
    expect(resolveMobileContextControls(identity, staleTargetOwner, current.detail, "session")).toBeUndefined();

    const changed = snapshots({ context: usage({ usedTokens: 60_000n, reservedTokens: 40_000n, utilizationRatio: 0.6 }) });
    expect(resolveMobileContextControls(identity, changed.owner, changed.detail, "session")?.authorityKey)
      .not.toBe(resolveMobileContextControls(identity, current.owner, current.detail, "session")?.authorityKey);
  });
});

function snapshots(input: {
  readonly context?: ContextUsage;
  readonly compacting?: boolean;
  readonly runState?: RunState;
  readonly reviewReadOnly?: boolean;
  readonly timeline?: readonly Event[];
  readonly typedCapabilities?: boolean;
} = {}): { readonly owner: Snapshot; readonly detail: Snapshot } {
  const hasContext = Object.prototype.hasOwnProperty.call(input, "context");
  const session = create(SessionSchema, {
    sessionId: "session",
    backendId: "backend",
    targetId: "target",
    displayName: "Task",
    state: SessionState.IDLE,
    nativeBinding: { backendId: "backend", opaqueReference: "native", runtimeGeneration: 8n, runtimeAttached: true },
    ...(hasContext ? (input.context === undefined ? {} : { context: input.context }) : { context: usage() }),
    ...(input.compacting === undefined ? {} : { contextState: { compacting: input.compacting } }),
    version: { revision: { value: 9n, etag: "session-r9" }, generation: 8n }
  });
  const typed = input.typedCapabilities !== false;
  const backend = create(BackendDescriptorSchema, {
    backendId: "backend",
    displayName: "Backend",
    capabilities: create(CapabilityManifestSchema, {
      schemaVersion: "1",
      revision: { value: 4n },
      capabilities: [
        create(CapabilitySchema, {
          name: capabilityNames.contextUsage,
          support: CapabilitySupport.SUPPORTED,
          ...(typed ? { options: { kind: { case: "context", value: { reportsBoundary: true } } } } : {})
        }),
        create(CapabilitySchema, {
          name: capabilityNames.contextCompact,
          support: CapabilitySupport.SUPPORTED,
          ...(typed ? { options: { kind: { case: "context", value: { manual: true } } } } : {})
        })
      ]
    }),
    entityVersion: { revision: { value: 3n }, generation: 2n }
  });
  const target = create(TargetSchema, {
    targetId: "target", backendId: "backend", displayName: "Target", state: TargetState.ACTIVE,
    version: { revision: { value: 2n } }
  });
  const common = {
    generation: 5n,
    server: { serverId: "server" },
    sessions: [session],
    backends: [backend],
    targets: [target]
  };
  const connection = create(ConnectionSchema, {
    connectionId: "connection", connectionProfileId: "profile", deviceId: "device",
    state: ConnectionState.CONNECTED, version: { revision: { value: 7n } }
  });
  const device = create(DeviceSchema, {
    deviceId: "device", displayName: "Phone", kind: DeviceKind.MOBILE,
    connectionIds: ["connection"], version: { revision: { value: 8n } }
  });
  return {
    owner: create(SnapshotSchema, {
      ...common,
      snapshotId: "owner",
      revision: { value: 30n, etag: "owner-r30" },
      scope: { kind: { case: "owner", value: {} } },
      connections: [connection],
      devices: [device]
    }),
    detail: create(SnapshotSchema, {
      ...common,
      snapshotId: "detail",
      revision: { value: 31n, etag: "detail-r31" },
      scope: { kind: { case: "session", value: { sessionId: "session", recentTimelineItems: 120 } } },
      timeline: [...(input.timeline ?? [])],
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

function usage(input: Partial<{
  readonly usedTokens: bigint;
  readonly contextWindowTokens: bigint;
  readonly reservedTokens: bigint;
  readonly utilizationRatio: number;
}> = {}): ContextUsage {
  return create(ContextUsageSchema, {
    usedTokens: input.usedTokens ?? 50_000n,
    contextWindowTokens: input.contextWindowTokens ?? 100_000n,
    reservedTokens: input.reservedTokens ?? 50_000n,
    utilizationRatio: input.utilizationRatio ?? 0.5,
    cumulativeUsage: create(UsageSchema, {
      inputTokens: 40_000n,
      outputTokens: 5_000n,
      cacheReadTokens: 4_000n,
      cacheWriteTokens: 1_000n,
      totalTokens: 50_000n
    }),
    measuredAt: { seconds: 123n }
  });
}

function compactionEvent(
  compactionId: string,
  state: CompactionState,
  sequence: bigint,
  generation: bigint
): Event {
  return create(EventSchema, {
    eventId: `${compactionId}-${sequence}`,
    cursor: { opaqueToken: `cursor-${sequence}`, sequence, generation: 5n },
    identity: { backendId: "backend", targetId: "target", sessionId: "session", generation, sequence },
    payload: { kind: { case: "compactionChanged", value: {
      compactionId,
      state,
      reason: "manual",
      automatic: false,
      tokensBefore: 50_000n
    } } }
  });
}

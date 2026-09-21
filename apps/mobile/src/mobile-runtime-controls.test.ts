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
  ModelDescriptorSchema,
  ModelInputModality,
  ModelKeySchema,
  ModelOutputModality,
  ModelSelectionSchema,
  PermissionMode,
  ProviderDescriptorSchema,
  ProviderConfigurationSchema,
  ProviderKind,
  SessionSchema,
  SnapshotSchema,
  TargetSchema,
  TargetState,
  capabilityNames,
  type Capability,
  type ModelDescriptor,
  type Snapshot
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  assertMobileModelSelection,
  assertMobilePermissionMode,
  assertMobilePlanMode,
  defaultMobileModelSelection,
  filterMobileModelRoutes,
  formatMobileTokenLimit,
  resolveMobileNewTaskDefaultModelAuthority,
  resolveMobileRuntimeControls,
  resolveMobileSessionModelAuthority
} from "./mobile-runtime-controls";

const identity = {
  profileId: "profile",
  connectionId: "connection",
  deviceId: "device",
  serverId: "server"
};

describe("mobile runtime controls", () => {
  it("projects only current Backend text routes allowed by Provider and model-access settings", () => {
    const modelA = model("alpha", "a", "Alpha Model", { context: 128_000n });
    const modelB = model("beta", "b", "Beta Model");
    const imageOnly = model("alpha", "image", "Image only", { outputs: [ModelOutputModality.IMAGE] });
    const ownerManaged = model("managed", "private", "Private Model");
    const { owner, detail } = snapshots({
      models: [modelB, imageOnly, ownerManaged, modelA],
      providers: [
        provider("beta", "Zeta Provider"),
        provider("alpha", "Alpha Provider"),
        provider("managed", "Managed Provider", true)
      ],
      disabledModels: [{ providerId: "beta", modelId: "b" }],
      providerConfigurations: [create(ProviderConfigurationSchema, {
        providerId: "managed", displayName: "Managed Provider", kind: ProviderKind.MANAGED, enabled: false
      })]
    });

    const controls = resolveMobileRuntimeControls(identity, owner, detail, "session");
    expect(controls?.models.map((route) => `${route.providerId}/${route.modelId}`)).toEqual(["alpha/a"]);
    expect(controls?.currentModel).toMatchObject({
      providerId: "alpha",
      modelId: "a",
      displayName: "Alpha Model",
      providerName: "Alpha Provider",
      effortId: "low",
      selectable: true
    });
    expect(filterMobileModelRoutes(controls?.models ?? [], "128")).toEqual([]);
    expect(filterMobileModelRoutes(controls?.models ?? [], "alpha")).toHaveLength(1);
    expect(formatMobileTokenLimit(128_000n, "en")).toBe("128K context");
    expect(detail.models).toEqual([]);
    expect(detail.providers).toEqual([]);
    expect(detail.settings).toBeUndefined();
  });

  it("fails closed on stale authority, duplicate routes, and malformed effort catalogs", () => {
    const duplicateA = model("alpha", "a", "Duplicate");
    const malformedEfforts = model("alpha", "broken", "Broken", {
      efforts: [
        { effortId: "high", displayName: "High", order: 0, defaultLevel: true },
        { effortId: "high", displayName: "Again", order: 1 }
      ]
    });
    const good = model("alpha", "good", "Good");
    const { owner, detail } = snapshots({ models: [model("alpha", "a", "Alpha"), duplicateA, malformedEfforts, good] });
    const controls = resolveMobileRuntimeControls(identity, owner, detail, "session");
    expect(controls?.models.map((route) => route.modelId)).toEqual(["good"]);

    const staleDetail = create(SnapshotSchema, { ...detail, generation: detail.generation + 1n });
    expect(resolveMobileRuntimeControls(identity, owner, staleDetail, "session")).toBeUndefined();
    const staleSession = create(SnapshotSchema, { ...detail, sessions: [create(SessionSchema, {
      ...detail.sessions[0]!,
      version: create(EntityVersionSchema, { revision: { value: 9n }, generation: 7n })
    })] });
    expect(resolveMobileRuntimeControls(identity, owner, staleSession, "session")).toBeUndefined();
    const driftedBackend = create(SnapshotSchema, { ...detail, backends: [create(BackendDescriptorSchema, {
      ...detail.backends[0]!, entityVersion: create(EntityVersionSchema, {
        revision: { value: 99n }, generation: 2n
      })
    })] });
    expect(resolveMobileRuntimeControls(identity, owner, driftedBackend, "session")).toBeUndefined();
    const crossBackendTarget = create(SnapshotSchema, { ...detail, targets: [create(TargetSchema, {
      ...detail.targets[0]!, backendId: "other-backend"
    })] });
    expect(resolveMobileRuntimeControls(identity, owner, crossBackendTarget, "session")).toBeUndefined();
    const duplicateConnection = create(SnapshotSchema, {
      ...owner, connections: [...owner.connections, owner.connections[0]!]
    });
    expect(resolveMobileRuntimeControls(identity, duplicateConnection, detail, "session")).toBeUndefined();
    const missingSettings = create(SnapshotSchema, { ...owner, settings: undefined });
    expect(resolveMobileRuntimeControls(identity, missingSettings, detail, "session")).toBeUndefined();
  });

  it("requires typed capability options and keeps permission and plan authority independent", () => {
    const { owner, detail } = snapshots();
    const controls = resolveMobileRuntimeControls(identity, owner, detail, "session");
    expect(controls).toMatchObject({
      canListModels: true,
      canSwitchModel: true,
      canSetEffort: true,
      canSetFastMode: true,
      canSetPermission: true,
      canSetPlanMode: true,
      permissionModes: [PermissionMode.ASK, PermissionMode.AUTO, PermissionMode.BYPASS_PERMISSIONS]
    });
    expect(assertMobilePermissionMode(controls!, PermissionMode.AUTO)).toBe(PermissionMode.AUTO);
    expect(assertMobilePlanMode(controls!, true)).toBe(true);

    const malformed = withCapabilities(detail, capabilities({ duplicatePermission: true, plan: true }));
    const malformedControls = resolveMobileRuntimeControls(identity, owner, malformed, "session");
    expect(malformedControls?.permissionModes).toEqual([]);
    expect(malformedControls?.canSetPermission).toBe(false);
    expect(malformedControls?.canSetPlanMode).toBe(true);
    expect(() => assertMobilePermissionMode(malformedControls!, PermissionMode.AUTO)).toThrow(/unavailable/u);
  });

  it("validates route, effort, and Fast Mode as independent advertised axes", () => {
    const { owner, detail } = snapshots({
      models: [
        model("alpha", "a", "Alpha"),
        model("beta", "b", "Beta", {
          fast: true,
          efforts: [
            { effortId: "medium", displayName: "Medium", order: 1, defaultLevel: true },
            { effortId: "high", displayName: "High", order: 2 }
          ]
        })
      ],
      providers: [provider("alpha", "Alpha Provider"), provider("beta", "Beta Provider")]
    });
    const controls = resolveMobileRuntimeControls(identity, owner, detail, "session")!;
    const beta = controls.models.find((route) => route.modelId === "b")!;
    expect(defaultMobileModelSelection(controls, beta)).toEqual({
      providerId: "beta",
      modelId: "b",
      effortId: "medium",
      fastMode: false
    });
    expect(assertMobileModelSelection(controls, {
      providerId: "beta",
      modelId: "b",
      effortId: "high",
      fastMode: true
    })).toEqual({ providerId: "beta", modelId: "b", effortId: "high", fastMode: true });
    expect(() => assertMobileModelSelection(controls, {
      providerId: "beta", modelId: "b", effortId: "extreme", fastMode: false
    })).toThrow(/not advertised/u);
    expect(() => assertMobileModelSelection(controls, {
      providerId: "alpha", modelId: "a", effortId: "low", fastMode: false
    })).toThrow(/different model setting/u);

    const noFast = resolveMobileRuntimeControls(identity, owner,
      withCapabilities(detail, capabilities({ fast: false, plan: true })), "session")!;
    expect(() => assertMobileModelSelection(noFast, {
      providerId: "beta", modelId: "b", effortId: "high", fastMode: true
    })).toThrow(/Fast Mode/u);
  });

  it("trusts image input only from one exact current or frozen default model route", () => {
    const vision = model("alpha", "a", "Alpha Vision", {
      inputs: [ModelInputModality.TEXT, ModelInputModality.IMAGE]
    });
    const { owner, detail } = snapshots({ models: [vision] });
    const configured = create(SnapshotSchema, {
      ...owner,
      settings: {
        ...owner.settings!,
        backends: [{
          ...owner.settings!.backends[0]!,
          defaultModel: create(ModelSelectionSchema, {
            model: create(ModelKeySchema, { providerId: "alpha", modelId: "a" }),
            effortId: "low",
            fastMode: false
          })
        }]
      }
    });

    expect(resolveMobileSessionModelAuthority(configured, detail.sessions[0])).toMatchObject({
      selection: { providerId: "alpha", modelId: "a", effortId: "low", fastMode: false },
      supportsImages: true
    });
    expect(resolveMobileNewTaskDefaultModelAuthority(configured, "backend")).toMatchObject({
      selection: { providerId: "alpha", modelId: "a", effortId: "low", fastMode: false },
      supportsImages: true
    });

    const duplicate = create(SnapshotSchema, { ...configured, models: [vision, vision] });
    expect(resolveMobileSessionModelAuthority(duplicate, detail.sessions[0])).toBeUndefined();
    expect(resolveMobileNewTaskDefaultModelAuthority(duplicate, "backend")).toBeUndefined();

    const textOnly = create(SnapshotSchema, {
      ...configured,
      models: [model("alpha", "a", "Alpha Text")]
    });
    expect(resolveMobileSessionModelAuthority(textOnly, detail.sessions[0])?.supportsImages).toBe(false);
    expect(resolveMobileNewTaskDefaultModelAuthority(textOnly, "backend")?.supportsImages).toBe(false);
  });
});

function snapshots(input: {
  readonly models?: readonly ModelDescriptor[];
  readonly providers?: Snapshot["providers"];
  readonly disabledModels?: readonly { readonly providerId: string; readonly modelId: string }[];
  readonly providerConfigurations?: NonNullable<Snapshot["settings"]>["providers"];
} = {}): { readonly owner: Snapshot; readonly detail: Snapshot } {
  const session = create(SessionSchema, {
    sessionId: "session",
    backendId: "backend",
    targetId: "target",
    displayName: "Task",
    nativeBinding: { backendId: "backend", opaqueReference: "native", runtimeGeneration: 8n, runtimeAttached: true },
    model: { model: { providerId: "alpha", modelId: "a" }, effortId: "low", fastMode: false },
    permissionMode: PermissionMode.ASK,
    planMode: false,
    version: { revision: { value: 9n, etag: "session-r9" }, generation: 8n }
  });
  const backend = create(BackendDescriptorSchema, {
    backendId: "backend",
    displayName: "Backend",
    capabilities: create(CapabilityManifestSchema, {
      schemaVersion: "1",
      revision: { value: 4n },
      capabilities: capabilities({ fast: true, plan: true })
    }),
    entityVersion: { revision: { value: 3n }, generation: 2n }
  });
  const models = input.models ?? [model("alpha", "a", "Alpha Model")];
  const providers = input.providers ?? [provider("alpha", "Alpha Provider")];
  const common = {
    generation: 5n,
    server: { serverId: "server" },
    sessions: [session],
    backends: [backend],
    targets: [create(TargetSchema, {
      targetId: "target", backendId: "backend", displayName: "Target", state: TargetState.ACTIVE,
      version: { revision: { value: 2n } }
    })]
  };
  const settings = {
    revision: { value: 6n },
    backends: [{
      backendId: "backend",
      enabled: true,
      modelAccess: { disabledModels: [...(input.disabledModels ?? [])] }
    }],
    providers: [...(input.providerConfigurations ?? [])]
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
      devices: [device],
      models: [...models],
      providers: [...providers],
      settings
    }),
    detail: create(SnapshotSchema, {
      ...common,
      snapshotId: "detail",
      revision: { value: 31n, etag: "detail-r31" },
      scope: { kind: { case: "session", value: { sessionId: "session", recentTimelineItems: 120 } } },
      connections: [],
      devices: [],
      models: [],
      providers: []
    })
  };
}

function withCapabilities(snapshot: Snapshot, values: readonly Capability[]): Snapshot {
  return create(SnapshotSchema, {
    ...snapshot,
    backends: [create(BackendDescriptorSchema, {
      ...snapshot.backends[0]!,
      capabilities: create(CapabilityManifestSchema, {
        schemaVersion: snapshot.backends[0]!.capabilities?.schemaVersion ?? "1",
        revision: snapshot.backends[0]!.capabilities?.revision,
        capabilities: [...values]
      })
    })]
  });
}

function capabilities(input: {
  readonly fast?: boolean;
  readonly plan?: boolean;
  readonly duplicatePermission?: boolean;
}): Capability[] {
  const result = [
    modelCapability(capabilityNames.modelList, { providerAware: true }),
    modelCapability(capabilityNames.modelSwitch, { providerAware: true, switchDuringSession: true }),
    modelCapability(capabilityNames.modelEffort, { providerAware: true, switchDuringSession: true, supportsEffort: true }),
    modelCapability(capabilityNames.modelFastMode, {
      providerAware: true,
      switchDuringSession: true,
      supportsFastMode: input.fast === true
    }, input.fast === true),
    permissionCapability(capabilityNames.permissionModes, [
      PermissionMode.BYPASS_PERMISSIONS,
      PermissionMode.ASK,
      ...(input.duplicatePermission ? [PermissionMode.ASK] : [PermissionMode.AUTO])
    ]),
    permissionCapability(capabilityNames.permissionChange, [], true),
    create(CapabilitySchema, {
      name: capabilityNames.planMode,
      support: input.plan === true ? CapabilitySupport.SUPPORTED : CapabilitySupport.UPSTREAM_MISSING
    })
  ];
  return result;
}

function modelCapability(
  name: string,
  options: { readonly providerAware?: boolean; readonly switchDuringSession?: boolean;
    readonly supportsEffort?: boolean; readonly supportsFastMode?: boolean },
  supported = true
): Capability {
  return create(CapabilitySchema, {
    name,
    support: supported ? CapabilitySupport.SUPPORTED : CapabilitySupport.UPSTREAM_MISSING,
    options: { kind: { case: "model", value: { ...options } } }
  });
}

function permissionCapability(name: string, modes: readonly PermissionMode[], mutableDuringSession = true): Capability {
  return create(CapabilitySchema, {
    name,
    support: CapabilitySupport.SUPPORTED,
    options: { kind: { case: "permission", value: { modes: [...modes], mutableDuringSession } } }
  });
}

function model(
  providerId: string,
  modelId: string,
  displayName: string,
  input: {
    readonly fast?: boolean;
    readonly context?: bigint;
    readonly inputs?: readonly ModelInputModality[];
    readonly outputs?: readonly ModelOutputModality[];
    readonly efforts?: readonly { readonly effortId: string; readonly displayName: string;
      readonly order: number; readonly defaultLevel?: boolean }[];
  } = {}
): ModelDescriptor {
  return create(ModelDescriptorSchema, {
    backendId: "backend",
    key: { providerId, modelId },
    displayName,
    family: "family",
    contextWindowTokens: input.context ?? 64_000n,
    maximumOutputTokens: 8_000n,
    inputModalities: [...(input.inputs ?? [ModelInputModality.TEXT])],
    outputModalities: [...(input.outputs ?? [ModelOutputModality.TEXT])],
    effortLevels: [...(input.efforts ?? [
      { effortId: "low", displayName: "Low", order: 0, defaultLevel: true },
      { effortId: "high", displayName: "High", order: 1 }
    ])],
    supportsFastMode: input.fast === true,
    available: true
  });
}

function provider(providerId: string, displayName: string, ownerManaged = false) {
  return create(ProviderDescriptorSchema, {
    backendId: "backend",
    providerId,
    displayName,
    kind: ownerManaged ? ProviderKind.MANAGED : ProviderKind.SUBSCRIPTION,
    ownerManaged
  });
}

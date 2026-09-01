import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterContext, BlobRef, PromptInput } from "@joko/core";
import {
  ArtifactMaintenance,
  ArtifactStore,
  BackendInstanceRegistry,
  BlobTransferCoordinator,
  ConnectionManager,
  LanDiscoveryService,
  DurableWorkspaceRunCapture,
  HistoryMaintenance,
  OperationalWorkspaceSnapshotRepository,
  OperationalArtifactRepository,
  ScheduleCoordinator,
  SessionHost,
  SessionWorktreeCoordinator,
  WorkspaceChangeSetService,
  WorkspaceService,
  createPublicServer,
  type OrchestratorApplication,
  type OrchestratorConfig
} from "@joko/orchestrator";
import { OperationalStore } from "@joko/store";
import {
  FakeBackendAdapter,
  PI_LIKE_PROFILE,
  type FakeAdapterProfile
} from "@joko/testkit";

import { createE2eClients, type E2eClients, type PairedClient } from "./connect-clients.js";

export type { E2eClients, PairedClient } from "./connect-clients.js";

export interface FixtureOptions {
  readonly rootDirectory?: string;
  readonly profiles?: readonly FakeAdapterProfile[];
  readonly keepRoot?: boolean;
}

export class InstrumentedFakeAdapter extends FakeBackendAdapter {
  compactCalls = 0;
  compactOutcome: "compacted" | "noop" = "compacted";
  exportCalls = 0;
  abortCalls = 0;
  sendCalls: PromptInput[] = [];
  interactionDecisions: string[] = [];

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.sendCalls.push(input);
    if (input.text === "[permission]") {
      const decision = await context.requestInteraction({
        id: `permission-${context.sessionId}-${randomUUID()}`,
        kind: "permission",
        title: "Allow a test write?",
        toolName: "write",
        summary: "Write the conformance fixture.",
        risk: "medium",
        choices: ["allow_once", "deny_once"]
      });
      this.interactionDecisions.push(
        decision.kind === "selected" ? decision.value : decision.kind === "confirmed" ? String(decision.confirmed) : "cancelled"
      );
    }
    await super.send(input, context);
  }

  override async compact(customInstructions: string | undefined, context: AdapterContext): Promise<"compacted" | "noop"> {
    this.compactCalls += 1;
    if (this.compactOutcome === "noop") {
      const compactionId = `e2e-compaction-${randomUUID()}`;
      await context.emit({ type: "compaction", compactionId, state: "started", reason: "fake" });
      await context.emit({ type: "compaction", compactionId, state: "no_op", reason: "fake" });
      return "noop";
    }
    return super.compact(customInstructions, context);
  }

  override async exportSession(context: AdapterContext): Promise<BlobRef> {
    this.exportCalls += 1;
    const sourcePath = join(context.target.workspaceRoot, `.joko-e2e-export-${randomUUID()}.html`);
    await writeFile(sourcePath, `<!doctype html><title>Joko export</title><main>${context.sessionId}</main>`, { mode: 0o600 });
    try {
      return await context.storeArtifact(sourcePath, {
        fileName: `session-${context.sessionId}.html`,
        mimeType: "text/html"
      });
    } finally {
      await rm(sourcePath, { force: true });
    }
  }

  override async abort(context: AdapterContext): Promise<void> {
    this.abortCalls += 1;
    await super.abort(context);
  }
}

class RecordingConnectionManager extends ConnectionManager {
  readonly pairingCodes = new Map<string, string>();

  constructor(store: OperationalStore) {
    super(store);
    this.onPairingIssued((challenge) => {
      this.pairingCodes.set(challenge.id, challenge.code);
    });
  }
}

export class OrchestratorE2eFixture {
  readonly rootDirectory: string;
  readonly workspaceDirectory: string;
  readonly databasePath: string;
  readonly baseUrl: string;
  readonly application: OrchestratorApplication;
  readonly adapters: ReadonlyMap<string, InstrumentedFakeAdapter>;
  readonly targets: ReadonlyMap<string, string>;
  readonly anonymous: E2eClients;
  readonly #server: Awaited<ReturnType<typeof createPublicServer>>;
  readonly #connections: RecordingConnectionManager;
  readonly #cleanupDelayMs: number;
  readonly #removeRootOnClose: boolean;
  #closed = false;

  private constructor(input: {
    rootDirectory: string;
    workspaceDirectory: string;
    databasePath: string;
    baseUrl: string;
    application: OrchestratorApplication;
    adapters: ReadonlyMap<string, InstrumentedFakeAdapter>;
    targets: ReadonlyMap<string, string>;
    server: Awaited<ReturnType<typeof createPublicServer>>;
    connections: RecordingConnectionManager;
    cleanupDelayMs: number;
    removeRootOnClose: boolean;
  }) {
    this.rootDirectory = input.rootDirectory;
    this.workspaceDirectory = input.workspaceDirectory;
    this.databasePath = input.databasePath;
    this.baseUrl = input.baseUrl;
    this.application = input.application;
    this.adapters = input.adapters;
    this.targets = input.targets;
    this.#server = input.server;
    this.#connections = input.connections;
    this.#cleanupDelayMs = input.cleanupDelayMs;
    this.#removeRootOnClose = input.removeRootOnClose;
    this.anonymous = createE2eClients(input.baseUrl);
  }

  static async start(options: FixtureOptions = {}): Promise<OrchestratorE2eFixture> {
    const ownsRoot = options.rootDirectory === undefined;
    const requestedRoot = options.rootDirectory ?? await mkdtemp(join(tmpdir(), "joko-e2e-"));
    const rootDirectory = process.env.GITHUB_ACTIONS === "true"
      ? await realpath(requestedRoot)
      : requestedRoot;
    const workspaceDirectory = join(rootDirectory, "workspace");
    const dataDirectory = join(rootDirectory, "data");
    const artifactDirectory = join(dataDirectory, "artifacts");
    const databasePath = join(dataDirectory, "orchestrator.db");
    await Promise.all([
      mkdir(workspaceDirectory, { recursive: true }),
      mkdir(artifactDirectory, { recursive: true }),
      mkdir(join(dataDirectory, "pi-agent-home"), { recursive: true })
    ]);
    await writeFile(join(workspaceDirectory, "README.md"), "# Joko e2e\n\nneedle from the service workspace\n", { flag: "a" });

    const profiles = (options.profiles ?? [PI_LIKE_PROFILE]).map((profile) => ({
      ...profile,
      streamDelayMs: profile.streamDelayMs ?? 10
    }));
    const adapters = new Map<string, InstrumentedFakeAdapter>();
    const store = new OperationalStore(databasePath);
    const backendInstances = new BackendInstanceRegistry(store);
    await backendInstances.provision(profiles.map((profile) => ({
      instanceId: profile.id,
      adapterKind: "fake",
      displayName: profile.displayName,
      create: () => new InstrumentedFakeAdapter(profile)
    })));
    for (const adapter of backendInstances.availableAdapters()) {
      if (!(adapter instanceof InstrumentedFakeAdapter)) {
        throw new Error("The E2E Backend registry provisioned an unexpected Adapter type.");
      }
      adapters.set(adapter.id, adapter);
    }
    const artifactRepository = new OperationalArtifactRepository(store);
    const artifacts = new ArtifactStore({
      rootDirectory: artifactDirectory,
      repository: artifactRepository,
      ingestRoots: [workspaceDirectory]
    });
    await artifacts.initialize();
    const artifactMaintenance = new ArtifactMaintenance({
      store,
      rootDirectory: artifactDirectory
    });
    await artifactMaintenance.initialize();
    const blobTransfers = new BlobTransferCoordinator(artifacts);
    const workspaces = new WorkspaceService();
    await workspaces.register({
      id: "workspace-main",
      root: workspaceDirectory,
      displayName: "Fixture workspace",
      trusted: true
    });
    const workspaceChanges = new WorkspaceChangeSetService({
      snapshotDirectory: join(dataDirectory, "workspace-snapshots"),
      repository: new OperationalWorkspaceSnapshotRepository(store),
      excludedRoots: [dataDirectory, artifactDirectory, join(dataDirectory, "pi-agent-home")]
    });
    await workspaceChanges.initialize();
    const sessionWorktrees = new SessionWorktreeCoordinator({
      store,
      workspaces,
      storageRoot: join(dataDirectory, "worktrees")
    });
    await sessionWorktrees.initialize();
    const sessionHost = new SessionHost(store, artifacts, backendInstances.availableAdapters(), {
      backendDescriptors: backendInstances.descriptors(),
      workspaceCapture: new DurableWorkspaceRunCapture(store, workspaceChanges),
      worktrees: sessionWorktrees
    });
    await sessionHost.initialize();
    const historyMaintenance = new HistoryMaintenance({
      store,
      activeSessions: {
        prepare: (sessionIds) => sessionHost.prepareHistoryMaintenanceBindings(sessionIds),
        release: (sessionIds) => sessionHost.releaseHistoryMaintenanceSessions(sessionIds)
      },
      externalRecords: workspaceChanges
    });
    const targets = new Map<string, string>();
    for (const profile of profiles) {
      const targetId = `target-${profile.id}`;
      targets.set(profile.id, targetId);
      await sessionHost.registerTarget({
        id: targetId,
        backendId: profile.id,
        displayName: `${profile.displayName} target`,
        workspaceRoot: workspaceDirectory,
        managed: true,
        trusted: true
      }, { workspaceId: "workspace-main" });
    }
    const scheduler = new ScheduleCoordinator(store, sessionHost, { tickMs: 25 });
    scheduler.start();

    const config: OrchestratorConfig = {
      host: "127.0.0.1",
      port: 0,
      internalPort: 4317,
      publicOrigin: "http://127.0.0.1",
      internalOrigin: "http://127.0.0.1:4317",
      dataDirectory,
      databasePath,
      allowInsecureLoopback: true,
      allowInsecureLan: false,
      lanDiscoveryEnabled: false,
      piExecutable: "pi",
      piAgentHome: join(dataDirectory, "pi-agent-home"),
      workspace: {
        id: "workspace-main",
        root: workspaceDirectory,
        displayName: "Fixture workspace",
        trusted: true
      },
      artifactDirectory,
      webDirectory: join(rootDirectory, "web-not-built"),
      corsOrigins: []
    };
    const connections = new RecordingConnectionManager(store);
    connections.openPairingWindow();
    const serverId = "orchestrator-e2e";
    const lanDiscovery = new LanDiscoveryService({
      self: () => ({
        serverId,
        displayName: "Orchestrator E2E",
        origin: config.publicOrigin,
        version: "0.1.0",
        apiVersion: "joko.v1",
        pairingEnabled: connections.pairingEnabled,
        lastSeen: Date.now()
      })
    });
    const restartBackend = async (backendId: string): Promise<void> => {
      const previous = backendInstances.get(backendId);
      await sessionHost.replaceBackendInstance({
        backendId,
        expectedCurrentGeneration: previous.generation,
        perform: (hooks) => backendInstances.replace(backendId, {
          preparePrevious: ({ candidateAdapter, candidateGeneration }) =>
            hooks.preparePrevious(candidateAdapter, candidateGeneration),
          activateCurrent: ({ adapter }) => {
            hooks.activateCurrent();
            adapters.set(backendId, adapter as InstrumentedFakeAdapter);
          }
        })
      });
    };
    const refreshBackendDescriptor = async (backendId: string): Promise<void> => {
      await backendInstances.refresh(backendId);
    };
    const application: OrchestratorApplication = {
      config,
      store,
      connections,
      serverId,
      lanDiscovery,
      artifacts,
      artifactMaintenance,
      historyMaintenance,
      blobTransfers,
      artifactRepository,
      workspaces,
      workspaceChanges,
      sessionWorktrees,
      sessionHost,
      scheduler,
      get adapters() {
        return backendInstances.availableAdapters();
      },
      restartBackend,
      refreshBackendDescriptor,
      browserActivity: [],
      async close() {
        scheduler.stop();
        await lanDiscovery.stop();
        await sessionHost.dispose();
        sessionWorktrees.dispose();
        store.close();
      }
    };
    const server = await createPublicServer(application);
    server.log.level = "silent";
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (address === null || typeof address === "string") throw new Error("Fastify did not expose an ephemeral TCP port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    return new OrchestratorE2eFixture({
      rootDirectory,
      workspaceDirectory,
      databasePath,
      baseUrl,
      application,
      adapters,
      targets,
      server,
      connections,
      cleanupDelayMs: Math.min(250, Math.max(0, ...profiles.map((profile) => profile.streamDelayMs ?? 0)) + 25),
      removeRootOnClose: ownsRoot && options.keepRoot !== true
    });
  }

  clients(authKey: string): E2eClients {
    return createE2eClients(this.baseUrl, authKey);
  }

  async pair(displayName = "E2E client"): Promise<PairedClient> {
    const begun = await this.anonymous.connection.beginPairing({ deviceDisplayName: displayName });
    if (begun.challenge === undefined) throw new Error("Orchestrator did not return a pairing challenge.");
    const completed = await this.anonymous.connection.completePairing({
      challengeId: begun.challenge.challengeId,
      humanCode: this.pairingCode(begun.challenge.challengeId),
      deviceDisplayName: displayName
    });
    const authKey = completed.result?.authKey;
    const connectionId = completed.result?.connection?.connectionId;
    const deviceId = completed.result?.device?.deviceId;
    if (!authKey || !connectionId || !deviceId) throw new Error("Orchestrator did not return the one-time connection credential and Device binding.");
    return { authKey, connectionId, deviceId, clients: this.clients(authKey) };
  }

  pairingCode(challengeId: string): string {
    const code = this.#connections.pairingCodes.get(challengeId);
    if (code === undefined) throw new Error(`The fixture supervisor did not observe pairing challenge ${challengeId}.`);
    return code;
  }

  targetId(backendId?: string): string {
    const id = backendId ?? this.adapters.keys().next().value;
    const target = id === undefined ? undefined : this.targets.get(id);
    if (target === undefined) throw new Error(`No fixture target exists for Backend ${String(id)}.`);
    return target;
  }

  adapter(backendId?: string): InstrumentedFakeAdapter {
    const id = backendId ?? this.adapters.keys().next().value;
    const adapter = id === undefined ? undefined : this.adapters.get(id);
    if (adapter === undefined) throw new Error(`No fixture adapter exists for Backend ${String(id)}.`);
    return adapter;
  }

  async close(options: { readonly removeRoot?: boolean } = {}): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#server.close();
    if (this.#cleanupDelayMs > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.#cleanupDelayMs));
    }
    await this.application.close();
    if (options.removeRoot ?? this.#removeRootOnClose) {
      await rm(this.rootDirectory, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last!, bigintJson)}`);
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

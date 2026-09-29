import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  CapabilitySupport,
  DevicePeerDirectoryKind,
  DeviceKind,
  OperationMutationSchema,
  OperationState,
  TerminalStatus,
  type DevicePeerRouteIdentity
} from "@joko/contracts";
import type {
  AdapterContext,
  BackendAdapter,
  CreateNativeSessionInput,
  NativeSessionBinding,
  PromptInput,
  TargetDescriptor
} from "@joko/core";
import {
  NodeDevicePeerAgentExecutor,
  createNodeDevicePeerAgentRoutePort,
  runNodeDevicePeerAgentRoute,
  type NodeDevicePeerAgentRoutePort,
  type DevicePeerTerminalTransportPort
} from "@joko/device-peer";
import {
  createOrchestratorApplication,
  createPublicServer,
  type OrchestratorApplication,
  type OrchestratorConfig
} from "@joko/orchestrator";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { spawnTerminalHost, terminalEnvironment } from "@joko/tool-terminal";
import { expect, it } from "vitest";

import { createE2eClients, type E2eClients, type PairedClient } from "./connect-clients.js";
import {
  archiveMutation,
  createSessionMutation,
  deleteMutation,
  queueRunIdFrom,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";
import { waitFor } from "./fixture.js";

const BACKEND_IDS = ["pi", "codex", "claude-code"] as const;
const PALETTE = {
  ansiRgb: Array.from({ length: 16 }, (_, index) => index * 0x111111),
  foregroundRgb: 0xffffff,
  backgroundRgb: 0,
  cursorRgb: 0xffffff
};

it("runs a durable two-Device project through public Connect and the shared Node peer agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-device-peer-product-e2e-"));
  const peerRoot = join(root, "peer-device");
  const existingProject = join(peerRoot, "existing-project");
  const createdProject = join(peerRoot, "created-project");
  const recentPath = join(peerRoot, "private", "recent-directories.json");
  await Promise.all([
    mkdir(join(existingProject, "known-child"), { recursive: true }),
    mkdir(dirname(recentPath), { recursive: true })
  ]);

  let product: ProductFixture | undefined;
  let agent: RunningPeerAgent | undefined;
  try {
    product = await ProductFixture.start(root);
    const firstHarnesses = installPeerBackedTestAdapters(product.application);
    const controller = await product.pair({
      name: "Peer controller",
      kind: DeviceKind.DESKTOP,
      platform: "windows"
    });
    const target = await product.pair({
      name: "Peer service",
      kind: DeviceKind.SERVICE,
      platform: process.platform
    });

    const connectionBeforeRoute = product.application.store.getConnection(target.connectionId);
    const connectionSeenBeforeRoute = connectionBeforeRoute.lastSeenAt ?? connectionBeforeRoute.pairedAt;
    agent = await RunningPeerAgent.start({
      product,
      target,
      recentPath,
      initialRecentDirectory: existingProject
    });
    await waitFor(
      () => Promise.resolve(product!.application.store.getConnection(target.connectionId).lastSeenAt ?? 0),
      lastSeenAt => lastSeenAt > connectionSeenBeforeRoute,
      "target agent heartbeat before authorization"
    );
    expect((await controller.clients.devicePeer.listDevicePeers({})).peers).toEqual([]);
    expect((await target.clients.devicePeer.listDevicePeers({})).peers).toEqual([]);
    await authorizePeer(controller, target);

    let firstPeer: Awaited<ReturnType<typeof waitForPeer>>;
    try {
      firstPeer = await waitForPeer(controller.clients, target.deviceId);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Route observation: ${JSON.stringify(agent.observation())}.`,
        { cause: error }
      );
    }
    const firstRoute = requiredRoute(firstPeer.route);
    expect(firstPeer).toMatchObject({
      displayName: "Peer service",
      kind: DeviceKind.SERVICE,
      platform: process.platform
    });

    const recent = await controller.clients.devicePeer.listDevicePeerRecentDirectories({ peer: firstRoute });
    expect(recent.directories).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: await realpath(existingProject) })
    ]));

    const home = await controller.clients.devicePeer.listDevicePeerDirectories({ peer: firstRoute, path: "" });
    expect(home.path).toBe(await realpath(homedir()));
    expect(home.parentPath).toBe(dirname(home.path));
    const children = await controller.clients.devicePeer.listDevicePeerDirectories({
      peer: firstRoute,
      path: existingProject
    });
    expect(children).toMatchObject({
      path: await realpath(existingProject),
      parentPath: await realpath(peerRoot),
      directories: [expect.objectContaining({ name: "known-child", path: await realpath(join(existingProject, "known-child")) })]
    });
    const missing = await controller.clients.devicePeer.inspectDevicePeerDirectory({
      peer: firstRoute,
      path: createdProject
    });
    expect(missing.kind).toBe(DevicePeerDirectoryKind.MISSING);

    const targetsBefore = (await controller.clients.target.listTargets({})).targets.length;
    const workspacesBefore = product.application.workspaces.listRegistrations().length;
    const refused = await submit(
      controller.clients.operation,
      controller.connectionId,
      createPeerTargetMutation("pi", "Peer Pi project", firstRoute, createdProject, false)
    );
    expect(refused.state).toBe(OperationState.FAILED);
    await expect(stat(createdProject)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await controller.clients.target.listTargets({})).targets).toHaveLength(targetsBefore);
    expect(product.application.workspaces.listRegistrations()).toHaveLength(workspacesBefore);

    const createdTargets = new Map<string, { targetId: string; workspaceId: string }>();
    for (const [index, backendId] of BACKEND_IDS.entries()) {
      const mutation = createPeerTargetMutation(
        backendId,
        `Peer ${backendId} project`,
        firstRoute,
        createdProject,
        index === 0
      );
      const operationId = index === 0 ? "device-peer-create-target-replay" : undefined;
      const operation = await submit(
        controller.clients.operation,
        controller.connectionId,
        mutation,
        operationId
      );
      expect(operation.state).toBe(OperationState.SUCCEEDED);
      if (operation.result?.payload.case !== "target") {
        throw new Error(`Device peer ${backendId} creation returned no Target.`);
      }
      const value = operation.result.payload.value;
      expect(value.location?.kind).toMatchObject({
        case: "devicePeer",
        value: {
          controllerDeviceId: controller.deviceId,
          targetDeviceId: target.deviceId,
          workspaceRootDisplay: await realpath(createdProject)
        }
      });
      createdTargets.set(backendId, { targetId: value.targetId, workspaceId: value.workspaceId });
      expect(product.application.store.getTarget(value.targetId).descriptor.remoteWorkspace).toEqual({
        kind: "device_peer",
        controllerDeviceId: controller.deviceId,
        targetDeviceId: target.deviceId,
        workspaceRoot: await realpath(createdProject)
      });
      if (index === 0) {
        const targetCount = (await controller.clients.target.listTargets({})).targets.length;
        const workspaceCount = product.application.workspaces.listRegistrations().length;
        const mkdirCount = agent.observation().inbound.filter(frame => frame === "command:createDirectory").length;
        const replay = await submit(
          controller.clients.operation,
          controller.connectionId,
          mutation,
          operationId
        );
        expect(replay.state).toBe(OperationState.SUCCEEDED);
        expect(replay.result?.payload).toMatchObject({
          case: "target",
          value: { targetId: value.targetId, workspaceId: value.workspaceId }
        });
        expect((await controller.clients.target.listTargets({})).targets).toHaveLength(targetCount);
        expect(product.application.workspaces.listRegistrations()).toHaveLength(workspaceCount);
        expect(agent.observation().inbound.filter(frame => frame === "command:createDirectory")).toHaveLength(mkdirCount);
      }
    }
    expect((await controller.clients.target.listTargets({})).targets).toHaveLength(targetsBefore + BACKEND_IDS.length);
    expect(product.application.workspaces.listRegistrations()).toHaveLength(workspacesBefore + BACKEND_IDS.length);

    const marker = "shared Node peer files reached the selected Device";
    await writeFile(join(createdProject, "peer-marker.txt"), `${marker}\n`, "utf8");
    const piTarget = createdTargets.get("pi")!;
    const listed = await controller.clients.workspace.listWorkspaceEntries({ workspaceId: piTarget.workspaceId });
    expect(listed.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "peer-marker.txt" })
    ]));
    const preview = await controller.clients.workspace.readWorkspaceFile({
      workspaceId: piTarget.workspaceId,
      relativePath: "peer-marker.txt",
      maximumBytes: 1024n
    });
    expect(preview.preview?.content).toMatchObject({
      case: "text",
      value: expect.objectContaining({ utf8Text: expect.stringContaining(marker) })
    });

    const sessions = new Map<string, string>();
    for (const backendId of BACKEND_IDS) {
      const targetBinding = createdTargets.get(backendId)!;
      const createdSession = await submit(
        controller.clients.operation,
        controller.connectionId,
        createSessionMutation({ backendId, targetId: targetBinding.targetId, displayName: `${backendId} peer task` })
      );
      if (createdSession.state !== OperationState.SUCCEEDED) {
        throw new Error(`Device peer ${backendId} Session creation failed: ${JSON.stringify(
          createdSession,
          (_key, value) => typeof value === "bigint" ? value.toString() : value
        )}.`);
      }
      const sessionId = sessionIdFrom(createdSession);
      sessions.set(backendId, sessionId);
      expect(firstHarnesses.get(backendId)?.probes).toEqual(expect.arrayContaining([
        expect.objectContaining({ backendId, phase: "create", cwd: await realpath(createdProject), marker })
      ]));
      const accepted = await submit(
        controller.clients.operation,
        controller.connectionId,
        sendInputMutation(
          sessionId,
          BigInt(product.application.store.getSession(sessionId).descriptor.binding.generation),
          `first peer input for ${backendId}`
        )
      );
      expect(accepted.state).toBe(OperationState.SUCCEEDED);
      const runId = queueRunIdFrom(accepted);
      const runState = await waitFor(
        async () => product!.application.store.getRun(runId).descriptor.state,
        state => state === "completed" || state === "failed",
        `${backendId} Device peer first input`
      );
      if (runState === "failed") {
        throw new Error(`Device peer ${backendId} first input failed: ${JSON.stringify(
          product.application.store.getRun(runId),
          (_key, value) => typeof value === "bigint" ? value.toString() : value
        )}.`);
      }
      expect(firstHarnesses.get(backendId)?.probes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          backendId,
          phase: "send",
          cwd: await realpath(createdProject),
          marker
        })
      ]));
    }

    const recentAfterProcess = await controller.clients.devicePeer.listDevicePeerRecentDirectories({ peer: firstRoute });
    expect(recentAfterProcess.directories).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: await realpath(createdProject) })
    ]));

    const piSessionId = sessions.get("pi")!;
    const terminalCapabilities = await controller.clients.terminal.getTerminalCapabilities({ sessionId: piSessionId });
    expect(terminalCapabilities.support).toBe(CapabilitySupport.SUPPORTED);
    const createdTerminal = await controller.clients.terminal.createTerminal({
      sessionId: piSessionId,
      requestId: randomUUID(),
      columns: 90,
      rows: 30,
      initialPalette: PALETTE
    });
    expect(createdTerminal.terminal).toMatchObject({ status: TerminalStatus.RUNNING, cwd: await realpath(createdProject) });
    const terminal = createdTerminal.terminal!;
    const appearance = { viewId: randomUUID(), viewRevision: 1n, palette: PALETTE };
    const watchAbort = new AbortController();
    const watch = controller.clients.terminal.watchTerminal({
      sessionId: piSessionId,
      terminalId: terminal.id,
      generation: terminal.generation,
      appearance
    }, { signal: watchAbort.signal })[Symbol.asyncIterator]();
    const checkpoint = await watch.next();
    expect(checkpoint.done).toBe(false);
    const focused = await controller.clients.terminal.updateTerminalAppearance({
      sessionId: piSessionId,
      terminalId: terminal.id,
      generation: terminal.generation,
      appearance: { ...appearance, viewRevision: 2n },
      claimFocus: true,
      expectedAppearanceRevision: checkpoint.value!.appearanceRevision
    });
    expect(focused.accepted).toBe(true);
    await controller.clients.terminal.writeTerminal({
      sessionId: piSessionId,
      terminalId: terminal.id,
      generation: terminal.generation,
      writerId: appearance.viewId,
      inputSequence: 1n,
      data: `echo PEER_TERMINAL${process.platform === "win32" ? "\r\n" : "\n"}`
    });
    await waitFor(
      async () => (await controller.clients.terminal.getTerminal({
        sessionId: piSessionId,
        terminalId: terminal.id,
        generation: terminal.generation
      })).serialized,
      screen => screen.includes("PEER_TERMINAL"),
      "Device peer terminal output"
    );
    watchAbort.abort();
    await watch.return?.();
    await controller.clients.terminal.closeTerminal({
      sessionId: piSessionId,
      terminalId: terminal.id,
      generation: terminal.generation
    });

    await submit(target.clients.operation, target.connectionId, create(OperationMutationSchema, {
      payload: { case: "setDeviceRemoteControlEnabled", value: { enabled: false } }
    }));
    await expect(controller.clients.devicePeer.listDevicePeerRecentDirectories({ peer: firstRoute }))
      .rejects.toMatchObject({ code: Code.Aborted });
    await expect(controller.clients.workspace.readWorkspaceFile({
      workspaceId: piTarget.workspaceId,
      relativePath: "peer-marker.txt",
      maximumBytes: 1024n
    })).rejects.toMatchObject({ code: Code.PermissionDenied });

    await submit(target.clients.operation, target.connectionId, create(OperationMutationSchema, {
      payload: { case: "setDeviceRemoteControlEnabled", value: { enabled: true } }
    }));
    const peerAfterReauthorization = await waitForPeer(controller.clients, target.deviceId);
    const firstTargetRevision = firstRoute.targetDeviceRevision?.value;
    const reauthorizedTargetRevision = peerAfterReauthorization.route?.targetDeviceRevision?.value;
    if (firstTargetRevision === undefined || reauthorizedTargetRevision === undefined) {
      throw new Error("Device peer route omitted its target revision.");
    }
    expect(reauthorizedTargetRevision).not.toBe(firstTargetRevision);

    await agent.stop();
    agent = undefined;
    await waitFor(
      async () => (await controller.clients.devicePeer.listDevicePeers({})).peers,
      peers => peers.length === 0,
      "retired Device peer route"
    );
    agent = await RunningPeerAgent.start({ product, target, recentPath });
    const rotatedPeer = await waitForPeer(controller.clients, target.deviceId);
    const rotatedRoute = requiredRoute(rotatedPeer.route);
    expect(rotatedRoute.routeGeneration).not.toBe(peerAfterReauthorization.route?.routeGeneration);
    await expect(controller.clients.devicePeer.inspectDevicePeerDirectory({
      peer: requiredRoute(peerAfterReauthorization.route),
      path: createdProject
    })).rejects.toMatchObject({ code: Code.Unavailable });
    expect((await controller.clients.workspace.readWorkspaceFile({
      workspaceId: piTarget.workspaceId,
      relativePath: "peer-marker.txt",
      maximumBytes: 1024n
    })).preview?.content).toMatchObject({ case: "text" });

    const archivedPiSessionId = sessions.get("pi")!;
    const archived = await submit(
      controller.clients.operation,
      controller.connectionId,
      archiveMutation(archivedPiSessionId, true)
    );
    expect(archived.state).toBe(OperationState.SUCCEEDED);
    for (const backendId of ["codex", "claude-code"] as const) {
      const deleted = await submit(
        controller.clients.operation,
        controller.connectionId,
        deleteMutation(sessions.get(backendId)!)
      );
      expect(deleted.state).toBe(OperationState.SUCCEEDED);
    }
    await agent.stop();
    agent = undefined;
    await product.close();
    product = undefined;

    product = await ProductFixture.start(root);
    const restartedHarnesses = installPeerBackedTestAdapters(product.application);
    const restartedController = pairedAt(product.baseUrl, controller);
    const restartedTarget = pairedAt(product.baseUrl, target);
    agent = await RunningPeerAgent.start({ product, target: restartedTarget, recentPath });
    const restartedPeer = await waitForPeer(restartedController.clients, target.deviceId);
    const restartedRoute = requiredRoute(restartedPeer.route);
    expect(restartedRoute).toMatchObject({
      targetDeviceId: target.deviceId,
      relationId: rotatedRoute.relationId,
      targetDeviceRevision: rotatedRoute.targetDeviceRevision,
      relationRevision: rotatedRoute.relationRevision
    });
    expect(restartedRoute.routeGeneration).not.toBe(rotatedRoute.routeGeneration);
    await expect(restartedController.clients.devicePeer.inspectDevicePeerDirectory({
      peer: rotatedRoute,
      path: createdProject
    })).rejects.toMatchObject({ code: Code.Unavailable });
    await expect(restartedController.clients.devicePeer.inspectDevicePeerDirectory({
      peer: restartedRoute,
      path: createdProject
    })).resolves.toMatchObject({ kind: DevicePeerDirectoryKind.DIRECTORY });
    const restoredTarget = await restartedController.clients.target.getTarget({ targetId: piTarget.targetId });
    expect(restoredTarget.target?.location?.kind).toMatchObject({
      case: "devicePeer",
      value: {
        controllerDeviceId: controller.deviceId,
        targetDeviceId: target.deviceId,
        workspaceRootDisplay: await realpath(createdProject)
      }
    });
    const restoredPreview = await restartedController.clients.workspace.readWorkspaceFile({
      workspaceId: piTarget.workspaceId,
      relativePath: "peer-marker.txt",
      maximumBytes: 1024n
    });
    expect(restoredPreview.preview?.content).toMatchObject({
      case: "text",
      value: expect.objectContaining({ utf8Text: expect.stringContaining(marker) })
    });
    const restoredSession = product.application.store.getSession(archivedPiSessionId).descriptor;
    expect(restoredSession).toMatchObject({
      id: archivedPiSessionId,
      targetId: piTarget.targetId,
      archived: true,
      remoteWorkspace: {
        kind: "device_peer",
        controllerDeviceId: controller.deviceId,
        targetDeviceId: target.deviceId,
        workspaceRoot: await realpath(createdProject)
      }
    });
    const unarchived = await submit(
      restartedController.clients.operation,
      controller.connectionId,
      archiveMutation(archivedPiSessionId, false)
    );
    expect(unarchived.state).toBe(OperationState.SUCCEEDED);
    const restoredInput = await submit(
      restartedController.clients.operation,
      controller.connectionId,
      sendInputMutation(
        archivedPiSessionId,
        BigInt(product.application.store.getSession(archivedPiSessionId).descriptor.binding.generation),
        "input after durable peer binding recovery"
      )
    );
    const restoredRunId = queueRunIdFrom(restoredInput);
    const restoredRunState = await waitFor(
      async () => product!.application.store.getRun(restoredRunId).descriptor.state,
      state => state === "completed" || state === "failed",
      "post-restart Device peer input"
    );
    if (restoredRunState === "failed") {
      throw new Error(`Post-restart Device peer input failed: ${JSON.stringify(
        product.application.store.getRun(restoredRunId),
        (_key, value) => typeof value === "bigint" ? value.toString() : value
      )}.`);
    }
    expect(restartedHarnesses.get("pi")?.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "send", marker, cwd: await realpath(createdProject) })
    ]));
  } finally {
    await agent?.stop().catch(() => undefined);
    await product?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 120_000);

class ProductFixture {
  readonly root: string;
  readonly baseUrl: string;
  readonly application: OrchestratorApplication;
  readonly anonymous: E2eClients;
  readonly #server: Awaited<ReturnType<typeof createPublicServer>>;
  readonly #pairingCodes: ReadonlyMap<string, string>;
  readonly #removePairingListener: () => void;
  #closed = false;

  private constructor(input: {
    root: string;
    baseUrl: string;
    application: OrchestratorApplication;
    server: Awaited<ReturnType<typeof createPublicServer>>;
    pairingCodes: ReadonlyMap<string, string>;
    removePairingListener: () => void;
  }) {
    this.root = input.root;
    this.baseUrl = input.baseUrl;
    this.application = input.application;
    this.#server = input.server;
    this.#pairingCodes = input.pairingCodes;
    this.#removePairingListener = input.removePairingListener;
    this.anonymous = createE2eClients(input.baseUrl, undefined, 30_000);
  }

  static async start(root: string): Promise<ProductFixture> {
    const workspace = join(root, "controller-workspace");
    const dataDirectory = join(root, "controller-data");
    await mkdir(workspace, { recursive: true });
    const config: OrchestratorConfig = {
      host: "127.0.0.1",
      port: 0,
      internalPort: 4317,
      publicOrigin: "http://127.0.0.1",
      internalOrigin: "http://127.0.0.1:4317",
      dataDirectory,
      databasePath: join(dataDirectory, "orchestrator.db"),
      allowInsecureLoopback: true,
      allowInsecureLan: false,
      lanDiscoveryEnabled: false,
      piAgentHome: join(dataDirectory, "pi-agent-home"),
      workspace: {
        id: "workspace-controller",
        root: workspace,
        displayName: "Controller workspace",
        trusted: true
      },
      artifactDirectory: join(dataDirectory, "artifacts"),
      webDirectory: join(root, "web-not-used"),
      corsOrigins: []
    };
    const application = await createOrchestratorApplication(config);
    const pairingCodes = new Map<string, string>();
    const removePairingListener = application.connections.onPairingIssued(challenge => {
      pairingCodes.set(challenge.id, challenge.code);
    });
    application.connections.openPairingWindow();
    const server = await createPublicServer(application);
    server.log.level = "silent";
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    return new ProductFixture({ root, baseUrl, application, server, pairingCodes, removePairingListener });
  }

  async pair(input: { name: string; kind: DeviceKind; platform: string }): Promise<PairedClient> {
    const begun = await this.anonymous.connection.beginPairing({
      deviceDisplayName: input.name,
      deviceKind: input.kind,
      platform: input.platform,
      appVersion: "device-peer-e2e"
    });
    const challenge = begun.challenge;
    if (challenge === undefined) throw new Error("Device peer pairing returned no challenge.");
    const code = this.#pairingCodes.get(challenge.challengeId);
    if (code === undefined) throw new Error("Device peer pairing code was not observed.");
    const completed = await this.anonymous.connection.completePairing({
      challengeId: challenge.challengeId,
      humanCode: code,
      deviceDisplayName: input.name,
      deviceKind: input.kind,
      platform: input.platform,
      appVersion: "device-peer-e2e"
    });
    const authKey = completed.result?.authKey;
    const connectionId = completed.result?.connection?.connectionId;
    const deviceId = completed.result?.device?.deviceId;
    if (!authKey || !connectionId || !deviceId) throw new Error("Device peer pairing returned no identity.");
    return {
      authKey,
      connectionId,
      deviceId,
      clients: createE2eClients(this.baseUrl, authKey, 30_000)
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#removePairingListener();
    await this.#server.close();
    await this.application.close();
  }
}

class RunningPeerAgent {
  readonly #controller: AbortController;
  readonly #settled: Promise<Error | undefined>;
  readonly #observation: PeerRouteObservation;

  private constructor(
    controller: AbortController,
    settled: Promise<Error | undefined>,
    observation: PeerRouteObservation
  ) {
    this.#controller = controller;
    this.#settled = settled;
    this.#observation = observation;
  }

  static async start(input: {
    product: ProductFixture;
    target: PairedClient;
    recentPath: string;
    initialRecentDirectory?: string;
  }): Promise<RunningPeerAgent> {
    const executor = new NodeDevicePeerAgentExecutor({
      recentDirectoriesPath: input.recentPath,
      terminals: terminalPort()
    });
    if (input.initialRecentDirectory !== undefined) {
      await executor.recordRecentDirectory(await realpath(input.initialRecentDirectory));
    }
    const controller = new AbortController();
    const observation: PeerRouteObservation = { outbound: [], inbound: [], closed: false };
    const routePort = createNodeDevicePeerAgentRoutePort();
    const settled = runNodeDevicePeerAgentRoute({
      connection: {
        credentialId: input.target.connectionId,
        deviceId: input.target.deviceId,
        serverId: input.product.application.serverId,
        origin: input.product.baseUrl,
        expectedDeviceKind: DeviceKind.SERVICE
      },
      executor,
      port: observingRoutePort(observation, routePort),
      signal: controller.signal,
      heartbeatIntervalMs: 15_000,
      readAuthKey: credentialId => Promise.resolve(
        credentialId === input.target.connectionId ? input.target.authKey : undefined
      ),
      isAuthorityCurrent: candidate => !controller.signal.aborted
        && candidate.credentialId === input.target.connectionId
        && candidate.deviceId === input.target.deviceId
        && candidate.serverId === input.product.application.serverId
        && candidate.origin === input.product.baseUrl
        && candidate.expectedDeviceKind === DeviceKind.SERVICE
    }).then(
      () => undefined,
      (error: unknown) => error instanceof Error ? error : new Error("Device peer agent route failed.")
    );
    return new RunningPeerAgent(controller, settled, observation);
  }

  async stop(): Promise<void> {
    this.#controller.abort();
    const failure = await this.#settled;
    if (failure !== undefined) {
      throw new Error(
        `${failure.message} Route observation: ${JSON.stringify(this.#observation)}.`,
        { cause: failure }
      );
    }
  }

  observation(): PeerRouteObservation {
    return {
      outbound: [...this.#observation.outbound],
      inbound: [...this.#observation.inbound],
      closed: this.#observation.closed,
      ...(this.#observation.failure === undefined ? {} : { failure: this.#observation.failure })
    };
  }
}

interface PeerRouteObservation {
  readonly outbound: string[];
  readonly inbound: string[];
  closed: boolean;
  failure?: string;
}

function observingRoutePort(
  observation: PeerRouteObservation,
  base: NodeDevicePeerAgentRoutePort
): NodeDevicePeerAgentRoutePort {
  return {
    readServerId: (origin, signal) => base.readServerId(origin, signal),
    verifyIdentity: (origin, authKey, connection, signal) =>
      base.verifyIdentity(origin, authKey, connection, signal),
    open(origin, authKey, requests, signal) {
      const observedRequests = (async function* () {
        for await (const request of requests) {
          observation.outbound.push(request.payload.case ?? "empty");
          yield request;
        }
      })();
      const responses = base.open(
        origin,
        authKey,
        observedRequests,
        signal
      );
      return (async function* () {
        try {
          for await (const response of responses) {
            const detail = response.payload.case === "retire"
              ? `retire:${response.payload.value.reason}`
              : response.payload.case === "command"
                ? `command:${response.payload.value.action.case ?? "empty"}`
              : response.payload.case ?? "empty";
            observation.inbound.push(detail);
            yield response;
          }
        } catch (error) {
          observation.failure = error instanceof Error
            ? `${error.name}: ${error.message}; cause=${error.cause instanceof Error
              ? `${error.cause.name}: ${error.cause.message}`
              : String(error.cause)}`
            : String(error);
          throw error;
        } finally {
          observation.closed = true;
        }
      })();
    }
  };
}

interface PeerProbe {
  readonly backendId: string;
  readonly phase: "create" | "send";
  readonly cwd: string;
  readonly marker: string;
}

class PeerBackedTestAdapter extends FakeBackendAdapter {
  readonly probes: PeerProbe[] = [];
  readonly #remoteExecution: NonNullable<OrchestratorApplication["remoteExecution"]>;

  constructor(backendId: string, remoteExecution: NonNullable<OrchestratorApplication["remoteExecution"]>) {
    super({ ...PI_LIKE_PROFILE, id: backendId, displayName: `${backendId} peer test Backend`, streamDelayMs: 0 });
    this.#remoteExecution = remoteExecution;
  }

  override async validateTarget(target: TargetDescriptor): Promise<void> {
    await super.validateTarget(target);
    if (target.remoteWorkspace?.kind !== "device_peer") {
      throw new Error("The controlled peer Backend requires a Device peer Target.");
    }
  }

  override async createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding> {
    await this.#probe(input.target, "create", context.signal);
    return super.createSession(input, context);
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    await this.#probe(context.target, "send", context.signal);
    await super.send(input, context);
  }

  async #probe(target: TargetDescriptor, phase: PeerProbe["phase"], signal: AbortSignal): Promise<void> {
    const binding = target.remoteWorkspace;
    if (binding?.kind !== "device_peer") throw new Error("The controlled peer Backend lost its Device binding.");
    const authority = await this.#remoteExecution.workspace(binding, signal);
    const paths = authority.pathStyle === "win32" ? win32 : posix;
    const markerPath = paths.join(binding.workspaceRoot, "peer-marker.txt");
    const marker = new TextDecoder("utf-8", { fatal: true }).decode(await authority.files.read({
      path: markerPath,
      maximumBytes: 1024,
      signal
    })).trim();
    authority.assertCurrent();
    const child = await authority.processes.open({
      executable: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');setTimeout(()=>process.stdout.write(JSON.stringify({backend:process.argv[1],cwd:process.cwd(),marker:fs.readFileSync('peer-marker.txt','utf8').trim()})),20)",
        this.id
      ],
      cwd: binding.workspaceRoot,
      signal
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", value => stdout.push(Buffer.from(value)));
    child.stderr.on("data", value => stderr.push(Buffer.from(value)));
    child.stdin.end();
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit({ code: child.exitCode, signal: child.signalCode });
        return;
      }
      child.once("error", rejectExit);
      child.once("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
    });
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`The controlled peer process failed: ${Buffer.concat(stderr).toString("utf8")}`);
    }
    const output = JSON.parse(Buffer.concat(stdout).toString("utf8")) as {
      readonly backend?: unknown;
      readonly cwd?: unknown;
      readonly marker?: unknown;
    };
    if (output.backend !== this.id || output.cwd !== binding.workspaceRoot || output.marker !== marker) {
      throw new Error("The controlled peer process returned the wrong Device workspace identity.");
    }
    authority.assertCurrent();
    this.probes.push({ backendId: this.id, phase, cwd: output.cwd, marker: output.marker });
  }
}

function installPeerBackedTestAdapters(application: OrchestratorApplication): Map<string, PeerBackedTestAdapter> {
  const remoteExecution = application.remoteExecution;
  if (remoteExecution === undefined) throw new Error("Production composition exposed no remote execution router.");
  const harnesses = new Map<string, PeerBackedTestAdapter>();
  const methods = [
    "validateTarget",
    "createSession",
    "resumeSession",
    "inspectSession",
    "detachSession",
    "closeSession",
    "deleteSession",
    "supportsDetachedSessionDeletion",
    "send",
    "abort",
    "setModel",
    "setEffort",
    "setFastMode",
    "setPermissionMode",
    "setPlanMode",
    "compact",
    "setAutoCompaction",
    "setAutoRetry",
    "abortRetry",
    "exportSession",
    "getTree",
    "navigateTree",
    "fork",
    "clone",
    "rebuildContext",
    "resetContext",
    "setName",
    "getCommands",
    "getResources",
    "executeUserShell",
    "abortUserShell"
  ] as const;
  const disabledNativeShortcuts = [
    "dispatchDuringCompaction",
    "sendWithDurableNativeDispatchFence",
    "setPolicySnapshot",
    "setExtraDirectories",
    "getRuntimeTools",
    "getNativeHistoryProjection",
    "nativeUserEntryIdForOperation"
  ] as const;
  for (const backendId of BACKEND_IDS) {
    const adapter = application.adapters.find(candidate => candidate.id === backendId);
    if (adapter === undefined) throw new Error(`Production composition exposed no ${backendId} Backend.`);
    const harness = new PeerBackedTestAdapter(backendId, remoteExecution);
    const source = harness as unknown as Record<string, unknown>;
    for (const methodName of methods) {
      const method = source[methodName];
      if (typeof method !== "function") throw new Error(`Peer test Backend is missing ${methodName}.`);
      Object.defineProperty(adapter, methodName, {
        configurable: true,
        value: method.bind(harness)
      });
    }
    // Production adapters expose optional native-only shortcuts that require
    // their real local runtime. This controlled E2E seam disables only those
    // shortcuts so ordinary input uses the peer-probing fake runtime methods.
    for (const methodName of disabledNativeShortcuts) {
      Object.defineProperty(adapter, methodName, { configurable: true, value: undefined });
    }
    const current = application.store.getBackend(backendId).descriptor;
    const providerIds = [...new Set(harness.profile.models.map(model => model.providerId))];
    application.store.upsertBackend({
      ...current,
      displayName: harness.profile.displayName,
      health: "healthy",
      installationState: "installed",
      authenticationState: "not_required",
      capabilities: new Map(harness.profile.capabilities.map(capability => [capability.key, capability])),
      providers: providerIds.map(providerId => ({
        providerId,
        displayName: providerId,
        api: harness.profile.models.find(model => model.providerId === providerId)!.api,
        authenticationState: "not_required",
        loginMethods: [],
        supportsLogin: false,
        supportsLogout: false,
        supportsRefresh: false,
        supportsModelRefresh: false
      })),
      models: harness.profile.models,
      tools: harness.profile.tools,
      diagnostics: []
    });
    harnesses.set(backendId, harness);
  }
  return harnesses;
}

async function authorizePeer(controller: PairedClient, target: PairedClient): Promise<void> {
  expect((await submit(controller.clients.operation, controller.connectionId, create(OperationMutationSchema, {
    payload: {
      case: "setDeviceControlTargetEnabled",
      value: { targetDeviceId: target.deviceId, enabled: true }
    }
  }))).state).toBe(OperationState.SUCCEEDED);
  expect((await submit(target.clients.operation, target.connectionId, create(OperationMutationSchema, {
    payload: { case: "setDeviceRemoteControlEnabled", value: { enabled: true } }
  }))).state).toBe(OperationState.SUCCEEDED);
  expect((await submit(target.clients.operation, target.connectionId, create(OperationMutationSchema, {
    payload: {
      case: "setDeviceControllerAllowed",
      value: { controllerDeviceId: controller.deviceId, allowed: true }
    }
  }))).state).toBe(OperationState.SUCCEEDED);
}

function createPeerTargetMutation(
  backendId: string,
  displayName: string,
  peer: DevicePeerRouteIdentity,
  workspacePath: string,
  createIfMissing: boolean
) {
  return create(OperationMutationSchema, {
    payload: {
      case: "createDevicePeerTarget",
      value: { backendId, displayName, peer, workspacePath, createIfMissing }
    }
  });
}

async function waitForPeer(clients: E2eClients, targetDeviceId: string) {
  const response = await waitFor(
    () => clients.devicePeer.listDevicePeers({}),
    value => value.peers.some(peer => peer.route?.targetDeviceId === targetDeviceId),
    "live Device peer route",
    15_000
  );
  return response.peers.find(peer => peer.route?.targetDeviceId === targetDeviceId)!;
}

function requiredRoute(route: DevicePeerRouteIdentity | undefined): DevicePeerRouteIdentity {
  if (route === undefined) throw new Error("Device peer projection returned no route identity.");
  return route;
}

function terminalPort(): DevicePeerTerminalTransportPort {
  const environment = Object.freeze(terminalEnvironment(process.env));
  const port: DevicePeerTerminalTransportPort = {
    async open(request) {
      const terminal = await spawnTerminalHost(request.executable, [...request.args], {
      cwd: request.cwd,
      cols: request.cols,
      rows: request.rows,
      env: environment
      }, request.signal);
      return {
        pid: terminal.pid,
        onData: listener => terminal.onData(listener),
        onExit: listener => terminal.onExit(listener),
        write: async data => { await terminal.write(data); },
        resize: async (cols, rows) => { await terminal.resize(cols, rows); },
        kill: async () => { await terminal.kill(); },
        pause: () => terminal.pause(),
        resume: () => terminal.resume()
      };
    }
  };
  return Object.freeze(port);
}

function pairedAt(baseUrl: string, paired: PairedClient): PairedClient {
  return {
    ...paired,
    clients: createE2eClients(baseUrl, paired.authKey, 30_000)
  };
}

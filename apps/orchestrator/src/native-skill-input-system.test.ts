import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, Code } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import * as contract from "@joko/contracts";
import { CodexBackendAdapter, AppServerHost } from "@joko/adapter-codex";
import { FakeCodexAppServer } from "@joko/adapter-codex/testing";
import { OperationalStore } from "@joko/store";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import type { OrchestratorApplication } from "./application.js";
import { ConnectionManager } from "./connection-manager.js";
import { PiResourceManager } from "./resource-manager.js";
import { createPublicServer } from "./server.js";
import { SessionHost } from "./session-host.js";
import { mkdtemp } from "./test-paths.js";

const serialized = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === "bigint" ? item.toString(10) : item);

describe("approved native skill input composition", () => {
  it.each([
    { journey: "an explicit resource", text: "Use @Public report", displayText: "@Public report", start: 4, end: 18, nativeText: "Use @Public report" },
    { journey: "a selected slash Skill", text: "/native-report Produce weekly report", displayText: "/native-report", start: 0, end: 14, nativeText: "Produce weekly report" }
  ])("dispatches $journey through authenticated durable Queue ownership without publishing private content", async ({ journey, text, displayText, start, end, nativeText }) => {
    const root = await mkdtemp(join(tmpdir(), "joko-native-skill-input-"));
    const database = join(root, "store.db");
    const store = new OperationalStore(database);
    const resources = new PiResourceManager({ store, managedRoot: join(root, "resources") });
    const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"),
      repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
    await artifacts.initialize();
    const fake = new FakeCodexAppServer();
    let mountedPath: string | undefined;
    let dispatchWitness: { queueItemId: string; runId: string; attemptId: string } | undefined;
    const nativeHost = new AppServerHost({ transportFactory: () => {
      const transport = fake.createTransport(), request = transport.request.bind(transport);
      transport.request = async (method, params, options) => {
        const record = params !== null && typeof params === "object" && !Array.isArray(params) ? params : {};
        if (method === "thread/start") {
          const config = record["config"];
          if (config !== null && typeof config === "object" && !Array.isArray(config)) {
            const entries = config["skills.config"];
            if (Array.isArray(entries)) for (const entry of entries) {
              if (entry !== null && typeof entry === "object" && !Array.isArray(entry)
                && entry["enabled"] === true && typeof entry["path"] === "string") {
                mountedPath = entry["path"];
                fake.reviewSkills.push({ name: "native-report", path: mountedPath, enabled: true });
              }
            }
          }
        }
        if (method === "turn/start") {
          const queue = store.listQueueItems({ sessionId, limit: 10 })[0];
          expect(queue).toBeDefined();
          expect(queue!.state).toBe("dispatching");
          expect(queue!.runId).toBeDefined();
          const run = store.getRun(queue!.runId!).descriptor;
          expect(run.activeAttemptId).toBeDefined();
          dispatchWitness = { queueItemId: queue!.id, runId: run.id, attemptId: run.activeAttemptId! };
        }
        return request(method, params, options);
      };
      return transport;
    } });
    const adapter: CodexBackendAdapter = new CodexBackendAdapter({ id: "native-input-backend", instanceGeneration: 1,
      host: nativeHost, profileDirectory: join(root, "profile"),
      resolveNativeSkills: (context, signal) => resources.runtimeSkillSnapshot(adapter.id, context.target.id, signal, undefined, context) });
    const descriptor = await adapter.describe();
    const host = new SessionHost(store, artifacts, [adapter], { backendDescriptors: [descriptor] });
    let sessionId = "";
    let server: Awaited<ReturnType<typeof createPublicServer>> | undefined;
    const privateBody = "PRIVATE_SKILL_BODY_FOR_DISPATCH_VERIFICATION";
    let savedResourceIdentity: { id: string; revision: string; version: string; generation: number } | undefined;
    try {
      await host.initialize(); await resources.initialize();
      await host.registerTarget({ id: "native-input-target", backendId: adapter.id,
        displayName: "Native input workspace", workspaceRoot: root, managed: false, trusted: true });
      const skillDirectory = join(root, ".agents", "skills", "report");
      await mkdir(join(skillDirectory, "assets"), { recursive: true });
      await writeFile(join(skillDirectory, "SKILL.md"), `---\nname: native-report\ndescription: Prepare a report\n---\n${privateBody}\n`);
      await writeFile(join(skillDirectory, "assets", "template.bin"), Buffer.from([0, 255, 8, 12]));
      const discovered = await resources.discover({ id: "approved-report", backendId: adapter.id,
        targetId: "native-input-target", kind: "skill", scope: "project", name: "Public report",
        source: { kind: "local", path: skillDirectory }, workspaceRoot: root });
      const connections = new ConnectionManager(store), challenge = connections.issuePairing("Skill input device");
      const paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Skill input device" });
      await resources.approve(discovered.id, discovered.discoveredRevision, paired.connection.id);
      await resources.setEnabled(discovered.id, true);
      sessionId = (await host.createSession({ operationId: "create-skill-input-task", connection: paired.connection,
        targetId: "native-input-target", title: "Approved skill input", providerId: "openai", modelId: "gpt-test",
        fastMode: false, permissionMode: "ask", planMode: false })).value.sessionId;
      server = await createPublicServer({
        config: { publicOrigin: "http://127.0.0.1", allowInsecureLoopback: true, allowInsecureLan: false,
          corsOrigins: [], webDirectory: join(root, "no-web"), dataDirectory: root },
        store, connections, sessionHost: host, piResources: resources, artifacts: {}, blobTransfers: {}, artifactRepository: {},
        workspaces: {}, workspaceChanges: {}, scheduler: {}, adapters: [adapter], browserActivity: []
      } as unknown as OrchestratorApplication);
      server.log.level = "silent";
      const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
      const transport = createConnectTransport({ baseUrl, httpVersion: "1.1",
        interceptors: [next => request => { request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request); }] });
      const sessions = createClient(contract.SessionService, transport), operations = createClient(contract.OperationService, transport);
      if (journey === "a selected slash Skill") {
        const commands = await sessions.listRuntimeCommands({ sessionId });
        expect(commands.commands).toEqual([expect.objectContaining({ sessionId, name: "native-report",
          resourceId: discovered.id, source: contract.RuntimeCommandSource.SKILL,
          inputMode: contract.RuntimeCommandInputMode.RESOURCE_MENTION, loaded: true })]);
        expect(serialized(commands)).not.toContain(mountedPath!);
        expect(serialized(commands)).not.toContain(privateBody);
      }
      const catalog = await sessions.listSessionResources({ sessionId });
      expect(catalog.resources).toHaveLength(1);
      const loaded = catalog.resources[0]!;
      expect(loaded).toMatchObject({ resourceId: discovered.id, name: "Public report", kind: contract.ResourceKind.SKILL });
      expect(loaded.discoveredRevision).toBe(discovered.discoveredRevision);
      expect(loaded.resourceVersion).toBeGreaterThan(0n);
      expect(mountedPath).toBeDefined();
      expect(await readFile(join(mountedPath!, "..", "assets", "template.bin"))).toEqual(Buffer.from([0, 255, 8, 12]));
      expect(serialized(catalog)).not.toContain(mountedPath!);
      await expect(createClient(contract.SessionService, createConnectTransport({ baseUrl, httpVersion: "1.1" }))
        .listSessionResources({ sessionId })).rejects.toMatchObject({ code: Code.Unauthenticated });
      savedResourceIdentity = { id: loaded.resourceId, revision: loaded.discoveredRevision,
        version: loaded.resourceVersion.toString(10), generation: Number(loaded.runtimeGeneration) };
      await operations.submitOperation({ operationId: "send-approved-skill", connectionId: paired.connection.id,
        mutation: { preconditions: [{ entity: { kind: contract.EntityKind.SESSION, id: sessionId }, expectedGeneration: loaded.runtimeGeneration }],
          payload: { case: "sendInput", value: { sessionId, deliveryMode: contract.QueueDeliveryMode.PROMPT,
            input: { parts: [
              { content: { case: "text", value: text } },
              { content: { case: "resourceMention", value: { resourceId: loaded.resourceId, displayText,
                discoveredRevision: loaded.discoveredRevision, resourceVersion: loaded.resourceVersion, runtimeGeneration: loaded.runtimeGeneration } } }
            ], mentionRanges: [{ start, end, mentionIndex: 0 }] }
          } } } });
      await expect.poll(() => fake.transport?.requests.filter(request => request.method === "turn/start").length, { timeout: 10_000 }).toBe(1);
      expect(dispatchWitness).toBeDefined();
      const started = fake.transport!.requests.find(request => request.method === "turn/start")!;
      expect(started.params).toMatchObject({ input: expect.arrayContaining([{ type: "skill", name: "native-report", path: mountedPath }]) });
      const queue = store.getQueueItem(dispatchWitness!.queueItemId);
      expect(queue.body.text).toBe(text);
      expect(queue.body.mentionRanges).toEqual([{ start, end, mentionIndex: 0 }]);
      const parameters = started.params;
      const inputs = parameters !== null && typeof parameters === "object" && !Array.isArray(parameters) ? parameters["input"] : undefined;
      const nativeTexts = Array.isArray(inputs) ? inputs.flatMap(part => part !== null && typeof part === "object" && !Array.isArray(part)
        && part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : []) : [];
      expect(nativeTexts).toEqual([nativeText]);
      expect(queue.body.mentions).toContainEqual({ kind: "resource", reference: savedResourceIdentity.id, label: displayText,
        discoveredRevision: savedResourceIdentity.revision, resourceVersion: savedResourceIdentity.version,
        runtimeGeneration: savedResourceIdentity.generation });
      for (const publicValue of [queue, store.listEvents({ sessionId }), store.getSession(sessionId)]) {
        expect(serialized(publicValue)).not.toContain(privateBody);
        expect(serialized(publicValue)).not.toContain(mountedPath!);
      }
      await fake.completeTurn(store.getSession(sessionId).descriptor.binding.nativeSessionId!);
      await expect.poll(() => store.getQueueItem(queue.id).state, { timeout: 10_000 }).toBe("completed");
    } finally {
      await server?.close();
      await host.dispose();
      await adapter.dispose();
      await nativeHost.shutdown();
      store.close();
    }
    const reopened = new OperationalStore(database);
    try {
      const queue = reopened.listQueueItems({ sessionId, limit: 10 })[0]!;
      expect(queue.state).toBe("completed");
      expect(savedResourceIdentity).toBeDefined();
      expect(queue.body.mentions[0]).toMatchObject({
        reference: savedResourceIdentity!.id, discoveredRevision: savedResourceIdentity!.revision,
        resourceVersion: savedResourceIdentity!.version, runtimeGeneration: savedResourceIdentity!.generation });
      expect(serialized(queue)).not.toContain(privateBody);
      expect(serialized(reopened.listEvents({ sessionId }))).not.toContain(mountedPath!);
    } finally { reopened.close(); await rm(root, { recursive: true, force: true }); }
  });
});

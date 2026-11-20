import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ExtensionPackageAction, OperationMutationSchema, OperationState, type ExtensionCatalogEntry } from "@joko/contracts";
import { expect, it } from "vitest";
import { waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

const executablePath = process.env["JOKO_BROWSER_EXECUTABLE"];

it.skipIf(!executablePath)("uses approved Chromium message hooks on the original owner send and assistant reply", { timeout: 90_000 }, async () => {
  const fixture = await RealPiSystemFixture.start({ externalBrowserExecutable: executablePath,
    providerResponder: () => ({ kind: "text", text: "Original model reply." }) });
  const viewerAbort = new AbortController();
  try {
    const owner = await fixture.pair("Message hook owner");
    const extension = owner.clients.extension;
    const { store, extensionMessageHooks } = fixture.application;
    const target = store.getTarget("workspace-real-pi");
    store.upsertTarget({ ...target.descriptor, trusted: true }, target.metadata);
    const catalog = join(fixture.rootDirectory, "message-hooks");
    const packages = [
      { directory: "first", name: "First message fixture", topics: ["session", "turn"], hooks: ["will-user-message", "will-assistant-message"],
        script: `
          const observed = [];
          joko.onHostMessage(event => { if (event.name?.startsWith("did-")) observed.push(event); });
          joko.messages.register("will-user-message", ({ text }) => {
            if (text === "Block this original send.") return { action: "block", reason: "Fixture policy." };
            if (text === "Report observed metadata.") return { action: "rewrite", text: JSON.stringify(observed) };
            return { action: "rewrite", text: "First " + text };
          });
          joko.messages.register("will-assistant-message", ({ text }) => ({
            action: "render", html: "<p>Formatted reply.</p><script>unexpected-script</script>"
          }));
        ` },
      { directory: "second", name: "Second message fixture", topics: [], hooks: ["will-user-message"],
        script: `joko.messages.register("will-user-message", ({ text }) => {
          if (text.startsWith("First Fail this hook.")) throw new Error("Fixture hook failure.");
          return { action: "rewrite", text: text + " Second." };
        });` }
    ];
    await mkdir(join(catalog, ".agents", "plugins"), { recursive: true });
    await writeFile(join(catalog, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "joko-message-fixture",
      plugins: packages.map(record => ({ name: record.name, source: `packages/${record.directory}` })) }));
    for (const record of packages) {
      const directory = join(catalog, "packages", record.directory);
      await mkdir(join(directory, "extensions"), { recursive: true });
      await mkdir(join(directory, "view"));
      await writeFile(join(directory, "package.json"), JSON.stringify({ name: `@joko-e2e/message-${record.directory}`, version: "1.0.0",
        pi: { extensions: ["extensions/index.js"] }, joko: { extensionSurfaces: { schemaVersion: 1, extensions: [{
          entry: "extensions/index.js",
          runtime: { html: "view/index.html", tools: [], subscribe: { topics: record.topics, hooks: record.hooks } }
        }] } } }));
      await writeFile(join(directory, "extensions", "index.js"), "export default function setup() {}");
      await writeFile(join(directory, "view", "index.html"), "<!doctype html><script src=\"app.js\" defer></script>");
      await writeFile(join(directory, "view", "app.js"), record.script);
    }
    const mutate = (payload: MessageInitShape<typeof OperationMutationSchema>["payload"], operationId?: string) =>
      submit(owner.clients.operation, owner.connectionId, create(OperationMutationSchema, { payload }), operationId);
    const sourceRevision = (await extension.listExtensionSources({ page: { pageSize: 100 } })).catalogRevision!;
    expect((await mutate({ case: "addExtensionSource", value: { expectedCatalogRevision: sourceRevision,
      source: { kind: { case: "local", value: { path: catalog } } } } })).state).toBe(OperationState.SUCCEEDED);
    const availableExtension = async (name: string): Promise<ExtensionCatalogEntry | undefined> =>
      (await extension.listExtensions({ query: name, page: { pageSize: 100 } })).extensions.find(item => item.owner?.kind.case === "source");
    for (const record of packages) {
      const available = (await availableExtension(record.name))!;
      expect(available?.revision).toBeDefined();
      const preview = (await extension.getExtensionPackagePreview({
        extensionId: available.extensionId, expectedRevision: available.revision, backendId: "pi"
      })).preview!;
      expect(preview.action).toBe(ExtensionPackageAction.INSTALL);
      const adopted = await mutate({ case: "adoptExtensionPackage", value: {
        extensionId: preview.extensionId, expectedRevision: preview.extensionRevision, backendId: preview.backendId,
        expectedAction: preview.action, expectedCurrentResourceId: "", allowSourceReplacement: false
      } });
      expect(adopted.state, adopted.error?.message).toBe(OperationState.SUCCEEDED);
      if (adopted.result?.payload.case !== "resource") throw new Error("The extension install returned no original resource.");
      const resourceId = adopted.result.payload.value.resourceId;
      const installed = (await extension.listExtensions({ installed: true, page: { pageSize: 100 } })).extensions.find(item =>
        item.owner?.kind.case === "resource" && item.owner.kind.value.resourceId === resourceId);
      if (installed === undefined) throw new Error("The original installed extension is missing from the catalog.");
      if (!installed.enabled) {
        expect((await mutate({ case: "setExtensionEnabled", value: {
          extensionId: installed.extensionId, enabled: true, expectedRevision: installed.revision
        } })).state).toBe(OperationState.SUCCEEDED);
      }
    }
    const targetId = target.descriptor.id;
    await waitFor(async () => extensionMessageHooks?.hasMessageHook("will-user-message", targetId),
      value => value === true, "the installed host-owned Chromium hook", 15_000);
    const created = await submit(owner.clients.operation, owner.connectionId,
      createSessionMutation({ backendId: "pi", targetId, providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID }));
    expect(created.state, created.error?.message).toBe(OperationState.SUCCEEDED);
    const sessionId = sessionIdFrom(created);
    const generation = BigInt(store.getSession(sessionId).descriptor.binding.generation);
    const viewer = extension.watchExtensionTaskViews({ focusedSessionId: sessionId }, { signal: viewerAbort.signal })[Symbol.asyncIterator]();
    expect((await viewer.next()).done).toBe(false);
    const send = (text: string, id?: string) => submit(owner.clients.operation, owner.connectionId,
      sendInputMutation(sessionId, generation, text), id);
    const requestId = randomUUID();
    const blocked = await send("Block this original send.", requestId);
    expect(blocked).toMatchObject({ state: OperationState.FAILED, error: { code: "EXTENSION_MESSAGE_BLOCKED" } });
    expect(await send("Block this original send.", requestId)).toMatchObject({
      operationId: blocked.operationId, state: OperationState.FAILED, error: { code: "EXTENSION_MESSAGE_BLOCKED" }
    });
    expect(store.listRuns({ sessionId })).toHaveLength(0);
    expect(fixture.providerRequests).toHaveLength(0);

    const sent = await send("Use the original fixture text.");
    expect(sent.state, sent.error?.message).toBe(OperationState.SUCCEEDED);
    const runId = queueRunIdFrom(sent);
    const published = await waitFor(async () => store.listEvents({ sessionId }).find(item =>
      item.payload.type === "assistant_message_presentation_changed"), value => value !== undefined, "the anchored assistant presentation", 20_000);
    expect(published?.payload).toMatchObject({ text: "Original model reply.", card: { html: "<p>Formatted reply.</p>", sessionId } });
    const completion = store.findCompletedAssistantReply(runId);
    expect(published?.payload).toMatchObject({ completionEventId: completion?.id });
    expect(completion?.payload).toMatchObject({ type: "message_complete", blocks: [{ kind: "text", text: "Original model reply." }] });
    const snapshot = await owner.clients.event.getSnapshot({ scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 200 } } } });
    const presented = snapshot.snapshot?.timeline.find(event => event.payload?.kind.case === "assistantMessagePresentationChanged");
    expect(presented?.payload?.kind).toMatchObject({ case: "assistantMessagePresentationChanged", value: {
      completionEventId: completion?.id, text: "Original model reply.", card: { html: "<p>Formatted reply.</p>", sessionId }
    } });
    expect(JSON.stringify(fixture.providerRequests[0]?.body)).toContain("First Use the original fixture text. Second.");

    const metadata = await send("Report observed metadata.");
    expect(metadata.state, metadata.error?.message).toBe(OperationState.SUCCEEDED);
    const metadataRunId = queueRunIdFrom(metadata);
    const queue = store.findQueueItemByRunId(sessionId, metadataRunId, { includeCleared: true })!;
    const events = JSON.parse(queue.body.text.slice(0, -" Second.".length)) as readonly Record<string, unknown>[];
    expect(events.map(event => event["name"])).toEqual(expect.arrayContaining([
      "did-session-created", "did-session-switched", "did-turn-start", "did-turn-end"
    ]));
    expect(events.every(event => event["sessionId"] === sessionId && event["text"] === undefined)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("Original model reply.");
    await waitFor(async () => store.getRun(metadataRunId).descriptor.state,
      state => state === "completed", "the accepted metadata report to finish before the refresh", 20_000);

    const previousBackendRevision = store.getBackend("pi").revision;
    const previousRuns = store.listRuns({ sessionId }).length;
    const previousRequests = fixture.providerRequests.length;
    await fixture.application.refreshPiGeneration?.();
    expect(store.getBackend("pi").revision).toBeGreaterThan(previousBackendRevision);
    const refreshedBlock = await send("Block this original send.");
    expect(refreshedBlock).toMatchObject({ state: OperationState.FAILED, error: { code: "EXTENSION_MESSAGE_BLOCKED" } });
    expect(store.listRuns({ sessionId })).toHaveLength(previousRuns);
    expect(fixture.providerRequests).toHaveLength(previousRequests);

    for (const text of ["Fail this hook. One", "Fail this hook. Two", "Fail this hook. Three", "Keep the fused hook inactive."]) {
      const accepted = await send(text);
      expect(accepted.state, accepted.error?.message).toBe(OperationState.SUCCEEDED);
      const item = store.findQueueItemByRunId(sessionId, queueRunIdFrom(accepted), { includeCleared: true });
      expect(item?.body.text).toBe(`First ${text}`);
    }
    const warnings = store.listEvents({ sessionId }).filter(item => item.traceId === "extension-message-hook-disabled");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.payload).toMatchObject({ type: "extension_ui_effect", effect: "notification", notificationKind: "warning" });
  } finally {
    viewerAbort.abort();
    await fixture.close();
  }
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import { OperationalStore } from "@joko/store";
import { readMailCard } from "@joko/contracts";
import { CredentialVault } from "../credential-vault.js";
import { ExtensionMainViewManager } from "../extension-main-view-manager.js";
import type { ExtensionCatalogDescriptor } from "../extension-catalog.js";
import type { PiInstalledPackageLease, PiResourceDescriptor } from "../resource-manager.js";
import type { BridgeToolProvider } from "../mcp-router.js";
import { parseExtensionRuntime, type ExtensionRuntimeDescriptor } from "../extension-surface-manifest.js";
import { ExtensionCardRuntime, validateExtensionEnvelope } from "./runtime.js";
import { ExtensionCardsManager } from "./manager.js";
import type { ExtensionTasks, ExtensionTaskOwner } from "../extension-tasks.js";
import { ExtensionProjectPolicies, extensionProjectForTarget } from "../extension-project-policy.js";

const browserIt = process.env.JOKO_BROWSER_EXECUTABLE ? it : it.skip;
it("bounds every plugin envelope before asynchronous admission", () => {
  validateExtensionEnvelope({ type: "card-update", html: "<p>Safe</p>" });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [cyclic, new Date(), { value: 1n }, { value: "x".repeat(4 * 1024 * 1024) }, { ignored: new Array(65_536).fill(0) }]) expect(() => validateExtensionEnvelope(value)).toThrow();
});
browserIt("runs inspected tools in Chromium, preserves mail edits through sending and revokes a disabled source", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-card-runtime-")), store = new OperationalStore(join(root, "store.db"));
  const vault = await CredentialVault.open(join(root, "vault.key"));
  store.upsertBackend({ id: "runtime", displayName: "Runtime", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "runtime", displayName: "Workspace", workspaceRoot: root, managed: false, trusted: true });
  store.createSession({ id: "task", backendId: "runtime", targetId: "target", title: "Task", binding: { opaqueRef: "native", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  store.upsertTarget({ id: "other-target", backendId: "runtime", displayName: "Other project", workspaceRoot: join(root, "other"), managed: false, trusted: true });
  store.createSession({ id: "other-task", backendId: "runtime", targetId: "other-target", title: "Other", binding: { opaqueRef: "other", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  const projects = new ExtensionProjectPolicies(store);
  const id = "extension_0123456789abcdef0123456789abcdef", revision = `sha256:${"a".repeat(64)}`;
  let enabled = true, changed: ((ids: readonly string[]) => void) | undefined, connectionIdentity = "original";
  const declaration: ExtensionRuntimeDescriptor = parseExtensionRuntime({ html: "ui/logic/index.html", tools: ["card", "mail", "inspect", "network", "read_mail", "transfer", "tasks", "text"].map(name => ({ name, description: `Fixture ${name}`, inputSchema: { type: "object" }, readOnly: ["inspect", "network", "read_mail"].includes(name) })),
    card: { externalLinks: true }, mail: true, agent: true, tasks: { hidden: true }, text: { oneshot: true }, showTaskPreferences: false,
    network: { hosts: ["api.example.test"], connections: [{ key: "service", label: "Service", inject: { header: "Authorization", format: "Bearer {value}" } }], secrets: [{ key: "key", label: "Key", inject: { header: "Authorization", format: "Bearer {value}" } }] }, mailReader: { tool: "read_mail", hosts: ["mail.example.test"], markRead: true } });
  const extension = () => ({ id, revision: 1n, name: "Fixture mail", installed: true, enabled, owner: { kind: "resource", resourceId: "resource", resourceVersion: 1n, discoveredRevision: revision },
    setup: { state: "not_required" }, runtime: { ...declaration, extensionEntry: "extensions/main.js" } } as unknown as ExtensionCatalogDescriptor);
  const resource = { id: "resource", kind: "package", scope: "managed", state: "installed", enabled: true, backendId: "runtime", versionNumber: 1n,
    discoveredRevision: revision, packageIdentity: "@sample/mail", version: "1.0.0", resourceDetails: [{ kind: "extension", entryPath: "extensions/main.js", runtime: declaration }] } as unknown as PiResourceDescriptor;
  const surfaces = new ExtensionMainViewManager({ rootDirectory: join(root, "surfaces"), resources: { acquireInstalledPackage: async (): Promise<PiInstalledPackageLease> => ({ resource,
    assertCurrent: async () => { if (!enabled) throw new Error("Disabled"); }, release: async () => {}, snapshotTo: async destination => {
      await mkdir(join(destination, "extensions"), { recursive: true }); await mkdir(join(destination, "ui/logic"), { recursive: true });
      await writeFile(join(destination, "package.json"), JSON.stringify({ name: "@sample/mail", version: "1.0.0", pi: { extensions: ["extensions/main.js"] },
        joko: { extensionSurfaces: { schemaVersion: 1, extensions: [{ entry: "extensions/main.js", runtime: declaration }] } } }));
      await writeFile(join(destination, "extensions/main.js"), "export default function setup() {}\n");
      await writeFile(join(destination, "ui/logic/index.html"), '<!doctype html><html><head><script src="./runtime.js"></script></head><body></body></html>');
      await writeFile(join(destination, "ui/logic/runtime.js"), String.raw`
        let writes = 0, sends = 0;
        const taskOutcomes = {}, textOutcomes = {};
        let saved = { status: 'read_back', draftId: 'draft-one', fingerprint: 'revision-1', locator: { id: 'draft-one' },
          headers: { from: 'owner@example.test', to: 'reader@example.test', cc: '', bcc: '', subject: 'Review' },
          editor: { editable: true, format: 'html', body: 'Hello', quote: '', bodyHtml: '<p style="color:red">Hello</p>', quoteHtml: '' }, attachments: [] };
        const account = { ok: true, accountId: 'account-one', accountEmail: 'owner@example.test' };
        const compose = jokoMail.register({ providerName: 'Fixture', draftStorage: 'server', richText: true,
          selectAccount: async () => account,
          readDraft: async () => ({ ok: true, data: { readBack: structuredClone(saved) } }),
          writeDraft: async request => {
            writes++;
            if (request.send) { sends++; return { ok: true, data: { sent: true, receipt: { id: 'accepted-one' } } }; }
            saved = { ...saved, fingerprint: 'revision-' + (writes + 1), headers: { ...saved.headers, ...Object.fromEntries(['to','cc','bcc','subject'].map(name => [name, request.fields[name] || ''])) },
              editor: { ...saved.editor, body: request.fields.body, bodyHtml: request.fields.bodyHtml, quote: request.fields.quote || '', quoteHtml: request.fields.quoteHtml || '' } };
            return { ok: true, data: { readBack: structuredClone(saved) } };
          }
        });
        joko.tools.register('card', async message => {
          const published = await joko.card.update({ callId: message.callId, html: '<p>Approved source</p><button data-joko-action="refresh">Refresh</button>' });
          return { ok: published.ok, result: { published: published.ok, nodeVisible: typeof process !== 'undefined', agentVisible: !!joko.agent } };
        });
        joko.tools.register('network', async message => {
          const connections = message.arguments.connection ? await joko.network.connections('service') : undefined;
          const response = await joko.network.fetch({ callId: message.callId, url: 'https://' + (connections ? connections.connections[0].host : 'api.example.test') + '/messages' });
          return { ok: true, result: connections ? { connections, response } : response };
        });
        joko.tools.register('transfer', async message => {
          const uploaded = await joko.network.fetch({ callId: message.callId, url: 'https://api.example.test/upload', method: 'POST', uploadDir: { token: message.arguments.dir_deposit.token, fileField: 'attachment' } });
          const downloaded = await joko.network.fetch({ callId: message.callId, url: 'https://api.example.test/download', as: 'file', saveTo: { token: message.arguments.save_deposit.token } });
          return { ok: uploaded.ok && downloaded.ok, result: { uploaded, downloaded, argumentKeys: Object.keys(message.arguments) } };
        });
        joko.tools.register('tasks', async message => {
          if (message.arguments.requestKey) {
            const requestKey = message.arguments.requestKey;
            try {
              const task = await joko.tasks.create({ ...(message.arguments.resident ? {} : { callId: message.callId }), requestKey, title: 'Deferred task' });
              taskOutcomes[requestKey] = { taskId: task.taskId };
            } catch (error) { taskOutcomes[requestKey] = { errorCode: error.code }; }
            return { ok: true, result: taskOutcomes[requestKey] };
          }
          const task = await joko.tasks.create({ callId: message.callId, requestKey: 'task-one', title: 'Review', hidden: true });
          const text = await joko.text.oneshot({ prompt: 'Return a summary', expectJson: true });
          let failureCode;
          try { await joko.tasks.get({ taskId: 'foreign-task' }); } catch (error) { failureCode = error.code; }
          return { ok: true, result: { task, text, failureCode, taskMethods: Object.keys(joko.tasks), hasCredentials: 'credential' in joko } };
        });
        joko.tools.register('text', async message => {
          const key = message.arguments.key;
          const response = await joko.text.oneshot({ prompt: key, ...(message.arguments.resident ? {} : { callId: message.arguments.expired ? 'missing-call' : message.callId }) });
          textOutcomes[key] = response;
          return { ok: true, result: response };
        });
        joko.tools.register('read_mail', async message => ({ ok: true, result: { accountId: 'one', messageId: 'one', from: 'Sender', to: 'Owner', cc: '', bcc: '', date: 'Today', subject: message.arguments.markRead ? 'Opened' : 'Unread', bodyHtml: '<p>Hello</p>', bodyText: 'Hello', attachments: [] } }));
        joko.onHostMessage(async message => {
          if (message.actionId === 'refresh') await joko.card.update({ callId: message.callId, html: '<p>Refreshed</p>' });
        });
        joko.tools.register('mail', async message => ({ ok: await compose.present(message, account, structuredClone(saved)), result: { shown: true } }));
        joko.tools.register('inspect', async () => ({ ok: true, result: { writes, sends, saved, taskOutcomes, textOutcomes } }));
      `);
      return { discoveredRevision: revision, files: 4, bytes: 5000, entries: [] };
    }
  }) } });
  let runtime: ExtensionCardRuntime | undefined;
  const providers = new Map<string, BridgeToolProvider>(), continuation = vi.fn(async () => {});
  const delayedTasks = new Map<string, { readonly owner: ExtensionTaskOwner; readonly release: () => void }>(), taskEffects: string[] = [];
  const delayedText = new Map<string, { readonly owner: ExtensionTaskOwner; readonly release: () => void }>(), textEffects: string[] = [], textCalls: string[] = [];
  const tasks: Pick<ExtensionTasks, "installation" | "request" | "drain"> = { installation: () => "durable-installation", drain: async () => {}, request: vi.fn(async (owner, input) => {
    owner.assertCurrent(); expect(owner.installation).toBe("durable-installation");
    if ((input as { kind: string }).kind === "get") throw Object.assign(new Error("Not owned"), { code: "TASK_NOT_FOUND" });
    const request = input as { requestKey?: string };
    if (request.requestKey?.startsWith("deferred-")) {
      const key = request.requestKey;
      await new Promise<void>(release => delayedTasks.set(key, { owner, release }));
      owner.assertCurrent(); owner.signal.throwIfAborted(); taskEffects.push(key);
      return { taskId: `managed-${key}`, revision: "configuration" };
    }
    expect(owner.sourceSessionId).toBe("task"); return { taskId: "managed-task", revision: "configuration", hidden: true, usage: 1n };
  }) };
  const manager = new ExtensionCardsManager({ store, vault, assertProject: (extensionId, sessionId) => projects.assertEnabledForSession(extensionId, sessionId), authority: extensionId => runtime?.authority(extensionId), redact: value => value,
    dispatch: (scope, event, assertCurrent) => runtime!.dispatch(scope, event, assertCurrent) });
  const startupErrors: string[] = [];
  const openSurface = surfaces.open.bind(surfaces);
  vi.spyOn(surfaces, "open").mockImplementation(async input => {
    try { return await openSurface(input); } catch (error) { startupErrors.push(String(error)); throw error; }
  });
  const registration = { id: "target", root, displayName: "Workspace", trusted: true };
  runtime = new ExtensionCardRuntime({ store, vault, cards: manager, surfaces, projects, executablePath: process.env.JOKO_BROWSER_EXECUTABLE,
    tasks, text: { oneshot: async (owner, input) => {
      owner.assertCurrent(); const key = (input as { prompt: string }).prompt; textCalls.push(key);
      if (key.startsWith("deferred-text-")) {
        await new Promise<void>(release => delayedText.set(key, { owner, release }));
        owner.assertCurrent(); owner.signal.throwIfAborted(); textEffects.push(key); return { ok: true, text: key };
      }
      return { ok: true, text: '{"summary":"Done"}' };
    } },
    workspaces: { listRegistrations: () => [registration] },
    launch: async () => {
      const browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE, headless: true, chromiumSandbox: true })
        .catch(error => { startupErrors.push(String(error)); throw error; });
      const open = browser.newContext.bind(browser);
      browser.newContext = async options => {
        const context = await open(options);
        context.on("page", page => { page.on("pageerror", error => startupErrors.push(error.message)); page.on("console", message => { if (message.type() === "error") startupErrors.push(message.text()); }); });
        return context;
      };
      return browser;
    },
    resources: { get: () => resource }, catalog: { get: () => extension(), snapshot: () => ({ revision: 1n, entries: [extension()], recoveredFromCorruption: false }),
      onAuthorityChanged: listener => { changed = listener; return () => { changed = undefined; }; } },
    registerProvider: provider => { providers.set(provider.id, provider); return () => { providers.delete(provider.id); }; }, redact: value => value,
    connections: { identity: () => connectionIdentity, hosts: () => ["one.example.test"], token: () => "connection-private-key",
      list: () => [{ id: "connection-one", host: "one.example.test", label: "One", isDefault: true, configured: true, changeId: "private-change-id" }] },
    fetch: (async (url, init) => {
      const token = new URL(String(url)).hostname === "one.example.test" ? "connection-private-key" : "runtime-private-key";
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      if (new URL(String(url)).pathname === "/upload") expect(Buffer.from(init?.body as ArrayBuffer).toString()).toContain("selected bytes");
      if (new URL(String(url)).pathname === "/download") return new Response(new Uint8Array([0, 1, 2]), { headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="result.zip"' } });
      return new Response(JSON.stringify({ messages: 1, echo: token }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch, resolveCredential: () => "runtime-private-key",
    continueTask: async (_scope, _text, guard) => { await guard(); await continuation(); } });
  const context = { sessionId: "task", targetId: "target", generation: 1 };
  const publicCards = () => store.listEvents({ sessionId: "task" }).flatMap(event => event.payload.type === "extension_card_changed" ? [event.payload.card] : []);
  try {
    await surfaces.initialize(); await runtime.start();
    const provider = providers.get(`${id}-runtime`)!; expect(provider, startupErrors.join("; ")).toBeDefined();
    const managed = await provider.callTool("tasks", {}, undefined, context);
    expect(managed.structuredContent).toMatchObject({ task: { taskId: "managed-task", revision: "configuration", hidden: true, usage: "1" },
      text: { ok: true, text: '{"summary":"Done"}' }, failureCode: "TASK_NOT_FOUND", hasCredentials: false });
    expect((managed.structuredContent?.taskMethods as string[])).toHaveLength(17);
    for (const reason of ["cancel", "generation", "bridge-authority", "resident"] as const) {
      const key = `deferred-${reason}`, source = new AbortController(); let bridgeCurrent = true;
      const failed = provider.callTool("tasks", { requestKey: key, ...(reason === "resident" ? { resident: true } : {}) }, source.signal,
        { ...context, assertCurrent: () => { if (!bridgeCurrent) throw new Error("Original tool authority revoked"); } }).then(() => false, () => true);
      await vi.waitFor(() => expect(delayedTasks.has(key)).toBe(true));
      const deferred = delayedTasks.get(key)!;
      if (reason === "generation") store.updateSession("task", { binding: { opaqueRef: "replacement-native", generation: 2 } });
      else if (reason === "bridge-authority") bridgeCurrent = false;
      else source.abort();
      if (reason === "cancel") expect(deferred.owner.signal.aborted).toBe(true);
      if (reason === "resident") { expect(deferred.owner.sourceSessionId).toBeUndefined(); expect(deferred.owner.signal.aborted).toBe(false); }
      else expect(() => deferred.owner.assertCurrent()).toThrow();
      deferred.release(); expect(await failed).toBe(true);
      if (reason === "generation") context.generation = 2;
      await vi.waitFor(async () => {
        const inspected = await provider.callTool("inspect", {}, undefined, context);
        expect(inspected.structuredContent).toMatchObject({ taskOutcomes: { [key]: reason === "resident" ? { taskId: `managed-${key}` } : { errorCode: "INTERNAL" } } });
      });
      expect(taskEffects.includes(key)).toBe(reason === "resident");
    }
    const beforeExpiredText = textCalls.length;
    const expiredText = await provider.callTool("text", { key: "expired-text", expired: true }, undefined, context);
    expect(expiredText.structuredContent).toMatchObject({ ok: false, errorCode: "SOURCE_CALL_EXPIRED" }); expect(textCalls).toHaveLength(beforeExpiredText);
    for (const reason of ["cancel", "generation", "resident"] as const) {
      const key = `deferred-text-${reason}`, source = new AbortController();
      const failed = provider.callTool("text", { key, ...(reason === "resident" ? { resident: true } : {}) }, source.signal, { ...context }).then(() => false, () => true);
      await vi.waitFor(() => expect(delayedText.has(key)).toBe(true));
      const deferred = delayedText.get(key)!;
      if (reason === "generation") store.updateSession("task", { binding: { opaqueRef: "next-native", generation: context.generation + 1 } });
      else source.abort();
      if (reason === "cancel") expect(deferred.owner.signal.aborted).toBe(true);
      if (reason === "resident") { expect(deferred.owner.sourceSessionId).toBeUndefined(); expect(deferred.owner.signal.aborted).toBe(false); }
      else expect(() => deferred.owner.assertCurrent()).toThrow();
      deferred.release(); expect(await failed).toBe(true);
      if (reason === "generation") context.generation += 1;
      await vi.waitFor(async () => {
        const inspected = await provider.callTool("inspect", {}, undefined, context);
        expect(inspected.structuredContent).toMatchObject({ textOutcomes: { [key]: reason === "resident" ? { ok: true, text: key } : { ok: false, errorCode: reason === "cancel" ? "CANCELLED" : "SOURCE_CHANGED" } } });
      });
      expect(textEffects.includes(key)).toBe(reason === "resident");
    }
    expect(provider.tools.find(tool => tool.name === "network")?.requiresPermission).toBe(true);
    expect(provider.tools.find(tool => tool.name === "transfer")?.inputSchema).toMatchObject({ properties: { dir: { type: "string" }, save_dir: { type: "string" } } });
    await writeFile(join(root, "selected.txt"), "selected bytes");
    const transferred = await provider.callTool("transfer", { dir: join(root, "selected.txt"), save_dir: root }, undefined, context);
    expect(transferred.structuredContent).toMatchObject({ uploaded: { ok: true }, downloaded: { ok: true, file: { file_name: "result.zip", bytes: 3 } }, argumentKeys: ["dir_deposit", "save_deposit"] });
    expect(await readFile(join(root, "result.zip"))).toEqual(Buffer.from([0, 1, 2]));
    const response = await provider.callTool("network", {}, undefined, context);
    expect(response.structuredContent).toMatchObject({ ok: true, status: 200, body: '{"messages":1,"echo":"[REDACTED]"}' });
    const connectionResponse = await provider.callTool("network", { connection: true }, undefined, context);
    expect(connectionResponse.structuredContent).toMatchObject({ connections: { ok: true, connections: [{ id: "connection-one", host: "one.example.test", label: "One", default: true }] },
      response: { ok: true, status: 200, body: '{"messages":1,"echo":"[REDACTED]"}' } });
    expect(JSON.stringify(connectionResponse)).not.toContain("private-change-id");
    expect(await runtime.previewMail("task", "https://mail.example.test/message/one", false, false, new AbortController().signal, () => {})).toEqual({ supported: true });
    expect(await runtime.previewMail("task", "https://mail.example.test/message/one", true, true, new AbortController().signal, () => {})).toMatchObject({ supported: true, message: { subject: "Opened", bodyText: "Hello" } });
    const first = await provider.callTool("card", {}, undefined, context).catch(error => { throw new Error(`${String(error)}; ${startupErrors.join("; ")}`); });
    expect(first).toMatchObject({ isError: false, structuredContent: { published: true, nodeVisible: false, agentVisible: true } });
    const cardId = first.structuredContent?.joko_card_id as string; expect(manager.get("task", cardId).card.html).toContain("Approved source");
    await new Promise(resolve => setTimeout(resolve, 1050));
    expect(await manager.dispatch({ sessionId: "task", cardId, actionId: "refresh", prompt: "", formValues: {}, change: false }, () => {})).toBe(true);
    await vi.waitFor(() => expect(manager.get("task", cardId).card.html).toContain("Refreshed"));
    const shown = await provider.callTool("mail", {}, undefined, context); expect(shown.isError).toBe(false);
    const mailId = shown.structuredContent?.joko_card_id as string;
    let mail = readMailCard(manager.get("task", mailId).card.html)!; expect(mail.state).toBe("draft");
    const fields = Object.fromEntries(mail.fields.map(field => [field.name, field.value]));
    fields.body = "Edited"; fields.bodyHtml = '<p style="color:red">Edited</p>';
    expect(await manager.dispatch({ sessionId: "task", cardId: mailId, actionId: `mail:change:${mail.key}`, prompt: "", formValues: fields, change: true }, () => {})).toBe(true);
    await vi.waitFor(async () => {
      const result = await provider.callTool("inspect", {}, undefined, context);
      expect(result.structuredContent).toMatchObject({ writes: 1, sends: 0, saved: { editor: { body: "Edited", bodyHtml: '<p style="color:red">Edited</p>' } } });
    }, { timeout: 6000 });
    mail = readMailCard(manager.get("task", mailId).card.html)!;
    const currentValues = () => Object.fromEntries(readMailCard(manager.get("task", mailId).card.html)!.fields.map(field => [field.name, field.value]));
    const action = (name: string) => manager.dispatch({ sessionId: "task", cardId: mailId, actionId: `mail:${name}:${mail.key}`, prompt: "", formValues: currentValues(), change: false }, () => {});
    expect(await action("send")).toBe(true); await vi.waitFor(() => expect(readMailCard(manager.get("task", mailId).card.html)?.state).toBe("sending"));
    expect(await action("cancel")).toBe(true); await vi.waitFor(() => expect(readMailCard(manager.get("task", mailId).card.html)?.state).toBe("draft"));
    expect((await provider.callTool("inspect", {}, undefined, context)).structuredContent?.sends).toBe(0);
    expect(await action("send")).toBe(true); await vi.waitFor(() => expect(readMailCard(manager.get("task", mailId).card.html)?.state).toBe("sending"));
    expect(await action("now")).toBe(true);
    await vi.waitFor(async () => {
      const current = readMailCard(manager.get("task", mailId).card.html);
      const stats = await provider.callTool("inspect", {}, undefined, context);
      expect(current?.state, JSON.stringify({ current, stats: stats.structuredContent, startupErrors })).toBe("sent");
    }, { timeout: 6000 });
    expect((await provider.callTool("inspect", {}, undefined, context)).structuredContent?.sends).toBe(1);
    expect(await action("send")).toBe(false);
    const project = extensionProjectForTarget(store.getTarget("target").descriptor);
    const pendingKey = "deferred-text-project-disabled";
    const pendingResult = provider.callTool("text", { key: pendingKey }, undefined, context).then(() => false, () => true);
    await vi.waitFor(() => expect(delayedText.has(pendingKey)).toBe(true));
    projects.setEnabled(project.id, "connection", extension(), false, 0n);
    expect(provider.includeForTarget?.("target")).toBe(false);
    expect(provider.includeForSession?.("task", "target")).toBe(false);
    expect(provider.includeForTarget?.("other-target")).toBe(true);
    expect(manager.get("task", cardId).interactive).toBe(false);
    expect(() => delayedText.get(pendingKey)!.owner.assertCurrent()).toThrow("disabled");
    delayedText.get(pendingKey)!.release(); expect(await pendingResult).toBe(true);
    expect(textEffects).not.toContain(pendingKey);
    await expect(provider.callTool("card", {}, undefined, context)).rejects.toThrow("disabled");
    const other = await provider.callTool("card", {}, undefined, { sessionId: "other-task", targetId: "other-target", generation: 1 });
    expect(other.isError).toBe(false); expect(provider.available).toBe(true);
    projects.setEnabled(project.id, "connection", extension(), true, projects.state(project.id, "connection").revision);
    expect(provider.includeForSession?.("task", "target")).toBe(true);
    expect((await provider.callTool("card", {}, undefined, context)).isError).toBe(false);
    const before = publicCards().length;
    connectionIdentity = "changed";
    await expect(provider.callTool("network", {}, undefined, context)).rejects.toThrow();
    expect(manager.get("task", mailId).interactive).toBe(false);
    enabled = false; changed?.([id]); expect(provider.available).toBe(false);
    expect(manager.get("task", mailId).interactive).toBe(false);
    await expect(provider.callTool("card", {}, undefined, context)).rejects.toThrow(); expect(publicCards()).toHaveLength(before);
  } finally { for (const task of [...delayedTasks.values(), ...delayedText.values()]) task.release(); await runtime.stop(); await manager.dispose(); await surfaces.close(); store.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

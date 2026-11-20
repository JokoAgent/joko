import { create } from "@bufbuild/protobuf";
import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { Code, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { EntityKind, OperationMutationSchema, OperationState, RemoteHostService } from "@joko/contracts";
import { RemoteHostRegistry } from "@joko/orchestrator";
import type { RemoteFileTransportPort, RemoteProcessTransportPort } from "@joko/remote-ssh";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { chromium, type Browser } from "playwright-core";
import { expect, it, vi } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { submit } from "./operations.js";

it.each(["/srv/new-project", "/home/fixture/server/new-project"])("browses and creates a revision-fenced SSH project at %s", async requestedPath => {
  let createdRemoteDirectory = false;
  const files: RemoteFileTransportPort = {
    realpath: vi.fn(async path => path === "." ? "/home/fixture" : path === "/home/fixture/server" ? "/srv" : path),
    stat: vi.fn(async () => ({ kind: "directory" as const, size: 0, modifiedAt: 0, mode: 0o755 })),
    list: vi.fn(async path => {
      if (path === "/") return [{ name: "home", kind: "directory" as const }, { name: "srv", kind: "directory" as const }];
      if (path === "/home") return [{ name: "fixture", kind: "directory" as const }];
      if (path === "/home/fixture") return [
        { name: "work", kind: "directory" as const }, { name: "readme.txt", kind: "file" as const },
        { name: "server", kind: "symbolic_link" as const }
      ];
      if (path === "/srv" && createdRemoteDirectory) return [{ name: "new-project", kind: "directory" as const }];
      return [];
    }),
    read: async () => new Uint8Array(), write: async () => undefined,
    mkdir: vi.fn(async path => {
      if (path !== "/srv/new-project") throw new Error("The SFTP parent must be a directory rather than a symbolic link.");
      createdRemoteDirectory = true;
    }),
    rename: async () => undefined, remove: async () => undefined
  };
  const processes: RemoteProcessTransportPort = { open: vi.fn(async () => { throw new Error("unused process transport"); }) };
  const capabilities = { commandExecution: true, processStreaming: true, fileTransfer: true, tcpForwarding: false, interactiveTerminal: false };
  const lifetimes: AbortController[] = [];
  const connect = vi.fn(async (request: Parameters<NonNullable<ConstructorParameters<typeof RemoteHostRegistry>[0]["connector"]>["connect"]>[0]) => {
    await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1, 2, 3) });
    request.onAuthenticating();
    const lifetime = new AbortController();
    lifetimes.push(lifetime);
    return { capabilities, files, processes, closed: lifetime.signal, close: async () => lifetime.abort() };
  });
  const fixture = await OrchestratorE2eFixture.start({ createAuxiliaryServices: async store => ({
    remoteHosts: new RemoteHostRegistry({ store, ownerId: "remote-directory-e2e", connector: { capabilities, connect } })
  }) });
  try {
    const targetId = [...fixture.targets.values()][0]!;
    const registry = fixture.application.remoteHosts!;
    const created = registry.create({ targetId, id: "host-one", hostname: "ssh-fixture.invalid", user: "fixture", source: "manual" });
    expect((await registry.connect(targetId, created.id, created.revision)).ok).toBe(true);
    const host = registry.get(targetId, created.id);
    const targetRevision = fixture.application.store.getTarget(targetId)!.revision;
    const paired = await fixture.pair("SSH directory browser");
    const client = (authKey?: string) => createClient(RemoteHostService, createConnectTransport({
      baseUrl: fixture.baseUrl, httpVersion: "1.1",
      interceptors: authKey === undefined ? [] : [next => request => { request.header.set("authorization", `Bearer ${authKey}`); return next(request); }]
    }));
    const request = { targetId, hostId: host.id, expectedTargetRevision: { value: targetRevision },
      expectedHostRevision: { value: host.revision }, path: "" };
    await expect(client().listRemoteHostDirectories(request)).rejects.toMatchObject({ code: Code.Unauthenticated });
    const listing = await client(paired.authKey).listRemoteHostDirectories(request);
    expect(listing).toMatchObject({ targetId, hostId: host.id, path: "/home/fixture", parentPath: "/home",
      directories: [{ name: "server", path: "/srv" }, { name: "work", path: "/home/fixture/work" }] });
    expect(listing.directories).toHaveLength(2);
    expect(files.realpath).toHaveBeenCalledWith(".", expect.any(AbortSignal));
    await expect(client(paired.authKey).listRemoteHostDirectories({ ...request, expectedHostRevision: { value: host.revision - 1n } }))
      .rejects.toMatchObject({ code: Code.Aborted });
    await expect(client(paired.authKey).listRemoteHostDirectories({ ...request, path: "D:/service-node" }))
      .rejects.toMatchObject({ code: Code.InvalidArgument });

    const inspection = await client(paired.authKey).inspectRemoteHostDirectory({
      ...request, path: requestedPath
    });
    expect(inspection).toMatchObject({
      targetId, hostId: host.id, targetRevision: { value: targetRevision }, hostRevision: { value: host.revision },
      exists: false, path: "/srv/new-project"
    });
    const createRemoteProject = (createIfMissing: boolean, workspacePath = inspection.path) => create(OperationMutationSchema, {
      preconditions: [{
        entity: { kind: EntityKind.TARGET, id: targetId }, expectedRevision: { value: targetRevision }
      }],
      payload: { case: "createRemoteTarget", value: {
        backendId: fixture.adapter().id,
        displayName: "Remote E2E project",
        hostTargetId: targetId,
        hostId: host.id,
        expectedHostRevision: { value: host.revision },
        workspacePath,
        createIfMissing
      } }
    });
    const refused = await submit(
      paired.clients.operation, paired.connectionId, createRemoteProject(false)
    );
    expect(refused).toMatchObject({
      state: OperationState.FAILED,
      error: { code: "EFFECT_FAILED", message: expect.stringContaining("The SSH project directory does not exist.") }
    });
    expect(createdRemoteDirectory).toBe(false);
    const createdOperation = await submit(
      paired.clients.operation, paired.connectionId, createRemoteProject(true, requestedPath)
    );
    expect(createdOperation.state).toBe(OperationState.SUCCEEDED);
    if (createdOperation.result?.payload.case !== "target") throw new Error("Remote project creation returned no Target.");
    const createdTarget = createdOperation.result.payload.value;
    expect(createdTarget.location?.kind).toMatchObject({
      case: "sshHost",
      value: { hostTargetId: targetId, hostId: host.id, workspaceRootDisplay: "/srv/new-project" }
    });
    expect(fixture.application.store.getTarget(createdTarget.targetId).descriptor.remoteWorkspace).toEqual({
      kind: "ssh", hostTargetId: targetId, hostId: host.id, workspaceRoot: "/srv/new-project"
    });
    expect(fixture.application.workspaces.listRegistrations()).toContainEqual(expect.objectContaining({
      id: createdTarget.workspaceId,
      root: "/srv/new-project",
      remote: {
        targetId: createdTarget.targetId,
        binding: { kind: "ssh", hostTargetId: targetId, hostId: host.id, workspaceRoot: "/srv/new-project" }
      }
    }));
    expect(files.mkdir).toHaveBeenCalledWith("/srv/new-project", expect.objectContaining({ recursive: true, mode: 0o700 }));
    expect(connect).toHaveBeenCalledOnce();

    const authority = await registry.captureTransportAuthority(targetId, host.id);
    const observed: string[] = [];
    const unsubscribe = registry.subscribe(targetId, change => {
      if (change.host.id === host.id) observed.push(change.host.status.state);
    });
    try {
      lifetimes[0]!.abort();
      expect(registry.get(targetId, host.id).status.state).toBe("disconnected");
      expect(() => authority.assertCurrent()).toThrow(/authority changed/);
      await expect(client(paired.authKey).listRemoteHostDirectories(request)).rejects.toMatchObject({ code: Code.Aborted });
      const recovered = await waitFor(async () => registry.get(targetId, host.id), value => value.status.state === "ready",
        "original SSH Host to authenticate on its replacement carrier");
      expect(observed).toEqual(["disconnected", "connecting", "authenticating", "ready"]);
      expect(recovered.trust).toEqual(host.trust);
      expect(recovered.revision).toBeGreaterThan(host.revision);
      expect(connect).toHaveBeenCalledTimes(2);
      const newListing = await client(paired.authKey).listRemoteHostDirectories({ ...request,
        expectedHostRevision: { value: recovered.revision } });
      expect(newListing).toMatchObject({ path: listing.path, hostRevision: { value: recovered.revision },
        directories: listing.directories });
    } finally {
      unsubscribe();
    }
  } finally {
    await fixture.close();
  }
});

const browserPath = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
const webDirectory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();

it.skipIf(!browserPath || !webDirectory)("downloads the original named SSH directory from task history and Files", { timeout: 90_000 }, async () => {
  const workspaceRoot = "/srv/project";
  const folder = `${workspaceRoot}/docs`;
  const guide = Buffer.from("Remote guide bytes");
  const binary = Buffer.from([0, 1, 254, 255]);
  const directories = [workspaceRoot, folder, `${folder}/nested`, `${folder}/nested/empty`];
  const contents = new Map([[ `${folder}/guide.txt`, guide ], [ `${folder}/nested/data.bin`, binary ]]);
  const files: RemoteFileTransportPort = {
    realpath: async path => path,
    stat: async path => {
      const bytes = contents.get(path);
      if (bytes !== undefined) return { kind: "file", size: bytes.length, modifiedAt: 10, mode: 0o644 };
      if (directories.includes(path)) return { kind: "directory", size: 0, modifiedAt: 10, mode: 0o755 };
      throw new Error("The fixture has no such entry.");
    },
    list: async path => [
      ...directories.filter(child => posix.dirname(child) === path).map(child => ({ kind: "directory" as const, name: posix.basename(child) })),
      ...[...contents.keys()].filter(child => posix.dirname(child) === path).map(child => ({ kind: "file" as const, name: posix.basename(child) }))
    ],
    read: async ({ path, maximumBytes }) => {
      const bytes = contents.get(path);
      if (bytes === undefined) throw new Error("The fixture has no such file.");
      return bytes.subarray(0, maximumBytes);
    },
    write: vi.fn(async () => { throw new Error("A directory download may not write on the source."); }),
    mkdir: vi.fn(async () => { throw new Error("A directory download may not create source entries."); }),
    rename: vi.fn(async () => { throw new Error("A directory download may not rename source entries."); }),
    remove: vi.fn(async () => { throw new Error("A directory download may not remove source entries."); })
  };
  const capabilities = { commandExecution: true, processStreaming: true, fileTransfer: true, tcpForwarding: false, interactiveTerminal: false };
  const profile = { ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "workspace.files", supported: true }] };
  const fixture = await OrchestratorE2eFixture.start({ profiles: [profile], webDirectory, createAuxiliaryServices: async store => ({
    remoteHosts: new RemoteHostRegistry({ store, ownerId: "remote-directory-download-test", connector: {
      capabilities,
      connect: async request => {
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(4, 5, 6) });
        request.onAuthenticating();
        return { capabilities, files, processes: { open: async () => { throw new Error("The download uses only the SSH file port."); } },
          close: async () => undefined };
      }
    } })
  }) });
  let browser: Browser | undefined;
  try {
    const registry = fixture.application.remoteHosts!;
    const store = fixture.application.store;
    const backendId = fixture.adapter().id;
    const hostTargetId = fixture.targetId();
    const host = registry.create({ targetId: hostTargetId, id: "directory-download-host", hostname: "owned-ssh.invalid", user: "fixture", source: "manual" });
    expect((await registry.connect(hostTargetId, host.id, host.revision)).ok).toBe(true);
    const workspaceId = "remote-folder-workspace", targetId = "remote-folder-project", sessionId = "remote-folder-task";
    const binding = { kind: "ssh" as const, hostTargetId, hostId: host.id, workspaceRoot };
    store.upsertTarget({ id: targetId, backendId, displayName: "Remote folder project", workspaceRoot, managed: false,
      trusted: true, remoteWorkspace: binding }, { workspaceId });
    await fixture.application.workspaces.register({ id: workspaceId, root: workspaceRoot, displayName: "Remote folder project",
      trusted: true, remote: { targetId, binding } });
    store.createSession({ id: sessionId, backendId, targetId, title: "Remote folder task", remoteWorkspace: binding,
      binding: { opaqueRef: "remote-folder-native", generation: 1 }, pinned: false, archived: false, permissionMode: "ask",
      planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
    store.appendEvent({ id: "remote-folder-link", backendId, targetId, sessionId, generation: 1, traceId: "remote-folder-link",
      payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "[Remote docs](./docs/)" }] } });
    await expect(fixture.anonymous.workspace.prepareWorkspaceDirectoryDownload({ workspaceId, relativePath: "docs" }))
      .rejects.toMatchObject({ code: Code.Unauthenticated });

    browser = await chromium.launch({ executablePath: browserPath!, headless: true });
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 960 }, acceptDownloads: true });
    const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Directory download Browser" })).challenge!;
    await page.goto(`${fixture.baseUrl}/#/tasks/${sessionId}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add Joko node", exact: true }).click();
    await page.locator("details.device-authorization__manual > summary").click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
    await page.getByLabel("Device name").fill("Directory download Browser");
    await page.locator("form.pair-form button[type=submit]").click();
    const link = page.getByRole("link", { name: "Remote docs", exact: true });
    await link.click({ button: "right" });
    const checkDownload = async (): Promise<void> => {
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("menuitem", { name: "Download folder", exact: true }).click()
      ]);
      expect(download.suggestedFilename()).toBe("docs.tar.gz");
      const path = (await download.path())!;
      const members = execFileSync("tar", ["-tzf", path], { encoding: "utf8" }).trim().split(/\r?\n/u);
      expect(members.map(name => name.replace(/^\.\//u, "")).sort()).toEqual([
        "docs/", "docs/guide.txt", "docs/nested/", "docs/nested/data.bin", "docs/nested/empty/"
      ]);
      for (const [name, bytes] of [["docs/guide.txt", guide], ["docs/nested/data.bin", binary]] as const) {
        const member = members.find(value => value.replace(/^\.\//u, "") === name)!;
        expect(execFileSync("tar", ["-xOzf", path, member])).toEqual(bytes);
      }
    };
    await checkDownload();
    await page.goto(`${fixture.baseUrl}/#/files/${encodeURIComponent(sessionId)}`);
    const row = page.locator('[data-workspace-tree-row][data-relative-path="docs"]');
    await row.click({ button: "right" });
    await checkDownload();
    expect(files.write).not.toHaveBeenCalled();
    expect(files.remove).not.toHaveBeenCalled();
  } finally {
    await browser?.close();
    await fixture.close();
  }
});

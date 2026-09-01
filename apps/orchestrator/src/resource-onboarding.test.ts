import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import type { PiPackageAcquisition, PiPackageAcquisitionRequest } from "./resource-acquisition.js";
import { PiResourceManager } from "./resource-manager.js";
import { SessionHost } from "./session-host.js";

const cleanups: Array<() => Promise<void> | void> = [];

class FakeAcquisition implements PiPackageAcquisition {
  readonly requests: PiPackageAcquisitionRequest[] = [];

  async acquire(request: PiPackageAcquisitionRequest) {
    this.requests.push({ ...request, source: { ...request.source } });
    const packageRoot = join(request.destinationRoot, "package");
    await mkdir(packageRoot, { recursive: true });
    const version = request.source.kind === "npm" ? request.source.versionSpec ?? "latest" : request.source.kind === "git" ? request.source.ref ?? "HEAD" : "local";
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-package", version }), "utf8");
    return { rootPath: packageRoot, version };
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Pi resource production onboarding", () => {
  it("requires Target trust, discovers inert project resources, and completes owner approval/enable through Connect operations", async () => {
    const fixture = await createFixture(false);
    const skill = join(fixture.workspace, ".pi", "skills", "review");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "# Review\n", "utf8");

    await expect(submit(fixture.services, "discover-untrusted", {
      case: "discoverProjectResources",
      value: create(contract.DiscoverProjectResourcesMutationSchema, { targetId: "target-project" })
    })).rejects.toMatchObject({ code: 9 });

    fixture.store.upsertTarget({
      id: "target-project",
      backendId: "pi",
      displayName: "Project",
      workspaceRoot: fixture.workspace,
      managed: false,
      trusted: true
    });
    await submit(fixture.services, "discover-trusted", {
      case: "discoverProjectResources",
      value: create(contract.DiscoverProjectResourcesMutationSchema, { targetId: "target-project" })
    });
    const [discovered] = fixture.resources.list({ targetId: "target-project" });
    expect(discovered).toMatchObject({ kind: "skill", state: "awaiting_approval", enabled: false });
    expect((await fixture.resources.targetRuntimeSnapshot("pi", "target-project")).resources).toEqual([]);

    await submit(fixture.services, "approve-project-resource", {
      case: "approveResource",
      value: create(contract.ApproveResourceMutationSchema, {
        resourceId: discovered!.id,
        discoveredRevision: discovered!.discoveredRevision
      })
    });
    await submit(fixture.services, "enable-project-resource", {
      case: "setResourceEnabled",
      value: create(contract.SetResourceEnabledMutationSchema, { resourceId: discovered!.id, enabled: true })
    });
    expect((await fixture.resources.targetRuntimeSnapshot("pi", "target-project")).skills).toHaveLength(1);

    const response = await invoke(fixture.services.pi.listPiResources, {
      backendId: "pi",
      targetId: "target-project",
      page: { pageSize: 100 }
    }) as contract.ListPiResourcesResponse;
    expect(response.resources[0]).toMatchObject({
      resourceId: discovered!.id,
      state: contract.ResourceState.APPROVED,
      discoveredRevision: discovered!.discoveredRevision
    });
  });

  it("adds, approves, installs, enables, and removes an explicitly owner-selected managed resource", async () => {
    const fixture = await createFixture(true);
    const source = join(fixture.root, "owner-skill");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# Owner skill\n", "utf8");

    await submit(fixture.services, "add-managed-resource", {
      case: "addResource",
      value: create(contract.AddResourceMutationSchema, {
        backendId: "pi",
        kind: contract.ResourceKind.SKILL,
        scope: contract.ResourceScope.MANAGED,
        acquisition: create(contract.ResourceAcquisitionSourceSchema, {
          source: { case: "local", value: create(contract.LocalResourceAcquisitionSchema, { serverPath: source }) }
        }),
        name: "Owner skill"
      })
    });
    const [discovered] = fixture.resources.list({ backendId: "pi" });
    await submit(fixture.services, "approve-managed-resource", {
      case: "approveResource",
      value: create(contract.ApproveResourceMutationSchema, { resourceId: discovered!.id, discoveredRevision: discovered!.discoveredRevision })
    });
    await submit(fixture.services, "install-managed-resource", {
      case: "installResource",
      value: create(contract.InstallResourceMutationSchema, { resourceId: discovered!.id })
    });
    await submit(fixture.services, "enable-managed-resource", {
      case: "setResourceEnabled",
      value: create(contract.SetResourceEnabledMutationSchema, { resourceId: discovered!.id, enabled: true })
    });
    expect((await fixture.resources.runtimeSnapshot("pi")).skills).toHaveLength(1);

    await writeFile(join(source, "SKILL.md"), "# Owner skill v2\n", "utf8");
    await submit(fixture.services, "rediscover-managed-resource", {
      case: "addResource",
      value: create(contract.AddResourceMutationSchema, {
        backendId: "pi",
        kind: contract.ResourceKind.SKILL,
        scope: contract.ResourceScope.MANAGED,
        acquisition: create(contract.ResourceAcquisitionSourceSchema, {
          source: { case: "local", value: create(contract.LocalResourceAcquisitionSchema, { serverPath: source }) }
        }),
        name: "Owner skill"
      })
    });
    expect(fixture.resources.get(discovered!.id)).toMatchObject({ state: "update_available", enabled: false });
    await submit(fixture.services, "update-managed-resource", {
      case: "updateResource",
      value: create(contract.UpdateResourceMutationSchema, { resourceId: discovered!.id })
    });
    await submit(fixture.services, "enable-updated-resource", {
      case: "setResourceEnabled",
      value: create(contract.SetResourceEnabledMutationSchema, { resourceId: discovered!.id, enabled: true })
    });
    expect((await fixture.resources.runtimeSnapshot("pi")).resources).toMatchObject([{ id: discovered!.id }]);

    await submit(fixture.services, "remove-managed-resource", {
      case: "removeResource",
      value: create(contract.RemoveResourceMutationSchema, { resourceId: discovered!.id })
    });
    expect(fixture.resources.get(discovered!.id)).toMatchObject({ state: "removed", enabled: false });
    expect((await fixture.resources.runtimeSnapshot("pi")).skills).toEqual([]);
  });

  it("accepts typed local/npm/git sources without treating server_path as a URL", async () => {
    const acquisition = new FakeAcquisition();
    const fixture = await createFixture(true, acquisition);
    const localSource = join(fixture.root, "typed-local-skill");
    await mkdir(localSource);
    await writeFile(join(localSource, "SKILL.md"), "# Typed local\n", "utf8");

    await submit(fixture.services, "typed-local", {
      case: "addResource",
      value: create(contract.AddResourceMutationSchema, {
        backendId: "pi",
        kind: contract.ResourceKind.SKILL,
        scope: contract.ResourceScope.USER,
        acquisition: create(contract.ResourceAcquisitionSourceSchema, {
          source: { case: "local", value: create(contract.LocalResourceAcquisitionSchema, { serverPath: localSource }) }
        })
      })
    });
    await submit(fixture.services, "typed-npm", {
      case: "addResource",
      value: create(contract.AddResourceMutationSchema, {
        backendId: "pi",
        kind: contract.ResourceKind.PACKAGE,
        scope: contract.ResourceScope.GLOBAL,
        name: "typed-npm",
        acquisition: create(contract.ResourceAcquisitionSourceSchema, {
          source: { case: "npm", value: create(contract.NpmResourceAcquisitionSchema, { packageName: "typed-npm", versionSpec: "1.0.0" }) }
        })
      })
    });
    await submit(fixture.services, "typed-git", {
      case: "addResource",
      value: create(contract.AddResourceMutationSchema, {
        backendId: "pi",
        kind: contract.ResourceKind.PACKAGE,
        scope: contract.ResourceScope.MANAGED,
        name: "typed-git",
        acquisition: create(contract.ResourceAcquisitionSourceSchema, {
          source: { case: "git", value: create(contract.GitResourceAcquisitionSchema, { repositoryUrl: "https://example.test/org/repo.git", ref: "v1" }) }
        })
      })
    });
    expect(acquisition.requests).toEqual([]);

    for (const resource of fixture.resources.list().filter((item) => item.sourceKind !== "local")) {
      await submit(fixture.services, `approve-${resource.id}`, {
        case: "approveResource",
        value: create(contract.ApproveResourceMutationSchema, { resourceId: resource.id, discoveredRevision: resource.discoveredRevision })
      });
      await submit(fixture.services, `install-${resource.id}`, {
        case: "installResource",
        value: create(contract.InstallResourceMutationSchema, { resourceId: resource.id })
      });
    }
    expect(acquisition.requests.map((request) => request.source.kind).sort()).toEqual(["git", "npm"]);

    const response = await invoke(fixture.services.pi.listPiResources, {
      backendId: "pi",
      page: { pageSize: 100 }
    }) as contract.ListPiResourcesResponse;
    expect(response.resources.map((resource) => resource.source?.acquisitionKind).sort()).toEqual([
      contract.ResourceAcquisitionKind.LOCAL,
      contract.ResourceAcquisitionKind.NPM,
      contract.ResourceAcquisitionKind.GIT
    ].sort());
    expect(response.resources.find((resource) => resource.name === "typed-npm")?.source?.sourceIdentity).toBe("npm:typed-npm");
  });
});

async function createFixture(trusted: boolean, acquisition?: PiPackageAcquisition) {
  const root = await mkdtemp(join(tmpdir(), "joko-resource-onboarding-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "latest-installed",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map([["runtime.resources", { key: "runtime.resources", supported: true }]]),
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget({ id: "target-project", backendId: "pi", displayName: "Project", workspaceRoot: workspace, managed: false, trusted });
  const connection = store.createConnection({ id: "connection-owner", name: "Owner", authKeyDigest: "digest" });
  const resources = new PiResourceManager({
    store,
    managedRoot: join(root, "managed-resources"),
    ...(acquisition === undefined ? {} : { acquisition })
  });
  await resources.initialize();
  const sessionHost = new SessionHost(store, {} as never, []);
  const application = {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections: { authenticate: () => connection },
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost,
    scheduler: {},
    adapters: [],
    piResources: resources,
    refreshPiGeneration: async () => undefined,
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
  const services = createConnectServices(application);
  cleanups.push(async () => {
    await sessionHost.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, store, resources, services };
}

async function submit(services: ReturnType<typeof createConnectServices>, operationId: string, payload: contract.OperationMutation["payload"]): Promise<void> {
  await invoke(services.operation.submitOperation, {
    operationId,
    connectionId: "connection-owner",
    mutation: create(contract.OperationMutationSchema, { payload })
  });
}

async function invoke(handler: unknown, request: unknown): Promise<unknown> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (request: unknown, context: unknown) => unknown)(request, {
    requestHeader: new Headers(),
    signal: new AbortController().signal
  });
}

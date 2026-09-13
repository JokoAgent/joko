import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("does not adopt a project discovery batch when the Backend resource capability changes during inspection", async () => {
    const fixture = await createFixture(true);
    const skill = join(fixture.workspace, ".pi", "skills", "review");
    const prompt = join(fixture.workspace, ".pi", "prompts");
    await mkdir(skill, { recursive: true });
    await mkdir(prompt, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "# Review\n", "utf8");
    await writeFile(join(prompt, "release.md"), "Review the release.\n", "utf8");
    const prepare = fixture.resources.prepareDiscoverProjectResources.bind(fixture.resources);
    fixture.resources.prepareDiscoverProjectResources = async (input) => {
      const prepared = await prepare(input);
      upsertResourceBackend(fixture.store, "pi", ["prompt"]);
      return prepared;
    };

    const response = await submit(fixture.services, "discover-capability-race", {
      case: "discoverProjectResources",
      value: create(contract.DiscoverProjectResourcesMutationSchema, { targetId: "target-project" })
    });

    expect(response.operation?.state).toBe(contract.OperationState.FAILED);
    expect(response.operation?.error?.message).toContain("authority changed");
    expect(fixture.resources.list({ targetId: "target-project" })).toEqual([]);
    expect(fixture.store.findSetting("service", "orchestrator", "pi_resource_catalog")).toBeUndefined();
    const reopened = new PiResourceManager({
      store: fixture.store,
      managedRoot: join(fixture.root, "managed-resources")
    });
    await reopened.initialize();
    expect(reopened.list({ targetId: "target-project" })).toEqual([]);
  });

  it("keeps archive navigation-only but rejects deletion during a prepared project discovery", async () => {
    const archived = await createFixture(true);
    const archivedSkill = join(archived.workspace, ".pi", "skills", "review");
    await mkdir(archivedSkill, { recursive: true });
    await writeFile(join(archivedSkill, "SKILL.md"), "# Review\n", "utf8");
    const prepareArchived = archived.resources.prepareDiscoverProjectResources.bind(archived.resources);
    archived.resources.prepareDiscoverProjectResources = async (input) => {
      const prepared = await prepareArchived(input);
      const target = archived.store.getTarget(input.targetId);
      archived.store.upsertTarget(target.descriptor, { ...asTestRecord(target.metadata), state: "archived", archivedAt: 1 });
      return prepared;
    };
    await submit(archived.services, "discover-while-archived", {
      case: "discoverProjectResources",
      value: create(contract.DiscoverProjectResourcesMutationSchema, { targetId: "target-project" })
    });
    expect(archived.resources.list({ targetId: "target-project" })).toHaveLength(1);

    const deleted = await createFixture(true);
    const deletedSkill = join(deleted.workspace, ".pi", "skills", "review");
    await mkdir(deletedSkill, { recursive: true });
    await writeFile(join(deletedSkill, "SKILL.md"), "# Review\n", "utf8");
    const prepareDeleted = deleted.resources.prepareDiscoverProjectResources.bind(deleted.resources);
    deleted.resources.prepareDiscoverProjectResources = async (input) => {
      const prepared = await prepareDeleted(input);
      const target = deleted.store.getTarget(input.targetId);
      deleted.store.upsertTarget(target.descriptor, { ...asTestRecord(target.metadata), state: "archived", deletedAt: 2 });
      return prepared;
    };
    const response = await submit(deleted.services, "discover-deletion-race", {
      case: "discoverProjectResources",
      value: create(contract.DiscoverProjectResourcesMutationSchema, { targetId: "target-project" })
    });
    expect(response.operation?.state).toBe(contract.OperationState.FAILED);
    expect(response.operation?.error?.message).toContain("Deleted Targets");
    expect(deleted.resources.list({ targetId: "target-project" })).toEqual([]);
    expect(deleted.store.findSetting("service", "orchestrator", "pi_resource_catalog")).toBeUndefined();
  });

  it("does not publish approval when Backend capability changes after resource inspection", async () => {
    const fixture = await createFixture(true);
    const skill = join(fixture.workspace, ".pi", "skills", "review");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "# Review\n", "utf8");
    await submit(fixture.services, "discover-before-approval-race", {
      case: "discoverProjectResources",
      value: create(contract.DiscoverProjectResourcesMutationSchema, { targetId: "target-project" })
    });
    const [resource] = fixture.resources.list({ targetId: "target-project" });
    const versionBefore = resource!.versionNumber;
    const prepare = fixture.resources.prepareApprove.bind(fixture.resources);
    fixture.resources.prepareApprove = async (...input) => {
      const prepared = await prepare(...input);
      upsertResourceBackend(fixture.store, "pi", ["prompt"]);
      return prepared;
    };

    const response = await submit(fixture.services, "approve-capability-race", {
      case: "approveResource",
      value: create(contract.ApproveResourceMutationSchema, {
        resourceId: resource!.id,
        discoveredRevision: resource!.discoveredRevision
      })
    });

    expect(response.operation?.state).toBe(contract.OperationState.FAILED);
    expect(fixture.resources.get(resource!.id)).toMatchObject({
      state: "awaiting_approval",
      enabled: false,
      versionNumber: versionBefore
    });
    expect(fixture.refreshPiGeneration).not.toHaveBeenCalled();
    const reopened = new PiResourceManager({
      store: fixture.store,
      managedRoot: join(fixture.root, "managed-resources")
    });
    await reopened.initialize();
    expect(reopened.get(resource!.id)).toMatchObject({
      state: "awaiting_approval",
      enabled: false,
      versionNumber: versionBefore
    });
  });

  it("retires a prepared install candidate when final Backend authority is lost", async () => {
    const fixture = await createFixture(true);
    const source = join(fixture.root, "prepared-install-skill");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# Prepared install\n", "utf8");
    await submit(fixture.services, "add-before-install-race", {
      case: "addResource",
      value: create(contract.AddResourceMutationSchema, {
        backendId: "pi",
        kind: contract.ResourceKind.SKILL,
        scope: contract.ResourceScope.MANAGED,
        acquisition: create(contract.ResourceAcquisitionSourceSchema, {
          source: { case: "local", value: create(contract.LocalResourceAcquisitionSchema, { serverPath: source }) }
        })
      })
    });
    const [resource] = fixture.resources.list({ backendId: "pi" });
    await submit(fixture.services, "approve-before-install-race", {
      case: "approveResource",
      value: create(contract.ApproveResourceMutationSchema, {
        resourceId: resource!.id,
        discoveredRevision: resource!.discoveredRevision
      })
    });
    const prepare = fixture.resources.prepareInstall.bind(fixture.resources);
    fixture.resources.prepareInstall = async (resourceId) => {
      const prepared = await prepare(resourceId);
      upsertResourceBackend(fixture.store, "pi", ["prompt"]);
      return prepared;
    };

    const response = await submit(fixture.services, "install-capability-race", {
      case: "installResource",
      value: create(contract.InstallResourceMutationSchema, { resourceId: resource!.id })
    });

    expect(response.operation?.state).toBe(contract.OperationState.FAILED);
    expect(fixture.resources.get(resource!.id)).toMatchObject({ state: "approved", enabled: false });
    expect(fixture.resources.get(resource!.id)).not.toHaveProperty("installedPath");
    expect(await readdir(join(fixture.root, "managed-resources", "skills"), { recursive: true })).toEqual([]);
    expect(fixture.refreshPiGeneration).toHaveBeenCalledTimes(1);
  });

  it("rejects a prepared install after same-capability Backend replacement", async () => {
    const fixture = await createFixture(true);
    const source = join(fixture.root, "prepared-install-generation-skill");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# Prepared generation install\n", "utf8");
    await submit(fixture.services, "add-before-generation-race", {
      case: "addResource",
      value: create(contract.AddResourceMutationSchema, {
        backendId: "pi",
        kind: contract.ResourceKind.SKILL,
        scope: contract.ResourceScope.MANAGED,
        acquisition: create(contract.ResourceAcquisitionSourceSchema, {
          source: { case: "local", value: create(contract.LocalResourceAcquisitionSchema, { serverPath: source }) }
        })
      })
    });
    const [resource] = fixture.resources.list({ backendId: "pi" });
    await submit(fixture.services, "approve-before-generation-race", {
      case: "approveResource",
      value: create(contract.ApproveResourceMutationSchema, {
        resourceId: resource!.id,
        discoveredRevision: resource!.discoveredRevision
      })
    });
    const prepare = fixture.resources.prepareInstall.bind(fixture.resources);
    fixture.resources.prepareInstall = async (resourceId) => {
      const prepared = await prepare(resourceId);
      const current = fixture.store.getBackend("pi").descriptor;
      const reservation = fixture.store.reserveBackendInstanceGeneration({
        backendId: current.id,
        adapterKind: current.adapterKind
      });
      const publication = fixture.store.publishBackendInstanceDescriptor({
        descriptor: { ...current, instanceGeneration: reservation.generation },
        ...(reservation.expectedCurrentGeneration === undefined
          ? {}
          : { expectedCurrentGeneration: reservation.expectedCurrentGeneration })
      });
      if (publication.status !== "published") throw new Error("Fixture Backend publication lost its generation fence.");
      return prepared;
    };

    const response = await submit(fixture.services, "install-generation-race", {
      case: "installResource",
      value: create(contract.InstallResourceMutationSchema, { resourceId: resource!.id })
    });

    expect(response.operation?.state).toBe(contract.OperationState.FAILED);
    expect(response.operation?.error?.message).toContain("Backend authority changed");
    expect(fixture.resources.get(resource!.id)).toMatchObject({ state: "approved", enabled: false });
    expect(await readdir(join(fixture.root, "managed-resources", "skills"), { recursive: true })).toEqual([]);
    expect(fixture.refreshPiGeneration).toHaveBeenCalledTimes(1);
  });

  it("keeps a committed resource Operation truthful when runtime reconciliation fails", async () => {
    const fixture = await createFixture(true);
    const skill = join(fixture.workspace, ".pi", "skills", "review");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "# Review\n", "utf8");
    await submit(fixture.services, "discover-before-refresh-failure", {
      case: "discoverProjectResources",
      value: create(contract.DiscoverProjectResourcesMutationSchema, { targetId: "target-project" })
    });
    const [resource] = fixture.resources.list({ targetId: "target-project" });
    fixture.refreshPiGeneration.mockRejectedValueOnce(new Error("private runtime path"));
    const approval = {
      case: "approveResource",
      value: create(contract.ApproveResourceMutationSchema, {
        resourceId: resource!.id,
        discoveredRevision: resource!.discoveredRevision
      })
    } as const;

    const response = await submit(fixture.services, "approve-with-refresh-failure", approval);
    expect(response.operation?.state).toBe(contract.OperationState.SUCCEEDED);
    expect(fixture.resources.get(resource!.id).state).toBe("approved");
    expect(fixture.store.listDiagnostics({ component: "resource-runtime" })).toMatchObject([{
      code: "RESOURCE_RUNTIME_REFRESH_FAILED",
      details: { backendId: "pi", resourceId: resource!.id }
    }]);
    const replay = await submit(fixture.services, "approve-with-refresh-failure", approval);
    expect(replay.operation?.state).toBe(contract.OperationState.SUCCEEDED);
    expect(fixture.refreshPiGeneration).toHaveBeenCalledTimes(1);
  });

  it("fences old live catalogs for disable, remove, update, and enable commits", async () => {
    const fixture = await createFixture(true);
    const source = join(fixture.root, "catalog-fence-skill");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# Catalog fence v1\n", "utf8");
    const add = (operationId: string) => submit(fixture.services, operationId, {
      case: "addResource",
      value: create(contract.AddResourceMutationSchema, {
        backendId: "pi",
        kind: contract.ResourceKind.SKILL,
        scope: contract.ResourceScope.MANAGED,
        acquisition: create(contract.ResourceAcquisitionSourceSchema, {
          source: { case: "local", value: create(contract.LocalResourceAcquisitionSchema, { serverPath: source }) }
        })
      })
    });
    await add("add-catalog-fence-resource");
    const [resource] = fixture.resources.list({ backendId: "pi" });
    await submit(fixture.services, "approve-catalog-fence-resource", {
      case: "approveResource",
      value: create(contract.ApproveResourceMutationSchema, {
        resourceId: resource!.id,
        discoveredRevision: resource!.discoveredRevision
      })
    });
    await submit(fixture.services, "install-catalog-fence-resource", {
      case: "installResource",
      value: create(contract.InstallResourceMutationSchema, { resourceId: resource!.id })
    });
    const fence = vi.spyOn(fixture.sessionHost, "fenceBackendResourceCatalogs");
    const complete = vi.spyOn(fixture.sessionHost, "completeBackendResourceCatalogRefresh");
    const setEnabled = (operationId: string, enabled: boolean) => submit(fixture.services, operationId, {
      case: "setResourceEnabled",
      value: create(contract.SetResourceEnabledMutationSchema, { resourceId: resource!.id, enabled })
    });

    await setEnabled("enable-catalog-fence-resource", true);
    await setEnabled("disable-catalog-fence-resource", false);
    await setEnabled("reenable-catalog-fence-resource", true);
    await writeFile(join(source, "SKILL.md"), "# Catalog fence v2\n", "utf8");
    await add("rediscover-catalog-fence-resource");
    await submit(fixture.services, "update-catalog-fence-resource", {
      case: "updateResource",
      value: create(contract.UpdateResourceMutationSchema, { resourceId: resource!.id })
    });
    expect(fixture.resources.get(resource!.id)).toMatchObject({ state: "installed", enabled: true });
    await submit(fixture.services, "remove-catalog-fence-resource", {
      case: "removeResource",
      value: create(contract.RemoveResourceMutationSchema, { resourceId: resource!.id })
    });

    expect(fence).toHaveBeenCalledTimes(5);
    expect(fence.mock.calls.every(([backendId]) => backendId === "pi")).toBe(true);
    expect(complete).toHaveBeenCalledTimes(5);
    expect(complete.mock.calls.every(([backendId, , retained]) => backendId === "pi" && retained === true)).toBe(true);
  });

  it.each(["discover", "add"] as const)(
    "fences an enabled project resource changed through the %s entrypoint",
    async (entrypoint) => {
      const fixture = await createFixture(true);
      const skill = join(fixture.workspace, ".pi", "skills", `project-${entrypoint}`);
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, "SKILL.md"), "# Project resource v1\n", "utf8");
      const discover = (operationId: string) => entrypoint === "discover"
        ? submit(fixture.services, operationId, {
            case: "discoverProjectResources",
            value: create(contract.DiscoverProjectResourcesMutationSchema, { targetId: "target-project" })
          })
        : submit(fixture.services, operationId, {
            case: "addResource",
            value: create(contract.AddResourceMutationSchema, {
              backendId: "pi",
              targetId: "target-project",
              kind: contract.ResourceKind.SKILL,
              scope: contract.ResourceScope.PROJECT,
              acquisition: create(contract.ResourceAcquisitionSourceSchema, {
                source: { case: "local", value: create(contract.LocalResourceAcquisitionSchema, { serverPath: skill }) }
              })
            })
          });
      await discover(`initial-project-${entrypoint}`);
      const resource = fixture.resources.list({ targetId: "target-project" })
        .find((candidate) => candidate.name === `project-${entrypoint}`)!;
      await submit(fixture.services, `approve-project-${entrypoint}`, {
        case: "approveResource",
        value: create(contract.ApproveResourceMutationSchema, {
          resourceId: resource.id,
          discoveredRevision: resource.discoveredRevision
        })
      });
      await submit(fixture.services, `enable-project-${entrypoint}`, {
        case: "setResourceEnabled",
        value: create(contract.SetResourceEnabledMutationSchema, { resourceId: resource.id, enabled: true })
      });
      const fence = vi.spyOn(fixture.sessionHost, "fenceBackendResourceCatalogs");
      const complete = vi.spyOn(fixture.sessionHost, "completeBackendResourceCatalogRefresh");

      await writeFile(join(skill, "SKILL.md"), "# Project resource v2\n", "utf8");
      await discover(`changed-project-${entrypoint}`);

      expect(fixture.resources.get(resource.id)).toMatchObject({ state: "awaiting_approval", enabled: false });
      expect(fence).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0]?.[2]).toBe(true);
    }
  );

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
    expect(fixture.resources.get(discovered!.id)).toMatchObject({ state: "update_available", enabled: true });
    expect((await fixture.resources.runtimeSnapshot("pi")).skills).toHaveLength(1);
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

  it("limits resource kinds by the exact Backend capability and restarts a Claude runtime generation", async () => {
    const restartBackend = vi.fn(async () => undefined);
    const fixture = await createFixture(true, undefined, restartBackend);
    const upsertClaudeBackend = (options: readonly string[]): void => {
      fixture.store.upsertBackend({
        id: "claude-code",
        displayName: "Claude Code",
        version: "fixture",
        health: "healthy",
        adapterKind: "claude-agent-sdk-stdio",
        instanceGeneration: 1,
        installationState: "installed",
        authenticationState: "authenticated",
        capabilities: new Map([["runtime.resources", {
          key: "runtime.resources",
          supported: true,
          options
        }]]),
        models: [],
        tools: [],
        diagnostics: []
      });
    };
    upsertClaudeBackend(["skill", "prompt"]);
    const claudeWorkspace = join(fixture.root, "claude-workspace");
    await mkdir(join(claudeWorkspace, ".claude", "skills", "review"), { recursive: true });
    await mkdir(join(claudeWorkspace, ".claude", "commands"), { recursive: true });
    await mkdir(join(claudeWorkspace, ".claude", "agents"), { recursive: true });
    await mkdir(join(claudeWorkspace, ".pi", "extensions"), { recursive: true });
    await mkdir(join(claudeWorkspace, ".pi", "skills", "review"), { recursive: true });
    await mkdir(join(claudeWorkspace, ".pi", "prompts"), { recursive: true });
    await mkdir(join(claudeWorkspace, ".pi", "themes"), { recursive: true });
    await mkdir(join(claudeWorkspace, ".pi", "packages", "fixture"), { recursive: true });
    await writeFile(join(claudeWorkspace, ".claude", "skills", "review", "SKILL.md"), "# Claude review\n", "utf8");
    await writeFile(join(claudeWorkspace, ".claude", "commands", "review.md"), "Review with Claude.\n", "utf8");
    await writeFile(join(claudeWorkspace, ".claude", "agents", "reviewer.md"), "Agent-only customization.\n", "utf8");
    await writeFile(join(claudeWorkspace, ".pi", "extensions", "extension.ts"), "export default () => {};\n", "utf8");
    await writeFile(join(claudeWorkspace, ".pi", "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(join(claudeWorkspace, ".pi", "prompts", "review.md"), "Review this.\n", "utf8");
    await writeFile(join(claudeWorkspace, ".pi", "themes", "night.json"), "{}\n", "utf8");
    await writeFile(join(claudeWorkspace, ".pi", "packages", "fixture", "package.json"), "{}\n", "utf8");
    fixture.store.upsertTarget({
      id: "claude-project",
      backendId: "claude-code",
      displayName: "Claude project",
      workspaceRoot: claudeWorkspace,
      managed: false,
      trusted: true
    });
    const prompt = join(fixture.root, "claude-prompt.md");
    await writeFile(prompt, "Review the release evidence.\n", "utf8");

    const discoverClaudeProject = {
      case: "discoverProjectResources",
      value: create(contract.DiscoverProjectResourcesMutationSchema, { targetId: "claude-project" })
    } as const;
    await submit(fixture.services, "discover-claude-project", discoverClaudeProject);
    expect(fixture.resources.list({
      backendId: "claude-code",
      targetId: "claude-project"
    }).map((resource) => [resource.kind, resource.name]).sort()).toEqual([
      ["prompt", "review"],
      ["skill", "review"]
    ]);

    await expect(submit(fixture.services, "reject-claude-extension", {
      case: "addResource",
      value: create(contract.AddResourceMutationSchema, {
        backendId: "claude-code",
        kind: contract.ResourceKind.EXTENSION,
        scope: contract.ResourceScope.MANAGED,
        acquisition: create(contract.ResourceAcquisitionSourceSchema, {
          source: { case: "local", value: create(contract.LocalResourceAcquisitionSchema, { serverPath: prompt }) }
        })
      })
    })).rejects.toMatchObject({ code: 9 });

    const addClaudePrompt = {
      case: "addResource",
      value: create(contract.AddResourceMutationSchema, {
        backendId: "claude-code",
        kind: contract.ResourceKind.PROMPT_TEMPLATE,
        scope: contract.ResourceScope.MANAGED,
        acquisition: create(contract.ResourceAcquisitionSourceSchema, {
          source: { case: "local", value: create(contract.LocalResourceAcquisitionSchema, { serverPath: prompt }) }
        })
      })
    } as const;
    await submit(fixture.services, "add-claude-prompt", addClaudePrompt);
    const resource = fixture.resources.list({ backendId: "claude-code" })
      .find((candidate) => candidate.targetId === undefined);
    await submit(fixture.services, "approve-claude-prompt", {
      case: "approveResource",
      value: create(contract.ApproveResourceMutationSchema, {
        resourceId: resource!.id,
        discoveredRevision: resource!.discoveredRevision
      })
    });
    await submit(fixture.services, "install-claude-prompt", {
      case: "installResource",
      value: create(contract.InstallResourceMutationSchema, { resourceId: resource!.id })
    });
    const enablePrompt = {
      case: "setResourceEnabled",
      value: create(contract.SetResourceEnabledMutationSchema, { resourceId: resource!.id, enabled: true })
    } as const;
    await submit(fixture.services, "enable-claude-prompt", enablePrompt);
    const [seed] = await fixture.resources.runtimeTextSnapshot(
      "claude-code",
      "claude-project",
      new AbortController().signal
    );
    expect(() => seed!.assertCurrent()).not.toThrow();

    expect(restartBackend).toHaveBeenCalledTimes(3);
    expect(restartBackend).toHaveBeenNthCalledWith(1, "claude-code");
    expect(fixture.refreshPiGeneration).not.toHaveBeenCalled();

    upsertClaudeBackend([]);
    await expect(fixture.resources.runtimeTextSnapshot(
      "claude-code",
      "claude-project",
      new AbortController().signal
    )).resolves.toEqual([]);
    expect(() => seed!.assertCurrent()).toThrow(/no longer current/u);
    expect((await submit(fixture.services, "discover-claude-project", discoverClaudeProject)).operation?.state)
      .toBe(contract.OperationState.SUCCEEDED);
    expect((await submit(fixture.services, "add-claude-prompt", addClaudePrompt)).operation?.state)
      .toBe(contract.OperationState.SUCCEEDED);
    const replay = await submit(fixture.services, "enable-claude-prompt", enablePrompt);
    expect(replay.operation?.state).toBe(contract.OperationState.SUCCEEDED);
    expect(restartBackend).toHaveBeenCalledTimes(3);
    await submit(fixture.services, "disable-after-capability-removal", {
      case: "setResourceEnabled",
      value: create(contract.SetResourceEnabledMutationSchema, { resourceId: resource!.id, enabled: false })
    });
    expect(() => seed!.assertCurrent()).toThrow(/no longer current/u);
    await expect(submit(fixture.services, "reject-enable-after-capability-removal", {
      case: "setResourceEnabled",
      value: create(contract.SetResourceEnabledMutationSchema, { resourceId: resource!.id, enabled: true })
    })).rejects.toMatchObject({ code: 9 });
    const projectResource = fixture.resources.list({
      backendId: "claude-code",
      targetId: "claude-project"
    })[0]!;
    await expect(submit(fixture.services, "reject-approve-after-capability-removal", {
      case: "approveResource",
      value: create(contract.ApproveResourceMutationSchema, {
        resourceId: projectResource.id,
        discoveredRevision: projectResource.discoveredRevision
      })
    })).rejects.toMatchObject({ code: 9 });
    await expect(submit(fixture.services, "reject-empty-resource-options", {
      case: "discoverProjectResources",
      value: create(contract.DiscoverProjectResourcesMutationSchema, { targetId: "claude-project" })
    })).rejects.toMatchObject({ code: 9 });
    await submit(fixture.services, "remove-after-capability-removal", {
      case: "removeResource",
      value: create(contract.RemoveResourceMutationSchema, { resourceId: resource!.id })
    });
    expect(fixture.resources.get(resource!.id)).toMatchObject({ state: "removed", enabled: false });
    expect(restartBackend).toHaveBeenCalledTimes(5);
  });
});

async function createFixture(
  trusted: boolean,
  acquisition?: PiPackageAcquisition,
  restartBackend?: (backendId: string) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), "joko-resource-onboarding-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "latest-installed",
    health: "healthy",
    adapterKind: "pi",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map([["runtime.resources", {
      key: "runtime.resources",
      supported: true,
      options: ["extension", "skill", "prompt", "package"]
    }]]),
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
  const refreshPiGeneration = vi.fn(async () => undefined);
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
    ...(restartBackend === undefined ? {} : { restartBackend }),
    refreshPiGeneration,
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
  const services = createConnectServices(application);
  cleanups.push(async () => {
    await sessionHost.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, store, resources, services, refreshPiGeneration, sessionHost };
}

function upsertResourceBackend(
  store: OperationalStore,
  backendId: string,
  options: readonly string[]
): void {
  const current = store.getBackend(backendId).descriptor;
  store.upsertBackend({
    ...current,
    capabilities: new Map(current.capabilities).set("runtime.resources", {
      key: "runtime.resources",
      supported: true,
      options
    })
  });
}

function asTestRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

async function submit(
  services: ReturnType<typeof createConnectServices>,
  operationId: string,
  payload: contract.OperationMutation["payload"]
): Promise<contract.SubmitOperationResponse> {
  return await invoke(services.operation.submitOperation, {
    operationId,
    connectionId: "connection-owner",
    mutation: create(contract.OperationMutationSchema, { payload })
  }) as contract.SubmitOperationResponse;
}

async function invoke(handler: unknown, request: unknown): Promise<unknown> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (request: unknown, context: unknown) => unknown)(request, {
    requestHeader: new Headers(),
    signal: new AbortController().signal
  });
}

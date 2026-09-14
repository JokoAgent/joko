import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import {
  AddResourceMutationSchema,
  ApproveResourceMutationSchema,
  InstallResourceMutationSchema,
  OperationMutationSchema,
  OperationState,
  ResourceAcquisitionSourceSchema,
  ResourceKind,
  ResourceScope,
  SetResourceEnabledMutationSchema,
  type ManagedResource,
  type SkillDescriptor
} from "@joko/contracts";

import type { PairedClient } from "./connect-clients.js";
import { ExtensionLibrarySystemFixture as SkillSystemFixture } from "./extension-library-system-fixture.js";
import { submit } from "./operations.js";

export { SkillSystemFixture };

export interface InstalledSkillFixture {
  readonly sourceDirectory: string;
  readonly skill: SkillDescriptor;
}

export async function installLocalSkill(
  fixture: SkillSystemFixture,
  paired: PairedClient,
  name = "managed-review"
): Promise<InstalledSkillFixture> {
  const sourceDirectory = join(fixture.rootDirectory, `skill-source-${randomUUID()}`);
  await mkdir(join(sourceDirectory, "references"), { recursive: true });
  await Promise.all([
    writeFile(join(sourceDirectory, "SKILL.md"), [
      "---",
      `name: ${name}`,
      "description: Production Skill management fixture",
      "version: 1.0.0",
      "---",
      "# Original Skill",
      ""
    ].join("\n"), "utf8"),
    writeFile(join(sourceDirectory, "references", "guide.md"), "Production guide\n", "utf8")
  ]);

  const added = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
    payload: {
      case: "addResource",
      value: create(AddResourceMutationSchema, {
        backendId: "pi",
        kind: ResourceKind.SKILL,
        scope: ResourceScope.MANAGED,
        acquisition: create(ResourceAcquisitionSourceSchema, {
          source: { case: "local", value: { serverPath: sourceDirectory } }
        }),
        name
      })
    }
  }));
  requireSucceeded(added, "add the Skill Resource");
  const discovered = (await paired.clients.pi.listPiResources({
    backendId: "pi",
    kind: ResourceKind.SKILL,
    page: { pageSize: 500 }
  })).resources.find((resource) => resource.name === name);
  if (discovered === undefined) throw new Error("The production Resource catalog did not expose the added Skill.");

  const approved = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
    payload: {
      case: "approveResource",
      value: create(ApproveResourceMutationSchema, {
        resourceId: discovered.resourceId,
        discoveredRevision: discovered.discoveredRevision
      })
    }
  }));
  resourceFrom(approved, "approve the Skill Resource");

  const installed = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
    payload: {
      case: "installResource",
      value: create(InstallResourceMutationSchema, { resourceId: discovered.resourceId })
    }
  }));
  const installedResource = resourceFrom(installed, "install the Skill Resource");

  const enabled = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
    payload: {
      case: "setResourceEnabled",
      value: create(SetResourceEnabledMutationSchema, { resourceId: installedResource.resourceId, enabled: true })
    }
  }));
  resourceFrom(enabled, "enable the Skill Resource");

  const catalog = await paired.clients.skill.listSkills({
    query: name,
    page: { pageSize: 500 }
  });
  const skill = catalog.skills.find((entry) => entry.skillId === discovered.resourceId);
  if (skill === undefined) throw new Error("The production Skill catalog did not expose the installed Resource.");
  return { sourceDirectory, skill };
}

function resourceFrom(operation: Awaited<ReturnType<typeof submit>>, action: string): ManagedResource {
  if (operation.state !== OperationState.SUCCEEDED || operation.result?.payload.case !== "resource") {
    throw new Error(
      `Production Connect operation failed to ${action}: state=${operation.state}, result=${String(operation.result?.payload.case)}, value=${JSON.stringify(operation.result?.payload.value, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)}, error=${operation.error?.message ?? "none"}.`
    );
  }
  return operation.result.payload.value;
}

function requireSucceeded(operation: Awaited<ReturnType<typeof submit>>, action: string): void {
  if (operation.state !== OperationState.SUCCEEDED) {
    throw new Error(`Production Connect operation failed to ${action}: state=${operation.state}.`);
  }
}

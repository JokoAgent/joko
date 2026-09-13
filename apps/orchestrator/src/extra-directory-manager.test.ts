import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { ExtraDirectoryManager } from "./extra-directory-manager.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("ExtraDirectoryManager", () => {
  it("projects only canonical explicit approvals and removes them by authoritative ID", async () => {
    const fixture = createFixture();
    const directory = join(fixture.root, "reference");
    mkdirSync(directory);
    const manager = new ExtraDirectoryManager(fixture.store);
    const approved = await manager.add({
      workspaceId: "workspace-one",
      serverPath: join(fixture.root, "ignored", "..", "reference"),
      access: "read_only"
    });
    expect(approved).toMatchObject({
      workspaceId: "workspace-one",
      targetId: "target-one",
      path: directory,
      access: "read_only",
      approved: true
    });
    expect(manager.resolveSelection("target-one", [approved.id])).toEqual([approved]);

    expect(manager.list()).toEqual([approved]);
    expect(manager.remove(approved.id)).toEqual(approved);
    expect(manager.list()).toEqual([]);
  });

  it("fails closed for files and missing paths", async () => {
    const fixture = createFixture();
    const manager = new ExtraDirectoryManager(fixture.store);
    const file = join(fixture.root, "not-a-directory.txt");
    writeFileSync(file, "no");
    await expect(manager.add({ workspaceId: "workspace-one", serverPath: file, access: "read_only" }))
      .rejects.toMatchObject({ publicError: { code: "EXTRA_DIRECTORY_UNSAFE_TYPE" } });
    await expect(manager.add({ workspaceId: "workspace-one", serverPath: join(fixture.root, "missing"), access: "read_write" }))
      .rejects.toMatchObject({ publicError: { code: "EXTRA_DIRECTORY_UNAVAILABLE" } });
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "joko-extra-directory-"));
  const store = new OperationalStore(join(root, "store.db"));
  store.upsertBackend({
    id: "backend-one",
    displayName: "Backend",
    version: "1",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget({
    id: "target-one",
    backendId: "backend-one",
    displayName: "Target",
    workspaceRoot: root,
    managed: true,
    trusted: true
  }, { workspaceId: "workspace-one" });
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store };
}

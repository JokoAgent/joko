import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationalStore, PartnerGroupStore } from "@joko/store";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { PartnerGroupWorkspaces } from "./partner-group-workspaces.js";
import { PartnerNetworkPlanWorkspaces } from "./partner-network-plan-workspaces.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-plan-public-output-")), path = join(root, "work"); await mkdir(path);
  const store = new OperationalStore(join(root, "operations.db")), groups = new PartnerGroupStore(join(root, "groups.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }); await artifacts.initialize();
  const work = new PartnerGroupWorkspaces(store, join(root, "data")); await work.initialize(); const plans = new PartnerNetworkPlanWorkspaces(store, groups, work);
  cleanup.push(async () => { work.dispose(); groups.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { path, artifacts, plans };
}
describe("public plan output snapshots", () => {
  it("retains ordinary deliverables while keeping credential paths and recognized credential contents out of the public attachment store", async () => {
    const f = await fixture(), before = await f.plans.snapshot(f.path);
    await writeFile(join(f.path, ".env"), "PRIVATE_CONFIGURATION=kept-local"); await writeFile(join(f.path, "report.txt"), "api_key=private-plan-fixture-value");
    await writeFile(join(f.path, "deliverable.txt"), "A public deliverable.");
    const outputs = await f.plans.outputs(f.path, before, f.artifacts, new AbortController().signal, () => {});
    expect(outputs.map(file => file.name)).toEqual(["deliverable.txt"]);
    expect(new TextDecoder().decode((await f.artifacts.readBlob(outputs[0]!.artifact)).data)).toBe("A public deliverable.");
  });
  it("refuses a same-inode same-size edit between the file snapshot and artifact finalization", async () => {
    const f = await fixture(), before = await f.plans.snapshot(f.path), path = join(f.path, "report.txt"); await writeFile(path, "version0");
    const ingest = f.artifacts.ingestFileHandle.bind(f.artifacts);
    vi.spyOn(f.artifacts, "ingestFileHandle").mockImplementationOnce(async (handle, options) => {
      await writeFile(path, "version1"); const modified = new Date(Date.now() + 2_000); await utimes(path, modified, modified);
      return ingest(handle, options);
    });
    await expect(f.plans.outputs(f.path, before, f.artifacts, new AbortController().signal, () => {})).rejects.toThrow("input-unavailable");
  });
});

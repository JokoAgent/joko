import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationalStore, PartnerWorkbenchStore, partnerHomeDirectoryName } from "@joko/store";
import { PartnerHomeWorkbench } from "./partner-home-workbench.js";
import type { PartnerHomeLocation, PartnerHomeMoveRecord } from "./partner-home-owner.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
describe("Partner workbench follows its computer", () => {
  it("retains old folder labels without granting them on a new computer and restores each computer's own approved catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-home-workbench-")), store = new OperationalStore(join(root, "state.db")), workbenches = new PartnerWorkbenchStore(root);
    cleanups.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
    const transit = new PartnerHomeWorkbench(store, workbenches), id = "partner-test";
    await mkdir(join(root, partnerHomeDirectoryName(id)));
    const first: PartnerHomeLocation = { kind: "service", deviceId: "original", name: "Original computer" }, second: PartnerHomeLocation = { kind: "device", controllerDeviceId: "phone", deviceId: "other", name: "Other computer", root: "/home/person/.joko/partner" };
    const move = (requestId: string, source: PartnerHomeLocation, destination: PartnerHomeLocation) => ({ requestId, partnerId: id, source: { location: source }, destination }) as PartnerHomeMoveRecord;
    let state = await workbenches.addProject(id, 1n, "/work/same-path");
    state = await workbenches.setJudgment(id, state.revision, { taskId: "idea:planning", project: "/work/same-path", title: "Keep next step", verdict: "idea", next: "Review the next option." });
    await transit.move(move("first-move", first, second), () => undefined);
    expect((await workbenches.read(id)).projects).toEqual([]);
    expect(transit.foreign(id, "other")[0]).toMatchObject({ deviceName: "Original computer", projects: [{ path: "/work/same-path" }], judgments: [{ taskId: "idea:planning" }] });
    state = await workbenches.read(id); state = await workbenches.addProject(id, state.revision, "/work/new-project");
    const revision = state.revision; await transit.move(move("first-move", first, second), () => undefined);
    expect((await workbenches.read(id)).revision).toBe(revision);
    await transit.move(move("return-move", second, first), () => undefined);
    expect((await workbenches.read(id)).projects.map(project => project.path)).toEqual(["/work/same-path"]);
    expect(transit.foreign(id, "original")[0]!.projects.map(project => project.path)).toEqual(["/work/new-project"]);
    const restarted = new PartnerHomeWorkbench(store, new PartnerWorkbenchStore(root));
    expect(await restarted.portable(id, first, () => undefined)).toHaveLength(2);
  });
});

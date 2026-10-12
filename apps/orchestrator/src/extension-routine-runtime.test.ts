import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RoutineInput } from "@joko/core";
import { PartnerRoutineStore, type StoredBackend } from "@joko/store";
import { ExtensionRoutineRuntime, validateRoutineRequestSize } from "./extension-routine-runtime.js";
import { ExtensionMainViewManager } from "./extension-main-view-manager.js";
import { RoutineEngine } from "./partner-routine-engine.js";
import type { ExtensionCatalogDescriptor } from "./extension-catalog.js";
import type { PiInstalledPackageLease, PiResourceDescriptor } from "./resource-manager.js";

const browserIt = process.env.JOKO_BROWSER_EXECUTABLE ? it : it.skip;
describe("resident Extension event authority", () => {
  it("bounds the complete request including ignored fields, cycles, arrays and hostile prototypes", () => {
    validateRoutineRequestSize({ action: "publish", event: { id: "one", data: { scope: "home" } } });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const payload of [cyclic, { ignored: "x".repeat(128 * 1024) }, new Date(), { ignored: new Array(4097).fill(0) }, { ignored: 1n }]) {
      expect(() => validateRoutineRequestSize(payload)).toThrow();
    }
  });
  browserIt("executes inspected publisher assets without a UI, authors the source ID and revokes a disabled package immediately", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-routine-publisher-"));
    const id = "extension_0123456789abcdef0123456789abcdef"; const revision = `sha256:${"a".repeat(64)}`;
    let enabled = true; let notify: ((ids: readonly string[]) => void) | undefined; let serial = 0;
    const events = { html: "ui/events/index.html", events: [{ type: "changed", name: "Changed", fields: ["scope"] }] };
    const extension = () => ({ id, revision: 1n, name: "Calendar", installed: true, enabled, owner: { kind: "resource", resourceId: "resource-calendar", resourceVersion: 1n, discoveredRevision: revision },
      setup: { state: "not_required" }, routineEvents: { ...events, extensionEntry: "extensions/events.js" } } as unknown as ExtensionCatalogDescriptor);
    const resource = { id: "resource-calendar", kind: "package", scope: "managed", state: "installed", enabled: true, backendId: "pi", versionNumber: 1n, discoveredRevision: revision, packageIdentity: "@sample/calendar", version: "1.0.0",
      resourceDetails: [{ kind: "extension", entryPath: "extensions/events.js", routineEvents: events }] } as unknown as PiResourceDescriptor;
    const storage = new PartnerRoutineStore(join(root, "routines")); const execute = vi.fn(async () => ({}));
    const engine = new RoutineEngine({ load: () => storage.load(), save: state => storage.save(state), execute, id: () => `run-${++serial}`, now: Date.now, changed: () => undefined, onError: () => undefined });
    const surfaces = new ExtensionMainViewManager({ rootDirectory: join(root, "surfaces"), resources: { acquireInstalledPackage: async (): Promise<PiInstalledPackageLease> => ({
      resource, assertCurrent: async () => { if (!enabled) throw new Error("Disabled"); }, release: async () => undefined,
      snapshotTo: async destination => {
        await mkdir(join(destination, "extensions"), { recursive: true }); await mkdir(join(destination, "ui/events"), { recursive: true });
        await writeFile(join(destination, "package.json"), JSON.stringify({ name: "@sample/calendar", version: "1.0.0", pi: { extensions: ["extensions/events.js"] },
          joko: { extensionSurfaces: { schemaVersion: 1, extensions: [{ entry: "extensions/events.js", routineEvents: events }] } } }));
        await writeFile(join(destination, "extensions/events.js"), "export default function setup() {}\n");
        await writeFile(join(destination, "ui/events/index.html"), '<!doctype html><html><head><script src="./publisher.js"></script></head><body></body></html>');
        await writeFile(join(destination, "ui/events/publisher.js"), `async function publish() {
          await window.joko.routines.request({action:"status",status:"listening"});
          await window.joko.routines.request({action:"publish",sourceId:"extension:impostor",event:{id:"event-one",type:"changed",occurredAt:Date.now(),data:{scope:"home"}}});
          await window.joko.routines.request({action:"publish",event:{id:"event-secret",type:"changed",occurredAt:Date.now(),data:{token:"private-token"}}});
          await window.joko.routines.request({action:"publish",event:{id:"event-undeclared",type:"other",occurredAt:Date.now(),data:{scope:"home"}}});
        } publish();`);
        return { discoveredRevision: revision, files: 4, bytes: 2048, entries: [] };
      }
    }) } });
    const runtime = new ExtensionRoutineRuntime({ engine, surfaces, executablePath: process.env.JOKO_BROWSER_EXECUTABLE,
      resources: { get: () => resource }, store: { getBackend: () => ({ revision: 1n, descriptor: { instanceGeneration: 1 } } as StoredBackend) },
      catalog: { get: () => extension(), snapshot: () => ({ revision: 1n, entries: [extension()], recoveredFromCorruption: false }), onAuthorityChanged: listener => { notify = listener; return () => { notify = undefined; }; } } });
    try {
      await surfaces.initialize(); await engine.start();
      const definition: RoutineInput = { name: "Calendar review", prompt: "Review the event.", enabled: true, silentWhenIdle: false,
        triggers: [{ id: "event", kind: "event", sourceId: `extension:${id}`, eventType: "changed", filters: [] }] };
      const routine = await engine.createOnce("partner-one", definition, "publisher-routine-creation");
      await runtime.start(); await vi.waitFor(() => expect(engine.history(routine.id)[0]?.status).toBe("success"), { timeout: 10000 });
      expect(execute).toHaveBeenCalledOnce(); expect(engine.history(routine.id)[0]?.events[0]?.sourceId).toBe(`extension:${id}`);
      await new Promise(resolve => setTimeout(resolve, 100)); expect(engine.history(routine.id)).toHaveLength(1);
      expect((await storage.load())?.runs.flatMap(run => run.events).some(item => item.event.id === "event-secret")).toBe(false);
      enabled = false; notify?.([id]); expect(engine.listSources()[0]?.status).toBe("disconnected");
    } finally { await runtime.stop(); await engine.stop(); await surfaces.close(); await rm(root, { recursive: true, force: true }); }
  }, 30000);
});

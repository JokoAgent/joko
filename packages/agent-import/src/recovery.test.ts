import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createImportedEnvironmentStore, emptyImportedEnvironment } from "./environment.js";
import { deserializeImportSnapshotAsync, indexImportSnapshot, serializeImportSnapshotAsync } from "./snapshot.js";
import { previewImportRedactions, retainedImportRedactions, selectedImportEnvironment } from "./environmentSelection.js";
import { redactEnvironmentValues } from "./process.js";
import { validateImportSelection } from "./transfer.js";
import type { AgentImportSelection, ImportItem, ImportSnapshot } from "./types.js";

const assertOwner = () => {};
const source = { kind: "hermes" as const, agentId: "default", name: "Reports", root: resolve("source"), workspace: resolve("source"), configFile: resolve("source", "config.yaml") };
const selection = (entryIds: string[], changes: Partial<AgentImportSelection> = {}): AgentImportSelection => ({ previewId: "preview", requestId: "import_request_000001", name: "Reports", entryIds, takeover: false, deferSetup: true, ...changes });
const view = (id: string) => ({ id, category: "connections" as const, name: id, selected: false });
const snapshot = (items: ImportItem[]): ImportSnapshot => indexImportSnapshot({ source, items, fingerprint: createHash("sha256").update("snapshot").digest("hex") });

describe("private import selection and recovery", () => {
  it("masks selected content using every known account while rejecting account conflicts and missing selection dependencies", () => {
    const items: ImportItem[] = [
      { view: view("account-a"), env: { REPORT_TOKEN: "fake-alpha-token", RETRY_COUNT: "3" } },
      { view: view("account-b"), env: { REPORT_TOKEN: "fake-beta-token" } },
      { view: { ...view("identity"), category: "personality" }, text: "Identity embeds fake-beta-token; status remains readable." },
      { view: view("short"), env: { CODE: "us" } },
      { view: view("connection"), mcp: { name: "Reports", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer fake-header-token", Cookie: "sid=fake-cookie-token" } } },
    ];
    const secrets = previewImportRedactions(items);
    const projection = redactEnvironmentValues("fake-alpha-token fake-beta-token fake-header-token fake-cookie-token; status us RETRY_COUNT=3", secrets);
    for (const privateValue of ["fake-alpha-token", "fake-beta-token", "fake-header-token", "fake-cookie-token"]) expect(projection).not.toContain(privateValue);
    expect(projection).toContain("status"); expect(projection).toContain("RETRY_COUNT=3"); expect(projection).not.toContain("status us");
    expect(() => selectedImportEnvironment(items.slice(0, 2))).toThrow("INVALID_SELECTION");
    const masks = retainedImportRedactions([items[2]!], secrets);
    expect(Object.values(masks)).toEqual(["fake-beta-token"]);
    expect(selectedImportEnvironment([items[0]!])).toEqual({ REPORT_TOKEN: "fake-alpha-token", RETRY_COUNT: "3" });
    const data = snapshot([{ view: view("account-a"), env: { TOKEN: "fake-alpha-token" } }, { view: view("tool"), envDependencies: { names: ["TOKEN"], entries: [] } }]);
    const selected = validateImportSelection(selection(["tool"]), data);
    expect(selected[0]!.view.dependsOn).toEqual([expect.stringMatching(/^env-/)]);
    expect(() => validateImportSelection(selection(["missing"]), data)).toThrow("SELECTION_CHANGED");
  });
  it("preserves compact binary checkpoints and immutable preview indexes, rejecting older or malformed stored encodings", async () => {
    const data = snapshot([{ view: view("zero") }, { view: view("chosen"), files: [{ name: "original", bytes: Buffer.from([0, 255, 17]), executable: true }],
      text: " Full original\n" }, { view: view("tail") }]);
    const subset = { ...data, items: [data.items[1]!] };
    const encoded = await serializeImportSnapshotAsync(subset, assertOwner);
    const restored = await deserializeImportSnapshotAsync(encoded, assertOwner);
    expect(restored.items[0]!.files![0]!.bytes).toEqual(Buffer.from([0, 255, 17])); expect(restored.items[0]!.text).toBe(" Full original\n");
    expect(validateImportSelection(selection([], { entryRanges: [[1, 1]] }), restored)[0]!.view.id).toBe("chosen");
    expect(() => validateImportSelection(selection([], { entryRanges: [[1, 2]] }), restored)).toThrow("SELECTION_CHANGED");
    const older = JSON.parse(encoded) as Record<string, unknown>; delete older.version;
    await expect(deserializeImportSnapshotAsync(JSON.stringify(older), assertOwner)).rejects.toMatchObject({ code: "CREDENTIAL_STORAGE_INVALID" });
    const numeric = JSON.parse(encoded) as { items: Array<{ files: Array<{ bytes: unknown }> }> };
    numeric.items[0]!.files[0]!.bytes = { type: "Buffer", data: [0, 255, 17] };
    await expect(deserializeImportSnapshotAsync(JSON.stringify(numeric), assertOwner)).rejects.toMatchObject({ code: "CREDENTIAL_STORAGE_INVALID" });
    numeric.items[0]!.files[0]!.bytes = { encoding: "base64", data: "Zh==" };
    await expect(deserializeImportSnapshotAsync(JSON.stringify(numeric), assertOwner)).rejects.toMatchObject({ code: "CREDENTIAL_STORAGE_INVALID" });
  });
  it("joins an in-flight write before removal and never admits a late write after Partner retirement", async () => {
    const values = new Map<string, string>(); let writing: (() => void) | undefined;
    let release: (() => void) | undefined; const started = new Promise<void>(resolveStarted => { writing = resolveStarted; });
    const hold = new Promise<void>(resolveRelease => { release = resolveRelease; });
    const storage = createImportedEnvironmentStore({ read: async key => values.get(key) ?? null,
      write: async (key, value) => { writing!(); await hold; values.set(key, value); }, remove: async key => { values.delete(key); } });
    const pending = storage.write("partner_1", emptyImportedEnvironment(source), assertOwner); const observed = pending.catch(error => error);
    await started; const removal = storage.remove("partner_1", assertOwner); release!();
    expect((await observed).code).toBe("IMPORT_OWNER_RETIRED"); await removal; expect(values.size).toBe(0);
    await expect(storage.write("partner_1", emptyImportedEnvironment(source), assertOwner)).rejects.toMatchObject({ code: "IMPORT_OWNER_RETIRED" });
    await expect(storage.read("partner_1", assertOwner)).rejects.toMatchObject({ code: "IMPORT_OWNER_RETIRED" });
  });
});

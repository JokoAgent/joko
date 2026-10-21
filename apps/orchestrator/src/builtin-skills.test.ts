import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { snapshotNativeSkills } from "@joko/core";
import { BuiltinSkillCatalog } from "./builtin-skills.js";
import { inspectPiSkillPackage } from "./resource-manager.js";
import { EXTENSION_CARD_RUNTIME_BOOTSTRAP_SOURCE } from "./extension-cards/runtime-bootstrap.js";
import { ExtensionCardService } from "./extension-cards/service.js";

it("loads the actual shipped Skill and relative references into an immutable native mount", async () => {
  const catalog = await BuiltinSkillCatalog.load(inspectPiSkillPackage);
  const current = vi.fn(); const controller = new AbortController();
  const seeds = await catalog.snapshot(current, controller.signal);
  expect(seeds).toHaveLength(1);
  expect(seeds[0]?.resource.trustedBuiltin).toEqual({ id: "plugin_creator", revision: seeds[0]?.resource.revision });
  const mounted = await snapshotNativeSkills(seeds, controller.signal);
  try {
    expect(await readFile(mounted.skills[0]!.filePath, "utf8")).toContain("name: joko-plugin-creator");
    const guide = await readFile(join(mounted.skills[0]!.path, "references", "tasks.md"), "utf8");
    expect(guide).toContain("expectedRevision"); expect(guide).toContain("joko.tasks.create");
    await mounted.assertFilesCurrent(controller.signal);
    expect(current).toHaveBeenCalled();
  } finally { await mounted.dispose(); }
});
it("does not attest a changed shipped revision or a stale runtime owner", async () => {
  const inspect = vi.fn(inspectPiSkillPackage);
  const catalog = await BuiltinSkillCatalog.load(inspect);
  inspect.mockImplementationOnce(async (...args) => ({ ...await inspectPiSkillPackage(...args), revision: "sha256:" + "0".repeat(64) }));
  await expect(catalog.snapshot(() => undefined, new AbortController().signal)).rejects.toThrow("bundle changed");
  await expect(catalog.snapshot(() => { throw Error("old owner"); }, new AbortController().signal)).rejects.toThrow("old owner");
});
it("runs the shipped example with the actual SDK and card service, including the user refresh action", async () => {
  const html: string[] = [], scope = { extensionId: "extension", authorityKey: "install", sessionId: "session", sessionCreatedAt: 1, targetId: "target", toolUseId: null };
  const cards = new ExtensionCardService({ available: () => true, persist: async row => { html.push(row.html); }, broadcast: () => undefined });
  cards.registerCall("example-call", scope);
  const sandbox: Record<string, unknown> = { AbortController, __jokoExtensionRequest: async (payload: unknown) => {
    const result = await cards.handleCardUpdate("extension", "install", payload, () => undefined); return { ok: result.accepted };
  } };
  sandbox["window"] = sandbox;
  runInNewContext(`(${EXTENSION_CARD_RUNTIME_BOOTSTRAP_SOURCE})({});`, sandbox);
  runInNewContext(await readFile(new URL("./system-skills/joko-plugin-creator/examples/status/ui/runtime.js", import.meta.url), "utf8"), sandbox);
  const runtime = sandbox["__jokoRuntime"] as { tool(input: unknown): Promise<unknown>; event(input: unknown): void };
  await expect(runtime.tool({ name: "show_status", arguments: {}, callId: "example-call", sessionId: "session", readOnly: true })).resolves.toEqual({ ok: true, result: { shown: true } });
  expect(html[0]).toContain("Status is ready"); expect(html[0]).toContain('data-joko-action="refresh"');
  expect(cards.reopenForAction("example-call", scope)).toBe(true);
  runtime.event({ type: "event", name: "card-action", actionId: "refresh", callId: "example-call", spawnCallId: "example-call::sp:1", sessionId: "session", change: false, ts: 1 });
  await vi.waitFor(() => expect(html.at(-1)).toContain("Status refreshed"));
});

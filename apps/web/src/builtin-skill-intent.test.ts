import { expect, it, vi } from "vitest";
import { builtinSkillIntentForText, pluginCreatorDraft, resolveBuiltinSkillDraft } from "./builtin-skill-intent.js";
import type { ComposerDraft, RuntimeCommandView, SessionResourceView } from "./model.js";
const revision = "sha256:" + "a".repeat(64);
const input: ComposerDraft = { builtinSkillIntent: "plugin_creator", text: "/joko-plugin-creator Build a timer", mentions: [], attachments: [], deliveryMode: "prompt" };
const command: RuntimeCommandView = { id: "command", name: "actual-name", sessionId: "task", loaded: true, source: "skill", inputMode: "text", resourceId: "shipped", builtinSkill: { id: "plugin_creator", revision }, description: "Creator" };
const resource: SessionResourceView = { sessionId: "task", id: "shipped", name: "Creator", kind: "skill", discoveredRevision: revision, resourceVersion: "1", runtimeGeneration: 3 };
it("prepares a reviewable ordinary task draft without selecting a fictitious model", () => {
  const draft = pluginCreatorDraft(); expect(draft.selection).toEqual({ kind: "unselected" }); expect(draft.modelId).toBe("");
  expect(draft.text).toBe("/joko-plugin-creator"); expect(draft.builtinSkillIntent).toBe("plugin_creator");
  expect(builtinSkillIntentForText("ordinary text", draft.builtinSkillIntent)).toBeUndefined();
});
it("uses an exact loaded resource mention so a native slash-command collision cannot redirect the creator", async () => {
  const api = { listCommands: vi.fn(async () => [command]), listSessionResources: vi.fn(async () => [resource]) };
  const resolved = await resolveBuiltinSkillDraft(input, "task", 3n, api, new AbortController().signal);
  expect(resolved.text).toBe(input.text); expect(resolved.builtinSkillIntent).toBeUndefined();
  expect(resolved.mentions[0]).toMatchObject({ kind: "resource", reference: "shipped", discoveredRevision: revision, runtimeGeneration: 3 });
  expect(resolved.inlineMentionRanges).toEqual([{ mentionId: resolved.mentions[0]!.id, from: 0, to: 20 }]);
});
it("rejects same-name user Skills, absent or changed environments and leaves the original draft intact", async () => {
  const api = { listCommands: vi.fn(async (): Promise<readonly RuntimeCommandView[]> => [{ ...command, builtinSkill: undefined }]), listSessionResources: vi.fn(async () => [resource]) };
  await expect(resolveBuiltinSkillDraft(input, "task", 3n, api, new AbortController().signal)).rejects.toThrow("no available");
  api.listCommands.mockResolvedValue([command]); api.listSessionResources.mockResolvedValue([{ ...resource, runtimeGeneration: 4 }]);
  await expect(resolveBuiltinSkillDraft(input, "task", 3n, api, new AbortController().signal)).rejects.toThrow("owner changed");
  expect(input.mentions).toHaveLength(0); expect(input.builtinSkillIntent).toBe("plugin_creator");
  const controller = new AbortController(); controller.abort();
  await expect(resolveBuiltinSkillDraft(input, "task", 3n, api, controller.signal)).rejects.toThrow();
});

import type { BuiltinSkillIntent, ComposerDraft, NewSessionLocalDraft, RuntimeCommandView, SessionResourceView } from "./model.js";
import { emptyComposerDocument, normalizeComposerDocument } from "./composer-quote-document.js";
import { applyPendingExtensionUse } from "./extension-use-handoff.js";

export const PLUGIN_CREATOR_INVOCATION = "/joko-plugin-creator";
const invocations: Readonly<Record<BuiltinSkillIntent, string>> = {
  plugin_creator: PLUGIN_CREATOR_INVOCATION,
  skill_creator: "/joko-skill-creator"
};

export function builtinSkillIntentForText(text: string, intent: unknown): BuiltinSkillIntent | undefined {
  if (intent !== "plugin_creator" && intent !== "skill_creator") return undefined;
  const invocation = invocations[intent];
  return text === invocation || text.startsWith(`${invocation} `) || text.startsWith(`${invocation}\n`) ? intent : undefined;
}

export function pluginCreatorDraft(existing?: NewSessionLocalDraft): NewSessionLocalDraft {
  return authoringDraft("plugin_creator", existing);
}

export function skillCreatorDraft(existing?: NewSessionLocalDraft): NewSessionLocalDraft {
  return authoringDraft("skill_creator", existing);
}

function authoringDraft(intent: BuiltinSkillIntent, existing?: NewSessionLocalDraft): NewSessionLocalDraft {
  const original = existing ?? { selection: { kind: "unselected" as const }, nativeStart: { kind: "fresh" as const }, providerId: "", modelId: "",
    fastMode: false, permissionMode: "ask" as const, planMode: false, text: "", editorDocument: emptyComposerDocument(), mentions: [], attachments: [] };
  const applied = applyPendingExtensionUse(normalizeComposerDocument(original.editorDocument, original.text), original.inlineMentionRanges ?? [], invocations[intent].slice(1));
  if (!applied) throw new Error("The authoring draft could not be prepared.");
  return { ...original, nativeStart: { kind: "fresh" }, text: applied.text, editorDocument: applied.document,
    inlineMentionRanges: applied.inlineMentionRanges, builtinSkillIntent: intent };
}

/** Resource mentions are revalidated by the Host and Adapter at durable dispatch. */
export async function resolveBuiltinSkillDraft(input: ComposerDraft, sessionId: string, generation: bigint, api: {
  listCommands(sessionId: string, signal?: AbortSignal): Promise<readonly RuntimeCommandView[]>;
  listSessionResources(sessionId: string, signal?: AbortSignal): Promise<readonly SessionResourceView[]>;
}, signal: AbortSignal): Promise<ComposerDraft> {
  const intent = builtinSkillIntentForText(input.text, input.builtinSkillIntent);
  if (intent === undefined) return input;
  const invocation = invocations[intent];
  signal.throwIfAborted();
  const commands = await api.listCommands(sessionId, signal); signal.throwIfAborted();
  const matching = commands.filter(command => command.loaded && command.source === "skill" && command.resourceId
    && command.sessionId === sessionId && command.builtinSkill?.id === intent && /^sha256:[a-f0-9]{64}$/u.test(command.builtinSkill.revision));
  if (matching.length !== 1) throw new Error(`The selected task environment does not offer ${invocation}. The original draft was preserved.`);
  const command = matching[0]!;
  const resources = await api.listSessionResources(sessionId, signal); signal.throwIfAborted();
  const owned = resources.filter(resource => resource.id === command.resourceId && resource.sessionId === sessionId && resource.kind === "skill"
    && BigInt(resource.runtimeGeneration) === generation && resource.discoveredRevision === command.builtinSkill!.revision);
  if (owned.length !== 1 || (input.inlineMentionRanges ?? []).some(range => range.from < invocation.length)) throw new Error("The built-in Skill's exact runtime owner changed. The original draft was preserved.");
  const resource = owned[0]!, id = crypto.randomUUID();
  const { builtinSkillIntent: _, ...original } = input;
  return { ...original, mentions: [...input.mentions, { id, kind: "resource", reference: resource.id, label: invocation, token: invocation,
    discoveredRevision: resource.discoveredRevision, resourceVersion: resource.resourceVersion, runtimeGeneration: resource.runtimeGeneration }],
    inlineMentionRanges: [{ mentionId: id, from: 0, to: invocation.length }, ...input.inlineMentionRanges ?? []] };
}

import { Code, ConnectError } from "@connectrpc/connect";
import { redactSecrets } from "@joko/core";
import type { PartnerModelRouteRecord, PartnerPatch, PartnerProfileRecord } from "@joko/store";
import type { BridgeToolCallContext, BridgeToolProvider, McpToolDescriptor } from "./mcp-router.js";
import type { PartnerManager } from "./partner-manager.js";
import type { PartnerConnectionsManager } from "./partner-connections.js";
import type { PartnerMemoryPreferences } from "./partner-memory-preferences.js";
import type { PartnerSessionTaskManager } from "./partner-session-tasks.js";

const providerId = "joko_partner_profile";
const guidance = "Read your own current profile, version, stable task, configured model candidates, memory switch and optional external references. Configuration is not proof of this turn's running model or tools. Empty references do not mean the shared guide or personal Skill shelf is absent. Change only fields requested by the user. Read get_session_task_models for enabled opaque route ids before changing your complete ordered model_chain (1–5 routes), preserving existing candidates unless replacement was requested. Null follows the global Partner model chain, or the application default while that chain is uncustomized, and preserves permission and Plan. Saving applies next turn and preserves other Partners, application defaults, personal Skills, memory and task history.";
function tool(name: string, properties: Record<string, unknown>, required: string[], write: boolean): McpToolDescriptor {
  return { serverId: providerId, name, description: guidance, inputSchema: { type: "object", additionalProperties: false, properties, required }, requiresPermission: write };
}
function invalid(message = "Read the current profile and enabled models before changing your own profile."): never {
  throw new ConnectError(message, Code.InvalidArgument);
}
function keys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== "string" || value.length > maximum || required && !value.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || redactSecrets(value) !== value) invalid();
  return value;
}

export class PartnerProfileTools implements BridgeToolProvider {
  readonly canonicalPartnerOnly = true;
  readonly id = providerId; readonly generation = 1; readonly available = true;
  readonly tools = [
    tool("get_partner_state", {}, [], false),
    tool("update_partner_profile", {
      expected_version: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      name: { type: "string", minLength: 1, maxLength: 200 }, description: { type: "string", maxLength: 12_000 },
      identity_source: { type: "string", minLength: 1, maxLength: 8_000 },
      model_chain: { anyOf: [{ type: "null" }, { type: "array", minItems: 1, maxItems: 5, items: { type: "object", additionalProperties: false,
        properties: { id: { type: "string", minLength: 1, maxLength: 2_048 }, effort: { type: "string", maxLength: 64 }, fast_mode: { type: "boolean" } }, required: ["id"] } }] }
    }, ["expected_version"], true)
  ];
  constructor(readonly partners: PartnerManager, readonly tasks: PartnerSessionTaskManager,
    readonly connections: PartnerConnectionsManager, readonly memory: Pick<PartnerMemoryPreferences, "enabled">) {}
  includeForTarget(targetId: string) {
    const profile = this.partners.partnerForHomeTarget(targetId);
    return profile?.lifecycle === "active" && profile.initializationState === "ready";
  }
  currentCaller(context: BridgeToolCallContext, signal: AbortSignal | undefined) {
    const profile = this.partners.canonicalCaller(context.sessionId), store = this.tasks.store;
    const session = store.getSession(context.sessionId).descriptor, target = store.getTarget(session.targetId);
    const backend = store.getBackend(session.backendId).descriptor;
    const assertCurrent = (expected: PartnerProfileRecord = profile) => {
      signal?.throwIfAborted(); const live = store.getSession(session.id).descriptor, home = store.getTarget(session.targetId);
      const current = this.partners.canonicalCaller(session.id), link = this.connections.profiles.getSessionLink(session.id);
      if (context.targetId !== profile.homeTargetId || context.targetId !== session.targetId || context.generation !== live.binding.generation
        || live.backendId !== session.backendId || live.binding.nativeSessionId !== session.binding.nativeSessionId
        || live.binding.opaqueRef !== session.binding.opaqueRef || live.remoteWorkspace !== undefined
        || current.id !== profile.id || current.revision !== expected.revision || current.profileVersion !== expected.profileVersion
        || link?.partnerId !== profile.id || link.role !== "canonical" || expected.revision === profile.revision && home.revision !== target.revision || !home.descriptor.trusted
        || home.descriptor.workspaceRoot !== target.descriptor.workspaceRoot || home.descriptor.backendId !== target.descriptor.backendId
        || home.descriptor.managed !== target.descriptor.managed
        || home.descriptor.remoteWorkspace !== undefined || store.getBackend(backend.id).descriptor.instanceGeneration !== backend.instanceGeneration
        || context.providerGeneration !== undefined && context.providerGeneration !== this.generation) {
        throw new ConnectError("The Partner profile caller changed. Read the current state again.", Code.Aborted);
      }
      this.connections.owner(profile.id, expected.revision, true);
    };
    assertCurrent(); return { profile, session, target, assertCurrent };
  }
  async callTool(name: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext) {
    try {
      const caller = this.currentCaller(context, signal); let value: Record<string, unknown>;
      if (name === "get_partner_state") {
        keys(input, []); const profile = caller.profile, references = this.connections.read(profile.id);
        value = { state: {
          profile: { id: profile.id, name: redactSecrets(profile.displayName), description: profile.description, identity_source: redactSecrets(profile.identitySource), version: profile.profileVersion },
          session: { id: caller.session.id, working_dir: caller.session.worktree?.path ?? caller.target.descriptor.workspaceRoot, remote_host_id: null },
          model: { source: profile.usesDirectoryDefaults ? "default" : "override", candidates: profile.capabilities.modelChain.map(route => ({
            backend_id: route.backendId, provider_id: route.providerId, model_id: route.modelId, effort: route.effort ?? "", fast_mode: route.fastMode })) },
          memory: { enabled: this.memory.enabled(profile.homeTargetId), scope: "self" },
          references: { skills: references.skills!.ids, mcp_servers: references.mcp!.ids, toolsets: references.toolsets!.ids }
        } };
        caller.assertCurrent();
      } else if (name === "update_partner_profile") {
        keys(input, ["expected_version", "name", "description", "identity_source", "model_chain"]);
        const version = input["expected_version"];
        if (typeof version !== "number" || !Number.isSafeInteger(version) || version !== caller.profile.profileVersion) throw new ConnectError("The Partner profile version changed.", Code.Aborted);
        if (["name", "description", "identity_source", "model_chain"].every(key => input[key] === undefined)) invalid("Choose at least one profile field to change.");
        const patch: PartnerPatch = {
          ...(input["name"] === undefined ? {} : { displayName: text(input["name"], 200, true) }),
          ...(input["description"] === undefined ? {} : { description: text(input["description"], 12_000) }),
          ...(input["identity_source"] === undefined ? {} : { identitySource: text(input["identity_source"], 8_000, true) }),
          ...(input["model_chain"] === undefined ? {} : input["model_chain"] === null ? { usesDirectoryDefaults: true } : {
            usesDirectoryDefaults: false, capabilities: { ...caller.profile.capabilities, modelChain: this.#chain(context.sessionId, input["model_chain"]) }
          })
        };
        caller.assertCurrent(); const updated = await this.partners.updatePartner(caller.profile.id, caller.profile.revision, patch, caller.assertCurrent, input["model_chain"] === null);
        caller.assertCurrent(updated); value = { effective: "next-turn", version: updated.profileVersion };
      } else throw new ConnectError("Partner profile tool is unavailable.", Code.NotFound);
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, isError: false };
    } catch (error) {
      signal?.throwIfAborted(); return { content: [{ type: "text" as const, text: error instanceof ConnectError ? error.rawMessage
        : "The Partner profile was not confirmed. Read current state and enabled models before retrying." }], isError: true };
    }
  }
  #chain(sessionId: string, input: unknown): readonly PartnerModelRouteRecord[] {
    if (!Array.isArray(input) || input.length < 1 || input.length > 5) invalid();
    const available = this.tasks.models(sessionId).available, configured = this.partners.canonicalCaller(sessionId).capabilities.modelChain, seen = new Set<string>();
    return input.map(raw => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid();
      const selection = raw as Record<string, unknown>; keys(selection, ["id", "effort", "fast_mode"]);
      const id = text(selection["id"], 2_048, true), choice = available.find(item => item.id === id);
      const previous = configured.find(route => route.backendId === choice?.backendId && route.providerId === choice.providerId && route.modelId === choice.modelId);
      const effort = selection["effort"] === undefined ? previous?.effort ?? choice?.effort : text(selection["effort"], 64);
      if (!choice || seen.has(id) || effort !== undefined && effort !== "" && !choice.efforts.includes(effort)
        || selection["fast_mode"] !== undefined && typeof selection["fast_mode"] !== "boolean"
        || selection["fast_mode"] === true && !choice.supportsFastMode) invalid();
      seen.add(id); return { backendId: choice.backendId, providerId: choice.providerId, modelId: choice.modelId,
        ...(effort ? { effort } : {}), fastMode: selection["fast_mode"] as boolean | undefined ?? previous?.fastMode ?? choice.fastMode };
    });
  }
}

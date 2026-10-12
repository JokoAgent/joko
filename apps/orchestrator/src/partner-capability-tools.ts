import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { redactSecrets } from "@joko/core";
import type { BridgeToolCallContext, BridgeToolProvider, McpToolDescriptor } from "./mcp-router.js";
import type { PartnerConnectionsManager } from "./partner-connections.js";

const providerId = "joko_partner_capabilities";
const kinds = { skill: contract.PartnerConnectionKind.SKILL, mcp: contract.PartnerConnectionKind.MCP, toolset: contract.PartnerConnectionKind.TOOLSET };
const fields = { skill: "skills", mcp: "mcp", toolset: "toolsets" } as const;
const kindSchema = { type: "string", enum: Object.keys(kinds) };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], write: boolean): McpToolDescriptor => ({
  serverId: providerId, name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, requiresPermission: write
});
function invalid(): never { throw new ConnectError("Capability selection is invalid.", Code.InvalidArgument); }
export class PartnerCapabilityTools implements BridgeToolProvider {
  readonly canonicalPartnerOnly = true;
  readonly id = providerId; readonly generation = 1; readonly available = true;
  readonly tools = [
    tool("find_partner_capabilities", "Find existing shared skills, MCP connections or optional toolsets available to this canonical Partner. Joined references apply to future turns; they do not prove what is running now. Personal skills remain separate.",
      { kind: kindSchema, query: { type: "string", maxLength: 200 } }, ["kind"], false),
    tool("select_partner_capability", "Join or remove one discovered capability for this canonical Partner. This changes only its references; shared installations, credentials and global switches stay with their owners. New mounts apply at the next safe turn boundary.",
      { kind: kindSchema, id: { type: "string", minLength: 1, maxLength: 256 }, joined: { type: "boolean" } }, ["kind", "id", "joined"], true)
  ];
  constructor(readonly manager: PartnerConnectionsManager, readonly requestRefresh: (sessionId: string) => boolean) {}
  includeForTarget(targetId: string) { return this.manager.profiles.listPartners().some(profile => profile.homeTargetId === targetId && profile.lifecycle !== "deleted"); }
  #caller(context: BridgeToolCallContext, signal: AbortSignal) {
    const session = this.manager.store.getSession(context.sessionId).descriptor, link = this.manager.profiles.getSessionLink(session.id);
    if (!link || link.role !== "canonical") throw new ConnectError("Only the canonical Partner task can manage these references.", Code.FailedPrecondition);
    const profile = this.manager.partners.getPartner(link.partnerId), backend = this.manager.store.getBackend(session.backendId).descriptor;
    const assertCurrent = () => {
      signal.throwIfAborted(); const current = this.manager.store.getSession(session.id).descriptor, live = this.manager.profiles.getSessionLink(session.id);
      if (current.targetId !== context.targetId || current.binding.generation !== context.generation || current.backendId !== session.backendId
        || current.archived || current.deletedAt !== undefined || current.remoteWorkspace?.kind === "ssh"
        || profile.homeTargetId !== context.targetId || profile.canonicalSessionId !== session.id || profile.lifecycle !== "active"
        || live?.partnerId !== profile.id || live.role !== "canonical" || context.providerGeneration !== undefined && context.providerGeneration !== 1
        || this.manager.store.getBackend(backend.id).descriptor.instanceGeneration !== backend.instanceGeneration) throw new ConnectError("The capability caller changed.", Code.Aborted);
      this.manager.owner(profile.id, profile.revision, true);
    };
    assertCurrent(); return { partnerId: profile.id, assertCurrent };
  }
  async callTool(name: string, input: Readonly<Record<string, unknown>>, optionalSignal: AbortSignal | undefined, context: BridgeToolCallContext) {
    const signal = optionalSignal ?? new AbortController().signal;
    try {
      const caller = this.#caller(context, signal), kind = input["kind"];
      if (typeof kind !== "string" || !Object.hasOwn(kinds, kind)) invalid();
      const selectedKind = kind as keyof typeof kinds, field = fields[selectedKind];
      let value: Record<string, unknown>;
      if (name === "find_partner_capabilities") {
        if (Object.keys(input).some(key => !["kind", "query"].includes(key)) || input["query"] !== undefined && (typeof input["query"] !== "string" || input["query"].length > 200 || input["query"].includes("\0"))) invalid();
        const result = await this.manager.readForClient(caller.partnerId, signal, input["query"] as string | undefined); caller.assertCurrent();
        const base = this.manager.read(caller.partnerId), selection = base[field]!, selected = new Set(selection.ids);
        const entries = result.entries.filter(item => item.kind === kinds[selectedKind] && !item.personal);
        for (const id of selected) if (!base.entries.some(entry => entry.kind === kinds[selectedKind] && entry.id === id)) {
          const query = String(input["query"] ?? "").trim().toLocaleLowerCase();
          if (!query || id.toLocaleLowerCase().includes(query)) entries.push(create(contract.PartnerConnectionEntrySchema, { kind: kinds[selectedKind], id, name: id, available: false }));
        }
        value = { capabilities: entries.slice(0, 50).map(entry => ({ id: entry.id, name: entry.name, description: entry.description,
          available: entry.available, joined: selected.has(entry.id) || selection.mode === contract.PartnerConnectionMode.INHERIT && entry.inherited })) };
      } else if (name === "select_partner_capability") {
        const id = input["id"], joined = input["joined"];
        if (Object.keys(input).some(key => !["kind", "id", "joined"].includes(key)) || typeof id !== "string" || !id || id.length > 256
          || /[\u0000-\u001f\u007f]/u.test(id) || redactSecrets(id) !== id || typeof joined !== "boolean") invalid();
        const base = await this.manager.readForClient(caller.partnerId, signal); caller.assertCurrent();
        const entry = base.entries.find(item => item.kind === kinds[selectedKind] && item.id === id);
        if (entry?.personal || joined && !entry?.available) throw new ConnectError("This capability cannot be selected.", Code.FailedPrecondition);
        const selection = base[field]!, ids = new Set(selection.mode === contract.PartnerConnectionMode.INHERIT
          ? base.entries.filter(item => item.kind === kinds[selectedKind] && item.inherited).map(item => item.id) : selection.ids);
        if (joined) ids.add(id); else ids.delete(id);
        this.manager.update(create(contract.UpdatePartnerConnectionsRequestSchema, { partnerId: caller.partnerId,
          expectedPartnerRevision: base.owner!.revision, ...(base.revision ? { expectedRevision: base.revision } : {}),
          expectedCatalogRevision: base.catalogRevision, mcp: base.mcp, toolsets: base.toolsets, skills: base.skills,
          [field]: { mode: contract.PartnerConnectionMode.ALLOWLIST, ids: [...ids].sort() } }));
        caller.assertCurrent(); value = { joined, effective: this.requestRefresh(context.sessionId) ? "next-turn" : "next-session" };
      } else throw new ConnectError("Capability tool is unavailable.", Code.NotFound);
      caller.assertCurrent(); return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, isError: false };
    } catch (error) {
      signal.throwIfAborted(); return { content: [{ type: "text" as const, text: error instanceof ConnectError ? error.rawMessage : "Capability operation failed. Refresh before retrying." }], isError: true };
    }
  }
}

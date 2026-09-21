import type { SessionDescriptor } from "@joko/core";
import {
  ContactStoreError,
  normalizeContactIdentityValue,
  normalizeContactPlatform,
  type ContactDirectoryState,
  type ContactDuplicateCandidate,
  type ContactGroupRecord,
  type ContactIdentityDraft,
  type ContactProfileRecord,
  type ContactSummaryRecord,
  type OperationalStore
} from "@joko/store";

import {
  ContactManagerError,
  type ContactManager,
  type ContactVCardImportDecision,
  type ContactVCardImportPreview,
  type ContactVCardImportPreviewEntry
} from "./contact-manager.js";
import { CONTACT_TOOL_POLICY_LOCALIZATIONS } from "./i18n/orchestration-language.js";
import type {
  BridgeToolCallContext,
  BridgeToolPolicyDeclaration,
  BridgeToolProvider,
  McpCallResult,
  McpToolDescriptor
} from "./mcp-router.js";

export const CONTACT_TOOL_PROVIDER_ID = "joko_contacts";
export const CONTACT_TOOL_POLICY_ID = "joko-contacts-tools";
export const CONTACT_TOOL_POLICY: BridgeToolPolicyDeclaration = Object.freeze({
  id: CONTACT_TOOL_POLICY_ID,
  displayName: "Contacts",
  description: "Let trusted tasks search and maintain the local Contacts directory.",
  productDefaultEnabled: true,
  localizations: CONTACT_TOOL_POLICY_LOCALIZATIONS
});

const LIST_TOOLS = "list_tools";
const CALL_TOOL = "call_tool";
const CALL_SENSITIVE_TOOL = "call_sensitive_tool";
const RECENT_EVENT_LIMIT = 10;
const COMPACT_RELATION_LIMIT = 20;
const COMPACT_GROUP_LIMIT = 20;
const DEFAULT_PROFILE_PAGE_SIZE = 100;
const MAXIMUM_PROFILE_PAGE_SIZE = 500;
const DEFAULT_PREVIEW_PAGE_SIZE = 50;
const MAXIMUM_PREVIEW_PAGE_SIZE = 100;
const PREVIEW_CANDIDATE_LIMIT = 20;
const COMMIT_RESULT_LIMIT = 200;

type ContactToolCategory = "search" | "read" | "write" | "manage";
type ContactToolConfirmation = "never" | "always" | "conditional";

interface ContactNestedToolDescriptor {
  readonly name: string;
  readonly category: ContactToolCategory;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly confirmation: ContactToolConfirmation;
  readonly rules?: readonly string[];
}

const ID_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$"
});
const REVISION_SCHEMA = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 16,
  pattern: "^[1-9][0-9]{0,15}$",
  description: "Exact decimal revision returned by a Contacts read."
});
const KIND_SCHEMA = Object.freeze({ type: "string", enum: ["person", "organization"] });
const STATUS_SCHEMA = Object.freeze({ type: "string", enum: ["confirmed", "pending"] });
const IDENTITY_PROPERTIES = Object.freeze({
  platform: { type: "string", minLength: 1, maxLength: 32, pattern: "^[a-z0-9_-]+$" },
  value: { type: "string", minLength: 1, maxLength: 320 },
  label: { type: "string", maxLength: 100 },
  note: { type: "string", maxLength: 1_000 }
});
const IDENTITY_SCHEMA = objectSchema(IDENTITY_PROPERTIES, ["platform", "value"]);
const ALIASES_SCHEMA = Object.freeze({
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 100 },
  maxItems: 20,
  uniqueItems: true
});
const CONTACT_MEMBER_SCHEMA = objectSchema({
  contact_id: ID_SCHEMA,
  expected_revision: REVISION_SCHEMA
}, ["contact_id", "expected_revision"]);

const COLLECTION_RULE =
  "Create a contact only for a clearly identified person or organization with an ongoing relationship. " +
  "Resolve before writing; use pending for low-confidence identity, append dated events for changing facts, " +
  "and never infer that similar names are the same person.";
const SENSITIVE_RULE =
  "Removal, deletion, merge, bulk import, and membership removal require the user's explicit instruction. " +
  "Read both current profiles and revisions before merging; deletion is not recoverable.";
const VCARD_RULE =
  "vCard import is preview-first and revision-fenced. Review every needs_review entry and commit the exact preview; " +
  "the whole batch rolls back if any decision is stale or invalid.";

const CONTACT_NESTED_TOOLS: readonly ContactNestedToolDescriptor[] = Object.freeze([
  nestedTool("contacts_resolve", "search",
    "Resolve an exact platform identity, name, alias, or full-text clue to compact Contacts profiles ranked by identity, name, then full-text confidence.",
    objectSchema({
      value: { type: "string", minLength: 1, maxLength: 320 },
      platform: { type: "string", minLength: 1, maxLength: 32, pattern: "^[a-z0-9_-]+$" },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 5 }
    }, ["value"]), "never"),
  nestedTool("contacts_search", "search",
    "Search names, aliases, identities, summaries, narratives, notes, events, and relations with bounded pagination.",
    objectSchema({
      query: { type: "string", minLength: 1, maxLength: 256 },
      kind: KIND_SCHEMA,
      status: STATUS_SCHEMA,
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      offset: { type: "integer", minimum: 0, maximum: 50_000, default: 0 }
    }, ["query"]), "never"),
  nestedTool("contacts_get", "read",
    "Read one complete contact with independently paged events, groups, and relations.",
    objectSchema({
      id: ID_SCHEMA,
      event_offset: { type: "integer", minimum: 0, maximum: 10_000, default: 0 },
      event_limit: { type: "integer", minimum: 1, maximum: MAXIMUM_PROFILE_PAGE_SIZE, default: DEFAULT_PROFILE_PAGE_SIZE },
      group_offset: { type: "integer", minimum: 0, maximum: 1_000, default: 0 },
      group_limit: { type: "integer", minimum: 1, maximum: MAXIMUM_PROFILE_PAGE_SIZE, default: DEFAULT_PROFILE_PAGE_SIZE },
      relation_offset: { type: "integer", minimum: 0, maximum: 10_000, default: 0 },
      relation_limit: { type: "integer", minimum: 1, maximum: MAXIMUM_PROFILE_PAGE_SIZE, default: DEFAULT_PROFILE_PAGE_SIZE }
    }, ["id"]), "never"),
  nestedTool("contacts_list", "read",
    "List contact summaries by kind, status, or group with bounded pagination.",
    objectSchema({
      kind: KIND_SCHEMA,
      status: STATUS_SCHEMA,
      group_id: ID_SCHEMA,
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      offset: { type: "integer", minimum: 0, maximum: 50_000, default: 0 }
    }), "never"),
  nestedTool("contacts_list_groups", "read", "List all contact groups and current revisions.", objectSchema({}), "never"),
  nestedTool("contacts_stats", "read", "Read directory enablement, revision, and contact/group counts.", objectSchema({}), "never"),
  nestedTool("contacts_create", "write",
    "Create an agent-sourced contact. Exact identity matches enrich the existing profile; similar names require an explicit allow_duplicate retry.",
    objectSchema({
      expected_directory_revision: REVISION_SCHEMA,
      kind: KIND_SCHEMA,
      display_name: { type: "string", minLength: 1, maxLength: 100 },
      aliases: ALIASES_SCHEMA,
      summary: { type: "string", maxLength: 300 },
      narrative: { type: "string", maxLength: 16_384 },
      agent_notes: { type: "string", maxLength: 1_000 },
      status: STATUS_SCHEMA,
      identities: { type: "array", items: IDENTITY_SCHEMA, maxItems: 30 },
      allow_duplicate: { type: "boolean", default: false }
    }, ["expected_directory_revision", "kind", "display_name"]), "never", [COLLECTION_RULE]),
  nestedTool("contacts_update", "write", "Revision-fenced patch of one contact; aliases replace the full alias set.",
    objectSchema({
      id: ID_SCHEMA,
      expected_revision: REVISION_SCHEMA,
      kind: KIND_SCHEMA,
      display_name: { type: "string", minLength: 1, maxLength: 100 },
      aliases: ALIASES_SCHEMA,
      summary: { type: "string", maxLength: 300 },
      narrative: { type: "string", maxLength: 16_384 },
      agent_notes: { type: "string", maxLength: 1_000 },
      status: STATUS_SCHEMA
    }, ["id", "expected_revision"]), "never", [COLLECTION_RULE]),
  nestedTool("contacts_confirm", "write", "Confirm one pending contact at its exact revision.",
    objectSchema({ id: ID_SCHEMA, expected_revision: REVISION_SCHEMA }, ["id", "expected_revision"]), "never", [COLLECTION_RULE]),
  nestedTool("contacts_add_identity", "write", "Add one globally unique platform identity to a contact at its exact revision.",
    objectSchema({ contact_id: ID_SCHEMA, expected_revision: REVISION_SCHEMA, ...IDENTITY_PROPERTIES },
      ["contact_id", "expected_revision", "platform", "value"]), "never", [COLLECTION_RULE]),
  nestedTool("contacts_remove_identity", "write", "Remove one identity from a contact at its exact revision.",
    objectSchema({ contact_id: ID_SCHEMA, expected_revision: REVISION_SCHEMA, identity_id: ID_SCHEMA },
      ["contact_id", "expected_revision", "identity_id"]), "always", [SENSITIVE_RULE]),
  nestedTool("contacts_append_event", "write", "Append one dated fact to a contact's event timeline.",
    objectSchema({
      contact_id: ID_SCHEMA,
      expected_revision: REVISION_SCHEMA,
      date: { type: "string", pattern: "^[0-9]{4}-(0[1-9]|1[0-2])(-([0-2][0-9]|3[01]))?$" },
      text: { type: "string", minLength: 1, maxLength: 1_000 },
      source: { type: "string", minLength: 1, maxLength: 64 }
    }, ["contact_id", "expected_revision", "date", "text"]), "never", [COLLECTION_RULE]),
  nestedTool("contacts_remove_event", "write", "Remove one contact event at the contact's exact revision.",
    objectSchema({ contact_id: ID_SCHEMA, expected_revision: REVISION_SCHEMA, event_id: ID_SCHEMA },
      ["contact_id", "expected_revision", "event_id"]), "always", [SENSITIVE_RULE]),
  nestedTool("contacts_add_relation", "write", "Add a directed relation from one contact to another.",
    objectSchema({
      from_id: ID_SCHEMA,
      expected_from_revision: REVISION_SCHEMA,
      to_id: ID_SCHEMA,
      relation: { type: "string", minLength: 1, maxLength: 30 },
      note: { type: "string", maxLength: 1_000 }
    }, ["from_id", "expected_from_revision", "to_id", "relation"]), "never", [COLLECTION_RULE]),
  nestedTool("contacts_update_relation", "write", "Update a relation label/note with both owner and relation revisions.",
    objectSchema({
      owner_id: ID_SCHEMA,
      expected_owner_revision: REVISION_SCHEMA,
      relation_id: ID_SCHEMA,
      expected_relation_revision: REVISION_SCHEMA,
      relation: { type: "string", minLength: 1, maxLength: 30 },
      note: { type: "string", maxLength: 1_000 }
    }, ["owner_id", "expected_owner_revision", "relation_id", "expected_relation_revision", "relation"]), "never", [COLLECTION_RULE]),
  nestedTool("contacts_remove_relation", "write", "Remove one relation from either endpoint at the owner's exact revision.",
    objectSchema({ owner_id: ID_SCHEMA, expected_owner_revision: REVISION_SCHEMA, relation_id: ID_SCHEMA },
      ["owner_id", "expected_owner_revision", "relation_id"]), "always", [SENSITIVE_RULE]),
  nestedTool("contacts_delete", "manage", "Permanently delete one contact and its identities, events, memberships, and relations.",
    objectSchema({ id: ID_SCHEMA, expected_revision: REVISION_SCHEMA }, ["id", "expected_revision"]), "always", [SENSITIVE_RULE]),
  nestedTool("contacts_merge", "manage", "Atomically merge source into target and permanently remove source.",
    objectSchema({
      target_id: ID_SCHEMA,
      expected_target_revision: REVISION_SCHEMA,
      source_id: ID_SCHEMA,
      expected_source_revision: REVISION_SCHEMA
    }, ["target_id", "expected_target_revision", "source_id", "expected_source_revision"]), "always", [SENSITIVE_RULE]),
  nestedTool("contacts_find_duplicates", "manage", "Scan a bounded set of similar-name contact pairs for explicit review.",
    objectSchema({ limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } }), "never", [SENSITIVE_RULE]),
  nestedTool("contacts_create_group", "manage", "Create one group at the exact directory revision.",
    objectSchema({
      expected_directory_revision: REVISION_SCHEMA,
      name: { type: "string", minLength: 1, maxLength: 60 },
      description: { type: "string", maxLength: 1_000 }
    }, ["expected_directory_revision", "name"]), "never", [COLLECTION_RULE]),
  nestedTool("contacts_update_group", "manage", "Revision-fenced patch of one group name or description.",
    objectSchema({
      group_id: ID_SCHEMA,
      expected_revision: REVISION_SCHEMA,
      name: { type: "string", minLength: 1, maxLength: 60 },
      description: { type: "string", maxLength: 1_000 }
    }, ["group_id", "expected_revision"]), "never", [COLLECTION_RULE]),
  nestedTool("contacts_delete_group", "manage", "Delete one group without deleting its contacts.",
    objectSchema({ group_id: ID_SCHEMA, expected_revision: REVISION_SCHEMA }, ["group_id", "expected_revision"]),
    "always", [SENSITIVE_RULE]),
  nestedTool("contacts_set_group_members", "manage", "Atomically add and/or remove up to 200 revision-fenced contact memberships.",
    objectSchema({
      group_id: ID_SCHEMA,
      expected_group_revision: REVISION_SCHEMA,
      add: { type: "array", items: CONTACT_MEMBER_SCHEMA, maxItems: 200 },
      remove: { type: "array", items: CONTACT_MEMBER_SCHEMA, maxItems: 200 }
    }, ["group_id", "expected_group_revision"]), "conditional", [COLLECTION_RULE, SENSITIVE_RULE]),
  nestedTool("contacts_preview_vcard_import", "manage", "Parse portable vCard text into a revision-fenced, paged import preview.",
    objectSchema({
      vcard_text: { type: "string", minLength: 1, maxLength: 2 * 1024 * 1024 },
      limit: { type: "integer", minimum: 1, maximum: MAXIMUM_PREVIEW_PAGE_SIZE, default: DEFAULT_PREVIEW_PAGE_SIZE }
    }, ["vcard_text"]), "never", [VCARD_RULE]),
  nestedTool("contacts_get_vcard_import_preview", "manage", "Read another bounded page from an unexpired vCard import preview.",
    objectSchema({
      preview_id: ID_SCHEMA,
      offset: { type: "integer", minimum: 0, maximum: 2_000, default: 0 },
      limit: { type: "integer", minimum: 1, maximum: MAXIMUM_PREVIEW_PAGE_SIZE, default: DEFAULT_PREVIEW_PAGE_SIZE }
    }, ["preview_id"]), "never", [VCARD_RULE]),
  nestedTool("contacts_commit_vcard_import", "manage", "Atomically commit exact create/merge/skip decisions for an unexpired vCard preview.",
    objectSchema({
      preview_id: ID_SCHEMA,
      expected_directory_revision: REVISION_SCHEMA,
      decisions: {
        type: "array",
        maxItems: 2_000,
        items: objectSchema({
          entry_id: ID_SCHEMA,
          decision: { type: "string", enum: ["create", "merge", "skip"] },
          target_contact_id: ID_SCHEMA,
          expected_target_revision: REVISION_SCHEMA,
          target_entry_id: ID_SCHEMA,
          confirmed_name_candidate_ids: { type: "array", items: ID_SCHEMA, maxItems: 100, uniqueItems: true },
          organization_decision: { type: "string", enum: ["create", "merge", "skip"] },
          organization_target_contact_id: ID_SCHEMA,
          expected_organization_target_revision: REVISION_SCHEMA,
          organization_target_entry_id: ID_SCHEMA,
          confirmed_organization_candidate_ids: { type: "array", items: ID_SCHEMA, maxItems: 100, uniqueItems: true }
        }, ["entry_id", "decision"])
      }
    }, ["preview_id", "expected_directory_revision", "decisions"]), "always", [VCARD_RULE, SENSITIVE_RULE]),
  nestedTool("contacts_export_vcard", "manage", "Export up to 2,000 selected contacts, or the whole directory, as portable vCard text.",
    objectSchema({ contact_ids: { type: "array", items: ID_SCHEMA, maxItems: 2_000, uniqueItems: true } }), "never", [VCARD_RULE])
]);

export const CONTACT_NESTED_TOOL_NAMES: readonly string[] = Object.freeze(
  CONTACT_NESTED_TOOLS.map((tool) => tool.name)
);

const BRIDGE_TOOLS: readonly McpToolDescriptor[] = Object.freeze([
  bridgeTool(LIST_TOOLS,
    "Discover local Contacts tools by search, read, write, or manage category, including exact schemas and safety rules.",
    objectSchema({ category: { type: "string", enum: ["search", "read", "write", "manage"] } }), false),
  bridgeTool(CALL_TOOL,
    "Invoke a discovered Contacts tool that does not require per-call destructive confirmation.",
    objectSchema({
      name: { type: "string", minLength: 1, maxLength: 128 },
      args: { type: "object", additionalProperties: {} }
    }, ["name", "args"]), false),
  bridgeTool(CALL_SENSITIVE_TOOL,
    "Invoke a discovered Contacts removal, deletion, merge, bulk import, or membership-removal tool after explicit approval.",
    objectSchema({
      name: { type: "string", minLength: 1, maxLength: 128 },
      args: { type: "object", additionalProperties: {} }
    }, ["name", "args"]), true)
]);

export class ContactToolBridgeProvider implements BridgeToolProvider {
  readonly id = CONTACT_TOOL_PROVIDER_ID;
  readonly generation = 1;
  readonly available = true;
  readonly configurablePolicy = CONTACT_TOOL_POLICY;
  readonly tools = BRIDGE_TOOLS;
  readonly #store: OperationalStore;
  readonly #contacts: ContactManager;

  constructor(options: { readonly store: OperationalStore; readonly contacts: ContactManager }) {
    this.#store = options.store;
    this.#contacts = options.contacts;
    if (CONTACT_NESTED_TOOLS.length !== 27 || new Set(CONTACT_NESTED_TOOL_NAMES).size !== 27) {
      throw new Error("The Contacts Tool catalog must expose exactly twenty-seven unique current-v1 tools.");
    }
  }

  includeForTarget(targetId: string): boolean {
    try {
      return this.#store.getTarget(targetId).descriptor.trusted;
    } catch {
      return false;
    }
  }

  async callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: BridgeToolCallContext
  ): Promise<McpCallResult> {
    signal?.throwIfAborted();
    try {
      this.#requireCaller(context);
      if (name === LIST_TOOLS) return this.#listTools(arguments_);
      if (name !== CALL_TOOL && name !== CALL_SENSITIVE_TOOL) {
        throw new ContactToolError("UNKNOWN_TOOL", "Contacts entry tool is not part of this runtime snapshot.");
      }
      assertKeys(arguments_, ["name", "args"]);
      const selectedName = requiredText(arguments_, "name", 128);
      const selected = CONTACT_NESTED_TOOLS.find((tool) => tool.name === selectedName);
      if (selected === undefined) {
        throw new ContactToolError("UNKNOWN_TOOL", "The requested Contacts tool is unavailable.", {
          requested: selectedName,
          available: CONTACT_NESTED_TOOL_NAMES
        });
      }
      const input = record(arguments_["args"], "args");
      const sensitive = requiresConfirmation(selected, input);
      if (sensitive && name !== CALL_SENSITIVE_TOOL) {
        throw new ContactToolError(
          "CONFIRMATION_REQUIRED",
          "This Contacts action requires explicit approval through call_sensitive_tool.",
          { tool: selected.name, entry_tool: CALL_SENSITIVE_TOOL }
        );
      }
      if (!sensitive && name === CALL_SENSITIVE_TOOL) {
        throw new ContactToolError(
          "INVALID_ENTRY_TOOL",
          "This Contacts action does not use the sensitive entry tool.",
          { tool: selected.name, entry_tool: CALL_TOOL }
        );
      }
      const directory = this.#requireEnabledDirectory();
      const data = this.#dispatch(selected.name, input, directory);
      signal?.throwIfAborted();
      return success(data);
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw error;
      return failure(error);
    }
  }

  #requireCaller(context: BridgeToolCallContext): SessionDescriptor {
    if (context.providerGeneration !== undefined && context.providerGeneration !== this.generation) {
      throw new ContactToolError("STALE_SCOPE", "Contacts Tool Provider generation is stale.");
    }
    let session: SessionDescriptor;
    let target;
    try {
      session = this.#store.getSession(context.sessionId).descriptor;
      target = this.#store.getTarget(context.targetId).descriptor;
    } catch {
      throw new ContactToolError("STALE_SCOPE", "Contacts tool scope is stale or unavailable.");
    }
    if (!target.trusted) {
      throw new ContactToolError("UNTRUSTED_TARGET", "Contacts tools require a trusted workspace.");
    }
    if (
      session.id !== context.sessionId ||
      session.targetId !== context.targetId ||
      session.backendId !== target.backendId ||
      session.binding.generation !== context.generation ||
      session.archived ||
      session.deletedAt !== undefined
    ) {
      throw new ContactToolError("STALE_SCOPE", "Contacts tool scope is stale or unavailable.");
    }
    if (this.#store.findSessionRuntimePolicy(session.id)?.policy === "review_read_only") {
      throw new ContactToolError("UNSUPPORTED_CAPABILITY", "Reviewer runtimes cannot access the private Contacts directory.");
    }
    return session;
  }

  #requireEnabledDirectory(): ContactDirectoryState {
    const directory = this.#contacts.directory();
    if (!directory.enabled) {
      throw new ContactToolError(
        "CONTACTS_NOT_READY",
        "Contacts is disabled. The user can enable it in Settings → Contacts."
      );
    }
    return directory;
  }

  #listTools(input: Readonly<Record<string, unknown>>): McpCallResult {
    assertKeys(input, ["category"]);
    const directory = this.#contacts.directory();
    const category = input["category"];
    if (category === undefined) {
      return success({
        directory_enabled: directory.enabled,
        directory_revision: directory.revision.toString(),
        categories: (["search", "read", "write", "manage"] as const).map((name) => ({
          name,
          tool_count: CONTACT_NESTED_TOOLS.filter((tool) => tool.category === name).length
        })),
        hint: "Call list_tools with one category, then use call_tool or call_sensitive_tool exactly as advertised."
      });
    }
    if (!isContactCategory(category)) {
      throw new ContactToolError("INVALID_ARGS", "category must be search, read, write, or manage.");
    }
    const selected = CONTACT_NESTED_TOOLS.filter((tool) => tool.category === category);
    return success({
      directory_enabled: directory.enabled,
      directory_revision: directory.revision.toString(),
      category,
      rules: [...new Set(selected.flatMap((tool) => tool.rules ?? []))],
      tools: selected.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        confirmation: tool.confirmation,
        entry_tool: tool.confirmation === "always" ? CALL_SENSITIVE_TOOL
          : tool.confirmation === "never" ? CALL_TOOL : "argument-dependent"
      }))
    });
  }

  #dispatch(name: string, input: Readonly<Record<string, unknown>>, directory: ContactDirectoryState): unknown {
    switch (name) {
      case "contacts_resolve": return this.#resolve(input);
      case "contacts_search": return this.#search(input);
      case "contacts_get": return this.#get(input);
      case "contacts_list": return this.#list(input);
      case "contacts_list_groups": return this.#listGroups(input);
      case "contacts_stats": return this.#stats(input, directory);
      case "contacts_create": return this.#create(input);
      case "contacts_update": return this.#update(input);
      case "contacts_confirm": return this.#confirm(input);
      case "contacts_add_identity": return this.#addIdentity(input);
      case "contacts_remove_identity": return this.#removeIdentity(input);
      case "contacts_append_event": return this.#appendEvent(input);
      case "contacts_remove_event": return this.#removeEvent(input);
      case "contacts_add_relation": return this.#addRelation(input);
      case "contacts_update_relation": return this.#updateRelation(input);
      case "contacts_remove_relation": return this.#removeRelation(input);
      case "contacts_delete": return this.#delete(input);
      case "contacts_merge": return this.#merge(input);
      case "contacts_find_duplicates": return this.#findDuplicates(input);
      case "contacts_create_group": return this.#createGroup(input);
      case "contacts_update_group": return this.#updateGroup(input);
      case "contacts_delete_group": return this.#deleteGroup(input);
      case "contacts_set_group_members": return this.#setGroupMembers(input);
      case "contacts_preview_vcard_import": return this.#previewVCard(input);
      case "contacts_get_vcard_import_preview": return this.#getVCardPreview(input);
      case "contacts_commit_vcard_import": return this.#commitVCard(input);
      case "contacts_export_vcard": return this.#exportVCard(input);
      default: throw new ContactToolError("UNKNOWN_TOOL", "The requested Contacts tool is unavailable.");
    }
  }

  #resolve(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["value", "platform", "limit"]);
    const value = requiredText(input, "value", 320);
    const platform = optionalPlatform(input, "platform");
    const limit = optionalInteger(input, "limit", 1, 20) ?? 5;
    if (platform !== undefined) {
      const profile = this.#contacts.resolveIdentity(platform, value);
      return {
        matches: profile === undefined ? [] : [{
          match_type: "identity",
          matched_identity: publicIdentity(requiredResolvedIdentity(profile, platform, value)),
          profile: compactProfile(profile)
        }]
      };
    }
    if (value.length > 256) throw new ContactToolError("INVALID_ARGS", "value exceeds the full-text lookup limit; specify platform.");
    const exactIdentities = this.#contacts.resolveIdentities(value, limit);
    const exactByContact = new Map(exactIdentities.map((identity) => [identity.contactId, identity]));
    const page = this.#contacts.list({ query: value, limit: Math.min(100, Math.max(20, limit * 5)), offset: 0 });
    const foldedValue = folded(value);
    const ranked = [
      ...exactIdentities.map((identity) => ({ contactId: identity.contactId, rank: 0, identity })),
      ...page.contacts.filter((summary) => !exactByContact.has(summary.id)).map((summary) => ({
        contactId: summary.id,
        rank: folded(summary.displayName) === foldedValue || summary.aliases.some((alias) => folded(alias) === foldedValue) ? 1 : 2,
        identity: undefined
      }))
    ].sort((left, right) => left.rank - right.rank);
    const selected = new Map<string, typeof ranked[number]>();
    for (const entry of ranked) {
      if (!selected.has(entry.contactId)) selected.set(entry.contactId, entry);
      if (selected.size >= limit) break;
    }
    const matches = [...selected.values()].map((entry) => ({
      match_type: entry.rank === 0 ? "identity" : entry.rank === 1 ? "name" : "fts",
      ...(entry.identity === undefined ? {} : { matched_identity: publicIdentity(entry.identity) }),
      profile: compactProfile(this.#contacts.get(entry.contactId))
    }));
    return { matches };
  }

  #search(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["query", "kind", "status", "limit", "offset"]);
    const page = this.#contacts.list({
      query: requiredText(input, "query", 256),
      ...(optionalKind(input["kind"]) === undefined ? {} : { kind: optionalKind(input["kind"])! }),
      ...(optionalStatus(input["status"]) === undefined ? {} : { status: optionalStatus(input["status"])! }),
      limit: optionalInteger(input, "limit", 1, 50) ?? 10,
      offset: optionalInteger(input, "offset", 0, 50_000) ?? 0
    });
    return publicContactPage(page);
  }

  #get(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["id", "event_offset", "event_limit", "group_offset", "group_limit", "relation_offset", "relation_limit"]);
    return publicProfile(this.#contacts.get(requiredId(input, "id")), {
      eventOffset: optionalInteger(input, "event_offset", 0, 10_000) ?? 0,
      eventLimit: optionalInteger(input, "event_limit", 1, MAXIMUM_PROFILE_PAGE_SIZE) ?? DEFAULT_PROFILE_PAGE_SIZE,
      groupOffset: optionalInteger(input, "group_offset", 0, 1_000) ?? 0,
      groupLimit: optionalInteger(input, "group_limit", 1, MAXIMUM_PROFILE_PAGE_SIZE) ?? DEFAULT_PROFILE_PAGE_SIZE,
      relationOffset: optionalInteger(input, "relation_offset", 0, 10_000) ?? 0,
      relationLimit: optionalInteger(input, "relation_limit", 1, MAXIMUM_PROFILE_PAGE_SIZE) ?? DEFAULT_PROFILE_PAGE_SIZE
    });
  }

  #list(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["kind", "status", "group_id", "limit", "offset"]);
    const kind = optionalKind(input["kind"]);
    const status = optionalStatus(input["status"]);
    const groupId = optionalId(input, "group_id");
    return publicContactPage(this.#contacts.list({
      ...(kind === undefined ? {} : { kind }),
      ...(status === undefined ? {} : { status }),
      ...(groupId === undefined ? {} : { groupId }),
      limit: optionalInteger(input, "limit", 1, 200) ?? 50,
      offset: optionalInteger(input, "offset", 0, 50_000) ?? 0
    }));
  }

  #listGroups(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, []);
    return { groups: this.#contacts.groups().map(publicGroup) };
  }

  #stats(input: Readonly<Record<string, unknown>>, directory: ContactDirectoryState): unknown {
    assertKeys(input, []);
    return { directory: publicDirectory(directory) };
  }

  #create(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["expected_directory_revision", "kind", "display_name", "aliases", "summary", "narrative", "agent_notes", "status", "identities", "allow_duplicate"]);
    const kind = requiredKind(input["kind"]);
    const aliases = optionalStringArray(input, "aliases", 20, 100);
    const identities = optionalIdentityArray(input["identities"]);
    const status = optionalStatus(input["status"]);
    const result = this.#contacts.createOrEnrichFromAgent({
      expectedDirectoryRevision: requiredRevision(input, "expected_directory_revision"),
      kind,
      displayName: requiredText(input, "display_name", 100),
      ...(aliases === undefined ? {} : { aliases }),
      ...optionalProperty(input, "summary", 300, "summary"),
      ...optionalProperty(input, "narrative", 16_384, "narrative"),
      ...optionalProperty(input, "agent_notes", 1_000, "agentNotes"),
      ...(status === undefined ? {} : { status }),
      ...(identities === undefined ? {} : { identities }),
      allowDuplicate: optionalBoolean(input, "allow_duplicate") ?? false
    });
    if (result.contact === undefined) {
      throw new ContactToolError("DUPLICATE_SUSPECT", "Similar contact names require explicit review before creation.", {
        candidates: result.candidates.slice(0, PREVIEW_CANDIDATE_LIMIT).map(publicCandidate),
        candidate_count: result.candidates.length,
        retry: { allow_duplicate: true }
      });
    }
    return {
      merged: result.merged,
      ...(result.mergedContactId === undefined ? {} : { merged_contact_id: result.mergedContactId }),
      contact: publicProfile(result.contact),
      directory: publicDirectory(this.#contacts.directory())
    };
  }

  #update(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["id", "expected_revision", "kind", "display_name", "aliases", "summary", "narrative", "agent_notes", "status"]);
    const kind = optionalKind(input["kind"]);
    const status = optionalStatus(input["status"]);
    const aliases = optionalStringArray(input, "aliases", 20, 100);
    const patch = {
      ...(kind === undefined ? {} : { kind }),
      ...optionalProperty(input, "display_name", 100, "displayName", false),
      ...(aliases === undefined ? {} : { aliases }),
      ...optionalProperty(input, "summary", 300, "summary"),
      ...optionalProperty(input, "narrative", 16_384, "narrative"),
      ...optionalProperty(input, "agent_notes", 1_000, "agentNotes"),
      ...(status === undefined ? {} : { status })
    };
    if (Object.keys(patch).length === 0) throw new ContactToolError("INVALID_ARGS", "contacts_update requires at least one patch field.");
    return mutationProfile(this.#contacts.update(requiredId(input, "id"), requiredRevision(input, "expected_revision"), patch), this.#contacts);
  }

  #confirm(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["id", "expected_revision"]);
    return mutationProfile(this.#contacts.confirm(requiredId(input, "id"), requiredRevision(input, "expected_revision")), this.#contacts);
  }

  #addIdentity(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["contact_id", "expected_revision", "platform", "value", "label", "note"]);
    return mutationProfile(this.#contacts.addIdentity(
      requiredId(input, "contact_id"),
      requiredRevision(input, "expected_revision"),
      identityDraft(input)
    ), this.#contacts);
  }

  #removeIdentity(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["contact_id", "expected_revision", "identity_id"]);
    return mutationProfile(this.#contacts.removeIdentity(
      requiredId(input, "contact_id"),
      requiredRevision(input, "expected_revision"),
      requiredId(input, "identity_id")
    ), this.#contacts);
  }

  #appendEvent(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["contact_id", "expected_revision", "date", "text", "source"]);
    return mutationProfile(this.#contacts.appendEvent(
      requiredId(input, "contact_id"),
      requiredRevision(input, "expected_revision"),
      {
        date: requiredText(input, "date", 10),
        text: requiredText(input, "text", 1_000),
        ...(optionalText(input, "source", 64, false) === undefined
          ? { source: "agent" }
          : { source: optionalText(input, "source", 64, false)! })
      }
    ), this.#contacts);
  }

  #removeEvent(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["contact_id", "expected_revision", "event_id"]);
    return mutationProfile(this.#contacts.removeEvent(
      requiredId(input, "contact_id"),
      requiredRevision(input, "expected_revision"),
      requiredId(input, "event_id")
    ), this.#contacts);
  }

  #addRelation(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["from_id", "expected_from_revision", "to_id", "relation", "note"]);
    const note = optionalText(input, "note", 1_000, true);
    return mutationProfile(this.#contacts.addRelation({
      fromContactId: requiredId(input, "from_id"),
      expectedFromRevision: requiredRevision(input, "expected_from_revision"),
      toContactId: requiredId(input, "to_id"),
      relation: requiredText(input, "relation", 30),
      ...(note === undefined ? {} : { note })
    }), this.#contacts);
  }

  #updateRelation(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["owner_id", "expected_owner_revision", "relation_id", "expected_relation_revision", "relation", "note"]);
    const note = optionalText(input, "note", 1_000, true);
    return mutationProfile(this.#contacts.updateRelation({
      ownerContactId: requiredId(input, "owner_id"),
      expectedOwnerRevision: requiredRevision(input, "expected_owner_revision"),
      relationId: requiredId(input, "relation_id"),
      expectedRelationRevision: requiredRevision(input, "expected_relation_revision"),
      relation: requiredText(input, "relation", 30),
      ...(note === undefined ? {} : { note })
    }), this.#contacts);
  }

  #removeRelation(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["owner_id", "expected_owner_revision", "relation_id"]);
    return mutationProfile(this.#contacts.removeRelation(
      requiredId(input, "owner_id"),
      requiredRevision(input, "expected_owner_revision"),
      requiredId(input, "relation_id")
    ), this.#contacts);
  }

  #delete(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["id", "expected_revision"]);
    const id = requiredId(input, "id");
    const deleted = this.#contacts.delete(id, requiredRevision(input, "expected_revision"));
    return { deleted, contact_id: id, directory: publicDirectory(this.#contacts.directory()) };
  }

  #merge(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["target_id", "expected_target_revision", "source_id", "expected_source_revision"]);
    const merged = this.#contacts.merge({
      targetContactId: requiredId(input, "target_id"),
      expectedTargetRevision: requiredRevision(input, "expected_target_revision"),
      mergedContactId: requiredId(input, "source_id"),
      expectedMergedRevision: requiredRevision(input, "expected_source_revision")
    });
    return {
      target: publicProfile(merged.target),
      merged_contact_id: merged.mergedContactId,
      moved_identities: merged.movedIdentities,
      moved_events: merged.movedEvents,
      moved_relations: merged.movedRelations,
      directory: publicDirectory(this.#contacts.directory())
    };
  }

  #findDuplicates(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["limit"]);
    return {
      pairs: this.#contacts.duplicates(optionalInteger(input, "limit", 1, 100) ?? 50).map((pair) => ({
        first: publicSummary(pair.first),
        second: publicSummary(pair.second)
      }))
    };
  }

  #createGroup(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["expected_directory_revision", "name", "description"]);
    const group = this.#contacts.createGroup(
      requiredRevision(input, "expected_directory_revision"),
      requiredText(input, "name", 60),
      optionalText(input, "description", 1_000, true) ?? ""
    );
    return { group: publicGroup(group), directory: publicDirectory(this.#contacts.directory()) };
  }

  #updateGroup(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["group_id", "expected_revision", "name", "description"]);
    const id = requiredId(input, "group_id");
    const current = this.#contacts.groups().find((group) => group.id === id);
    if (current === undefined) throw new ContactToolError("NOT_FOUND", "The contact group does not exist.");
    const name = optionalText(input, "name", 60, false);
    const description = optionalText(input, "description", 1_000, true);
    if (name === undefined && description === undefined) {
      throw new ContactToolError("INVALID_ARGS", "contacts_update_group requires name or description.");
    }
    const group = this.#contacts.updateGroup(
      id,
      requiredRevision(input, "expected_revision"),
      name ?? current.name,
      description ?? current.description
    );
    return { group: publicGroup(group), directory: publicDirectory(this.#contacts.directory()) };
  }

  #deleteGroup(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["group_id", "expected_revision"]);
    const groupId = requiredId(input, "group_id");
    return {
      deleted: this.#contacts.deleteGroup(groupId, requiredRevision(input, "expected_revision")),
      group_id: groupId,
      directory: publicDirectory(this.#contacts.directory())
    };
  }

  #setGroupMembers(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["group_id", "expected_group_revision", "add", "remove"]);
    const result = this.#contacts.setGroupMembers({
      groupId: requiredId(input, "group_id"),
      expectedGroupRevision: requiredRevision(input, "expected_group_revision"),
      add: membershipEntries(input["add"], "add"),
      remove: membershipEntries(input["remove"], "remove")
    });
    return {
      group: publicGroup(result.group),
      added: result.added,
      removed: result.removed,
      contacts: result.contacts.map(publicSummary),
      directory: publicDirectory(this.#contacts.directory())
    };
  }

  #previewVCard(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["vcard_text", "limit"]);
    const preview = this.#contacts.previewVCardImport(requiredVCardText(input["vcard_text"]));
    return publicPreviewPage(preview, 0, optionalInteger(input, "limit", 1, MAXIMUM_PREVIEW_PAGE_SIZE) ?? DEFAULT_PREVIEW_PAGE_SIZE);
  }

  #getVCardPreview(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["preview_id", "offset", "limit"]);
    const preview = this.#contacts.readVCardImportPreview(requiredId(input, "preview_id"));
    return publicPreviewPage(
      preview,
      optionalInteger(input, "offset", 0, 2_000) ?? 0,
      optionalInteger(input, "limit", 1, MAXIMUM_PREVIEW_PAGE_SIZE) ?? DEFAULT_PREVIEW_PAGE_SIZE
    );
  }

  #commitVCard(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["preview_id", "expected_directory_revision", "decisions"]);
    const result = this.#contacts.commitVCardImport({
      previewId: requiredId(input, "preview_id"),
      expectedDirectoryRevision: requiredRevision(input, "expected_directory_revision"),
      decisions: importDecisions(input["decisions"])
    });
    return {
      created: result.created,
      enriched: result.enriched,
      skipped: result.skipped,
      contact_ids: result.contactIds.slice(0, COMMIT_RESULT_LIMIT),
      contact_id_count: result.contactIds.length,
      entries: result.entries.slice(0, COMMIT_RESULT_LIMIT).map((entry) => ({
        entry_id: entry.entryId,
        display_name: entry.displayName,
        outcome: entry.outcome,
        ...(entry.contactId === undefined ? {} : { contact_id: entry.contactId })
      })),
      entry_count: result.entries.length,
      results_truncated: result.entries.length > COMMIT_RESULT_LIMIT || result.contactIds.length > COMMIT_RESULT_LIMIT,
      directory: publicDirectory(result.directory)
    };
  }

  #exportVCard(input: Readonly<Record<string, unknown>>): unknown {
    assertKeys(input, ["contact_ids"]);
    const ids = optionalIdArray(input, "contact_ids", 2_000) ?? [];
    const exported = this.#contacts.exportVCards(ids);
    return {
      vcard_text: exported.text,
      contact_count: exported.count,
      suggested_file_name: exported.suggestedFileName,
      directory_revision: this.#contacts.directory().revision.toString()
    };
  }
}

class ContactToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = "ContactToolError";
  }
}

function nestedTool(
  name: string,
  category: ContactToolCategory,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  confirmation: ContactToolConfirmation,
  rules?: readonly string[]
): ContactNestedToolDescriptor {
  return { name, category, description, inputSchema, confirmation, ...(rules === undefined ? {} : { rules }) };
}

function bridgeTool(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  requiresPermission: boolean
): McpToolDescriptor {
  return { serverId: CONTACT_TOOL_PROVIDER_ID, name, description, inputSchema, requiresPermission };
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = []
): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false
  };
}

function requiresConfirmation(
  tool: ContactNestedToolDescriptor,
  input: Readonly<Record<string, unknown>>
): boolean {
  if (tool.confirmation === "always") return true;
  if (tool.confirmation === "never") return false;
  if (tool.name !== "contacts_set_group_members") return true;
  const remove = input["remove"];
  return remove === undefined ? false : !Array.isArray(remove) || remove.length > 0;
}

function success(data: unknown): McpCallResult {
  const envelope = { ok: true, data };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: false
  };
}

function failure(error: unknown): McpCallResult {
  const classified = classifyError(error);
  const envelope = {
    ok: false,
    errorCode: classified.code,
    message: classified.message,
    ...(classified.details === undefined ? {} : { data: classified.details })
  };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: true
  };
}

function classifyError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
} {
  if (error instanceof ContactToolError) {
    return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  if (error instanceof ContactManagerError) {
    const code = error.code === "CONTACT_IMPORT_INVALID" ? "INVALID_ARGS"
      : error.code === "CONTACT_IMPORT_EXPIRED" ? "IMPORT_EXPIRED" : "PRECONDITION_FAILED";
    return { code, message: error.message };
  }
  if (error instanceof ContactStoreError) {
    const code = error.code === "CONTACT_INVALID" ? "INVALID_ARGS"
      : error.code === "CONTACT_NOT_FOUND" ? "NOT_FOUND"
        : error.code === "CONTACT_CHANGED" || error.code === "CONTACT_DIRECTORY_CHANGED" ? "PRECONDITION_FAILED"
          : error.code === "CONTACT_IDENTITY_CONFLICT" ? "IDENTITY_CONFLICT"
            : error.code === "CONTACT_ALREADY_EXISTS" ? "ALREADY_EXISTS" : "CONTACTS_NOT_READY";
    return {
      code,
      message: error.message,
      ...(error.conflictContactId === undefined ? {} : { details: { conflict_contact_id: error.conflictContactId } })
    };
  }
  return { code: "INTERNAL", message: "Contacts could not complete the request." };
}

function publicDirectory(value: ContactDirectoryState): Readonly<Record<string, unknown>> {
  return {
    revision: value.revision.toString(),
    enabled: value.enabled,
    people: value.people,
    organizations: value.organizations,
    pending: value.pending,
    groups: value.groups
  };
}

function publicSummary(value: ContactSummaryRecord): Readonly<Record<string, unknown>> {
  return {
    id: value.id,
    revision: value.revision.toString(),
    kind: value.kind,
    display_name: value.displayName,
    aliases: value.aliases,
    summary: value.summary,
    status: value.status,
    source: value.source,
    identity_count: value.identityCount,
    created_at: iso(value.createdAt),
    updated_at: iso(value.updatedAt)
  };
}

function publicContactPage(value: {
  readonly contacts: readonly ContactSummaryRecord[];
  readonly total: number;
  readonly nextOffset?: number;
}): Readonly<Record<string, unknown>> {
  return {
    contacts: value.contacts.map(publicSummary),
    total: value.total,
    ...(value.nextOffset === undefined ? {} : { next_offset: value.nextOffset })
  };
}

function publicIdentity(value: ContactProfileRecord["identities"][number]): Readonly<Record<string, unknown>> {
  return {
    id: value.id,
    revision: value.revision.toString(),
    platform: value.platform,
    value: value.value,
    label: value.label,
    note: value.note,
    created_at: iso(value.createdAt)
  };
}

interface PublicProfilePageOptions {
  readonly eventOffset: number;
  readonly eventLimit: number;
  readonly groupOffset: number;
  readonly groupLimit: number;
  readonly relationOffset: number;
  readonly relationLimit: number;
}

function publicProfile(
  value: ContactProfileRecord,
  options: PublicProfilePageOptions = {
    eventOffset: 0,
    eventLimit: DEFAULT_PROFILE_PAGE_SIZE,
    groupOffset: 0,
    groupLimit: DEFAULT_PROFILE_PAGE_SIZE,
    relationOffset: 0,
    relationLimit: DEFAULT_PROFILE_PAGE_SIZE
  }
): Readonly<Record<string, unknown>> {
  const events = value.events.slice(options.eventOffset, options.eventOffset + options.eventLimit);
  const groups = value.groups.slice(options.groupOffset, options.groupOffset + options.groupLimit);
  const relations = value.relations.slice(options.relationOffset, options.relationOffset + options.relationLimit);
  return {
    ...publicSummary(value),
    narrative: value.narrative,
    agent_notes: value.agentNotes,
    identities: value.identities.map(publicIdentity),
    events: events.map((event) => ({
      id: event.id,
      revision: event.revision.toString(),
      date: event.date,
      text: event.text,
      source: event.source,
      created_at: iso(event.createdAt)
    })),
    event_total: value.events.length,
    ...(options.eventOffset + events.length < value.events.length ? { event_next_offset: options.eventOffset + events.length } : {}),
    groups: groups.map(publicGroup),
    group_total: value.groups.length,
    ...(options.groupOffset + groups.length < value.groups.length ? { group_next_offset: options.groupOffset + groups.length } : {}),
    relations: relations.map((relation) => ({
      id: relation.id,
      revision: relation.revision.toString(),
      direction: relation.direction,
      from_contact_id: relation.fromContactId,
      to_contact_id: relation.toContactId,
      related_contact_id: relation.relatedContactId,
      related_display_name: relation.relatedDisplayName,
      related_kind: relation.relatedKind,
      relation: relation.relation,
      note: relation.note,
      created_at: iso(relation.createdAt)
    })),
    relation_total: value.relations.length,
    ...(options.relationOffset + relations.length < value.relations.length
      ? { relation_next_offset: options.relationOffset + relations.length }
      : {})
  };
}

function compactProfile(value: ContactProfileRecord): Readonly<Record<string, unknown>> {
  return {
    ...publicSummary(value),
    narrative: value.narrative,
    agent_notes: value.agentNotes,
    identities: value.identities.map(publicIdentity),
    recent_events: value.events.slice(0, RECENT_EVENT_LIMIT).map((event) => ({
      id: event.id,
      revision: event.revision.toString(),
      date: event.date,
      text: event.text,
      source: event.source
    })),
    event_total: value.events.length,
    groups: value.groups.slice(0, COMPACT_GROUP_LIMIT).map(publicGroup),
    group_total: value.groups.length,
    relations: value.relations.slice(0, COMPACT_RELATION_LIMIT).map((relation) => ({
      id: relation.id,
      revision: relation.revision.toString(),
      direction: relation.direction,
      related_contact_id: relation.relatedContactId,
      related_display_name: relation.relatedDisplayName,
      related_kind: relation.relatedKind,
      relation: relation.relation,
      note: relation.note
    })),
    relation_total: value.relations.length
  };
}

function publicGroup(value: ContactGroupRecord): Readonly<Record<string, unknown>> {
  return {
    id: value.id,
    revision: value.revision.toString(),
    name: value.name,
    description: value.description,
    member_count: value.memberCount,
    created_at: iso(value.createdAt),
    updated_at: iso(value.updatedAt)
  };
}

function publicCandidate(value: ContactDuplicateCandidate): Readonly<Record<string, unknown>> {
  return {
    match_type: value.matchType,
    contact_id: value.contactId,
    display_name: value.displayName,
    kind: value.kind,
    status: value.status,
    summary: value.summary,
    ...(value.matchedPlatform === undefined ? {} : { matched_platform: value.matchedPlatform }),
    ...(value.matchedValue === undefined ? {} : { matched_value: value.matchedValue })
  };
}

function publicPreviewPage(preview: ContactVCardImportPreview, offset: number, limit: number): Readonly<Record<string, unknown>> {
  if (offset > preview.entries.length) throw new ContactToolError("INVALID_ARGS", "Preview offset exceeds the entry count.");
  const entries = preview.entries.slice(offset, offset + limit);
  return {
    preview_id: preview.previewId,
    directory_revision: preview.directoryRevision.toString(),
    expires_at: iso(preview.expiresAt),
    entry_total: preview.entries.length,
    offset,
    entries: entries.map(publicPreviewEntry),
    ...(offset + entries.length < preview.entries.length ? { next_offset: offset + entries.length } : {})
  };
}

function publicPreviewEntry(entry: ContactVCardImportPreviewEntry): Readonly<Record<string, unknown>> {
  return {
    entry_id: entry.entryId,
    contact: publicDraft(entry.contact),
    disposition: entry.disposition,
    ...(entry.existingContactId === undefined ? {} : { existing_contact_id: entry.existingContactId }),
    ...(entry.existingEntryId === undefined ? {} : { existing_entry_id: entry.existingEntryId }),
    candidates: entry.candidates.slice(0, PREVIEW_CANDIDATE_LIMIT).map(publicCandidate),
    candidate_count: entry.candidates.length,
    candidates_truncated: entry.candidates.length > PREVIEW_CANDIDATE_LIMIT,
    similar_entry_ids: entry.similarEntryIds.slice(0, PREVIEW_CANDIDATE_LIMIT),
    similar_entry_count: entry.similarEntryIds.length,
    ...(entry.organizationName === undefined ? {} : { organization_name: entry.organizationName }),
    ...(entry.title === undefined ? {} : { title: entry.title }),
    groups: entry.groups,
    ...(entry.organizationContactId === undefined ? {} : { organization_contact_id: entry.organizationContactId }),
    organization_candidates: entry.organizationCandidates.slice(0, PREVIEW_CANDIDATE_LIMIT).map(publicCandidate),
    organization_candidate_count: entry.organizationCandidates.length,
    organization_candidates_truncated: entry.organizationCandidates.length > PREVIEW_CANDIDATE_LIMIT
  };
}

function publicDraft(value: ContactVCardImportPreviewEntry["contact"]): Readonly<Record<string, unknown>> {
  return {
    kind: value.kind,
    display_name: value.displayName,
    aliases: value.aliases ?? [],
    summary: value.summary ?? "",
    narrative: value.narrative ?? "",
    agent_notes: value.agentNotes ?? "",
    status: value.status ?? "confirmed",
    source: value.source ?? "import",
    identities: (value.identities ?? []).map((identity) => ({
      platform: identity.platform,
      value: identity.value,
      label: identity.label ?? "",
      note: identity.note ?? ""
    }))
  };
}

function mutationProfile(contact: ContactProfileRecord, manager: ContactManager): Readonly<Record<string, unknown>> {
  return { contact: publicProfile(contact), directory: publicDirectory(manager.directory()) };
}

function membershipEntries(value: unknown, field: string): readonly { readonly contactId: string; readonly expectedRevision: bigint }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new ContactToolError("INVALID_ARGS", `${field} is invalid.`);
  return value.map((item) => {
    const entry = record(item, field);
    assertKeys(entry, ["contact_id", "expected_revision"]);
    return {
      contactId: requiredId(entry, "contact_id"),
      expectedRevision: requiredRevision(entry, "expected_revision")
    };
  });
}

function importDecisions(value: unknown): readonly ContactVCardImportDecision[] {
  if (!Array.isArray(value) || value.length > 2_000) throw new ContactToolError("INVALID_ARGS", "decisions is invalid.");
  return value.map((item) => {
    const input = record(item, "decision");
    assertKeys(input, [
      "entry_id", "decision", "target_contact_id", "expected_target_revision", "target_entry_id",
      "confirmed_name_candidate_ids", "organization_decision", "organization_target_contact_id",
      "expected_organization_target_revision", "organization_target_entry_id",
      "confirmed_organization_candidate_ids"
    ]);
    const decision = requiredDecision(input["decision"], "decision");
    const organizationDecision = optionalDecision(input["organization_decision"], "organization_decision");
    const targetContactId = optionalId(input, "target_contact_id");
    const expectedTargetRevision = optionalRevision(input, "expected_target_revision");
    const targetEntryId = optionalId(input, "target_entry_id");
    const confirmed = optionalIdArray(input, "confirmed_name_candidate_ids", 100);
    const organizationTargetContactId = optionalId(input, "organization_target_contact_id");
    const expectedOrganizationTargetRevision = optionalRevision(input, "expected_organization_target_revision");
    const organizationTargetEntryId = optionalId(input, "organization_target_entry_id");
    const confirmedOrganization = optionalIdArray(input, "confirmed_organization_candidate_ids", 100);
    return {
      entryId: requiredId(input, "entry_id"),
      decision,
      ...(targetContactId === undefined ? {} : { targetContactId }),
      ...(expectedTargetRevision === undefined ? {} : { expectedTargetRevision }),
      ...(targetEntryId === undefined ? {} : { targetEntryId }),
      ...(confirmed === undefined ? {} : { confirmedNameCandidateIds: confirmed }),
      ...(organizationDecision === undefined ? {} : { organizationDecision }),
      ...(organizationTargetContactId === undefined ? {} : { organizationTargetContactId }),
      ...(expectedOrganizationTargetRevision === undefined ? {} : { expectedOrganizationTargetRevision }),
      ...(organizationTargetEntryId === undefined ? {} : { organizationTargetEntryId }),
      ...(confirmedOrganization === undefined ? {} : { confirmedOrganizationCandidateIds: confirmedOrganization })
    };
  });
}

function identityDraft(input: Readonly<Record<string, unknown>>): ContactIdentityDraft {
  const label = optionalText(input, "label", 100, true);
  const note = optionalText(input, "note", 1_000, true);
  return {
    platform: requiredPlatform(input, "platform"),
    value: requiredText(input, "value", 320),
    ...(label === undefined ? {} : { label }),
    ...(note === undefined ? {} : { note })
  };
}

function requiredResolvedIdentity(
  profile: ContactProfileRecord,
  platform: string,
  value: string
): ContactProfileRecord["identities"][number] {
  const normalized = normalizeContactIdentityValue(value, platform);
  const identity = profile.identities.find((candidate) =>
    candidate.platform === platform && candidate.normalizedValue === normalized
  );
  if (identity === undefined) throw new ContactToolError("INTERNAL", "Resolved contact is missing its exact identity.");
  return identity;
}

function requiredVCardText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0") || Buffer.byteLength(value, "utf8") > 2 * 1024 * 1024) {
    throw new ContactToolError("INVALID_ARGS", "vcard_text is invalid.");
  }
  return value;
}

function requiredPlatform(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = requiredText(input, key, 32);
  if (!/^[a-z0-9_-]{1,32}$/u.test(value)) throw new ContactToolError("INVALID_ARGS", `${key} is invalid.`);
  return normalizeContactPlatform(value);
}

function optionalPlatform(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return input[key] === undefined ? undefined : requiredPlatform(input, key);
}

function optionalIdentityArray(value: unknown): readonly ContactIdentityDraft[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 30) throw new ContactToolError("INVALID_ARGS", "identities is invalid.");
  return value.map((item) => {
    const input = record(item, "identity");
    assertKeys(input, ["platform", "value", "label", "note"]);
    return identityDraft(input);
  });
}

function optionalProperty(
  input: Readonly<Record<string, unknown>>,
  sourceKey: string,
  maximum: number,
  targetKey: string,
  allowEmpty = true
): Readonly<Record<string, string>> {
  const value = optionalText(input, sourceKey, maximum, allowEmpty);
  return value === undefined ? {} : { [targetKey]: value };
}

function optionalStringArray(
  input: Readonly<Record<string, unknown>>,
  key: string,
  maximumItems: number,
  maximumLength: number
): readonly string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems) throw new ContactToolError("INVALID_ARGS", `${key} is invalid.`);
  const result = value.map((item) => boundedText(item, key, maximumLength, false));
  if (new Set(result.map(folded)).size !== result.length) throw new ContactToolError("INVALID_ARGS", `${key} contains duplicates.`);
  return result;
}

function optionalIdArray(
  input: Readonly<Record<string, unknown>>,
  key: string,
  maximumItems: number
): readonly string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems) throw new ContactToolError("INVALID_ARGS", `${key} is invalid.`);
  const result = value.map((item) => boundedId(item, key));
  if (new Set(result).size !== result.length) throw new ContactToolError("INVALID_ARGS", `${key} contains duplicates.`);
  return result;
}

function requiredText(
  input: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
  allowNewlines = false
): string {
  return boundedText(input[key], key, maximum, false, allowNewlines);
}

function optionalText(
  input: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
  allowEmpty: boolean
): string | undefined {
  const value = input[key];
  return value === undefined ? undefined : boundedText(value, key, maximum, allowEmpty, key === "narrative");
}

function boundedText(value: unknown, field: string, maximum: number, allowEmpty: boolean, allowNewlines = false): string {
  if (typeof value !== "string" || value !== value.trim() || (!allowEmpty && value.length === 0) || value.length > maximum || value.includes("\0")) {
    throw new ContactToolError("INVALID_ARGS", `${field} is invalid.`);
  }
  if (!allowNewlines && /[\r\n\t]/u.test(value)) throw new ContactToolError("INVALID_ARGS", `${field} is invalid.`);
  return value;
}

function requiredId(input: Readonly<Record<string, unknown>>, key: string): string {
  return boundedId(input[key], key);
}

function optionalId(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return input[key] === undefined ? undefined : boundedId(input[key], key);
}

function boundedId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new ContactToolError("INVALID_ARGS", `${field} is invalid.`);
  }
  return value;
}

function requiredRevision(input: Readonly<Record<string, unknown>>, key: string): bigint {
  const value = optionalRevision(input, key);
  if (value === undefined) throw new ContactToolError("INVALID_ARGS", `${key} is required.`);
  return value;
}

function optionalRevision(input: Readonly<Record<string, unknown>>, key: string): bigint | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/u.test(value)) {
    throw new ContactToolError("INVALID_ARGS", `${key} is invalid.`);
  }
  const revision = BigInt(value);
  if (revision > BigInt(Number.MAX_SAFE_INTEGER)) throw new ContactToolError("INVALID_ARGS", `${key} is invalid.`);
  return revision;
}

function optionalInteger(
  input: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ContactToolError("INVALID_ARGS", `${key} is invalid.`);
  }
  return value as number;
}

function optionalBoolean(input: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ContactToolError("INVALID_ARGS", `${key} is invalid.`);
  return value;
}

function requiredKind(value: unknown): "person" | "organization" {
  if (value !== "person" && value !== "organization") throw new ContactToolError("INVALID_ARGS", "kind is invalid.");
  return value;
}

function optionalKind(value: unknown): "person" | "organization" | undefined {
  return value === undefined ? undefined : requiredKind(value);
}

function optionalStatus(value: unknown): "confirmed" | "pending" | undefined {
  if (value === undefined) return undefined;
  if (value !== "confirmed" && value !== "pending") throw new ContactToolError("INVALID_ARGS", "status is invalid.");
  return value;
}

function requiredDecision(value: unknown, field: string): "create" | "merge" | "skip" {
  if (value !== "create" && value !== "merge" && value !== "skip") throw new ContactToolError("INVALID_ARGS", `${field} is invalid.`);
  return value;
}

function optionalDecision(value: unknown, field: string): "create" | "merge" | "skip" | undefined {
  return value === undefined ? undefined : requiredDecision(value, field);
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContactToolError("INVALID_ARGS", `${field} must be a JSON object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw new ContactToolError("INVALID_ARGS", "Contacts tool arguments contain unknown fields.");
  }
}

function isContactCategory(value: unknown): value is ContactToolCategory {
  return value === "search" || value === "read" || value === "write" || value === "manage";
}

function folded(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

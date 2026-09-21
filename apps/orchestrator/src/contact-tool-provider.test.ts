import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionDescriptor } from "@joko/core";
import { ContactStore, OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { ContactManager } from "./contact-manager.js";
import {
  CONTACT_NESTED_TOOL_NAMES,
  CONTACT_TOOL_POLICY,
  ContactToolBridgeProvider
} from "./contact-tool-provider.js";
import type { BridgeToolCallContext, McpCallResult } from "./mcp-router.js";
import { mkdtempSync } from "./test-paths.js";

const NOW = Date.UTC(2026, 8, 21, 8, 0, 0);
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("ContactToolBridgeProvider", () => {
  it("publishes progressive discovery with separate ordinary and explicitly approved entry tools", async () => {
    const fixture = createFixture();
    expect(fixture.provider.tools.map((tool) => ({ name: tool.name, permission: tool.requiresPermission }))).toEqual([
      { name: "list_tools", permission: false },
      { name: "call_tool", permission: false },
      { name: "call_sensitive_tool", permission: true }
    ]);
    expect(fixture.provider.configurablePolicy).toBe(CONTACT_TOOL_POLICY);
    expect(CONTACT_NESTED_TOOL_NAMES).toHaveLength(27);
    expect(new Set(CONTACT_NESTED_TOOL_NAMES).size).toBe(27);

    const overview = resultData(await fixture.provider.callTool("list_tools", {}, undefined, context())) as {
      directory_enabled: boolean;
      categories: readonly { name: string; tool_count: number }[];
    };
    expect(overview).toEqual({
      directory_enabled: false,
      directory_revision: "1",
      categories: [
        { name: "search", tool_count: 2 },
        { name: "read", tool_count: 4 },
        { name: "write", tool_count: 10 },
        { name: "manage", tool_count: 11 }
      ],
      hint: expect.any(String)
    });
    const manage = resultData(await fixture.provider.callTool("list_tools", { category: "manage" }, undefined, context())) as {
      tools: readonly Record<string, unknown>[];
      rules: readonly string[];
    };
    expect(manage.tools).toHaveLength(11);
    expect(manage.rules).toEqual(expect.arrayContaining([expect.stringContaining("explicit instruction")]));
    expect(manage.tools.find((tool) => tool["name"] === "contacts_merge")).toMatchObject({
      confirmation: "always",
      entry_tool: "call_sensitive_tool",
      input_schema: expect.any(Object)
    });
    expect(manage.tools.find((tool) => tool["name"] === "contacts_set_group_members")).toMatchObject({
      confirmation: "conditional",
      entry_tool: "argument-dependent"
    });

    expect(errorData(await callOrdinary(fixture.provider, "contacts_stats", {}))).toMatchObject({
      errorCode: "CONTACTS_NOT_READY"
    });
  });

  it("fences the private directory to an active trusted caller and fails closed across entry-tool risk", async () => {
    const fixture = createFixture();
    enable(fixture.manager);
    expect(fixture.provider.includeForTarget("target-a")).toBe(true);
    expect(fixture.provider.includeForTarget("target-u")).toBe(false);
    expect(fixture.provider.includeForTarget("missing")).toBe(false);

    expect(errorData(await callOrdinary(fixture.provider, "contacts_stats", {}, {
      sessionId: "session-a",
      targetId: "target-a",
      generation: 6
    }))).toMatchObject({ errorCode: "STALE_SCOPE" });
    expect(errorData(await callOrdinary(fixture.provider, "contacts_stats", {}, {
      sessionId: "session-u",
      targetId: "target-u",
      generation: 7
    }))).toMatchObject({ errorCode: "UNTRUSTED_TARGET" });
    expect(errorData(await callOrdinary(fixture.provider, "contacts_stats", {}, {
      ...context(),
      providerGeneration: 2
    }))).toMatchObject({ errorCode: "STALE_SCOPE" });

    expect(errorData(await callOrdinary(fixture.provider, "contacts_delete", {
      id: "contact_missing",
      expected_revision: "1"
    }))).toMatchObject({
      errorCode: "CONFIRMATION_REQUIRED",
      data: { entry_tool: "call_sensitive_tool" }
    });
    expect(errorData(await callSensitive(fixture.provider, "contacts_search", { query: "Alice" }))).toMatchObject({
      errorCode: "INVALID_ENTRY_TOOL",
      data: { entry_tool: "call_tool" }
    });
    expect(errorData(await callOrdinary(fixture.provider, "contacts_set_group_members", {
      group_id: "contact_group_missing",
      expected_group_revision: "1",
      remove: "malformed"
    }))).toMatchObject({ errorCode: "CONFIRMATION_REQUIRED" });
    expect(errorData(await callOrdinary(fixture.provider, "contacts_future_tool", {}))).toMatchObject({
      errorCode: "UNKNOWN_TOOL",
      data: { available: CONTACT_NESTED_TOOL_NAMES }
    });
  });

  it("creates, enriches, resolves, searches, patches, and rejects ambiguous or conflicting identities", async () => {
    const fixture = createFixture();
    enable(fixture.manager);

    const created = resultData(await callOrdinary(fixture.provider, "contacts_create", {
      expected_directory_revision: revision(fixture.manager),
      kind: "person",
      display_name: "Alice Chen",
      status: "pending",
      summary: "Platform engineer",
      identities: [{ platform: "email", value: "alice@example.com", label: "work" }]
    })) as { merged: boolean; contact: { id: string; revision: string; source: string } };
    expect(created).toMatchObject({ merged: false, contact: { source: "agent" } });
    const aliceId = created.contact.id;

    const enriched = resultData(await callOrdinary(fixture.provider, "contacts_create", {
      expected_directory_revision: revision(fixture.manager),
      kind: "person",
      display_name: "Alice C.",
      narrative: "Met through the platform launch.",
      identities: [
        { platform: "email", value: "ALICE@example.com" },
        { platform: "github", value: "@alice" }
      ]
    })) as { merged: boolean; merged_contact_id: string; contact: { aliases: string[]; identities: unknown[] } };
    expect(enriched).toMatchObject({ merged: true, merged_contact_id: aliceId });
    expect(enriched.contact.aliases).toContain("Alice C.");
    expect(enriched.contact.identities).toHaveLength(2);

    const duplicate = errorData(await callOrdinary(fixture.provider, "contacts_create", {
      expected_directory_revision: revision(fixture.manager),
      kind: "person",
      display_name: "Alice Chen"
    }));
    expect(duplicate).toMatchObject({
      errorCode: "DUPLICATE_SUSPECT",
      data: { candidates: [expect.objectContaining({ contact_id: aliceId })], retry: { allow_duplicate: true } }
    });
    const second = resultData(await callOrdinary(fixture.provider, "contacts_create", {
      expected_directory_revision: revision(fixture.manager),
      kind: "person",
      display_name: "Alice Chen",
      allow_duplicate: true
    })) as { contact: { id: string; revision: string } };

    const resolved = resultData(await callOrdinary(fixture.provider, "contacts_resolve", {
      value: "@ALICE",
      platform: "github"
    })) as { matches: readonly { match_type: string; profile: { id: string } }[] };
    expect(resolved.matches).toEqual([expect.objectContaining({
      match_type: "identity",
      profile: expect.objectContaining({ id: aliceId })
    })]);
    const searched = resultData(await callOrdinary(fixture.provider, "contacts_search", {
      query: "Platform",
      status: "pending"
    })) as { contacts: readonly { id: string }[] };
    expect(searched.contacts.map((contact) => contact.id)).toContain(aliceId);

    const currentAlice = fixture.manager.get(aliceId);
    const confirmed = resultData(await callOrdinary(fixture.provider, "contacts_confirm", {
      id: aliceId,
      expected_revision: currentAlice.revision.toString()
    })) as { contact: { status: string; revision: string } };
    expect(confirmed.contact.status).toBe("confirmed");
    const updated = resultData(await callOrdinary(fixture.provider, "contacts_update", {
      id: aliceId,
      expected_revision: confirmed.contact.revision,
      agent_notes: "Use the work address for project updates."
    })) as { contact: { agent_notes: string } };
    expect(updated.contact.agent_notes).toContain("work address");

    expect(errorData(await callOrdinary(fixture.provider, "contacts_add_identity", {
      contact_id: second.contact.id,
      expected_revision: second.contact.revision,
      platform: "email",
      value: "alice@example.com"
    }))).toMatchObject({
      errorCode: "IDENTITY_CONFLICT",
      data: { conflict_contact_id: aliceId }
    });
    expect(errorData(await callOrdinary(fixture.provider, "contacts_update", {
      id: aliceId,
      expected_revision: fixture.manager.get(aliceId).revision.toString(),
      unknown: true
    }))).toMatchObject({ errorCode: "INVALID_ARGS" });
  });

  it("maintains events, directed relations, atomic group membership, and sensitive removals", async () => {
    const fixture = createFixture();
    enable(fixture.manager);
    const alice = createContact(fixture, "Alice", "person");
    const studio = createContact(fixture, "Northwind Studio", "organization");

    const eventResult = resultData(await callOrdinary(fixture.provider, "contacts_append_event", {
      contact_id: alice.id,
      expected_revision: alice.revision.toString(),
      date: "2026-09",
      text: "Joined the launch review",
      source: "session"
    })) as { contact: { revision: string; events: readonly { id: string }[] } };
    expect(eventResult.contact.events).toHaveLength(1);
    const eventId = eventResult.contact.events[0]!.id;

    const relationResult = resultData(await callOrdinary(fixture.provider, "contacts_add_relation", {
      from_id: alice.id,
      expected_from_revision: eventResult.contact.revision,
      to_id: studio.id,
      relation: "member",
      note: "Platform lead"
    })) as { contact: { relations: readonly { id: string }[] } };
    expect(relationResult.contact.relations).toHaveLength(1);

    const group = resultData(await callOrdinary(fixture.provider, "contacts_create_group", {
      expected_directory_revision: revision(fixture.manager),
      name: "Launch Team"
    })) as { group: { id: string; revision: string } };
    expect(errorData(await callOrdinary(fixture.provider, "contacts_set_group_members", {
      group_id: group.group.id,
      expected_group_revision: group.group.revision,
      add: [
        { contact_id: alice.id, expected_revision: fixture.manager.get(alice.id).revision.toString() },
        { contact_id: studio.id, expected_revision: "1" }
      ]
    }))).toMatchObject({ errorCode: "PRECONDITION_FAILED" });
    expect(fixture.manager.get(alice.id).groups).toEqual([]);
    expect(fixture.manager.groups().find((candidate) => candidate.id === group.group.id)?.memberCount).toBe(0);
    const added = resultData(await callOrdinary(fixture.provider, "contacts_set_group_members", {
      group_id: group.group.id,
      expected_group_revision: group.group.revision,
      add: [{ contact_id: alice.id, expected_revision: fixture.manager.get(alice.id).revision.toString() }]
    })) as { group: { revision: string; member_count: number }; added: number };
    expect(added).toMatchObject({ added: 1, group: { member_count: 1 } });

    expect(errorData(await callOrdinary(fixture.provider, "contacts_set_group_members", {
      group_id: group.group.id,
      expected_group_revision: added.group.revision,
      remove: [{ contact_id: alice.id, expected_revision: fixture.manager.get(alice.id).revision.toString() }]
    }))).toMatchObject({ errorCode: "CONFIRMATION_REQUIRED" });
    const removed = resultData(await callSensitive(fixture.provider, "contacts_set_group_members", {
      group_id: group.group.id,
      expected_group_revision: added.group.revision,
      remove: [{ contact_id: alice.id, expected_revision: fixture.manager.get(alice.id).revision.toString() }]
    })) as { removed: number; group: { member_count: number } };
    expect(removed).toMatchObject({ removed: 1, group: { member_count: 0 } });

    const beforeRemove = fixture.manager.get(alice.id);
    const relationId = beforeRemove.relations[0]!.id;
    const withoutRelation = resultData(await callSensitive(fixture.provider, "contacts_remove_relation", {
      owner_id: alice.id,
      expected_owner_revision: beforeRemove.revision.toString(),
      relation_id: relationId
    })) as { contact: { revision: string; relations: unknown[] } };
    expect(withoutRelation.contact.relations).toEqual([]);
    const withoutEvent = resultData(await callSensitive(fixture.provider, "contacts_remove_event", {
      contact_id: alice.id,
      expected_revision: withoutRelation.contact.revision,
      event_id: eventId
    })) as { contact: { events: unknown[] } };
    expect(withoutEvent.contact.events).toEqual([]);
  });

  it("previews paged vCards, atomically commits through the sensitive entry, and exports portable text", async () => {
    const fixture = createFixture();
    enable(fixture.manager);
    const text = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Import One",
      "EMAIL:one@example.com",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Import Two",
      "TEL:+86 138 0013 8000",
      "END:VCARD",
      ""
    ].join("\r\n");
    const preview = resultData(await callOrdinary(fixture.provider, "contacts_preview_vcard_import", {
      vcard_text: text,
      limit: 1
    })) as {
      preview_id: string;
      directory_revision: string;
      entry_total: number;
      entries: readonly { disposition: string }[];
      next_offset: number;
    };
    expect(preview).toMatchObject({ entry_total: 2, next_offset: 1, entries: [{ disposition: "create" }] });
    const secondPage = resultData(await callOrdinary(fixture.provider, "contacts_get_vcard_import_preview", {
      preview_id: preview.preview_id,
      offset: preview.next_offset,
      limit: 1
    })) as { entries: readonly { contact: { display_name: string } }[] };
    expect(secondPage.entries[0]?.contact.display_name).toBe("Import Two");

    expect(errorData(await callOrdinary(fixture.provider, "contacts_commit_vcard_import", {
      preview_id: preview.preview_id,
      expected_directory_revision: preview.directory_revision,
      decisions: []
    }))).toMatchObject({ errorCode: "CONFIRMATION_REQUIRED" });
    const committed = resultData(await callSensitive(fixture.provider, "contacts_commit_vcard_import", {
      preview_id: preview.preview_id,
      expected_directory_revision: preview.directory_revision,
      decisions: []
    })) as { created: number; entry_count: number; contact_ids: readonly string[] };
    expect(committed).toMatchObject({ created: 2, entry_count: 2 });

    const exported = resultData(await callOrdinary(fixture.provider, "contacts_export_vcard", {
      contact_ids: committed.contact_ids
    })) as { vcard_text: string; contact_count: number; suggested_file_name: string };
    expect(exported.contact_count).toBe(2);
    expect(exported.vcard_text).toContain("FN:Import One");
    expect(exported.vcard_text).toContain("FN:Import Two");
    expect(exported.suggested_file_name).toMatch(/^joko-contacts-/u);
  });

  it("revision-fences destructive merge and delete while preserving typed failures", async () => {
    const fixture = createFixture();
    enable(fixture.manager);
    const first = createContact(fixture, "Merge Target", "person");
    const second = createContact(fixture, "Merge Source", "person");

    expect(errorData(await callSensitive(fixture.provider, "contacts_merge", {
      target_id: first.id,
      expected_target_revision: "1",
      source_id: second.id,
      expected_source_revision: second.revision.toString()
    }))).toMatchObject({ errorCode: "PRECONDITION_FAILED" });
    const merged = resultData(await callSensitive(fixture.provider, "contacts_merge", {
      target_id: first.id,
      expected_target_revision: fixture.manager.get(first.id).revision.toString(),
      source_id: second.id,
      expected_source_revision: fixture.manager.get(second.id).revision.toString()
    })) as { target: { id: string; revision: string }; merged_contact_id: string };
    expect(merged).toMatchObject({ target: { id: first.id }, merged_contact_id: second.id });
    expect(() => fixture.manager.get(second.id)).toThrow();

    expect(errorData(await callSensitive(fixture.provider, "contacts_delete", {
      id: first.id,
      expected_revision: "1"
    }))).toMatchObject({ errorCode: "PRECONDITION_FAILED" });
    expect(resultData(await callSensitive(fixture.provider, "contacts_delete", {
      id: first.id,
      expected_revision: merged.target.revision
    }))).toMatchObject({ deleted: true, contact_id: first.id });
  });
});

function createFixture(): {
  readonly operational: OperationalStore;
  readonly contacts: ContactStore;
  readonly manager: ContactManager;
  readonly provider: ContactToolBridgeProvider;
} {
  const root = mkdtempSync(join(tmpdir(), "joko-contact-tools-"));
  const trustedRoot = join(root, "trusted");
  const untrustedRoot = join(root, "untrusted");
  mkdirSync(trustedRoot, { recursive: true });
  mkdirSync(untrustedRoot, { recursive: true });
  const operational = new OperationalStore(":memory:");
  operational.upsertBackend({
    id: "backend-a",
    displayName: "Backend A",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  operational.upsertTarget({
    id: "target-a",
    backendId: "backend-a",
    displayName: "Trusted",
    workspaceRoot: trustedRoot,
    managed: false,
    trusted: true
  });
  operational.upsertTarget({
    id: "target-u",
    backendId: "backend-a",
    displayName: "Untrusted",
    workspaceRoot: untrustedRoot,
    managed: false,
    trusted: false
  });
  createSession(operational, "session-a", "target-a");
  createSession(operational, "session-u", "target-u");
  const contacts = new ContactStore(join(root, "contacts.db"), { now: () => NOW });
  const manager = new ContactManager(contacts, { now: () => NOW });
  const provider = new ContactToolBridgeProvider({ store: operational, contacts: manager });
  cleanups.push(() => {
    manager.close();
    contacts.close();
    operational.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { operational, contacts, manager, provider };
}

function createSession(store: OperationalStore, id: string, targetId: string): void {
  const input: SessionDescriptor = {
    id,
    backendId: "backend-a",
    targetId,
    title: id,
    binding: { opaqueRef: `${id}.jsonl`, generation: 7 },
    pinned: false,
    archived: false,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    createdAt: NOW,
    updatedAt: NOW
  };
  store.createSession(input);
}

function enable(manager: ContactManager): void {
  manager.setEnabled(manager.directory().revision, true);
}

function createContact(
  fixture: ReturnType<typeof createFixture>,
  displayName: string,
  kind: "person" | "organization"
): ContactProfileRecordLike {
  const result = fixture.manager.create({
    expectedDirectoryRevision: fixture.manager.directory().revision,
    kind,
    displayName,
    source: "manual"
  }).contact;
  if (result === undefined) throw new Error("Fixture contact was not created.");
  return { id: result.id, revision: result.revision };
}

interface ContactProfileRecordLike {
  readonly id: string;
  readonly revision: bigint;
}

function revision(manager: ContactManager): string {
  return manager.directory().revision.toString();
}

async function callOrdinary(
  provider: ContactToolBridgeProvider,
  name: string,
  args: Readonly<Record<string, unknown>>,
  callContext = context()
): Promise<McpCallResult> {
  return provider.callTool("call_tool", { name, args }, undefined, callContext);
}

async function callSensitive(
  provider: ContactToolBridgeProvider,
  name: string,
  args: Readonly<Record<string, unknown>>,
  callContext = context()
): Promise<McpCallResult> {
  return provider.callTool("call_sensitive_tool", { name, args }, undefined, callContext);
}

function context(): BridgeToolCallContext;
function context(sessionId: string, targetId: string): BridgeToolCallContext;
function context(sessionId = "session-a", targetId = "target-a"): BridgeToolCallContext {
  return { sessionId, targetId, generation: 7, providerGeneration: 1 };
}

function resultData(result: McpCallResult): unknown {
  expect(result.isError).toBe(false);
  return result.structuredContent?.["data"];
}

function errorData(result: McpCallResult): Readonly<Record<string, unknown>> {
  expect(result.isError).toBe(true);
  return result.structuredContent ?? {};
}

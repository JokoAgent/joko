import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { SessionDescriptor } from "@joko/core";
import { ContactStore, OperationalStore, type ContactDraft } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContactManager } from "./contact-manager.js";
import {
  CONTACT_NESTED_TOOL_NAMES,
  CONTACT_TOOL_POLICY,
  ContactToolBridgeProvider
} from "./contact-tool-provider.js";
import type { BridgeToolCallContext, McpCallResult } from "./mcp-router.js";
import { SystemContactsPermissionError, type NativeSystemContactsPort } from "./input-handoff/native-host.js";
import type { SystemContactToolsOptions } from "./system-contact-tools.js";
import { mkdtempSync } from "./test-paths.js";

const NOW = Date.UTC(2026, 8, 21, 8, 0, 0);
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("ContactToolBridgeProvider", () => {
  it("offers system import only to the originating Desktop and asks before every native read", async () => {
    const f = createFixture();
    enable(f.manager);
    const existing = createContact(f, "Ada Lovelace", "person");
    const read = vi.fn<NativeSystemContactsPort["read"]>(async (_input, check) => {
      check();
      return create(contract.NativeSystemContactsReadResponseSchema, { cards: [
        { nativeId: "apple-ada", fields: { kind: contract.ContactKind.PERSON, displayName: "Ada Lovelace",
          emails: [{ value: "ada@example.test" }, { value: "ADA@example.test" }] } },
        { nativeId: "apple-grace", fields: { kind: contract.ContactKind.PERSON, displayName: "Grace Hopper" } }
      ] });
    });
    const { provider, callContext, approve } = systemFixture(f, { read });
    const input = { dry_run: true, name_contains: "Ada", require_email: true, group: "Imported" };
    expect(errorData(await callOrdinary(provider, "contacts_import_system", input))).toMatchObject({ errorCode: "UNKNOWN_TOOL" });
    approve.mockResolvedValueOnce(false);
    expect(errorData(await callOrdinary(provider, "contacts_import_system", input, callContext("denied"))))
      .toMatchObject({ errorCode: "PERMISSION_DENIED" });
    expect(read).not.toHaveBeenCalled();
    const before = f.manager.directory();
    read.mockResolvedValueOnce(create(contract.NativeSystemContactsReadResponseSchema, { cards: [
      { nativeId: "apple-ada", fields: { kind: contract.ContactKind.PERSON, displayName: "Ada Lovelace", emails: [{ value: "ada@example.test" }] } }
    ] }));
    expect(resultData(await callOrdinary(provider, "contacts_import_system", input, callContext("dry"))))
      .toEqual({ dryRun: true, total: 1, withEmail: 1, withOrg: 0, sample: ["Ada Lovelace"] });
    expect(read.mock.calls[0]?.[0]).toMatchObject({ nameContains: "Ada", requireEmail: true });
    expect(f.manager.directory()).toEqual(before);
    expect(f.manager.groups()).toEqual([]);
    expect(approve).toHaveBeenCalledTimes(2);

    expect(resultData(await callOrdinary(provider, "contacts_import_system", { group: "Imported" }, callContext("import"))))
      .toMatchObject({ created: 1, enriched: 0, skipped: 1, reviewCount: 1, needsReview: ["Ada Lovelace"] });
    expect(f.manager.get(existing.id).identities).toEqual([]);
    const grace = f.manager.list({ query: "Grace Hopper" }).contacts[0]!;
    expect(f.contacts.findSystemContactOwner("device-contacts", "apple-grace")).toBe(grace.id);
    expect(f.manager.get(grace.id).groups).toEqual([expect.objectContaining({ name: "Imported" })]);
    expect(JSON.stringify(f.contacts.readContactSyncState("source-node").state,
      (_key, value) => typeof value === "bigint" ? String(value) : value)).not.toContain("apple-grace");
  });

  it("previews a local write, skips pending, adopts only exact native receipts and replays the original operation", async () => {
    const f = createFixture();
    enable(f.manager);
    const person = f.manager.create({
      kind: "person", displayName: "Grace Hopper", summary: "Private summary", narrative: "Private narrative",
      agentNotes: "Private agent note", identities: [{ platform: "email", value: "grace@example.test" },
        { platform: "signal", value: "private-signal" }], expectedDirectoryRevision: f.manager.directory().revision
    }).contact!;
    const pending = f.manager.create({ kind: "person", displayName: "Pending person", status: "pending",
      expectedDirectoryRevision: f.manager.directory().revision }).contact!;
    const organization = createContact(f, "Research Laboratory", "organization");
    f.manager.addRelation({ fromContactId: person.id, expectedFromRevision: person.revision,
      toContactId: organization.id, relation: "works at", note: "Engineer" });
    const write = vi.fn<NativeSystemContactsPort["write"]>(async (request, check, admit) => {
      check();
      admit();
      check();
      return create(contract.NativeSystemContactsWriteResponseSchema, { receipts: [{
        contactId: request.items[0]!.contactId, nativeId: "apple-grace", outcome: contract.NativeSystemContactWriteOutcome.CREATED
      }] });
    });
    const { provider, callContext, approve } = systemFixture(f, { write });
    const ids = [person.id, pending.id, person.id];
    expect(resultData(await callOrdinary(provider, "contacts_export_system", { ids, dry_run: true }, callContext("plan"))))
      .toMatchObject({ toCreate: ["Grace Hopper"], skippedPending: ["Pending person"] });
    expect(approve).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();

    const execution = () => callOrdinary(provider, "contacts_export_system", { ids }, callContext("write"));
    const first = await execution();
    expect(resultData(first)).toMatchObject({ created: 1, updated: 0, skippedPending: 1, operation_id: "mcp-contacts:write" });
    expect(await execution()).toEqual(first);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(errorData(await callOrdinary(provider, "contacts_export_system", { ids: [organization.id] }, {
      ...callContext("write"), requestBodyHash: "conflicting-body"
    }))).toMatchObject({ errorCode: "OPERATION_CONFLICT" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0].items).toEqual([expect.objectContaining({ contactId: person.id,
      fields: expect.objectContaining({ displayName: "Grace Hopper", organizationName: "Research Laboratory", title: "Engineer",
        emails: [expect.objectContaining({ value: "grace@example.test" })], phones: [] }) })]);
    expect(JSON.stringify(write.mock.calls[0]?.[0])).not.toMatch(/Private|private-signal/u);
    expect(f.contacts.systemContactAnchor("device-contacts", person.id)).toEqual({ nativeId: "apple-grace", unresolved: false });

    write.mockImplementationOnce(async (request, check, admit) => {
      check();
      admit();
      expect(request.items[0]?.nativeId).toBe("apple-grace");
      return create(contract.NativeSystemContactsWriteResponseSchema, { receipts: [{
        contactId: person.id, outcome: contract.NativeSystemContactWriteOutcome.MISSING
      }] });
    });
    expect(resultData(await callOrdinary(provider, "contacts_export_system", { ids: [person.id] }, callContext("missing"))))
      .toMatchObject({ created: 0, missing: 1, issues: [{ contact_id: person.id, outcome: "missing" }] });
    expect(f.contacts.systemContactAnchor("device-contacts", person.id)).toEqual({ nativeId: "apple-grace", unresolved: false });
  });

  it("holds an unconfirmed create and releases a known denial before a later write", async () => {
    const f = createFixture();
    enable(f.manager);
    const uncertain = createContact(f, "Grace Hopper", "person");
    const denied = createContact(f, "Barbara Liskov", "person");
    const write = vi.fn<NativeSystemContactsPort["write"]>(async (_request, _check, admit) => {
      admit();
      throw new Error("The Main mailbox stopped after admitting the write.");
    });
    const { provider, callContext } = systemFixture(f, { write });
    const uncertainWrite = () => callOrdinary(provider, "contacts_export_system", { ids: [uncertain.id] }, callContext("unknown"));
    expect(errorData(await uncertainWrite())).toMatchObject({
      errorCode: "EFFECT_OUTCOME_UNKNOWN", data: { unknown: 1, operation_id: "mcp-contacts:unknown" }
    });
    expect(errorData(await uncertainWrite())).toMatchObject({ errorCode: "EFFECT_OUTCOME_UNKNOWN" });
    expect(f.operational.getOperation("mcp-contacts:unknown")).toMatchObject({ status: "failed", error: { stateMayHaveChanged: true } });
    expect(resultData(await callOrdinary(provider, "contacts_export_system", { ids: [uncertain.id] }, callContext("later"))))
      .toMatchObject({ unresolved: 1, created: 0 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(f.contacts.systemContactAnchor("device-contacts", uncertain.id)).toEqual({ unresolved: true });

    write.mockImplementationOnce(async (_request, _check, admit) => {
      admit();
      throw new SystemContactsPermissionError();
    });
    expect(errorData(await callOrdinary(provider, "contacts_export_system", { ids: [denied.id] }, callContext("permission"))))
      .toMatchObject({ errorCode: "PERMISSION_DENIED", data: { unknown: 0, skipped: 1 } });
    expect(f.contacts.systemContactAnchor("device-contacts", denied.id)).toEqual({ unresolved: false });
  });

  it("keeps the first batch's anchors when a later batch from the same group loses its receipt", async () => {
    const f = createFixture();
    enable(f.manager);
    const group = f.manager.createGroup(f.manager.directory().revision, "Selected team", "");
    const names = ["Cedar Grove", "Riverbank", "Aster Design", "Muir Lawn", "Ocean Laboratory", "Gray Stone", "Sparrow"];
    for (const [index, displayName] of names.entries()) {
      const profile = f.manager.create({
        kind: "person", displayName, expectedDirectoryRevision: f.manager.directory().revision,
        identities: Array.from({ length: 30 }, (_unused, entry) => ({
          platform: "email", value: `${index}-${entry}-${"a".repeat(285)}@example.test`, label: "w".repeat(90)
        }))
      }).contact!;
      f.manager.setGroupMembership(profile.id, profile.revision, group.id, true);
    }
    const write = vi.fn<NativeSystemContactsPort["write"]>()
      .mockImplementationOnce(async (request, check, admit) => {
        admit();
        check();
        return create(contract.NativeSystemContactsWriteResponseSchema, { receipts: request.items.map(item => ({
          contactId: item.contactId, outcome: contract.NativeSystemContactWriteOutcome.CREATED, nativeId: `apple:${item.contactId}`
        })) });
      }).mockImplementationOnce(async (_request, _check, admit) => {
        admit();
        throw new Error("Lost the second native receipt.");
      });
    const { provider, callContext, approve } = systemFixture(f, { write });
    const result = await callOrdinary(provider, "contacts_export_system", { group: group.name }, callContext("group"));
    expect(write).toHaveBeenCalledTimes(2);
    expect(approve).toHaveBeenCalledOnce();
    const first = write.mock.calls[0]![0].items;
    const second = write.mock.calls[1]![0].items;
    expect(first.length + second.length).toBe(names.length);
    expect(errorData(result)).toMatchObject({
      errorCode: "EFFECT_OUTCOME_UNKNOWN", data: { created: first.length, unknown: second.length, operation_id: "mcp-contacts:group" }
    });
    for (const item of first) expect(f.contacts.systemContactAnchor("device-contacts", item.contactId))
      .toEqual({ unresolved: false, nativeId: `apple:${item.contactId}` });
    for (const item of second) expect(f.contacts.systemContactAnchor("device-contacts", item.contactId))
      .toEqual({ unresolved: true });
    expect(f.operational.getOperation("mcp-contacts:group").error).toMatchObject({
      message: expect.stringContaining(`Confirmed created: ${first.length}.`)
    });
  });

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

  it("resolves exact identities and names before a bounded page of weak full-text matches", async () => {
    const { manager, provider } = createFixture();
    enable(manager);
    const create = (draft: Omit<ContactDraft, "kind">) => {
      const profile = manager.create({ ...draft, kind: "person", expectedDirectoryRevision: manager.directory().revision }).contact;
      if (profile === undefined) throw new Error("Fixture contact was not created.");
      return profile;
    };
    const exact = create({
      displayName: "Zoe",
      aliases: ["星河", "Ａster"],
      narrative: "Background details kept for the contact record. ".repeat(240).trim()
    });
    for (let i = 0; i < 26; i += 1) {
      create({ displayName: `Colleague ${i}`, summary: "Met Zoe at the industry event." });
    }
    const oldWindow = manager.list({ query: "Zoe", limit: 25 });
    expect(oldWindow.contacts).toHaveLength(25);
    expect(oldWindow.contacts.map(({ id }) => id)).not.toContain(exact.id);

    const resolve = async (args: Record<string, unknown>) =>
      (resultData(await callOrdinary(provider, "contacts_resolve", args)) as {
        matches: readonly { match_type: string; profile: { id: string } }[];
      }).matches;
    for (const value of ["zoe", "星河", "aster"]) {
      expect(await resolve({ value })).toEqual([
        expect.objectContaining({ match_type: "name", profile: expect.objectContaining({ id: exact.id }) })
      ]);
    }

    const github = create({ displayName: "Taylor", identities: [{ platform: "github", value: "Zoe" }] });
    const slack = create({ displayName: "Morgan", identities: [{ platform: "slack", value: "Zoe" }] });
    const identities = await resolve({ value: "Zoe" });
    expect(identities.map(match => [match.match_type, match.profile.id]))
      .toEqual(expect.arrayContaining([["identity", github.id], ["identity", slack.id]]));
    expect(identities).toHaveLength(2);
    expect(await resolve({ value: "Zoe", platform: "github" })).toEqual([
      expect.objectContaining({ match_type: "identity", profile: expect.objectContaining({ id: github.id }) })
    ]);
    expect(await resolve({ value: "Zoe", platform: "email" })).toEqual([]);

    const fallback = await resolve({ value: "industry", limit: 20 });
    expect(fallback).toHaveLength(20);
    expect(fallback.every(match => match.match_type === "fts")).toBe(true);
    expect(await resolve({ value: "industry" })).toEqual(fallback.slice(0, 5));
  });

  it("returns the adopted narrative and an explicit atomic error when exact-identity enrichment is too large", async () => {
    const fixture = createFixture();
    enable(fixture.manager);
    const original = fixture.manager.create({ expectedDirectoryRevision: fixture.manager.directory().revision,
      kind: "person", displayName: "Alice", narrative: "去年在会议认识",
      identities: [{ platform: "email", value: "alice@example.test" }] }).contact!;
    const enrich = (narrative: string) => callOrdinary(fixture.provider, "contacts_create", {
      expected_directory_revision: revision(fixture.manager), kind: "person", display_name: "Alice",
      narrative, identities: [{ platform: "email", value: "ALICE@example.test" }]
    });
    const adopted = resultData(await enrich("现在负责采购"));
    expect(adopted).toMatchObject({ merged: true, merged_contact_id: original.id,
      contact: { narrative: "去年在会议认识\n\n<!-- agent enrich 2026-09-21 -->\n现在负责采购" } });
    const current = fixture.manager.get(original.id);
    const afterAppend = fixture.manager.directory();
    for (const invalid of [" \t\n ", " 现在负责采购 "]) {
      expect(errorData(await enrich(invalid))).toMatchObject({ errorCode: "INVALID_ARGS" });
    }
    expect(fixture.manager.get(original.id)).toEqual(current);
    expect(fixture.manager.directory()).toEqual(afterAppend);
    const full = fixture.manager.update(current.id, current.revision, { narrative: "界".repeat(5_461) });
    const before = fixture.manager.directory();
    expect(errorData(await enrich("new context"))).toMatchObject({ errorCode: "INVALID_ARGS", message: "Contact narrative is too large." });
    expect(fixture.manager.get(original.id)).toEqual(full);
    expect(fixture.manager.directory()).toEqual(before);
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
    expect(resultData(await callOrdinary(fixture.provider, "contacts_append_event", {
      contact_id: alice.id,
      expected_revision: fixture.manager.get(alice.id).revision.toString(),
      date: "2026-09",
      text: "Agent observation"
    }))).toMatchObject({ contact: { events: [expect.objectContaining({ date: "2026-09", text: "Agent observation", source: "agent" })] } });
  });

  it("pages rejected and valid vCards together and reports rejection reasons through the approved commit", async () => {
    const fixture = createFixture();
    enable(fixture.manager);
    const card = (name: string) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${name}\r\nEND:VCARD\r\n`;
    const first = resultData(await callOrdinary(fixture.provider, "contacts_preview_vcard_import", {
      vcard_text: card("x".repeat(101)) + card("Bob") + card("y".repeat(101)), limit: 1
    })) as { preview_id: string; directory_revision: string; next_offset: number };
    expect(first).toMatchObject({ entry_total: 3, entries: [], rejected_entry_count: 2, next_offset: 1,
      rejected_entries: [{ entry_id: "vcard-entry-1", reason: "Contact display name is invalid." }] });
    const second = resultData(await callOrdinary(fixture.provider, "contacts_get_vcard_import_preview", {
      preview_id: first.preview_id, offset: first.next_offset, limit: 1
    }));
    expect(second).toMatchObject({ entries: [{ entry_id: "vcard-entry-2", disposition: "create" }], rejected_entries: [], next_offset: 2 });
    const last = resultData(await callOrdinary(fixture.provider, "contacts_get_vcard_import_preview", {
      preview_id: first.preview_id, offset: 2, limit: 1
    }));
    expect(last).toMatchObject({ entries: [], rejected_entries: [{ entry_id: "vcard-entry-3", reason: "Contact display name is invalid." }] });
    expect(last).not.toHaveProperty("next_offset");
    expect(errorData(await callOrdinary(fixture.provider, "contacts_get_vcard_import_preview", {
      preview_id: first.preview_id, offset: 4, limit: 1
    }))).toMatchObject({ errorCode: "INVALID_ARGS" });
    const commit = { preview_id: first.preview_id, expected_directory_revision: first.directory_revision, decisions: [] };
    expect(errorData(await callOrdinary(fixture.provider, "contacts_commit_vcard_import", commit))).toMatchObject({ errorCode: "CONFIRMATION_REQUIRED" });
    expect(resultData(await callSensitive(fixture.provider, "contacts_commit_vcard_import", commit))).toMatchObject({
      created: 1, enriched: 0, skipped: 2, entries: [
        { entry_id: "vcard-entry-1", outcome: "skipped", reason: "Contact display name is invalid." },
        { entry_id: "vcard-entry-2", outcome: "created" },
        { entry_id: "vcard-entry-3", outcome: "skipped", reason: "Contact display name is invalid." }
      ]
    });
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

function systemFixture(f: ReturnType<typeof createFixture>, effects: Partial<NativeSystemContactsPort>) {
  const connection = f.operational.createConnection({ id: "connection-contacts", deviceId: "device-contacts",
    name: "Desktop", authKeyDigest: "contacts-fixture-digest" });
  const scope = { id: "contacts-queue", runId: "contacts-run", attemptId: "contacts-attempt" };
  const prompt = { text: "Use my macOS Contacts", images: [], files: [], mentions: [], disposition: "prompt" } as const;
  f.operational.runOperation({ id: "contacts-send", connectionId: connection.id, kind: "sendInput", body: prompt }, store => {
    store.createRun({ id: scope.runId, sessionId: "session-a", source: "user", state: "queued", createdAt: NOW });
    store.createAttempt({ id: scope.attemptId, runId: scope.runId, ordinal: 1, generation: 7, startedAt: NOW });
    store.enqueueQueueItem({ id: scope.id, sessionId: "session-a", runId: scope.runId, attemptId: scope.attemptId,
      operationId: "contacts-send", body: prompt, disposition: "prompt" });
    return {};
  });
  expect(f.operational.claimNextQueueItem({ sessionId: "session-a", backendInstanceGeneration: 0 })?.id).toBe(scope.id);
  const port: NativeSystemContactsPort = {
    connectionId: connection.id, deviceId: connection.deviceId, assertCurrent: () => {},
    read: async () => { throw new Error("Unexpected native read."); },
    write: async () => { throw new Error("Unexpected native write."); },
    ...effects
  };
  const approve = vi.fn<SystemContactToolsOptions["approve"]>(async request => {
    request.assertCurrent();
    return true;
  });
  const provider = new ContactToolBridgeProvider({ store: f.operational, contacts: f.manager,
    systemContacts: { getPort: () => port, approve } });
  const callContext = (id: string): BridgeToolCallContext => ({ ...context(), localProductScope: true, inputQueueItem: scope,
    requestIdentity: id, requestBodyHash: `body-${id}`, effectIdentity: `effect-${id}`, assertCurrent: () => {} });
  return { provider, callContext, approve };
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

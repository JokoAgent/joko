import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperationalStore } from "@joko/store";
import { readMailCard, type MailCardData } from "@joko/contracts";
import { CredentialVault, type EncryptedCredential } from "../credential-vault.js";
import { ExtensionCardsManager, type ExtensionCardAuthority, type ExtensionCardAction } from "./manager.js";
import type { ExtensionCardScope } from "./service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-extension-card-")), store = new OperationalStore(join(root, "store.db"));
  cleanups.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const vault = await CredentialVault.open(join(root, "vault.key"));
  store.upsertBackend({ id: "runtime", displayName: "Runtime", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "runtime", displayName: "Workspace", workspaceRoot: root, managed: false, trusted: true });
  for (const id of ["task", "other-task"]) store.createSession({ id, backendId: "runtime", targetId: "target", title: id,
    binding: { opaqueRef: id, generation: 1 }, pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  let source: ExtensionCardAuthority | undefined = { key: "private-installation-generation", name: "Calendar", runtime: {
    html: "ui/runtime.html", tools: [{ name: "show", description: "Show", inputSchema: { type: "object" }, readOnly: true }], card: { externalLinks: true }, mail: true } };
  const dispatch = vi.fn(async (_scope: ExtensionCardScope, _event: ExtensionCardAction, _assertCurrent: () => void) => {});
  const options = { store, vault, authority: () => source, redact: (text: string) => text.replaceAll("private-credential", "[REDACTED]"), dispatch };
  const manager = new ExtensionCardsManager(options); cleanups.push(() => manager.dispose());
  const register = (sessionId = "task") => manager.registerCall("extension-one", source!.key, sessionId, "native-tool");
  const publish = (id: string, html = '<p>Review</p><button data-joko-action="save">Save</button>') => manager.cards.handleCardUpdate("extension-one", source!.key,
    { type: "card-update", version: 1, callId: id, html }, () => {});
  const events = () => store.listEvents({ sessionId: "task" }).filter(event => event.payload.type === "extension_card_changed");
  return { root, store, vault, manager, options, register, publish, events, dispatch, setSource: (next?: ExtensionCardAuthority) => { source = next; }, source: () => source! };
}
const mail = (): MailCardData => ({ accountId: "account-one", draftId: "draft-one", key: "11111111-1111-4111-8111-111111111111", from: "owner@example.test",
  fields: ["to", "cc", "bcc", "subject", "body"].map(name => ({ name, label: name, value: name === "body" ? "Hello" : "" })),
  attachments: [], state: "draft", status: "Saved", sendLabel: "Send", fromLabel: "From" });

it("seals private source authority and commits sanitized history before notifying readers", async () => {
  const f = await fixture(), id = f.register();
  const unsubscribe = f.store.subscribe(event => { if (event.payload.type === "extension_card_changed") expect(f.manager.get("task", id).card.html).toBe(event.payload.card.html); });
  expect(await f.publish(id, '<p>private-credential</p><script>bad()</script>')).toEqual({ accepted: true });
  expect(f.manager.get("task", id).card.html).toBe("<p>[REDACTED]</p>");
  const encoded = JSON.stringify(f.events().map(event => event.payload));
  expect(encoded).not.toContain("private-installation-generation"); expect(encoded).not.toContain("private-credential");
  const sealed = f.store.getSetting<EncryptedCredential>("service", "extension-card-records", id).value;
  expect(JSON.stringify(sealed)).not.toContain("private-installation-generation");
  expect(JSON.parse(f.vault.open(sealed, id)).row.authorityKey).toBe("private-installation-generation"); unsubscribe();
});
it("requires the original task and a currently declared action; passive edits have their own declaration", async () => {
  const f = await fixture(), id = f.register(), encoded = JSON.stringify([{ name: "body", label: "Body", value: "Hello" }]).replaceAll('"', "&quot;");
  await f.publish(id, `<div data-joko-form="${encoded}" data-joko-change="edit">Preview</div><button data-joko-action="save" data-joko-prompt="">Save</button>`);
  const request = { sessionId: "task", cardId: id, actionId: "save", prompt: "Typed", formValues: { body: "Changed" }, change: false };
  expect(await f.manager.dispatch({ ...request, actionId: "invented" }, () => {})).toBe(false);
  expect(await f.manager.dispatch({ ...request, actionId: "edit", change: true, formValues: {} }, () => {})).toBe(false);
  await expect(f.manager.dispatch({ ...request, sessionId: "other-task" }, () => {})).rejects.toThrow();
  expect(await f.manager.dispatch(request, () => {})).toBe(true);
  expect(f.dispatch.mock.calls[0]?.[1]).toMatchObject({ actionId: "save", prompt: "Typed", formValues: { body: "Changed" }, change: false });
  expect(await f.manager.dispatch({ ...request, actionId: "edit", prompt: "", change: true }, () => {})).toBe(true);
  expect(f.dispatch.mock.calls[1]?.[1]).toMatchObject({ spawnCallId: id, change: true });
  expect(f.manager.authorizeLink("task", id, "https://example.test/")).toBe(false);
});
it("keeps history inert after a package generation changes and after host restart", async () => {
  const f = await fixture(), id = f.register(); await f.publish(id); await f.manager.finalizeCall(id);
  const restarted = new ExtensionCardsManager(f.options); cleanups.push(() => restarted.dispose());
  expect(restarted.get("task", id)).toMatchObject({ working: false, animatedHtml: "", interactive: true });
  f.setSource({ ...f.source(), key: "new-private-generation" });
  expect(restarted.get("task", id)).toMatchObject({ working: false, interactive: false });
  await expect(restarted.dispatch({ sessionId: "task", cardId: id, actionId: "save", prompt: "", formValues: {}, change: false }, () => {})).rejects.toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
});
it("restores mail from the existing card and supersedes only the same source/task/entity", async () => {
  const f = await fixture(), one = f.register(), first = mail();
  expect(await f.manager.mail.handle("extension-one", f.source().key, { callId: one, draft: first }, () => true)).toEqual({ ok: true });
  await f.manager.finalizeCall(one);
  const two = f.register(), second = { ...first, key: "22222222-2222-4222-8222-222222222222", fields: first.fields.map(field => ({ ...field, value: field.name === "body" ? "Fresh" : field.value })) };
  expect(await f.manager.mail.handle("extension-one", f.source().key, { callId: two, draft: second }, () => true)).toEqual({ ok: true });
  expect(readMailCard(f.manager.get("task", one).card.html)?.supersededBy).toBe(two);
  expect(await f.manager.mail.restore("extension-one", f.source().key, { callId: one }, () => true)).toEqual({ ok: false });
  expect(await f.manager.mail.restore("extension-one", f.source().key, { callId: two }, () => true)).toMatchObject({ ok: true, draft: { draftId: "draft-one" } });
  expect(await f.manager.mail.restore("extension-one", "forged-generation", { callId: two }, () => true)).toEqual({ ok: false });
  expect(await f.manager.mail.handle("extension-one", f.source().key, { callId: two, statusOnly: { state: "sent", status: "Sent" } }, () => true)).toEqual({ ok: true });
  expect(await f.manager.mail.handle("extension-one", f.source().key, { callId: two, draft: second }, () => true)).toEqual({ ok: false });
});

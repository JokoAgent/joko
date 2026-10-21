import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { OperationalStore } from "@joko/store";
import { EXTENSION_CARD_IMAGE_PLACEHOLDER, readMailCard, extensionCardFormValuesToEntries, ExtensionCardServiceDispatchRequestSchema, type ExtensionCardServiceDispatchRequest, type ExtensionCardServiceDispatchResponse, type MailCardData } from "@joko/contracts";
import { create } from "@bufbuild/protobuf";
import type { ConnectionManager } from "../connection-manager.js";
import { ArtifactStore } from "../artifact-store.js";
import { OperationalArtifactRepository } from "../artifact-repository.js";
import { BlobTransferCoordinator } from "../blob-transfers.js";
import { CredentialVault } from "../credential-vault.js";
import { ExtensionCardMedia } from "./media.js";
import { ExtensionCardsManager, type ExtensionCardAction } from "./manager.js";
import type { ExtensionCardScope } from "./service.js";
import { ExtensionNetwork } from "./network.js";
import { createExtensionCardConnectService } from "./connect-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const bytes = Buffer.from(EXTENSION_CARD_IMAGE_PLACEHOLDER.split(",")[1]!, "base64"), sha256 = createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-card-media-")), store = new OperationalStore(join(root, "store.db"));
  cleanups.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const vault = await CredentialVault.open(join(root, "vault.key")), artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
  await artifacts.initialize(); const transfers = new BlobTransferCoordinator(artifacts), media = new ExtensionCardMedia({ store, vault, artifacts, transfers });
  store.upsertBackend({ id: "runtime", displayName: "Runtime", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "runtime", displayName: "Workspace", workspaceRoot: root, managed: false, trusted: true });
  for (const id of ["task", "other"]) store.createSession({ id, backendId: "runtime", targetId: "target", title: id, binding: { opaqueRef: id, generation: 1 }, pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  const dispatch = vi.fn(async (_scope: ExtensionCardScope, _event: ExtensionCardAction, assertCurrent: () => void) => { assertCurrent(); });
  const authority = { key: "private-source", name: "Mail", runtime: { html: "ui/runtime.html", tools: [{ name: "read", description: "Read", inputSchema: { type: "object" }, readOnly: true }], card: {}, mail: true as const, mailReader: { tool: "read", hosts: ["mail.example.test"] } } };
  const manager = new ExtensionCardsManager({ store, vault, media, authority: () => authority, dispatch, redact: value => value }); cleanups.push(() => manager.dispose());
  const id = manager.registerCall("extension", authority.key, "task", "native-tool"), key = "11111111-1111-4111-8111-111111111111";
  const draft: MailCardData = { accountId: "account", draftId: "draft", key, from: "owner@example.test", fields: [
    ...["to", "cc", "bcc", "body"].map(name => ({ name, label: name, value: "" })),
    { name: "subject", label: "Subject", value: "Initial" }, { name: "bodyHtml", label: "Body", kind: "mail-html", value: "<p>Hello</p>" },
    { name: "attachmentItems", label: "Files", kind: "mail-attachments", value: "[]" }], attachments: [], state: "draft", status: "Saved", sendLabel: "Send", fromLabel: "From" };
  const publish = (mail = draft) => manager.mail.handle("extension", authority.key, { callId: id, draft: mail }, () => true);
  expect(await publish()).toEqual({ ok: true });
  const begin = (inline = false) => manager.beginAttachment("task", id, "connection", { name: "image.gif", mimeType: "image/gif", sha256, bytes: bytes.length, inline }, () => {});
  const upload = async (transfer: Awaited<ReturnType<typeof begin>>) => { const secret = decodeURIComponent(transfer.relativeEndpoint.split("/").at(-1)!); return transfers.acceptUpload(transfer.ticketId, secret, Readable.from([bytes])); };
  const values = () => Object.fromEntries(readMailCard(manager.get("task", id).card.html)!.fields.map(field => [field.name, field.value]));
  return { root, store, vault, artifacts, transfers, media, manager, authority, dispatch, id, key, draft, begin, upload, publish, values };
}
it("uses the original card, Connection and verified bytes, then keeps media ownership across a host restart", async () => {
  const f = await fixture(), transfer = await f.begin(true); await f.upload(transfer);
  const request = { sessionId: "task", cardId: f.id, actionId: `mail:image:${f.key}`, prompt: "", formValues: f.values(), change: false, uploadId: transfer.uploadId };
  await expect(f.manager.dispatch(request, () => {}, "other-connection")).rejects.toThrow(); expect(f.dispatch).not.toHaveBeenCalled();
  expect(await f.manager.dispatch(request, () => {}, "connection")).toBe(true);
  const attachment = f.dispatch.mock.calls[0]![1].mailAttachment!;
  expect(attachment).toMatchObject({ path: `joko-media://blobs/${sha256}.gif`, filename: "image.gif", sha256, bytes: bytes.length, mimeType: "image/gif", contentId: expect.stringMatching(/@joko\.local$/u) });
  expect(JSON.stringify(attachment)).not.toContain(f.root); expect(f.store.listEvents({ sessionId: "task" }).some(event => event.payload.type === "artifact")).toBe(true);
  const scope = { extensionId: "extension", authorityKey: f.authority.key, sessionId: "task", sessionCreatedAt: 1, targetId: "target", toolUseId: null };
  const restarted = new ExtensionCardMedia({ store: f.store, vault: f.vault, artifacts: f.artifacts, transfers: f.transfers });
  expect(await restarted.image(scope, attachment.path, () => {})).toBe(EXTENSION_CARD_IMAGE_PLACEHOLDER);
  const differentlyTyped = await f.artifacts.ingestBytes(bytes, { mimeType: "application/octet-stream", fileName: "same-bytes.bin" });
  restarted.grant(scope, differentlyTyped, () => {}); expect(await restarted.image(scope, attachment.path, () => {})).toBe(EXTENSION_CARD_IMAGE_PLACEHOLDER);
  await expect(restarted.read({ ...scope, sessionId: "other" }, sha256, () => {})).rejects.toThrow();
  await expect(restarted.read({ ...scope, extensionId: "another-extension" }, sha256, () => {})).rejects.toThrow();
  await expect(restarted.read({ ...scope, authorityKey: "updated-installation" }, sha256, () => {})).rejects.toThrow();
  await expect(f.manager.dispatch(request, () => {}, "connection")).rejects.toThrow(); expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(await f.publish({ ...f.draft, images: [{ cid: attachment.contentId!, url: attachment.path }] })).toEqual({ ok: true });
  expect(f.manager.get("task", f.id).mediaUris).toContain(attachment.path);
  expect(await f.manager.readMedia({ sessionId: "task", cardId: f.id, extensionId: "", uri: attachment.path }, () => {})).toBe(EXTENSION_CARD_IMAGE_PLACEHOLDER);
  await expect(f.manager.readMedia({ sessionId: "other", cardId: f.id, extensionId: "", uri: attachment.path }, () => {})).rejects.toThrow();
});
it("rebases unrelated remote edits onto an attachment selection and refuses overlapping edits", async () => {
  const f = await fixture(), transfer = await f.begin(); await f.upload(transfer); const original = f.values();
  expect(await f.publish({ ...f.draft, fields: f.draft.fields.map(field => field.name === "bodyHtml" ? { ...field, value: "<p>Remote edit</p>" } : field) })).toEqual({ ok: true });
  expect(await f.manager.dispatch({ sessionId: "task", cardId: f.id, actionId: `mail:attach:${f.key}`, prompt: "", formValues: { ...original, subject: "Local edit" }, change: false, uploadId: transfer.uploadId }, () => {}, "connection")).toBe(true);
  expect(f.dispatch.mock.calls[0]![1].formValues).toMatchObject({ subject: "Local edit", bodyHtml: "<p>Remote edit</p>" });
  const next = await f.begin(); await f.upload(next); const before = f.values();
  expect(await f.publish({ ...f.draft, fields: f.draft.fields.map(field => field.name === "subject" ? { ...field, value: "Other window" } : field) })).toEqual({ ok: true });
  expect(await f.manager.dispatch({ sessionId: "task", cardId: f.id, actionId: `mail:attach:${f.key}`, prompt: "", formValues: { ...before, subject: "Conflicting local edit" }, change: false, uploadId: next.uploadId }, () => {}, "connection")).toBe(false);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});
it("revokes a selected upload when the owning task is archived before dispatch", async () => {
  const f = await fixture(), transfer = await f.begin(); await f.upload(transfer);
  const values = f.values(); f.store.updateSession("task", { archived: true });
  await expect(f.manager.dispatch({ sessionId: "task", cardId: f.id, actionId: `mail:attach:${f.key}`, prompt: "", formValues: values, change: false, uploadId: transfer.uploadId }, () => {}, "connection")).rejects.toThrow();
  expect(f.dispatch).not.toHaveBeenCalled(); expect(f.store.listEvents({ sessionId: "task" }).some(event => event.payload.type === "artifact")).toBe(false);
});
it("uploads only source-owned media through the declared network host without exposing local paths", async () => {
  const f = await fixture(), transfer = await f.begin(); await f.upload(transfer);
  expect(await f.manager.dispatch({ sessionId: "task", cardId: f.id, actionId: `mail:attach:${f.key}`, prompt: "", formValues: f.values(), change: false, uploadId: transfer.uploadId }, () => {}, "connection")).toBe(true);
  const task = { extensionId: "extension", authorityKey: f.authority.key, sessionId: "task", sessionCreatedAt: 1, targetId: "target", toolUseId: null };
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    expect(new Headers(init?.headers).get("content-type")).toMatch(/^multipart\/form-data; boundary=----joko-extension-/u);
    const body = Buffer.from(init!.body as ArrayBuffer);
    expect(body.includes(bytes)).toBe(true); expect(body.toString()).toContain(`name="size"\r\n\r\n${bytes.length}`); expect(body.toString()).not.toContain(f.root);
    return new Response('{"accepted":true}', { headers: { "content-type": "application/json" } });
  });
  const network = new ExtensionNetwork({ fetch: fetchMock, media: f.media, resolveCredential: () => "", redact: value => value });
  const scope = { extensionId: "extension", authorityKey: f.authority.key, declaration: { hosts: ["upload.example.test"] }, task, readOnly: false, signal: new AbortController().signal, assertCurrent: () => {} };
  const request = { url: "https://upload.example.test/files", method: "POST", upload: { hashes: [sha256], field: "file", fields: { size: "{bytes}" } } };
  expect(await network.request(scope, request)).toMatchObject({ ok: true, body: '{"accepted":true}' }); expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await network.request({ ...scope, task: { ...task, sessionId: "other" } }, request)).toMatchObject({ ok: false }); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("retains a delivered action's Connection guard after its HTTP acknowledgement and rejects later revocation", async () => {
  const f = await fixture(); let current = true;
  const connection = { id: "owner" }, connections = { authenticate: (auth: string) => { expect(auth).toBe("Bearer owner"); return connection; },
    fence: () => { if (!current) throw new Error("Connection revoked."); } } as unknown as ConnectionManager;
  const service = createExtensionCardConnectService(f.manager, connections), rpc = service.dispatch as (request: ExtensionCardServiceDispatchRequest, context: unknown) => Promise<ExtensionCardServiceDispatchResponse>;
  const http = new AbortController();
  expect(await rpc(create(ExtensionCardServiceDispatchRequestSchema, { sessionId: "task", cardId: f.id, actionId: `mail:send:${f.key}`, formValues: extensionCardFormValuesToEntries(f.values()) }),
    { signal: http.signal, requestHeader: new Headers({ authorization: "Bearer owner" }) })).toMatchObject({ accepted: true });
  const retained = f.dispatch.mock.calls[0]![2]; http.abort(); expect(() => retained()).not.toThrow();
  current = false; expect(() => retained()).toThrow("Connection revoked");
});
it("sniffs media response bytes, returns only source-owned metadata and retains bounded text fallback", async () => {
  const f = await fixture(), task = { extensionId: "extension", authorityKey: f.authority.key, sessionId: "task", sessionCreatedAt: 1, targetId: "target", toolUseId: null };
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(bytes, { headers: { "content-type": "application/octet-stream" } }))
    .mockResolvedValueOnce(new Response('{"result":1}', { headers: { "content-type": "application/octet-stream" } }))
    .mockResolvedValueOnce(new Response(new Uint8Array([0, 1, 0, 255]), { headers: { "content-type": "application/octet-stream" } }));
  const network = new ExtensionNetwork({ fetch: fetchMock, media: f.media, resolveCredential: () => "", redact: value => value });
  const scope = { extensionId: "extension", authorityKey: f.authority.key, declaration: { hosts: ["api.example.test"] }, task, readOnly: true, signal: new AbortController().signal, assertCurrent: () => {} };
  const uri = `joko-media://blobs/${sha256}.gif`, request = { url: "https://api.example.test/image", as: "media" };
  expect(await network.request(scope, request)).toMatchObject({ ok: true, media: { url: uri, hash: sha256, ext: ".gif", bytes: bytes.length } });
  const id = f.manager.registerCall("extension", f.authority.key, "task", null);
  expect(await f.manager.cards.handleCardUpdate("extension", f.authority.key, { type: "card-update", version: 1, callId: id, html: `<img src="${uri}">` }, () => {})).toEqual({ accepted: true });
  const input = { sessionId: "task", cardId: id, extensionId: "", uri };
  expect(await f.manager.describeMedia(input, () => {})).toMatchObject({ sha256, mimeType: "image/gif", byteLength: bytes.length });
  await expect(f.manager.describeMedia({ ...input, uri: `joko-media://blobs/${"b".repeat(64)}.gif` }, () => {})).rejects.toThrow();
  await expect(f.manager.describeMedia({ ...input, sessionId: "other" }, () => {})).rejects.toThrow();
  expect(await network.request(scope, request)).toMatchObject({ ok: true, body: '{"result":1}' }); expect(await network.request(scope, request)).toMatchObject({ ok: false });
});

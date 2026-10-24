import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { OperationalStore, PartnerNetworkStore, networkHash } from "@joko/store";
import { afterEach, expect, it } from "vitest";
import { PartnerNetworkHost } from "./partner-network-host.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const authority = () => ({ signal: new AbortController().signal, assertCurrent() {} });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-network-media-")), store = new OperationalStore(":memory:");
  const options = { storage: new PartnerNetworkStore(store), serverId: "media-owner", origin: "http://127.0.0.1",
    mediaDirectory: join(root, "media"), partner: (id: string) => ({ id, name: "Partner", description: "" }) };
  let host = new PartnerNetworkHost(options);
  const room = host.create(create(contract.CreatePartnerNetworkRequestSchema, { operationId: "create-room", name: "Files", displayName: "Owner" }));
  const request = create(contract.MediaPartnerNetworkRequestSchema, { action: "begin", roomId: room.id,
    operationId: "original-upload", name: "report.txt", mediaType: "text/plain", sizeBytes: 3n });
  const id = `media:${networkHash([host.selfId, request.operationId])}`;
  const directory = join(options.mediaDirectory, room.id), path = join(directory, id.replace(":", "-"));
  cleanups.push(async () => { await host.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, room, request, id, directory, path, get host() { return host; },
    async restart() { await host.close(); host = new PartnerNetworkHost({ ...options, storage: new PartnerNetworkStore(store) }); } };
}

it("serializes a begin and write queued in the same tick under the derived media ID", async () => {
  const f = await fixture();
  const beginning = f.host.media(f.request, f.host.selfId, authority());
  const write = create(contract.MediaPartnerNetworkRequestSchema, { action: "write", roomId: f.room.id,
    mediaId: f.id, offset: 0n, data: new TextEncoder().encode("abc") });
  const writing = f.host.media(write, f.host.selfId, authority());
  const [begun, written] = await Promise.all([beginning, writing]);
  expect(begun).toMatchObject({ attachment: { id: f.id }, offset: 0n, complete: false });
  expect(written).toMatchObject({ attachment: { id: f.id }, offset: 3n, complete: true });
  expect(await readFile(f.path, "utf8")).toBe("abc");
  expect(await f.host.media(write, f.host.selfId, authority())).toMatchObject({ offset: 3n, complete: true });
  expect(await f.host.media(f.request, f.host.selfId, authority())).toMatchObject({ offset: 3n, complete: true });
});

it.each(["abort", "authority"] as const)("rejects a queued write after its original %s is retired and resumes the same upload", async retirement => {
  const f = await fixture(), abort = new AbortController(), denied = new Error("The original upload owner was revoked.");
  let current = true;
  const beginning = f.host.media(f.request, f.host.selfId, authority());
  const write = create(contract.MediaPartnerNetworkRequestSchema, { action: "write", roomId: f.room.id,
    mediaId: f.id, offset: 0n, data: new TextEncoder().encode("abc") });
  const writing = f.host.media(write, f.host.selfId, { signal: abort.signal, assertCurrent() { if (!current) throw denied; } });
  if (retirement === "abort") abort.abort();
  else current = false;
  const rejected = retirement === "abort"
    ? expect(writing).rejects.toMatchObject({ name: "AbortError" })
    : expect(writing).rejects.toBe(denied);
  await Promise.all([beginning, rejected]);
  expect(f.host.storage.media(f.room.id, f.id)).toMatchObject({ actorId: f.host.selfId, offset: 0, complete: false });
  expect(await readFile(f.path)).toHaveLength(0);
  expect(await f.host.media(write, f.host.selfId, authority())).toMatchObject({ attachment: { id: f.id }, offset: 3n, complete: true });
  expect(await readFile(f.path, "utf8")).toBe("abc");
});

it("recovers the exact upload after cancellation between file creation and the begin reply", async () => {
  const f = await fixture(), abort = new AbortController();
  await expect(f.host.media(f.request, f.host.selfId, { signal: abort.signal, assertCurrent() {
    if (existsSync(f.path)) abort.abort();
    abort.signal.throwIfAborted();
  } })).rejects.toThrow();
  expect(existsSync(f.path)).toBe(true);
  expect(f.host.storage.media(f.room.id, f.id)).toMatchObject({ offset: 0, complete: false });
  await f.restart();
  const begun = await f.host.media(f.request, f.host.selfId, authority());
  expect(begun).toMatchObject({ attachment: { id: f.id }, offset: 0n, complete: false });
  const result = await f.host.media(create(contract.MediaPartnerNetworkRequestSchema, { action: "write", roomId: f.room.id,
    mediaId: f.id, offset: 0n, data: new TextEncoder().encode("abc") }), f.host.selfId, authority());
  expect(result).toMatchObject({ offset: 3n, complete: true });
  expect(await readFile(f.path, "utf8")).toBe("abc");
  expect(await f.host.media(f.request, f.host.selfId, authority())).toMatchObject({ offset: 3n, complete: true });
});

it("recreates an unstarted durable upload file and still rejects changed input on the same operation", async () => {
  const f = await fixture();
  f.host.storage.saveMedia(f.room.id, { actorId: f.host.selfId,
    attachment: { id: f.id, name: f.request.name, mediaType: f.request.mediaType, sizeBytes: 3 }, offset: 0, complete: false });
  await f.restart();
  await expect(f.host.media(create(contract.MediaPartnerNetworkRequestSchema, { ...f.request, name: "different.txt" }), f.host.selfId, authority()))
    .rejects.toMatchObject({ code: "changed" });
  expect(existsSync(f.path)).toBe(false);
  expect(await f.host.media(f.request, f.host.selfId, authority())).toMatchObject({ offset: 0n, complete: false });
  expect(await readFile(f.path)).toHaveLength(0);
});

it("adopts an empty orphan left before its receipt and never resets a saved prefix", async () => {
  const f = await fixture();
  await mkdir(f.directory, { recursive: true }); await writeFile(f.path, "");
  expect(await f.host.media(f.request, f.host.selfId, authority())).toMatchObject({ offset: 0n, complete: false });
  await f.host.media(create(contract.MediaPartnerNetworkRequestSchema, { action: "write", roomId: f.room.id,
    mediaId: f.id, data: new TextEncoder().encode("ab") }), f.host.selfId, authority());
  await f.restart();
  expect(await f.host.media(f.request, f.host.selfId, authority())).toMatchObject({ offset: 2n, complete: false });
  expect(await readFile(f.path, "utf8")).toBe("ab");
  await rm(f.path);
  await expect(f.host.media(f.request, f.host.selfId, authority())).rejects.toMatchObject({ code: "not_found" });
  expect(existsSync(f.path)).toBe(false);
});

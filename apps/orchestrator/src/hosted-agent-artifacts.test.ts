import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AdapterContext } from "@joko/core";
import { afterEach, expect, it, vi } from "vitest";
import { HostedAgentArtifacts, HOSTED_AGENT_ARTIFACT_CHUNK_BYTES, receiveHostedAgentArtifact } from "./hosted-agent-artifacts.js";
import { HostedAgentExchange } from "./hosted-agent-exchange.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-hosted-artifact-")), host = join(root, "model-node"), task = join(root, "task-node");
  await mkdir(host); await mkdir(task);
  const exchange = new HostedAgentExchange({ assertCurrent: () => {}, onOverflow: () => {} });
  const artifacts = new HostedAgentArtifacts({ root: host, maximumBytes: 8 * 1024 * 1024, assertCurrent: () => {}, exchange });
  const signal = new AbortController().signal;
  cleanups.push(async () => { exchange.close(); await artifacts.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true }); });
  const admitted: Buffer[] = [];
  const context = { signal, artifactCapacityBytes: 8 * 1024 * 1024, storeArtifact: vi.fn(async (path: string, options: { fileName?: string; mimeType?: string }) => {
    expect(resolve(path).startsWith(resolve(task) + sep)).toBe(true);
    const data = await readFile(path); admitted.push(data);
    return { id: "original-task-artifact", byteLength: data.byteLength, sha256: createHash("sha256").update(data).digest("hex"), mimeType: options.mimeType ?? "application/octet-stream", fileName: options.fileName };
  }) } as unknown as AdapterContext;
  return { root, host, task, exchange, artifacts, signal, context, admitted };
}

it.each([0, HOSTED_AGENT_ARTIFACT_CHUNK_BYTES * 2 + 17])("streams a %i-byte native result into the original task's ArtifactStore", async length => {
  const f = await fixture(), bytes = Buffer.alloc(length, 0xab), path = join(f.host, "native-output.bin"); await writeFile(path, bytes);
  const pending = f.artifacts.store(path, f.signal, { fileName: "native-result.bin" }); void pending.catch(() => {});
  const frames = await Promise.race([
    f.exchange.poll(0, f.signal),
    pending.then(() => { throw new Error("Artifact completed before its offer was accepted."); })
  ]);
  const frame = frames.frames[0]!; if (frame.payload.kind !== "request" || frame.payload.request.kind !== "artifact") throw new Error("Missing Artifact offer.");
  const offer = frame.payload.request.offer, read = vi.fn((id: string, offset: number, maximum: number) => f.artifacts.read(id, offset, maximum));
  const blob = await receiveHostedAgentArtifact({ offer, context: f.context, temporaryRoot: f.task, signal: f.signal, assertCurrent: () => {}, readChunk: read });
  f.exchange.reply(frame.payload.id, { ok: true, value: blob }); expect(await pending).toEqual(blob);
  expect(f.admitted).toEqual([bytes]); expect(read).toHaveBeenCalledTimes(Math.ceil(length / HOSTED_AGENT_ARTIFACT_CHUNK_BYTES));
  expect(await readdir(f.task)).toEqual([]);
  await expect(f.artifacts.read(offer.id, 0, 1)).rejects.toThrow("unavailable");
  expect(JSON.stringify(offer)).not.toContain(f.host);
});

it("rejects altered chunks before publishing an Artifact and cleans the task's private staging files", async () => {
  const f = await fixture(), bytes = Buffer.from("unaltered native bytes");
  const offer = { id: "owned-offer", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), fileName: "result.bin" };
  const changed = Buffer.alloc(bytes.length, 0);
  await expect(receiveHostedAgentArtifact({ offer, context: f.context, temporaryRoot: f.task, signal: f.signal, assertCurrent: () => {},
    readChunk: async () => ({ data: changed.toString("base64") }) })).rejects.toThrow("checksum changed");
  expect(f.context.storeArtifact).not.toHaveBeenCalled(); expect(await readdir(f.task)).toEqual([]);
  await expect(receiveHostedAgentArtifact({ offer: { ...offer, byteLength: f.context.artifactCapacityBytes + 1 }, context: f.context, temporaryRoot: f.task,
    signal: f.signal, assertCurrent: () => {}, readChunk: async () => { throw new Error("Oversized offer must not read"); } })).rejects.toThrow("offer is invalid");
});

it("accepts only files owned by that native run and exact bounded chunk requests", async () => {
  const f = await fixture(), other = join(f.task, "not-owned.bin"); await writeFile(other, "task private contents");
  await expect(f.artifacts.store(other, f.signal)).rejects.toThrow("outside its native owner");
  await expect(f.artifacts.read("other-offer", 0, 1)).rejects.toThrow("unavailable");
  await expect(f.artifacts.read("other-offer", -1, HOSTED_AGENT_ARTIFACT_CHUNK_BYTES + 1)).rejects.toThrow("unavailable");
});

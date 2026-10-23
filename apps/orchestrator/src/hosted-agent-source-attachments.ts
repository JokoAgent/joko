import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { extname, join, posix, relative, resolve, win32 } from "node:path";
import { z } from "zod";
import type { AdapterContext, ArtifactMentionResolver, BlobRef, DurableNativeDispatchPreparation, FileInput } from "@joko/core";
import { NotFoundError, type OperationalStore } from "@joko/store";
import type { ExecutorPathAlias } from "./hosted-agent-workspace.js";
import { observeSourceInputFile, snapshotSourceInputFile, type SourceInputFileSnapshot } from "./hosted-agent-input-snapshot.js";

const SCOPE = "hosted-inputs.v1", digest = z.string().regex(/^[a-f0-9]{64}$/u), id = z.string().min(1).max(512);
const blobSchema = z.strictObject({ id, sha256: digest, byteLength: z.number().int().min(0).max(256 * 1024 * 1024), mimeType: z.string().min(1).max(256), fileName: z.string().max(1024).optional() });
const originSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("file"), index: z.number().int().min(0).max(1023) }),
  z.strictObject({ kind: z.literal("artifact"), artifactId: id, sourceSessionId: id })]);
const fileSchema = z.strictObject({ key: digest, stamp: digest, extension: z.string().regex(/^(?:\.[a-zA-Z0-9]{1,16})?$/u), blob: blobSchema, origin: originSchema });
const recordSchema = z.strictObject({ format: z.literal(1), sessionId: id, queueItemId: id, operationId: id, bodyHash: z.string().min(1).max(128), inputFingerprint: digest, files: z.array(fileSchema).max(256) });
type FileRecord = z.infer<typeof fileSchema>;
interface MountedFile { readonly record: FileRecord; readonly snapshot: SourceInputFileSnapshot; readonly assertPreparing?: () => void }
export interface SourceInputMount extends Pick<SourceInputFileSnapshot, "path" | "assertCurrent"> { readonly namespace?: boolean }
interface RuntimeInputs { readonly empty: string; readonly accepted: Map<string, MountedFile>; readonly pending: Map<string, Map<string, MountedFile>> }
export interface SourceAttachmentPreparation {
  file(file: FileInput, index: number, workspace?: { readonly path: string; readonly assertCurrent: () => void }): Promise<{ readonly text: string; readonly assertCurrent: () => void }>;
  artifact(artifactId: string, sourceSessionId: string, label: string): Promise<{ readonly text: string; readonly assertCurrent: () => void }>;
  retained(): readonly { readonly text: string; readonly assertCurrent: () => void }[];
  commit(preparation: DurableNativeDispatchPreparation): Promise<void>;
}

/** Target-owned copies of files explicitly admitted by one original Queue.
 * Source Artifact authority is checked until the dispatch fence; accepted
 * immutable bytes then belong to that task's native input context. */
export class HostedAgentSourceAttachments {
  readonly #runtimes = new Map<string, RuntimeInputs>();
  constructor(private readonly options: { readonly store: OperationalStore; readonly root: string;
    readonly resolveFile: (blob: BlobRef, context: AdapterContext) => Promise<string>;
    readonly resolveArtifactMention: ArtifactMentionResolver;
    readonly assertContext: (context: AdapterContext) => void }) {}

  async initialize(): Promise<void> {
    const sessions = new Set(this.options.store.listSettingsByKeyPrefix("service", SCOPE, "").map(row => recordSchema.parse(row.value).sessionId));
    for (const sessionId of sessions) if (this.#deleted(sessionId)) await this.forget(sessionId);
  }

  async capture(context: AdapterContext): Promise<void> {
    const guard = () => this.#guard(context); guard();
    const root = await this.#directory(context.sessionId), empty = join(root, "namespace"); await mkdir(empty, { recursive: true, mode: 0o700 });
    if (await realpath(empty) !== empty) throw new Error("The Source input namespace is unsafe.");
    const runtime: RuntimeInputs = { empty, accepted: new Map(), pending: new Map() };
    for (const row of this.options.store.listSettingsByKeyPrefix("service", SCOPE, `${hash(context.sessionId)}:`)) {
      const record = recordSchema.parse(row.value), item = this.options.store.getQueueItem(record.queueItemId);
      if (record.sessionId !== context.sessionId || item.sessionId !== context.sessionId || item.operationId !== record.operationId || item.bodyHash !== record.bodyHash
        || row.key !== this.#recordKey(context.sessionId, record.queueItemId)) throw new Error("The Source input receipt no longer matches its original Queue.");
      for (const file of record.files) {
        this.#assertOrigin(item.body, file);
        const path = this.#filePath(root, file);
        try { const snapshot = observeSourceInputFile(path, file.blob); if (snapshot.fingerprint === file.stamp) runtime.accepted.set(file.key, { record: file, snapshot }); }
        catch { guard(); /* Missing or changed cached bytes stay unavailable; never reacquire another Artifact incarnation. */ }
      }
    }
    guard(); this.#runtimes.set(this.#key(context), runtime);
  }

  begin(context: AdapterContext, shadow: string): SourceAttachmentPreparation {
    const runtime = this.#runtime(context), selected = new Map<string, MountedFile>(), guards: (() => void)[] = [];
    let committed = false;
    const queue = () => {
      this.#guard(context);
      if (!context.inputQueueItemId || !context.operationId) throw new Error("File input requires its original durable Queue owner.");
      const item = this.options.store.getQueueItem(context.inputQueueItemId);
      if (item.sessionId !== context.sessionId || item.operationId !== context.operationId || item.state !== "dispatching") throw new Error("The Source input Queue owner changed.");
      return item;
    };
    const native = /^[A-Za-z]:|^\\/u.test(shadow) ? win32 : posix;
    const mount = async (blob: BlobRef, source: string, origin: FileRecord["origin"], assertOrigin: () => void) => {
      const item = queue(); assertOrigin();
      const key = hash(JSON.stringify([item.id, origin, blob.id, blob.sha256, blob.byteLength]));
      const suffix = extname(blob.fileName ?? ""), extension = /^\.[a-zA-Z0-9]{1,16}$/u.test(suffix) ? suffix : "";
      const seed: FileRecord = { key, stamp: "0".repeat(64), extension, blob: blobSchema.parse(blob), origin }; this.#assertOrigin(item.body, seed);
      const root = await this.#directory(context.sessionId), snapshot = await snapshotSourceInputFile(source, this.#filePath(root, seed), blob, context.signal, () => { queue(); assertOrigin(); });
      const record = { ...seed, stamp: snapshot.fingerprint };
      const file = { record, snapshot, assertPreparing: () => { queue(); assertOrigin(); } }; selected.set(key, file); runtime.pending.set(context.operationId!, selected); guards.push(assertOrigin);
      const assertCurrent = () => { this.#guard(context); snapshot.assertCurrent(); if (!committed) { queue(); assertOrigin(); } };
      return { path: native.join(shadow, ".joko-inputs", hash(context.sessionId), key + extension), assertCurrent };
    };
    return {
      file: async (file, index, workspace) => {
        const item = queue(), original = item.body.files[index];
        if (!original || !sameBlob(original.blob, file.blob) || original.workspacePath !== file.workspacePath) throw new Error("The file belongs to another Source input.");
        const stored = this.options.store.getArtifact(file.blob.id), identity = stored.revision;
        const assertOrigin = () => { queue(); workspace?.assertCurrent(); const current = this.options.store.getArtifact(file.blob.id);
          const metadata = current.metadata, expires = metadata !== null && typeof metadata === "object" && "expiresAt" in metadata ? metadata.expiresAt : undefined;
          if (current.revision !== identity || current.deletedAt !== undefined || expires !== undefined && (typeof expires !== "number" || expires <= Date.now())
            || !sameBlob(current.blob, file.blob)) throw new Error("The uploaded Source file authority changed."); };
        assertOrigin(); const source = workspace?.path ?? await this.options.resolveFile(file.blob, context); assertOrigin();
        const value = await mount(file.blob, source, { kind: "file", index }, assertOrigin);
        return { text: `Attached file: ${JSON.stringify({ name: file.blob.fileName ?? "attachment" })}\nPath: ${value.path}`, assertCurrent: value.assertCurrent };
      },
      artifact: async (artifactId, sourceSessionId, label) => {
        queue(); const resolved = await this.options.resolveArtifactMention(artifactId, sourceSessionId, context, context.signal); resolved.assertCurrent();
        if (resolved.blob.id !== artifactId) throw new Error("The Source Artifact identity changed.");
        const value = await mount(resolved.blob, resolved.path, { kind: "artifact", artifactId, sourceSessionId }, resolved.assertCurrent);
        return { text: `Artifact reference: ${JSON.stringify({ name: label })}\nPath: ${value.path}`, assertCurrent: value.assertCurrent };
      },
      retained: () => {
        this.#guard(context);
        return [...runtime.accepted.values()].flatMap(file => {
          if (selected.has(file.record.key)) return [];
          try { file.snapshot.assertCurrent(); } catch { this.#guard(context); return []; }
          const assertCurrent = () => { this.#guard(context); file.snapshot.assertCurrent(); };
          return [{ text: `${file.record.origin.kind === "file" ? "Attached file" : "Artifact reference"}: ${JSON.stringify({ name: file.record.blob.fileName ?? "attachment", retained: true })}\nPath: ${native.join(shadow, ".joko-inputs", hash(context.sessionId), file.record.key + file.record.extension)}`, assertCurrent }];
        });
      },
      commit: async preparation => {
        if (!selected.size) return;
        const item = queue(); for (const guard of guards) guard(); for (const file of selected.values()) file.snapshot.assertCurrent();
        const record = recordSchema.parse({ format: 1, sessionId: context.sessionId, queueItemId: item.id, operationId: item.operationId,
          bodyHash: item.bodyHash, inputFingerprint: preparation.inputFingerprint, files: [...selected.values()].map(file => file.record) });
        this.options.store.setSetting("service", SCOPE, this.#recordKey(context.sessionId, item.id), record);
        committed = true; for (const [key, file] of selected) runtime.accepted.set(key, { record: file.record, snapshot: file.snapshot }); runtime.pending.delete(context.operationId!);
      }
    };
  }

  authority(context: AdapterContext, shadow: string): { readonly aliases: readonly ExecutorPathAlias[]; readonly files: readonly SourceInputMount[]; readonly revision: string } {
    this.#guard(context); const runtime = this.#runtime(context), selected = new Map(runtime.accepted);
    for (const [key, file] of runtime.pending.get(context.operationId ?? "") ?? []) selected.set(key, file);
    const native = /^[A-Za-z]:|^\\/u.test(shadow) ? win32 : posix;
    return { aliases: [{ from: native.join(shadow, ".joko-inputs", hash(context.sessionId)), to: runtime.empty }, ...[...selected.values()].map(file => ({ from: native.join(shadow, ".joko-inputs", hash(context.sessionId), file.record.key + file.record.extension), to: file.snapshot.path, kind: "file" as const }))],
      files: [{ path: runtime.empty, namespace: true, assertCurrent: () => { const info = lstatSync(runtime.empty); if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(runtime.empty) !== runtime.empty) throw new Error("The Source input namespace changed."); } },
        ...[...selected.values()].map(file => ({ path: file.snapshot.path, assertCurrent: () => { file.snapshot.assertCurrent(); file.assertPreparing?.(); } }))], revision: JSON.stringify([...selected.keys()].sort()) };
  }
  async release(context: AdapterContext): Promise<void> { this.#runtimes.delete(this.#key(context)); if (this.#deleted(context.sessionId)) await this.forget(context.sessionId); }
  async forget(sessionId: string): Promise<void> {
    const root = resolve(this.options.root), expected = join(root, hash(sessionId));
    try { const actualRoot = await realpath(root), actual = await realpath(expected);
      if (actualRoot !== root || relative(actualRoot, actual) !== hash(sessionId) || (await lstat(expected)).isSymbolicLink()) throw new Error("The Source input cleanup owner changed.");
      await rm(actual, { recursive: true, force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const row of this.options.store.listSettingsByKeyPrefix("service", SCOPE, `${hash(sessionId)}:`)) this.options.store.deleteSetting("service", SCOPE, row.key);
  }
  #assertOrigin(body: import("@joko/core").PromptInput, file: FileRecord): void {
    const origin = file.origin;
    if (origin.kind === "file" ? !body.files[origin.index] || !sameBlob(body.files[origin.index]!.blob, file.blob)
      : file.blob.id !== origin.artifactId || !body.mentions.some(mention => mention.kind === "artifact" && mention.reference === origin.artifactId && mention.sourceSessionId === origin.sourceSessionId)) throw new Error("The Source file receipt does not belong to its accepted input.");
  }
  #guard(context: AdapterContext): void { context.signal.throwIfAborted(); this.options.assertContext(context); }
  #deleted(sessionId: string): boolean { try { return this.options.store.getSession(sessionId).descriptor.deletedAt !== undefined; }
    catch (error) { if (error instanceof NotFoundError && error.resource === "Session" && error.id === sessionId) return true; throw error; } }
  #key(context: AdapterContext): string { return JSON.stringify([context.sessionId, context.generation, context.backendInstanceGeneration]); }
  #runtime(context: AdapterContext): RuntimeInputs { const value = this.#runtimes.get(this.#key(context)); if (!value) throw new Error("The Source input runtime is not captured."); return value; }
  #recordKey(sessionId: string, queueItemId: string): string { return `${hash(sessionId)}:${hash(queueItemId)}`; }
  #filePath(root: string, file: FileRecord): string { return join(root, "files", file.key + file.extension); }
  async #directory(sessionId: string): Promise<string> { const root = resolve(this.options.root), directory = join(root, hash(sessionId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(root) !== root || await realpath(directory) !== directory) throw new Error("The Source input cache owner changed."); return directory;
  }
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sameBlob(a: BlobRef, b: BlobRef): boolean { return a.id === b.id && a.sha256 === b.sha256 && a.byteLength === b.byteLength && a.mimeType === b.mimeType && a.fileName === b.fileName; }

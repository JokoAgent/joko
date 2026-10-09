import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { boundNativeSessionPreview, redactSecrets, type NativeSessionCatalogEntry, type NativeSessionCatalogResult, type NativeSessionPreview } from "@joko/core";
import { readNativeTranscriptWindow, type NativeTranscriptFileIdentity, type NativeTranscriptWindow } from "@joko/runtime-governance";

interface Source { readonly path: string; readonly root: string; readonly identity: NativeTranscriptFileIdentity }

/** Read-only discovery over the Adapter's configured native JSONL roots. It
 * intentionally leaves full catalog adoption to the existing import owner. */
export class PiNativePreviewCatalog {
  readonly #sources = new WeakMap<NativeSessionCatalogEntry, Source>();
  constructor(readonly roots: readonly string[]) {}

  async scan(projectDirectories: readonly string[]): Promise<NativeSessionCatalogResult> {
    const projects = await Promise.all(projectDirectories.map((path) => realpath(path).catch(() => undefined)));
    const entries: NativeSessionCatalogEntry[] = [];
    const seen = new Set<string>();
    let inspected = 0;
    for (const configuredRoot of this.roots) {
      const root = await realpath(configuredRoot).catch(() => undefined);
      if (root === undefined || seen.has(root)) continue;
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      seen.add(root);
      const pending = [{ path: root, depth: 0 }];
      let directories = 0;
      while (pending.length > 0 && directories++ < 256 && inspected < 4_000) {
        const directory = pending.shift()!;
        const children = await readdir(directory.path, { withFileTypes: true }).catch(() => []);
        for (const child of children) {
          const path = join(directory.path, child.name);
          if (child.isDirectory() && directory.depth < 3) { pending.push({ path, depth: directory.depth + 1 }); continue; }
          if (!child.isFile() || !child.name.endsWith(".jsonl") || inspected++ >= 4_000) continue;
          const actual = await realpath(path).catch(() => undefined);
          if (actual === undefined || !inside(actual, root) || !same(actual, path)) continue;
          const parts = await readNativeTranscriptWindow(path).catch(() => undefined);
          if (parts === undefined) continue;
          const header = parseRecord(parts.head[0] ?? "");
          if (header?.["type"] !== "session" || typeof header["id"] !== "string" || typeof header["cwd"] !== "string" || !isAbsolute(header["cwd"])) continue;
          const workingDirectory = await realpath(header["cwd"]).catch(() => undefined);
          if (workingDirectory === undefined || !projects.some((project) => project !== undefined && inside(workingDirectory, project))) continue;
          const messages = parseMessages(parts.head);
          const nativeReference = `native-preview:${createHash("sha256").update(root).update("\0").update(path).digest("hex")}`;
          const createdAt = typeof header["timestamp"] === "string" ? Date.parse(header["timestamp"]) : NaN;
          const entry: NativeSessionCatalogEntry = { nativeReference, nativeSessionId: header["id"],
            title: messages.find((item) => item.role === "user")?.text.replace(/\s+/gu, " ").slice(0, 80) ?? "Native task",
            workingDirectory, projectDirectory: workingDirectory,
            createdAt: Number.isFinite(createdAt) ? createdAt : Number(parts.identity.modifiedAtNanoseconds / 1_000_000n),
            modifiedAt: Number(parts.identity.modifiedAtNanoseconds / 1_000_000n), archived: false, placement: "project", existingMatch: "binding" };
          this.#sources.set(entry, { path, root, identity: parts.identity });
          entries.push(entry);
        }
      }
    }
    entries.sort((left, right) => right.modifiedAt - left.modifiedAt || left.nativeReference.localeCompare(right.nativeReference));
    return { entries: entries.slice(0, 1_000), rejectedCount: 0 };
  }

  async read(entry: NativeSessionCatalogEntry): Promise<NativeSessionPreview> {
    const source = this.#sources.get(entry);
    if (source === undefined || !same(await realpath(source.root), source.root) || !same(await realpath(source.path), source.path)
      || !inside(source.path, source.root)) throw new Error("The native transcript source changed. Rescan and retry.");
    const parts: NativeTranscriptWindow = await readNativeTranscriptWindow(source.path, source.identity);
    return boundNativeSessionPreview(parseMessages(parts.head), parseMessages(parts.tail), parts.whole);
  }
}
function parseMessages(lines: readonly string[]): NativeSessionPreview["messages"] {
  return lines.flatMap((line) => {
    const value = parseRecord(line);
    if (value?.["type"] !== "message" || !record(value["message"])) return [];
    const message = value["message"];
    const role = message["role"];
    if (role !== "user" && role !== "assistant") return [];
    const content = message["content"];
    const text = redactSecrets(typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((part: unknown) =>
      record(part) && part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : []).join("\n") : "");
    const at = typeof value["timestamp"] === "string" ? Date.parse(value["timestamp"]) : NaN;
    return [{ role, text, at: Number.isFinite(at) ? at : 0 }];
  });
}
function parseRecord(line: string): Record<string, unknown> | undefined { try { const value: unknown = JSON.parse(line); return record(value) ? value : undefined; } catch { return undefined; } }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function key(path: string): string { return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path; }
function same(left: string, right: string): boolean { return key(resolve(left)) === key(resolve(right)); }
function inside(child: string, parent: string): boolean { const part = relative(key(parent), key(child)); return part === "" || part !== ".." && !part.startsWith("..\\") && !part.startsWith("../") && !isAbsolute(part); }

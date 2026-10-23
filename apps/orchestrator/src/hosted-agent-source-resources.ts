import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { snapshotNativeSkills, validInputMentionRanges, type AdapterContext, type PromptInput, type RuntimeResource, type RuntimeCommand,
  type ApprovedSkillSeed, type NativeSkillSnapshot, type NativeSkillPolicy, type ApprovedDirectory } from "@joko/core";
import type { RuntimeTextResourceSeed } from "./resource-manager.js";
import type { HostedProjectFile } from "./hosted-agent-project-files.js";
import type { ExecutorPathAlias } from "./hosted-agent-workspace.js";

/** Source-owned text catalog, frozen at native creation. No Provider path or
 * Provider-installed resource can stand in for an approved local identity. */
export class HostedAgentSourceResources {
  readonly #entries = new Map<string, readonly RuntimeTextResourceSeed[]>();
  readonly #skills = new Map<string, NativeSkillSnapshot>();
  async captureSkills(context: AdapterContext, seeds: readonly ApprovedSkillSeed[], policy?: NativeSkillPolicy): Promise<readonly RuntimeTextResourceSeed[]> {
    const key = this.#key(context);
    if (this.#skills.has(key)) throw new Error("The Source resource runtime is already captured.");
    const snapshot = await snapshotNativeSkills(seeds, context.signal, undefined, policy);
    try {
      const text = await Promise.all(snapshot.skills.map(async mount => ({ ...mount.seed.resource,
        kind: "skill" as const, content: await readFile(mount.filePath, { encoding: "utf8", signal: context.signal }), assertCurrent: snapshot.assertCurrent })));
      await snapshot.assertFilesCurrent(context.signal); this.#skills.set(key, snapshot); return text;
    } catch (error) { await snapshot.dispose(); throw error; }
  }
  capture(context: AdapterContext, seeds: readonly RuntimeTextResourceSeed[]): readonly HostedProjectFile[] {
    const ids = new Set<string>(); let total = 0;
    const entries = seeds.map(seed => {
      seed.assertCurrent();
      if (!seed.id || ids.has(seed.id) || !["skill", "prompt"].includes(seed.kind) || !seed.name || !seed.revision
        || seed.resourceVersion < 1n || typeof seed.content !== "string" || seed.content.includes("\0")
        || Buffer.byteLength(seed.content) > 512 * 1024) throw new Error("The approved Source text resource is invalid or too large.");
      ids.add(seed.id); total += Buffer.byteLength(seed.content);
      if (ids.size > 512 || total > 4 * 1024 * 1024) throw new Error("The Source text resource catalog exceeds its limit.");
      return Object.freeze({ ...seed });
    });
    context.signal.throwIfAborted(); this.#entries.set(this.#key(context), Object.freeze(entries));
    return entries.map(seed => {
      return { path: resourcePath(seed.id, seed.kind), content: seed.content };
    });
  }
  async release(context: AdapterContext): Promise<void> {
    const key = this.#key(context); this.#entries.delete(key);
    const snapshot = this.#skills.get(key); this.#skills.delete(key); await snapshot?.dispose();
  }
  authority(context: AdapterContext, shadow: string): { readonly aliases: readonly ExecutorPathAlias[]; readonly approvedRoots: readonly ApprovedDirectory[]; readonly revision: string } {
    const snapshot = this.#skills.get(this.#key(context)); snapshot?.assertCurrent();
    const native = /^[A-Za-z]:|^\\\\/u.test(shadow) ? win32 : posix;
    const mounts = snapshot?.skills ?? [];
    return { aliases: mounts.map(mount => ({ from: native.join(shadow, ...resourcePath(mount.seed.resource.id, "skill").split("/").slice(0, -1)), to: mount.path })),
      approvedRoots: mounts.map(mount => ({ id: mount.seed.resource.id, path: mount.path, access: "read_only" as const })),
      revision: JSON.stringify(mounts.map(mount => [mount.seed.resource.id, mount.seed.resource.revision, mount.seed.resource.resourceVersion.toString()])) };
  }
  resources(context: AdapterContext): readonly RuntimeResource[] {
    context.signal.throwIfAborted();
    return (this.#entries.get(this.#key(context)) ?? []).flatMap(seed => {
      try { seed.assertCurrent(); } catch { return []; }
      return [{ id: seed.id, name: seed.name, kind: seed.kind, source: "managed", state: "loaded" as const,
        revision: seed.revision, resourceVersion: seed.resourceVersion, runtimeGeneration: context.generation,
        ...(seed.version === undefined ? {} : { version: seed.version }) }];
    });
  }
  commands(context: AdapterContext): readonly RuntimeCommand[] {
    const resources = this.resources(context);
    const names = resources.map(value => value.name.trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 96) || value.kind);
    return resources.map((resource, index) => ({ name: names.filter(name => name === names[index]).length > 1
      ? `${names[index]}-${createHash("sha256").update(resource.id).digest("hex").slice(0, 8)}` : names[index]!,
      description: resource.name, source: resource.kind as "skill" | "prompt", inputMode: "resource_mention", resourceId: resource.id, loaded: true }));
  }
  resolve(mention: Extract<PromptInput["mentions"][number], { kind: "resource" }>, context: AdapterContext): { readonly text: string; readonly assertCurrent: () => void } {
    const entries = this.#entries.get(this.#key(context)) ?? [];
    const seed = entries.find(value => value.id === mention.reference);
    if (!seed || seed.revision !== mention.discoveredRevision || seed.resourceVersion.toString() !== mention.resourceVersion
      || mention.runtimeGeneration !== context.generation) throw new Error("The referenced Source resource is no longer loaded by this runtime.");
    const assertCurrent = () => { context.signal.throwIfAborted(); context.assertResourceMentionCurrent?.(mention); seed.assertCurrent(); };
    assertCurrent();
    return { text: [`[Joko approved ${seed.kind} resource]`, `Name: ${JSON.stringify(seed.name)}`, "Content:", seed.content, `[End Joko approved ${seed.kind} resource]`].join("\n"), assertCurrent };
  }
  prepare(input: PromptInput, context: AdapterContext): { readonly input: PromptInput; readonly assertCurrent: () => void } {
    if (input.files.length || input.mentions.some(mention => mention.kind !== "resource")) throw new Error("This Source input requires its workspace resolver.");
    const resolved = input.mentions.map(mention => {
      if (mention.kind !== "resource") throw new Error("The Source resource kind is invalid.");
      return this.resolve(mention, context);
    });
    return projectSourceInput(input, context, resolved.map(value => value.text), resolved.map(value => value.assertCurrent));
  }
  #key(context: AdapterContext): string { return JSON.stringify([context.sessionId, context.generation, context.backendInstanceGeneration]); }
}

export function projectSourceInput(input: PromptInput, context: AdapterContext, blocks: readonly string[], guards: readonly (() => void)[], files: readonly string[] = [], retainedFiles: readonly string[] = []): { readonly input: PromptInput; readonly assertCurrent: () => void } {
  if (blocks.length !== input.mentions.length || files.length !== input.files.length
    || !validInputMentionRanges(input.text, input.mentions, input.mentionRanges ?? [], input.pastedTextRanges ?? [])) throw new Error("The accepted Source mention ranges are invalid.");
  const text: string[] = [], represented = new Set<number>(); let cursor = 0;
  for (const range of input.mentionRanges ?? []) {
    text.push(input.text.slice(cursor, range.start), `\n\n${blocks[range.mentionIndex]!}\n\n`);
    cursor = range.end; represented.add(range.mentionIndex);
  }
  text.push(input.text.slice(cursor), ...blocks.filter((_, index) => !represented.has(index)));
  const combined = [...text, ...files, ...retainedFiles].join("\n");
  if (Buffer.byteLength(combined) > 1024 * 1024) throw new Error("The resolved Source prompt exceeds its text limit.");
  const assertCurrent = () => { context.signal.throwIfAborted(); for (const assert of guards) assert(); };
  assertCurrent();
  const { mentionRanges: _ranges, pastedTextRanges: _pasted, ...withoutRanges } = input;
  return { input: blocks.length || files.length || retainedFiles.length ? { ...withoutRanges, text: combined, files: [], mentions: [] } : input, assertCurrent };
}
function resourcePath(id: string, kind: "skill" | "prompt"): string {
  const digest = createHash("sha256").update(id).digest("hex");
  return kind === "skill" ? `.agents/skills/approved-${digest}/SKILL.md` : `.pi/prompts/approved-${digest}.md`;
}

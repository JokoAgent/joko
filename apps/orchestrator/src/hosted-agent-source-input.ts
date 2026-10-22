import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { validInputMentionRanges, type AdapterContext, type DurableNativeDispatchPreparation, type PromptInput } from "@joko/core";
import { HostedAgentSourceResources, projectSourceInput } from "./hosted-agent-source-resources.js";
import type { SourceAttachmentPreparation } from "./hosted-agent-source-attachments.js";

/** References retain the task computer's identity; only their virtual native
 * paths enter the prompt. File contents still pass through the Source gate. */
export async function prepareSourceWorkspaceInput(input: PromptInput, context: AdapterContext, options: {
  readonly shadow: string; readonly workspaceId: string; readonly resources: HostedAgentSourceResources; readonly assertCurrent: () => void;
  readonly attachments?: SourceAttachmentPreparation;
}): Promise<{ readonly input: PromptInput; readonly assertCurrent: () => void; readonly commit?: (preparation: DurableNativeDispatchPreparation) => Promise<void> }> {
  const guard = () => { context.signal.throwIfAborted(); options.assertCurrent(); };
  guard();
  if (input.files.length && !options.attachments || input.files.length + input.mentions.length + input.images.length > 256
    || !validInputMentionRanges(input.text, input.mentions, input.mentionRanges ?? [], input.pastedTextRanges ?? [])) throw new Error("The Source input shape is unsupported or invalid.");
  const native = /^[A-Za-z]:|^\\/u.test(options.shadow) ? win32 : posix;
  if (!native.isAbsolute(options.shadow) || options.shadow.length > 16_384 || /[\x00-\x1f\x7f]/u.test(options.shadow)) throw new Error("The Source native workspace is invalid.");
  const blocks: string[] = [], guards = [guard], files: string[] = [];
  for (const [index, file] of input.files.entries()) {
    const workspace = file.workspacePath === undefined ? undefined : await capturePath(file.workspacePath, false, context, options.shadow, guard);
    const value = await options.attachments!.file(file, index, workspace); files.push(value.text); guards.push(value.assertCurrent);
  }
  for (const mention of input.mentions) {
    guard();
    if (mention.kind === "resource") {
      const resource = options.resources.resolve(mention, context); blocks.push(resource.text); guards.push(resource.assertCurrent); continue;
    }
    if (mention.kind === "artifact") {
      if (!options.attachments) throw new Error("This Source Artifact requires its original authority resolver.");
      const value = await options.attachments.artifact(mention.reference, mention.sourceSessionId, mention.label); blocks.push(value.text); guards.push(value.assertCurrent); continue;
    }
    if (mention.kind !== "workspace_file" && mention.kind !== "workspace_directory") throw new Error("This Source mention requires its authority resolver.");
    if (mention.workspaceId !== options.workspaceId || !mention.reference || mention.reference.length > 4096
      || isAbsolute(mention.reference) || win32.isAbsolute(mention.reference) || /[\x00-\x1f\x7f]/u.test(mention.reference)) throw new Error("The Source workspace reference is stale or outside its workspace.");
    if (mention.lineRange !== undefined && (mention.kind !== "workspace_file" || !Number.isSafeInteger(mention.lineRange.startLine)
      || !Number.isSafeInteger(mention.lineRange.endLine) || mention.lineRange.startLine < 1 || mention.lineRange.endLine < mention.lineRange.startLine
      || mention.lineRange.endLine > 0xffff_ffff)) throw new Error("The Source line range is invalid.");
    const value = await capturePath(mention.reference, mention.kind === "workspace_directory", context, options.shadow, guard);
    guards.push(value.assertCurrent);
    blocks.push(`Workspace ${mention.kind === "workspace_directory" ? "directory" : "file"} reference: ${JSON.stringify({ name: mention.label,
      ...(mention.lineRange === undefined ? {} : { lineRange: { ...mention.lineRange } }) })}\nPath: ${value.nativePath}`);
  }
  const retained = options.attachments?.retained() ?? [];
  guards.push(...retained.map(file => file.assertCurrent));
  const prepared = projectSourceInput(input, context, blocks, guards, files, retained.map(file => file.text));
  return { ...prepared, ...(input.files.length || input.mentions.some(mention => mention.kind === "artifact") ? { commit: options.attachments!.commit } : {}) };
}

async function capturePath(reference: string, directory: boolean, context: AdapterContext, shadow: string, guard: () => void): Promise<{ readonly path: string; readonly nativePath: string; readonly assertCurrent: () => void }> {
    if (!reference || reference.length > 4096 || isAbsolute(reference) || win32.isAbsolute(reference) || /[\x00-\x1f\x7f]/u.test(reference)) throw new Error("The Source file path is invalid.");
    const native = /^[A-Za-z]:|^\\/u.test(shadow) ? win32 : posix;
    const root = await realpath(context.target.workspaceRoot); guard();
    if (!samePath(root, context.target.workspaceRoot)) throw new Error("The Source workspace no longer has its original canonical path.");
    const candidate = resolve(root, reference);
    if (!inside(root, candidate)) throw new Error("The Source reference is outside its workspace.");
    const before = await lstat(candidate, { bigint: true }), actual = await realpath(candidate); guard();
    if (!inside(root, actual) || before.isSymbolicLink() || !(directory ? before.isDirectory() : before.isFile())
      || !directory && before.size > 256n * 1024n * 1024n) throw new Error("The Source reference does not identify an allowed file or directory.");
    const assertCurrent = () => {
      guard(); const current = lstatSync(candidate, { bigint: true });
      if (current.isSymbolicLink() || !(directory ? current.isDirectory() : current.isFile()) || current.dev !== before.dev || current.ino !== before.ino
        || !samePath(realpathSync(context.target.workspaceRoot), root) || !samePath(realpathSync(candidate), actual)) throw new Error("The Source workspace reference changed before dispatch.");
    };
    assertCurrent(); return { path: actual, nativePath: native.join(shadow, ...relative(root, actual).split(sep)), assertCurrent };
}
function samePath(left: string, right: string): boolean { return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right); }
function inside(root: string, target: string): boolean { const value = relative(root, target); return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value); }

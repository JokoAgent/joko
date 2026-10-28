import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createPiAutoReviewer, type AutoReviewControl } from "@joko/adapter-pi";
import type { AdapterContext, NativeToolAuthorizationDecision, ToolCall } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { AuxiliaryTextRouting } from "./auxiliary-text-routing.js";
import type { HostedAgentExecutorPolicy } from "./hosted-agent-executor.js";
import { realPathOrAncestor } from "./hosted-agent-workspace.js";
import { readNativeOwnerInstructions } from "./native-owner-intent.js";

/** Reuses the native deterministic/contextual reviewer on the task node. The
 * auxiliary owner retains model credentials, deadlines and route revocation. */
export function createHostedAgentAutoReviewer(options: {
  readonly store: OperationalStore;
  readonly auxiliary: AuxiliaryTextRouting;
  readonly readPolicy: (context: AdapterContext) => HostedAgentExecutorPolicy;
  readonly redact: (text: string) => string;
}) {
  const reviewers = new Map<string, ReturnType<typeof createPiAutoReviewer>>();
  return async (context: AdapterContext, call: ToolCall, signal: AbortSignal, assertCurrent: () => void, capturedPolicy?: HostedAgentExecutorPolicy): Promise<NativeToolAuthorizationDecision> => {
    const plan = options.auxiliary.capture();
    let identity = "", epoch = 0;
    const guard = () => {
      signal.throwIfAborted(); context.signal.throwIfAborted(); assertCurrent();
      const session = options.store.getSession(context.sessionId).descriptor;
      if (session.binding.generation !== context.generation || session.targetId !== context.target.id
        || session.backendId !== context.target.backendId || session.deletedAt !== undefined
        || session.permissionMode !== "auto" || !options.auxiliary.isCurrent(plan)) throw new Error("The original automatic review authority changed.");
    };
    const control = (): AutoReviewControl => {
      guard(); const policy = options.readPolicy(context), session = options.store.getSession(context.sessionId).descriptor;
      const next = JSON.stringify([context.sessionId, context.generation, context.backendInstanceGeneration, policy.revision, capturedPolicy?.revision,
        session.providerId, session.modelId, session.planMode, plan.runtimeRevision]);
      if (next !== identity) { identity = next; epoch++; }
      return { policyGeneration: epoch, permissionMode: "auto", approvedRoots: [
        { path: context.target.workspaceRoot, access: "read_write" }, ...(capturedPolicy ?? policy).approvedRoots
      ] };
    };
    const branch = () => {
      guard();
      return readNativeOwnerInstructions(options.store, context, options.redact)
        .map(content => ({ type: "message", message: { role: "user", content } }));
    };
    const captured = control();
    const digest = createHash("sha256").update(JSON.stringify([plan.models, plan.revision.toString(), plan.runtimeRevision])).digest("hex");
    const key = createHash("sha256").update(JSON.stringify([identity, digest, captured.approvedRoots])).digest("hex");
    let reviewer = reviewers.get(key);
    if (!reviewer) {
      reviewer = createPiAutoReviewer({ resolvePath: (value, cwd) => {
        try { return realPathOrAncestor(resolve(cwd, value)); } catch { return undefined; }
      } });
      reviewers.set(key, reviewer); if (reviewers.size > 128) { const oldest = reviewers.keys().next().value!; reviewers.get(oldest)?.clear(); reviewers.delete(oldest); }
    }
    const decision = await reviewer.review({ control: captured, readControl: control, workspaceRoot: context.target.workspaceRoot,
      event: { toolName: call.name, input: call.args }, ctx: { cwd: context.target.workspaceRoot, signal,
        model: { provider: "task-node-auxiliary", id: digest }, sessionManager: { getBranch: branch },
        modelRegistry: { complete: async (_model, input, request) => {
          guard(); const result = await options.auxiliary.run(plan, { system: input.systemPrompt,
            user: options.redact(input.messages[0].content[0].text), maxTokens: request.maxTokens,
            timeoutMs: 20_000, signal: request.signal, stillCurrent: () => { guard(); return true; }, validate: raw => raw });
          guard(); if (result.status !== "ok") throw new Error("Automatic review is unavailable.");
          return { content: [{ type: "text", text: result.text }] };
        } } } });
    guard();
    return { verdict: decision.verdict, reason: options.redact(decision.reason), ...(decision.unavailable ? { unavailable: true } : {}) };
  };
}

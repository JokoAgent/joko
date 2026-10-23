import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createPiAutoReviewer, type AutoReviewControl } from "@joko/adapter-pi";
import type { AdapterContext, NativeToolAuthorizationDecision, ToolCall } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { AuxiliaryTextRouting } from "./auxiliary-text-routing.js";
import type { HostedAgentExecutorPolicy } from "./hosted-agent-executor.js";
import { realPathOrAncestor } from "./hosted-agent-workspace.js";

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
      const active = new Set<string>(); let afterCursor: bigint | undefined, complete = false;
      // Never drop an earlier restriction to fit the evidence budget.
      for (let page = 0; page < 20; page++) {
        const events = options.store.listEvents({ sessionId: context.sessionId, activeNativeTimeline: true, limit: 500,
          ...(afterCursor === undefined ? {} : { afterCursor }) });
        for (const event of events) {
          const value = event.payload;
          if (value.type !== "message_complete" || value.role !== "user" || value.automaticContinuation || value.objectiveContinuation
            || value.inputHandoffContinuation || value.partnerPrivateOrigin) continue;
          if (event.operationId) active.add(event.operationId);
        }
        if (events.length < 500) { complete = true; break; }
        afterCursor = events.at(-1)!.globalCursor;
      }
      if (!complete) return [];
      const instructions: { at: number; text: string }[] = [];
      for (let offset = 0; ; offset += 500) {
        const page = options.store.listQueueItems({ sessionId: context.sessionId, offset, limit: 500 });
        for (const item of page) if (options.store.getRun(item.runId).descriptor.source === "user"
          && (active.has(item.operationId) && ["backend_accepted", "completed"].includes(item.state)
            || item.operationId === context.operationId && ["dispatching", "backend_accepted", "completed"].includes(item.state))) {
          // Provider-native user-shaped messages cannot author owner consent.
          instructions.push({ at: item.createdAt, text: item.body.text });
        }
        if (page.length < 500) break;
        if (offset >= 10_000) return [];
      }
      const answers = options.store.listInteractions({ sessionId: context.sessionId, kinds: ["question", "plan_review"], status: "resolved", limit: 65 });
      if (answers.length >= 65) return [];
      for (const answer of answers) if (answer.generation === context.generation && answer.decision
        && ["question", "plan_review"].includes(answer.decision.kind)) instructions.push({ at: answer.resolvedAt ?? answer.createdAt,
          text: JSON.stringify({ interactionContext: answer.payload, ownerAnswer: answer.decision }) });
      const values = instructions.sort((a, b) => a.at - b.at).map(value => options.redact(value.text));
      if (values.length > 64 || values.reduce((size, value) => size + value.length, 0) > 16_000) return [];
      return values.map(content => ({ type: "message", message: { role: "user", content } }));
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

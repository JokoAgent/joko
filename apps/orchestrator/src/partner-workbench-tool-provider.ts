import { redactSecrets, type PartnerWorkbenchJudgment } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { PartnerManager } from "./partner-manager.js";
import { PartnerWorkbenchError, type PartnerWorkbenchManager, type PartnerWorkbenchOwner } from "./partner-workbench-manager.js";
import type { BridgeToolCallContext, BridgeToolProvider, McpCallResult, McpToolDescriptor } from "./mcp-router.js";

const PROVIDER_ID = "joko_partner_workbench";
const ID = { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$" };
const PATH = { type: "string", minLength: 1, maxLength: 32_768 };
const JUDGMENT = { task_id: ID, project: PATH, title: { type: "string", minLength: 1, maxLength: 40 },
  verdict: { type: "string", enum: ["unfinished", "idea", "done"] }, next: { type: "string", maxLength: 120 }, ref: { type: "string", maxLength: 2_000 } };
const schema = (properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });
const tool = (name: string, description: string, inputSchema: Record<string, unknown>, requiresPermission = false): McpToolDescriptor => ({ serverId: PROVIDER_ID, name, description, inputSchema, requiresPermission });

/** Direct tools for the same project, file and Queue authority as the owner UI. */
export class PartnerWorkbenchToolProvider implements BridgeToolProvider {
  readonly id = PROVIDER_ID;
  readonly generation = 1;
  readonly available = true;
  readonly tools = [
    tool("get_workbench", "Read handed-over projects, bounded recent task candidates, judgments, routines, automation and project briefs. Quiet tasks are not evidence of unfinished work.", schema({})),
    tool("read_workbench", "Read the bounded transcript of one task_id, or one text document path in a currently handed-over project. Supply exactly one.", schema({ task_id: ID, path: PATH })),
    tool("set_workbench", "Save a judgment for one scoped task or a new item:<identity> note. Unfinished and idea judgments require a concise next step; judgments do not change runtime state.", schema(JUDGMENT, ["task_id", "project", "title", "verdict"])),
    tool("set_many_workbench", "Save one to 30 workbench judgments, with an explicit per-item result. Each uses the same current project authority.", schema({ items: { type: "array", minItems: 1, maxItems: 30, items: schema(JUDGMENT, ["task_id", "project", "title", "verdict"]) } }, ["items"])),
    tool("continue_workbench", "Continue one handed-over task through its actual Queue. Adopt one exact native candidate when supported, otherwise create one owned background task from bounded source evidence. Unconfirmed effects must be inspected, not blindly repeated.", schema({ task_id: ID, message: { type: "string", maxLength: 12_000 } }, ["task_id"])),
    tool("add_workbench_project", "Accept one existing absolute or ~/ project directory into this partner's workbench and runtime file scope under the current Agent permission policy.", schema({ path: PATH }, ["path"]), true),
    tool("remove_workbench_project", "Withdraw one workbench project grant. Its files, tasks, histories and saved judgments are preserved.", schema({ path: PATH }, ["path"]), true)
  ] satisfies readonly McpToolDescriptor[];
  constructor(readonly options: { readonly store: OperationalStore; readonly partners: PartnerManager; readonly workbench: PartnerWorkbenchManager }) {}

  includeForTarget(targetId: string): boolean {
    const partner = this.options.partners.partnerForHomeTarget(targetId);
    return partner?.lifecycle === "active" && partner.initializationState === "ready";
  }

  async callTool(name: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<McpCallResult> {
    signal?.throwIfAborted();
    try {
      const owner = this.#caller(context);
      const active = this.options.workbench;
      let result: unknown;
      if (name === "get_workbench") {
        keys(input, []);
        const view = await active.readState(owner.partnerId);
        result = { revision: view.state.revision, projects: view.projects, tasks: view.candidates,
          notes: view.tasks.filter((task) => task.kind === "item"), automations: view.tasks.filter((task) => task.kind === "automation"), briefs: view.briefs,
          older_count: view.olderCount, truncated: view.truncated, unavailable_sources: view.unavailableSources };
      } else if (name === "read_workbench") {
        keys(input, ["task_id", "path"]);
        if ((input["task_id"] === undefined) === (input["path"] === undefined)) throw invalid("Supply exactly one task_id or path.");
        result = input["task_id"] === undefined ? await active.readProjectFile(owner, text(input, "path", 32_768)) : await active.readDetail(owner, text(input, "task_id", 256));
      } else if (name === "set_workbench") {
        effect(context);
        const judgment = readJudgment(input);
        const before = await active.readState(owner.partnerId);
        const view = await active.setJudgment(owner, before.state.revision, judgment);
        result = { revision: view.state.revision, task_id: judgment.taskId, saved: true };
      } else if (name === "set_many_workbench") {
        keys(input, ["items"]);
        effect(context);
        if (!Array.isArray(input["items"]) || input["items"].length < 1 || input["items"].length > 30) throw invalid("Provide one to 30 judgments.");
        const results: Array<{ readonly taskId: string; readonly ok: boolean; readonly error?: string }> = [];
        for (const value of input["items"]) {
          signal?.throwIfAborted();
          if (JSON.stringify(this.#caller(context)) !== JSON.stringify(owner)) throw invalid("The workbench caller changed.");
          try {
            if (!record(value)) throw invalid("A judgment is invalid.");
            results.push(...(await active.setManyJudgments(owner, [readJudgment(value)])).results);
          } catch (error) {
            const taskId = record(value) && typeof value["task_id"] === "string" ? value["task_id"].slice(0, 256) : "";
            results.push({ taskId, ok: false, error: error instanceof PartnerWorkbenchError ? error.message : "The judgment could not be saved." });
          }
        }
        result = { results };
      } else if (name === "continue_workbench") {
        keys(input, ["task_id", "message"]);
        result = await active.continueTask(owner, text(input, "task_id", 256), input["message"] === undefined ? "" : text(input, "message", 12_000, true), `partner-workbench:${effect(context)}`);
      } else if (name === "add_workbench_project" || name === "remove_workbench_project") {
        keys(input, ["path"]);
        effect(context);
        const before = await active.readState(owner.partnerId);
        const path = text(input, "path", 32_768);
        const view = name === "add_workbench_project" ? await active.addProject(owner, before.state.revision, path) : await active.removeProject(owner, before.state.revision, path);
        result = { revision: view.state.revision, projects: view.projects };
      } else throw invalid("The workbench tool is not part of this runtime snapshot.");
      signal?.throwIfAborted();
      const current = this.#caller(context);
      if (JSON.stringify(current) !== JSON.stringify(owner)) throw invalid("The workbench caller changed.");
      return { isError: false, content: [{ type: "text", text: JSON.stringify(result, (_key, value: unknown) => typeof value === "bigint" ? value.toString(10) : value) }] };
    } catch (error) {
      if (signal?.aborted || error instanceof Error && error.name === "AbortError") throw error;
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false,
        code: error instanceof PartnerWorkbenchError ? error.code : "WORKBENCH_UNAVAILABLE",
        message: redactSecrets(error instanceof Error ? error.message : "The workbench action is unavailable.").slice(0, 400) }) }] };
    }
  }
  #caller(context: BridgeToolCallContext): PartnerWorkbenchOwner {
    const session = this.options.store.getSession(context.sessionId).descriptor;
    if (context.providerGeneration !== undefined && context.providerGeneration !== this.generation || session.targetId !== context.targetId
      || session.binding.generation !== context.generation || session.archived || session.deletedAt !== undefined) throw invalid("The workbench tool scope is stale.");
    return this.options.workbench.ownerForCaller(context.sessionId);
  }
}

function readJudgment(input: Readonly<Record<string, unknown>>): Omit<PartnerWorkbenchJudgment, "updatedAt"> {
  keys(input, Object.keys(JUDGMENT));
  const verdict = input["verdict"];
  if (verdict !== "unfinished" && verdict !== "idea" && verdict !== "done") throw invalid("The judgment verdict is invalid.");
  return { taskId: text(input, "task_id", 256), project: text(input, "project", 32_768), title: text(input, "title", 40), verdict,
    next: input["next"] === undefined ? null : text(input, "next", 120, true) || null,
    ...(input["ref"] === undefined ? {} : { ref: text(input, "ref", 2_000) }) };
}
function keys(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): void { if (Object.keys(input).some((key) => !allowed.includes(key))) throw invalid("Unknown workbench arguments."); }
function text(input: Readonly<Record<string, unknown>>, key: string, max: number, empty = false): string {
  const value = input[key];
  if (typeof value !== "string" || !empty && !value.trim() || value.length > max || value.includes("\0")) throw invalid(`${key} is invalid.`);
  return value;
}
function effect(context: BridgeToolCallContext): string {
  if (!/^[a-f0-9]{64}$/u.test(context.effectIdentity ?? "")) throw invalid("The durable workbench effect identity is unavailable.");
  return context.effectIdentity!;
}
function invalid(message: string): PartnerWorkbenchError { return new PartnerWorkbenchError("WORKBENCH_INVALID", message); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

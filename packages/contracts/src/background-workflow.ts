import type { BackgroundWorkflowAgent, BackgroundWorkflowProgress } from "./gen/joko/v1/runtime_pb.js";

const terminal = new Set(["completed", "done", "failed", "error", "stopped", "killed", "aborted", "cancelled"]);
const unfinished = new Set(["start", "progress", "running", "queued", "pending"]);

export interface BackgroundWorkflowGroup {
  readonly title?: string;
  readonly detail?: string;
  readonly agents: readonly BackgroundWorkflowAgent[];
}

/** Presentation only: a native file never changes the product task or Run state. */
export function projectBackgroundWorkflow(workflow: BackgroundWorkflowProgress, taskState?: string): {
  readonly status: string;
  readonly agentCount: bigint;
  readonly groups: readonly BackgroundWorkflowGroup[];
} {
  const ended = terminal.has(workflow.status) || taskState !== undefined && terminal.has(taskState);
  const phases = new Map<string, { title: string; detail?: string; agents: BackgroundWorkflowAgent[] }>();
  const titles = new Map<number, string>();
  for (const phase of workflow.phases) {
    if (!titles.has(phase.index)) titles.set(phase.index, phase.title);
    const group = phases.get(phase.title);
    if (!group) phases.set(phase.title, { title: phase.title, detail: phase.detail, agents: [] });
    else if (!group.detail && phase.detail) group.detail = phase.detail;
  }
  const orphans: BackgroundWorkflowAgent[] = [];
  for (const original of workflow.agents) {
    const agent = ended && unfinished.has(original.state) ? { ...original, state: "error" } : original;
    const title = original.phaseTitle || (original.phaseIndex === undefined ? undefined : titles.get(original.phaseIndex));
    const group = title === undefined ? undefined : phases.get(title);
    (group?.agents ?? orphans).push(agent);
  }
  const groups: BackgroundWorkflowGroup[] = [...phases.values()].filter(group => group.agents.length > 0);
  if (orphans.length > 0) groups.push({ agents: orphans });
  const count = BigInt(workflow.agents.length);
  return { status: terminal.has(workflow.status) ? workflow.status : taskState ?? workflow.status,
    agentCount: workflow.agentCount !== undefined && workflow.agentCount > count ? workflow.agentCount : count, groups };
}

export function backgroundWorkflowDuration(milliseconds: bigint): string {
  const seconds = milliseconds / 1_000n;
  if (seconds >= 3_600n) return `${seconds / 3_600n}h ${seconds % 3_600n / 60n}m`;
  return seconds >= 60n ? `${seconds / 60n}m ${seconds % 60n}s` : `${seconds}s`;
}

const en = { title: "Workflow progress", agents: "Agents", tokens: "Tokens", tools: "Tools", duration: "Duration",
  attempt: "Attempt", logs: "Logs", other: "Other agents", model: "Model", tool: "Latest tool", result: "Result", error: "Error",
  endedEarly: "Ended before this agent finished.",
  states: { start: "Starting", progress: "Working", running: "Working", queued: "Queued", pending: "Waiting", waiting: "Waiting",
    done: "Completed", completed: "Completed", error: "Failed", failed: "Failed", stopped: "Stopped", killed: "Stopped", aborted: "Stopped", cancelled: "Stopped", unknown: "Unconfirmed" } };
type Messages = typeof en;
const zh: Messages = { title: "工作流进度", agents: "Agent", tokens: "Token", tools: "工具", duration: "时长", attempt: "尝试次数",
  logs: "日志", other: "其它 Agent", model: "模型", tool: "最近工具", result: "结果", error: "错误", endedEarly: "任务结束时此 Agent 尚未完成。",
  states: { start: "启动中", progress: "工作中", running: "工作中", queued: "排队中", pending: "等待中", waiting: "等待中", done: "已完成", completed: "已完成",
    error: "失败", failed: "失败", stopped: "已停止", killed: "已停止", aborted: "已停止", cancelled: "已停止", unknown: "未确认" } };
const zhTW: Messages = { title: "工作流程進度", agents: "Agent", tokens: "Token", tools: "工具", duration: "時間", attempt: "嘗試次數",
  logs: "記錄", other: "其他 Agent", model: "模型", tool: "最近工具", result: "結果", error: "錯誤", endedEarly: "任務結束時此 Agent 尚未完成。",
  states: { start: "啟動中", progress: "工作中", running: "工作中", queued: "排隊中", pending: "等待中", waiting: "等待中", done: "已完成", completed: "已完成",
    error: "失敗", failed: "失敗", stopped: "已停止", killed: "已停止", aborted: "已停止", cancelled: "已停止", unknown: "未確認" } };
export function backgroundWorkflowMessages(locale: string): Messages { return locale === "zh-TW" ? zhTW : locale.startsWith("zh") ? zh : en; }
export function backgroundWorkflowStateLabel(state: string, locale: string): string {
  const states: Readonly<Record<string, string>> = backgroundWorkflowMessages(locale).states;
  return states[state] ?? state;
}

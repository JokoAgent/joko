export interface NativeStrings {
  readonly heading: string;
  readonly running: string;
  readonly interaction: string;
  readonly completed: string;
  readonly error: string;
  readonly focus: string;
  readonly allow: string;
  readonly allowForSession: string;
  readonly deny: string;
  readonly expand: string;
  readonly collapse: string;
  readonly showAll: string;
  readonly settings: string;
  readonly mute: string;
  readonly unmute: string;
  readonly ready: string;
  readonly readyForTask: string;
  readonly noTasks: string;
  readonly newTask: string;
  readonly untitled: string;
  readonly recentActivity: string;
  readonly awaitingPermission: string;
  readonly awaitingQuestion: string;
  readonly awaitingPlan: string;
  readonly taskCount: (count: number) => string;
  readonly more: (count: number) => string;
}

export const EN_STRINGS: NativeStrings = Object.freeze({
  heading: "Task status",
  running: "Running",
  interaction: "Needs input",
  completed: "Completed",
  error: "Needs attention",
  focus: "Open",
  allow: "Allow",
  allowForSession: "Allow for task",
  deny: "Deny",
  expand: "Expand task status",
  collapse: "Collapse task status",
  showAll: "Show all tasks",
  settings: "Open task-status settings",
  mute: "Mute task-status sounds",
  unmute: "Turn on task-status sounds",
  ready: "Ready",
  readyForTask: "Ready for a new task",
  noTasks: "Running tasks and requests that need your attention will appear here.",
  newTask: "New task",
  untitled: "Untitled task",
  recentActivity: "Recent activity",
  awaitingPermission: "Awaiting permission",
  awaitingQuestion: "Awaiting your reply",
  awaitingPlan: "Awaiting plan review",
  taskCount: (count: number) => `${count} ${count === 1 ? "task" : "tasks"}`,
  more: (count: number) => `${count} more`
});

export const ZH_STRINGS: NativeStrings = Object.freeze({
  heading: "任务状态",
  running: "正在运行",
  interaction: "需要输入",
  completed: "已完成",
  error: "需要关注",
  focus: "打开",
  allow: "允许",
  allowForSession: "本任务允许",
  deny: "拒绝",
  expand: "展开任务状态",
  collapse: "收起任务状态",
  showAll: "显示所有任务",
  settings: "打开任务状态设置",
  mute: "关闭任务状态声音",
  unmute: "开启任务状态声音",
  ready: "就绪",
  readyForTask: "可以开始新任务",
  noTasks: "运行中的任务和需要你处理的请求会显示在这里。",
  newTask: "新建任务",
  untitled: "未命名任务",
  recentActivity: "最近活动",
  awaitingPermission: "等待权限确认",
  awaitingQuestion: "等待你的回复",
  awaitingPlan: "等待计划审核",
  taskCount: (count: number) => `${count} 个任务`,
  more: (count: number) => `还有 ${count} 个`
});

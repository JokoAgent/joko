const en = {
  groups: "Groups", create: "Create group", name: "Group name", members: "Members", membersHint: "Choose 2–6 partners", chat: "Open group", settings: "Group settings", back: "Back",
  send: "Send", stop: "Stop", continue: "Continue discussion", placeholder: "Message the group · @mention a partner", attach: "Add attachments", divide: "Arrange work", remove: "Remove",
  empty: "Start a conversation with your partners", loading: "Loading group…", refresh: "Refresh", older: "Earlier messages", unavailable: "Group unavailable", save: "Save", cancel: "Cancel",
  all: "Everyone replies", mentioned: "Mentioned partners reply", replyMode: "Who replies", speaking: "Speaking order", auto: "First circle together, then in turn", sequential: "In turn",
  organizer: "Organizer", automatic: "First available partner", project: "Project folder", clearProject: "Use the group folder", folderHint: "Work is shared in one worktree when the folder is a Git repository.",
  delete: "Delete group", deleteHint: "Group conversations are removed and hidden tasks are archived. Existing worktrees are retained.", confirmDelete: "Delete this group?", unread: "Unread",
  roundEnd: "Discussion paused", planEnd: "Work completed", plan: "Work plan", start: "Start", dismiss: "Not now", retry: "Retry step", next: "Continue to next partner", reassign: "Change partner",
  pending: "Pending", running: "Working", done: "Done", failed: "Failed", paused: "Paused", error: "Unavailable", archived: "Archived", deleting: "Deleting", missing: "Missing", active: "Ready",
  proposed: "Ready to start", waiting: "Waiting for you", stopped: "Stopped", dismissed: "Dismissed", superseded: "Replaced", handoff: "Handoff files", opening: "Opening…",
  memberFailed: "This partner could not finish the reply.", memberTimeout: "This partner reached the reply time limit.", memberUnavailable: "This partner is unavailable.",
  planFailed: "A work plan could not be prepared.", planStopped: "The work plan was stopped.", workdirUnavailable: "The approved working folder is unavailable.",
  planning: "Arranging work", replying: "Replying", decision: "Needs your decision", answer: "Submit answer", allowOnce: "Allow once", allowTurn: "Allow for this turn", allowSession: "Allow for this group task",
  denyOnce: "Deny", denySession: "Deny for this group task", abort: "Stop this reply", execute: "Execute", stayPlan: "Keep planning", refine: "Refine", feedback: "Feedback", other: "Other", yes: "Yes", no: "No",
  pendingCreate: "A previous creation needs checking", checkCreate: "Check creation", retireCreate: "Retire creation", attachmentsLimit: "At most 20 attachments", maxName: "At most 40 characters",
  readOnlyFiles: "Open handoff files on the host", memberRemoved: "A member can finish an approved step after leaving the group.",
  planIntro: "I suggest these {count} steps. Each partner will hand their work to the next.", editHint: "Click a step to change it", pauseNote: "Each step pauses for your review before the next partner starts.",
  keepOneStep: "Keep one step", nextStep: "Next", more: "More actions", divisionTag: "Work plan", divisionDescription: "Ask the organizer to arrange work for the group", divisionBusy: "Finish the current plan first", removeDivision: "Remove work plan mode"
};
const zh: typeof en = {
  groups: "群聊", create: "创建群聊", name: "群聊名称", members: "成员", membersHint: "选择 2–6 位伙伴", chat: "打开群聊", settings: "群聊设置", back: "返回",
  send: "发送", stop: "停止", continue: "继续讨论", placeholder: "给群聊发消息 · @提及伙伴", attach: "添加附件", divide: "安排分工", remove: "移除",
  empty: "和伙伴们开始讨论", loading: "正在读取群聊…", refresh: "刷新", older: "更早的消息", unavailable: "群聊暂不可用", save: "保存", cancel: "取消",
  all: "所有成员回复", mentioned: "仅提及的成员回复", replyMode: "谁来回复", speaking: "发言顺序", auto: "首圈一起，之后轮流", sequential: "依次发言",
  organizer: "负责人", automatic: "首位可用成员", project: "项目文件夹", clearProject: "使用群聊文件夹", folderHint: "Git 项目中的分工会共享一个 worktree。",
  delete: "删除群聊", deleteHint: "移除群聊记录并归档隐藏任务，已有 worktree 会保留。", confirmDelete: "删除这个群聊？", unread: "未读",
  roundEnd: "讨论已停下", planEnd: "分工已完成", plan: "分工安排", start: "开始", dismiss: "先不用", retry: "重试这一步", next: "交给下一位", reassign: "换一位",
  pending: "待开始", running: "正在工作", done: "已完成", failed: "未完成", paused: "已暂停", error: "暂不可用", archived: "已归档", deleting: "正在删除", missing: "已不在这里", active: "可用",
  proposed: "等待开始", waiting: "等待你的下一步", stopped: "已停止", dismissed: "暂不执行", superseded: "已更新", handoff: "交接文件", opening: "正在打开…",
  memberFailed: "这位伙伴未能完成回复。", memberTimeout: "这位伙伴的回复已超时。", memberUnavailable: "这位伙伴暂不可用。",
  planFailed: "未能生成分工安排。", planStopped: "分工已停止。", workdirUnavailable: "原工作文件夹暂不可用。",
  planning: "正在安排分工", replying: "正在回复", decision: "需要你决定", answer: "提交回答", allowOnce: "允许一次", allowTurn: "允许这一轮", allowSession: "允许此群聊任务",
  denyOnce: "拒绝", denySession: "在此群聊任务中拒绝", abort: "停止本次回复", execute: "执行", stayPlan: "继续规划", refine: "调整计划", feedback: "反馈", other: "其他", yes: "是", no: "否",
  pendingCreate: "上次创建需要确认结果", checkCreate: "查询创建结果", retireCreate: "结束创建意图", attachmentsLimit: "最多 20 个附件", maxName: "最多 40 字",
  readOnlyFiles: "请在主机打开交接文件", memberRemoved: "离开群聊的成员仍可完成已经批准的步骤。",
  planIntro: "我建议分成这 {count} 步，做完后交给下一位伙伴。", editHint: "点击步骤可调整", pauseNote: "每一步完成后都会停下，等你确认再交给下一位。",
  keepOneStep: "至少保留一步", nextStep: "下一步", more: "更多操作", divisionTag: "分工", divisionDescription: "请负责人为群聊安排分工", divisionBusy: "请先完成当前分工", removeDivision: "取消分工模式"
};
export function partnerGroupMessages(locale: string): typeof en { return locale === "zh-CN" ? zh : en; }

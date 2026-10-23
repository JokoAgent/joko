export function providerSharingText(language = "en") {
  const zh = language.startsWith("zh");
  return {
    title: zh ? "供应商分享" : "Provider sharing", body: zh ? "逐人分享模型能力。文件与命令由使用者自己的原机执行。" : "Share model access with individual people. Files and commands execute on their own Source computer.",
    owned: zh ? "我分享的" : "Shared by me", received: zh ? "收到的" : "Received", refresh: zh ? "刷新" : "Refresh",
    loading: zh ? "正在读取分享…" : "Loading shares…", unknown: zh ? "尚未确认结果。刷新查询原操作后再继续。" : "The outcome is unconfirmed. Refresh the original operation before continuing.",
    name: zh ? "对方看到的姓名" : "Name shown to the other person", provider: zh ? "供应商" : "Provider", createLink: zh ? "生成邀请链接" : "Generate invitation link",
    enableRemote: zh ? "先在远端 Agent 设置开启整机与对应供应商。" : "Enable this computer and Provider in the remote Agent settings first.",
    privateLink: zh ? "私有邀请链接" : "Private invitation link", linkRule: zh ? "5 分钟内有效，首次提交申请后锁定。请私下发给一人。" : "Valid for five minutes and locked by the first submitted application. Send it privately to one person.",
    expired: zh ? "邀请已过期" : "Invitation expired", copy: zh ? "复制链接" : "Copy link", applying: zh ? "申请使用" : "Applying for access",
    compare: zh ? "通过其他渠道与对方核对四位码一致。" : "Compare these four digits with the other person through another channel.", code: zh ? "核对码" : "Comparison code",
    compared: zh ? "我已与申请人核对一致" : "I compared the digits with the applicant", approve: zh ? "同意" : "Approve", reject: zh ? "拒绝" : "Reject",
    pause: zh ? "暂停" : "Pause", resume: zh ? "恢复" : "Resume", remove: zh ? "撤销并删除成员" : "Revoke and remove member", noMembers: zh ? "尚无申请或成员。" : "No applications or members yet.",
    paste: zh ? "粘贴邀请链接" : "Paste invitation link", preview: zh ? "预览邀请" : "Preview invitation", apply: zh ? "提交申请" : "Submit application",
    applicationRule: zh ? "提交后链接立即锁定。申请保留 24 小时，须经发行者对码并同意。" : "Submitting immediately locks the link. The application lasts 24 hours and requires the issuer to compare the digits and approve.",
    withdraw: zh ? "撤回申请" : "Withdraw application", leave: zh ? "退出分享" : "Leave share",
    from: (name: string, node: string) => zh ? `来自 ${name} · ${node}` : `From ${name} · ${node}`,
    reshare: (member: string, recipient: string) => zh ? `${member} 希望再分享给 ${recipient}` : `${member} wants to share with ${recipient}`,
    models: (count: number) => zh ? `${count} 个可用模型，可在任务模型来源中选择。` : `${count} models available in the task model sources.`,
    state: (state: string) => (zh ? ({ active: "可用", unavailable: "暂时不可用", paused: "已暂停", removed: "已撤销", left: "已退出", pending: "待同意", approved: "已同意", rejected: "已拒绝", withdrawn: "已撤回", expired: "已过期", unknown: "结果未知", not_submitted: "未提交", unused: "可申请", used: "已使用", prepared: "准备中", sent: "已提交" } as Record<string, string>)
      : ({ active: "Available", unavailable: "Temporarily unavailable", paused: "Paused", removed: "Revoked", left: "Left", pending: "Pending", approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn", expired: "Expired", unknown: "Unknown outcome", not_submitted: "Not submitted", unused: "Available to apply", used: "Used", prepared: "Preparing", sent: "Submitted" } as Record<string, string>))[state] ?? state
  };
}

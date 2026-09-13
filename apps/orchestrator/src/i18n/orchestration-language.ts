export const REMOTE_HOST_POLICY_LOCALIZATIONS = {
  "zh-CN": {
    displayName: "远程主机",
    description: "检查已配置的远程主机，并运行经过批准的命令。"
  }
};

export const COLLABORATION_POLICY_LOCALIZATIONS = {
  "zh-CN": {
    displayName: "协同",
    description: "委派后台工作，并与其他任务协同。"
  }
};

export const MEMORY_SAVE_REQUEST_PREFIXES = ["Save in memory:", "记到 memory:"] as const;

export function reviewTitlePrefix(locale: string): string {
  return locale.toLowerCase().startsWith("zh") ? "审查 · " : "Review · ";
}

export function hasGeneratedLineLabel(value: string): boolean {
  return /^(?:title|summary|user|assistant|system|标题|摘要)\s*[:：]/iu.test(value);
}

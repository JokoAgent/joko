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

export const CONTACT_TOOL_POLICY_LOCALIZATIONS = {
  "zh-CN": {
    displayName: "通讯录",
    description: "允许受信任任务搜索并维护本地通讯录。"
  },
  "zh-TW": {
    displayName: "通訊錄",
    description: "允許受信任工作搜尋並維護本機通訊錄。"
  },
  ja: {
    displayName: "連絡先",
    description: "信頼済みタスクによるローカル連絡先の検索と管理を許可します。"
  },
  ko: {
    displayName: "연락처",
    description: "신뢰할 수 있는 작업이 로컬 연락처를 검색하고 관리하도록 허용합니다."
  }
};

export const MEMORY_SAVE_REQUEST_PREFIXES = ["Save in memory:", "记到 memory:"] as const;

export function reviewTitlePrefix(locale: string): string {
  return locale.toLowerCase().startsWith("zh") ? "审查 · " : "Review · ";
}

export function hasGeneratedLineLabel(value: string): boolean {
  return /^(?:title|summary|user|assistant|system|标题|摘要)\s*[:：]/iu.test(value);
}

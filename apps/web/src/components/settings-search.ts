import { translate, type MessageKey } from "../i18n.js";
import type { SettingsSection, SettingsSubsection } from "./SettingsPage.js";
import type { Translator } from "./types.js";

export interface SettingsSearchEntry {
  readonly id: string;
  readonly section: SettingsSection;
  readonly subsection?: SettingsSubsection;
  readonly titleKey: MessageKey;
  readonly sectionKey: MessageKey;
  readonly targetId?: string;
  readonly fallbackTargetId: string;
  readonly aliases?: readonly string[];
  readonly capability?: string;
  readonly providerView?: "credentials" | "usage";
}

export interface SettingsSearchDocument {
  readonly entry: SettingsSearchEntry;
  readonly title: string;
  readonly section: string;
  readonly category: string;
  readonly searchText: string;
}

export interface SettingsSearchContext {
  readonly visibleSections: readonly SettingsSection[];
  readonly desktopCapabilities: readonly string[];
}

const CATEGORY_KEYS: Readonly<Record<SettingsSection, MessageKey>> = {
  sharing: "taskSharing.title",
  general: "settings.general", personalization: "settings.personalization", providers: "settings.providers",
  voice: "settings.voiceInput", shortcuts: "settings.shortcuts", taskStatus: "settings.nativeTaskStatus.title",
  import: "portable.importTitle", contacts: "contacts.title", messaging: "settings.messaging",
  connections: "settings.connections", tools: "settings.toolPolicies.nav", automation: "settings.automation", about: "settings.about"
};

function group(
  section: SettingsSection,
  sectionKey: MessageKey,
  keys: readonly MessageKey[],
  options: { readonly subsection?: SettingsSubsection; readonly capability?: string; readonly aliases?: readonly string[] } = {}
): SettingsSearchEntry[] {
  return keys.map((titleKey) => ({
    id: `${section}.${titleKey}`, section, sectionKey, titleKey,
    fallbackTargetId: `settings-subsection-${options.subsection ?? section}`,
    ...options,
    aliases: titleKey === sectionKey ? options.aliases : undefined
  }));
}

/** Labels and destinations only: indexing never mounts another page or reads setting values. */
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  { id: "about.personalDevelopment", section: "about", subsection: "personalDevelopment", titleKey: "personalDevelopment.title", sectionKey: "settings.about", targetId: "personal-development-title", fallbackTargetId: "settings-subsection-personalDevelopment", capability: "development.personal", aliases: ["source", "personal", "build", "源码", "个人版本", "构建"] },
  { id: "about.worktreeRecycle", section: "about", subsection: "worktreeRecycle", titleKey: "worktreeRecycle.title", sectionKey: "settings.about", targetId: "worktree-recycle-title", fallbackTargetId: "settings-subsection-worktreeRecycle", aliases: ["worktree", "cleanup", "recovery", "回收", "工作树"] },
  ...Object.entries(CATEGORY_KEYS).map(([section, titleKey]) => ({
    id: section, section: section as SettingsSection, titleKey, sectionKey: titleKey,
    targetId: `settings-panel-${section}`, fallbackTargetId: `settings-panel-${section}`
  })),
  ...group("general", "settings.appearance", [
    "settings.appearance", "settings.theme", "settings.locale", "settings.appearance.fonts",
    "settings.appearance.uiFamily", "settings.appearance.uiSize", "settings.appearance.codeFamily", "settings.appearance.codeSize",
    "settings.layoutResetTitle"
  ], { subsection: "appearance", aliases: ["appearance", "theme", "font", "language", "外观", "主题", "字体", "语言"] }),
  ...group("general", "settings.appearance", ["settings.wallpaper.title"], { subsection: "appearance", capability: "appearance.wallpaper" }),
  ...group("general", "settings.applicationBehavior", [
    "settings.applicationBehavior", "settings.sessionNotifications", "settings.keepAwake", "settings.sendShortcut",
    "settings.agentResource.title", "settings.agentResource.preset", "settings.agentResource.maxConcurrent",
    "settings.agentResource.priority", "settings.agentResource.capThreads", "settings.collaboration.title",
    "settings.collaboration.workerSoftLimit", "settings.collaboration.workerHardLimit", "settings.collaboration.idleRelease",
    "settings.gitSafety.title", "settings.gitSafety.autoSnapshotTitle", "settings.languageTools.title"
  ], { aliases: ["notification", "awake", "concurrency", "worker", "git", "lsp", "通知", "休眠", "并发"] }),
  ...group("general", "settings.applicationBehavior", ["settings.activationClick"], { capability: "window.activationClick" }),
  ...group("general", "settings.applicationBehavior", ["desktopClose.title"], { capability: "window.mainCloseBehavior" }),
  ...group("general", "settings.policy", [
    "settings.policy", "settings.requireTrust", "settings.redactCredentials", "settings.stripCredentials", "settings.projectTrust"
  ], { subsection: "policy", aliases: ["trust", "credential", "security", "权限", "信任", "凭据"] }),
  ...group("general", "settings.pi", [
    "settings.pi", "settings.autoCompaction", "settings.autoRetry", "settings.steeringQueue", "settings.followUpQueue",
    "settings.managedResources", "settings.addResource"
  ], { subsection: "pi", aliases: ["extension", "package", "skill", "resource", "扩展", "技能", "资源"] }),
  ...group("personalization", "settings.personalization", [
    "settings.personalization.promptSubtitle", "settings.memory.title", "settings.memory.makerLabel", "settings.subagentModels.title",
    "settings.subagentModels.smartRouting", "settings.auxiliaryText.title", "settings.auxiliaryText.mode",
    "settings.visionBridge.title", "settings.visionBridge.enableLabel", "settings.visionBridge.targetModels.label",
    "settings.visionBridge.backends.label", "settings.compaction.title", "settings.linkOpen.title", "terminal.defaultShell",
    "settings.streamFade.title", "settings.tips", "settings.chatEmbedding.label", "settings.messageNavRail.label"
  ], { aliases: ["instructions", "prompt", "memory", "subagent", "vision", "compaction", "terminal", "shell", "link", "记忆", "指令", "提示词", "子任务", "终端"] }),
  ...group("providers", "settings.providers", ["settings.modelCatalog", "settings.modelsShownInPicker", "settings.addProvider"], { aliases: ["model", "provider", "api", "模型", "供应商"] }),
  { id: "providers.credentials", section: "providers", subsection: "credentials", titleKey: "settings.credentials", sectionKey: "settings.providers", fallbackTargetId: "settings-subsection-providers", providerView: "credentials", aliases: ["credential", "api key", "secret", "凭据", "密钥"] },
  { id: "providers.usage", section: "providers", titleKey: "usage.title", sectionKey: "settings.providers", fallbackTargetId: "settings-subsection-providers", providerView: "usage", aliases: ["tokens", "cost", "history", "用量", "费用"] },
  ...group("voice", "settings.voiceInput", [
    "settings.voiceInputService", "settings.voiceInputServiceEnabled", "settings.voiceInputServiceProtocol",
    "settings.voiceInputServiceEndpoint", "settings.voiceInputServiceResourceId", "settings.voiceInputServiceModel",
    "settings.voiceInputServiceKeyless", "settings.voiceInputFallbackEnabled", "settings.voiceInputFallbackProtocol",
    "settings.voiceInputFallbackEndpoint", "settings.voiceInputFallbackResourceId", "settings.voiceInputFallbackModel",
    "settings.voiceInputFallbackKeyless", "settings.voiceInputRefinementEnabled", "settings.voiceInputRefinementModel",
    "settings.voiceInputRefinementFallbackModel", "settings.voiceInputPermission", "settings.voiceInputLocale",
    "settings.voiceInputDevice", "settings.voiceInputShortcut", "settings.voiceInputInteractionSound",
    "settings.voiceInputMuteSystemAudio", "settings.voiceInputFastActivation", "settings.voiceInputRecognitionContext",
    "settings.voiceInputRefinementInstructions", "settings.voiceInputAutoDictionary", "settings.voiceInputDictionarySync",
    "settings.voiceInputDictionary", "settings.voiceInputUsage"
  ], { aliases: ["voice", "microphone", "asr", "transcription", "dictation", "dictionary", "语音", "麦克风", "转写", "词典"] }),
  ...group("shortcuts", "settings.shortcuts", [
    "settings.shortcuts.title", "settings.gamepad.title", "settings.gamepad.enable", "settings.gamepad.buttons", "settings.gamepad.stickMode"
  ], { aliases: ["keyboard", "shortcut", "gamepad", "controller", "快捷键", "键盘", "手柄"] }),
  ...group("shortcuts", "settings.shortcuts", ["settings.dedicatedHardware.title"], { capability: "hardware.dedicatedInput", aliases: ["hardware", "micro", "硬件"] }),
  ...group("taskStatus", "settings.nativeTaskStatus.title", [
    "settings.nativeTaskStatus.enabled", "settings.nativeTaskStatus.display", "settings.nativeTaskStatus.layout", "settings.nativeTaskStatus.sounds"
  ]),
  ...group("import", "settings.sessionImport.title", [
    "settings.sessionImport.title", "settings.sessionImport.source", "settings.sessionImport.placement"
  ], { aliases: ["import", "portable", "history", "导入", "历史"] }),
  ...group("contacts", "contacts.title", ["contacts.directory", "contacts.enableDirectory", "contacts.syncTitle", "contacts.syncEnable"], { aliases: ["contact", "organization", "sync", "联系人", "组织", "同步"] }),
  ...group("messaging", "settings.messaging", ["messaging.connections", "messaging.defaultRoute"], { aliases: ["telegram", "slack", "discord", "dingtalk", "feishu", "wecom", "wechat", "消息", "渠道", "钉钉", "飞书", "微信"] }),
  ...group("connections", "settings.connections", ["settings.automaticConnection", "settings.savedClient", "settings.orchestratorDevices", "settings.activeConnections"], { aliases: ["device", "pairing", "connection", "设备", "配对", "连接"] }),
  ...group("connections", "settings.hostedAgents.title", ["settings.hostedAgents.title", "settings.hostedAgents.allow", "settings.hostedAgents.limits", "settings.hostedAgents.perDevice", "settings.hostedAgents.total"], { aliases: ["remote agent", "provider", "quota", "远端", "模型调用", "额度"] }),
  ...group("connections", "settings.remoteDesktop.title", ["settings.remoteDesktop.title", "settings.remoteDesktop.allow", "settings.remoteDesktop.permissions", "settings.remoteDesktop.screenRecording", "settings.remoteDesktop.accessibility"], { subsection: "remoteDesktop", capability: "remote.desktopHost", aliases: ["remote desktop", "screen", "远程桌面", "屏幕"] }),
  ...group("connections", "settings.remoteHosts.title", ["settings.remoteHosts.title", "settings.remoteHosts.autoConnect"], { subsection: "remoteHosts", aliases: ["remote", "ssh", "host", "远端", "主机"] }),
  ...group("connections", "sshKeys.title", ["sshKeys.title", "sshKeys.publicKey", "sshKeys.install"], { aliases: ["ssh key", "public key", "密钥", "公钥"] }),
  ...group("tools", "settings.toolPolicies.title", ["settings.toolPolicies.title", "settings.toolPolicies.scope"], { aliases: ["tool", "policy", "工具", "策略"] }),
  ...group("tools", "settings.mcp", ["settings.mcp", "settings.credentialReferences"], { subsection: "mcp", aliases: ["mcp", "server", "工具服务器"] }),
  ...group("automation", "settings.automation", [
    "settings.automationBrowser", "settings.automationBrowserTarget", "settings.browserProfile", "settings.takeoverTimeout",
    "settings.allowUploads", "settings.allowDownloads", "settings.automationComputer", "settings.automationAccessibility",
    "settings.automationScreenRecording", "settings.automationAndroid", "settings.automationAndroidDevice", "settings.automationAndroidAdb"
  ], { aliases: ["browser", "computer", "android", "automation", "浏览器", "电脑", "安卓", "自动化"] }),
  ...group("about", "settings.about", ["settings.aboutAutoUpdateLabel", "settings.betaChannel.title"], { aliases: ["update", "beta", "version", "更新", "版本"] }),
  ...group("about", "settings.backends", ["settings.backends", "settings.defaultPermission", "settings.planMode"], { subsection: "backends", aliases: ["backend", "runtime", "permission", "执行器", "权限"] }),
  ...group("about", "settings.diagnostics", [
    "settings.diagnostics", "settings.diagnosticLevel", "settings.retention", "settings.performanceMetrics",
    "settings.backendPayloads", "settings.operationalDiagnostics", "settings.taskHistoryTitle", "settings.taskHistoryRetention",
    "settings.taskHistoryIncludeActive", "settings.taskHistoryBackup", "settings.artifactStorageTitle"
  ], { subsection: "diagnostics", aliases: ["diagnostic", "log", "cleanup", "storage", "history", "诊断", "日志", "清理", "存储", "历史"] }),
  ...group("about", "settings.processUsage.title", ["settings.processUsage.title"], { subsection: "runtime", aliases: ["process", "cpu", "ram", "memory usage", "进程", "内存"] })
];

export function normalizeSettingsSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}

export function buildSettingsSearchDocuments(t: Translator, context: SettingsSearchContext): SettingsSearchDocument[] {
  const visible = new Set(context.visibleSections);
  return SETTINGS_SEARCH_ENTRIES.filter((entry) => visible.has(entry.section)
    && (entry.capability === undefined || context.desktopCapabilities.includes(entry.capability))).map((entry) => {
    const title = t(entry.titleKey);
    const section = t(entry.sectionKey);
    const category = t(CATEGORY_KEYS[entry.section]);
    const english = [entry.titleKey, entry.sectionKey, CATEGORY_KEYS[entry.section]].map((key) => translate("en", key));
    const searchText = normalizeSettingsSearchText([title, section, category, ...english, ...(entry.aliases ?? [])]
      .join(" ").replace(/\{[^}]+\}/gu, ""));
    return { entry, title, section, category, searchText };
  });
}

export function searchSettings(documents: readonly SettingsSearchDocument[], query: string): SettingsSearchDocument[] {
  const normalized = normalizeSettingsSearchText(query);
  if (!normalized) return [];
  return documents.map((document, index) => {
    if (!document.searchText.includes(normalized) && !normalized.split(" ").every((token) => document.searchText.includes(token))) return null;
    const title = normalizeSettingsSearchText(document.title);
    let score = 100;
    if (title === normalized) score += 1000;
    else if (title.startsWith(normalized)) score += 700;
    else if (title.includes(normalized)) score += 500;
    if (normalizeSettingsSearchText(document.section).includes(normalized)) score += 300;
    if (normalizeSettingsSearchText(document.category).includes(normalized)) score += 100;
    return { document, index, score };
  }).filter((match): match is { document: SettingsSearchDocument; index: number; score: number } => match !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index).map((match) => match.document);
}

export function settingsSearchHash(entry: SettingsSearchEntry): string {
  return `#/settings/${entry.section}${entry.subsection === undefined ? "" : `/${entry.subsection}`}?search=${encodeURIComponent(entry.id)}`;
}

/** Only the current catalog's exact entry identity is a navigation target. */
export function settingsSearchEntryFromHash(
  hash: string, section: SettingsSection, subsection: SettingsSubsection | undefined, documents: readonly SettingsSearchDocument[]
): SettingsSearchEntry | undefined {
  const query = hash.indexOf("?");
  if (query < 0) return undefined;
  const params = new URLSearchParams(hash.slice(query + 1));
  const ids = params.getAll("search");
  if (ids.length !== 1) return undefined;
  return documents.find(({ entry }) => entry.id === ids[0] && entry.section === section && entry.subsection === subsection)?.entry;
}

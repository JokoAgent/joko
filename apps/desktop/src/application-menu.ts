import type { MenuItemConstructorOptions } from "electron";

import type {
  DesktopApplicationMenuCommand,
  DesktopApplicationMenuConfiguration,
  DesktopApplicationMenuConfigurationPatch
} from "./channels.js";

type ZoomRole = "resetZoom" | "zoomIn" | "zoomOut";

interface ApplicationMenuHost<TMenu> {
  readonly buildFromTemplate: (template: MenuItemConstructorOptions[]) => TMenu;
  readonly setApplicationMenu: (menu: TMenu | null) => void;
}

export interface MacApplicationMenuOptions {
  /** Settings capture must receive menu-backed combinations before macOS. */
  readonly shortcutRecording?: boolean;
  readonly newSessionAccelerator?: string | null;
  readonly openSettingsAccelerator?: string | null;
  /** Display-only: Toggle Sidebar remains owned by the renderer key handler. */
  readonly toggleSidebarAccelerator?: string | null;
  readonly onCommand?: (command: DesktopApplicationMenuCommand) => void;
  /** Main supplies Electron's native localized role label. */
  readonly roleLabel?: (role: ZoomRole) => string;
  readonly appName?: string;
}

/**
 * The macOS View menu keeps zoom persistent by dispatching an application
 * command instead of using Electron's transient page-zoom roles. Toggle
 * Sidebar displays its shortcut but deliberately leaves registration to the
 * renderer so editable surfaces and shortcut capture retain first refusal.
 */
export function buildMacApplicationMenuTemplate(
  platform: NodeJS.Platform,
  locale = "en",
  isPackaged = true,
  options: MacApplicationMenuOptions = {}
): MenuItemConstructorOptions[] | undefined {
  if (platform !== "darwin") return undefined;

  const registerAccelerator = options.shortcutRecording !== true;
  const dispatch = (command: DesktopApplicationMenuCommand): void => options.onCommand?.(command);
  const labels = resolveMacApplicationMenuLabels(locale, options.appName ?? "Joko");
  const developmentItems: MenuItemConstructorOptions[] = isPackaged
    ? []
    : [
        { role: "reload", registerAccelerator },
        { role: "forceReload", registerAccelerator },
        { role: "toggleDevTools", registerAccelerator },
        { type: "separator" }
      ];

  return [
    {
      label: options.appName ?? "Joko",
      submenu: [
        { label: labels.about, click: () => dispatch("open-about") },
        { type: "separator" },
        {
          label: labels.settings,
          ...optionalAccelerator(options.openSettingsAccelerator, "Command+,"),
          registerAccelerator,
          click: () => dispatch("open-settings")
        },
        { label: labels.checkForUpdates, click: () => dispatch("check-for-updates") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: labels.hide, registerAccelerator },
        { role: "hideOthers", registerAccelerator },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: labels.quit, registerAccelerator }
      ]
    },
    {
      label: labels.fileMenu,
      submenu: [{
        label: labels.newSession,
        ...optionalAccelerator(options.newSessionAccelerator, "Command+N"),
        registerAccelerator,
        click: () => dispatch("new-session")
      }]
    },
    { role: "editMenu" },
    {
      // Electron's aggregate `viewMenu` role cannot host these custom
      // persistent commands, so keep the localized top-level label explicit.
      label: labels.viewMenu,
      submenu: [
        {
          label: labels.toggleSidebar,
          ...(options.toggleSidebarAccelerator === null
            ? {}
            : { accelerator: options.toggleSidebarAccelerator ?? "Command+B" }),
          registerAccelerator: false,
          click: () => dispatch("toggle-sidebar")
        },
        { type: "separator" },
        ...developmentItems,
        ...persistentZoomMenuItems("resetZoom", "zoom-reset", "CommandOrControl+0", registerAccelerator, options),
        ...persistentZoomMenuItems("zoomIn", "zoom-in", "CommandOrControl+Plus", registerAccelerator, options),
        ...persistentZoomMenuItems("zoomOut", "zoom-out", "CommandOrControl+-", registerAccelerator, options),
        { type: "separator" },
        { role: "togglefullscreen", registerAccelerator }
      ]
    },
    {
      label: labels.windowMenu,
      role: "window",
      submenu: [
        { role: "minimize", registerAccelerator },
        { role: "zoom" },
        { type: "separator" },
        // Renderer owns Cmd+W so an active right-side tab closes before the
        // main window is hidden. Mouse activation still uses the native role.
        { role: "close", registerAccelerator: false }
      ]
    }
  ];
}

export function installMacApplicationMenu<TMenu>(
  platform: NodeJS.Platform,
  host: ApplicationMenuHost<TMenu>,
  locale = "en",
  isPackaged = true,
  options: MacApplicationMenuOptions = {}
): boolean {
  const template = buildMacApplicationMenuTemplate(platform, locale, isPackaged, options);
  if (template === undefined) {
    // Windows/Linux use Joko's renderer chrome; leaving Electron's default
    // menu installed would expose reload/devtools and duplicate shortcuts.
    host.setApplicationMenu(null);
    return false;
  }

  host.setApplicationMenu(host.buildFromTemplate(template));
  return true;
}

export function resolveMacViewMenuLabel(locale: string): string {
  return resolveMacApplicationMenuLabels(locale, "Joko").viewMenu;
}

export function resolveMacToggleSidebarLabel(locale: string): string {
  return resolveMacApplicationMenuLabels(locale, "Joko").toggleSidebar;
}

interface MacApplicationMenuLabels {
  readonly about: string;
  readonly settings: string;
  readonly checkForUpdates: string;
  readonly hide: string;
  readonly quit: string;
  readonly fileMenu: string;
  readonly newSession: string;
  readonly viewMenu: string;
  readonly toggleSidebar: string;
  readonly windowMenu: string;
}

function resolveMacApplicationMenuLabels(locale: string, appName: string): MacApplicationMenuLabels {
  const normalized = normalizeLocale(locale);
  if (normalized === "zh-tw" || normalized === "zh-hk" || normalized === "zh-mo") return {
    about: `關於 ${appName}`, settings: "設定…", checkForUpdates: "檢查更新…",
    hide: `隱藏 ${appName}`, quit: `結束 ${appName}`, fileMenu: "檔案", newSession: "新增任務",
    viewMenu: "顯示方式", toggleSidebar: "切換側邊欄", windowMenu: "視窗"
  };
  if (normalized === "zh" || normalized.startsWith("zh-cn") || normalized.startsWith("zh-hans")) return {
    about: `关于 ${appName}`, settings: "设置…", checkForUpdates: "检查更新…",
    hide: `隐藏 ${appName}`, quit: `退出 ${appName}`, fileMenu: "文件", newSession: "新建任务",
    viewMenu: "显示", toggleSidebar: "切换侧边栏", windowMenu: "窗口"
  };
  if (normalized.startsWith("ja")) return {
    about: `${appName} について`, settings: "設定…", checkForUpdates: "アップデートを確認…",
    hide: `${appName}を隠す`, quit: `${appName}を終了`, fileMenu: "ファイル", newSession: "新規セッション",
    viewMenu: "表示", toggleSidebar: "サイドバーを切り替え", windowMenu: "ウインドウ"
  };
  if (normalized.startsWith("ko")) return {
    about: `${appName} 정보`, settings: "설정…", checkForUpdates: "업데이트 확인…",
    hide: `${appName} 가리기`, quit: `${appName} 종료`, fileMenu: "파일", newSession: "새 세션",
    viewMenu: "보기", toggleSidebar: "사이드바 토글", windowMenu: "윈도우"
  };
  return {
    about: `About ${appName}`, settings: "Settings…", checkForUpdates: "Check for Updates…",
    hide: `Hide ${appName}`, quit: `Quit ${appName}`, fileMenu: "File", newSession: "New Session",
    viewMenu: "View", toggleSidebar: "Toggle Sidebar", windowMenu: "Window"
  };
}

function optionalAccelerator(value: string | null | undefined, fallback: string): { readonly accelerator?: string } {
  return value === null ? {} : { accelerator: value ?? fallback };
}

const CONFIGURABLE_ACCELERATOR_MODIFIERS = ["Ctrl", "Alt", "Shift", "Command"] as const;
const CONFIGURABLE_ACCELERATOR_NAMED_KEYS = new Set([
  "Space", "Tab", "Enter", "Esc", "Backspace", "Delete", "Home", "End",
  "PageUp", "PageDown", "Up", "Down", "Left", "Right"
]);
const SHIFT_ONLY_CONFIGURABLE_KEYS = new Set([
  "Tab", "Home", "End", "PageUp", "PageDown", "Up", "Down", "Left", "Right"
]);

/** Strict inverse of Web's Darwin combo converter for menu-owned shortcuts. */
export function isSafeMacApplicationMenuAccelerator(value: string): boolean {
  if (value.length === 0 || value.length > 96 || /[^\x20-\x7e]/u.test(value)) return false;
  const parts = value.split("+");
  if (parts.some((part) => part.length === 0)) return false;
  const key = parts.at(-1);
  if (key === undefined || !isConfigurableAcceleratorKey(key)) return false;
  const modifiers = parts.slice(0, -1);
  let previousIndex = -1;
  for (const modifier of modifiers) {
    const index = CONFIGURABLE_ACCELERATOR_MODIFIERS.indexOf(
      modifier as (typeof CONFIGURABLE_ACCELERATOR_MODIFIERS)[number]
    );
    if (index <= previousIndex) return false;
    previousIndex = index;
  }
  const strongModifier = modifiers.includes("Ctrl") || modifiers.includes("Alt") || modifiers.includes("Command");
  if (strongModifier) return true;
  if (modifiers.length === 0) return isFunctionKey(key);
  return modifiers.length === 1 && modifiers[0] === "Shift"
    && (SHIFT_ONLY_CONFIGURABLE_KEYS.has(key) || isFunctionKey(key));
}

const APPLICATION_MENU_CONFIGURATION_KEYS = new Set([
  "shortcutRecording", "newSessionAccelerator", "openSettingsAccelerator", "toggleSidebarAccelerator"
]);
const APPLICATION_MENU_ACCELERATOR_KEYS = [
  "newSessionAccelerator", "openSettingsAccelerator", "toggleSidebarAccelerator"
] as const;

export function parseMacApplicationMenuConfigurationPatch(
  value: unknown
): DesktopApplicationMenuConfigurationPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Application-menu configuration patch must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.some((key) => !APPLICATION_MENU_CONFIGURATION_KEYS.has(key))) {
    throw new TypeError("Application-menu configuration patch contains unsupported keys.");
  }
  const patch: {
    shortcutRecording?: boolean;
    newSessionAccelerator?: string | null;
    openSettingsAccelerator?: string | null;
    toggleSidebarAccelerator?: string | null;
  } = {};
  if (Object.hasOwn(record, "shortcutRecording")) {
    if (typeof record["shortcutRecording"] !== "boolean") {
      throw new TypeError("Application-menu recording state must be boolean.");
    }
    patch.shortcutRecording = record["shortcutRecording"];
  }
  for (const key of APPLICATION_MENU_ACCELERATOR_KEYS) {
    if (!Object.hasOwn(record, key)) continue;
    const accelerator = record[key];
    if (!(accelerator === null
      || typeof accelerator === "string" && isSafeMacApplicationMenuAccelerator(accelerator))) {
      throw new TypeError(`Application-menu ${key} is invalid.`);
    }
    patch[key] = accelerator;
  }
  return patch;
}

export interface MacApplicationMenuConfigurationState {
  readonly snapshot: () => {
    readonly configuration: DesktopApplicationMenuConfiguration;
    readonly ready: boolean;
  };
  readonly apply: (patch: DesktopApplicationMenuConfigurationPatch) => {
    readonly menuChanged: boolean;
    readonly commands: readonly DesktopApplicationMenuCommand[];
  };
  readonly resetForRendererLoad: () => boolean;
  readonly acceptCommand: (command: DesktopApplicationMenuCommand) => readonly DesktopApplicationMenuCommand[];
}

export interface ApplicationMenuShortcutRecordingLeaseSnapshot {
  readonly wasActive: boolean;
  readonly active: boolean;
}

/** Aggregates independent renderer recording lifetimes into one process-wide menu state. */
export class ApplicationMenuShortcutRecordingLeases<Owner> {
  readonly #owners = new Set<Owner>();

  set(owner: Owner, recording: boolean): ApplicationMenuShortcutRecordingLeaseSnapshot {
    const wasActive = this.#owners.size > 0;
    if (recording) this.#owners.add(owner);
    else this.#owners.delete(owner);
    return { wasActive, active: this.#owners.size > 0 };
  }

  active(): boolean {
    return this.#owners.size > 0;
  }
}

/** Runtime fence preventing stale defaults from firing before Web preference sync. */
export function createMacApplicationMenuConfigurationState(
  initial: DesktopApplicationMenuConfiguration
): MacApplicationMenuConfigurationState {
  let configuration = initial;
  let ready = false;
  const pendingCommands: DesktopApplicationMenuCommand[] = [];
  return {
    snapshot: () => ({ configuration, ready }),
    apply: (patch) => {
      const next = { ...configuration, ...patch };
      const becameReady = !ready && APPLICATION_MENU_ACCELERATOR_KEYS.every((key) => Object.hasOwn(patch, key));
      const menuChanged = becameReady || !applicationMenuConfigurationsEqual(next, configuration);
      configuration = next;
      if (becameReady) ready = true;
      return {
        menuChanged,
        commands: becameReady ? pendingCommands.splice(0) : []
      };
    },
    resetForRendererLoad: () => {
      if (!configuration.shortcutRecording && !ready) return false;
      configuration = { ...configuration, shortcutRecording: false };
      ready = false;
      return true;
    },
    acceptCommand: (command) => {
      if (ready) return [command];
      if (pendingCommands.length === 32) pendingCommands.shift();
      pendingCommands.push(command);
      return [];
    }
  };
}

function applicationMenuConfigurationsEqual(
  left: DesktopApplicationMenuConfiguration,
  right: DesktopApplicationMenuConfiguration
): boolean {
  return left.shortcutRecording === right.shortcutRecording
    && left.newSessionAccelerator === right.newSessionAccelerator
    && left.openSettingsAccelerator === right.openSettingsAccelerator
    && left.toggleSidebarAccelerator === right.toggleSidebarAccelerator;
}

function isConfigurableAcceleratorKey(value: string): boolean {
  return /^[A-Z0-9]$/u.test(value)
    || isFunctionKey(value)
    || CONFIGURABLE_ACCELERATOR_NAMED_KEYS.has(value)
    || value.length === 1 && ",.;'/\\[]`-=".includes(value);
}

function isFunctionKey(value: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/u.test(value);
}

function persistentZoomMenuItems(
  role: ZoomRole,
  command: Extract<DesktopApplicationMenuCommand, "zoom-reset" | "zoom-in" | "zoom-out">,
  accelerator: string,
  registerAccelerator: boolean,
  options: MacApplicationMenuOptions
): MenuItemConstructorOptions[] {
  const item: MenuItemConstructorOptions = {
    label: options.roleLabel?.(role) ?? role,
    accelerator,
    registerAccelerator,
    click: () => options.onCommand?.(command)
  };
  if (role !== "zoomIn") return [item];
  return [
    item,
    {
      ...item,
      id: "persisted-page-zoom-in-unshifted",
      accelerator: "CommandOrControl+=",
      visible: false,
      acceleratorWorksWhenHidden: true
    }
  ];
}

function normalizeLocale(locale: string): string {
  return locale.toLowerCase().replaceAll("_", "-");
}

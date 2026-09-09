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

export function resolveMacApplicationMenuLabels(locale: string, appName: string): MacApplicationMenuLabels {
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

function normalizeLocale(locale: string): string {
  return locale.toLowerCase().replaceAll("_", "-");
}

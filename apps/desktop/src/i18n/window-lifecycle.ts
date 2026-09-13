export function desktopMainWindowCloseLabels(locale: string): {
  title: string; message: string; detail: string; tray: string; minimize: string; quit: string; cancel: string; failure: string;
} {
  return locale.toLowerCase().startsWith("zh") ? {
    title: "Joko", message: "关闭主窗口时要执行什么操作？", detail: "选择会保存在此设备上，可在通用设置中更改。",
    tray: "收起到托盘", minimize: "最小化窗口", quit: "退出 Joko", cancel: "取消", failure: "无法保存或应用关闭设置。窗口将保持打开，请重试。"
  } : {
    title: "Joko", message: "What should happen when you close the main window?", detail: "Your choice is saved on this device. Change it in General settings.",
    tray: "Keep running in tray", minimize: "Minimize window", quit: "Quit Joko", cancel: "Cancel", failure: "The close setting could not be saved or applied. The window will stay open. Please try again."
  };
}

export function desktopWindowLoadFailureLabels(
  locale: string,
  kind: "main" | "session" | "runtime",
  attempt: number
): { title: string; message: string; attemptDetail: string; buttons: string[] } {
  const chinese = locale.toLowerCase().startsWith("zh");
  const main = kind === "main";
  const runtime = kind === "runtime";
  return {
    title: chinese
      ? main ? "Joko 无法启动" : runtime ? "Joko 无法打开运行时资源用量" : "Joko 无法打开任务窗口"
      : main ? "Joko could not start" : runtime ? "Joko could not open runtime resource usage" : "Joko could not open the task window",
    message: chinese
      ? main ? "Joko 用户界面无法加载。" : runtime ? "运行时资源用量无法加载。" : "任务窗口无法加载。"
      : main ? "The Joko user interface could not be loaded." : runtime ? "Runtime resource usage could not be loaded." : "The task window could not be loaded.",
    attemptDetail: attempt > 1
      ? chinese ? `\n\n第 ${attempt} 次加载失败。` : `\n\nLoad attempt ${attempt} failed.`
      : "",
    buttons: chinese ? ["重试", main ? "退出" : "关闭"] : ["Retry", main ? "Quit" : "Close"]
  };
}

export function desktopRuntimeResourceWindowTitle(locale: string): string {
  return locale.toLowerCase().startsWith("zh")
    ? "Joko · 运行时资源用量"
    : "Joko · Runtime resource usage";
}

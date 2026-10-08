export interface DesktopTrayMenuLabels {
  readonly open: string;
  readonly quit: string;
}

export interface DesktopRemoteDesktopTrayLabels {
  readonly allow: string;
  readonly viewing: string;
  readonly controlling: string;
  readonly disconnect: string;
}

export function resolveDesktopRemoteDesktopTrayLabels(
  locale: string
): DesktopRemoteDesktopTrayLabels {
  const normalized = locale.trim().toLowerCase();
  const labels = normalized === "zh" || normalized.startsWith("zh-cn") || normalized.startsWith("zh-hans")
    ? {
        allow: "允许远程桌面",
        viewing: "远程桌面：正在查看",
        controlling: "远程桌面：正在控制",
        disconnect: "断开远程桌面"
      }
    : {
        allow: "Allow Remote Desktop",
        viewing: "Remote Desktop: Viewing",
        controlling: "Remote Desktop: Controlling",
        disconnect: "Disconnect Remote Desktop"
      };
  return normalized === "en-xa"
    ? {
        allow: pseudoLocalizeTrayLabel(labels.allow),
        viewing: pseudoLocalizeTrayLabel(labels.viewing),
        controlling: pseudoLocalizeTrayLabel(labels.controlling),
        disconnect: pseudoLocalizeTrayLabel(labels.disconnect)
      }
    : labels;
}

export function resolveDesktopTrayMenuLabels(
  locale: string,
  managesLocalOrchestrator: boolean
): DesktopTrayMenuLabels {
  const normalized = locale.trim().toLowerCase();
  const labels = normalized === "zh" || normalized.startsWith("zh-cn") || normalized.startsWith("zh-hans")
    ? {
        open: "打开 Joko",
        quit: managesLocalOrchestrator ? "退出 Joko 和本地 Orchestrator" : "退出 Joko"
      }
    : {
        open: "Open Joko",
        quit: managesLocalOrchestrator ? "Quit Joko and local Orchestrator" : "Quit Joko"
      };
  return normalized === "en-xa"
    ? { open: pseudoLocalizeTrayLabel(labels.open), quit: pseudoLocalizeTrayLabel(labels.quit) }
    : labels;
}

function pseudoLocalizeTrayLabel(value: string): string {
  const accents: Readonly<Record<string, string>> = {
    a: "à", e: "ë", i: "ï", o: "õ", u: "ü",
    A: "Â", E: "Ë", I: "Ï", O: "Ö", U: "Û"
  };
  return `［${[...value].map((character) => accents[character] ?? character).join("")}··］`;
}

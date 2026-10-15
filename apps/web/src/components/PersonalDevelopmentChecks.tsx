import type { JSX } from "react";
import type { PersonalDevelopmentToolCheck } from "@joko/contracts";
import type { Translator } from "./types.js";
import { Button } from "./ui.js";

export function PersonalDevelopmentChecks({ checks, t, openHttpLink }: {
  readonly checks: readonly PersonalDevelopmentToolCheck[]; readonly t: Translator;
  readonly openHttpLink?: (url: string) => Promise<unknown>;
}): JSX.Element {
  return <ul className="personal-development-checks">{checks.map(check => {
    const label = check.id === "node" ? "Node.js" : check.id === "gitLfs" ? "Git LFS" : check.id === "platform" ? t("personalDevelopment.platform")
      : check.id === "native" ? t("personalDevelopment.nativeTools") : check.id === "storage" ? t("personalDevelopment.storage") : check.id;
    const status = check.status === "ready" ? "ready" : check.status === "missing" ? "missing" : check.status === "unsupported" ? "unsupported"
      : ["checking", "pending"].includes(check.status) ? "checking" : ["downloading", "verifying", "extracting"].includes(check.status) ? "preparing" : "failed";
    const guide = check.status === "ready" ? undefined : ["nativeWindows", "nativeWindowsRust"].includes(check.reason)
      ? { message: "nativeWindows", url: "https://visualstudio.microsoft.com/visual-cpp-build-tools/" }
      : check.reason === "nativeMac" ? { message: "nativeMac", url: "https://developer.apple.com/xcode/resources/", command: "xcode-select --install" }
      : check.reason === "nativeLinux" ? { message: "nativeLinux" as const, url: "https://github.com/nodejs/node-gyp#on-unix", command: "Debian / Ubuntu: sudo apt install git build-essential\nFedora: sudo dnf install git gcc-c++ make\nArch: sudo pacman -S git base-devel" }
          : undefined;
    const needsRust = ["nativeRust", "nativeWindowsRust"].includes(check.reason);
    return <li key={check.id}><div className="personal-development-check-row"><span>{label}</span><span>{check.version || t(check.status === "warning" ? "personalDevelopment.warning" : `personalDevelopment.status.${status}`)}
      {check.source === "system" || check.source === "managed" ? ` · ${t(`personalDevelopment.toolSource.${check.source}`)}` : ""}{check.freeGib > 0 ? ` · ${check.freeGib} GiB` : ""}</span></div>
      {check.progress && <div className="personal-development-progress"><small>{t("personalDevelopment.downloadBytes", { loaded: mebibytes(check.progress.loaded), total: check.progress.total === undefined ? "?" : mebibytes(check.progress.total) })}{check.progress.percent === undefined ? "" : ` · ${Math.round(check.progress.percent)}%`}</small>{check.progress.percent !== undefined && <progress value={Math.min(100, Math.max(0, check.progress.percent))} max={100} aria-label={label} />}</div>}
      {guide && <div className="personal-development-guidance"><p>{t(`personalDevelopment.${guide.message}` as "personalDevelopment.nativeWindows" | "personalDevelopment.nativeMac" | "personalDevelopment.nativeLinux")}</p>{guide.command && <code>{guide.command}</code>}{openHttpLink && <Button onClick={() => { void openHttpLink(guide.url); }}>{t("personalDevelopment.installGuide")}</Button>}</div>}
      {needsRust && <div className="personal-development-guidance"><p>{t("personalDevelopment.nativeRust")}</p>{openHttpLink && <Button onClick={() => { void openHttpLink("https://www.rust-lang.org/tools/install"); }}>{t("personalDevelopment.installGuide")}</Button>}</div>}
    </li>;
  })}</ul>;
}

function mebibytes(bytes: bigint): string { return (Number(bytes) / 1_048_576).toFixed(1); }

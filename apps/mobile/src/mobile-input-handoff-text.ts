import type { MobileSupportedLocale } from "./mobile-locale-preference";

const en = {
  title: "Your input is needed", open: "Fill on this device", qrOpen: "View sign-in QR code", close: "Close", cancel: "Cancel input", done: "Already done", openTask: "Open task",
  refresh: "Refresh step", claim: "Take over on this device", stay: "Keep waiting", held: "Another device is filling this step. You can take over.", showPassword: "Show password", hidePassword: "Hide password",
  reading: "Reading window", ready: "Waiting for your input", working: "Entering input", finishing: "Returning control in {seconds}s", succeeded: "Completed",
  cancelled: "Cancelled", failed: "Failed", expired: "Expired", unavailable: "Input requests are temporarily unavailable.",
  changed: "This step changed. Refresh it and enter your input again.", unknown: "The result could not be confirmed. Refresh the step before continuing.",
  pictureLoading: "Reading this window…", pictureFailed: "The window could not be read. Refresh the step and try again.", picture: "Use window picture",
  form: "Return to form", fill: "Enter only", submit: "Fill and continue", enter: "Enter and press Return", password: "Password", code: "Verification code", field: "Input",
  filled: "This field already has text. Leave it empty to keep it.", agent: "Agent note", requester: "Requested by", privacy: "Your input goes only to the execution computer's private input channel.",
  scanned: "The QR code has gone away. Waiting for sign-in to finish.", openLink: "Open on this device", copyText: "Copy QR content", copyImage: "Copy QR image",
  copyCode: "Copy code", copied: "Copied.", copyFailed: "Copy did not finish.", pictureLabel: "Current target window", qrLabel: "Current sign-in QR code",
  insecure: "This page is not using HTTPS.", "ip-address": "This page uses an IP address.", "local-host": "This page is on the execution computer.",
  "local-file": "This is a local file.", punycode: "Check the internationalized domain carefully.", "embedded-frame": "This form is in an embedded frame.",
  permission: "Permission to read or enter input is unavailable.", target_gone: "The target window closed.", unreadable: "This page cannot be read.", action_failed: "Input could not be entered.",
  timeout: "The request timed out.", unsupported: "This execution computer does not support input handoff.", origin_changed: "The page changed. Your input was not entered.",
  picture_unavailable: "This window picture is unavailable.", nothing_to_fill: "There are no text fields to fill.", screen_locked: "Unlock the execution computer to continue."
};
const zh: typeof en = {
  title: "需要你代为输入", open: "在此设备填写", qrOpen: "查看登录二维码", close: "关闭", cancel: "取消代填", done: "已完成", openTask: "打开任务",
  refresh: "刷新步骤", claim: "在此设备接管", stay: "继续等待", held: "另一台设备正在填写，你可以接管此步骤。", showPassword: "显示密码", hidePassword: "隐藏密码",
  reading: "正在读取窗口", ready: "等待你填写", working: "正在输入", finishing: "即将交还 · {seconds} 秒", succeeded: "已完成", cancelled: "已取消", failed: "未完成", expired: "已过期",
  unavailable: "代填状态暂时不可用。", changed: "此步骤已变化，请刷新后重新填写。", unknown: "无法确认提交结果，请刷新当前步骤后继续。",
  pictureLoading: "正在读取当前窗口…", pictureFailed: "无法读取当前窗口，请刷新步骤后再试。", picture: "改用窗口画面", form: "返回表单", fill: "只输入",
  submit: "填写并继续", enter: "输入并回车", password: "密码", code: "验证码", field: "输入内容", filled: "此字段已填写，留空可保留原内容。",
  agent: "Agent 说明", requester: "来自", privacy: "填写内容只交给执行电脑的私密输入通道。", scanned: "二维码已离开，正在等待登录完成。",
  openLink: "在此设备打开", copyText: "复制二维码内容", copyImage: "复制二维码图片", copyCode: "复制代码", copied: "已复制。", copyFailed: "复制未完成。",
  pictureLabel: "当前目标窗口", qrLabel: "当前登录二维码", insecure: "此页面未使用 HTTPS。", "ip-address": "此页面使用 IP 地址。", "local-host": "此页面位于执行电脑本机。",
  "local-file": "这是本地文件。", punycode: "请仔细核对国际化域名。", "embedded-frame": "此表单位于嵌入页面。", permission: "尚未取得读取或输入权限。",
  target_gone: "目标窗口已关闭。", unreadable: "无法读取此页面。", action_failed: "未能输入。", timeout: "请求已超时。", unsupported: "此执行电脑不支持输入代填。",
  origin_changed: "页面已变化，未输入你的内容。", picture_unavailable: "无法读取此窗口画面。", nothing_to_fill: "页面没有需要填写的文本字段。", screen_locked: "请先解锁执行电脑。"
};
export function mobileInputHandoffText(locale: MobileSupportedLocale, key: keyof typeof en): string {
  return (locale.startsWith("zh") ? zh : en)[key];
}

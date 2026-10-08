import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileRemoteDesktopNotice, MobileRemoteDesktopSnapshot } from "./remote-desktop-controller";
import type { Session, Target } from "@joko/contracts";

interface MobileRemoteDesktopCopy {
  readonly title: string;
  readonly back: string;
  readonly chooseDesktop: string;
  readonly chooseDisplay: string;
  readonly view: string;
  readonly control: string;
  readonly touch: string;
  readonly trackpad: string;
  readonly pan: string;
  readonly keyboard: string;
  readonly fit: string;
  readonly left: string;
  readonly right: string;
  readonly release: string;
  readonly retry: string;
  readonly takeover: string;
  readonly permissionGuide: string;
  readonly connecting: string;
  readonly reconnecting: string;
  readonly offline: string;
  readonly unsupported: string;
  readonly permission: string;
  readonly revoked: string;
  readonly busy: string;
  readonly stopped: string;
  readonly error: string;
  readonly rtc: string;
  readonly jpeg: string;
  readonly noHosts: string;
  readonly compatibility: string;
  readonly inputOverflow: string;
  readonly viewOnly: string;
  readonly accessibilityPermission: string;
  readonly inputBusy: string;
  readonly inputUnavailable: string;
  readonly viewerRestarted: string;
}

const EN: MobileRemoteDesktopCopy = {
  title: "Remote Desktop", back: "Back", chooseDesktop: "Choose a desktop", chooseDisplay: "Choose a display",
  view: "View", control: "Control", touch: "Touch", trackpad: "Trackpad", pan: "Pan",
  keyboard: "Keyboard", fit: "Fit", left: "Left", right: "Right", release: "Release",
  retry: "Retry", takeover: "Take over", permissionGuide: "Show permission guide",
  connecting: "Connecting…", reconnecting: "Reconnecting — the last frame stays visible.", offline: "Offline",
  unsupported: "Remote Desktop is unavailable.", permission: "Desktop permission is required.",
  revoked: "Remote Desktop access changed.", busy: "This desktop is already in use.",
  stopped: "The desktop stopped this session.", error: "Remote Desktop could not continue.",
  rtc: "Live", jpeg: "Compatibility video", noHosts: "No available desktop supports Remote Desktop.",
  compatibility: "Using compatibility video while the live connection recovers.",
  inputOverflow: "Control was released because the input queue filled.", viewOnly: "This desktop is view-only.",
  accessibilityPermission: "Accessibility permission is required on the desktop for control.",
  inputBusy: "Desktop input is busy. Viewing continues.",
  inputUnavailable: "Desktop control is unavailable. Viewing continues.",
  viewerRestarted: "The viewer restarted safely. Take control again to continue input."
};

const ZH_CN: MobileRemoteDesktopCopy = {
  title: "远程桌面", back: "返回", chooseDesktop: "选择桌面", chooseDisplay: "选择显示器",
  view: "查看", control: "控制", touch: "触控", trackpad: "触控板", pan: "平移",
  keyboard: "键盘", fit: "适合屏幕", left: "左键", right: "右键", release: "释放输入",
  retry: "重试", takeover: "接管", permissionGuide: "显示权限指引",
  connecting: "正在连接…", reconnecting: "正在重新连接，保留最后一帧。", offline: "已离线",
  unsupported: "远程桌面不可用。", permission: "需要桌面权限。", revoked: "远程桌面访问权已变化。",
  busy: "此桌面正在使用中。", stopped: "桌面已停止此会话。", error: "远程桌面无法继续。",
  rtc: "实时", jpeg: "兼容视频", noHosts: "没有可用的桌面支持远程桌面。",
  compatibility: "实时连接恢复期间正在使用兼容视频。", inputOverflow: "输入队列已满，控制已释放。",
  viewOnly: "此桌面仅支持查看。", accessibilityPermission: "控制桌面需要辅助功能权限。",
  inputBusy: "桌面输入正忙，查看仍可继续。", inputUnavailable: "桌面控制不可用，查看仍可继续。",
  viewerRestarted: "查看器已安全重启，请重新取得控制以继续输入。"
};

const ZH_TW: MobileRemoteDesktopCopy = {
  ...ZH_CN, title: "遠端桌面", back: "返回", chooseDesktop: "選擇桌面", chooseDisplay: "選擇顯示器", view: "檢視",
  control: "控制", touch: "觸控", trackpad: "觸控板", pan: "平移", keyboard: "鍵盤",
  fit: "符合螢幕", left: "左鍵", right: "右鍵", release: "釋放輸入", retry: "重試",
  takeover: "接管", permissionGuide: "顯示權限指引", connecting: "正在連線…",
  reconnecting: "正在重新連線，保留最後一幀。", offline: "已離線", unsupported: "遠端桌面無法使用。",
  permission: "需要桌面權限。", revoked: "遠端桌面存取權已變更。", busy: "此桌面正在使用中。",
  stopped: "桌面已停止此工作階段。", error: "遠端桌面無法繼續。", rtc: "即時", jpeg: "相容視訊",
  noHosts: "沒有可用的桌面支援遠端桌面。", compatibility: "即時連線恢復期間正在使用相容視訊。",
  inputOverflow: "輸入佇列已滿，控制已釋放。", viewOnly: "此桌面僅支援檢視。",
  accessibilityPermission: "控制桌面需要輔助使用權限。", inputBusy: "桌面輸入忙碌中，檢視仍可繼續。",
  inputUnavailable: "桌面控制無法使用，檢視仍可繼續。",
  viewerRestarted: "檢視器已安全重新啟動，請重新取得控制以繼續輸入。"
};

const JA: MobileRemoteDesktopCopy = {
  ...EN, title: "リモートデスクトップ", back: "戻る", chooseDesktop: "デスクトップを選択",
  chooseDisplay: "ディスプレイを選択", view: "表示", control: "操作", touch: "タッチ",
  trackpad: "トラックパッド", pan: "移動", keyboard: "キーボード", fit: "画面に合わせる",
  left: "左クリック", right: "右クリック", release: "入力を解放", retry: "再試行", takeover: "引き継ぐ",
  permissionGuide: "権限ガイドを表示", connecting: "接続中…", reconnecting: "再接続中 — 最後のフレームを表示しています。",
  offline: "オフライン", unsupported: "リモートデスクトップを利用できません。", permission: "デスクトップ側の権限が必要です。",
  revoked: "アクセス権が変更されました。", busy: "このデスクトップは使用中です。", stopped: "デスクトップがセッションを停止しました。",
  error: "リモートデスクトップを続行できません。", rtc: "ライブ", jpeg: "互換映像",
  noHosts: "リモートデスクトップを利用できるデスクトップがありません。",
  compatibility: "ライブ接続の回復中は互換映像を使用しています。", inputOverflow: "入力キューが一杯になったため操作を解除しました。",
  viewOnly: "このデスクトップは表示専用です。", accessibilityPermission: "操作するにはデスクトップ側でアクセシビリティ権限が必要です。",
  inputBusy: "デスクトップ入力は使用中です。表示は続行できます。", inputUnavailable: "デスクトップを操作できません。表示は続行できます。",
  viewerRestarted: "ビューアーを安全に再起動しました。入力を続けるにはもう一度操作を有効にしてください。"
};

const KO: MobileRemoteDesktopCopy = {
  ...EN, title: "원격 데스크톱", back: "뒤로", chooseDesktop: "데스크톱 선택", chooseDisplay: "디스플레이 선택",
  view: "보기", control: "제어", touch: "터치", trackpad: "트랙패드", pan: "이동", keyboard: "키보드",
  fit: "화면 맞춤", left: "왼쪽", right: "오른쪽", release: "입력 해제", retry: "다시 시도",
  takeover: "인계받기", permissionGuide: "권한 안내 표시", connecting: "연결 중…",
  reconnecting: "다시 연결 중 — 마지막 프레임을 유지합니다.", offline: "오프라인",
  unsupported: "원격 데스크톱을 사용할 수 없습니다.", permission: "데스크톱 권한이 필요합니다.",
  revoked: "원격 데스크톱 접근 권한이 변경되었습니다.", busy: "이 데스크톱은 사용 중입니다.",
  stopped: "데스크톱이 세션을 중지했습니다.", error: "원격 데스크톱을 계속할 수 없습니다.", rtc: "라이브", jpeg: "호환 영상",
  noHosts: "원격 데스크톱을 지원하는 사용 가능한 데스크톱이 없습니다.", compatibility: "라이브 연결이 복구되는 동안 호환 영상을 사용합니다.",
  inputOverflow: "입력 대기열이 가득 차 제어를 해제했습니다.", viewOnly: "이 데스크톱은 보기 전용입니다.",
  accessibilityPermission: "제어하려면 데스크톱의 손쉬운 사용 권한이 필요합니다.", inputBusy: "데스크톱 입력이 사용 중입니다. 보기는 계속됩니다.",
  inputUnavailable: "데스크톱 제어를 사용할 수 없습니다. 보기는 계속됩니다.",
  viewerRestarted: "뷰어를 안전하게 다시 시작했습니다. 입력을 계속하려면 제어를 다시 켜세요."
};

export function mobileRemoteDesktopCopy(locale: MobileSupportedLocale): MobileRemoteDesktopCopy {
  return locale === "zh-CN" ? ZH_CN : locale === "zh-TW" ? ZH_TW : locale === "ja" ? JA : locale === "ko" ? KO : EN;
}

export function mobileRemoteDesktopStatusLabel(snapshot: MobileRemoteDesktopSnapshot, copy: MobileRemoteDesktopCopy): string {
  if (snapshot.status === "loading" || snapshot.status === "connecting") return copy.connecting;
  if (snapshot.status === "reconnecting") return copy.reconnecting;
  if (snapshot.status === "offline") return copy.offline;
  if (snapshot.status === "unsupported") return copy.unsupported;
  if (snapshot.status === "permission") return copy.permission;
  if (snapshot.status === "revoked") return copy.revoked;
  if (snapshot.status === "busy") return copy.busy;
  if (snapshot.status === "stopped") return copy.stopped;
  if (snapshot.status === "error") return copy.error;
  if (snapshot.status === "live") return snapshot.media === "webrtc" ? copy.rtc : snapshot.media === "jpeg" ? copy.jpeg : copy.connecting;
  return snapshot.status === "select-host" ? copy.chooseDesktop : copy.chooseDisplay;
}

export function mobileRemoteDesktopNoticeLabel(
  notice: MobileRemoteDesktopNotice | undefined,
  copy: MobileRemoteDesktopCopy
): string | undefined {
  if (notice === undefined) return undefined;
  if (notice === "no-hosts") return copy.noHosts;
  if (notice === "compatibility") return copy.compatibility;
  if (notice === "input-overflow") return copy.inputOverflow;
  if (notice === "view-only") return copy.viewOnly;
  if (notice === "accessibility-permission") return copy.accessibilityPermission;
  if (notice === "input-busy") return copy.inputBusy;
  if (notice === "input-unavailable") return copy.inputUnavailable;
  if (notice === "viewer-restarted") return copy.viewerRestarted;
  if (notice === "screen-permission" || notice === "screen-permission-guide") return copy.permission;
  if (notice === "authority-changed") return copy.revoked;
  if (notice === "busy") return copy.busy;
  if (notice === "stopped") return copy.stopped;
  if (notice === "unavailable") return copy.unsupported;
  return copy.error;
}

export function mobileRemoteDesktopSessionDeviceId(
  session: Session | undefined,
  targets: readonly Target[],
  controllerDeviceId: string | undefined
): string | undefined {
  if (!session?.targetId || !boundedDeviceId(controllerDeviceId)) return undefined;
  const matches = targets.filter((target) => target.targetId === session.targetId);
  if (matches.length !== 1) return undefined;
  const location = matches[0]!.location?.kind;
  if (location?.case !== "devicePeer") return undefined;
  if (location.value.controllerDeviceId !== controllerDeviceId) return undefined;
  const targetDeviceId = location.value.targetDeviceId;
  return boundedDeviceId(targetDeviceId) ? targetDeviceId : undefined;
}

function boundedDeviceId(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

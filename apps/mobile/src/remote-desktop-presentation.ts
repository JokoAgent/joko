import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type {
  MobileRemoteDesktopClipboardNotice,
  MobileRemoteDesktopNotice,
  MobileRemoteDesktopSnapshot
} from "./remote-desktop-controller";
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
  readonly frameRate: string;
  readonly quality: string;
  readonly auto: string;
  readonly saver: string;
  readonly hd: string;
  readonly qualityHint: string;
  readonly audioOn: string;
  readonly audioOff: string;
  readonly pictureInPicture: string;
  readonly resolution: string;
  readonly nativeResolution: string;
  readonly displayModesLoading: string;
  readonly displayModesFailed: string;
  readonly displayModeFailed: string;
  readonly copyToPhone: string;
  readonly pasteFromPhone: string;
  readonly clipboardTransferring: string;
  readonly clipboardCopied: string;
  readonly clipboardPasted: string;
  readonly clipboardEmpty: string;
  readonly clipboardUnsupported: string;
  readonly clipboardTooLarge: string;
  readonly clipboardUnavailable: string;
  readonly clipboardBusy: string;
  readonly clipboardFailed: string;
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
  readonly audioUnavailable: string;
  readonly videoSettingsFailed: string;
  readonly pipUnavailable: string;
}

const EN: MobileRemoteDesktopCopy = {
  title: "Remote Desktop", back: "Back", chooseDesktop: "Choose a desktop", chooseDisplay: "Choose a display",
  view: "View", control: "Control", touch: "Touch", trackpad: "Trackpad", pan: "Pan",
  keyboard: "Keyboard", fit: "Fit", left: "Left", right: "Right", release: "Release",
  frameRate: "Frame rate", quality: "Quality", auto: "Auto", saver: "Data saver", hd: "HD",
  qualityHint: "Auto keeps motion smooth and sharpens when the network allows. Data saver limits usage to 30 FPS. HD keeps text sharp and lowers frame rate when bandwidth is limited.",
  audioOn: "Audio on", audioOff: "Audio off",
  pictureInPicture: "Picture in Picture", resolution: "Resolution", nativeResolution: "Native",
  displayModesLoading: "Loading resolutions…", displayModesFailed: "Could not load resolutions.",
  displayModeFailed: "The resolution could not be changed. The desktop connection is unchanged when the host rejected it.",
  copyToPhone: "Copy to phone", pasteFromPhone: "Paste from phone",
  clipboardTransferring: "Transferring clipboard…", clipboardCopied: "Copied to this phone.",
  clipboardPasted: "Pasted on the desktop.", clipboardEmpty: "The clipboard is empty.",
  clipboardUnsupported: "This clipboard item is not supported.",
  clipboardTooLarge: "This clipboard item is too large.",
  clipboardUnavailable: "Rich clipboard transfer is unavailable on this device.",
  clipboardBusy: "Another clipboard transfer is in progress.",
  clipboardFailed: "The clipboard transfer failed.",
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
  viewerRestarted: "The viewer restarted safely. Take control again to continue input.",
  audioUnavailable: "Desktop audio is unavailable. Video continues without audio.",
  videoSettingsFailed: "The video setting could not be applied. The current view remains available.",
  pipUnavailable: "Picture in Picture could not start. Continue viewing here."
};

const ZH_CN: MobileRemoteDesktopCopy = {
  title: "远程桌面", back: "返回", chooseDesktop: "选择桌面", chooseDisplay: "选择显示器",
  view: "查看", control: "控制", touch: "触控", trackpad: "触控板", pan: "平移",
  keyboard: "键盘", fit: "适合屏幕", left: "左键", right: "右键", release: "释放输入",
  frameRate: "帧率", quality: "画质", auto: "自动", saver: "省流", hd: "高清",
  qualityHint: "自动优先保证流畅，网络允许时尽量清晰；省流将流量与帧率限制在 30 FPS；高清优先保证文字清晰，带宽不足时会降低帧率。",
  audioOn: "声音已开启", audioOff: "声音已关闭",
  pictureInPicture: "画中画", resolution: "分辨率", nativeResolution: "原生",
  displayModesLoading: "正在加载分辨率…", displayModesFailed: "无法加载分辨率。",
  displayModeFailed: "无法更改分辨率。若桌面已开始切换，将自动重新连接。",
  copyToPhone: "复制到手机", pasteFromPhone: "从手机粘贴", clipboardTransferring: "正在传输剪贴板…",
  clipboardCopied: "已复制到此手机。", clipboardPasted: "已粘贴到桌面。", clipboardEmpty: "剪贴板为空。",
  clipboardUnsupported: "不支持此剪贴板项目。", clipboardTooLarge: "此剪贴板项目过大。",
  clipboardUnavailable: "此设备不支持富剪贴板传输。", clipboardBusy: "另一个剪贴板传输正在进行。",
  clipboardFailed: "剪贴板传输失败。",
  retry: "重试", takeover: "接管", permissionGuide: "显示权限指引",
  connecting: "正在连接…", reconnecting: "正在重新连接，保留最后一帧。", offline: "已离线",
  unsupported: "远程桌面不可用。", permission: "需要桌面权限。", revoked: "远程桌面访问权已变化。",
  busy: "此桌面正在使用中。", stopped: "桌面已停止此会话。", error: "远程桌面无法继续。",
  rtc: "实时", jpeg: "兼容视频", noHosts: "没有可用的桌面支持远程桌面。",
  compatibility: "实时连接恢复期间正在使用兼容视频。", inputOverflow: "输入队列已满，控制已释放。",
  viewOnly: "此桌面仅支持查看。", accessibilityPermission: "控制桌面需要辅助功能权限。",
  inputBusy: "桌面输入正忙，查看仍可继续。", inputUnavailable: "桌面控制不可用，查看仍可继续。",
  viewerRestarted: "查看器已安全重启，请重新取得控制以继续输入。",
  audioUnavailable: "桌面声音不可用，视频将继续静音播放。",
  videoSettingsFailed: "无法应用视频设置，当前画面仍可继续查看。",
  pipUnavailable: "无法启动画中画，请继续在此查看。"
};

const ZH_TW: MobileRemoteDesktopCopy = {
  ...ZH_CN, title: "遠端桌面", back: "返回", chooseDesktop: "選擇桌面", chooseDisplay: "選擇顯示器", view: "檢視",
  control: "控制", touch: "觸控", trackpad: "觸控板", pan: "平移", keyboard: "鍵盤",
  fit: "符合螢幕", left: "左鍵", right: "右鍵", release: "釋放輸入", retry: "重試",
  frameRate: "影格率", quality: "畫質", auto: "自動", saver: "省流量", hd: "高清",
  qualityHint: "自動優先確保流暢，網路允許時盡量清晰；省流量將用量與影格率限制在 30 FPS；高清優先確保文字清晰，頻寬不足時會降低影格率。",
  audioOn: "聲音已開啟", audioOff: "聲音已關閉",
  pictureInPicture: "子母畫面", resolution: "解析度", nativeResolution: "原生",
  displayModesLoading: "正在載入解析度…", displayModesFailed: "無法載入解析度。",
  displayModeFailed: "無法變更解析度。若桌面已開始切換，將自動重新連線。",
  copyToPhone: "複製到手機", pasteFromPhone: "從手機貼上", clipboardTransferring: "正在傳輸剪貼簿…",
  clipboardCopied: "已複製到此手機。", clipboardPasted: "已貼到桌面。", clipboardEmpty: "剪貼簿是空的。",
  clipboardUnsupported: "不支援此剪貼簿項目。", clipboardTooLarge: "此剪貼簿項目過大。",
  clipboardUnavailable: "此裝置不支援富剪貼簿傳輸。", clipboardBusy: "另一個剪貼簿傳輸正在進行。",
  clipboardFailed: "剪貼簿傳輸失敗。",
  takeover: "接管", permissionGuide: "顯示權限指引", connecting: "正在連線…",
  reconnecting: "正在重新連線，保留最後一幀。", offline: "已離線", unsupported: "遠端桌面無法使用。",
  permission: "需要桌面權限。", revoked: "遠端桌面存取權已變更。", busy: "此桌面正在使用中。",
  stopped: "桌面已停止此工作階段。", error: "遠端桌面無法繼續。", rtc: "即時", jpeg: "相容視訊",
  noHosts: "沒有可用的桌面支援遠端桌面。", compatibility: "即時連線恢復期間正在使用相容視訊。",
  inputOverflow: "輸入佇列已滿，控制已釋放。", viewOnly: "此桌面僅支援檢視。",
  accessibilityPermission: "控制桌面需要輔助使用權限。", inputBusy: "桌面輸入忙碌中，檢視仍可繼續。",
  inputUnavailable: "桌面控制無法使用，檢視仍可繼續。",
  viewerRestarted: "檢視器已安全重新啟動，請重新取得控制以繼續輸入。",
  audioUnavailable: "桌面聲音無法使用，視訊將繼續靜音播放。",
  videoSettingsFailed: "無法套用視訊設定，目前畫面仍可繼續檢視。",
  pipUnavailable: "無法啟動子母畫面，請繼續在此檢視。"
};

const JA: MobileRemoteDesktopCopy = {
  ...EN, title: "リモートデスクトップ", back: "戻る", chooseDesktop: "デスクトップを選択",
  chooseDisplay: "ディスプレイを選択", view: "表示", control: "操作", touch: "タッチ",
  trackpad: "トラックパッド", pan: "移動", keyboard: "キーボード", fit: "画面に合わせる",
  left: "左クリック", right: "右クリック", release: "入力を解放", retry: "再試行", takeover: "引き継ぐ",
  frameRate: "フレームレート", quality: "画質", auto: "自動", saver: "データ節約", hd: "高画質",
  qualityHint: "自動は滑らかさを優先し、通信に余裕があれば鮮明にします。データ節約は通信量とフレームレートを 30 FPS に抑えます。高画質は文字の鮮明さを優先し、帯域が足りないときはフレームレートを下げます。",
  audioOn: "音声オン", audioOff: "音声オフ",
  pictureInPicture: "ピクチャ・イン・ピクチャ", resolution: "解像度", nativeResolution: "ネイティブ",
  displayModesLoading: "解像度を読み込み中…", displayModesFailed: "解像度を読み込めませんでした。",
  displayModeFailed: "解像度を変更できませんでした。切り替えが始まっている場合は自動的に再接続します。",
  copyToPhone: "スマートフォンにコピー", pasteFromPhone: "スマートフォンから貼り付け",
  clipboardTransferring: "クリップボードを転送中…", clipboardCopied: "このスマートフォンにコピーしました。",
  clipboardPasted: "デスクトップに貼り付けました。", clipboardEmpty: "クリップボードは空です。",
  clipboardUnsupported: "このクリップボード項目には対応していません。",
  clipboardTooLarge: "このクリップボード項目は大きすぎます。",
  clipboardUnavailable: "このデバイスではリッチクリップボード転送を利用できません。",
  clipboardBusy: "別のクリップボード転送が進行中です。", clipboardFailed: "クリップボード転送に失敗しました。",
  permissionGuide: "権限ガイドを表示", connecting: "接続中…", reconnecting: "再接続中 — 最後のフレームを表示しています。",
  offline: "オフライン", unsupported: "リモートデスクトップを利用できません。", permission: "デスクトップ側の権限が必要です。",
  revoked: "アクセス権が変更されました。", busy: "このデスクトップは使用中です。", stopped: "デスクトップがセッションを停止しました。",
  error: "リモートデスクトップを続行できません。", rtc: "ライブ", jpeg: "互換映像",
  noHosts: "リモートデスクトップを利用できるデスクトップがありません。",
  compatibility: "ライブ接続の回復中は互換映像を使用しています。", inputOverflow: "入力キューが一杯になったため操作を解除しました。",
  viewOnly: "このデスクトップは表示専用です。", accessibilityPermission: "操作するにはデスクトップ側でアクセシビリティ権限が必要です。",
  inputBusy: "デスクトップ入力は使用中です。表示は続行できます。", inputUnavailable: "デスクトップを操作できません。表示は続行できます。",
  viewerRestarted: "ビューアーを安全に再起動しました。入力を続けるにはもう一度操作を有効にしてください。",
  audioUnavailable: "デスクトップ音声を利用できません。映像は無音で続行します。",
  videoSettingsFailed: "映像設定を適用できませんでした。現在の表示はそのまま利用できます。",
  pipUnavailable: "ピクチャ・イン・ピクチャを開始できません。ここで表示を続けてください。"
};

const KO: MobileRemoteDesktopCopy = {
  ...EN, title: "원격 데스크톱", back: "뒤로", chooseDesktop: "데스크톱 선택", chooseDisplay: "디스플레이 선택",
  view: "보기", control: "제어", touch: "터치", trackpad: "트랙패드", pan: "이동", keyboard: "키보드",
  fit: "화면 맞춤", left: "왼쪽", right: "오른쪽", release: "입력 해제", retry: "다시 시도",
  frameRate: "프레임 속도", quality: "화질", auto: "자동", saver: "데이터 절약", hd: "고화질",
  qualityHint: "자동은 부드러움을 우선하고 네트워크가 허용하면 더 선명하게 표시합니다. 데이터 절약은 사용량과 프레임 속도를 30 FPS로 제한합니다. 고화질은 글자 선명도를 우선하며 대역폭이 부족하면 프레임 속도를 낮춥니다.",
  audioOn: "오디오 켜짐", audioOff: "오디오 꺼짐",
  pictureInPicture: "화면 속 화면", resolution: "해상도", nativeResolution: "기본",
  displayModesLoading: "해상도 불러오는 중…", displayModesFailed: "해상도를 불러오지 못했습니다.",
  displayModeFailed: "해상도를 변경하지 못했습니다. 전환이 시작된 경우 자동으로 다시 연결합니다.",
  copyToPhone: "휴대전화로 복사", pasteFromPhone: "휴대전화에서 붙여넣기",
  clipboardTransferring: "클립보드 전송 중…", clipboardCopied: "이 휴대전화에 복사했습니다.",
  clipboardPasted: "데스크톱에 붙여넣었습니다.", clipboardEmpty: "클립보드가 비어 있습니다.",
  clipboardUnsupported: "이 클립보드 항목은 지원되지 않습니다.",
  clipboardTooLarge: "이 클립보드 항목이 너무 큽니다.",
  clipboardUnavailable: "이 기기에서는 리치 클립보드 전송을 사용할 수 없습니다.",
  clipboardBusy: "다른 클립보드 전송이 진행 중입니다.", clipboardFailed: "클립보드 전송에 실패했습니다.",
  takeover: "인계받기", permissionGuide: "권한 안내 표시", connecting: "연결 중…",
  reconnecting: "다시 연결 중 — 마지막 프레임을 유지합니다.", offline: "오프라인",
  unsupported: "원격 데스크톱을 사용할 수 없습니다.", permission: "데스크톱 권한이 필요합니다.",
  revoked: "원격 데스크톱 접근 권한이 변경되었습니다.", busy: "이 데스크톱은 사용 중입니다.",
  stopped: "데스크톱이 세션을 중지했습니다.", error: "원격 데스크톱을 계속할 수 없습니다.", rtc: "라이브", jpeg: "호환 영상",
  noHosts: "원격 데스크톱을 지원하는 사용 가능한 데스크톱이 없습니다.", compatibility: "라이브 연결이 복구되는 동안 호환 영상을 사용합니다.",
  inputOverflow: "입력 대기열이 가득 차 제어를 해제했습니다.", viewOnly: "이 데스크톱은 보기 전용입니다.",
  accessibilityPermission: "제어하려면 데스크톱의 손쉬운 사용 권한이 필요합니다.", inputBusy: "데스크톱 입력이 사용 중입니다. 보기는 계속됩니다.",
  inputUnavailable: "데스크톱 제어를 사용할 수 없습니다. 보기는 계속됩니다.",
  viewerRestarted: "뷰어를 안전하게 다시 시작했습니다. 입력을 계속하려면 제어를 다시 켜세요.",
  audioUnavailable: "데스크톱 오디오를 사용할 수 없습니다. 영상은 음소거 상태로 계속됩니다.",
  videoSettingsFailed: "영상 설정을 적용하지 못했습니다. 현재 화면은 계속 볼 수 있습니다.",
  pipUnavailable: "화면 속 화면을 시작하지 못했습니다. 여기에서 계속 시청하세요."
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
  if (notice === "audio-unavailable") return copy.audioUnavailable;
  if (notice === "video-settings-failed") return copy.videoSettingsFailed;
  if (notice === "pip-unavailable") return copy.pipUnavailable;
  if (notice === "screen-permission" || notice === "screen-permission-guide") return copy.permission;
  if (notice === "authority-changed") return copy.revoked;
  if (notice === "busy") return copy.busy;
  if (notice === "stopped") return copy.stopped;
  if (notice === "unavailable") return copy.unsupported;
  return copy.error;
}

export function mobileRemoteDesktopClipboardNoticeLabel(
  notice: MobileRemoteDesktopClipboardNotice | undefined,
  copy: MobileRemoteDesktopCopy
): string | undefined {
  if (notice === "copied") return copy.clipboardCopied;
  if (notice === "pasted") return copy.clipboardPasted;
  if (notice === "empty") return copy.clipboardEmpty;
  if (notice === "unsupported") return copy.clipboardUnsupported;
  if (notice === "too-large") return copy.clipboardTooLarge;
  if (notice === "unavailable") return copy.clipboardUnavailable;
  if (notice === "busy") return copy.clipboardBusy;
  if (notice === "failed") return copy.clipboardFailed;
  return undefined;
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

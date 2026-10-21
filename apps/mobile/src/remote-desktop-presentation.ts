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
  readonly mouseButtons: string;
  readonly leftMouseButton: string;
  readonly rightMouseButton: string;
  readonly mouseWheel: string;
  readonly inputSettingsLoadFailed: string;
  readonly inputSettingsSaveFailed: string;
  readonly pointer: string;
  readonly pointerHint: string;
  readonly settings: string;
  readonly closeSettings: string;
  readonly controls: string;
  readonly displaySettings: string;
  readonly security: string;
  readonly panelBack: string;
  readonly panelClose: string;
  readonly displaySwitching: string;
  readonly displaySwitchFailed: string;
  readonly displayUnavailable: string;
  readonly keyboard: string;
  readonly inputMethod: string;
  readonly computerKeyboard: string;
  readonly functionKeys: string;
  readonly comboMode: string;
  readonly closeKeyboard: string;
  readonly allWindows: string;
  readonly showDesktop: string;
  readonly workspaceLeft: string;
  readonly workspaceRight: string;
  readonly systemMenu: string;
  readonly systemActionUpdating: string;
  readonly systemActionFailed: string;
  readonly fit: string;
  readonly fitDisplay: string;
  readonly restoreDisplay: string;
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
  readonly hostMute: string;
  readonly hostMuteHint: string;
  readonly hostMuteActive: string;
  readonly hostMuteUnconfirmed: string;
  readonly hostMuteUpdating: string;
  readonly hostMuteLoadFailed: string;
  readonly hostMuteSaveFailed: string;
  readonly hostMuteApplyFailed: string;
  readonly privacyScreen: string;
  readonly privacyScreenHint: string;
  readonly privacyScreenActive: string;
  readonly privacyScreenUnconfirmed: string;
  readonly privacyScreenUpdating: string;
  readonly privacyScreenLoadFailed: string;
  readonly privacyScreenSaveFailed: string;
  readonly privacyScreenApplyFailed: string;
  readonly lockOnExit: string;
  readonly lockOnExitHint: string;
  readonly lockPreferenceLoadFailed: string;
  readonly lockPreferenceSaveFailed: string;
  readonly lockingOnExit: string;
  readonly disconnecting: string;
  readonly lockExpired: string;
  readonly lockUnavailable: string;
  readonly lockFailed: string;
  readonly exitFailed: string;
  readonly reconnect: string;
  readonly closeViewer: string;
  readonly disconnect: string;
  readonly returnToDesktop: string;
  readonly pictureInPicture: string;
  readonly backgroundViewing: string;
  readonly backgroundLoadFailed: string;
  readonly backgroundSaveFailed: string;
  readonly rotate: string;
  readonly rotating: string;
  readonly rotationFailed: string;
  readonly networkDirect: string;
  readonly networkRelay: string;
  readonly networkVideo: string;
  readonly networkScreenshot: string;
  readonly resolution: string;
  readonly nativeResolution: string;
  readonly displayModesLoading: string;
  readonly displayModesFailed: string;
  readonly displayModeFailed: string;
  readonly temporaryResolution: string;
  readonly displayRestoreFailed: string;
  readonly copyToPhone: string;
  readonly pasteFromPhone: string;
  readonly clipboardTransferring: string;
  readonly clipboardSync: string;
  readonly clipboardSyncHint: string;
  readonly clipboardSyncActive: string;
  readonly clipboardSyncPaused: string;
  readonly clipboardSyncLoadFailed: string;
  readonly clipboardSyncSaveFailed: string;
  readonly clipboardSyncSkipped: string;
  readonly clipboardSyncConflict: string;
  readonly clipboardSyncPermission: string;
  readonly clipboardSyncFailed: string;
  readonly clipboardSyncUnknown: string;
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
  readonly permissionsTitle: string;
  readonly permissionsIntro: string;
  readonly permissionsReady: string;
  readonly screenRecording: string;
  readonly accessibility: string;
  readonly permissionChecking: string;
  readonly permissionGranted: string;
  readonly permissionNotRequired: string;
  readonly permissionUnknown: string;
  readonly permissionMissing: string;
  readonly openGuideOnComputer: string;
  readonly permissionGuideOpened: string;
  readonly permissionActionFailed: string;
  readonly permissionCheckFailed: string;
  readonly permissionGuideUnknown: string;
  readonly reconnectAfterPermissions: string;
  readonly connecting: string;
  readonly capturePending: string;
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
  readonly inputRecovering: string;
  readonly viewerRestarted: string;
  readonly audioUnavailable: string;
  readonly videoSettingsFailed: string;
  readonly pipUnavailable: string;
}

const EN: MobileRemoteDesktopCopy = {
  permissionsTitle: "Remote desktop permissions", permissionsIntro: "Screen recording lets you view the desktop. Accessibility also enables control. Complete authorization on the computer; status updates automatically.",
  permissionsReady: "System permissions are ready. You can reconnect.", screenRecording: "Screen recording", accessibility: "Accessibility",
  permissionChecking: "Checking…", permissionGranted: "Granted", permissionNotRequired: "Not required", permissionUnknown: "Unconfirmed", permissionMissing: "Not granted",
  openGuideOnComputer: "Open guide on computer", permissionGuideOpened: "The permission guide is open on the computer. Continue there.",
  permissionActionFailed: "Could not open the permission guide. Try again in Remote control settings on the computer.",
  permissionCheckFailed: "Could not check permissions. Make sure the computer is online and try again.",
  permissionGuideUnknown: "Opening the permission guide could not be confirmed. Check the computer before trying again.", reconnectAfterPermissions: "Check and reconnect",
  controls: "Controls", displaySettings: "Display settings", security: "Security", panelBack: "Back to controls", panelClose: "Close panel",
  displaySwitching: "Switching display…", displaySwitchFailed: "The previous display could not be disconnected. Retry to finish disconnecting before switching.",
  displayUnavailable: "The selected display is no longer available. Choose a display from the current list.",
  title: "Remote Desktop", back: "Back", chooseDesktop: "Choose a desktop", chooseDisplay: "Choose a display",
  view: "View", control: "Control", touch: "Touch", trackpad: "Trackpad", pan: "Pan",
  keyboard: "Keyboard", fit: "Fit", left: "Left", right: "Right", release: "Release",
  inputMethod: "Input method", computerKeyboard: "Computer keyboard", functionKeys: "Function keys",
  comboMode: "Combo mode", closeKeyboard: "Close keyboard", allWindows: "All windows", showDesktop: "Show desktop",
  workspaceLeft: "Left workspace", workspaceRight: "Right workspace", systemMenu: "System menu",
  systemActionUpdating: "Updating desktop…", systemActionFailed: "The desktop action could not be confirmed. Viewing continues; retry to try again.",
  fitDisplay: "Fit display to viewer", restoreDisplay: "Restore display",
  frameRate: "Frame rate", quality: "Quality", auto: "Auto", saver: "Data saver", hd: "HD",
  qualityHint: "Auto keeps motion smooth and sharpens when the network allows. Data saver limits usage to 30 FPS. HD keeps text sharp and lowers frame rate when bandwidth is limited.",
  audioOn: "Audio on", audioOff: "Audio off",
  hostMute: "Mute desktop speakers", hostMuteHint: "Mutes desktop output while you control it. Your preference is saved for this desktop.",
  privacyScreen: "Privacy screen", privacyScreenHint: "Protects the desktop's physical screens while you control it. Your preference is saved for this desktop.",
  privacyScreenActive: "Privacy screen confirmed", privacyScreenUnconfirmed: "Privacy screen not confirmed", privacyScreenUpdating: "Updating privacy screen…",
  privacyScreenLoadFailed: "Could not load the privacy screen preference. Retry or save a new choice.", privacyScreenSaveFailed: "Could not save the privacy screen preference. The previous choice is kept.",
  privacyScreenApplyFailed: "Privacy screen could not be confirmed. Viewing continues; toggle the setting to retry.",
  hostMuteActive: "Desktop mute confirmed", hostMuteUnconfirmed: "Desktop mute not confirmed", hostMuteUpdating: "Updating desktop mute…",
  hostMuteLoadFailed: "Could not load the desktop mute preference. Retry to load it.",
  hostMuteSaveFailed: "Could not save the desktop mute preference. The previous preference remains selected.",
  hostMuteApplyFailed: "Could not confirm desktop mute. Viewing continues; retry to apply it.",
  lockOnExit: "Lock desktop on exit", lockOnExitHint: "Locks this desktop when you disconnect, or when Picture in Picture ends after leaving this page.",
  lockPreferenceLoadFailed: "Could not load the exit lock preference. Retry to load it.",
  lockPreferenceSaveFailed: "Could not save the exit lock preference. The previous preference remains selected.",
  lockingOnExit: "Locking desktop and disconnecting…", disconnecting: "Disconnecting…",
  lockExpired: "The exit authority expired. Desktop locking was not confirmed. Reconnect for a new session or close this viewer.",
  lockUnavailable: "Desktop locking is unavailable. Locking was not confirmed. Reconnect or close this viewer.",
  lockFailed: "Desktop locking failed. Reconnect for a new session or close this viewer.",
  exitFailed: "Disconnect could not be confirmed. Reconnect for a new session or close this viewer.",
  reconnect: "Reconnect", closeViewer: "Close viewer", disconnect: "Disconnect", returnToDesktop: "Return to Remote Desktop",
  pictureInPicture: "Picture in Picture", resolution: "Resolution", nativeResolution: "Native",
  backgroundViewing: "Run in background", backgroundLoadFailed: "Could not load the background preference. Retry to load it.",
  backgroundSaveFailed: "Could not save the background preference. The saved setting remains selected.",
  rotate: "Rotate screen", rotating: "Rotating…", rotationFailed: "Could not rotate the screen. Try again.",
  networkDirect: "Direct connection", networkRelay: "Relay connection", networkVideo: "Video", networkScreenshot: "Screenshots",
  mouseButtons: "Mouse buttons", leftMouseButton: "Left mouse button", rightMouseButton: "Right mouse button", mouseWheel: "Mouse wheel",
  inputSettingsLoadFailed: "Could not load the input preference. Retry to load it.", inputSettingsSaveFailed: "The input preference was not saved. Retry to save it.",
  pointer: "Touchpad", pointerHint: "Move your finger to move the pointer. Tap to click.", settings: "Remote desktop settings", closeSettings: "Close settings",
  displayModesLoading: "Loading resolutions…", displayModesFailed: "Could not load resolutions.",
  displayModeFailed: "The resolution could not be changed. The desktop connection is unchanged when the host rejected it.",
  temporaryResolution: "Temporary resolution; the original mode is restored when this connection ends.",
  displayRestoreFailed: "The original resolution could not be restored. Reconnect to retry recovery.",
  copyToPhone: "Copy to phone", pasteFromPhone: "Paste from phone",
  clipboardSync: "Clipboard sync", clipboardSyncHint: "Sync portable text, images and rich text both ways while this page is active and you control the desktop. Allow paste access if your device asks.",
  clipboardSyncActive: "Sync active", clipboardSyncPaused: "Sync paused",
  clipboardSyncLoadFailed: "Could not load the sync preference. Retry to load it, or select the switch to save a new preference.",
  clipboardSyncSaveFailed: "Could not save the sync preference. The previous preference remains selected.",
  clipboardSyncSkipped: "This clipboard item could not be synced and was skipped. Copy supported text or an image to try again.",
  clipboardSyncConflict: "Both clipboards changed. Both copies were kept. Copy again on either device to sync.",
  clipboardSyncPermission: "Sync is paused. Allow paste access, then retry. Your setting stays on.",
  clipboardSyncFailed: "Sync temporarily failed. Retrying automatically; your setting stays on.",
  clipboardSyncUnknown: "A clipboard operation has not finished. Sync is paused until its result is known; the write will not be repeated.",
  clipboardTransferring: "Transferring clipboard…", clipboardCopied: "Copied to this phone.",
  clipboardPasted: "Pasted on the desktop.", clipboardEmpty: "The clipboard is empty.",
  clipboardUnsupported: "This clipboard item is not supported.",
  clipboardTooLarge: "This clipboard item is too large.",
  clipboardUnavailable: "Rich clipboard transfer is unavailable on this device.",
  clipboardBusy: "Another clipboard transfer is in progress.",
  clipboardFailed: "The clipboard transfer failed.",
  retry: "Retry", takeover: "Take over", permissionGuide: "Show permission guide",
  connecting: "Connecting…", reconnecting: "Reconnecting — the last frame stays visible.", offline: "Offline",
  capturePending: "Waiting for screen sharing approval on the desktop…",
  unsupported: "Remote Desktop is unavailable.", permission: "Desktop permission is required.",
  revoked: "Remote Desktop access changed.", busy: "This desktop is already in use.",
  stopped: "The desktop stopped this session.", error: "Remote Desktop could not continue.",
  rtc: "Live", jpeg: "Compatibility video", noHosts: "No available desktop supports Remote Desktop.",
  compatibility: "Using compatibility video while the live connection recovers.",
  inputOverflow: "Control was released because the input queue filled.", viewOnly: "This desktop is view-only.",
  accessibilityPermission: "Accessibility permission is required on the desktop for control.",
  inputBusy: "Desktop input is busy. Viewing continues.",
  inputUnavailable: "Desktop control is unavailable. Viewing continues.",
  inputRecovering: "Restoring desktop control… Viewing continues.",
  viewerRestarted: "The viewer restarted safely. Take control again to continue input.",
  audioUnavailable: "Desktop audio is unavailable. Video continues without audio.",
  videoSettingsFailed: "The video setting could not be applied. The current view remains available.",
  pipUnavailable: "Picture in Picture could not start. Continue viewing here."
};

const ZH_CN: MobileRemoteDesktopCopy = {
  permissionsTitle: "远程桌面权限", permissionsIntro: "查看桌面需要屏幕录制权限；操作桌面还需要辅助功能权限。请在电脑上完成授权，结果会自动更新。",
  permissionsReady: "系统权限已就绪，可以重新连接。", screenRecording: "屏幕录制", accessibility: "辅助功能",
  permissionChecking: "检测中…", permissionGranted: "已授权", permissionNotRequired: "无需授权", permissionUnknown: "未确认", permissionMissing: "未授权",
  openGuideOnComputer: "在电脑上打开授权引导", permissionGuideOpened: "已在电脑上显示授权引导，请在电脑上继续。",
  permissionActionFailed: "未能打开授权引导。请在电脑端的远程控制设置中重试。", permissionCheckFailed: "暂时无法检测权限，请确认电脑在线后重试。",
  permissionGuideUnknown: "无法确认电脑上已打开授权引导。请先检查电脑，再决定是否重试。", reconnectAfterPermissions: "重新检测并连接",
  controls: "操作", displaySettings: "显示设置", security: "安全", panelBack: "返回操作面板", panelClose: "关闭面板",
  displaySwitching: "正在切换显示器…", displaySwitchFailed: "无法确认已断开原显示器。请重试，完成断开后再切换。",
  displayUnavailable: "所选显示器已不可用。请从当前列表重新选择。",
  title: "远程桌面", back: "返回", chooseDesktop: "选择桌面", chooseDisplay: "选择显示器",
  view: "查看", control: "控制", touch: "触控", trackpad: "触控板", pan: "平移",
  keyboard: "键盘", fit: "适合屏幕", left: "左键", right: "右键", release: "释放输入",
  inputMethod: "输入法", computerKeyboard: "电脑键盘", functionKeys: "功能键",
  comboMode: "组合模式", closeKeyboard: "关闭键盘", allWindows: "所有窗口", showDesktop: "显示桌面",
  workspaceLeft: "左侧工作区", workspaceRight: "右侧工作区", systemMenu: "系统菜单",
  systemActionUpdating: "正在更新桌面…", systemActionFailed: "无法确认桌面操作。画面仍可查看，请重试。",
  fitDisplay: "显示器适配查看器", restoreDisplay: "恢复显示器",
  frameRate: "帧率", quality: "画质", auto: "自动", saver: "省流", hd: "高清",
  qualityHint: "自动优先保证流畅，网络允许时尽量清晰；省流将流量与帧率限制在 30 FPS；高清优先保证文字清晰，带宽不足时会降低帧率。",
  audioOn: "声音已开启", audioOff: "声音已关闭",
  hostMute: "静音桌面扬声器", hostMuteHint: "控制期间静音桌面输出，为此桌面保存偏好。",
  hostMuteActive: "已确认桌面静音", hostMuteUnconfirmed: "桌面静音未确认", hostMuteUpdating: "正在更新桌面静音…",
  hostMuteLoadFailed: "无法读取桌面静音偏好，请重试。", hostMuteSaveFailed: "无法保存桌面静音偏好，仍选用之前的偏好。",
  hostMuteApplyFailed: "无法确认桌面静音，画面仍可查看，请重试应用。",
  privacyScreen: "隐私屏", privacyScreenHint: "控制期间保护桌面的实体屏幕，为此桌面保存偏好。",
  privacyScreenActive: "已确认隐私屏", privacyScreenUnconfirmed: "隐私屏未确认", privacyScreenUpdating: "正在更新隐私屏…",
  privacyScreenLoadFailed: "无法读取隐私屏偏好，请重试或保存新选择。", privacyScreenSaveFailed: "无法保存隐私屏偏好，仍选用之前的偏好。",
  privacyScreenApplyFailed: "无法确认隐私屏；画面仍可查看，请切换设置以重试。",
  lockOnExit: "退出时锁定桌面", lockOnExitHint: "断开连接时，或离开本页后的画中画结束时，锁定此桌面。",
  lockPreferenceLoadFailed: "无法读取退出锁屏偏好，请重试。", lockPreferenceSaveFailed: "无法保存退出锁屏偏好，仍选用之前的偏好。",
  lockingOnExit: "正在锁定桌面并断开连接…", disconnecting: "正在断开连接…",
  lockExpired: "退出权限已过期，未确认桌面锁定。请重新连接新会话，或关闭查看器。",
  lockUnavailable: "桌面锁定不可用，未确认锁屏。请重新连接，或关闭查看器。",
  lockFailed: "桌面锁定失败。请重新连接新会话，或关闭查看器。", exitFailed: "无法确认断开连接。请重新连接新会话，或关闭查看器。",
  reconnect: "重新连接", closeViewer: "关闭查看器", disconnect: "断开连接", returnToDesktop: "返回远程桌面",
  pictureInPicture: "画中画", resolution: "分辨率", nativeResolution: "原生",
  backgroundViewing: "后台运行", backgroundLoadFailed: "无法加载后台运行偏好，请重试加载。",
  backgroundSaveFailed: "无法保存后台运行偏好，仍采用上次已保存的选择。",
  rotate: "旋转屏幕", rotating: "正在旋转…", rotationFailed: "无法旋转屏幕，请重试。",
  networkDirect: "直连", networkRelay: "中继连接", networkVideo: "视频", networkScreenshot: "截图",
  mouseButtons: "鼠标按钮", leftMouseButton: "鼠标左键", rightMouseButton: "鼠标右键", mouseWheel: "鼠标滚轮",
  inputSettingsLoadFailed: "无法加载输入偏好，请重试加载。", inputSettingsSaveFailed: "未能保存输入偏好，请重试保存。",
  pointer: "触控板", pointerHint: "移动手指控制指针，轻点执行点击。", settings: "远程桌面设置", closeSettings: "关闭设置",
  displayModesLoading: "正在加载分辨率…", displayModesFailed: "无法加载分辨率。",
  displayModeFailed: "无法确认分辨率切换。",
  temporaryResolution: "临时分辨率；连接结束后恢复原显示模式。", displayRestoreFailed: "无法确认原分辨率恢复，请重新连接以重试恢复。",
  copyToPhone: "复制到手机", pasteFromPhone: "从手机粘贴", clipboardTransferring: "正在传输剪贴板…",
  clipboardSync: "剪贴板同步", clipboardSyncHint: "当前页面在前台且你拥有桌面控制权时，双向同步可传输的文字、图片与富文本。设备请求粘贴权限时请允许。",
  clipboardSyncActive: "同步已启用", clipboardSyncPaused: "同步已暂停",
  clipboardSyncLoadFailed: "无法加载同步偏好。可重试加载，或点击开关保存新偏好。", clipboardSyncSaveFailed: "无法保存同步偏好，仍采用上次已保存的选择。",
  clipboardSyncSkipped: "已跳过无法同步的剪贴板内容。重新复制支持的文字或图片后可继续同步。",
  clipboardSyncConflict: "两端剪贴板均已变化，已分别保留。请在任一设备重新复制以同步。",
  clipboardSyncPermission: "同步已暂停。请允许粘贴权限后重试，开关仍保持开启。",
  clipboardSyncFailed: "同步暂时失败，正在自动重试，开关仍保持开启。",
  clipboardSyncUnknown: "剪贴板操作尚未结束，等待结果期间暂停同步，不会重复写入。",
  clipboardCopied: "已复制到此手机。", clipboardPasted: "已粘贴到桌面。", clipboardEmpty: "剪贴板为空。",
  clipboardUnsupported: "不支持此剪贴板项目。", clipboardTooLarge: "此剪贴板项目过大。",
  clipboardUnavailable: "此设备不支持富剪贴板传输。", clipboardBusy: "另一个剪贴板传输正在进行。",
  clipboardFailed: "剪贴板传输失败。",
  retry: "重试", takeover: "接管", permissionGuide: "显示权限指引",
  connecting: "正在连接…", reconnecting: "正在重新连接，保留最后一帧。", offline: "已离线",
  capturePending: "正在等待桌面批准屏幕共享…",
  unsupported: "远程桌面不可用。", permission: "需要桌面权限。", revoked: "远程桌面访问权已变化。",
  busy: "此桌面正在使用中。", stopped: "桌面已停止此会话。", error: "远程桌面无法继续。",
  rtc: "实时", jpeg: "兼容视频", noHosts: "没有可用的桌面支持远程桌面。",
  compatibility: "实时连接恢复期间正在使用兼容视频。", inputOverflow: "输入队列已满，控制已释放。",
  viewOnly: "此桌面仅支持查看。", accessibilityPermission: "控制桌面需要辅助功能权限。",
  inputBusy: "桌面输入正忙，查看仍可继续。", inputUnavailable: "桌面控制不可用，查看仍可继续。",
  inputRecovering: "正在恢复桌面控制，查看仍可继续。",
  viewerRestarted: "查看器已安全重启，请重新取得控制以继续输入。",
  audioUnavailable: "桌面声音不可用，视频将继续静音播放。",
  videoSettingsFailed: "无法应用视频设置，当前画面仍可继续查看。",
  pipUnavailable: "无法启动画中画，请继续在此查看。"
};

const ZH_TW: MobileRemoteDesktopCopy = {
  ...ZH_CN, permissionsTitle: "遠端桌面權限", permissionsIntro: "檢視桌面需要螢幕錄製權限；操作桌面還需要輔助使用權限。請在電腦上完成授權，結果會自動更新。",
  permissionsReady: "系統權限已就緒，可以重新連線。", screenRecording: "螢幕錄製", accessibility: "輔助使用",
  permissionChecking: "檢測中…", permissionGranted: "已授權", permissionNotRequired: "無需授權", permissionUnknown: "未確認", permissionMissing: "未授權",
  openGuideOnComputer: "在電腦上開啟授權引導", permissionGuideOpened: "已在電腦上顯示授權引導，請在電腦上繼續。",
  permissionActionFailed: "無法開啟授權引導。請在電腦端的遠端控制設定中重試。", permissionCheckFailed: "暫時無法檢測權限，請確認電腦在線後重試。",
  permissionGuideUnknown: "無法確認電腦上已開啟授權引導。請先檢查電腦，再決定是否重試。", reconnectAfterPermissions: "重新檢測並連線",
  controls: "操作", displaySettings: "顯示設定", security: "安全", panelBack: "返回操作面板", panelClose: "關閉面板",
  displaySwitching: "正在切換顯示器…", displaySwitchFailed: "無法確認已中斷原顯示器。請重試，完成中斷後再切換。",
  displayUnavailable: "所選顯示器已無法使用。請從目前清單重新選擇。",
  title: "遠端桌面", back: "返回", chooseDesktop: "選擇桌面", chooseDisplay: "選擇顯示器", view: "檢視",
  control: "控制", touch: "觸控", trackpad: "觸控板", pan: "平移", keyboard: "鍵盤",
  fit: "符合螢幕", left: "左鍵", right: "右鍵", release: "釋放輸入", retry: "重試",
  inputMethod: "輸入法", computerKeyboard: "電腦鍵盤", functionKeys: "功能鍵",
  comboMode: "組合模式", closeKeyboard: "關閉鍵盤", allWindows: "所有視窗", showDesktop: "顯示桌面",
  workspaceLeft: "左側工作區", workspaceRight: "右側工作區", systemMenu: "系統選單",
  systemActionUpdating: "正在更新桌面…", systemActionFailed: "無法確認桌面操作。畫面仍可檢視，請重試。",
  fitDisplay: "顯示器配合檢視器", restoreDisplay: "恢復顯示器",
  frameRate: "影格率", quality: "畫質", auto: "自動", saver: "省流量", hd: "高清",
  qualityHint: "自動優先確保流暢，網路允許時盡量清晰；省流量將用量與影格率限制在 30 FPS；高清優先確保文字清晰，頻寬不足時會降低影格率。",
  audioOn: "聲音已開啟", audioOff: "聲音已關閉",
  hostMute: "靜音桌面揚聲器", hostMuteHint: "控制期間靜音桌面輸出，為此桌面儲存偏好。",
  hostMuteActive: "已確認桌面靜音", hostMuteUnconfirmed: "桌面靜音未確認", hostMuteUpdating: "正在更新桌面靜音…",
  hostMuteLoadFailed: "無法讀取桌面靜音偏好，請重試。", hostMuteSaveFailed: "無法儲存桌面靜音偏好，仍選用先前的偏好。",
  hostMuteApplyFailed: "無法確認桌面靜音，畫面仍可檢視，請重試套用。",
  privacyScreen: "隱私屏", privacyScreenHint: "控制期間保護桌面的實體螢幕，為此桌面儲存偏好。",
  privacyScreenActive: "已確認隱私屏", privacyScreenUnconfirmed: "隱私屏未確認", privacyScreenUpdating: "正在更新隱私屏…",
  privacyScreenLoadFailed: "無法讀取隱私屏偏好，請重試或儲存新選擇。", privacyScreenSaveFailed: "無法儲存隱私屏偏好，仍選用先前的偏好。",
  privacyScreenApplyFailed: "無法確認隱私屏；畫面仍可檢視，請切換設定以重試。",
  lockOnExit: "退出時鎖定桌面", lockOnExitHint: "中斷連線時，或離開本頁後的子母畫面結束時，鎖定此桌面。",
  lockPreferenceLoadFailed: "無法讀取退出鎖屏偏好，請重試。", lockPreferenceSaveFailed: "無法儲存退出鎖屏偏好，仍選用先前的偏好。",
  lockingOnExit: "正在鎖定桌面並中斷連線…", disconnecting: "正在中斷連線…",
  lockExpired: "退出權限已過期，未確認桌面鎖定。請重新連線新工作階段，或關閉檢視器。",
  lockUnavailable: "桌面鎖定無法使用，未確認鎖屏。請重新連線，或關閉檢視器。",
  lockFailed: "桌面鎖定失敗。請重新連線新工作階段，或關閉檢視器。", exitFailed: "無法確認中斷連線。請重新連線新工作階段，或關閉檢視器。",
  reconnect: "重新連線", closeViewer: "關閉檢視器", disconnect: "中斷連線", returnToDesktop: "返回遠端桌面",
  pictureInPicture: "子母畫面", resolution: "解析度", nativeResolution: "原生",
  backgroundViewing: "背景執行", backgroundLoadFailed: "無法載入背景執行偏好，請重試載入。",
  backgroundSaveFailed: "無法儲存背景執行偏好，仍採用上次已儲存的選擇。",
  rotate: "旋轉螢幕", rotating: "正在旋轉…", rotationFailed: "無法旋轉螢幕，請重試。",
  networkDirect: "直接連線", networkRelay: "中繼連線", networkVideo: "影片", networkScreenshot: "截圖",
  mouseButtons: "滑鼠按鈕", leftMouseButton: "滑鼠左鍵", rightMouseButton: "滑鼠右鍵", mouseWheel: "滑鼠滾輪",
  inputSettingsLoadFailed: "無法載入輸入偏好，請重試載入。", inputSettingsSaveFailed: "未能儲存輸入偏好，請重試儲存。",
  pointer: "觸控板", pointerHint: "移動手指控制指標，輕點執行點擊。", settings: "遠端桌面設定", closeSettings: "關閉設定",
  displayModesLoading: "正在載入解析度…", displayModesFailed: "無法載入解析度。",
  displayModeFailed: "無法確認解析度切換。",
  temporaryResolution: "暫時解析度；連線結束後恢復原顯示模式。", displayRestoreFailed: "無法確認原解析度恢復，請重新連線以重試恢復。",
  copyToPhone: "複製到手機", pasteFromPhone: "從手機貼上", clipboardTransferring: "正在傳輸剪貼簿…",
  clipboardSync: "剪貼簿同步", clipboardSyncHint: "目前頁面在前景且你擁有桌面控制權時，雙向同步可傳輸的文字、圖片與格式文字。裝置請求貼上權限時請允許。",
  clipboardSyncActive: "同步已啟用", clipboardSyncPaused: "同步已暫停",
  clipboardSyncLoadFailed: "無法載入同步偏好。可重試載入，或點選開關儲存新偏好。", clipboardSyncSaveFailed: "無法儲存同步偏好，仍採用上次已儲存的選擇。",
  clipboardSyncSkipped: "已略過無法同步的剪貼簿內容。重新複製支援的文字或圖片後可繼續同步。",
  clipboardSyncConflict: "兩端剪貼簿均已變更，已分別保留。請在任一裝置重新複製以同步。",
  clipboardSyncPermission: "同步已暫停。請允許貼上權限後重試，開關仍保持開啟。",
  clipboardSyncFailed: "同步暫時失敗，正在自動重試，開關仍保持開啟。",
  clipboardSyncUnknown: "剪貼簿操作尚未結束，等待結果期間暫停同步，不會重複寫入。",
  clipboardCopied: "已複製到此手機。", clipboardPasted: "已貼到桌面。", clipboardEmpty: "剪貼簿是空的。",
  clipboardUnsupported: "不支援此剪貼簿項目。", clipboardTooLarge: "此剪貼簿項目過大。",
  clipboardUnavailable: "此裝置不支援富剪貼簿傳輸。", clipboardBusy: "另一個剪貼簿傳輸正在進行。",
  clipboardFailed: "剪貼簿傳輸失敗。",
  takeover: "接管", permissionGuide: "顯示權限指引", connecting: "正在連線…",
  capturePending: "正在等待桌面批准螢幕共享…",
  reconnecting: "正在重新連線，保留最後一幀。", offline: "已離線", unsupported: "遠端桌面無法使用。",
  permission: "需要桌面權限。", revoked: "遠端桌面存取權已變更。", busy: "此桌面正在使用中。",
  stopped: "桌面已停止此工作階段。", error: "遠端桌面無法繼續。", rtc: "即時", jpeg: "相容視訊",
  noHosts: "沒有可用的桌面支援遠端桌面。", compatibility: "即時連線恢復期間正在使用相容視訊。",
  inputOverflow: "輸入佇列已滿，控制已釋放。", viewOnly: "此桌面僅支援檢視。",
  accessibilityPermission: "控制桌面需要輔助使用權限。", inputBusy: "桌面輸入忙碌中，檢視仍可繼續。",
  inputUnavailable: "桌面控制無法使用，檢視仍可繼續。",
  inputRecovering: "正在恢復桌面控制，檢視仍可繼續。",
  viewerRestarted: "檢視器已安全重新啟動，請重新取得控制以繼續輸入。",
  audioUnavailable: "桌面聲音無法使用，視訊將繼續靜音播放。",
  videoSettingsFailed: "無法套用視訊設定，目前畫面仍可繼續檢視。",
  pipUnavailable: "無法啟動子母畫面，請繼續在此檢視。"
};

const JA: MobileRemoteDesktopCopy = {
  ...EN, title: "リモートデスクトップ", back: "戻る", chooseDesktop: "デスクトップを選択",
  inputMethod: "入力方法", computerKeyboard: "コンピューターのキーボード", functionKeys: "ファンクションキー",
  comboMode: "組み合わせモード", closeKeyboard: "キーボードを閉じる", allWindows: "すべてのウィンドウ", showDesktop: "デスクトップを表示",
  workspaceLeft: "左のワークスペース", workspaceRight: "右のワークスペース", systemMenu: "システムメニュー",
  systemActionUpdating: "デスクトップを更新中…", systemActionFailed: "デスクトップ操作を確認できませんでした。表示は継続します。再試行してください。",
  chooseDisplay: "ディスプレイを選択", view: "表示", control: "操作", touch: "タッチ",
  permissionsTitle: "リモートデスクトップの権限", permissionsIntro: "画面の表示には画面収録、操作にはアクセシビリティの権限も必要です。コンピューターで許可すると、状態が自動更新されます。",
  permissionsReady: "システム権限の準備ができました。再接続できます。", screenRecording: "画面収録", accessibility: "アクセシビリティ",
  permissionChecking: "確認中…", permissionGranted: "許可済み", permissionNotRequired: "許可不要", permissionUnknown: "未確認", permissionMissing: "未許可",
  openGuideOnComputer: "コンピューターでガイドを開く", permissionGuideOpened: "コンピューターに権限ガイドを表示しました。そちらで続けてください。",
  permissionActionFailed: "権限ガイドを開けませんでした。コンピューターのリモート操作設定で再試行してください。",
  permissionCheckFailed: "権限を確認できません。コンピューターがオンラインか確認して再試行してください。",
  permissionGuideUnknown: "権限ガイドが開いたことを確認できませんでした。再試行する前にコンピューターを確認してください。", reconnectAfterPermissions: "確認して再接続",
  controls: "操作", displaySettings: "表示設定", security: "セキュリティ", panelBack: "操作パネルに戻る", panelClose: "パネルを閉じる",
  displaySwitching: "ディスプレイを切り替え中…", displaySwitchFailed: "前のディスプレイの切断を確認できませんでした。再試行して切断を完了してください。",
  displayUnavailable: "選択したディスプレイは利用できません。現在の一覧から選び直してください。",
  trackpad: "トラックパッド", pan: "移動", keyboard: "キーボード", fit: "画面に合わせる",
  fitDisplay: "表示をビューアーに合わせる", restoreDisplay: "ディスプレイを復元",
  left: "左クリック", right: "右クリック", release: "入力を解放", retry: "再試行", takeover: "引き継ぐ",
  frameRate: "フレームレート", quality: "画質", auto: "自動", saver: "データ節約", hd: "高画質",
  qualityHint: "自動は滑らかさを優先し、通信に余裕があれば鮮明にします。データ節約は通信量とフレームレートを 30 FPS に抑えます。高画質は文字の鮮明さを優先し、帯域が足りないときはフレームレートを下げます。",
  audioOn: "音声オン", audioOff: "音声オフ",
  hostMute: "デスクトップのスピーカーをミュート", hostMuteHint: "操作中はデスクトップの出力をミュートします。このデスクトップの設定を保存します。",
  hostMuteActive: "デスクトップのミュートを確認済み", hostMuteUnconfirmed: "デスクトップのミュートは未確認", hostMuteUpdating: "ミュートを更新中…",
  hostMuteLoadFailed: "ミュート設定を読み込めませんでした。再試行してください。", hostMuteSaveFailed: "ミュート設定を保存できませんでした。以前の設定を維持します。",
  hostMuteApplyFailed: "ミュートを確認できませんでした。表示は継続します。適用を再試行してください。",
  privacyScreen: "プライバシー画面", privacyScreenHint: "操作中はデスクトップの物理画面を保護します。このデスクトップの設定を保存します。",
  privacyScreenActive: "プライバシー画面を確認済み", privacyScreenUnconfirmed: "プライバシー画面は未確認", privacyScreenUpdating: "プライバシー画面を更新中…",
  privacyScreenLoadFailed: "プライバシー設定を読み込めませんでした。再試行するか、新しい設定を保存してください。", privacyScreenSaveFailed: "プライバシー設定を保存できませんでした。以前の設定を維持します。",
  privacyScreenApplyFailed: "プライバシー画面を確認できませんでした。表示は継続します。設定を切り替えて再試行してください。",
  lockOnExit: "終了時にデスクトップをロック", lockOnExitHint: "切断時、またはこの画面を離れた後にピクチャ・イン・ピクチャが終了したときにロックします。",
  lockPreferenceLoadFailed: "終了時のロック設定を読み込めませんでした。再試行してください。", lockPreferenceSaveFailed: "終了時のロック設定を保存できませんでした。以前の設定を維持します。",
  lockingOnExit: "デスクトップをロックして切断中…", disconnecting: "切断中…",
  lockExpired: "終了権限が失効しました。ロックは未確認です。新しいセッションに再接続するか、ビューアーを閉じてください。",
  lockUnavailable: "ロックを利用できず、確認できませんでした。再接続するか、ビューアーを閉じてください。",
  lockFailed: "ロックに失敗しました。新しいセッションに再接続するか、ビューアーを閉じてください。", exitFailed: "切断を確認できませんでした。新しいセッションに再接続するか、ビューアーを閉じてください。",
  reconnect: "再接続", closeViewer: "ビューアーを閉じる", disconnect: "切断", returnToDesktop: "リモートデスクトップに戻る",
  pictureInPicture: "ピクチャ・イン・ピクチャ", resolution: "解像度", nativeResolution: "ネイティブ",
  backgroundViewing: "バックグラウンドで実行", backgroundLoadFailed: "バックグラウンド設定を読み込めませんでした。再試行してください。",
  backgroundSaveFailed: "バックグラウンド設定を保存できませんでした。保存済みの設定を維持します。",
  rotate: "画面を回転", rotating: "回転中…", rotationFailed: "画面を回転できませんでした。再試行してください。",
  networkDirect: "直接接続", networkRelay: "中継接続", networkVideo: "動画", networkScreenshot: "スクリーンショット",
  mouseButtons: "マウスボタン", leftMouseButton: "左マウスボタン", rightMouseButton: "右マウスボタン", mouseWheel: "マウスホイール",
  inputSettingsLoadFailed: "入力設定を読み込めませんでした。再試行してください。", inputSettingsSaveFailed: "入力設定を保存できませんでした。再試行してください。",
  pointer: "タッチパッド", pointerHint: "指を動かしてポインターを移動し、タップしてクリックします。", settings: "リモートデスクトップ設定", closeSettings: "設定を閉じる",
  displayModesLoading: "解像度を読み込み中…", displayModesFailed: "解像度を読み込めませんでした。",
  displayModeFailed: "解像度の変更を確認できませんでした。",
  temporaryResolution: "一時的な解像度です。接続終了時に元のモードを復元します。", displayRestoreFailed: "元の解像度を復元できませんでした。再接続して復元を再試行してください。",
  copyToPhone: "スマートフォンにコピー", pasteFromPhone: "スマートフォンから貼り付け",
  clipboardSync: "クリップボード同期", clipboardSyncHint: "この画面が前面にあり、デスクトップを操作中にテキスト、画像、書式付きテキストを双方向に同期します。ペーストの許可を求められたら許可してください。",
  clipboardSyncActive: "同期中", clipboardSyncPaused: "同期を一時停止",
  clipboardSyncLoadFailed: "同期設定を読み込めませんでした。再試行するか、スイッチで新しい設定を保存してください。", clipboardSyncSaveFailed: "同期設定を保存できませんでした。保存済みの設定を維持します。",
  clipboardSyncSkipped: "同期できない内容をスキップしました。対応するテキストや画像をコピーすると同期を再開します。",
  clipboardSyncConflict: "両方のクリップボードが変更され、それぞれ保持されています。どちらかでもう一度コピーしてください。",
  clipboardSyncPermission: "同期を一時停止しました。ペーストを許可してから再試行してください。設定はオンのままです。",
  clipboardSyncFailed: "同期に一時的に失敗しました。自動で再試行し、設定はオンのままです。",
  clipboardSyncUnknown: "クリップボードの処理が完了していません。結果が分かるまで同期を停止し、書き込みは繰り返しません。",
  clipboardTransferring: "クリップボードを転送中…", clipboardCopied: "このスマートフォンにコピーしました。",
  clipboardPasted: "デスクトップに貼り付けました。", clipboardEmpty: "クリップボードは空です。",
  clipboardUnsupported: "このクリップボード項目には対応していません。",
  clipboardTooLarge: "このクリップボード項目は大きすぎます。",
  clipboardUnavailable: "このデバイスではリッチクリップボード転送を利用できません。",
  clipboardBusy: "別のクリップボード転送が進行中です。", clipboardFailed: "クリップボード転送に失敗しました。",
  permissionGuide: "権限ガイドを表示", connecting: "接続中…", reconnecting: "再接続中 — 最後のフレームを表示しています。",
  capturePending: "デスクトップで画面共有が許可されるのを待っています…",
  offline: "オフライン", unsupported: "リモートデスクトップを利用できません。", permission: "デスクトップ側の権限が必要です。",
  revoked: "アクセス権が変更されました。", busy: "このデスクトップは使用中です。", stopped: "デスクトップがセッションを停止しました。",
  error: "リモートデスクトップを続行できません。", rtc: "ライブ", jpeg: "互換映像",
  noHosts: "リモートデスクトップを利用できるデスクトップがありません。",
  compatibility: "ライブ接続の回復中は互換映像を使用しています。", inputOverflow: "入力キューが一杯になったため操作を解除しました。",
  viewOnly: "このデスクトップは表示専用です。", accessibilityPermission: "操作するにはデスクトップ側でアクセシビリティ権限が必要です。",
  inputBusy: "デスクトップ入力は使用中です。表示は続行できます。", inputUnavailable: "デスクトップを操作できません。表示は続行できます。",
  inputRecovering: "デスクトップ操作を復元中… 表示は続行できます。",
  viewerRestarted: "ビューアーを安全に再起動しました。入力を続けるにはもう一度操作を有効にしてください。",
  audioUnavailable: "デスクトップ音声を利用できません。映像は無音で続行します。",
  videoSettingsFailed: "映像設定を適用できませんでした。現在の表示はそのまま利用できます。",
  pipUnavailable: "ピクチャ・イン・ピクチャを開始できません。ここで表示を続けてください。"
};

const KO: MobileRemoteDesktopCopy = {
  ...EN, permissionsTitle: "원격 데스크톱 권한", permissionsIntro: "데스크톱을 보려면 화면 기록 권한이, 조작하려면 손쉬운 사용 권한도 필요합니다. 컴퓨터에서 허용하면 상태가 자동으로 갱신됩니다.",
  permissionsReady: "시스템 권한이 준비되었습니다. 다시 연결할 수 있습니다.", screenRecording: "화면 기록", accessibility: "손쉬운 사용",
  permissionChecking: "확인 중…", permissionGranted: "허용됨", permissionNotRequired: "권한 불필요", permissionUnknown: "확인되지 않음", permissionMissing: "허용되지 않음",
  openGuideOnComputer: "컴퓨터에서 권한 안내 열기", permissionGuideOpened: "컴퓨터에 권한 안내를 표시했습니다. 컴퓨터에서 계속하세요.",
  permissionActionFailed: "권한 안내를 열지 못했습니다. 컴퓨터의 원격 제어 설정에서 다시 시도하세요.", permissionCheckFailed: "권한을 확인하지 못했습니다. 컴퓨터가 온라인인지 확인하고 다시 시도하세요.",
  permissionGuideUnknown: "권한 안내가 열렸는지 확인하지 못했습니다. 다시 시도하기 전에 컴퓨터를 확인하세요.", reconnectAfterPermissions: "확인 후 다시 연결",
  controls: "조작", displaySettings: "디스플레이 설정", security: "보안", panelBack: "조작 패널로 돌아가기", panelClose: "패널 닫기",
  displaySwitching: "디스플레이 전환 중…", displaySwitchFailed: "이전 디스플레이 연결 해제를 확인하지 못했습니다. 다시 시도하여 연결 해제를 완료하세요.",
  displayUnavailable: "선택한 디스플레이를 사용할 수 없습니다. 현재 목록에서 다시 선택하세요.",
  title: "원격 데스크톱", back: "뒤로", chooseDesktop: "데스크톱 선택", chooseDisplay: "디스플레이 선택",
  inputMethod: "입력 방식", computerKeyboard: "컴퓨터 키보드", functionKeys: "기능 키",
  comboMode: "조합 모드", closeKeyboard: "키보드 닫기", allWindows: "모든 창", showDesktop: "데스크톱 표시",
  workspaceLeft: "왼쪽 작업 공간", workspaceRight: "오른쪽 작업 공간", systemMenu: "시스템 메뉴",
  systemActionUpdating: "데스크톱 업데이트 중…", systemActionFailed: "데스크톱 작업을 확인하지 못했습니다. 화면은 계속 볼 수 있습니다. 다시 시도하세요.",
  view: "보기", control: "제어", touch: "터치", trackpad: "트랙패드", pan: "이동", keyboard: "키보드",
  fit: "화면 맞춤", left: "왼쪽", right: "오른쪽", release: "입력 해제", retry: "다시 시도",
  fitDisplay: "뷰어에 디스플레이 맞춤", restoreDisplay: "디스플레이 복원",
  frameRate: "프레임 속도", quality: "화질", auto: "자동", saver: "데이터 절약", hd: "고화질",
  qualityHint: "자동은 부드러움을 우선하고 네트워크가 허용하면 더 선명하게 표시합니다. 데이터 절약은 사용량과 프레임 속도를 30 FPS로 제한합니다. 고화질은 글자 선명도를 우선하며 대역폭이 부족하면 프레임 속도를 낮춥니다.",
  audioOn: "오디오 켜짐", audioOff: "오디오 꺼짐",
  hostMute: "데스크톱 스피커 음소거", hostMuteHint: "제어 중 데스크톱 출력을 음소거합니다. 이 데스크톱의 설정을 저장합니다.",
  hostMuteActive: "데스크톱 음소거 확인됨", hostMuteUnconfirmed: "데스크톱 음소거 미확인", hostMuteUpdating: "음소거 업데이트 중…",
  hostMuteLoadFailed: "음소거 설정을 불러오지 못했습니다. 다시 시도하세요.", hostMuteSaveFailed: "음소거 설정을 저장하지 못했습니다. 이전 설정이 유지됩니다.",
  hostMuteApplyFailed: "음소거를 확인하지 못했습니다. 보기는 계속됩니다. 적용을 다시 시도하세요.",
  privacyScreen: "개인정보 보호 화면", privacyScreenHint: "제어 중 데스크톱의 물리 화면을 보호합니다. 이 데스크톱의 설정을 저장합니다.",
  privacyScreenActive: "개인정보 보호 화면 확인됨", privacyScreenUnconfirmed: "개인정보 보호 화면 미확인", privacyScreenUpdating: "개인정보 보호 화면 업데이트 중…",
  privacyScreenLoadFailed: "개인정보 보호 설정을 불러오지 못했습니다. 다시 시도하거나 새 설정을 저장하세요.", privacyScreenSaveFailed: "개인정보 보호 설정을 저장하지 못했습니다. 이전 설정이 유지됩니다.",
  privacyScreenApplyFailed: "개인정보 보호 화면을 확인하지 못했습니다. 보기는 계속됩니다. 설정을 전환하여 다시 시도하세요.",
  lockOnExit: "종료 시 데스크톱 잠금", lockOnExitHint: "연결을 끊거나 이 페이지를 떠난 후 화면 속 화면이 종료될 때 데스크톱을 잠급니다.",
  lockPreferenceLoadFailed: "종료 잠금 설정을 불러오지 못했습니다. 다시 시도하세요.", lockPreferenceSaveFailed: "종료 잠금 설정을 저장하지 못했습니다. 이전 설정이 유지됩니다.",
  lockingOnExit: "데스크톱을 잠그고 연결을 끊는 중…", disconnecting: "연결 끊는 중…",
  lockExpired: "종료 권한이 만료되어 잠금을 확인하지 못했습니다. 새 세션에 다시 연결하거나 뷰어를 닫으세요.",
  lockUnavailable: "데스크톱 잠금을 사용할 수 없으며 확인되지 않았습니다. 다시 연결하거나 뷰어를 닫으세요.",
  lockFailed: "잠금에 실패했습니다. 새 세션에 다시 연결하거나 뷰어를 닫으세요.", exitFailed: "연결 해제를 확인하지 못했습니다. 새 세션에 다시 연결하거나 뷰어를 닫으세요.",
  reconnect: "다시 연결", closeViewer: "뷰어 닫기", disconnect: "연결 끊기", returnToDesktop: "원격 데스크톱으로 돌아가기",
  pictureInPicture: "화면 속 화면", resolution: "해상도", nativeResolution: "기본",
  backgroundViewing: "백그라운드 실행", backgroundLoadFailed: "백그라운드 설정을 불러오지 못했습니다. 다시 시도하세요.",
  backgroundSaveFailed: "백그라운드 설정을 저장하지 못했습니다. 저장된 설정이 유지됩니다.",
  rotate: "화면 회전", rotating: "회전 중…", rotationFailed: "화면을 회전하지 못했습니다. 다시 시도하세요.",
  networkDirect: "직접 연결", networkRelay: "중계 연결", networkVideo: "동영상", networkScreenshot: "스크린샷",
  mouseButtons: "마우스 버튼", leftMouseButton: "왼쪽 마우스 버튼", rightMouseButton: "오른쪽 마우스 버튼", mouseWheel: "마우스 휠",
  inputSettingsLoadFailed: "입력 설정을 불러오지 못했습니다. 다시 시도하세요.", inputSettingsSaveFailed: "입력 설정을 저장하지 못했습니다. 다시 시도하세요.",
  pointer: "터치패드", pointerHint: "손가락을 움직여 포인터를 이동하고 탭하여 클릭하세요.", settings: "원격 데스크톱 설정", closeSettings: "설정 닫기",
  displayModesLoading: "해상도 불러오는 중…", displayModesFailed: "해상도를 불러오지 못했습니다.",
  displayModeFailed: "해상도 변경을 확인하지 못했습니다.",
  temporaryResolution: "임시 해상도입니다. 연결이 끝나면 원래 모드로 복원합니다.", displayRestoreFailed: "원래 해상도를 복원하지 못했습니다. 다시 연결하여 복원을 재시도하세요.",
  copyToPhone: "휴대전화로 복사", pasteFromPhone: "휴대전화에서 붙여넣기",
  clipboardSync: "클립보드 동기화", clipboardSyncHint: "이 화면이 전면에 있고 데스크톱을 제어하는 동안 텍스트, 이미지, 서식 있는 텍스트를 양방향으로 동기화합니다. 붙여넣기 권한을 요청하면 허용해 주세요.",
  clipboardSyncActive: "동기화 중", clipboardSyncPaused: "동기화 일시 중지",
  clipboardSyncLoadFailed: "동기화 설정을 불러오지 못했습니다. 다시 시도하거나 스위치로 새 설정을 저장하세요.", clipboardSyncSaveFailed: "동기화 설정을 저장하지 못했습니다. 이전에 저장한 설정이 유지됩니다.",
  clipboardSyncSkipped: "동기화할 수 없는 내용을 건너뛰었습니다. 지원되는 텍스트나 이미지를 복사하면 계속 동기화됩니다.",
  clipboardSyncConflict: "양쪽 클립보드가 변경되어 각각 유지되었습니다. 어느 기기에서든 다시 복사하세요.",
  clipboardSyncPermission: "동기화가 일시 중지되었습니다. 붙여넣기를 허용한 후 다시 시도하세요. 설정은 켜진 상태로 유지됩니다.",
  clipboardSyncFailed: "동기화가 일시적으로 실패했습니다. 자동으로 다시 시도하며 설정은 켜진 상태로 유지됩니다.",
  clipboardSyncUnknown: "클립보드 작업이 끝나지 않았습니다. 결과를 확인할 때까지 동기화를 중지하며 쓰기를 반복하지 않습니다.",
  clipboardTransferring: "클립보드 전송 중…", clipboardCopied: "이 휴대전화에 복사했습니다.",
  clipboardPasted: "데스크톱에 붙여넣었습니다.", clipboardEmpty: "클립보드가 비어 있습니다.",
  clipboardUnsupported: "이 클립보드 항목은 지원되지 않습니다.",
  clipboardTooLarge: "이 클립보드 항목이 너무 큽니다.",
  clipboardUnavailable: "이 기기에서는 리치 클립보드 전송을 사용할 수 없습니다.",
  clipboardBusy: "다른 클립보드 전송이 진행 중입니다.", clipboardFailed: "클립보드 전송에 실패했습니다.",
  takeover: "인계받기", permissionGuide: "권한 안내 표시", connecting: "연결 중…",
  capturePending: "데스크톱에서 화면 공유를 승인할 때까지 기다리는 중…",
  reconnecting: "다시 연결 중 — 마지막 프레임을 유지합니다.", offline: "오프라인",
  unsupported: "원격 데스크톱을 사용할 수 없습니다.", permission: "데스크톱 권한이 필요합니다.",
  revoked: "원격 데스크톱 접근 권한이 변경되었습니다.", busy: "이 데스크톱은 사용 중입니다.",
  stopped: "데스크톱이 세션을 중지했습니다.", error: "원격 데스크톱을 계속할 수 없습니다.", rtc: "라이브", jpeg: "호환 영상",
  noHosts: "원격 데스크톱을 지원하는 사용 가능한 데스크톱이 없습니다.", compatibility: "라이브 연결이 복구되는 동안 호환 영상을 사용합니다.",
  inputOverflow: "입력 대기열이 가득 차 제어를 해제했습니다.", viewOnly: "이 데스크톱은 보기 전용입니다.",
  accessibilityPermission: "제어하려면 데스크톱의 손쉬운 사용 권한이 필요합니다.", inputBusy: "데스크톱 입력이 사용 중입니다. 보기는 계속됩니다.",
  inputUnavailable: "데스크톱 제어를 사용할 수 없습니다. 보기는 계속됩니다.",
  inputRecovering: "데스크톱 제어 복구 중… 보기는 계속됩니다.",
  viewerRestarted: "뷰어를 안전하게 다시 시작했습니다. 입력을 계속하려면 제어를 다시 켜세요.",
  audioUnavailable: "데스크톱 오디오를 사용할 수 없습니다. 영상은 음소거 상태로 계속됩니다.",
  videoSettingsFailed: "영상 설정을 적용하지 못했습니다. 현재 화면은 계속 볼 수 있습니다.",
  pipUnavailable: "화면 속 화면을 시작하지 못했습니다. 여기에서 계속 시청하세요."
};

export function mobileRemoteDesktopCopy(locale: MobileSupportedLocale): MobileRemoteDesktopCopy {
  return locale === "zh-CN" ? ZH_CN : locale === "zh-TW" ? ZH_TW : locale === "ja" ? JA : locale === "ko" ? KO : EN;
}

export function mobileRemoteDesktopStatusLabel(snapshot: MobileRemoteDesktopSnapshot, copy: MobileRemoteDesktopCopy): string {
  if (snapshot.status === "capture-pending") return copy.capturePending;
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
  if (notice === "capture-pending") return copy.capturePending;
  if (notice === "no-hosts") return copy.noHosts;
  if (notice === "compatibility") return copy.compatibility;
  if (notice === "input-overflow") return copy.inputOverflow;
  if (notice === "view-only") return copy.viewOnly;
  if (notice === "accessibility-permission") return copy.accessibilityPermission;
  if (notice === "input-busy") return copy.inputBusy;
  if (notice === "input-unavailable") return copy.inputUnavailable;
  if (notice === "input-recovering") return copy.inputRecovering;
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

const CREDENTIAL_EN = {
  autoUnlock: "Auto unlock", autoUnlockHint: "Unlock the remote computer using credentials saved on this device.",
  biometric: "Face ID verification", storage: "The password is entered and stored securely by the operating system.",
  pending: "Updating saved unlock settings…", unavailable: "Native unlock is unavailable. Viewing continues.",
  signing: "Native unlock requires a properly signed application and helper.", password: "The saved password was rejected. Retry to set it up again.",
  identity: "The device identity changed. Check the selected devices and set up unlock again.",
  permission: "Native unlock requires permission on the host.", expired: "The unlock session expired. Retry to start a new session.",
  busy: "Another native authentication is still pending. Try again after it finishes."
};
type MobileCredentialCopy = Record<keyof typeof CREDENTIAL_EN, string>;
const CREDENTIAL_COPY: Readonly<Record<MobileSupportedLocale, MobileCredentialCopy>> = {
  en: CREDENTIAL_EN,
  "zh-CN": {
    autoUnlock: "自动解锁", autoUnlockHint: "使用本机保存的凭据解锁远程电脑。", biometric: "Face ID 验证",
    storage: "密码由操作系统原生输入并安全保存。", pending: "正在更新已保存的解锁设置…", unavailable: "原生解锁当前不可用，查看仍继续。",
    signing: "原生解锁需要正确签名的应用与辅助程序。", password: "已保存的密码被拒绝，请重试以重新设置。",
    identity: "设备身份已变化，请确认所选设备并重新设置解锁。", permission: "原生解锁需要主机上的权限。",
    expired: "解锁会话已过期，请重试以开启新会话。", busy: "另一项原生认证仍未结束，请在完成后重试。"
  },
  "zh-TW": {
    autoUnlock: "自動解鎖", autoUnlockHint: "使用本機儲存的憑證解鎖遠端電腦。", biometric: "Face ID 驗證",
    storage: "密碼由作業系統原生輸入並安全儲存。", pending: "正在更新已儲存的解鎖設定…", unavailable: "原生解鎖目前無法使用，檢視仍繼續。",
    signing: "原生解鎖需要正確簽署的應用程式與輔助程式。", password: "已儲存的密碼遭拒，請重試以重新設定。",
    identity: "裝置身分已變更，請確認所選裝置並重新設定解鎖。", permission: "原生解鎖需要主機上的權限。",
    expired: "解鎖工作階段已過期，請重試以開啟新工作階段。", busy: "另一項原生認證尚未結束，請在完成後重試。"
  },
  ja: {
    autoUnlock: "自動ロック解除", autoUnlockHint: "端末に保存した資格情報でリモートコンピューターのロックを解除します。", biometric: "Face ID 認証",
    storage: "パスワードの入力と安全な保存は OS が行います。", pending: "保存したロック解除設定を更新中…", unavailable: "ネイティブのロック解除を利用できません。表示は続行します。",
    signing: "ネイティブのロック解除には正しく署名されたアプリとヘルパーが必要です。", password: "保存したパスワードが拒否されました。再試行して設定し直してください。",
    identity: "端末の識別情報が変わりました。選択した端末を確認し、ロック解除を設定し直してください。", permission: "ネイティブのロック解除にはホストの権限が必要です。",
    expired: "ロック解除セッションの期限が切れました。再試行して新しいセッションを開始してください。", busy: "別のネイティブ認証がまだ処理中です。完了後に再試行してください。"
  },
  ko: {
    autoUnlock: "자동 잠금 해제", autoUnlockHint: "이 기기에 저장한 자격 증명으로 원격 컴퓨터의 잠금을 해제합니다.", biometric: "Face ID 인증",
    storage: "암호 입력과 안전한 저장은 운영 체제에서 처리합니다.", pending: "저장된 잠금 해제 설정 업데이트 중…", unavailable: "기본 잠금 해제를 사용할 수 없습니다. 화면 보기는 계속됩니다.",
    signing: "기본 잠금 해제에는 올바르게 서명된 앱과 도우미가 필요합니다.", password: "저장된 암호가 거부되었습니다. 다시 시도하여 설정하세요.",
    identity: "기기 식별 정보가 변경되었습니다. 선택한 기기를 확인하고 잠금 해제를 다시 설정하세요.", permission: "기본 잠금 해제에는 호스트의 권한이 필요합니다.",
    expired: "잠금 해제 세션이 만료되었습니다. 다시 시도하여 새 세션을 시작하세요.", busy: "다른 기본 인증이 아직 진행 중입니다. 완료된 뒤 다시 시도하세요."
  }
};
export function mobileRemoteDesktopCredentialCopy(locale: MobileSupportedLocale): MobileCredentialCopy { return CREDENTIAL_COPY[locale]; }

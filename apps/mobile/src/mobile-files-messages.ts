import type { MobileSupportedLocale } from "./mobile-locale-preference";

const en = {
  "files.presentation.itemOptions": "File options for {name}", "files.presentation.copyPath": "Copy relative path", "files.presentation.copyName": "Copy filename",
  "files.presentation.copied": "Copied.", "files.presentation.copyFailed": "Could not copy. Try again.", "files.presentation.copyUnknown": "Copy result is unknown. Wait before trying again.",
  "files.presentation.copyBusy": "A clipboard operation is still in progress.", "files.presentation.copying": "Copying…",
  "files.presentation.options": "Display and sorting",
  "files.presentation.optionsFor": "Folder options for {name}",
  "files.presentation.view": "View", "files.presentation.sort": "Sort by", "files.presentation.path": "Location",
  "files.presentation.grid": "Grid", "files.presentation.list": "List", "files.presentation.sortName": "Name",
  "files.presentation.sortModified": "Date modified", "files.presentation.sortSize": "Size",
  "files.presentation.today": "Today {time}", "files.presentation.yesterday": "Yesterday {time}",
  "files.presentation.folderOne": "{count} folder", "files.presentation.folderMany": "{count} folders",
  "files.presentation.fileOne": "{count} file", "files.presentation.fileMany": "{count} files",
  "files.presentation.preferenceError": "Display preferences could not be loaded or saved. Try again."
} as const;
type Catalog = { readonly [K in keyof typeof en]: string };
export const mobileFilesMessages: Readonly<Record<MobileSupportedLocale, Catalog>> = {
  en,
  "zh-CN": {
    "files.presentation.itemOptions": "{name} 的文件选项", "files.presentation.copyPath": "复制相对路径", "files.presentation.copyName": "复制文件名",
    "files.presentation.copied": "已复制。", "files.presentation.copyFailed": "无法复制，请重试。", "files.presentation.copyUnknown": "复制结果未知，请稍后重试。",
    "files.presentation.copyBusy": "剪贴板操作仍在进行中。", "files.presentation.copying": "正在复制…",
    "files.presentation.options": "显示与排序", "files.presentation.optionsFor": "{name} 的文件夹选项",
    "files.presentation.view": "视图", "files.presentation.sort": "排序方式", "files.presentation.path": "位置",
    "files.presentation.grid": "网格", "files.presentation.list": "列表", "files.presentation.sortName": "名称",
    "files.presentation.sortModified": "修改时间", "files.presentation.sortSize": "大小",
    "files.presentation.today": "今天 {time}", "files.presentation.yesterday": "昨天 {time}",
    "files.presentation.folderOne": "{count} 个文件夹", "files.presentation.folderMany": "{count} 个文件夹",
    "files.presentation.fileOne": "{count} 个文件", "files.presentation.fileMany": "{count} 个文件",
    "files.presentation.preferenceError": "无法读取或保存显示偏好，请重试。"
  },
  "zh-TW": {
    "files.presentation.itemOptions": "{name} 的檔案選項", "files.presentation.copyPath": "複製相對路徑", "files.presentation.copyName": "複製檔案名稱",
    "files.presentation.copied": "已複製。", "files.presentation.copyFailed": "無法複製，請重試。", "files.presentation.copyUnknown": "複製結果未知，請稍後重試。",
    "files.presentation.copyBusy": "剪貼簿操作仍在進行中。", "files.presentation.copying": "正在複製…",
    "files.presentation.options": "顯示與排序", "files.presentation.optionsFor": "{name} 的資料夾選項",
    "files.presentation.view": "檢視", "files.presentation.sort": "排序方式", "files.presentation.path": "位置",
    "files.presentation.grid": "網格", "files.presentation.list": "列表", "files.presentation.sortName": "名稱",
    "files.presentation.sortModified": "修改時間", "files.presentation.sortSize": "大小",
    "files.presentation.today": "今天 {time}", "files.presentation.yesterday": "昨天 {time}",
    "files.presentation.folderOne": "{count} 個資料夾", "files.presentation.folderMany": "{count} 個資料夾",
    "files.presentation.fileOne": "{count} 個檔案", "files.presentation.fileMany": "{count} 個檔案",
    "files.presentation.preferenceError": "無法讀取或儲存顯示偏好，請重試。"
  },
  ja: {
    "files.presentation.itemOptions": "{name} のファイル操作", "files.presentation.copyPath": "相対パスをコピー", "files.presentation.copyName": "ファイル名をコピー",
    "files.presentation.copied": "コピーしました。", "files.presentation.copyFailed": "コピーできませんでした。もう一度お試しください。", "files.presentation.copyUnknown": "コピーの結果を確認できません。しばらくしてからお試しください。",
    "files.presentation.copyBusy": "クリップボードの操作がまだ進行中です。", "files.presentation.copying": "コピー中…",
    "files.presentation.options": "表示と並べ替え", "files.presentation.optionsFor": "{name} のフォルダ設定",
    "files.presentation.view": "表示", "files.presentation.sort": "並べ替え", "files.presentation.path": "場所",
    "files.presentation.grid": "グリッド", "files.presentation.list": "リスト", "files.presentation.sortName": "名前",
    "files.presentation.sortModified": "更新日時", "files.presentation.sortSize": "サイズ",
    "files.presentation.today": "今日 {time}", "files.presentation.yesterday": "昨日 {time}",
    "files.presentation.folderOne": "フォルダ {count} 件", "files.presentation.folderMany": "フォルダ {count} 件",
    "files.presentation.fileOne": "ファイル {count} 件", "files.presentation.fileMany": "ファイル {count} 件",
    "files.presentation.preferenceError": "表示設定を読み込む、または保存することができませんでした。もう一度お試しください。"
  },
  ko: {
    "files.presentation.itemOptions": "{name} 파일 옵션", "files.presentation.copyPath": "상대 경로 복사", "files.presentation.copyName": "파일 이름 복사",
    "files.presentation.copied": "복사했습니다.", "files.presentation.copyFailed": "복사할 수 없습니다. 다시 시도하세요.", "files.presentation.copyUnknown": "복사 결과를 확인할 수 없습니다. 잠시 후 다시 시도하세요.",
    "files.presentation.copyBusy": "클립보드 작업이 아직 진행 중입니다.", "files.presentation.copying": "복사 중…",
    "files.presentation.options": "표시 및 정렬", "files.presentation.optionsFor": "{name} 폴더 옵션",
    "files.presentation.view": "보기", "files.presentation.sort": "정렬 기준", "files.presentation.path": "위치",
    "files.presentation.grid": "격자", "files.presentation.list": "목록", "files.presentation.sortName": "이름",
    "files.presentation.sortModified": "수정 날짜", "files.presentation.sortSize": "크기",
    "files.presentation.today": "오늘 {time}", "files.presentation.yesterday": "어제 {time}",
    "files.presentation.folderOne": "폴더 {count}개", "files.presentation.folderMany": "폴더 {count}개",
    "files.presentation.fileOne": "파일 {count}개", "files.presentation.fileMany": "파일 {count}개",
    "files.presentation.preferenceError": "표시 설정을 읽거나 저장할 수 없습니다. 다시 시도하세요."
  }
};

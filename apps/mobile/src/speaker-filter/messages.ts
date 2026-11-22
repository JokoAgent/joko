import type { MobileSupportedLocale } from "../mobile-locale-preference";

const en = {
  title: "Recognize my voice", navigation: "Filter other voices during dictation on this phone.",
  description: "Record three short clips to create a voiceprint. The clips and voiceprint stay on this phone.",
  download: "Download voice models ({size} MB)", downloading: "Downloading voice models…", cancelDownload: "Cancel download",
  record: "Record clip {clip} of 3", finish: "Finish recording", discard: "Discard recordings",
  instruction: "Read a few sentences in your normal voice with no one else speaking.",
  enroll: "Save voiceprint", enrolled: "Voiceprint saved on this phone", remove: "Delete voiceprint",
  removeConfirm: "Delete the saved voiceprint for this connection?", recordAgain: "Record a new voiceprint",
  cancelReplacement: "Cancel re-enrollment", unsupported: "Speaker filtering is unavailable in this app build.",
  enabled: "Filter other voices", strength: "Filter strength",
  relaxed: "Relaxed", standard: "Standard", strict: "Strict", useDefault: "Follow default ({strength})",
  clipInvalid: "Record clip {clip} again with at least two seconds of clear speech.",
  inconsistent: "Use the same speaker and record the clips again in a quiet place.",
  error: "Couldn't complete the voice filter action. Check the microphone or try again.",
  filtered: "Another voice was filtered.",
  unavailable: "The voice filter is unavailable. This dictation is unfiltered."
};
const cn: typeof en = {
  title: "识别我的声音", navigation: "在这部手机听写时过滤其他人的声音。",
  description: "录制三段短语音以创建声纹。录音和声纹仅保存在这部手机上。",
  download: "下载语音模型（{size} MB）", downloading: "正在下载语音模型…", cancelDownload: "取消下载",
  record: "录制第 {clip} 段，共 3 段", finish: "结束录制", discard: "放弃录音",
  instruction: "请用平常的声音读几句话，并让其他人暂时保持安静。",
  enroll: "保存声纹", enrolled: "声纹已保存在这部手机", remove: "删除声纹",
  removeConfirm: "删除为此连接保存的声纹？", recordAgain: "重新录入声纹",
  cancelReplacement: "取消重新录入", unsupported: "此应用版本暂不支持说话人过滤。",
  enabled: "过滤其他人的声音", strength: "过滤强度",
  relaxed: "宽松", standard: "标准", strict: "严格", useDefault: "跟随默认值（{strength}）",
  clipInvalid: "请重录第 {clip} 段，确保至少有两秒清晰语音。",
  inconsistent: "请由同一人在安静的环境中重录三段语音。",
  error: "语音过滤操作未完成。请检查麦克风或重试。",
  filtered: "已过滤其他人的声音。",
  unavailable: "语音过滤暂不可用，本次听写未经过滤。"
};

export function mobileSpeakerMessage(locale: MobileSupportedLocale, key: keyof typeof en, value?: number | string): string {
  const message = (locale === "zh-CN" ? cn : en)[key];
  return value === undefined ? message : message.replace(/\{(?:clip|size|strength)\}/u, String(value));
}

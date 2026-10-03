import { create } from "@bufbuild/protobuf";
import {
  VoiceInputSaucAuthentication, VoiceInputSaucMode, VoiceInputSaucSettingsSchema,
  type VoiceInputSaucSettings
} from "./gen/joko/v1/settings_pb.js";

export interface VoiceInputSaucSettingsView {
  readonly mode: "asyncTwoPass" | "bidirectional" | "streamInput";
  readonly authentication: "apiKey" | "accessToken";
  readonly appId: string;
  readonly useDictionaryHotwords: boolean;
  readonly boostingTableName: string;
  readonly boostingTableId: string;
  readonly correctTableName: string;
  readonly correctTableId: string;
}

export interface VoiceInputRecognitionContextView {
  readonly contextData: readonly { readonly text: string }[];
}

export const VOICE_RECOGNITION_CONTEXT_MAXIMUM_ITEMS = 20;
export const VOICE_RECOGNITION_CONTEXT_MAXIMUM_ITEM_BYTES = 2_048;
export const VOICE_RECOGNITION_CONTEXT_MAXIMUM_BYTES = 8_192;

export function voiceInputRecognitionContextFromTexts(values: readonly string[], limits = {
  recognitionContextMaximumItems: VOICE_RECOGNITION_CONTEXT_MAXIMUM_ITEMS,
  recognitionContextMaximumItemBytes: VOICE_RECOGNITION_CONTEXT_MAXIMUM_ITEM_BYTES,
  recognitionContextMaximumBytes: VOICE_RECOGNITION_CONTEXT_MAXIMUM_BYTES
}): VoiceInputRecognitionContextView | undefined {
  if (values.length === 0) return undefined;
  const encoder = new TextEncoder();
  let bytes = 0;
  if (values.length > limits.recognitionContextMaximumItems) throw new TypeError("Recognition context has too many items.");
  const contextData = values.map((text) => {
    if (typeof text !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) throw new TypeError("Recognition context text is invalid.");
    const normalized = text.replace(/\r\n?/gu, "\n").trim();
    if (normalized === "") throw new TypeError("Recognition context text is empty.");
    const size = encoder.encode(normalized).byteLength;
    bytes += size;
    if (size > limits.recognitionContextMaximumItemBytes || bytes > limits.recognitionContextMaximumBytes) {
      throw new TypeError("Recognition context exceeds its UTF-8 byte limit.");
    }
    return Object.freeze({ text: normalized });
  });
  return Object.freeze({ contextData: Object.freeze(contextData) });
}

export function voiceInputRecognitionLocale(locale: string | undefined, capability: {
  readonly supportsLocale: boolean; readonly supportedLocales: readonly string[];
}): string | undefined {
  if (!capability.supportsLocale || locale === undefined) return undefined;
  if (capability.supportedLocales.length === 0) return locale;
  if (capability.supportedLocales.includes(locale)) return locale;
  // Device preferences also offer language-only selections. Resolve those to
  // a single advertised region without rewriting the user's local preference.
  if (!locale.includes("-")) {
    const matches = capability.supportedLocales.filter((value) => value.split("-")[0] === locale);
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

export function defaultVoiceInputSaucSettings(): VoiceInputSaucSettingsView {
  return { mode: "asyncTwoPass", authentication: "apiKey", appId: "", useDictionaryHotwords: false,
    boostingTableName: "", boostingTableId: "", correctTableName: "", correctTableId: "" };
}

export function projectVoiceInputSaucSettings(value: VoiceInputSaucSettings | undefined): VoiceInputSaucSettingsView | undefined {
  if (value === undefined) return undefined;
  const mode = value.mode === VoiceInputSaucMode.ASYNC_TWO_PASS ? "asyncTwoPass"
    : value.mode === VoiceInputSaucMode.BIDIRECTIONAL ? "bidirectional"
      : value.mode === VoiceInputSaucMode.STREAM_INPUT ? "streamInput" : undefined;
  const authentication = value.authentication === VoiceInputSaucAuthentication.API_KEY ? "apiKey"
    : value.authentication === VoiceInputSaucAuthentication.ACCESS_TOKEN ? "accessToken" : undefined;
  if (mode === undefined || authentication === undefined) throw new TypeError("The service returned invalid SAUC settings.");
  return { mode, authentication, appId: value.appId, useDictionaryHotwords: value.useDictionaryHotwords,
    boostingTableName: value.boostingTableName, boostingTableId: value.boostingTableId,
    correctTableName: value.correctTableName, correctTableId: value.correctTableId };
}

export function protoVoiceInputSaucSettings(value: VoiceInputSaucSettingsView): VoiceInputSaucSettings {
  return create(VoiceInputSaucSettingsSchema, { ...value,
    mode: value.mode === "asyncTwoPass" ? VoiceInputSaucMode.ASYNC_TWO_PASS
      : value.mode === "bidirectional" ? VoiceInputSaucMode.BIDIRECTIONAL : VoiceInputSaucMode.STREAM_INPUT,
    authentication: value.authentication === "apiKey" ? VoiceInputSaucAuthentication.API_KEY : VoiceInputSaucAuthentication.ACCESS_TOKEN });
}

export function voiceInputSaucEndpoint(endpoint: string, mode: VoiceInputSaucSettingsView["mode"]): string {
  const url = new URL(endpoint);
  url.pathname = `/api/v3/sauc/${mode === "asyncTwoPass" ? "bigmodel_async" : mode === "bidirectional" ? "bigmodel" : "bigmodel_nostream"}`;
  return url.toString();
}

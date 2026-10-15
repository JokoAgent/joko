import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { BackgroundTaskOutputState, type BackgroundTaskOutput } from "@joko/contracts";
import type { MobileDelegatedControls, MobileDelegatedReadClient } from "./mobile-delegated-reader";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

export function MobileBackgroundTaskOutput({ client, controls, taskId, enabled, colors, locale }: {
  readonly client: MobileDelegatedReadClient; readonly controls: MobileDelegatedControls; readonly taskId: string;
  readonly enabled: boolean; readonly colors: MobileInteractionSheetColors; readonly locale: MobileSupportedLocale;
}) {
  const key = JSON.stringify([controls.authorityKey, taskId]), current = useRef(key); current.current = key;
  const [state, setState] = useState<{ readonly key: string; readonly loading: boolean; readonly output?: BackgroundTaskOutput; readonly failed?: boolean }>({ key, loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ key, loading: true });
    if (!enabled || !client.loadTaskBackgroundOutput) return () => controller.abort();
    const valid = () => !controller.signal.aborted && current.current === key
      && client.taskDelegatedControls()?.authorityKey === controls.authorityKey;
    const read = async () => {
      const deadline = new AbortController(), signal = AbortSignal.any([controller.signal, deadline.signal]);
      const timeout = setTimeout(() => deadline.abort(), 10_000);
      let onAbort: (() => void) | undefined;
      try {
        const output = await Promise.race([client.loadTaskBackgroundOutput!(controls.authorityKey, taskId, signal),
          new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error("The background output read retired."));
            signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort(); })]);
        if (!valid()) return;
        if (output.sessionId !== controls.sessionId || output.backgroundTaskId !== taskId
          || new TextEncoder().encode(output.text).length > 262_144 || output.totalBytes < 0n
          || ![BackgroundTaskOutputState.AVAILABLE, BackgroundTaskOutputState.UNAVAILABLE, BackgroundTaskOutputState.FAILED].includes(output.state)) throw new Error("The background output response is invalid.");
        setState({ key, loading: false, output });
      } catch { if (valid()) setState({ key, loading: false, failed: true }); }
      finally { clearTimeout(timeout); if (onAbort) signal.removeEventListener("abort", onAbort); }
      if (valid()) timer = setTimeout(() => void read(), 2_000);
    };
    void read(); return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [key, enabled, attempt, client]);
  const language = locale.startsWith("zh") ? "zh" : locale;
  const t = { en: ["Recent output", "Loading output…", "No output yet.", "Output is unavailable for this task.", "The output could not be read.", "Refresh output", "Truncated", "Updated"],
    zh: ["最近输出", "正在读取输出…", "暂无输出。", "此任务的输出暂不可用。", "无法读取输出。", "刷新输出", "已截断", "更新于"],
    ja: ["最近の出力", "出力を読み込み中…", "出力はまだありません。", "このタスクの出力は利用できません。", "出力を読み込めませんでした。", "出力を更新", "一部省略", "更新"],
    ko: ["최근 출력", "출력 읽는 중…", "아직 출력이 없습니다.", "이 작업의 출력을 사용할 수 없습니다.", "출력을 읽을 수 없습니다.", "출력 새로 고침", "잘림", "업데이트"]
  }[language === "zh" || language === "ja" || language === "ko" ? language : "en"];
  const value = state.key === key ? state : { loading: true, output: undefined, failed: false };
  const output = value.output;
  const age = output ? Math.max(0, Math.floor((Date.now() - Number(output.modifiedAtMs ?? output.capturedAtMs)) / 1_000)) : 0;
  return <View style={{ gap: 8 }}>
    <Text style={{ color: colors.muted }}>{t[0]}</Text>
    <Text selectable style={{ color: value.failed || output?.state === BackgroundTaskOutputState.FAILED ? colors.negative : colors.ink, fontSize: 12 }}>
      {value.loading ? t[1] : value.failed || output?.state === BackgroundTaskOutputState.FAILED ? t[4]
        : output?.state === BackgroundTaskOutputState.UNAVAILABLE ? t[3] : output?.text ? output.text.split("\n").slice(-12).join("\n") : t[2]}
    </Text>
    {output?.state === BackgroundTaskOutputState.AVAILABLE && <Text style={{ color: colors.muted, fontSize: 12 }}>
      {`${t[7]} ${age}s · ${output.totalBytes} B${output.truncated ? ` · ${t[6]}` : ""}`}
    </Text>}
    <Pressable accessibilityRole="button" accessibilityLabel={t[5]} disabled={!enabled} onPress={() => setAttempt(value => value + 1)} style={{ paddingVertical: 8 }}>
      <Text style={{ color: colors.accent }}>{t[5]}</Text>
    </Pressable>
  </View>;
}

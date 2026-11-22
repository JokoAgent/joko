import { useEffect, useRef, useState } from "react";
import { Alert, AppState, Pressable, ScrollView, Switch, Text, View } from "react-native";
import type { MobileSettingsColors } from "./MobileSettingsScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileSpeakerMessage } from "./speaker-filter/messages";
import { mobileMessage } from "./mobile-messages";
import { downloadMobileSpeakerModels, mobileSpeakerModelsPresent, SPEAKER_DOWNLOAD_BYTES, SPEAKER_DOWNLOAD_MB } from "./speaker-filter/models";
import { enrollMobileSpeaker, readMobileSpeakerSettings, removeMobileSpeakerProfile, startMobileSpeakerClip,
  writeMobileSpeakerSettings } from "./speaker-filter/mobile-speaker-filter";
import { DEFAULT_SPEAKER_GATE_STRICTNESS, SPEAKER_ENROLLMENT_CLIP_COUNT, SPEAKER_ENROLLMENT_MAX_CLIP_SEC,
  SPEAKER_GATE_STRICTNESS_VALUES } from "@joko/voice-speaker";
import { isSpeakerOnnxAvailable } from "./speaker-filter/native";

export function MobileSpeakerFilterScreen({ owner, colors, locale, foreground, onBack }: {
  readonly owner: string;
  readonly colors: MobileSettingsColors;
  readonly locale: MobileSupportedLocale;
  readonly foreground: boolean;
  readonly onBack: () => void;
}) {
  const t = (key: Parameters<typeof mobileSpeakerMessage>[1], value?: number | string) => mobileSpeakerMessage(locale, key, value);
  const supported = isSpeakerOnnxAvailable();
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof readMobileSpeakerSettings>>>();
  const [models, setModels] = useState(false);
  const [busy, setBusy] = useState<"download" | "record" | "save">();
  const [downloaded, setDownloaded] = useState(0);
  const [replacing, setReplacing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [clipCount, setClipCount] = useState(0);
  const [error, setError] = useState("");
  const lifetime = useRef<AbortController | undefined>(undefined);
  const active = useRef<AbortController | undefined>(undefined);
  const recorder = useRef<(() => Promise<Float32Array>) | undefined>(undefined);
  const clips = useRef<Float32Array[]>([]);
  const clipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearClips = () => { for (const clip of clips.current) clip.fill(0); clips.current = []; };
  const stopActivity = () => {
    clearTimeout(clipTimer.current);
    active.current?.abort();
    active.current = undefined;
    if (recorder.current) void recorder.current().catch(() => undefined);
    recorder.current = undefined;
    clearClips();
  };
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const subscription = AppState.addEventListener("change", state => {
      if (state !== "background" || active.current === undefined && clips.current.length === 0) return;
      stopActivity(); setBusy(undefined); setRecording(false); setClipCount(0); setReplacing(false);
    });
    void Promise.all([readMobileSpeakerSettings(owner), supported ? mobileSpeakerModelsPresent().catch(() => false) : false]).then(([profile, present]) => {
      if (!controller.signal.aborted) { setSettings(profile); setModels(present); }
    }).catch(() => { if (!controller.signal.aborted) setError(t("error")); });
    return () => { controller.abort(); subscription.remove(); stopActivity(); };
  }, [owner, supported]);

  const run = (kind: "download" | "save", effect: (signal: AbortSignal) => Promise<void>) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || !foreground || AppState.currentState === "background" || active.current) return;
    const controller = active.current = new AbortController();
    setError(""); setBusy(kind);
    void effect(controller.signal).catch(() => { if (!controller.signal.aborted) setError(t("error")); })
      .finally(() => {
        if (active.current !== controller) return;
        active.current = undefined;
        setBusy(undefined);
      });
  };
  const finish = () => {
    const capture = recorder.current, controller = active.current;
    if (!capture || !controller) return;
    recorder.current = undefined;
    clearTimeout(clipTimer.current);
    setRecording(false); setBusy("record");
    void capture().then(samples => {
      if (controller.signal.aborted) { samples.fill(0); return; }
      clips.current.push(samples); setClipCount(clips.current.length);
    }).catch(() => { if (!controller.signal.aborted) setError(t("error")); }).finally(() => {
      if (active.current === controller) { active.current = undefined; setBusy(undefined); }
    });
  };
  const record = () => {
    if (!foreground || !supported || !models || active.current || clips.current.length >= SPEAKER_ENROLLMENT_CLIP_COUNT) return;
    const controller = active.current = new AbortController();
    setError(""); setBusy("record");
    void startMobileSpeakerClip(controller.signal).then(capture => {
      if (active.current !== controller || controller.signal.aborted) { void capture().catch(() => undefined); return; }
      recorder.current = capture; setRecording(true); setBusy(undefined);
      clipTimer.current = setTimeout(finish, SPEAKER_ENROLLMENT_MAX_CLIP_SEC * 1_000);
    }).catch(() => {
      if (active.current === controller) { active.current = undefined; setBusy(undefined); setError(t("error")); }
    });
  };

  const enroll = () => run("save", async signal => {
    const samples = clips.current;
    try {
      const result = await enrollMobileSpeaker(owner, samples, signal);
      signal.throwIfAborted();
      if (result.ok) {
        const profile = await readMobileSpeakerSettings(owner);
        signal.throwIfAborted();
        clearClips(); setClipCount(0); setSettings(profile); setReplacing(false);
      }
      else if (result.reason === "inconsistent") {
        clearClips(); setClipCount(0); setError(t("inconsistent"));
      } else {
        const index = result.clipIndex ?? 0;
        for (const clip of clips.current.splice(index)) clip.fill(0);
        setClipCount(index); setError(t("clipInvalid", index + 1));
      }
    } catch (failure) {
      if (!signal.aborted) {
        const present = await mobileSpeakerModelsPresent().catch(() => false);
        if (!signal.aborted) { setModels(present); throw failure; }
      }
    }
  });

  const changeSettings = (change: Parameters<typeof writeMobileSpeakerSettings>[1]) => run("save", async signal => {
    const next = await writeMobileSpeakerSettings(owner, change, signal);
    if (!signal.aborted) setSettings(next);
  });
  const confirmRemoval = () => Alert.alert(t("remove"), t("removeConfirm"), [
    { text: mobileMessage(locale, "common.cancel"), style: "cancel" },
    { text: t("remove"), style: "destructive", onPress: () => run("save", async signal => {
      const next = await removeMobileSpeakerProfile(owner, signal);
      if (!signal.aborted) setSettings(next);
    }) }
  ]);
  const discard = () => {
    stopActivity(); setBusy(undefined); setRecording(false); setClipCount(0); setReplacing(false); setError("");
  };

  const disabled = busy !== undefined || recording || !foreground;
  const button = (label: string, onPress: () => void, unavailable = disabled, selected?: boolean) =>
    <Pressable key={label} accessibilityRole="button" accessibilityState={{ disabled: unavailable, selected }}
      disabled={unavailable} onPress={onPress} style={{ padding: 11, borderWidth: 1, borderRadius: 8,
        borderColor: selected ? colors.accent : colors.border, opacity: unavailable ? 0.55 : 1 }}>
      <Text style={{ color: colors.ink }}>{label}</Text>
    </Pressable>;
  return <ScrollView contentContainerStyle={{ padding: 18, gap: 14, backgroundColor: colors.background, flexGrow: 1 }}>
    <View style={{ alignItems: "flex-start" }}>{button(locale === "zh-CN" ? "‹ 设置" : "‹ Settings", onBack, false)}</View>
    <Text accessibilityRole="header" style={{ fontSize: 24, fontWeight: "700", color: colors.ink }}>{t("title")}</Text>
    <Text style={{ color: colors.muted }}>{t("description")}</Text>
    {!supported && <Text accessibilityRole="alert" style={{ color: colors.muted }}>{t("unsupported")}</Text>}
    {error !== "" && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{error}</Text>}
    {supported && !models && busy !== "download" && button(t("download", SPEAKER_DOWNLOAD_MB), () => run("download", async signal => {
      setDownloaded(0);
      await downloadMobileSpeakerModels(signal, bytes => { if (!signal.aborted) setDownloaded(bytes); });
      if (!signal.aborted) setModels(true);
    }))}
    {busy === "download" && <>
      <Text accessibilityRole="progressbar" accessibilityLabel={t("downloading")}
        accessibilityValue={{ min: 0, max: SPEAKER_DOWNLOAD_BYTES, now: downloaded }} style={{ color: colors.ink }}>
        {t("downloading")} {downloadProgress(downloaded, locale)}
      </Text>
      {button(t("cancelDownload"), () => active.current?.abort(), false)}
    </>}
    {settings?.enrolled && <>
      <Text style={{ color: colors.muted }}>{t("enrolled")}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: colors.ink }}>{t("enabled")}</Text>
        <Switch accessibilityLabel={t("enabled")} value={settings.enabled} disabled={disabled || replacing || !settings.enabled && (!models || !supported)}
          trackColor={{ false: colors.border, true: colors.accent }} thumbColor={colors.surface}
          onValueChange={enabled => changeSettings({ enabled })} />
      </View>
      <Text style={{ color: colors.muted }}>{t("strength")}</Text>
        <View style={{ gap: 8, flexDirection: "row", flexWrap: "wrap" }}>
          {button(t("useDefault", t(DEFAULT_SPEAKER_GATE_STRICTNESS)), () => changeSettings({ strictness: null }), disabled || replacing, settings.strictnessOverride === undefined)}
          {SPEAKER_GATE_STRICTNESS_VALUES.map(strictness => button(t(strictness), () => changeSettings({ strictness }),
            disabled || replacing, settings.strictnessOverride === strictness))}
        </View>
      {!replacing && supported && models && button(t("recordAgain"), () => setReplacing(true))}
      {!replacing && button(t("remove"), confirmRemoval)}
    </>}
    {settings !== undefined && (!settings.enrolled || replacing) && supported && models && <>
      <Text style={{ color: colors.muted }}>{t("instruction")}</Text>
      {recording ? button(t("finish"), finish, false) : clipCount < SPEAKER_ENROLLMENT_CLIP_COUNT
        ? button(t("record", clipCount + 1), record) : button(t("enroll"), enroll)}
      {(replacing || recording || clipCount > 0) && button(t(replacing ? "cancelReplacement" : "discard"), discard, !foreground)}
    </>}
  </ScrollView>;
}

function downloadProgress(bytes: number, locale: MobileSupportedLocale): string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return `${number.format(bytes / 1_000_000)} / ${number.format(SPEAKER_DOWNLOAD_BYTES / 1_000_000)} MB`;
}

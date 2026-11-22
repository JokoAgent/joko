import { useEffect, useRef, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import type { MobileSettingsColors } from "./MobileSettingsScreen";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileHandheld, type MobileHandheldSettings } from "./mobile-handheld";

const labels = {
  en: ["Handheld mode", "Voice button", "Press a controller button", "Use the secondary display", "Secondary display disconnected", "Couldn't save handheld settings"],
  "zh-CN": ["掌机模式", "语音按键", "请按下手柄按键", "使用副屏", "副屏未连接", "无法保存掌机设置"],
  "zh-TW": ["掌機模式", "語音按鍵", "請按下手把按鍵", "使用副螢幕", "副螢幕未連線", "無法儲存掌機設定"],
  ja: ["携帯ゲーム機モード", "音声ボタン", "コントローラーのボタンを押してください", "セカンダリディスプレイを使用", "セカンダリディスプレイが未接続です", "設定を保存できませんでした"],
  ko: ["휴대용 게임기 모드", "음성 버튼", "컨트롤러 버튼을 누르세요", "보조 디스플레이 사용", "보조 디스플레이 연결 안 됨", "설정을 저장하지 못했습니다"]
} as const;

export function MobileHandheldSettingsSection({ colors, locale, foreground }: {
  readonly colors: MobileSettingsColors;
  readonly locale: MobileSupportedLocale;
  readonly foreground: boolean;
}) {
  const native = mobileHandheld();
  const [settings, setSettings] = useState<MobileHandheldSettings>();
  const current = useRef(settings);
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const [title, voice, press, secondary, disconnected, failure] = labels[locale];
  const adopt = (value: MobileHandheldSettings) => { current.current = value; setSettings(value); };
  const configure = async (enabled: boolean, key: number, useSecondary: boolean) => {
    if (!native) return;
    setSaving(true); setFailed(false);
    try {
      const value = await native.configure(enabled, key, useSecondary);
      if (mounted.current) adopt(value);
    } catch { if (mounted.current) setFailed(true); }
    finally { if (mounted.current) setSaving(false); }
  };
  const configureKey = useRef(configure);
  configureKey.current = configure;
  useEffect(() => {
    if (!native || !foreground) return;
    let active = true;
    mounted.current = true;
    setCapturing(false); setSaving(false);
    void native.read().then(value => { if (active) adopt(value); }).catch(() => { if (active) setFailed(true); });
    const displays = native.addListener("onDisplaysChanged", value => { if (active) adopt(value); });
    const mapping = native.addListener("onKeyCaptured", ({ key }) => {
      const value = current.current;
      if (!active || !value?.enabled) return;
      setCapturing(false);
      void configureKey.current(true, key, value.secondary);
    });
    return () => {
      active = false; mounted.current = false;
      displays.remove(); mapping.remove();
      void native.captureKey(false).catch(() => undefined);
    };
  }, [foreground, native]);
  if (!native || (!settings && !failed)) return null;
  return <View style={{ backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 10, padding: 12, gap: 10 }}>
    {settings && <>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: colors.ink, flexShrink: 1 }}>{title}</Text>
        <Switch accessibilityLabel={title} value={settings.enabled} disabled={!foreground || saving}
          trackColor={{ false: colors.border, true: colors.accent }} thumbColor={colors.surface}
          onValueChange={enabled => { setCapturing(false); void configure(enabled, settings.voiceKey, settings.secondary); }} />
      </View>
      {settings.enabled && <>
        <Pressable accessibilityRole="button" accessibilityLabel={voice} disabled={!foreground || saving}
          onPress={() => {
            setCapturing(!capturing); setFailed(false);
            void native.captureKey(!capturing).catch(() => { if (mounted.current) { setCapturing(false); setFailed(true); } });
          }}>
          <Text style={{ color: colors.ink, paddingVertical: 8 }}>
            {capturing ? press : `${voice} · ${settings.keyName.replace(/^KEYCODE_BUTTON_/, "")}`}
          </Text>
        </Pressable>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <View style={{ flexShrink: 1 }}><Text style={{ color: colors.ink }}>{secondary}</Text>
            {!settings.secondaryAvailable && <Text style={{ color: colors.muted }}>{disconnected}</Text>}
          </View>
          <Switch accessibilityLabel={secondary} value={settings.secondary} disabled={!foreground || saving}
            trackColor={{ false: colors.border, true: colors.accent }} thumbColor={colors.surface}
            onValueChange={value => void configure(true, settings.voiceKey, value)} />
        </View>
      </>}
    </>}
    {failed && <Text accessibilityRole="alert" style={{ color: colors.negative }}>{failure}</Text>}
  </View>;
}

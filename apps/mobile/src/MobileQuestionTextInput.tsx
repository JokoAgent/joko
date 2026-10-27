import { useRef, useState } from "react";
import { Pressable, Text, TextInput, View, type StyleProp, type TextStyle } from "react-native";
import { randomUUID } from "expo-crypto";
import type { MobileVoiceTransport } from "./mobile-voice-input";
import type { MobileComposerDraft, MobileComposerSelection } from "./mobile-composer-document";
import { useMobileVoiceInput } from "./use-mobile-voice-input";
import type { MobileInteractionSheetColors } from "./MobileInteractionSheet";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { useMobileVoicePermissionSettings } from "./use-mobile-voice-permission-settings";

export function MobileQuestionTextInput({ ownerKey, transport, enabled, label, value, multiline, placeholder, style, colors, locale, onFocus, onChange, onError }: {
  readonly ownerKey: string;
  readonly transport?: MobileVoiceTransport;
  readonly enabled: boolean;
  readonly label: string;
  readonly value: string;
  readonly multiline?: boolean;
  readonly placeholder?: string;
  readonly style?: StyleProp<TextStyle>;
  readonly colors: MobileInteractionSheetColors;
  readonly locale: MobileSupportedLocale;
  readonly onFocus?: () => void;
  readonly onChange: (value: string) => void;
  readonly onError: (message: string) => void;
}) {
  const [preview, setPreview] = useState<{ readonly ownerKey: string; readonly base: string; readonly text: string }>();
  const text = enabled && preview?.ownerKey === ownerKey && preview.base === value ? preview.text : value;
  const latest = useRef({ value, text, ownerKey, enabled, onChange }); latest.current = { value, text, ownerKey, enabled, onChange };
  const selection = useRef<MobileComposerSelection>({ start: value.length, end: value.length });
  const input = useRef<TextInput>(null);
  const pressing = useRef(false);
  const voice = useMobileVoiceInput({ transport, enabled, draftOwnerKey: ownerKey, locale, requestId: randomUUID, onError,
    readDraft: (): MobileComposerDraft => ({ text: latest.current.text, mentions: [], atoms: [], slashCommands: [], attachments: [] }),
    readSelection: () => selection.current,
    writeDraft: (draft, nextSelection, persist) => {
      if (!latest.current.enabled) return;
      latest.current.text = draft.text; selection.current = nextSelection;
      if (persist) { setPreview(undefined); latest.current.onChange(draft.text); }
      else setPreview({ ownerKey: latest.current.ownerKey, base: latest.current.value, text: draft.text });
    }
  });
  useMobileVoicePermissionSettings(voice.error, locale);
  const recording = voice.state === "starting" || voice.state === "listening";
  return <View style={{ gap: 8 }}>
    <TextInput ref={input} accessibilityLabel={label} multiline={multiline} editable={enabled} value={text}
      placeholder={placeholder} placeholderTextColor={colors.muted} style={style} onFocus={onFocus}
      onSelectionChange={event => { selection.current = event.nativeEvent.selection; }}
      onChangeText={next => { setPreview(undefined); latest.current.text = next; onChange(next); }}
      onBlur={() => { if (!pressing.current) void voice.cancel(); }} />
    {(voice.available || voice.checking || voice.busy) && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={recording ? mobileMessage(locale, "voice.stopLabel", { duration: voice.elapsedLabel ?? "0:00" }) : mobileMessage(locale, "voice.label")}
        accessibilityState={{ disabled: !enabled || voice.checking || voice.state === "submitting", busy: voice.busy }}
        disabled={!enabled || voice.checking || voice.state === "submitting"}
        onPressIn={() => { pressing.current = true; }} onPressOut={() => { pressing.current = false; }}
        onPress={() => { void voice.toggle(); }} style={{ padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
        <Text style={{ color: colors.ink }}>{voice.state === "submitting" ? mobileMessage(locale, "voice.transcribing") : recording ? voice.elapsedLabel ?? "0:00" : mobileMessage(locale, "voice.label")}</Text>
      </Pressable>
      {voice.busy && <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "voice.cancel")}
        onPressIn={() => { pressing.current = true; }} onPressOut={() => { pressing.current = false; }}
        onPress={() => { void voice.cancel(); }} style={{ padding: 10 }}><Text style={{ color: colors.negative }}>{mobileMessage(locale, "voice.cancel")}</Text></Pressable>}
    </View>}
  </View>;
}

import { useEffect, useMemo, useRef, useState, type ComponentRef, type ComponentType } from "react";
import { findNodeHandle, Platform, StyleSheet, Text, View, useWindowDimensions, type ViewProps } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { randomUUID } from "expo-crypto";
import { requireNativeViewManager, type EventSubscription } from "expo-modules-core";
import type { MobileComposerSelection } from "./mobile-composer-document";
import { readNativeMessageSelection } from "./mobile-composer-quote";

interface AndroidMessageSelectionModule {
  attach(tag: number, registration: string, label: string): Promise<boolean>;
  detach(registration: string): Promise<void>;
  addListener(event: "onQuoteSelection", listener: (value: unknown) => void): EventSubscription;
}

interface IosMessageTextProps extends ViewProps {
  readonly registration: string;
  readonly quoteLabel: string;
  readonly body: string;
  readonly ink: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly onQuoteSelection: (event: { readonly nativeEvent: unknown }) => void;
}

const moduleName = "JokoMessageSelection";
let nativeSelection: ReturnType<typeof loadNativeSelection> | undefined;

function loadNativeSelection(): { readonly android?: AndroidMessageSelectionModule; readonly ios?: ComponentType<IosMessageTextProps> } {
  try {
    const module = requireOptionalNativeModule<AndroidMessageSelectionModule>(moduleName);
    if (module && Platform.OS === "android") return { android: module };
    if (module && Platform.OS === "ios") return { ios: requireNativeViewManager<IosMessageTextProps>(moduleName) };
  } catch { /* Builds without the native adapter retain the ordinary text surface. */ }
  return {};
}

export function mobileNativeMessageSelectionAvailable(): boolean {
  const { android, ios } = nativeSelection ??= loadNativeSelection();
  return android !== undefined || ios !== undefined;
}

export interface MobileMessageQuoteAction {
  readonly source: string;
  readonly label: string;
  readonly onQuote: (selection: MobileComposerSelection) => void;
}

export function MobileSelectableMessageText({ text, ink, lineHeight, action, testID }: {
  readonly text: string;
  readonly ink: string;
  readonly lineHeight: number;
  readonly action: MobileMessageQuoteAction;
  readonly testID?: string;
}) {
  const registration = useMemo(() => randomUUID(), [action.source, text, action.label]);
  const current = useRef({ registration, text, onQuote: action.onQuote });
  current.current = { registration, text, onQuote: action.onQuote };
  const nativeText = useRef<ComponentRef<typeof Text> | null>(null);
  const [tag, setTag] = useState<number | null>(null);
  const { fontScale } = useWindowDimensions();
  const { android: androidSelection, ios: IosMessageText } = nativeSelection ??= loadNativeSelection();
  const accept = (value: unknown) => {
    const active = current.current;
    const selection = readNativeMessageSelection(value, active.registration, active.text);
    if (selection !== undefined) active.onQuote(selection);
  };
  useEffect(() => {
    if (androidSelection == null || tag === null) return;
    let current = true;
    const listener = androidSelection.addListener("onQuoteSelection", (value) => { if (current) accept(value); });
    void androidSelection.attach(tag, registration, action.label).catch(() => undefined);
    return () => { current = false; listener.remove(); void androidSelection.detach(registration).catch(() => undefined); };
  }, [androidSelection, registration, action.label, tag]);
  const style = { color: ink, fontSize: 15, lineHeight };
  if (IosMessageText === undefined) return <Text ref={nativeText} testID={testID} selectable style={style}
    onLayout={androidSelection === undefined ? undefined : () => setTag(findNodeHandle(nativeText.current))}>{text}</Text>;
  // Measure with the regular React Native paragraph so the UIKit view uses the same space in the timeline.
  return <View>
    <Text accessible={false} accessibilityElementsHidden pointerEvents="none" style={[style, styles.measure]}>{text}</Text>
    <IosMessageText testID={testID} style={StyleSheet.absoluteFill} registration={registration} quoteLabel={action.label}
      body={text} ink={ink} fontSize={15 * fontScale} lineHeight={lineHeight * fontScale}
      onQuoteSelection={(event) => accept(event.nativeEvent)} />
  </View>;
}

const styles = StyleSheet.create({ measure: { opacity: 0 } });

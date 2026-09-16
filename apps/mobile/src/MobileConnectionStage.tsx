import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SvgXml } from "react-native-svg";
import {
  connectionStageBoxInViewport,
  resolveConnectionSurface,
  type ConnectionStageBox
} from "./connection-surface";

interface StageColors {
  readonly brandBackground: string;
  readonly ink: string;
  readonly muted: string;
}

interface MobileConnectionStageProps {
  readonly artworkId: string;
  readonly artworkSource: string;
  readonly iconSource: string;
  readonly colors: StageColors;
  readonly onArtworkPress: () => void;
  readonly onIconPress: () => void;
  readonly children: ReactNode;
}

export function MobileConnectionStage({
  artworkId,
  artworkSource,
  iconSource,
  colors,
  onArtworkPress,
  onIconPress,
  children
}: MobileConnectionStageProps) {
  const viewport = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const surface = resolveConnectionSurface(viewport.width, viewport.height);
  const hero = connectionStageBoxInViewport(surface, surface.hero);
  const lockup = connectionStageBoxInViewport(surface, surface.lockup);
  const projectedForm = connectionStageBoxInViewport(surface, surface.form);
  const formLeft = Math.max(projectedForm.x, insets.left + 16);
  const formRight = Math.min(
    projectedForm.x + projectedForm.width,
    viewport.width - insets.right - 16
  );
  const formTop = Math.max(projectedForm.y, insets.top);

  return <View style={[styles.root, { backgroundColor: colors.brandBackground }]}>
    <Hero
      frame={hero}
      artworkId={artworkId}
      artworkSource={artworkSource}
      onPress={onArtworkPress}
    />
    <BrandLockup
      frame={lockup}
      iconSource={iconSource}
      colors={colors}
      onPress={onIconPress}
    />
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[
        styles.formLane,
        {
          left: formLeft,
          top: formTop,
          width: Math.max(0, formRight - formLeft)
        }
      ]}
    >
      <ScrollView
        contentContainerStyle={[styles.formScroll, { paddingBottom: 36 + insets.bottom }]}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.form}>{children}</View>
      </ScrollView>
    </KeyboardAvoidingView>
  </View>;
}

function Hero({
  frame,
  artworkId,
  artworkSource,
  onPress
}: {
  readonly frame: ConnectionStageBox;
  readonly artworkId: string;
  readonly artworkSource: string;
  readonly onPress: () => void;
}) {
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={`Change Joko illustration, ${artworkId}`}
    accessibilityHint="Switches between the two poses in this illustration group."
    onPress={onPress}
    style={[styles.hero, frameStyle(frame)]}
  >
    <SvgXml xml={artworkSource} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" />
  </Pressable>;
}

function BrandLockup({
  frame,
  iconSource,
  colors,
  onPress
}: {
  readonly frame: ConnectionStageBox;
  readonly iconSource: string;
  readonly colors: StageColors;
  readonly onPress: () => void;
}) {
  const iconSize = Math.min(frame.height * 0.76, frame.width * 0.23);
  const titleSize = clamp(frame.height * 0.34, 18, 40);
  const subtitleSize = clamp(frame.height * 0.16, 10, 16);
  return <View style={[styles.lockup, frameStyle(frame), { gap: Math.max(6, frame.height * 0.08) }]}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Show the next Joko illustration"
      accessibilityHint="Changes the illustration group and returns it to its first pose."
      onPress={onPress}
      style={{ width: iconSize, height: iconSize }}
    >
      <SvgXml xml={iconSource} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" />
    </Pressable>
    <View style={styles.lockupWords}>
      <Text
        maxFontSizeMultiplier={1.3}
        numberOfLines={1}
        style={[styles.brandTitle, { color: colors.ink, fontSize: titleSize, lineHeight: titleSize * 1.04 }]}
      >Joko</Text>
      <Text
        maxFontSizeMultiplier={1.3}
        numberOfLines={1}
        style={[styles.brandSubtitle, { color: colors.muted, fontSize: subtitleSize, lineHeight: subtitleSize * 1.3 }]}
      >Your work, wherever you are.</Text>
    </View>
  </View>;
}

function frameStyle(frame: ConnectionStageBox) {
  return {
    left: frame.x,
    top: frame.y,
    width: frame.width,
    height: frame.height
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: "hidden" },
  hero: { position: "absolute", alignItems: "center", justifyContent: "center" },
  lockup: { position: "absolute", flexDirection: "row", alignItems: "center", justifyContent: "center" },
  lockupWords: { minWidth: 0, flexShrink: 1, justifyContent: "center", gap: 2 },
  brandTitle: { fontWeight: "400", letterSpacing: -1.3 },
  brandSubtitle: {},
  formLane: { position: "absolute", bottom: 0 },
  formScroll: { flexGrow: 1 },
  form: { gap: 14 }
});

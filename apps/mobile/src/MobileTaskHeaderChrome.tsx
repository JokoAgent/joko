import type { RefObject } from "react";
import { Pressable, View } from "react-native";
import type { MobileNavigationButton } from "./mobile-navigation-header";
import { MobileTaskHeaderIcon } from "./MobileTaskHeaderIcon";

export interface MobileTaskHeaderButtonsProps {
  readonly buttons: readonly MobileNavigationButton[];
  readonly colors: { readonly surface: string; readonly ink: string; readonly dark?: boolean };
  readonly focusRef?: RefObject<View | null>;
}
export function MobileTaskHeaderButtons({ buttons, colors, focusRef }: MobileTaskHeaderButtonsProps) {
  return <View style={{ flexDirection: "row", flexShrink: 0, height: 44 }}>
    {buttons.map(button => <Pressable key={button.id} ref={buttons.length === 1 ? focusRef : undefined} accessibilityRole="button" accessibilityLabel={button.label}
      accessibilityState={{ disabled: button.disabled, expanded: button.expanded }} disabled={button.disabled} onPress={button.onPress}
      testID={`task.header.${button.id}`} style={({ pressed }) => ({ width: 44, height: 44, alignItems: "center", justifyContent: "center",
        opacity: button.disabled ? 0.4 : pressed ? 0.65 : 1 })}>
      <MobileTaskHeaderIcon id={button.id} color={colors.ink} />
    </Pressable>)}
  </View>;
}

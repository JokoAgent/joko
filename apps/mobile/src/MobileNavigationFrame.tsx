import { useLayoutEffect, useRef, type ReactNode } from "react";
import { BackHandler, Keyboard, Platform } from "react-native";

export function MobileNavigationFrame({ children, onBack }: {
  readonly children: ReactNode; readonly dark?: boolean; readonly onBack?: () => boolean;
}) {
  const currentBack = useRef(onBack); currentBack.current = onBack;
  // Register before screen effects so local dialogs and editors handle Back first.
  useLayoutEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!currentBack.current) return false;
      if (Keyboard.isVisible()) { Keyboard.dismiss(); return true; }
      return currentBack.current();
    });
    return () => subscription.remove();
  }, []);
  return children;
}

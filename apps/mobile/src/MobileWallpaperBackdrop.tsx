import { lazy, Suspense, type ComponentType } from "react";
import { Image, StyleSheet, View } from "react-native";
import { useReducedMotion } from "./MobileDrawer";
import type { CustomWallpaper } from "./mobile-wallpaper";

const Motion = lazy<ComponentType<{ uri: string }>>(() =>
  import("./MobileWallpaperMotion").catch(() => ({ default: () => null })));

export function MobileWallpaperBackdrop({ file, dynamic, fill, dark }: {
  file: CustomWallpaper; dynamic: boolean; fill: string; dark: boolean;
}) {
  const reduced = useReducedMotion(true);
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden style={StyleSheet.absoluteFill}>
    <Image source={{ uri: file.imageUri }} resizeMode="cover" style={StyleSheet.absoluteFill} />
    {dynamic && !reduced && file.videoUri && <Suspense fallback={null}>
      <Motion key={file.videoUri} uri={file.videoUri} />
    </Suspense>}
    <View style={[StyleSheet.absoluteFill, { backgroundColor: fill, opacity: dark ? 0.84 : 0.78 }]} />
  </View>;
}

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View, useWindowDimensions, type ViewProps } from "react-native";
import { requireNativeViewManager } from "expo-modules-core";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { remotePresentation } from "../modules/joko-remote-presentation/src/index";
import { parseMobileWindowGeometry, type MobileWindowGeometry } from "./mobile-window-geometry";

const GeometryContext = createContext<MobileWindowGeometry | null>(null);
const Probe = Platform.OS === "ios" && remotePresentation?.windowLayoutAvailable === true
  ? requireNativeViewManager<ViewProps & { onGeometryChange(event: { readonly nativeEvent: unknown }): void }>(
    "JokoRemotePresentation", "WindowLayout") : null;

/** One attached observation source for the current window. */
export function MobileAdaptiveWindowProvider({ children }: { readonly children: ReactNode }) {
  const window = useWindowDimensions(), insets = useSafeAreaInsets();
  const [geometry, setGeometry] = useState<MobileWindowGeometry | null>(null);
  const current = geometry && Math.abs(geometry.width - window.width) < 1 && Math.abs(geometry.height - window.height) < 1 ? geometry : null;
  const value = useMemo<MobileWindowGeometry>(() => current ?? normalGeometry(window.width, window.height, insets),
    [current, window.width, window.height, insets]);
  return <GeometryContext.Provider value={value}><View style={styles.root}>
    {children}
    {Probe ? <Probe pointerEvents="none" style={StyleSheet.absoluteFill}
      onGeometryChange={event => setGeometry(parseMobileWindowGeometry(event.nativeEvent) ?? null)} /> : null}
  </View></GeometryContext.Provider>;
}
export function useMobileAdaptiveWindow(): MobileWindowGeometry {
  const value = useContext(GeometryContext), window = useWindowDimensions(), insets = useSafeAreaInsets();
  return value ?? normalGeometry(window.width, window.height, insets);
}
function normalGeometry(width: number, height: number, insets: MobileWindowGeometry["insets"]): MobileWindowGeometry {
  return { width, height, insets, regularWidth: width >= 600, regularHeight: height >= 600,
    barEdge: "none", regions: [], reservedRegionsSupported: false };
}
const styles = StyleSheet.create({ root: { flex: 1 } });

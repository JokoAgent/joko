import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, StyleSheet } from "react-native";
import { ScreenStack, Screen, ScreenContentWrapper, ScreenStackHeaderConfig, ScreenStackHeaderLeftView, ScreenStackHeaderCenterView,
  ScreenStackHeaderRightView, type HeaderBarButtonItem } from "react-native-screens";
import { MobileNavigationHeaderContext, type MobileNavigationButton, type MobileNavigationHeader } from "./mobile-navigation-header";
import monitorArtwork from "../assets/navigation/monitor.png";
import folderArtwork from "../assets/navigation/folder.png";

/** One native scene hosts UIKit chrome without acquiring a second route stack. */
export function MobileNavigationFrame({ children, dark = false }: { readonly children: ReactNode; readonly dark?: boolean }) {
  const current = useRef<{ readonly owner: symbol; readonly header: MobileNavigationHeader; readonly target: number } | undefined>(undefined);
  const [slot, setSlot] = useState<typeof current.current>();
  const [height, setHeight] = useState(0);
  const targetSequence = useRef(0);
  const [lifecycle, setLifecycle] = useState({ foreground: AppState.currentState === "active", epoch: 0 });
  const lifecycleRef = useRef(lifecycle); lifecycleRef.current = lifecycle;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => {
      const next = { foreground: state === "active", epoch: lifecycleRef.current.epoch + 1 };
      lifecycleRef.current = next; setLifecycle(next);
    });
    return () => subscription.remove();
  }, []);
  const publish = useCallback((owner: symbol, header: MobileNavigationHeader) => {
    const previous = current.current;
    const sameButtons = (left: readonly MobileNavigationButton[], right: readonly MobileNavigationButton[]): boolean =>
      left.length === right.length && left.every((button, index) => button.id === right[index]?.id);
    const retained = previous?.owner === owner && previous.header.mode === header.mode
      && sameButtons(previous.header.leading, header.leading) && sameButtons(previous.header.trailing, header.trailing);
    const next = { owner, header, target: retained ? previous.target : ++targetSequence.current };
    current.current = next; setSlot(next);
  }, []);
  const retire = useCallback((owner: symbol) => {
    if (current.current?.owner !== owner) return;
    current.current = undefined; setSlot(undefined);
  }, []);
  const header = slot?.header;
  const horizontal = header?.mode === "horizontal";
  const port = useMemo(() => ({ native: true, height: horizontal ? height : 0, publish, retire }),
    [horizontal, height, publish, retire]);
  const barItems = (items: readonly MobileNavigationButton[], side: "leading" | "trailing"): HeaderBarButtonItem[] => items.map(item => ({
    type: "button", accessibilityLabel: item.label,
    icon: item.id === "files" || item.id === "remote-desktop" ? { type: "templateSource", templateSource: item.id === "files" ? folderArtwork : monitorArtwork }
      : { type: "sfSymbol", name: item.symbol },
    disabled: item.disabled, identifier: item.id, onPress: () => {
      const active = current.current;
      if (!active || active.owner !== slot?.owner || active.target !== slot?.target || active.header.mode !== "rail"
        || lifecycleRef.current.epoch !== lifecycle.epoch || !lifecycleRef.current.foreground || AppState.currentState !== "active") return;
      const action = active.header[side].find(candidate => candidate.id === item.id);
      if (action && !action.disabled) action.onPress();
    }
  }));
  return <MobileNavigationHeaderContext.Provider value={port}>
    <ScreenStack style={styles.fill}>
      <Screen enabled isNativeStack screenId="joko-scene" activityState={2} gestureEnabled={false} nativeBackButtonDismissalEnabled={false}
        preventNativeDismiss stackPresentation="push" stackAnimation="none" style={styles.fill}
        statusBarStyle={dark ? "light" : "dark"}
        onHeaderHeightChange={event => {
          const value = event.nativeEvent.headerHeight;
          if (Number.isFinite(value) && value >= 0 && value <= 200) setHeight(value);
        }}>
        <ScreenContentWrapper style={styles.fill}>{children}</ScreenContentWrapper>
        <ScreenStackHeaderConfig key={`${slot?.target ?? 0}/${lifecycle.epoch}`}
          hidden={!header || header.mode === "hidden" || !lifecycle.foreground} hideBackButton hideShadow
          translucent backgroundColor="transparent" color={header?.ink} title=""
          experimental_userInterfaceStyle={dark ? "dark" : "light"}
          disableTopInsetApplication disableBottomInsetApplication disableLeftInsetApplication disableRightInsetApplication
          {...(header?.mode === "rail" ? {
            headerLeftBarButtonItems: barItems(header.leading, "leading"), headerRightBarButtonItems: barItems(header.trailing, "trailing")
          } : {})}>
          {horizontal ? <>
            <ScreenStackHeaderLeftView hidesSharedBackground>{header.left}</ScreenStackHeaderLeftView>
            <ScreenStackHeaderCenterView>{header.title}</ScreenStackHeaderCenterView>
            <ScreenStackHeaderRightView hidesSharedBackground>{header.right}</ScreenStackHeaderRightView>
          </> : undefined}
        </ScreenStackHeaderConfig>
      </Screen>
    </ScreenStack>
  </MobileNavigationHeaderContext.Provider>;
}
const styles = StyleSheet.create({ fill: { flex: 1 } });

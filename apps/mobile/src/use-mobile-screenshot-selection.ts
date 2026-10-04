import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { MobileScreenshotSelectionController, subscribeMobileScreenshots } from "./mobile-screenshot-selection";

export function useMobileScreenshotSelection(input: {
  readonly owner?: string;
  readonly blocked: boolean;
  readonly selectionActive: boolean;
  readonly visible: (signal: AbortSignal) => Promise<readonly string[]>;
  readonly enter: (owner: string, ids: readonly string[]) => void;
}) {
  const latest = useRef(input); latest.current = input;
  useEffect(() => {
    if (Platform.OS !== "ios" || !input.owner) return;
    const owner = input.owner;
    const controller = new MobileScreenshotSelectionController(() => ({
      owner: latest.current.owner === owner ? owner : undefined, blocked: latest.current.blocked, selectionActive: latest.current.selectionActive,
      foreground: AppState.currentState === "active"
    }), (signal) => latest.current.visible(signal), (owner, ids) => latest.current.enter(owner, ids));
    const remove = subscribeMobileScreenshots(() => controller.capture());
    const lifecycle = AppState.addEventListener("change", (state) => { if (state !== "active") controller.retire(); });
    return () => { remove(); lifecycle.remove(); controller.dispose(); };
  }, [input.owner]);
}

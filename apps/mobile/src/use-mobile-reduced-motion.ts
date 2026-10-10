import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/** Only a proven false preference enables native motion. */
export function useMobileReducedMotion(): boolean | undefined {
  const [reduced, setReduced] = useState<boolean>();
  useEffect(() => {
    let active = true;
    let observedChange = false;
    const update = (value: boolean): void => { if (active) setReduced(value); };
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (!observedChange) update(value); })
      .catch(() => { if (!observedChange) update(true); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => { observedChange = true; update(value); });
    return () => { active = false; subscription.remove(); };
  }, []);
  return reduced;
}

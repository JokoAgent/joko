import { Alert, AppState } from "react-native";
import type { ProviderGroupRebalanceSuggestion } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

/** A native dialog belongs to the exact source and unsent draft that opened it. */
export function confirmMobileProviderRebalance(suggestion: ProviderGroupRebalanceSuggestion, options: { readonly signal: AbortSignal;
  readonly locale: MobileSupportedLocale; readonly current: () => boolean; readonly subscribe: (listener: () => void) => () => void }): Promise<"keep" | "cancel" | { readonly remember: boolean }> {
  return new Promise(resolve => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const active = () => !options.signal.aborted && options.current() && AppState.currentState === "active";
    const finish = (answer: "keep" | "cancel" | { readonly remember: boolean }) => {
      if (settled) return; settled = true; clearTimeout(timer); unsubscribe?.(); listener.remove(); options.signal.removeEventListener("abort", cancel);
      resolve(active() ? answer : "cancel");
    };
    const cancel = () => finish("cancel");
    const timer = setTimeout(cancel, 60_000);
    const listener = AppState.addEventListener("change", state => { if (state !== "active") cancel(); });
    unsubscribe = options.subscribe(() => { if (!active()) cancel(); });
    options.signal.addEventListener("abort", cancel, { once: true });
    if (!active()) { cancel(); return; }
    const remaining = (quota: ProviderGroupRebalanceSuggestion["currentQuota"]) => {
      const used = quota?.pacingWindow?.usedPercent ?? quota?.usagePercent;
      return used !== undefined && Number.isFinite(used) && used >= 0 && used <= 100
        ? `${new Intl.NumberFormat(options.locale, { maximumFractionDigits: 1 }).format(100 - used)}%` : "—";
    };
    Alert.alert(mobileMessage(options.locale, "task.rebalanceTitle"), mobileMessage(options.locale, "task.rebalanceBody", {
      current: suggestion.fromLabel.slice(0, 200), target: suggestion.toLabel.slice(0, 200),
      currentQuota: remaining(suggestion.currentQuota), targetQuota: remaining(suggestion.targetQuota)
    }), [
      { text: mobileMessage(options.locale, "task.rebalanceKeep"), onPress: () => finish("keep") },
      { text: mobileMessage(options.locale, "task.rebalanceOnce"), onPress: () => finish({ remember: false }) },
      { text: mobileMessage(options.locale, "task.rebalanceRemember"), onPress: () => finish({ remember: true }) }
    ], { cancelable: true, onDismiss: cancel });
  });
}

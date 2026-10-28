import { create } from "@bufbuild/protobuf";
import { ProviderGroupRebalanceSuggestionSchema } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmMobileProviderRebalance } from "./mobile-provider-rebalance-confirmation";

const native = vi.hoisted(() => ({ state: "active", alert: vi.fn(), listeners: new Set<(state: string) => void>() }));
vi.mock("react-native", () => ({ Alert: { alert: native.alert }, AppState: { get currentState() { return native.state; },
  addEventListener: (_kind: string, listener: (state: string) => void) => { native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) }; } } }));
afterEach(() => { native.state = "active"; native.alert.mockReset(); native.listeners.clear(); vi.useRealTimers(); });

describe("native account switch confirmation", () => {
  it.each(["background", "owner", "abort", "expiry"])("retires the exact prompt after %s and ignores a later positive callback", async reason => {
    vi.useFakeTimers(); let current = true; let notify!: () => void;
    const abort = new AbortController(), suggestion = create(ProviderGroupRebalanceSuggestionSchema, { suggestionKey: `rebalance_${"a".repeat(64)}`,
      fromLabel: "Original account", toLabel: "Suggested account", currentQuota: { usagePercent: 80 }, targetQuota: { usagePercent: 20 } });
    const done = confirmMobileProviderRebalance(suggestion, { signal: abort.signal, locale: "en", current: () => current,
      subscribe: listener => { notify = listener; return vi.fn(); } });
    const buttons = native.alert.mock.calls[0]![2] as Array<{ onPress: () => void }>;
    expect(native.alert.mock.calls[0]![1]).toContain("20% remaining"); expect(native.alert.mock.calls[0]![1]).toContain("80% remaining");
    if (reason === "background") { native.state = "background"; native.listeners.forEach(listener => listener("background")); native.state = "active"; }
    else if (reason === "owner") { current = false; notify(); current = true; }
    else if (reason === "abort") abort.abort();
    else await vi.advanceTimersByTimeAsync(60_001);
    buttons[2]!.onPress(); await expect(done).resolves.toBe("cancel");
    expect(native.listeners.size).toBe(0);
  });

  it.each([0, 1, 2])("consumes one explicit native choice %i once", async index => {
    const done = confirmMobileProviderRebalance(create(ProviderGroupRebalanceSuggestionSchema, { fromLabel: "A", toLabel: "B" }), {
      signal: new AbortController().signal, locale: "en", current: () => true, subscribe: () => vi.fn() });
    const buttons = native.alert.mock.calls[0]![2] as Array<{ onPress: () => void }>;
    buttons[index]!.onPress(); buttons[(index + 1) % 3]!.onPress();
    await expect(done).resolves.toEqual(index === 0 ? "keep" : { remember: index === 2 });
  });
});

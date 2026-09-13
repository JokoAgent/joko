export type WindowLayoutResetFailure = "client" | "native" | "client-and-native";

export interface WindowLayoutResetActions {
  readonly resetClient: () => Promise<void>;
  readonly resetNative?: () => Promise<void>;
}

/** Run the independent client and native reset boundaries exactly once each. */
export async function resetWindowLayout(
  actions: WindowLayoutResetActions
): Promise<WindowLayoutResetFailure | undefined> {
  const client = Promise.resolve().then(actions.resetClient);
  const native = actions.resetNative === undefined
    ? undefined
    : Promise.resolve().then(actions.resetNative);
  const [clientResult, nativeResult] = await Promise.all([
    client.then(() => true, () => false),
    native?.then(() => true, () => false) ?? Promise.resolve(true)
  ]);
  if (clientResult && nativeResult) return undefined;
  if (!clientResult && !nativeResult) return "client-and-native";
  return clientResult ? "native" : "client";
}

export type ClientLayoutResetResult = "inspector-retained" | void;

export type WindowLayoutResetFailure = "client" | "native" | "client-and-native" | "inspector-retained" | "inspector-retained-and-native";

export interface WindowLayoutResetActions {
  readonly resetClient: () => Promise<ClientLayoutResetResult>;
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
    client.then((result) => result ?? "done", () => "failed" as const),
    native?.then(() => true, () => false) ?? Promise.resolve(true)
  ]);
  if (clientResult === "inspector-retained") return nativeResult ? "inspector-retained" : "inspector-retained-and-native";
  if (clientResult === "failed") return nativeResult ? "client" : "client-and-native";
  return nativeResult ? undefined : "native";
}

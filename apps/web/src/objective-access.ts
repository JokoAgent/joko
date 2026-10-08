import type { BackendView, SessionView } from "./model.js";

export type ObjectiveSessionAccess = "hidden" | "readOnly" | "write";

/** Admit ObjectiveService only on the ordinary task surface it owns. */
export function objectiveSessionAccess(
  session: SessionView,
  backend: BackendView | undefined,
  options: {
    readonly connected: boolean;
    readonly reviewReadOnly: boolean;
    readonly embeddedInFiles: boolean;
  }
): ObjectiveSessionAccess {
  if (
    !options.connected
    || options.reviewReadOnly
    || options.embeddedInFiles
    || backend?.id !== session.backendId
    || backend.health === "unavailable"
    || backend.capabilities.get("input.text")?.supported !== true
  ) return "hidden";
  return session.archived || session.state === "closed" ? "readOnly" : "write";
}

import type { AppController } from "./controller.js";

/** Keep code-host navigation behind the same HTTP-only controller boundary as message links. */
export function openCodeHostPullRequestExternal(
  controller: Pick<AppController, "openHttpLink">,
  sessionId: string,
  url: string
): Promise<void> {
  return controller.openHttpLink(url, { forceExternal: true, sessionId });
}

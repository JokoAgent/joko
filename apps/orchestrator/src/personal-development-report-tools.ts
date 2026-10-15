import { PersonalDevelopmentError } from "@joko/personal-development";

import type { BridgeToolCallContext, BridgeToolProvider } from "./mcp-router.js";
import type { PersonalDevelopmentCoordinator } from "./personal-development-coordinator.js";

/** The caller's immutable bridge grant supplies the complete task authority. */
export class PersonalDevelopmentReportTools implements BridgeToolProvider {
  readonly id = "joko_personal_development";
  readonly generation = 1;
  readonly available = true;
  readonly tools = [{ serverId: this.id, name: "report_complete", runtimeName: "report_complete",
    description: "Request completion of this personal development task after implementing and verifying the requested changes. The service records an intent now and captures the result after the turn and all workspace writers retire. Finish this turn after calling the tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, requiresPermission: false }];
  constructor(readonly coordinator: () => PersonalDevelopmentCoordinator | undefined) {}
  includeForSession(sessionId: string, targetId: string): boolean { return this.coordinator()?.includeForSession(sessionId, targetId) ?? false; }
  async callTool(name: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext) {
    signal?.throwIfAborted();
    try {
      if (name !== "report_complete" || Object.keys(input).length > 0) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
      const coordinator = this.coordinator(); if (coordinator === undefined) throw new PersonalDevelopmentError("ENVIRONMENT_NOT_READY");
      const value = coordinator.reportComplete(context);
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false };
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof PersonalDevelopmentError
        ? `Personal task completion was not admitted: ${error.code}.` : "Personal task completion could not be confirmed." }], isError: true };
    }
  }
}

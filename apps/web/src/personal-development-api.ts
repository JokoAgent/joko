import type { MessageInitShape } from "@bufbuild/protobuf";
import type { PersonalDevelopmentDoctorRun, PersonalDevelopmentState, RunPersonalDevelopmentActionRequestSchema, StartPersonalDevelopmentDoctorRequestSchema, StartPersonalDevelopmentTaskRequestSchema } from "@joko/contracts";

export interface PersonalDevelopmentSnapshot {
  readonly available: boolean;
  readonly unavailableReason: string;
  readonly state?: PersonalDevelopmentState;
}
export type PersonalDevelopmentAction = NonNullable<MessageInitShape<typeof RunPersonalDevelopmentActionRequestSchema>["action"]>;
export type PersonalDevelopmentTaskDraft = Omit<MessageInitShape<typeof StartPersonalDevelopmentTaskRequestSchema>, "operationId" | "$typeName">;
export type PersonalDevelopmentDoctorDraft = Omit<MessageInitShape<typeof StartPersonalDevelopmentDoctorRequestSchema>, "operationId" | "$typeName">;
export interface PersonalDevelopmentApi {
  getPersonalDevelopment(signal?: AbortSignal): Promise<PersonalDevelopmentSnapshot>;
  watchPersonalDevelopment(afterGeneration: bigint, onUpdate: (state: PersonalDevelopmentSnapshot) => void, signal: AbortSignal): Promise<void>;
  runPersonalDevelopmentAction(action: PersonalDevelopmentAction, operationId: string, signal?: AbortSignal): Promise<PersonalDevelopmentState | undefined>;
  startPersonalDevelopmentTask(draft: PersonalDevelopmentTaskDraft, operationId: string, signal?: AbortSignal): Promise<{ readonly taskId: string; readonly sessionId?: string; readonly state?: PersonalDevelopmentState }>;
  controlPersonalDevelopmentTask(taskId: string, action: "continue" | "end" | "start_test" | "stop_test" | "retry_preparation", message: string, operationId: string, signal?: AbortSignal): Promise<PersonalDevelopmentState | undefined>;
  startPersonalDevelopmentDoctor(draft: PersonalDevelopmentDoctorDraft, operationId: string, signal?: AbortSignal): Promise<PersonalDevelopmentDoctorRun>;
  controlPersonalDevelopmentDoctor(runId: string, action: "cancel" | "retry" | "wait" | "personal", operationId: string, signal?: AbortSignal): Promise<PersonalDevelopmentDoctorRun>;
}

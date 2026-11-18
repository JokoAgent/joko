export function manualScheduleDispatchOperationId(operationId: string): string {
  return `manual-schedule-${operationId}`;
}

export function scheduleRunIdFromDigest(digest: string): string {
  return `run-${digest.slice(0, 24)}`;
}

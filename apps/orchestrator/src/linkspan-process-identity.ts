import { createDefaultManagedProcessSupervisor } from "@joko/adapter-pi";

// Reuse the existing OS birth-proof implementation; never retire by PID alone.
const supervisor = createDefaultManagedProcessSupervisor();
let currentIdentity: string | undefined;
export function captureLinkspanProcessIdentity(pid: number): string | undefined {
  try { return pid === process.pid ? currentIdentity ??= supervisor.captureSync(pid) : supervisor.captureSync(pid); }
  catch { return undefined; }
}
export function ownLinkspanProcessIdentity(): string {
  const identity = captureLinkspanProcessIdentity(process.pid);
  if (identity === undefined) throw new Error("The SDK endpoint's owning process identity could not be captured.");
  return identity;
}
export function linkspanProcessIsRetired(pid: number, expectedIdentity?: string): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  const current = captureLinkspanProcessIdentity(pid);
  if (current !== undefined && expectedIdentity !== undefined && current !== expectedIdentity) return true;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error instanceof Error && "code" in error && error.code === "ESRCH"; }
}

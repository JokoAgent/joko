import { ConnectError } from "@connectrpc/connect";

export type SshKeyFailure = "invalid_key" | "invalid_name" | "bad_passphrase" | "key_changed" | "agent_unavailable" | "agent_failed" | "busy" | "aborted" | "outcome_unknown" | "io_failed" | "not_found" | "unknown";

export function sshKeyFailure(cause: unknown): SshKeyFailure {
  if (!(cause instanceof ConnectError)) return "unknown";
  switch (cause.rawMessage) {
    case "ssh_key.invalid_key": return "invalid_key";
    case "ssh_key.invalid_name": return "invalid_name";
    case "ssh_key.bad_passphrase": return "bad_passphrase";
    case "ssh_key.key_changed": return "key_changed";
    case "ssh_key.agent_unavailable": return "agent_unavailable";
    case "ssh_key.agent_failed": return "agent_failed";
    case "ssh_key.busy": return "busy";
    case "ssh_key.aborted": return "aborted";
    case "ssh_key.outcome_unknown": return "outcome_unknown";
    case "ssh_key.io_failed": return "io_failed";
    case "ssh_key.not_found": return "not_found";
    default: return "unknown";
  }
}

export function sshKeyOutcomeUncertain(failure: SshKeyFailure): boolean {
  return failure === "unknown" || failure === "outcome_unknown" || failure === "io_failed";
}

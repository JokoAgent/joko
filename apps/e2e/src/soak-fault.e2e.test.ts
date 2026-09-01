import { RunState, StateImpact } from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createSessionMutation,
  queueRunIdFrom,
  retryRunMutation,
  runIdFrom,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

const configuredFaults = faultMatrix(process.env["JOKO_E2E_FAULTS"]);
const minimumCycles = boundedInteger(process.env["JOKO_E2E_SOAK_ITERATIONS"], 1, 1, 100);
const minimumDurationMs = boundedInteger(process.env["JOKO_E2E_SOAK_DURATION_MS"], 0, 0, 300_000);

describe("configurable queue soak and dispatch fault matrix", () => {
  let fixture: OrchestratorE2eFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("preserves terminal outcomes across clean, crash, unknown, and hung dispatches", { timeout: soakTimeout() }, async () => {
    const startedAt = Date.now();
    let cycle = 0;
    do {
      for (const fault of configuredFaults) {
        await fixture?.close();
        const current = await OrchestratorE2eFixture.start();
        fixture = current;
        const paired = await current.pair("Soak fault matrix");
        const sessionId = sessionIdFrom(await submit(
          paired.clients.operation,
          paired.connectionId,
          createSessionMutation({
            backendId: current.adapter().id,
            targetId: current.targetId(),
            displayName: `Soak ${cycle + 1} ${fault}`
          })
        ));
        if (fault !== "clean") current.adapter().injectFault(sessionId, fault);
        const queued = await submit(
          paired.clients.operation,
          paired.connectionId,
          sendInputMutation(sessionId, `cycle ${cycle + 1} ${fault}`)
        );
        const runId = queueRunIdFrom(queued);
        if (fault === "clean") {
          await waitFor(
            () => paired.clients.run.getRun({ runId }),
            (response) => response.run?.state === RunState.SUCCEEDED,
            "clean soak Run to succeed"
          );
          continue;
        }
        if (fault === "crash") {
          const failed = await waitFor(
            () => paired.clients.run.getRun({ runId }),
            (response) => response.run?.state === RunState.FAILED,
            "pre-accept crash Run to fail"
          );
          expect(failed.run?.error?.code).toBe("FAKE_CRASH");
          current.adapter().clearFault(sessionId);
          const retry = await submit(
            paired.clients.operation,
            paired.connectionId,
            retryRunMutation(runId)
          );
          const retryRunId = runIdFrom(retry);
          await waitFor(
            () => paired.clients.run.getRun({ runId: retryRunId }),
            (response) => response.run?.state === RunState.SUCCEEDED,
            "explicit crash retry to succeed"
          );
          continue;
        }
        if (fault === "dispatch_unknown") {
          const unknown = await waitFor(
            () => paired.clients.run.getRun({ runId }),
            (response) => response.run?.state === RunState.DISPATCH_UNKNOWN,
            "post-accept dispatch to remain unknown"
          );
          expect(unknown.run?.error).toMatchObject({
            code: "FAKE_DISPATCH_UNKNOWN",
            queueImpact: StateImpact.MAY_HAVE_CHANGED,
            nativeSessionImpact: StateImpact.MAY_HAVE_CHANGED
          });
          continue;
        }
        await waitFor(
          async () => current.adapter().sendCalls.length,
          (sendCount) => sendCount === 1,
          "hung dispatch to reach the Backend"
        );
        const durableRoot = current.rootDirectory;
        await current.close({ removeRoot: false });
        fixture = await OrchestratorE2eFixture.start({ rootDirectory: durableRoot });
        const recoveredClients = fixture.clients(paired.authKey);
        await waitFor(
          () => recoveredClients.run.getRun({ runId }),
          (response) => response.run?.state === RunState.DISPATCH_UNKNOWN,
          "hung dispatch to be fenced unknown after restart"
        );
        expect(fixture.adapter().sendCalls).toHaveLength(0);
      }
      cycle += 1;
    } while (cycle < minimumCycles || Date.now() - startedAt < minimumDurationMs);

    expect(cycle).toBeGreaterThanOrEqual(minimumCycles);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(minimumDurationMs);
  });
});

type FaultCase = "clean" | "crash" | "dispatch_unknown" | "hang";

function faultMatrix(value: string | undefined): readonly FaultCase[] {
  const requested = (value ?? "clean,crash,dispatch_unknown,hang")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (requested.length === 0) throw new Error("JOKO_E2E_FAULTS must select at least one fault case.");
  const allowed = new Set<FaultCase>(["clean", "crash", "dispatch_unknown", "hang"]);
  const unique: FaultCase[] = [];
  for (const item of requested) {
    if (!allowed.has(item as FaultCase)) throw new Error(`Unsupported JOKO_E2E_FAULTS entry '${item}'.`);
    if (!unique.includes(item as FaultCase)) unique.push(item as FaultCase);
  }
  return unique;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function soakTimeout(): number {
  return Math.max(20_000, minimumDurationMs + minimumCycles * configuredFaults.length * 10_000 + 10_000);
}

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RUNTIME_PROCESS_MONITOR_MAX_PENDING_REQUESTS,
  RUNTIME_PROCESS_MONITOR_REQUEST_TIMEOUT_MS,
  RuntimeProcessMonitorBroker,
  parseDesktopRuntimeProcessSample,
  parseDesktopRuntimeProcessMonitorOwner,
  parseDesktopRuntimeProcessMonitorRequest,
  parseDesktopRuntimeProcessMonitorResponse,
  sameDesktopRuntimeProcessMonitorOwner,
  type DesktopRuntimeProcessMonitorOwner,
  type DesktopRuntimeProcessMonitorRequest,
  type DesktopRuntimeProcessMonitorResponse
} from "./runtime-process-monitor.js";

const OWNER = Object.freeze({
  version: 1,
  profileId: "profile-1",
  serverId: "server-1",
  connectionGeneration: "7",
  snapshotGeneration: "11"
} satisfies DesktopRuntimeProcessMonitorOwner);

function request(index = 1, owner = OWNER): DesktopRuntimeProcessMonitorRequest {
  return Object.freeze({
    version: 1,
    requestId: uuid(index),
    owner,
    action: Object.freeze({ kind: "refresh" })
  });
}

function response(index = 1, owner = OWNER): DesktopRuntimeProcessMonitorResponse {
  return Object.freeze({
    version: 1,
    requestId: uuid(index),
    owner,
    result: Object.freeze({
      kind: "snapshot",
      locale: "en",
      backends: Object.freeze([Object.freeze({
        backendId: "backend-1",
        backendGeneration: "3",
        backendName: "Local runtime",
        usageSupported: true,
        terminateSupported: true,
        state: "ready",
        capturedAt: 1_000,
        processes: Object.freeze([Object.freeze({
          backendId: "backend-1",
          role: "task-host",
          sessionId: "session-1",
          generation: 2,
          pid: 123,
          cpuPercent: 1.5,
          memoryKb: 4_096,
          processCount: 1,
          terminable: true,
          processInstanceId: "10000000-0000-4000-8000-000000000001"
        })])
      })]),
      sessions: Object.freeze([Object.freeze({
        sessionId: "session-1",
        backendId: "backend-1",
        sessionName: "Task one",
        generation: "2"
      })])
    })
  });
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

afterEach(() => vi.useRealTimers());

describe("runtime process monitor v1 protocol", () => {
  it("accepts only exact read-only Desktop application process projections", () => {
    const sample = {
      version: 1,
      capturedAt: 1_000,
      processes: [{
        role: "renderer",
        pid: 321,
        label: "Task one",
        cpuPercent: 2.5,
        memoryKb: 8_192,
        processCount: 1
      }]
    };
    expect(parseDesktopRuntimeProcessSample(sample)).toEqual(sample);
    expect(() => parseDesktopRuntimeProcessSample({
      ...sample,
      processes: [{ ...sample.processes[0], terminable: true }]
    })).toThrow(/metric/u);
    expect(() => parseDesktopRuntimeProcessSample({
      ...sample,
      processes: [sample.processes[0], { ...sample.processes[0] }]
    })).toThrow(/identities/u);
    expect(() => parseDesktopRuntimeProcessSample({ ...sample, capturedAt: -1 })).toThrow(/sample/u);
  });

  it("accepts only the exact occurrence owner and canonical request identity", () => {
    expect(parseDesktopRuntimeProcessMonitorOwner(OWNER)).toEqual(OWNER);
    expect(() => parseDesktopRuntimeProcessMonitorOwner({ ...OWNER, snapshotGeneration: "01" })).toThrow(/owner/u);
    expect(() => parseDesktopRuntimeProcessMonitorOwner({ ...OWNER, privateOrigin: "http://secret" })).toThrow(/owner/u);
    expect(parseDesktopRuntimeProcessMonitorRequest(request())).toEqual(request());
    expect(() => parseDesktopRuntimeProcessMonitorRequest({ ...request(10), requestId: uuid(10).toUpperCase() })).toThrow(/request/u);
    expect(() => parseDesktopRuntimeProcessMonitorRequest({ ...request(), bearer: "secret" })).toThrow(/request/u);
    const snapshot = response().result;
    if (snapshot.kind !== "snapshot" || snapshot.backends[0]?.state !== "ready") throw new Error("fixture must be ready");
    const terminate = {
      ...request(2),
      action: {
        kind: "terminate",
        backendGeneration: "3",
        process: snapshot.backends[0].processes[0]
      }
    };
    expect(parseDesktopRuntimeProcessMonitorRequest(terminate)).toEqual(terminate);
    expect(() => parseDesktopRuntimeProcessMonitorRequest({
      ...terminate,
      action: { ...terminate.action, backendGeneration: "03" }
    })).toThrow(/action/u);
    const { backendGeneration: _removed, ...oldTerminate } = terminate.action;
    expect(() => parseDesktopRuntimeProcessMonitorRequest({ ...terminate, action: oldTerminate })).toThrow(/action/u);
    expect(sameDesktopRuntimeProcessMonitorOwner(OWNER, { ...OWNER })).toBe(true);
    expect(sameDesktopRuntimeProcessMonitorOwner(OWNER, { ...OWNER, connectionGeneration: "8" })).toBe(false);
    expect(sameDesktopRuntimeProcessMonitorOwner(OWNER, { ...OWNER, snapshotGeneration: "12" })).toBe(false);
  });

  it("accepts a Session-free control plane but rejects it as a termination target", () => {
    const base = response();
    if (base.result.kind !== "snapshot" || base.result.backends[0]?.state !== "ready") throw new Error("fixture must be ready");
    const controlPlane = {
      backendId: "backend-1",
      role: "control-plane" as const,
      pid: 321,
      cpuPercent: 2.5,
      memoryKb: 8_192,
      processCount: 2,
      terminable: false as const
    };
    const value = {
      ...base,
      result: {
        ...base.result,
        backends: [{ ...base.result.backends[0], processes: [controlPlane] }]
      }
    };
    expect(parseDesktopRuntimeProcessMonitorResponse(value)).toEqual(value);
    expect(() => parseDesktopRuntimeProcessMonitorRequest({
      ...request(3),
      action: { kind: "terminate", backendGeneration: "3", process: controlPlane }
    })).toThrow(/termination/u);
  });

  it("parses the direct snapshot shape and enforces backend/session/process ownership", () => {
    expect(parseDesktopRuntimeProcessMonitorResponse(response())).toEqual(response());
    const result = response().result;
    if (result.kind !== "snapshot") throw new Error("fixture must be a snapshot");
    const ready = result.backends[0];
    if (ready?.state !== "ready") throw new Error("fixture must contain a ready Backend");
    expect(() => parseDesktopRuntimeProcessMonitorResponse({
      ...response(),
      result: { ...result, snapshot: { locale: "en", backends: [], sessions: [] } }
    })).toThrow(/result/u);
    expect(() => parseDesktopRuntimeProcessMonitorResponse({
      ...response(),
      result: {
        ...result,
        backends: [{ ...ready, backendGeneration: "03" }]
      }
    })).toThrow(/result|Backend/u);
    expect(() => parseDesktopRuntimeProcessMonitorResponse({
      ...response(),
      result: {
        ...result,
        backends: [{ ...ready, processes: [{ ...ready.processes[0], backendId: "backend-other" }] }]
      }
    })).toThrow(/ownership/u);
    expect(() => parseDesktopRuntimeProcessMonitorResponse({
      ...response(),
      result: {
        ...result,
        backends: [{ ...ready, processes: [{ ...ready.processes[0], terminable: false }] }]
      }
    })).toThrow(/process/u);
    expect(() => parseDesktopRuntimeProcessMonitorResponse({
      ...response(),
      result: {
        ...result,
        backends: [{
          backendId: "backend-1",
          backendName: "Local runtime",
          usageSupported: true,
          terminateSupported: false,
          state: "error",
          error: "Unavailable",
          processes: []
        }]
      }
    })).toThrow(/result|Backend/u);
  });
});

describe("runtime process monitor broker", () => {
  it("routes only exact owner/request/action pairs and fences a reloaded document", () => {
    const onTimeout = vi.fn();
    const broker = new RuntimeProcessMonitorBroker<string>({ onTimeout });
    broker.bind({ owner: OWNER, ownerEndpoint: "owner", monitorEndpoint: "monitor" });
    expect(broker.matchesOwner("owner", { ...OWNER })).toBe(true);
    expect(broker.acceptRequest("monitor", request())).toBe("owner");
    expect(() => broker.acceptRequest("monitor", request())).toThrow(/already pending/u);
    expect(() => broker.acceptResponse("owner", {
      ...response(),
      result: { kind: "terminated" }
    })).toThrow(/pending request/u);
    expect(broker.acceptResponse("owner", response())).toBe("monitor");

    expect(broker.acceptRequest("monitor", request(2))).toBe("owner");
    broker.clearMonitorDocument("monitor");
    expect(() => broker.acceptResponse("owner", response(2))).toThrow(/pending request/u);
    expect(() => broker.acceptRequest("monitor", request(3, { ...OWNER, snapshotGeneration: "12" })))
      .toThrow(/owner occurrence/u);
  });

  it("bounds pending work, supports failed-forward cancellation, and times out once", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const broker = new RuntimeProcessMonitorBroker<string>({ onTimeout });
    broker.bind({ owner: OWNER, ownerEndpoint: "owner", monitorEndpoint: "monitor" });
    for (let index = 1; index <= RUNTIME_PROCESS_MONITOR_MAX_PENDING_REQUESTS; index += 1) {
      broker.acceptRequest("monitor", request(index));
    }
    expect(() => broker.acceptRequest("monitor", request(RUNTIME_PROCESS_MONITOR_MAX_PENDING_REQUESTS + 1)))
      .toThrow(/too many/u);
    broker.cancelRequest("monitor", uuid(1));
    expect(broker.acceptRequest("monitor", request(RUNTIME_PROCESS_MONITOR_MAX_PENDING_REQUESTS + 1))).toBe("owner");

    broker.retire();
    broker.bind({ owner: OWNER, ownerEndpoint: "owner", monitorEndpoint: "monitor" });
    broker.acceptRequest("monitor", request(99));
    vi.advanceTimersByTime(RUNTIME_PROCESS_MONITOR_REQUEST_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith("monitor", {
      version: 1,
      requestId: uuid(99),
      owner: OWNER,
      result: { kind: "error", message: "Runtime process diagnostics did not respond in time." }
    });
    vi.advanceTimersByTime(RUNTIME_PROCESS_MONITOR_REQUEST_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(() => broker.acceptResponse("owner", response(99))).toThrow(/pending request/u);
  });

  it("retires pending generations so late timers and responses cannot cross replacement", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const broker = new RuntimeProcessMonitorBroker<string>({ onTimeout });
    broker.bind({ owner: OWNER, ownerEndpoint: "owner-a", monitorEndpoint: "monitor-a" });
    broker.acceptRequest("monitor-a", request(1));
    const nextOwner = Object.freeze({ ...OWNER, snapshotGeneration: "12" });
    expect(broker.bind({ owner: nextOwner, ownerEndpoint: "owner-b", monitorEndpoint: "monitor-b" }))
      .toEqual({ owner: OWNER, ownerEndpoint: "owner-a", monitorEndpoint: "monitor-a" });
    vi.advanceTimersByTime(RUNTIME_PROCESS_MONITOR_REQUEST_TIMEOUT_MS);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(() => broker.acceptResponse("owner-a", response(1))).toThrow(/owner occurrence/u);
    expect(broker.ownerForMonitor("monitor-b")).toEqual(nextOwner);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  DesktopRuntimeProcessSampler,
  projectDesktopRuntimeProcessSample,
  type ElectronRuntimeProcessMetric
} from "./desktop-runtime-processes.js";

const METRICS = Object.freeze([
  Object.freeze({ pid: 10, type: "Browser", cpu: { percentCPUUsage: 3.25 }, memory: { workingSetSize: 20_480 } }),
  Object.freeze({ pid: 20, type: "Tab", cpu: { percentCPUUsage: 1.5 }, memory: { workingSetSize: 10_240 } }),
  Object.freeze({ pid: 30, type: "GPU", cpu: { percentCPUUsage: 0.25 }, memory: { workingSetSize: 8_192 } }),
  Object.freeze({
    pid: 40,
    type: "Utility",
    serviceName: "network.mojom.NetworkService",
    cpu: { percentCPUUsage: 0.1 },
    memory: { workingSetSize: 4_096 }
  })
] satisfies readonly ElectronRuntimeProcessMetric[]);

describe("desktop runtime process projection", () => {
  it("projects only bounded Electron roles and content-free metrics", () => {
    expect(projectDesktopRuntimeProcessSample(METRICS, 1_000, (pid) => pid === 20 ? "Task one" : null)).toEqual({
      version: 1,
      capturedAt: 1_000,
      processes: [
        { role: "main", pid: 10, label: null, cpuPercent: 3.25, memoryKb: 20_480, processCount: 1 },
        { role: "renderer", pid: 20, label: "Task one", cpuPercent: 1.5, memoryKb: 10_240, processCount: 1 },
        { role: "gpu", pid: 30, label: null, cpuPercent: 0.25, memoryKb: 8_192, processCount: 1 },
        { role: "utility", pid: 40, label: "network.mojom.NetworkService", cpuPercent: 0.1, memoryKb: 4_096, processCount: 1 }
      ]
    });
  });

  it("normalizes labels and invalid counters without accepting ambiguous pids", () => {
    expect(projectDesktopRuntimeProcessSample([{
      pid: 20,
      type: "Tab",
      cpu: { percentCPUUsage: Number.NaN },
      memory: { workingSetSize: -1 }
    }], 2_000, () => "  Renderer\u0000title  ").processes[0]).toEqual({
      role: "renderer",
      pid: 20,
      label: "Renderer title",
      cpuPercent: 0,
      memoryKb: 0,
      processCount: 1
    });
    expect(() => projectDesktopRuntimeProcessSample([
      { pid: 20, type: "Browser" },
      { pid: 20, type: "Tab" }
    ], 2_000, () => null)).toThrow(/identity/u);
  });
});

describe("DesktopRuntimeProcessSampler", () => {
  it("shares one Electron CPU observation across concurrent readers and refreshes after the cache interval", () => {
    let now = 10_000;
    const getMetrics = vi.fn(() => METRICS);
    const sampler = new DesktopRuntimeProcessSampler({
      getMetrics,
      describeRenderer: () => null,
      now: () => now,
      cacheMs: 1_000
    });

    const first = sampler.sample();
    now = 10_999;
    expect(sampler.sample()).toBe(first);
    expect(getMetrics).toHaveBeenCalledTimes(1);

    now = 11_000;
    const next = sampler.sample();
    expect(next).not.toBe(first);
    expect(next.capturedAt).toBe(11_000);
    expect(getMetrics).toHaveBeenCalledTimes(2);
  });
});

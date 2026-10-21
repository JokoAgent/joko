import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForDevelopmentProcessGroupExit } from "./process.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const failure = (code: string) => Object.assign(new Error("Controlled process group probe."), { code });

describe("owned POSIX command group retirement", () => {
  it("waits through a Darwin permission result until the exact group is independently absent", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const kill = vi.spyOn(process, "kill")
      .mockImplementationOnce(() => { throw failure("EPERM"); })
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => { throw failure("ESRCH"); });
    const outcomes: string[] = [];
    const done = waitForDevelopmentProcessGroupExit(4321).then(() => { outcomes.push("absent"); },
      () => { outcomes.push("unknown"); });
    await Promise.resolve();
    expect(outcomes).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(outcomes).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    await done;
    expect(outcomes).toEqual(["absent"]);
    expect(kill.mock.calls).toEqual([[-4321, 0], [-4321, 0], [-4321, 0]]);
  });

  it("never turns persistent Darwin permission denial into a quiescent proof", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    vi.spyOn(process, "kill").mockImplementation(() => { throw failure("EPERM"); });
    const done = waitForDevelopmentProcessGroupExit(4321);
    const rejected = expect(done).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
  });

  it.each(["linux", "freebsd"])("retains a real permission failure on %s", async value => {
    Object.defineProperty(process, "platform", { ...platform, value });
    vi.spyOn(process, "kill").mockImplementation(() => { throw failure("EPERM"); });
    await expect(waitForDevelopmentProcessGroupExit(4321)).rejects.toMatchObject({ code: "EPERM" });
  });

  it("rejects another Darwin probe error and unsafe group identifiers", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw failure("EIO"); });
    await expect(waitForDevelopmentProcessGroupExit(4321)).rejects.toMatchObject({ code: "EIO" });
    for (const pid of [0, 1, -2, 1.5]) await expect(waitForDevelopmentProcessGroupExit(pid)).rejects.toBeInstanceOf(TypeError);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

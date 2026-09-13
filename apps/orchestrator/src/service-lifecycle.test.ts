import { describe, expect, it, vi } from "vitest";

import { OrchestratorServiceLifecycle, OrchestratorStartupInterruptedError } from "./service-lifecycle.js";

describe("Orchestrator service startup lifecycle", () => {
  it("closes a public server created after shutdown intent and waits for startup to settle", async () => {
    const events: string[] = [];
    const fixture = createFixture(events);
    const lifecycle = new OrchestratorServiceLifecycle(fixture.application, fixture.disposeBootstrap);
    let closed = false;
    const closing = lifecycle.requestShutdown("desktop_bootstrap_disconnected").then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    const latePublic = server("public", events);
    lifecycle.registerPublicServer(latePublic);
    expect(() => lifecycle.assertStartupActive()).toThrowError(OrchestratorStartupInterruptedError);
    await Promise.resolve();
    expect(latePublic.close).toHaveBeenCalledOnce();
    expect(fixture.application.close).not.toHaveBeenCalled();

    lifecycle.finishStartup();
    await closing;
    expect(fixture.disposeBootstrap).toHaveBeenCalledOnce();
    expect(fixture.application.lanDiscovery.stop).toHaveBeenCalledOnce();
    expect(latePublic.close).toHaveBeenCalledOnce();
    expect(fixture.application.close).toHaveBeenCalledOnce();
    expect(events.indexOf("application")).toBeGreaterThan(events.indexOf("public"));
  });

  it("closes public and late internal servers exactly once when shutdown lands between creation steps", async () => {
    const events: string[] = [];
    const fixture = createFixture(events);
    const lifecycle = new OrchestratorServiceLifecycle(fixture.application, fixture.disposeBootstrap);
    const publicServer = lifecycle.registerPublicServer(server("public", events));
    const closing = lifecycle.requestShutdown("SIGTERM");
    const internalServer = lifecycle.registerInternalServer(server("internal", events));
    lifecycle.finishStartup();
    await closing;

    expect(publicServer.close).toHaveBeenCalledOnce();
    expect(internalServer.close).toHaveBeenCalledOnce();
    expect(fixture.application.close).toHaveBeenCalledOnce();
    expect(events.indexOf("application")).toBeGreaterThan(events.indexOf("public"));
    expect(events.indexOf("application")).toBeGreaterThan(events.indexOf("internal"));
  });

  it("starts listener drain immediately but closes the application only after in-flight close resolves", async () => {
    const events: string[] = [];
    const fixture = createFixture(events);
    const closeGate = deferred<void>();
    const publicServer = {
      close: vi.fn(async () => {
        events.push("public-start");
        await closeGate.promise;
        events.push("public-finished");
      })
    };
    const lifecycle = new OrchestratorServiceLifecycle(fixture.application, fixture.disposeBootstrap);
    lifecycle.registerPublicServer(publicServer);
    const closing = lifecycle.requestShutdown("SIGTERM");
    lifecycle.finishStartup();
    await Promise.resolve();

    expect(publicServer.close).toHaveBeenCalledOnce();
    expect(fixture.application.close).not.toHaveBeenCalled();
    closeGate.resolve();
    await closing;
    expect(events).toContain("public-finished");
    expect(events.indexOf("application")).toBeGreaterThan(events.indexOf("public-finished"));
  });

  it("does not stop a successfully started persistent daemon merely because startup ownership is released", async () => {
    const events: string[] = [];
    const fixture = createFixture(events);
    const lifecycle = new OrchestratorServiceLifecycle(fixture.application, fixture.disposeBootstrap);
    const publicServer = lifecycle.registerPublicServer(server("public", events));
    const internalServer = lifecycle.registerInternalServer(server("internal", events));
    lifecycle.finishStartup();
    await Promise.resolve();

    expect(lifecycle.shutdownRequested).toBe(false);
    expect(fixture.disposeBootstrap).not.toHaveBeenCalled();
    expect(publicServer.close).not.toHaveBeenCalled();
    expect(internalServer.close).not.toHaveBeenCalled();
    expect(fixture.application.close).not.toHaveBeenCalled();
  });
});

function createFixture(events: string[]) {
  return {
    disposeBootstrap: vi.fn(() => { events.push("bootstrap"); }),
    application: {
      lanDiscovery: {
        stop: vi.fn(async () => { events.push("lan"); })
      },
      close: vi.fn(async () => { events.push("application"); })
    }
  };
}

function server(name: string, events: string[]) {
  return {
    close: vi.fn(async () => { events.push(name); })
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

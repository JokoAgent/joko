import { describe, expect, it, vi } from "vitest";

import { promoteExternalWindowActivation } from "../src/external-window-activation.js";

describe("external Desktop window activation", () => {
  it("uses Windows application focus and z-order promotion", () => {
    const fixture = activationFixture();
    promoteExternalWindowActivation("win32", fixture.application, fixture.window);
    expect(fixture.application.focus).toHaveBeenCalledWith();
    expect(fixture.window.moveTop).toHaveBeenCalledOnce();
    expect(fixture.window.focus).toHaveBeenCalledOnce();
    expect(fixture.window.setAlwaysOnTop).not.toHaveBeenCalled();
  });

  it("uses a bounded macOS steal-focus fence and always removes elevation", () => {
    const fixture = activationFixture();
    fixture.window.focus.mockImplementationOnce(() => { throw new Error("denied"); });
    promoteExternalWindowActivation("darwin", fixture.application, fixture.window);
    expect(fixture.application.focus).toHaveBeenCalledWith({ steal: true });
    expect(fixture.window.setAlwaysOnTop).toHaveBeenNthCalledWith(1, true, "floating");
    expect(fixture.window.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
  });

  it("uses temporary elevation on Linux without application focus theft", () => {
    const fixture = activationFixture();
    promoteExternalWindowActivation("linux", fixture.application, fixture.window);
    expect(fixture.application.focus).not.toHaveBeenCalled();
    expect(fixture.window.setAlwaysOnTop).toHaveBeenNthCalledWith(1, true, "pop-up-menu");
    expect(fixture.window.focus).toHaveBeenCalledOnce();
    expect(fixture.window.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
  });
});

function activationFixture() {
  return {
    application: { focus: vi.fn() },
    window: { moveTop: vi.fn(), focus: vi.fn(), setAlwaysOnTop: vi.fn() }
  };
}

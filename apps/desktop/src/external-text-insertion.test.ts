import { describe, expect, it, vi } from "vitest";

import {
  ExternalTextInsertionCoordinator,
  insertTextIntoCapturedApplication,
  type ExternalClipboard
} from "./external-text-insertion.js";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function clipboardHarness(): {
  readonly clipboard: ExternalClipboard;
  readonly text: () => string;
  readonly html: () => string;
  readonly replace: (text: string, html?: string) => void;
} {
  let current = "before";
  let currentHtml = "";
  const clipboard: ExternalClipboard = {
    availableFormats: () => [],
    readText: () => current,
    readHTML: () => currentHtml,
    readRTF: () => "",
    readBookmark: () => ({ title: "", url: "" }),
    readImage: () => ({ isEmpty: () => true }) as ReturnType<ExternalClipboard["readImage"]>,
    writeText: (value) => { current = value; currentHtml = ""; },
    write: (value) => { current = value.text ?? ""; currentHtml = value.html ?? ""; },
    clear: () => { current = ""; currentHtml = ""; }
  };
  return {
    clipboard,
    text: () => current,
    html: () => currentHtml,
    replace: (text, html = "") => { current = text; currentHtml = html; }
  };
}

describe("captured external text insertion", () => {
  it("keeps transcript text out of the fixed native paste callback", async () => {
    const state = clipboardHarness();
    const write = vi.spyOn(state.clipboard, "write");
    const paste = vi.fn(async (...parameters: unknown[]) => parameters.length === 0);
    const transcript = "private <transcript>\n  next line";
    const result = await insertTextIntoCapturedApplication(transcript, {
      clipboard: state.clipboard,
      paste,
      delay: async () => undefined
    });
    expect(result.inserted).toBe(true);
    expect(paste).toHaveBeenCalledWith();
    expect(write.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      text: transcript,
      html: expect.stringContaining("<!--joko-external-text-owner-v1:")
    }));
    expect(write.mock.calls[0]?.[0].html).toContain("private &lt;transcript&gt;\n  next line");
    await result.restored;
    expect(state.text()).toBe("before");
  });

  it("restores the clipboard immediately when the exact target rejects paste", async () => {
    const state = clipboardHarness();
    const result = await insertTextIntoCapturedApplication("private transcript", {
      clipboard: state.clipboard,
      paste: async () => false
    });
    expect(result.inserted).toBe(false);
    expect(state.text()).toBe("before");
  });

  it("fails closed before paste when another owner replaces the clipboard payload", async () => {
    const state = clipboardHarness();
    const clipboard: ExternalClipboard = {
      ...state.clipboard,
      write: () => state.replace("new clipboard owner")
    };
    const paste = vi.fn(async () => true);
    const result = await insertTextIntoCapturedApplication("private transcript", { clipboard, paste });
    expect(result.inserted).toBe(false);
    expect(paste).not.toHaveBeenCalled();
    expect(state.text()).toBe("new clipboard owner");
  });

  it("fails closed before paste when another owner writes the same text without the private marker", async () => {
    const state = clipboardHarness();
    const clipboard: ExternalClipboard = {
      ...state.clipboard,
      write: (value) => {
        state.clipboard.write(value);
        state.replace(value.text ?? "", "<html><body>same text, different owner</body></html>");
      }
    };
    const paste = vi.fn(async () => true);

    const result = await insertTextIntoCapturedApplication("private transcript", { clipboard, paste });

    expect(result.inserted).toBe(false);
    expect(paste).not.toHaveBeenCalled();
    await result.restored;
    expect(state.text()).toBe("private transcript");
    expect(state.html()).not.toContain("joko-external-text-owner-v1:");
  });

  it("does not restore over a same-text replacement after paste", async () => {
    const state = clipboardHarness();
    const paste = vi.fn(async () => true);
    const result = await insertTextIntoCapturedApplication("private transcript", {
      clipboard: state.clipboard,
      paste,
      delay: async () => {
        state.replace("private transcript", "<html><body>same text, later owner</body></html>");
      }
    });

    expect(result.inserted).toBe(true);
    await result.restored;
    expect(paste).toHaveBeenCalledOnce();
    expect(state.text()).toBe("private transcript");
    expect(state.html()).toBe("<html><body>same text, later owner</body></html>");
  });

  it("keeps one process-wide insertion lease through clipboard restoration", async () => {
    const state = clipboardHarness();
    const pasteFinished = deferred<boolean>();
    const restoreFinished = deferred<void>();
    const coordinator = new ExternalTextInsertionCoordinator();

    const firstPromise = coordinator.insertCaptured("first transcript", {
      clipboard: state.clipboard,
      paste: () => pasteFinished.promise,
      delay: () => restoreFinished.promise
    });
    expect(coordinator.busy()).toBe(true);

    const overlapping = await coordinator.insertCaptured("second transcript", {
      clipboard: state.clipboard,
      paste: async () => true
    });
    expect(overlapping.inserted).toBe(false);
    expect(state.text()).toBe("first transcript");

    pasteFinished.resolve(true);
    const first = await firstPromise;
    expect(first.inserted).toBe(true);
    expect(coordinator.busy()).toBe(true);
    const idle = coordinator.waitForIdle();
    let idleSettled = false;
    void idle.then(() => { idleSettled = true; });
    await Promise.resolve();
    expect(idleSettled).toBe(false);
    restoreFinished.resolve();
    await first.restored;
    await overlapping.restored;
    await idle;
    expect(coordinator.busy()).toBe(false);
    expect(state.text()).toBe("before");
  });

  it("retries clipboard restoration while retaining the process-wide lease", async () => {
    const state = clipboardHarness();
    const originalClear = state.clipboard.clear.bind(state.clipboard);
    let clearAttempts = 0;
    const clipboard: ExternalClipboard = {
      ...state.clipboard,
      clear: () => {
        clearAttempts += 1;
        if (clearAttempts < 3) throw new Error("clipboard temporarily unavailable");
        originalClear();
      }
    };
    const coordinator = new ExternalTextInsertionCoordinator();

    const result = await coordinator.insertCaptured("private transcript", {
      clipboard,
      paste: async () => true,
      delay: async () => undefined
    });

    expect(result.inserted).toBe(true);
    expect(coordinator.busy()).toBe(true);
    await result.restored;
    expect(clearAttempts).toBe(3);
    expect(state.text()).toBe("before");
    expect(coordinator.busy()).toBe(false);
  });

  it("remains unavailable when clipboard restoration cannot be proven", async () => {
    const state = clipboardHarness();
    const clipboard: ExternalClipboard = {
      ...state.clipboard,
      clear: () => { throw new Error("clipboard unavailable"); }
    };
    const coordinator = new ExternalTextInsertionCoordinator();

    const result = await coordinator.insertCaptured("private transcript", {
      clipboard,
      paste: async () => true,
      delay: async () => undefined
    });

    expect(result.inserted).toBe(true);
    await expect(result.restored).rejects.toThrow("External clipboard restoration failed");
    expect(state.text()).toBe("private transcript");
    expect(coordinator.busy()).toBe(true);
    await expect(coordinator.waitForIdle()).rejects.toThrow("External clipboard restoration failed");

    const later = await coordinator.insertCaptured("later transcript", {
      clipboard,
      paste: async () => true
    });
    expect(later.inserted).toBe(false);
    await expect(later.restored).rejects.toThrow("External clipboard restoration failed");
    expect(state.text()).toBe("private transcript");
  });
});

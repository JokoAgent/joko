// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileComposerRichInput } from "./MobileComposerRichInput";
import {
  markMobileComposerSlashCommand,
  plainTextMobileComposerDraft,
  type MobileComposerDraft
} from "./mobile-composer-document";

const bridge = vi.hoisted((): {
  instanceId: string;
  inject: ReturnType<typeof vi.fn<(script: string) => void>>;
  mounts: number;
  onAppStateChange: (state: string) => void;
  onContentProcessDidTerminate: () => void;
  onMessage: (event: { nativeEvent: { data: string } }) => void;
  onRenderProcessGone: () => boolean;
  state: string;
} => ({
  instanceId: "",
  inject: vi.fn<(script: string) => void>(),
  mounts: 0,
  onAppStateChange: () => undefined,
  onContentProcessDidTerminate: () => undefined,
  onMessage: (_event: { nativeEvent: { data: string } }) => undefined,
  onRenderProcessGone: () => true,
  state: "active"
}));

vi.mock("react-native", () => ({
  AppState: {
    get currentState() { return bridge.state; },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      bridge.onAppStateChange = listener;
      return { remove: () => { bridge.onAppStateChange = () => undefined; } };
    }
  },
  Platform: { OS: "ios", isPad: false },
  StyleSheet: { create: (styles: unknown) => styles },
  View: "div"
}));

vi.mock("react-native-webview", async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import("react");
  return {
    WebView: forwardRef((props: {
      readonly onContentProcessDidTerminate: () => void;
      readonly onMessage: (event: { nativeEvent: { data: string } }) => void;
      readonly onRenderProcessGone: () => boolean;
      readonly source: { readonly html: string };
    }, ref) => {
      bridge.onContentProcessDidTerminate = props.onContentProcessDidTerminate;
      bridge.onMessage = props.onMessage;
      bridge.onRenderProcessGone = props.onRenderProcessGone;
      bridge.instanceId = props.source.html.match(/"instanceId":"([^"]+)"/u)?.[1] ?? "";
      useImperativeHandle(ref, () => ({ injectJavaScript: bridge.inject }));
      useEffect(() => { bridge.mounts += 1; }, []);
      return null;
    })
  };
});

const theme = {
  background: "#fff",
  border: "#aaa",
  chip: "#eee",
  focus: "#7755cc",
  placeholder: "#777",
  text: "#111",
  textSecondary: "#555"
};

interface Page {
  document: unknown;
  documentId: number;
  readonly applyDocument: ReturnType<typeof vi.fn>;
  readonly blur: ReturnType<typeof vi.fn>;
  readonly focus: ReturnType<typeof vi.fn>;
  readonly ping: ReturnType<typeof vi.fn>;
  readonly setConfig: ReturnType<typeof vi.fn>;
}

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  bridge.inject.mockReset();
  bridge.mounts = 0;
  bridge.instanceId = "";
  bridge.onAppStateChange = () => undefined;
  bridge.state = "active";
  vi.useRealTimers();
});

function mount(initialDraft: MobileComposerDraft) {
  const onEdit = vi.fn();
  const onError = vi.fn();
  const onBlur = vi.fn();
  const onCommandPaletteKey = vi.fn();
  const onCompositionChange = vi.fn();
  const onPasteText = vi.fn();
  const onSelectionChange = vi.fn();
  const page: Page = {
    document: undefined,
    documentId: 0,
    applyDocument: vi.fn((document: unknown, documentId: number) => {
      page.document = document;
      page.documentId = documentId;
    }),
    blur: vi.fn(),
    focus: vi.fn(),
    ping: vi.fn(),
    setConfig: vi.fn()
  };
  bridge.inject.mockImplementation((script: string) => runInNewContext(script, {
    window: { jokoComposer: page }
  }));
  root = createRoot(document.createElement("div"));
  const render = (draft: MobileComposerDraft) => act(() => root!.render(createElement(MobileComposerRichInput, {
    accessibilityLabel: "Task message",
    commandPaletteOpen: true,
    draft,
    editable: true,
    height: 88,
    maxHeight: 264,
    onBlur,
    onEdit,
    onError,
    onCommandPaletteKey,
    onCompositionChange,
    onPasteText,
    onSelectionChange,
    ownerKey: "profile\u001fsession",
    placeholder: "Message Joko…",
    selection: { start: draft.text.length, end: draft.text.length },
    theme
  })));
  render(initialDraft);
  const send = (message: Record<string, unknown>, instanceId = bridge.instanceId) => act(() => bridge.onMessage({
    nativeEvent: { data: JSON.stringify({ ...message, instanceId }) }
  }));
  const ready = () => send({ type: "ready" });
  return {
    onBlur, onCommandPaletteKey, onCompositionChange, onEdit, onError, onPasteText,
    onSelectionChange, page, ready, render, send
  };
}

describe("mobile composer rich input lifecycle", () => {
  it("restores the latest accepted native document after process loss and ignores old callbacks", () => {
    const mounted = mount(plainTextMobileComposerDraft("initial"));
    mounted.ready();
    const firstDocumentId = mounted.page.documentId;
    const oldInstanceId = bridge.instanceId;
    const oldMessage = bridge.onMessage;
    mounted.send({
      type: "change",
      documentId: firstDocumentId,
      segments: [{ type: "text", text: "typed before reload" }],
      start: 19,
      end: 19
    });
    expect(mounted.onEdit).toHaveBeenCalledTimes(1);

    act(() => {
      bridge.onContentProcessDidTerminate();
      bridge.onContentProcessDidTerminate();
    });
    expect(bridge.mounts).toBe(2);
    expect(bridge.instanceId).not.toBe(oldInstanceId);
    mounted.ready();
    expect(mounted.page.document).toEqual({ version: 1, nodes: [{ type: "text", text: "typed before reload" }] });
    expect(mounted.page.documentId).toBeGreaterThan(firstDocumentId);

    act(() => oldMessage({ nativeEvent: { data: JSON.stringify({
      type: "change",
      instanceId: oldInstanceId,
      documentId: mounted.page.documentId,
      segments: [{ type: "text", text: "late old process" }],
      start: 16,
      end: 16
    }) } }));
    expect(mounted.onEdit).toHaveBeenCalledTimes(1);
  });

  it("increments the document fence for external updates and rejects stale edits", () => {
    const mounted = mount(plainTextMobileComposerDraft("initial"));
    mounted.ready();
    const staleDocumentId = mounted.page.documentId;
    mounted.render(plainTextMobileComposerDraft("external authority"));
    expect(mounted.page.documentId).toBeGreaterThan(staleDocumentId);
    mounted.send({
      type: "change",
      documentId: staleDocumentId,
      segments: [{ type: "text", text: "stale edit" }],
      start: 10,
      end: 10
    });
    expect(mounted.onEdit).not.toHaveBeenCalled();
  });

  it("restores an exact selected slash mark after process loss and demotes an edited mark", () => {
    const draft = markMobileComposerSlashCommand(plainTextMobileComposerDraft("/review next"), 0, "/review");
    const mounted = mount(draft);
    mounted.ready();
    act(() => bridge.onContentProcessDidTerminate());
    mounted.ready();
    expect(mounted.page.document).toEqual({
      version: 1,
      nodes: [
        { type: "text", text: "/review", slashCommand: "/review" },
        { type: "text", text: " next" }
      ]
    });
    mounted.send({
      type: "change",
      documentId: mounted.page.documentId,
      segments: [{ type: "text", text: "/revise next" }],
      start: 7,
      end: 7
    });
    expect(mounted.onEdit).toHaveBeenCalledTimes(1);
    expect(mounted.onEdit.mock.calls[0]?.[0]).toMatchObject({ draft: { slashCommands: [] } });
  });

  it("forwards composition and consumed palette keys only from the active editor instance", () => {
    const mounted = mount(plainTextMobileComposerDraft("/re"));
    mounted.ready();
    const activeInstanceId = bridge.instanceId;
    mounted.send({ type: "composition", composing: true });
    mounted.send({ type: "paletteKey", key: "ArrowDown" });
    expect(mounted.onCompositionChange).toHaveBeenCalledWith(true);
    expect(mounted.onCommandPaletteKey).toHaveBeenCalledWith("ArrowDown");

    mounted.send({ type: "composition", composing: false }, "retired-instance");
    mounted.send({ type: "paletteKey", key: "Enter" }, "retired-instance");
    expect(mounted.onCompositionChange).toHaveBeenCalledTimes(1);
    expect(mounted.onCommandPaletteKey).toHaveBeenCalledTimes(1);

    act(() => bridge.onContentProcessDidTerminate());
    expect(activeInstanceId).not.toBe(bridge.instanceId);
    expect(mounted.onCompositionChange).toHaveBeenLastCalledWith(false);
    expect(mounted.onBlur).toHaveBeenCalledTimes(1);
  });

  it("repairs background DOM changes and forwards paste with the exact accepted draft", () => {
    const draft = plainTextMobileComposerDraft("kept");
    const mounted = mount(draft);
    mounted.ready();
    const firstDocumentId = mounted.page.documentId;
    bridge.state = "background";
    mounted.send({
      type: "change",
      documentId: firstDocumentId,
      segments: [{ type: "text", text: "background edit" }],
      start: 15,
      end: 15
    });
    expect(mounted.onEdit).not.toHaveBeenCalled();
    expect(mounted.page.documentId).toBeGreaterThan(firstDocumentId);

    bridge.state = "active";
    mounted.send({
      type: "paste",
      documentId: mounted.page.documentId,
      start: 4,
      end: 4,
      text: "paste"
    });
    expect(mounted.onPasteText).toHaveBeenCalledWith({
      draft,
      selection: { start: 4, end: 4 },
      text: "paste"
    });
  });

  it("defers a background process recovery until the app becomes active", () => {
    const mounted = mount(plainTextMobileComposerDraft("kept"));
    mounted.ready();
    const oldInstanceId = bridge.instanceId;
    bridge.state = "background";
    act(() => bridge.onContentProcessDidTerminate());
    expect(bridge.mounts).toBe(1);
    expect(bridge.instanceId).toBe(oldInstanceId);

    bridge.state = "active";
    act(() => bridge.onAppStateChange("active"));
    expect(bridge.mounts).toBe(2);
    expect(bridge.instanceId).not.toBe(oldInstanceId);
    mounted.ready();
    expect(mounted.page.document).toEqual({ version: 1, nodes: [{ type: "text", text: "kept" }] });
  });

  it("rebuilds one unresponsive ready editor and clears heartbeat timers on unmount", () => {
    vi.useFakeTimers();
    const mounted = mount(plainTextMobileComposerDraft("initial"));
    mounted.ready();
    act(() => vi.advanceTimersByTime(20_000));
    expect(mounted.page.ping).toHaveBeenCalledTimes(1);
    expect(bridge.mounts).toBe(2);
    expect(mounted.onError).toHaveBeenCalledWith(expect.stringMatching(/stopped responding/u));
    act(() => root?.unmount());
    root = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });
});

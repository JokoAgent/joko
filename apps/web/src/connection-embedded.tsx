import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { ConnectionScreen } from "./components/ConnectionScreen.js";
import type { Translator } from "./components/types.js";
import type { ConnectionScreenActionArguments, ConnectionScreenController, ConnectionScreenState } from "./connection-contract.js";
import { translate } from "./i18n.js";

export interface ConnectionEmbeddedSnapshot {
  readonly instanceId: string;
  readonly state: ConnectionScreenState;
  readonly locale: "en" | "zh-CN" | "zh-TW" | "ja" | "ko";
  readonly dark: boolean;
  readonly messages?: Readonly<Record<string, string>>;
}

export interface ConnectionEmbeddedRuntime {
  update(snapshot: ConnectionEmbeddedSnapshot): void;
  settle(id: number, success: boolean, error?: string): void;
  close(): void;
}

declare global {
  interface Window {
    readonly ReactNativeWebView?: { postMessage(message: string): void };
    jokoConnectionInitial?: ConnectionEmbeddedSnapshot;
    jokoConnection?: ConnectionEmbeddedRuntime;
    jokoConnectionRuntime?: true;
  }
}

const requestTimeoutMs = 60_000;

interface PendingAction {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: number;
}

function embeddedTranslator(snapshot: ConnectionEmbeddedSnapshot): Translator {
  return (key, values) => {
    const message = snapshot.messages?.[key];
    if (message === undefined) return translate(snapshot.locale === "zh-CN" ? "zh-CN" : "en", key, values);
    return message.replace(/\{(\w+)\}/gu, (placeholder: string, name: string) => {
      const value = values?.[name];
      return value === undefined ? placeholder : String(value);
    });
  };
}

export function mountConnectionEmbedded(initial: ConnectionEmbeddedSnapshot): ConnectionEmbeddedRuntime {
  const instanceId = initial.instanceId;
  let snapshot = initial;
  let closed = false;
  let ready = false;
  let sequence = 0;
  const pending = new Map<number, PendingAction>();
  const container = document.getElementById("root") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "root" }));
  const root = createRoot(container);
  const unexpectedError = (): Error => new Error(embeddedTranslator(snapshot)("error.unexpected"));
  const post = (message: object): void => {
    if (closed || window.ReactNativeWebView === undefined) throw unexpectedError();
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  const request = <Name extends keyof ConnectionScreenActionArguments>(name: Name, args: ConnectionScreenActionArguments[Name]): Promise<void> => {
    if (closed) return Promise.reject(unexpectedError());
    const id = ++sequence;
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(unexpectedError());
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        post({ type: "action", instanceId, id, name, args });
      } catch {
        window.clearTimeout(timer);
        pending.delete(id);
        reject(unexpectedError());
      }
    });
  };
  const notify = <Name extends keyof ConnectionScreenActionArguments>(name: Name, args: ConnectionScreenActionArguments[Name]): void => {
    void request(name, args).catch(() => undefined);
  };
  const controller: ConnectionScreenController = {
    get state() { return snapshot.state; },
    connect: (profile, options) => request("connect", options === undefined ? [profile.id] : [profile.id, options]),
    pair: (origin, code, deviceName, options) => request("pair", options === undefined ? [origin, code, deviceName] : [origin, code, deviceName, options]),
    disconnect: () => request("disconnect", []),
    forgetProfile: (profileId) => request("forgetProfile", [profileId]),
    refreshDiscoveredNodes: () => request("refreshDiscoveredNodes", []),
    retryManagedOrchestrator: () => request("retryManagedOrchestrator", []),
    cancelAutomaticConnectionAttempt: () => notify("cancelAutomaticConnectionAttempt", []),
    setAutomaticConnectionEnabled: (enabled) => request("setAutomaticConnectionEnabled", [enabled]),
    setTheme: (theme) => request("setTheme", [theme]),
    inspect: (origin) => request("inspect", [origin]),
    requestPairing: (origin, deviceName) => request("requestPairing", [origin, deviceName]),
    cancelPairing: () => notify("cancelPairing", []),
    recheckSavedProfiles: () => request("recheckSavedProfiles", []),
    goBack: () => request("goBack", []),
    selectMode: (mode) => notify("selectMode", [mode])
  };

  function EmbeddedPage({ value }: { readonly value: ConnectionEmbeddedSnapshot }): React.JSX.Element {
    useLayoutEffect(() => {
      if (ready || closed) return;
      ready = true;
      try { post({ type: "ready", instanceId }); } catch { /* The host owns availability and retry. */ }
    }, []);
    return <ConnectionScreen controller={controller} t={embeddedTranslator(value)} />;
  }

  const render = (): void => {
    document.documentElement.lang = snapshot.locale;
    document.documentElement.dataset.theme = snapshot.dark ? "dark" : "light";
    root.render(<EmbeddedPage value={snapshot} />);
  };
  const runtime: ConnectionEmbeddedRuntime = {
    update(next) {
      if (closed || next.instanceId !== instanceId) return;
      snapshot = next;
      render();
    },
    settle(id, success, error) {
      if (closed || !Number.isSafeInteger(id) || id < 1 || typeof success !== "boolean") return;
      const action = pending.get(id);
      if (action === undefined) return;
      pending.delete(id);
      window.clearTimeout(action.timer);
      if (success) action.resolve();
      else action.reject(typeof error === "string" && error.length > 0 ? new Error(error) : unexpectedError());
    },
    close() {
      if (closed) return;
      closed = true;
      window.removeEventListener("pagehide", onPageHide);
      root.unmount();
      for (const action of pending.values()) {
        window.clearTimeout(action.timer);
        action.reject(unexpectedError());
      }
      pending.clear();
    }
  };
  const onPageHide = (): void => runtime.close();
  window.addEventListener("pagehide", onPageHide);
  window.jokoConnection = runtime;
  render();
  return runtime;
}

window.jokoConnectionRuntime = true;
const start = (): void => {
  if (window.jokoConnectionInitial !== undefined) mountConnectionEmbedded(window.jokoConnectionInitial);
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();

import { requireOptionalNativeModule } from "expo-modules-core";
import { randomUUID } from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import { AppState, Platform } from "react-native";
import type { ExtensionOAuthAuthorization } from "@joko/contracts";

interface NativeReceiver {
  start(options: { id: string; callbackUrl: string; state: string; expiresAt: number }): Promise<void>;
  wait(id: string): Promise<unknown>;
  status(id: string): Promise<string>;
  close(id: string): Promise<void>;
}

/** The phone receives only the exact callback. The node owns PKCE and exchange. */
export async function authorizeMobileExtensionAccount(authorization: ExtensionOAuthAuthorization, expiresAt: number,
  signal: AbortSignal, assertCurrent: () => void): Promise<{ readonly state: string; readonly code?: string; readonly error?: string }> {
  const native = requireOptionalNativeModule<NativeReceiver>("JokoPluginOauth");
  if (!native) throw new Error("Update the mobile app to authorize plugin accounts.");
  const callback = new URL(authorization.callbackUrl), target = new URL(authorization.authorizeUrl);
  if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || !callback.port || Number(callback.port) < 1024
    || callback.username || callback.password || callback.search || callback.hash || !/^\/[A-Za-z0-9._~/-]*$/u.test(callback.pathname)
    || target.protocol !== "https:" || target.username || target.password || !authorization.state || authorization.state.length > 256
    || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 310_000) throw new Error("Plugin callback is not supported.");
  const id = randomUUID(); let closed = false, browserOpened = false, left = false;
  let reject!: (error: Error) => void; const cancelled = new Promise<never>((_resolve, fail) => { reject = fail; });
  const stop = () => { if (closed) return; closed = true; void native.close(id).catch(() => undefined); reject(new Error("Plugin authorization cancelled.")); };
  const current = () => { assertCurrent(); if (closed || signal.aborted || Date.now() >= expiresAt) throw new Error("Plugin authorization retired."); };
  let returnTimer: ReturnType<typeof setTimeout> | undefined;
  const subscription = AppState.addEventListener("change", state => {
    if (!browserOpened) return;
    if (state === "background" && Platform.OS === "android") left = true;
    else if (state === "active" && left && Platform.OS === "android") {
      left = false; clearTimeout(returnTimer);
      returnTimer = setTimeout(() => { void native.status(id).then(status => { if (status !== "received") stop(); }, stop); }, 500);
    }
  });
  signal.addEventListener("abort", stop, { once: true });
  const timer = setInterval(() => { try { current(); } catch { stop(); } }, 200);
  try {
    current();
    const start = native.start({ id, callbackUrl: authorization.callbackUrl, state: authorization.state, expiresAt });
    void start.then(() => { if (closed) void native.close(id).catch(() => undefined); }, () => undefined);
    await Promise.race([start, cancelled]); current();
    const received = native.wait(id); browserOpened = true;
    const browser = WebBrowser.openBrowserAsync(authorization.authorizeUrl, { showTitle: true }).then(async result => {
      if (result.type !== "opened" && await native.status(id) !== "received") stop();
      return new Promise<never>(() => undefined);
    });
    const raw = await Promise.race([received, browser, cancelled]); current();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Plugin callback is invalid.");
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some(key => !["state", "code", "error"].includes(key)) || value.state !== authorization.state
      || (typeof value.code === "string") === (typeof value.error === "string")
      || typeof value.code === "string" && (!value.code || value.code.length > 8192)
      || typeof value.error === "string" && (!value.error || value.error.length > 256)) throw new Error("Plugin callback is invalid.");
    // Do not dispatch protected callbacks while the browser owns the foreground.
    while (AppState.currentState !== "active") {
      await Promise.race([new Promise(resolve => setTimeout(resolve, 200)), cancelled]); current();
    }
    return { state: authorization.state, ...(typeof value.code === "string" ? { code: value.code } : { error: "access_denied" }) };
  } finally {
    closed = true; clearInterval(timer); clearTimeout(returnTimer); signal.removeEventListener("abort", stop); subscription.remove();
    await native.close(id).catch(() => undefined);
    if (browserOpened && Platform.OS === "ios") await WebBrowser.dismissBrowser().catch(() => undefined);
  }
}

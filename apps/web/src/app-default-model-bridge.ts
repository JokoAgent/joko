import { useEffect, useRef } from "react";
import { appDefaultModelRouteId, type AppDefaultModelRouteValue } from "@joko/contracts";
import type { AppController } from "./controller.js";
import type { AppSnapshot } from "./model.js";
import type { AppDefaultModelUiPort } from "./app-default-model-ui.js";
import { isModelVisible, modelPreferenceKey, readModelPickerOwnerPreferences, useModelPickerOwnerPreferences } from "./model-picker-preferences.js";
import { readAppDefaultModelPreference, setAppDefaultModelPreference, subscribeAppDefaultModelPreference } from "./app-default-model-preferences.js";
import { randomUuid } from "./web-crypto.js";

export function startAppDefaultModelBridge(port: AppDefaultModelUiPort, ownerId: string, options: {
  readonly signal: AbortSignal; readonly assertCurrent: () => void; readonly snapshot: () => AppSnapshot; readonly now?: () => number;
}) {
  const uiOwnerId = randomUuid(), now = options.now ?? (() => performance.now());
  let ready = false, processing = false, tail: Promise<void> = Promise.resolve();
  const assertCurrent = () => { options.signal.throwIfAborted(); options.assertCurrent(); };
  const mirror = () => {
    const preference = readAppDefaultModelPreference(ownerId), models = options.snapshot().models;
    const picker = readModelPickerOwnerPreferences(ownerId), tuning = new Map(preference.tuning.map(route => [appDefaultModelRouteId(route), route]));
    for (const model of models) {
      const configuration = picker.configurations[modelPreferenceKey(model.backendId, model.providerId, model.modelId)];
      if (configuration) {
        const route = { backendId: model.backendId, providerId: model.providerId, modelId: model.modelId,
          effort: configuration.effort ?? tuning.get(appDefaultModelRouteId(model))?.effort ?? model.efforts[0] ?? "", fastMode: configuration.fast === true };
        tuning.set(appDefaultModelRouteId(route), route);
      }
    }
    if (preference.current !== undefined) tuning.set(appDefaultModelRouteId(preference.current), preference.current);
    return { ...(preference.current === undefined ? {} : { current: preference.current }), tuning: [...tuning.values()],
      visibleRouteIds: models.filter(model => isModelVisible(picker, model.backendId, model.providerId, model.modelId, model.defaultVisible)).map(appDefaultModelRouteId),
      hiddenRouteIds: models.filter(model => !isModelVisible(picker, model.backendId, model.providerId, model.modelId, model.defaultVisible)).map(appDefaultModelRouteId) };
  };
  const sync = (confirmedRequestId?: string) => {
    tail = tail.catch(() => undefined).then(async () => {
      assertCurrent(); if (!ready) return;
      const accepted = await port.syncAppDefaultModel(uiOwnerId, { ...mirror(), ...(confirmedRequestId === undefined ? {} : { confirmedRequestId }) }, options.signal);
      assertCurrent(); if (!accepted) ready = false;
    });
    return tail;
  };
  const refresh = () => { if (!processing) void sync().catch(() => undefined); };
  const unsubscribe = subscribeAppDefaultModelPreference(refresh);
  options.signal.addEventListener("abort", unsubscribe, { once: true });
  const run = async () => {
    for await (const message of port.watchAppDefaultModel(uiOwnerId, options.signal)) {
      assertCurrent();
      if (message.ready) { ready = true; await sync(); continue; }
      if (!ready || !message.requestId || processing) continue;
      processing = true;
      try {
        await tail.catch(() => undefined); assertCurrent();
        const started = now(), request = await port.claimAppDefaultModel(uiOwnerId, message.requestId, options.signal);
        // Start before the round trip: remote clock skew and all request latency
        // reduce this deadline rather than extending the service's five seconds.
        const deadline = started + request.remainingMs;
        const assertRequest = () => { assertCurrent(); if (now() >= deadline) throw new Error("Default-model request expired."); };
        assertRequest();
        if (!routeAvailable(options.snapshot(), ownerId, request.requested)) continue;
        if (setAppDefaultModelPreference(ownerId, request.requested, { route: request.expected, assertCurrent: assertRequest })) await sync(message.requestId);
      } catch { /* No receipt on unknown/expired ownership; read actual state before retry. */ }
      finally { processing = false; refresh(); }
    }
  };
  const task = run().finally(() => { unsubscribe(); options.signal.removeEventListener("abort", unsubscribe); });
  return { refresh, task };
}
function routeAvailable(snapshot: AppSnapshot, ownerId: string, route: AppDefaultModelRouteValue): boolean {
  const backend = snapshot.backends.find(item => item.id === route.backendId);
  const model = snapshot.models.find(item => appDefaultModelRouteId(item) === appDefaultModelRouteId(route));
  return backend !== undefined && backend.health !== "unavailable" && model?.available === true
    && isModelVisible(readModelPickerOwnerPreferences(ownerId), route.backendId, route.providerId, route.modelId, model.defaultVisible)
    && (!route.effort || backend.capabilities.get("model.effort")?.supported === true && model.efforts.includes(route.effort))
    && (!route.fastMode || backend.capabilities.get("model.fast_mode")?.supported === true && model.supportsFast);
}
export function useAppDefaultModelBridge(controller: AppController, enabled: boolean): void {
  const current = useRef(controller); current.current = controller;
  const state = controller.state, ownerId = state.activeProfile?.serverId;
  const picker = useModelPickerOwnerPreferences(ownerId);
  const bridge = useRef<ReturnType<typeof startAppDefaultModelBridge> | undefined>(undefined);
  const owner = !enabled || !state.ready || state.connectionState !== "connected" || !state.activeProfile || !controller.appDefaultModelUi
    ? undefined : JSON.stringify([state.activeProfile.id, state.activeProfile.serverId, state.activeProfile.origin, state.connectionGeneration]);
  useEffect(() => {
    if (!owner || !ownerId || !current.current.appDefaultModelUi) return;
    const abort = new AbortController();
    const assertCurrent = () => {
      const live = current.current.state;
      if (!live.ready || live.connectionState !== "connected" || !live.activeProfile
        || JSON.stringify([live.activeProfile.id, live.activeProfile.serverId, live.activeProfile.origin, live.connectionGeneration]) !== owner) throw new Error("Default-model UI owner changed.");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      if (abort.signal.aborted) return;
      bridge.current = startAppDefaultModelBridge(current.current.appDefaultModelUi!, ownerId, { signal: abort.signal, assertCurrent, snapshot: () => current.current.state.snapshot });
      void bridge.current.task.catch(() => undefined).finally(() => { if (!abort.signal.aborted) timer = setTimeout(start, 1_000); });
    };
    start();
    return () => { abort.abort(); if (timer) clearTimeout(timer); bridge.current = undefined; };
  }, [owner, ownerId]);
  const projection = JSON.stringify([picker.visibility, picker.configurations, state.snapshot.models]);
  useEffect(() => { bridge.current?.refresh(); }, [projection]);
}

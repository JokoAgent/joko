import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { AppController } from "../controller.js";
import { projectNativeTaskStatusSnapshot, resolveNativeTaskStatusPermissionAction } from "../native-task-status-bridge.js";

export function NativeTaskStatusBridge({ controller, ownsProjection, visibleSessionIds }: {
  readonly controller: AppController;
  readonly ownsProjection: boolean;
  readonly visibleSessionIds: readonly string[];
}): JSX.Element | null {
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  const supported = desktop?.capabilities.includes("native.taskStatus") === true;
  const ownerId = controller.state.activeProfile?.serverId;

  useEffect(() => {
    if (!supported || desktop === undefined) return;
    void desktop.nativeTaskStatus.setVisibleSessions(visibleSessionIds).catch(() => undefined);
  }, [desktop, supported, visibleSessionIds]);

  useEffect(() => () => {
    if (!supported || desktop === undefined) return;
    void desktop.nativeTaskStatus.setVisibleSessions([]).catch(() => undefined);
  }, [desktop, supported]);

  useEffect(() => {
    if (!ownsProjection || !supported || desktop === undefined) return;
    const unavailable = controller.state.connectionState !== "connected" || ownerId === undefined;
    const snapshot: JokoDesktopNativeTaskStatusSnapshot = unavailable
      ? {
          ownerId: `renderer-unavailable:${ownerId ?? "none"}`,
          revision: "0",
          locale: controller.state.preferences.locale,
          sessions: []
        }
      : projectNativeTaskStatusSnapshot({
          ownerId,
          revision: controller.state.snapshot.revision,
          locale: controller.state.preferences.locale,
          sessions: controller.state.snapshot.sessions,
          interactions: controller.state.snapshot.interactions,
          timelineBySession: controller.state.snapshot.timelineBySession
        });
    void desktop.nativeTaskStatus.publish(snapshot).catch(() => undefined);
  }, [
    controller.state.connectionState,
    controller.state.preferences.locale,
    controller.state.snapshot.interactions,
    controller.state.snapshot.revision,
    controller.state.snapshot.sessions,
    controller.state.snapshot.timelineBySession,
    desktop,
    ownsProjection,
    ownerId,
    supported
  ]);

  useEffect(() => {
    if (!ownsProjection || !supported || desktop === undefined) return;
    const settling = new Set<string>();
    return desktop.nativeTaskStatus.onAction((action) => {
      if (action.kind !== "permission") return;
      const key = `${action.sessionId}\u0000${action.interactionId}\u0000${action.generation}`;
      if (settling.has(key)) return;
      settling.add(key);
      void resolveNativeTaskStatusPermissionAction(controllerRef.current, action)
        .catch(() => false)
        .finally(() => settling.delete(key));
    });
  }, [desktop, ownsProjection, supported]);

  useEffect(() => () => {
    if (!ownsProjection || !supported || desktop === undefined) return;
    void desktop.nativeTaskStatus.publish({
      ownerId: "renderer-unmounted",
      revision: "0",
      locale: controllerRef.current.state.preferences.locale,
      sessions: []
    }).catch(() => undefined);
  }, [desktop, ownsProjection, supported]);

  return null;
}

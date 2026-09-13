import { useEffect, useMemo, useState, type JSX } from "react";
import type { AppController } from "../controller.js";
import type { AppSnapshot, DeviceControlRelationView, DeviceView } from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { Button, Pill, StatusDot, cx, formatRelativeTime, CheckboxControl, SwitchControl } from "./ui.js";

const PRESENCE_REFRESH_MS = 30_000;

export function deviceControlRelation(
  relations: readonly DeviceControlRelationView[],
  controllerDeviceId: string,
  targetDeviceId: string
): DeviceControlRelationView {
  return relations.find((relation) =>
    relation.controllerDeviceId === controllerDeviceId && relation.targetDeviceId === targetDeviceId
  ) ?? {
    id: `${controllerDeviceId}:${targetDeviceId}`,
    controllerDeviceId,
    targetDeviceId,
    outboundEnabled: true,
    inboundAllowed: true,
    effective: false,
    revision: 0n
  };
}

export function sortControllableDevices(devices: readonly DeviceView[]): readonly DeviceView[] {
  return [...devices].sort((left, right) => {
    const presence = Number(right.presence === "online") - Number(left.presence === "online");
    if (presence !== 0) return presence;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.id.localeCompare(right.id);
  });
}

export function DeviceControlSettings({ controller, snapshot, locale, runAction, t }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly locale: string;
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element | null {
  const activeProfile = controller.state.activeProfile;
  const currentDeviceId = activeProfile?.deviceId;
  const currentDevice = snapshot.devices.find((device) => device.id === currentDeviceId);
  const [name, setName] = useState(currentDevice?.name ?? "");
  useEffect(() => setName(currentDevice?.name ?? ""), [currentDevice?.id, currentDevice?.name]);
  useEffect(() => {
    if (currentDeviceId === undefined) return undefined;
    const timer = window.setInterval(() => void controller.refresh().catch(() => undefined), PRESENCE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [controller, currentDeviceId]);
  const peers = useMemo(() => sortControllableDevices(snapshot.devices.filter((device) =>
    !device.revoked && device.id !== currentDeviceId
  )), [currentDeviceId, snapshot.devices]);

  if (activeProfile === undefined || currentDeviceId === undefined || currentDevice === undefined) return null;
  const canReceiveControl = currentDevice.kind === "desktop" || currentDevice.kind === "service";
  const saveName = (): void => {
    const next = name.trim();
    if (next.length === 0 || next === currentDevice.name) return;
    runAction(`rename-device:${currentDevice.id}`, () => controller.renameDevice(currentDevice.id, next));
  };

  return <section className="device-control-settings" aria-labelledby="device-control-heading">
    <div className="device-control-settings__heading">
      <div>
        <h3 id="device-control-heading">{t("settings.deviceControl.title")}</h3>
        <p>{t("settings.deviceControl.body")}</p>
      </div>
      <Button onClick={() => runAction("refresh-device-control", () => controller.refresh())}>{t("common.refresh")}</Button>
    </div>

    <article className="settings-card device-control-self">
      <div className="device-control-self__identity">
        <StatusDot state={currentDevice.presence} label={t(`settings.deviceControl.${currentDevice.presence}`)} />
        <div>
          <strong>{t("settings.deviceControl.thisDevice")}</strong>
          <small>{currentDevice.platform} · {currentDevice.appVersion}</small>
        </div>
        <Pill tone="success">{t("common.current")}</Pill>
      </div>
      <div className="device-control-name-row">
        <label>
          <span>{t("settings.deviceControl.deviceName")}</span>
          <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter") saveName();
          }} />
        </label>
        <Button disabled={name.trim().length === 0 || name.trim() === currentDevice.name} onClick={saveName}>{t("common.save")}</Button>
      </div>
      <div className={cx("device-control-toggle-row", !canReceiveControl && "is-disabled")}>
        <span>
          <strong>{t("settings.deviceControl.receive")}</strong>
          <small>{canReceiveControl ? t("settings.deviceControl.receiveBody") : t("settings.deviceControl.controllerOnly")}</small>
        </span>
        <SwitchControl
            checked={canReceiveControl && currentDevice.remoteControlEnabled}
            disabled={!canReceiveControl}
            aria-label={t("settings.deviceControl.receive")}
            onChange={(event) => runAction("device-remote-control", () => controller.setDeviceRemoteControlEnabled(event.target.checked))}
          />
      </div>
    </article>

    <div className="device-control-settings__subheading">
      <strong>{t("settings.deviceControl.pairedDevices")}</strong>
      <span>{t("settings.deviceControl.twoSidedConsent")}</span>
    </div>
    <div className="device-control-peer-list">
      {peers.map((peer) => {
        const outbound = deviceControlRelation(snapshot.deviceControlRelations, currentDevice.id, peer.id);
        const inbound = deviceControlRelation(snapshot.deviceControlRelations, peer.id, currentDevice.id);
        const targetCanReceive = peer.kind === "desktop" || peer.kind === "service";
        return <article className="settings-card device-control-peer" key={peer.id}>
          <header>
            <StatusDot state={peer.presence} label={t(`settings.deviceControl.${peer.presence}`)} />
            <div>
              <strong>{peer.name}</strong>
              <small>{peer.kind} · {peer.platform}{peer.lastSeenAt === undefined ? "" : ` · ${formatRelativeTime(peer.lastSeenAt, locale)}`}</small>
            </div>
            <Pill tone={peer.presence === "online" ? "success" : "neutral"}>{t(`settings.deviceControl.${peer.presence}`)}</Pill>
          </header>
          <div className={cx("device-control-toggle-row", !targetCanReceive && "is-disabled")}>
            <span>
              <strong>{t("settings.deviceControl.controlPeer")}</strong>
              <small>{!targetCanReceive
                ? t("settings.deviceControl.peerControllerOnly")
                : peer.remoteControlEnabled
                  ? outbound.effective ? t("settings.deviceControl.routeReady") : t("settings.deviceControl.awaitingPeerConsent")
                  : t("settings.deviceControl.peerOptedOut")}</small>
            </span>
            <SwitchControl
                checked={outbound.outboundEnabled}
                disabled={!targetCanReceive}
                aria-label={t("settings.deviceControl.controlPeerAria", { name: peer.name })}
                onChange={(event) => runAction(`device-control-target:${peer.id}`, () => controller.setDeviceControlTargetEnabled(peer.id, event.target.checked))}
              />
          </div>
          <div className={cx("device-control-toggle-row", (!canReceiveControl || !currentDevice.remoteControlEnabled) && "is-disabled")}>
            <span>
              <strong>{t("settings.deviceControl.allowPeer")}</strong>
              <small>{canReceiveControl && currentDevice.remoteControlEnabled
                ? inbound.inboundAllowed ? t("settings.deviceControl.peerAllowed") : t("settings.deviceControl.peerDenied")
                : t("settings.deviceControl.enableGlobalFirst")}</small>
            </span>
            <SwitchControl
                checked={inbound.inboundAllowed}
                disabled={!canReceiveControl || !currentDevice.remoteControlEnabled}
                aria-label={t("settings.deviceControl.allowPeerAria", { name: peer.name })}
                onChange={(event) => runAction(`device-controller-allowed:${peer.id}`, () => controller.setDeviceControllerAllowed(peer.id, event.target.checked))}
              />
          </div>
        </article>;
      })}
      {peers.length === 0 && <p className="settings-card muted device-control-empty">{t("settings.deviceControl.empty")}</p>}
    </div>
  </section>;
}

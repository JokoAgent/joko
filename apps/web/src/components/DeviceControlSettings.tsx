import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { AppController } from "../controller.js";
import type { AppSnapshot, DeviceControlRelationView, DeviceView } from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { Button, Pill, StatusDot, cx, formatRelativeTime, SwitchControl } from "./ui.js";

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
  const drafts = useRef(new Map<string, DeviceNameDraft>());
  const nameOwner = `${activeProfile?.serverId ?? ""}\u0000${activeProfile?.origin ?? ""}\u0000${activeProfile?.id ?? ""}`;
  const nameOccurrence = `${nameOwner}\u0000${controller.state.connectionGeneration ?? 0}`;
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
      <DeviceNameEditor key={`${nameOccurrence}\u0000${currentDevice.id}`} device={currentDevice} controller={controller}
        ownerId={`${nameOwner}\u0000${currentDevice.id}`} drafts={drafts.current} t={t} />
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
          <DeviceNameEditor key={`${nameOccurrence}\u0000${peer.id}`} device={peer} controller={controller}
            ownerId={`${nameOwner}\u0000${peer.id}`} drafts={drafts.current} t={t} />
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

interface DeviceNameDraft {
  readonly name: string;
  readonly baseline: DeviceView;
  readonly dirty: boolean;
}

function DeviceNameEditor({ device, controller, ownerId, drafts, t }: {
  readonly device: DeviceView;
  readonly controller: AppController;
  readonly ownerId: string;
  readonly drafts: Map<string, DeviceNameDraft>;
  readonly t: Translator;
}): JSX.Element {
  const [draft, setDraft] = useState<DeviceNameDraft>(() => drafts.get(ownerId) ?? { name: device.name, baseline: device, dirty: false });
  const owner = useMemo(() => ({
    rename: controller.renameDevice, reset: controller.resetDeviceName, check: controller.checkDeviceNameUpdate
  }), [controller.renameDevice, controller.resetDeviceName, controller.checkDeviceNameUpdate]);
  const mountedOwner = useRef<typeof owner | undefined>(owner);
  const flight = useRef<object | undefined>(undefined);
  const latestDevice = useRef(device);
  latestDevice.current = device;
  const [feedback, setFeedback] = useState<{
    readonly owner: typeof owner;
    readonly pending: boolean;
    readonly uncertain?: boolean;
    readonly error?: string;
    readonly succeeded?: boolean;
  }>({ owner, pending: false });
  const activeFeedback = feedback.owner === owner ? feedback : { owner, pending: false };
  const pending = activeFeedback.pending;
  const uncertain = activeFeedback.uncertain === true || (!pending && controller.hasPendingDeviceNameUpdate(device.id));
  const projected = draft.baseline.revision > device.revision ? draft.baseline : device;
  useEffect(() => {
    mountedOwner.current = owner;
    return () => {
      if (mountedOwner.current === owner) mountedOwner.current = undefined;
      flight.current = undefined;
    };
  }, [owner]);
  useEffect(() => {
    if (draft.dirty || device.revision < draft.baseline.revision) return;
    const next = { name: device.name, baseline: device, dirty: false };
    drafts.set(ownerId, next);
    setDraft(next);
  }, [device, draft.dirty, draft.baseline.revision, drafts, ownerId]);

  const replaceDraft = (next: DeviceNameDraft): void => {
    drafts.set(ownerId, next);
    setDraft(next);
  };
  const discardDraft = (): void => {
    if (flight.current !== undefined || uncertain) return;
    const current = device.revision >= draft.baseline.revision ? device : draft.baseline;
    replaceDraft({ name: current.name, baseline: current, dirty: false });
    setFeedback({ owner, pending: false });
  };
  const validName = draft.name.trim().length > 0 && draft.name.trim().length <= 120;
  const canSave = validName && (draft.name.trim() !== projected.name || projected.manualDisplayName === undefined);
  const perform = (kind: "rename" | "reset" | "check"): void => {
    if (flight.current !== undefined || mountedOwner.current !== owner || device.revoked) return;
    if (kind !== "check" && uncertain) return;
    if (kind === "rename" && !canSave) return;
    const attempt = {};
    flight.current = attempt;
    setFeedback({ owner, pending: true, uncertain });
    const baseline = draft.dirty ? draft.baseline : projected;
    const action = kind === "check" ? () => owner.check(device.id)
      : kind === "reset" ? () => owner.reset(device.id, projected.revision)
        : () => owner.rename(device.id, draft.name.trim(), baseline.revision);
    const current = (): boolean => mountedOwner.current === owner && flight.current === attempt;
    void action().then((result) => {
      if (!current()) return;
      const latest = latestDevice.current;
      const confirmed = latest.revision > result.revision ? latest : result;
      replaceDraft({ name: confirmed.name, baseline: confirmed, dirty: false });
      setFeedback({ owner, pending: false, succeeded: true });
    }).catch((error: unknown) => {
      if (!current()) return;
      const unconfirmed = error instanceof Error && "code" in error && error.code === "DEVICE_NAME_UNCONFIRMED";
      setFeedback({
        owner, pending: false, uncertain: unconfirmed,
        error: unconfirmed ? t("settings.deviceControl.nameUnconfirmed") : t("settings.deviceControl.nameFailed")
      });
    }).finally(() => { if (current()) flight.current = undefined; });
  };

  return <div className="device-control-name-editor">
    <div className="device-control-name-row">
      <label>
        <span>{t("settings.deviceControl.deviceName")}</span>
        <input value={draft.name} maxLength={120} disabled={pending || uncertain || device.revoked}
          aria-label={t("settings.deviceControl.nameAria", { name: device.name })}
          onChange={(event) => {
            replaceDraft({ name: event.target.value, baseline: projected, dirty: true });
            setFeedback({ owner, pending: false });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); perform("rename"); }
            if (event.key === "Escape") { event.preventDefault(); discardDraft(); }
          }} />
        <small>{t(projected.manualDisplayName === undefined ? "settings.deviceControl.defaultName" : "settings.deviceControl.manualName", { name: projected.defaultDisplayName })}</small>
      </label>
      <div className="device-control-name-actions">
        <Button disabled={pending || uncertain || device.revoked || !canSave} onClick={() => perform("rename")}>{t("common.save")}</Button>
        <Button disabled={pending || uncertain || device.revoked || projected.manualDisplayName === undefined} onClick={() => perform("reset")}>{t("settings.deviceControl.resetName")}</Button>
        {draft.dirty && <Button disabled={pending || uncertain} onClick={discardDraft}>{t("common.cancel")}</Button>}
        {uncertain && <Button disabled={pending || device.revoked} onClick={() => perform("check")}>{t("settings.deviceControl.checkName")}</Button>}
      </div>
    </div>
    {pending && <p role="status">{t("settings.deviceControl.namePending")}</p>}
    {activeFeedback.error !== undefined && <p role="alert">{activeFeedback.error}</p>}
    {activeFeedback.succeeded === true && <p role="status">{t("settings.deviceControl.nameSaved")}</p>}
  </div>;
}

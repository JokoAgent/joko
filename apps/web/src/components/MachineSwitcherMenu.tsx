import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Check, ChevronDown, Laptop, RefreshCw } from "lucide-react";
import type { ConnectionProfile, MachineCacheView, MachinePresenceView } from "../model.js";
import {
  toggleMachineProfile,
  type MachineSelection
} from "../machine-federation.js";
import type { Translator } from "./types.js";
import { IconButton, StatusDot } from "./ui.js";

export interface MachineSwitcherMenuProps {
  readonly profiles: readonly ConnectionProfile[];
  readonly activeProfile: ConnectionProfile;
  readonly presenceByProfile: Readonly<Record<string, MachinePresenceView>>;
  readonly caches: readonly MachineCacheView[];
  readonly selection: MachineSelection;
  readonly locale: string;
  readonly t: Translator;
  readonly onSelectionChange: (selection: MachineSelection) => void;
  readonly onRefresh: () => void;
  readonly onSwitch: (profile: ConnectionProfile) => void;
  readonly onRepair?: (profile: ConnectionProfile) => void;
}

export function MachineSwitcherMenu(props: MachineSwitcherMenuProps): JSX.Element | null {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [unavailableProfileId, setUnavailableProfileId] = useState<string>();
  const cachedIds = useMemo(() => new Set(props.caches.map((cache) => cache.profileId)), [props.caches]);
  const profiles = useMemo(() => props.profiles
    .filter((profile) => profile.id === props.activeProfile.id
      || props.presenceByProfile[profile.id] !== "offline"
      || cachedIds.has(profile.id))
    .sort((left, right) => {
      const current = Number(right.id === props.activeProfile.id) - Number(left.id === props.activeProfile.id);
      return current || left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.id.localeCompare(right.id);
    }), [cachedIds, props.activeProfile.id, props.presenceByProfile, props.profiles]);
  const selected = props.selection === "all" ? new Set(profiles.map((profile) => profile.id)) : new Set(props.selection);
  const unavailableProfile = profiles.find((profile) => profile.id === unavailableProfileId);
  const unavailablePresence = unavailableProfile === undefined ? undefined : props.presenceByProfile[unavailableProfile.id];
  useEffect(() => {
    if (unavailableProfile === undefined || (unavailablePresence !== "identityMismatch" && unavailablePresence !== "accessDenied")) {
      setUnavailableProfileId(undefined);
    }
  }, [unavailablePresence, unavailableProfile]);
  if (profiles.length < 2) return null;

  const switchMachine = (profile: ConnectionProfile): void => {
    const presence = props.presenceByProfile[profile.id];
    if (presence === "identityMismatch" || presence === "accessDenied") {
      setUnavailableProfileId(profile.id);
      return;
    }
    setUnavailableProfileId(undefined);
    detailsRef.current?.removeAttribute("open");
    props.onSelectionChange([profile.id]);
    props.onSwitch(profile);
  };
  return <details className="machine-switcher" ref={detailsRef}>
    <summary aria-label={props.t("machine.openSwitcher")}>
      <Laptop aria-hidden="true" />
      <span>
        <strong>{props.activeProfile.name}</strong>
        <small>{props.selection === "all" ? props.t("machine.all") : props.t("machine.selectedCount", { count: selected.size })}</small>
      </span>
      <StatusDot state={props.presenceByProfile[props.activeProfile.id] === "offline" ? "offline" : "connected"} label={machinePresenceLabel(props.presenceByProfile[props.activeProfile.id] ?? "current", props.t)} />
      <ChevronDown aria-hidden="true" />
    </summary>
    <div className="machine-switcher__menu">
      <header>
        <div><strong>{props.t("machine.title")}</strong><small>{props.t("machine.body")}</small></div>
        <IconButton label={props.t("machine.refresh")} onClick={props.onRefresh}><RefreshCw aria-hidden="true" /></IconButton>
      </header>
      <button
        type="button"
        className="machine-switcher__all"
        role="checkbox"
        aria-checked={props.selection === "all"}
        onClick={() => props.onSelectionChange("all")}
      ><span aria-hidden="true">{props.selection === "all" && <Check />}</span><strong>{props.t("machine.all")}</strong><small>{props.t("machine.allBody")}</small></button>
      {unavailableProfile !== undefined && unavailablePresence !== undefined && <div className="machine-switcher__unavailable" role="alert">
        <span>{props.t("machine.unavailableBody", { name: unavailableProfile.name, reason: machinePresenceLabel(unavailablePresence, props.t) })}</span>
        {props.onRepair !== undefined && <button type="button" onClick={() => props.onRepair?.(unavailableProfile)}>{props.t("machine.repair")}</button>}
      </div>}
      <div className="machine-switcher__profiles" role="group" aria-label={props.t("machine.title")}>
        {profiles.map((profile) => {
          const presence = props.presenceByProfile[profile.id] ?? "checking";
          const checked = selected.has(profile.id);
          const denied = presence === "identityMismatch" || presence === "accessDenied";
          return <div className={`machine-switcher__profile${denied ? " is-denied" : ""}`} key={profile.id}>
            <button
              type="button"
              className="machine-switcher__profile-main"
              onClick={(event) => {
                if (!denied && (event.metaKey || event.ctrlKey)) {
                  props.onSelectionChange(toggleMachineProfile(props.selection, profile.id, profiles));
                  return;
                }
                switchMachine(profile);
              }}
              onKeyDown={(event) => {
                if (denied || event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
                event.preventDefault();
                props.onSelectionChange(toggleMachineProfile(props.selection, profile.id, profiles));
              }}
            >
              <StatusDot state={machinePresenceTone(presence)} label={machinePresenceLabel(presence, props.t)} />
              <span><strong>{profile.name}</strong><small>{profile.managedLocal === true ? props.t("machine.local") : profile.origin}</small></span>
              {profile.id === props.activeProfile.id && <em>{props.t("common.current")}</em>}
            </button>
            <IconButton
              className="machine-switcher__profile-check"
              role="checkbox"
              aria-checked={checked}
              disabled={denied}
              disabledReason={denied ? machinePresenceLabel(presence, props.t) : undefined}
              label={props.t("machine.includeAria", { name: profile.name })}
              onClick={() => props.onSelectionChange(toggleMachineProfile(props.selection, profile.id, profiles))}
            ><span aria-hidden="true">{checked && <Check />}</span></IconButton>
          </div>;
        })}
      </div>
    </div>
  </details>;
}

function machinePresenceTone(presence: MachinePresenceView): string {
  if (presence === "current" || presence === "online") return "connected";
  if (presence === "checking") return "connecting";
  if (presence === "identityMismatch" || presence === "accessDenied") return "error";
  return "offline";
}

function machinePresenceLabel(presence: MachinePresenceView, t: Translator): string {
  if (presence === "current") return t("machine.current");
  if (presence === "online") return t("machine.online");
  if (presence === "checking") return t("machine.checking");
  if (presence === "identityMismatch") return t("machine.identityMismatch");
  if (presence === "accessDenied") return t("machine.accessDenied");
  return t("machine.offline");
}

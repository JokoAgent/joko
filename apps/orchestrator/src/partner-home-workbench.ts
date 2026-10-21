import { createHash } from "node:crypto";
import type { PartnerWorkbenchState } from "@joko/core";
import type { OperationalStore, PartnerWorkbenchStore } from "@joko/store";
import type { PartnerHomeLocation, PartnerHomeMoveRecord } from "./partner-home-owner.js";

interface ComputerWorkbench {
  readonly version: 1; readonly deviceId: string; readonly deviceName: string;
  readonly projects: PartnerWorkbenchState["projects"]; readonly judgments: PartnerWorkbenchState["judgments"];
}
/** A retained folder label is never a filesystem grant on a different computer. */
export class PartnerHomeWorkbench {
  constructor(private readonly store: OperationalStore, private readonly workbenches: PartnerWorkbenchStore) {}
  foreign(partnerId: string, currentDeviceId: string): readonly ComputerWorkbench[] {
    return this.store.listSettingsByKeyPrefix("service", `partner-home-workbench:${partnerId}`, "computer.")
      .map(row => this.#read(row.value, partnerId)).filter(value => value.deviceId !== currentDeviceId);
  }
  async portable(partnerId: string, source: PartnerHomeLocation, assertCurrent: () => void) {
    const current = await this.workbenches.read(partnerId); assertCurrent();
    return [...this.foreign(partnerId, source.deviceId), { version: 1 as const, deviceId: source.deviceId, deviceName: source.name,
      projects: current.projects, judgments: current.judgments }];
  }
  async move(move: PartnerHomeMoveRecord, assertCurrent: () => void): Promise<void> {
    const scope = `partner-home-workbench:${move.partnerId}`, receiptKey = `move.${hash(move.requestId)}`;
    let receipt = this.store.findSetting<{ readonly version: 1; readonly target: ComputerWorkbench; readonly installed: boolean }>("service", scope, receiptKey)?.value;
    if (!receipt) {
      const current = await this.workbenches.read(move.partnerId); assertCurrent();
      const previous = this.store.findSetting<unknown>("service", scope, `computer.${hash(move.destination.deviceId)}`)?.value;
      const target: ComputerWorkbench = previous === undefined ? { version: 1, deviceId: move.destination.deviceId, deviceName: move.destination.name, projects: [], judgments: [] } : this.#read(previous, move.partnerId);
      receipt = { version: 1, target, installed: false };
      this.store.transaction(store => { assertCurrent(); store.setSetting("service", scope, `computer.${hash(move.source.location.deviceId)}`,
        { version: 1, deviceId: move.source.location.deviceId, deviceName: move.source.location.name, projects: current.projects, judgments: current.judgments } satisfies ComputerWorkbench);
        store.setSetting("service", scope, receiptKey, receipt!); });
    }
    const target = this.#read(receipt.target, move.partnerId);
    if (receipt.version !== 1 || typeof receipt.installed !== "boolean" || target.deviceId !== move.destination.deviceId) throw new Error("The workbench change owner is invalid.");
    if (receipt.installed) return;
    const current = await this.workbenches.read(move.partnerId); assertCurrent();
    await this.workbenches.replaceHomeState(move.partnerId, current.revision, { projects: target.projects, judgments: target.judgments }, assertCurrent); assertCurrent();
    this.store.setSetting("service", scope, receiptKey, { ...receipt, installed: true });
  }
  #read(value: unknown, partnerId: string): ComputerWorkbench {
    const row = read(value), validated = this.workbenches.validateHomeState(partnerId, row);
    return { ...row, projects: validated.projects, judgments: validated.judgments };
  }
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function read(value: unknown): ComputerWorkbench {
  const row = value as Partial<ComputerWorkbench> | null;
  if (!row || row.version !== 1 || typeof row.deviceId !== "string" || !row.deviceId || row.deviceId.length > 256
    || typeof row.deviceName !== "string" || !row.deviceName.trim() || row.deviceName.length > 256 || /[\u0000-\u001f\u007f]/u.test(row.deviceName)
    || !Array.isArray(row.projects) || !Array.isArray(row.judgments)
    || row.projects.length > 50 || row.judgments.length > 200 || Object.keys(row).some(key => !["version", "deviceId", "deviceName", "projects", "judgments"].includes(key))) {
    throw new Error("The retained computer workbench is invalid.");
  }
  return structuredClone(row as ComputerWorkbench);
}

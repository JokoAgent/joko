import type { OperationalStore } from "@joko/store";

import type {
  RewindPreviewRecord,
  SnapshotFile,
  WorkspaceBaseline,
  WorkspaceChangeSetRecord,
  WorkspaceSnapshotRepository
} from "./workspace-change-set.js";

const SCOPE = "service" as const;
const SCOPE_ID = "orchestrator";
const BASELINE_PREFIX = "workspace_baseline.";
const CHANGE_SET_PREFIX = "workspace_change_set.";
const PREVIEW_PREFIX = "workspace_rewind_preview.";
const CONSUMED_PREFIX = "workspace_rewind_consumed.";

interface StoredBaseline extends Omit<WorkspaceBaseline, "files"> {
  readonly fileEntries: readonly (readonly [string, SnapshotFile])[];
}

/** Durable metadata companion for content-addressed workspace snapshot blobs. */
export class OperationalWorkspaceSnapshotRepository implements WorkspaceSnapshotRepository {
  readonly #store: OperationalStore;

  constructor(store: OperationalStore) {
    this.#store = store;
  }

  async putBaseline(value: WorkspaceBaseline): Promise<void> {
    this.#store.setSetting(SCOPE, SCOPE_ID, `${BASELINE_PREFIX}${value.id}`, encodeBaseline(value));
  }

  async getBaseline(id: string): Promise<WorkspaceBaseline | undefined> {
    const stored = this.#store.findSetting<StoredBaseline>(SCOPE, SCOPE_ID, `${BASELINE_PREFIX}${id}`)?.value;
    return stored === undefined ? undefined : decodeBaseline(stored);
  }

  async listBaselines(): Promise<readonly WorkspaceBaseline[]> {
    return this.#store.listSettings(SCOPE, SCOPE_ID)
      .filter((item) => item.key.startsWith(BASELINE_PREFIX))
      .map((item) => decodeBaseline(item.value as StoredBaseline));
  }

  async putChangeSet(value: WorkspaceChangeSetRecord): Promise<void> {
    this.#store.setSetting(SCOPE, SCOPE_ID, `${CHANGE_SET_PREFIX}${value.id}`, value);
  }

  async getChangeSet(id: string): Promise<WorkspaceChangeSetRecord | undefined> {
    return this.#store.findSetting<WorkspaceChangeSetRecord>(SCOPE, SCOPE_ID, `${CHANGE_SET_PREFIX}${id}`)?.value;
  }

  async listChangeSets(): Promise<readonly WorkspaceChangeSetRecord[]> {
    return this.#store.listSettings(SCOPE, SCOPE_ID)
      .filter((item) => item.key.startsWith(CHANGE_SET_PREFIX))
      .map((item) => item.value as WorkspaceChangeSetRecord);
  }

  async putRewindPreview(value: RewindPreviewRecord): Promise<void> {
    this.#store.setSetting(SCOPE, SCOPE_ID, `${PREVIEW_PREFIX}${value.id}`, value);
  }

  async getRewindPreview(id: string): Promise<RewindPreviewRecord | undefined> {
    return this.#store.findSetting<RewindPreviewRecord>(SCOPE, SCOPE_ID, `${PREVIEW_PREFIX}${id}`)?.value;
  }

  async consumeRewindPreview(id: string, now: number): Promise<boolean> {
    return this.#store.transaction((store) => {
      const preview = store.findSetting<RewindPreviewRecord>(SCOPE, SCOPE_ID, `${PREVIEW_PREFIX}${id}`)?.value;
      if (preview === undefined || preview.expiresAt <= now) return false;
      if (store.findSetting(SCOPE, SCOPE_ID, `${CONSUMED_PREFIX}${id}`) !== undefined) return false;
      store.setSetting(SCOPE, SCOPE_ID, `${CONSUMED_PREFIX}${id}`, { consumedAt: now });
      return true;
    });
  }
}

function encodeBaseline(value: WorkspaceBaseline): StoredBaseline {
  const { files, ...rest } = value;
  return { ...rest, fileEntries: Object.entries(files) };
}

function decodeBaseline(value: StoredBaseline): WorkspaceBaseline {
  const { fileEntries, ...rest } = value;
  return { ...rest, files: Object.fromEntries(fileEntries) };
}

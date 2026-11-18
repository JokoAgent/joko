import type { OperationApi } from "./model.js";

export type PortableSessionImportApi = Pick<OperationApi,
  "inspectPortableSessionImport" | "unlockPortableSessionImport" | "cancelPortableSessionImport"
  | "commitPortableSessionImport" | "retryPortableSessionActivation">;

export interface PortableSessionImportOwner {
  readonly key: string;
  readonly api: PortableSessionImportApi;
}

/** Business calls require the captured owner. Cleanup can only reach that original API. */
export function bindPortableSessionImportApi(source: PortableSessionImportApi | undefined,
  isCurrent: () => boolean): PortableSessionImportApi {
  const original = (): PortableSessionImportApi => {
    if (!source) throw new Error("Connect to Joko before importing a task.");
    return source;
  };
  const check = (): void => {
    if (!isCurrent()) throw new DOMException("The task import connection changed.", "AbortError");
  };
  const checked = async <T>(action: (api: PortableSessionImportApi) => Promise<T>): Promise<T> => {
    check();
    const result = await action(original());
    check();
    return result;
  };
  return {
    inspectPortableSessionImport: async file => {
      check();
      const api = original(), draft = await api.inspectPortableSessionImport(file);
      if (!isCurrent()) {
        await api.cancelPortableSessionImport(draft.draftId).catch(() => undefined);
        check();
      }
      return draft;
    },
    unlockPortableSessionImport: (draftId, password) => checked(api => api.unlockPortableSessionImport(draftId, password)),
    commitPortableSessionImport: input => checked(api => api.commitPortableSessionImport(input)),
    retryPortableSessionActivation: sessionId => checked(api => api.retryPortableSessionActivation(sessionId)),
    cancelPortableSessionImport: draftId => original().cancelPortableSessionImport(draftId)
  };
}

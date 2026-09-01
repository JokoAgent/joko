import type {
  InteractionRecord,
  OperationalStore,
  PersistedEvent,
  QueueItemRecord,
  StoredRun
} from "@joko/store";

const COMPLETE_SCAN_PAGE_SIZE = 100_000;

type QueueItemListOptions = NonNullable<Parameters<OperationalStore["listQueueItems"]>[0]>;
type InteractionListOptions = NonNullable<Parameters<OperationalStore["listInteractions"]>[0]>;
type RunListOptions = NonNullable<Parameters<OperationalStore["listRuns"]>[0]>;

export function visitVisibleSessionEvents(
  store: OperationalStore,
  sessionId: string,
  visitor: (event: PersistedEvent) => void,
  pageSize = COMPLETE_SCAN_PAGE_SIZE
): void {
  visitSessionEvents(store, sessionId, visitor, false, pageSize);
}

export function visitSessionEventsIncludingTombstones(
  store: OperationalStore,
  sessionId: string,
  visitor: (event: PersistedEvent) => void,
  pageSize = COMPLETE_SCAN_PAGE_SIZE
): void {
  visitSessionEvents(store, sessionId, visitor, true, pageSize);
}

function visitSessionEvents(
  store: OperationalStore,
  sessionId: string,
  visitor: (event: PersistedEvent) => void,
  includeTombstoned: boolean,
  pageSize: number
): void {
  assertPageSize(pageSize);
  let afterCursor: bigint | undefined;
  while (true) {
    const page = store.listEvents({
      sessionId,
      ...(includeTombstoned ? { includeTombstoned: true } : {}),
      ...(afterCursor === undefined ? {} : { afterCursor }),
      limit: pageSize
    });
    for (const event of page) visitor(event);
    if (page.length < pageSize) return;
    const nextCursor = page.at(-1)?.globalCursor;
    if (nextCursor === undefined || (afterCursor !== undefined && nextCursor <= afterCursor)) {
      throw new Error("Session Event pagination did not advance.");
    }
    afterCursor = nextCursor;
  }
}

export function listAllVisibleSessionEvents(
  store: OperationalStore,
  sessionId: string,
  pageSize = COMPLETE_SCAN_PAGE_SIZE
): PersistedEvent[] {
  const events: PersistedEvent[] = [];
  visitVisibleSessionEvents(store, sessionId, (event) => events.push(event), pageSize);
  return events;
}

export function listAllQueueItems(
  store: OperationalStore,
  options: Omit<QueueItemListOptions, "limit" | "offset"> = {},
  pageSize = COMPLETE_SCAN_PAGE_SIZE
): QueueItemRecord[] {
  return listAllByOffset(
    (offset) => store.listQueueItems({ ...options, limit: pageSize, offset }),
    pageSize
  );
}

export function listAllInteractions(
  store: OperationalStore,
  options: Omit<InteractionListOptions, "limit" | "offset"> = {},
  pageSize = COMPLETE_SCAN_PAGE_SIZE
): InteractionRecord[] {
  return listAllByOffset(
    (offset) => store.listInteractions({ ...options, limit: pageSize, offset }),
    pageSize
  );
}

export function listAllRuns(
  store: OperationalStore,
  options: Omit<RunListOptions, "limit" | "offset"> = {},
  pageSize = COMPLETE_SCAN_PAGE_SIZE
): StoredRun[] {
  return listAllByOffset(
    (offset) => store.listRuns({ ...options, limit: pageSize, offset }),
    pageSize
  );
}

function listAllByOffset<T>(pageAt: (offset: number) => readonly T[], pageSize: number): T[] {
  assertPageSize(pageSize);
  const values: T[] = [];
  while (true) {
    const page = pageAt(values.length);
    values.push(...page);
    if (page.length < pageSize) return values;
  }
}

function assertPageSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > COMPLETE_SCAN_PAGE_SIZE) {
    throw new RangeError("Complete Store scan page size must be an integer between 1 and 100000.");
  }
}

import { resolve } from "node:path";

const repositoryQueues = new Map<string, Promise<void>>();

export async function enqueueRepositoryWrite<T>(repositoryRoot: string, task: () => Promise<T>): Promise<T> {
  const key = repositoryKey(repositoryRoot);
  const previous = repositoryQueues.get(key) ?? Promise.resolve();
  let resolveTail: (() => void) | undefined;
  const tail = new Promise<void>((resolveCurrent) => {
    resolveTail = resolveCurrent;
  });
  const queuedTail = previous.catch(() => undefined).then(() => tail);
  repositoryQueues.set(key, queuedTail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    resolveTail?.();
    if (repositoryQueues.get(key) === queuedTail) repositoryQueues.delete(key);
  }
}

function repositoryKey(repositoryRoot: string): string {
  const absolute = resolve(repositoryRoot);
  return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}

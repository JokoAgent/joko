import { createClient, type Transport } from "@connectrpc/connect";
import { InputHandoffService } from "@joko/contracts";
import type { AppSnapshot } from "./model.js";

export function watchInputHandoffTasks(options: { readonly transport: Transport; readonly signal: AbortSignal;
  readonly isCurrent: () => boolean; readonly ownerKey: () => string;
  readonly changed: (tasks: NonNullable<AppSnapshot["inputHandoffs"]>) => void }): () => void {
  const client = createClient(InputHandoffService, options.transport), lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined, previous = "";
  const publish = (tasks: NonNullable<AppSnapshot["inputHandoffs"]>) => {
    if (!options.isCurrent() || signal.aborted) return;
    const key = JSON.stringify(tasks); if (key === previous) return; previous = key; options.changed(tasks);
  };
  const read = async () => {
    if (signal.aborted || !options.isCurrent()) return;
    const owner = options.ownerKey();
    try {
      const reply = await client.listInputHandoffTasks({}, { signal });
      if (signal.aborted || !options.isCurrent() || options.ownerKey() !== owner) return;
      if (reply.tasks.length > 10_000) throw new Error("Too many input handoff subjects.");
      const tasks = reply.tasks.map(task => {
        const generation = Number(task.generation);
        if (![task.sessionId, task.requestId].every(id => id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(id))
          || !Number.isSafeInteger(generation) || generation < 0 || task.stepNumber < 1) throw new Error("Invalid input handoff subject.");
        return { sessionId: task.sessionId, requestId: task.requestId, generation, stepNumber: task.stepNumber };
      }).sort((left, right) => left.sessionId.localeCompare(right.sessionId) || left.requestId.localeCompare(right.requestId));
      publish(tasks);
    } catch { if (options.ownerKey() === owner) publish([]); }
    finally {
      if (!signal.aborted && options.isCurrent()) {
        timer = setTimeout(() => { void read(); }, 2_000);
        if (typeof timer === "object") timer.unref();
      }
    }
  };
  void read();
  return () => { lifetime.abort(); clearTimeout(timer); };
}

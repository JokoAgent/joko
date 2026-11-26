import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { effectiveTodoDeadline, type PartnerTodoRecord } from "@joko/core";
import type { PartnerTodoManager } from "./partner-todos.js";
import { toProtoRevision, toProtoTimestamp } from "./proto-mapper.js";

export function createPartnerTodoConnectMethods(manager: PartnerTodoManager | undefined, authenticate: (context: HandlerContext) => unknown):
  Pick<ServiceImpl<typeof contract.PartnerService>, "listPartnerTodos" | "updatePartnerTodo"> {
  const owner = () => { if (!manager) throw new ConnectError("Partner affairs are unavailable.", Code.Unimplemented); return manager; };
  const current = (context: HandlerContext) => { context.signal.throwIfAborted(); return authenticate(context); };
  return {
    listPartnerTodos: (request, context) => {
      current(context);
      if (request.view !== contract.PartnerTodoView.OPEN && request.view !== contract.PartnerTodoView.DONE) throw new ConnectError("Choose a Todo view.", Code.InvalidArgument);
      const page = owner().list(request.partnerId, request.view === contract.PartnerTodoView.OPEN ? "open" : "done", request.offset);
      current(context); return create(contract.ListPartnerTodosResponseSchema, { partnerId: request.partnerId, partnerRevision: toProtoRevision(page.partnerRevision),
        items: page.items.map(toPublicTodo), total: page.total, ...(page.offset + page.items.length < page.total ? { nextOffset: page.offset + page.items.length } : {}),
        ...(page.nextDeferredAt ? { nextDeferredAt: toProtoTimestamp(Date.parse(page.nextDeferredAt)) } : {}) });
    },
    updatePartnerTodo: (_request, context) => {
      current(context);
      throw new ConnectError("Partner todo editing has been retired.", Code.Unimplemented);
    }
  };
}
function toPublicTodo(todo: PartnerTodoRecord): contract.PartnerTodo {
  const deadline = effectiveTodoDeadline(todo);
  return create(contract.PartnerTodoSchema, { id: todo.id, revision: BigInt(todo.revision), title: todo.title, progress: todo.progress, outcome: todo.outcome,
    value: todo.value, ...(todo.next ? { nextLabel: todo.next.label, nextKind: todo.next.kind } : {}),
    sources: todo.sources.map(source => ({ kind: source.kind, label: source.label, ref: source.ref })), status: todo.status,
    createdAt: todo.createdAt, updatedAt: todo.updatedAt, ...(deadline ? { deadline: { kind: deadline.kind, date: deadline.date, timeZone: deadline.timeZone, at: deadline.at } } : {}), history: todo.history });
}

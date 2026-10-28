import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { effectiveTodoDeadline, type PartnerTodoRecord } from "@joko/core";
import type { ConnectionRecord } from "@joko/store";
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
    updatePartnerTodo: (request, context) => {
      const connection = current(context) as ConnectionRecord | undefined;
      if (!connection?.id || !connection.authKeyDigest) throw new ConnectError("The Todo request owner is unavailable.", Code.Unauthenticated);
      const revision = request.expectedPartnerRevision?.value;
      if (!revision || request.expectedRevision < 1n || request.expectedRevision > BigInt(Number.MAX_SAFE_INTEGER)
        || request.action !== contract.PartnerTodoUiAction.DELETE && request.action !== contract.PartnerTodoUiAction.RESTORE) throw new ConnectError("The Todo revision or action is invalid.", Code.InvalidArgument);
      const todo = owner().updateUi({ connection, operationId: request.operationId, partnerId: request.partnerId, partnerRevision: revision,
        todoId: request.todoId, revision: Number(request.expectedRevision), action: request.action === contract.PartnerTodoUiAction.DELETE ? "delete" : "restore", assertCurrent: () => { current(context); } });
      current(context); return create(contract.UpdatePartnerTodoResponseSchema, { partnerId: request.partnerId, todo: toPublicTodo(todo) });
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

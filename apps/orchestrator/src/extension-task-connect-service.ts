import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { ConnectionManager } from "./connection-manager.js";
import type { ExtensionTasks } from "./extension-tasks.js";

/** Host settings and user takeover only; the author runtime cannot call this service. */
export function createExtensionTaskConnectService(tasks: ExtensionTasks | undefined, connections: ConnectionManager, reconcile: () => void): ServiceImpl<typeof contract.ExtensionTaskService> {
  const owner = (context: HandlerContext) => {
    const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
    if (!tasks) throw new ConnectError("Plugin task management is unavailable.", Code.Unavailable);
    const assertCurrent = () => { context.signal.throwIfAborted(); connections.fence(connection); reconcile(); };
    assertCurrent(); return { tasks, assertCurrent };
  };
  const state = (id: string, value: ReturnType<ExtensionTasks["preferences"]>) => create(contract.ExtensionTaskPreferencesSchema, {
    extensionId: id, revision: { value: value.revision }, model: value.config.model && { ...value.config.model, ...contract.encodeModelSpeed(value.config.model.fastMode) }, targetId: value.config.targetId,
    permissionMode: value.config.permissionMode === "auto" ? contract.PermissionMode.AUTO : value.config.permissionMode === "acceptEdits" ? contract.PermissionMode.ACCEPT_EDITS : contract.PermissionMode.ASK,
    showPreferences: value.show, tasksAvailable: value.tasks, models: value.models.map(model => ({ ...model, route: { ...model.route, ...contract.encodeModelSpeed(model.route.fastMode) }, efforts: [...model.efforts] })),
    directories: value.targets.map(target => ({ targetId: target.id, name: target.displayName, backendId: target.backendId })),
    writeRequests: value.writeRequests.map(request => ({ ...request, mode: request.mode === "auto" ? contract.PermissionMode.AUTO : contract.PermissionMode.ACCEPT_EDITS }))
  });
  return {
    getPreferences: (request, context) => { const owned = owner(context); return { preferences: state(request.extensionId, owned.tasks.preferences(request.extensionId)) }; },
    updatePreferences: (request, context) => {
      const owned = owner(context);
      if (!request.expectedRevision || ![contract.PermissionMode.ASK, contract.PermissionMode.ACCEPT_EDITS, contract.PermissionMode.AUTO].includes(request.permissionMode)) throw new ConnectError("A settings revision and supported permission mode are required.", Code.InvalidArgument);
      const result = owned.tasks.updatePreferences(request.extensionId, request.expectedRevision.value, {
        ...(request.model ? { model: { backendId: request.model.backendId, providerId: request.model.providerId, modelId: request.model.modelId,
          ...(request.model.effort === undefined ? {} : { effort: request.model.effort }), fastMode: contract.decodeModelSpeed(request.model) } } : {}), ...(request.targetId === undefined ? {} : { targetId: request.targetId }),
        permissionMode: request.permissionMode === contract.PermissionMode.AUTO ? "auto" : request.permissionMode === contract.PermissionMode.ACCEPT_EDITS ? "acceptEdits" : "ask"
      }, owned.assertCurrent);
      return { preferences: state(request.extensionId, result) };
    },
    listBackgroundTasks: (request, context) => {
      const owned = owner(context); return { tasks: owned.tasks.backgroundTasks(request.extensionId).map(task => ({ ...task, updatedAt: timestampFromMs(task.updatedAt) })) };
    },
    revealTask: (request, context) => { const owned = owner(context); owned.tasks.reveal(request.extensionId, request.taskId, owned.assertCurrent); return { taskId: request.taskId }; },
    retryWriteAccess: async (request, context) => { const owned = owner(context);
      const result = await owned.tasks.retryWriteAccess(request.extensionId, request.taskId, context.signal, owned.assertCurrent);
      owned.assertCurrent(); return { granted: result.granted, preferences: state(request.extensionId, owned.tasks.preferences(request.extensionId)) };
    }
  };
}

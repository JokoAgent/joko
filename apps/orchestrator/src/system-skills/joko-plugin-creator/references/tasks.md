# Managed tasks and one-shot text

Declare `runtime.tasks: {}` to use `joko.tasks`. A plugin that really needs hidden
background tasks declares `runtime.tasks: {"hidden": true}`. Hidden tasks remain
real host Session/Queue/Run records and the user can reveal or take them over.
Do not use hiding to suppress an authorization or user decision.

The current methods are capabilities, models, create, get, list, setModel, send,
getRun, listRuns, readMessages, cancel, setHidden, requestWriteAccess, startTeam,
getTeam, setTeamPlan and releaseWorker. Use exact returned task/run/revision and
operation receipts. Persist request keys before retrying and read an unknown
result; do not create replacement tasks or send a second input speculatively.
Model routes use the actual backendId/providerId/modelId and supported effort/
fastMode. A model unavailable on the selected computer does not authorize a
fallback with another billing identity.

The write-request API defaults to `acceptEdits` and also accepts explicit `auto`.
The actual backend must advertise the requested mode; unsupported modes fail and
are never silently converted. Edit approval requires an unstarted task. Both modes
use a real host permission interaction and the native runtime's observed setting.
An ungranted attempt does not repeatedly prompt: the user may explicitly retry in
host task preferences. Plugins have no retry override. A team must have an immutable
declared plan with exact workers/routes/directories before dispatch.

Delegated native Auto actions require that host-registered plan. The host records
the coordinator's exact route when accepting the plan; a later route change
invalidates that authority. Starting an empty team without a plan does not grant
native Auto execution. A successfully released worker label is durably settled
and cannot be reused or awakened through another dispatch.

Declare `runtime.text: {"oneshot": true}` for `joko.text.oneshot({prompt,
expectJson?, maxTokens?})`. maxTokens, when supplied, is a positive safe integer;
omitting it does not invent an output cap. A selected single-model preference is
authoritative; failure must not switch provider. Without a selection, the host
uses its normal auxiliary text route. This operation does not create a task or
change the global model setting.

The host shows one model/task preferences section for these capabilities unless
`runtime.showTaskPreferences` is false. That field changes presentation only; it
does not revoke API permission, clear settings or remove background-task recovery.
Original-task continuation (`runtime.agent`) is a separate capability.

The host can use an exact configured HTTP route or the selected native Claude/
Codex text-only channel. Native Claude applies maxTokens through its supported
output-budget setting. Native Codex does not support an explicit maxTokens budget:
the argument does not impose an output limit or switch the selected model.
Pi's native review channel is not a plugin one-shot API; configured HTTP routes
remain available. These channels create no ordinary task or tool authorization.
Native text responses retain the existing 24000-character channel bound; HTTP
responses retain the existing 1 MiB budget. A maxTokens argument is not a promise
that a channel can return arbitrarily long text.

## Exact SDK payloads and receipts

以下每个 `await joko.tasks.method(payload)` 直接返回表中的 result，失败抛出带 `error.code` 的 Error；`{ok,result/errorCode}` 只属于私有宿主桥协议，SDK 已解包。`capabilities()`、`models()` 可不传参数。requestKey 是非空、最多256字符的插件自选稳定键。重复 create/send 同键且同内容复用原回执，不产生第二个真实任务/输入；异内容返回 IDEMPOTENCY_CONFLICT。不可把失败后随机换键当重试。

`route = {backendId,providerId,modelId,effort?:string,fastMode:boolean}`，三个 ID 均必须来自 `(await joko.tasks.models()).items[].route`；Fast 与 effort 必须符合该模型事实。`task = {taskId,title,revision,status,hidden,resolvedConfig,permissionMode,planMode}`。revision 为宿主不透明字符串，每次变更前通过 get() 刷新。BigInt 从 runtime 边界以十进制字符串返回。

| 方法 | 输入 payload | result 关键字段 |
| --- | --- | --- |
| capabilities | 无 | version:1、operations、scope、exactRoute、pluginDefaultModel、sourceCallContext、writeAccessModes:["acceptEdits","auto"]、hiddenTasks |
| models | 无 | items:[{route,efforts,supportsFastMode,name}] |
| create | `{requestKey,title,route?,hidden?:boolean,isolatedWorkspace?:boolean,callId?:string}` | task；title最多120字符。route 优先于插件偏好，之后为宿主验证的源调用模型、应用默认模型。隐藏需显式声明 hidden:true。isolatedWorkspace 使用现有 worktree 创建链，受实际目录/后端能力约束。 |
| get | `{taskId}` | task |
| list | `{after?:taskId,limit?:number}` | `{items:task[],nextCursor:string|null}`；limit1–100，默认50 |
| setModel | `{taskId,expectedRevision,route:route|"plugin-default"}` | `{status,task}`，status 是真实宿主 runtime-control 结果；不静默切换到任意模型 |
| send | `{taskId,expectedRevision,requestKey,text}` | run，text最多32768字符，真实 Queue/Run 在派发前原子持久化；插件输入标注为外部应用数据 |
| getRun | `{runId}` | run=`{runId,taskId,status,queueState,acceptedAt,completedAt?,error?,usage}`，usage 仅实际归属信息，否则显式 unavailable |
| listRuns | `{taskId,after?:runId,limit?:number}` | `{items:run[],nextCursor:string|null}`，包括可追溯到原插件输入的真实重试 Run |
| readMessages | `{taskId,after?:decimalEventCursor,limit?:number}` | `{items:[{id,cursor,createdAt,message}],nextCursor:string|null}`；cursor 是宿主事件游标，message 是已持久化 message_complete，扫描页允许为空仍带下一游标 |
| cancel | `{runId}` | 最新 run；仅取消原始输入/归属重试，已完成无副作用，dispatch_unknown 显式 RECONCILING |
| setHidden | `{taskId,hidden:boolean}` | task；隐藏权限声明移除后不得继续由插件改可见性，用户接手/卸载仍可恢复 |
| requestWriteAccess | `{taskId,mode?:"acceptEdits"|"auto"}` | `{granted:boolean,task}`；省略mode为acceptEdits。后端须真实支持该模式；acceptEdits仅未开始任务，planMode不可申请写入。已获准返回true。拒绝/未授予后插件重复调用不再提示，用户可在宿主偏好明确重试原请求；插件不能传retry绕过。原安装/偏好/任务变更撤销旧请求，不映射其他模式 |
| setTeamPlan | `{taskId,plan:{concurrency,task,items:[{label,workingDir,route,task}]}}` | `{ok:true}`；首个输入/worker 前注册，计划不可变；concurrency1–128，items1–1000，总JSON≤1MiB，label≤64，task≤8000字符。workingDir只能任务/其worktree的真实目录与子目录，或用户偏好明确批准目录的准确根 |
| startTeam | `{taskId}` | 新建或既有真实 CollaborationGoalTreeView；需要任务与插件偏好都为Auto且不在planMode。无计划时沿现有受批目录策略，已有计划时按计划精确匹配worker |
| getTeam | `{taskId}` | 真实 CollaborationGoalTreeView，尚无团队为`{team:null}` |
| releaseWorker | `{taskId,workerId,completedAt:number}` | 真实 releaseWorker 返回 tree/worker；completedAt 必须等于该 worker 最新真实 Run 的 endedAt，不可用当前时间代替 |

可用调用模式：

```js
const created = await joko.tasks.create({requestKey: "review:document-42", title: "Review document", hidden: true});
const current = await joko.tasks.get({taskId: created.taskId});
const accepted = await joko.tasks.send({taskId: current.taskId,
  expectedRevision: current.revision, requestKey: "input:document-42:1", text: "Review the supplied document."});
const execution = await joko.tasks.getRun({runId: accepted.runId});
```

`joko.text.oneshot({prompt,expectJson?:boolean,maxTokens?:number,callId?:string})` 直接返回 `{ok:true,text}` 或 `{ok:false,errorCode}`。prompt≤32768字符；maxTokens按当前宿主接受任意正安全整数，省略时不发送显式输出上限；超时60秒。expectJson 要求可解析JSON。明确插件模型失败时绝不换供应商/模型计费身份；没有选择时才跟随辅助模型链。并发限制为每插件8、总32。text不借用普通任务，不创建Session/Run，不向插件交出凭证。明确选择可通过另一引擎的同provider/model真实推理通道执行，但保持其provider/model。

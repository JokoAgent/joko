# Resident runtime: tools and cards

Copy `examples/status/` to the selected task's actual source directory, rename its
npm identity, then validate and pack that copy. The example is a complete plugin:
an empty native entry plus a resident HTML runtime, one declared tool and a card.
The host injects `window.joko` before runtime scripts. Use external package scripts
as in the example. Do not put a runtime script into the displayed card.

## Manifest and tool entry

The manifest binding names the same `entry` as `pi.extensions`. Its `runtime`
requires `html` and `tools`; `tools` is an array of at most 64 unique entries:

```js
{ name: "show_status", description: "Show status",
  inputSchema: {type: "object", properties: {}, additionalProperties: false},
  readOnly: true }
```

Use `readOnly:true` only for operations without external writes. Otherwise omit it
or use false. The schema describes arguments, not a callback or executable code.
The runtime must register each declared tool once:

```js
joko.tools.register("show_status", async ({name, arguments: args, callId,
  sessionId, readOnly, signal}) => {
  signal.throwIfAborted();
  return {ok: true, result: {status: "ready"}};
});
```

The handler receives the host-owned original call/session, exact prepared arguments
and an AbortSignal. Return a JSON-safe `{ok:boolean,result?:object}`. Errors may
return `{ok:false,result:{message:"Useful failure"}}`; throwing also fails the
tool. Do not return BigInt, cycles, DOM objects or secrets. The host applies a
4 MiB envelope bound and cancellation; release your own work when signal aborts.
There is no page API for invoking another arbitrary native tool or service RPC.

## Display a card

Declare `runtime.card:{}`. To request allowed external-link presentation use
`runtime.card:{externalLinks:true}`. Publish inert markup from the original call:

```js
const published = await joko.card.update({callId, html:
  '<p>Ready</p><button data-joko-action="refresh">Refresh</button>',
  height: 180, state: "done"});
if (!published.ok) return {ok:false,result:{message:"The card is unavailable"}};
```

`height` is optional (default 240; range 120–900), `state` is optional `working` or
`done`. `html` is at most 32 KiB. Updates are bounded and throttled; await the result
and do not spin on denial. The host sanitizes tags, CSS, links and media. Scripts,
iframes and inline event handlers do not execute. Escape all untrusted values before
inserting HTML. The host attaches its own `joko_card_id` receipt to a successful
object tool result; do not fabricate or reuse another call's receipt.

User actions are delivered through `joko.onHostMessage(listener)`:

```js
joko.onHostMessage(async event => {
  if (event.type !== "event" || event.name !== "card-action") return;
  if (event.actionId === "refresh") {
    await joko.card.update({callId:event.callId, html:"<p>Refreshed</p>", state:"done"});
  }
});
```

The event contains `callId`, `spawnCallId`, `actionId`, optional `prompt` and
`formValues`, `change:boolean`, `ts` and the original `sessionId`. Keep host IDs
unchanged. `change` is an edit notification, not permission for a background write.

With `runtime.agent:true`, a non-change user action may also carry a one-use
`userActionToken`. Only that event may continue its original task:

```js
const accepted = await joko.agent.run({mode:"continue",
  userActionToken:event.userActionToken, userMessage:"Continue with this result.",
  event:{actionId:event.actionId}});
```

`userMessage` is at most 16000 characters. Check `accepted.ok`; there is no arbitrary
task selector or permanent continuation grant. New managed tasks instead use the
separately declared [tasks API](tasks.md).

## Private runtime storage and locale

The resident page may GET `/kv` for its plugin-scoped JSON object and PUT `/kv`
with a JSON object (64 KiB maximum). This is routing data, not a credential store.
GET `/app-context` returns `{context:{locale}}`. Check HTTP status and JSON errors;
these endpoints are scoped to the approved runtime. They are not URLs for another
plugin, native task control or the main-view bridge.

A main view is separate HTML. It can be ordinary self-contained UI. Declaring
`library:{schemaVersion:1}` additionally supplies `joko.library(operation)` for
that plugin's Library. That bridge handles its own mobile readiness and returns
`{ok:true,...result}` or `{ok:false,errorCode,message}`. It does not expose the
resident tool/network/tasks APIs. Preserve view lifetime and host permissions.

# Scoped network, credentials and file transfer

Resident runtime requests use `joko.network`, supplied only when `runtime.network`
is declared. Native `fetch` is not a route around this boundary. For a fixed API:

```json
{"hosts":["api.example.test"],"secrets":[{"key":"api_key","label":"API key",
  "inject":{"hosts":["api.example.test"],"header":"Authorization","format":"Bearer {value}"}}]}
```

Place this object in `runtime.network`. The user supplies the secret in host plugin
settings. The host injects it; the runtime never receives it. `hosts` accepts up to
eight lowercase DNS names/wildcards. Requests require HTTPS, no explicit port,
URL credentials or an undeclared destination. A wildcard covers subdomains only.
Injection uses one `{value}` placeholder and a declared safe header. It does not
authorize author-supplied Authorization/Cookie headers or arbitrary redirects.

```js
joko.tools.register("read_status", async message => {
  const response = await joko.network.fetch({callId:message.callId,
    url:"https://api.example.test/status", method:"GET", as:"text"});
  if (!response.ok) return {ok:false,result:{message:response.message || "Request failed"}};
  return {ok:true,result:{status:response.status,body:response.body}};
});
```

Declare the tool separately in `runtime.tools`. The result is an object with `ok`,
`status`, bounded/redacted `headers` and string `body`, optionally `truncated`.
An HTTP error status is still a completed HTTP response; inspect status yourself.
Host admission/transport failure returns `ok:false`. Request fields are `callId`,
`url`, optional `method` (GET/HEAD/POST/PUT/PATCH/DELETE), `headers`, string `body`,
`timeoutMs`, `as` and the transfer fields below. GET/HEAD have no body. The author
body limit is 256 KiB. Current read-only task policy refuses write methods.

User-configured service hosts instead use `network.connections:[{key,label,
inject:{header,format},maxConnections?:number}]`. Obtain current selected hosts
with `await joko.network.connections(key)` -> `{ok:true,connections:[{id,host,
label?,default}]}`. Use an actual returned host, not a hardcoded path or token.
`joko.network.accounts(key)` returns host-managed OAuth account summaries for a
declared OAuth secret. An optional `authAccount` chooses an actual returned account;
do not fabricate one. OAuth declaration/provider approval uses host settings and
authorization cards. A missing account is an actionable failure, not permission
to ask a model for a token or put credentials into the manifest.

## Upload and download task files

A tool may declare input `dir:string` and/or `save_dir:string`, describing a user-
authorized absolute path in the current task workspace or approved extra directory.
They are native tool arguments, not arbitrary paths read by resident JavaScript.
When the host admits the call it removes those path fields and passes short-lived
`dir_deposit` / `save_deposit` receipts instead. A single file is allowed for dir.
Keep receipt tokens inside the original call and never put one in a card/history.

```js
const upload = await joko.network.fetch({callId:message.callId,
  url:"https://api.example.test/upload", method:"POST",
  uploadDir:{token:message.arguments.dir_deposit.token, fileField:"attachment"}});
const download = await joko.network.fetch({callId:message.callId,
  url:"https://api.example.test/download", as:"file",
  saveTo:{token:message.arguments.save_deposit.token,filename:"result.zip"}});
```

`fileField` requires exactly one admitted file. For a directory omit it and use
optional `fileFieldPrefix` plus bounded string `fields`; the host supplies multipart
bytes, relative filenames and content type. Do not also supply body or upload.
Download save authority uses create-only semantics: existing files are not replaced.
Inspect the host's returned result before reporting saved/uploaded. A token is not
reusable after permission, workspace, installation or original call changes.

Existing host media can upload with `upload:{hashes:[actualHash],field?:string,
fields?:object}` instead of uploadDir. To receive supported media use `as:"media"`;
only actual returned owned media references may be placed in card media slots.
Neither invent a `joko-media://` reference nor copy it from a foreign task. `as:file`
uses the file receipt; it does not silently turn an arbitrary file into supported
media. Missing/revoked authority must preserve the user's draft and allow explicit
retry through the existing host flow.

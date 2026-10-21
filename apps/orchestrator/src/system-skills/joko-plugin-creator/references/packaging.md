# Validate and package

The distributable is a standard npm `.tgz`, containing one `package/` tree. It is
not a custom archive. Keep package identity and files explicit. Never include
node_modules, credentials, caches, runtime state or development workspaces.

Discover the actual host tools `validate_extension_package` and
`pack_extension_package`. On an available local Workspace, pass
`{"directory":"relative/source/folder"}`. Validation uses the real package parser;
packing uses bundled npm offline, disables lifecycle scripts, validates the
packed tree and returns a downloadable Artifact. It does not install or publish.

Where those host tools are unavailable, in the selected actual source directory
use native terminal commands:

```sh
npm pack --dry-run --json --ignore-scripts
npm pack --json --ignore-scripts
```

Inspect the returned file list and filename. `--ignore-scripts` prevents lifecycle
scripts from becoming an implicit packaging action. Build required assets before
packing with only the build work authorized by the task. The resulting filename
and bytes must actually exist before reporting success. List archive entries and
verify package.json, native entries, declared HTML/scripts, licenses and referenced
assets are present. Validate against the current host's package and Extension
surface parser through the available package-authoring tool, when present.

Exercise the complete function in the requested environment, including absent
credentials, cancellation, permission revocation and stale/reinstalled ownership.
Source checks and an archive listing do not prove a native device or real account
test. Record missing prerequisites precisely.

Installation is a separate user-directed Joko package import and explicit approval.
Do not install just to make packaging appear successful. Local export/import is
the supported distribution route; do not invent public marketplace publication,
signing or a hosted account workflow.

# Current package and manifest

Use a standard package.json with a stable npm name/version and `pi.extensions`
containing its actual runtime Extension entries. Joko's optional surface binding
is `joko.extensionSurfaces`, with `schemaVersion: 1` and `extensions` entries.
All paths are package-relative inspected regular files. No source path may escape
the package or depend on the developer's checkout.

```json
{
  "name": "joko-example",
  "version": "1.0.0",
  "type": "module",
  "files": ["extensions", "ui", "README.md"],
  "pi": {"extensions": ["extensions/index.js"]},
  "joko": {"extensionSurfaces": {"schemaVersion": 1, "extensions": [{
    "entry": "extensions/index.js",
    "mainView": {"html": "ui/index.html", "title": "Example", "icon": "layout"}
  }]}}
}
```

The native entry must use the installed Pi Extension API. For an HTML-only view,
an empty native entry is sufficient: `export default function () {}`. It does not
register a model tool. A declared resident `runtime` has its own exact HTML entry
and tools array; do not confuse it with a native process or grant Node access.

Optional current fields include mainView, library (`schemaVersion: 1`),
routineEvents, runtime and recommendations. A recommendation is authored text,
never authority to invoke an undeclared command. Runtime supports declared tools,
cards, mail readers, scoped networking, original-task continuation, managed tasks
and one-shot text only through the actual declared host SDK. Read the relevant
reference and inspect a real host response before using an unfamiliar capability.

No migration, alternate manifest, compatibility reader or dual write is required
for the current first-release shape. Rebuild incompatible development fixtures.

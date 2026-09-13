# diagrams.net static viewer

Vendored for offline `.drawio` previews. This is the upstream diagrams.net
`viewer-static.min.js` release artifact, version `30.0.4`, licensed under
Apache-2.0; see `LICENSE` in this directory.

The app loads it lazily from `WorkspaceDrawioPreview.tsx`. It must never be
fetched from a CDN or referenced from another local checkout at runtime.

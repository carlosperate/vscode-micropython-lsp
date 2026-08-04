# Python Language Server extension for browser-hosted VS Code

A VS Code extension that runs a Python language server in a **Web Worker**, so Python
IntelliSense works in browser-hosted VS Code with no backend, e.g., `vscode.dev`-style deployments,
static self-hosted builds, and the desktop app alike.

> **Status: not yet implemented.** This currently contains Microsoft's
> [LSP web extension sample](https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-web-extension-sample)
> (MIT) unmodified — colour decorators on `#rrggbb` in plaintext files — committed as a working
> baseline so the language server work lands as a reviewable diff.

## Why this exists

Nothing off the shelf provides Python IntelliSense in a browser-hosted VS Code. Pylance is
proprietary and absent from Open VSX; `ms-python.python`'s browser entry contains no analysis of
its own; every other Python extension on Open VSX (`ms-pyright.pyright`, `detachhead.basedpyright`,
`anysphere.pyright`, `meta.pyrefly`, `charliermarsh.ruff`) ships a `main` entry only, so it cannot
run in the web extension host.

The plan is to drive [`browser-basedpyright`](https://www.npmjs.com/package/browser-basedpyright)
— a browser build of basedpyright, itself descended from the micro:bit Foundation's Pyright fork —
from a `vscode-languageclient/browser` client.

## Layout

```
client/src/browserClientMain.ts   # runs in the extension host worker
server/src/browserServerMain.ts   # runs in a nested Web Worker
esbuild.config.mjs                # both bundles; also exported for host projects
test/bundle.test.ts               # guards the module-format and path constraints
```

The two-bundle split and the `client/dist` + `server/dist` layout are load-bearing — see the
comments in `esbuild.config.mjs`.

## Develop

```sh
npm install
npm run build       # bundles into client/dist and server/dist
npm run typecheck
npm test
npm run chrome      # open a browser with the extension loaded
```

## Consumed from source

Until this is published to Open VSX, the [`vscode-microbit`](../) project in this repository
builds it straight from source rather than from a VSIX: `build-scripts/build-local-extensions.mjs`
imports `getBuildTargets(outDir)` from `esbuild.config.mjs` and assembles the extension directly
into its `dist/`. That wiring is marked temporary and is deleted once this is published — at which
point it becomes an ordinary entry in that project's `config/extensions.config.json`.

Nothing in this folder depends on that project. It is a standalone extension with its own
manifest, dependencies, TypeScript config and tests, and is intended to be extracted to its own
repository.

## Licence

MIT — see `LICENSE`. The vendored sample sources keep Microsoft's original MIT headers; bundled
dependencies (`vscode-languageclient`, `vscode-languageserver`, `vscode-languageserver-textdocument`,
`path-browserify`) are all MIT.

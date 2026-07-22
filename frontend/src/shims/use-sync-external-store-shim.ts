// Local ESM shim replacing the CJS `use-sync-external-store/shim` package.
//
// Why this exists: @base-ui/react (via @base-ui/utils/store/useStore) imports
// `useSyncExternalStore` from the CommonJS package `use-sync-external-store/shim`,
// which internally does `require("react")`. Vite's module-federation plugin can
// only rewrite plain ESM `import ... from "react"` into the shared, host-provided
// React instance — it cannot see through a CJS `require("react")` buried inside a
// bundled dependency. The result: Vite's CJS interop silently inlines a *second,
// private* copy of React into this plugin's bundle. That private copy is what
// @base-ui's internal store subscription (used by DialogRoot, PopoverRoot, etc.)
// ends up calling hooks against — and since it's never actually rendering (no
// dispatcher attached to that copy), every hook call inside it throws
// `TypeError: Cannot read properties of null (reading 'useSyncExternalStore')`.
//
// Fix: alias `use-sync-external-store/shim` (see vite.config.ts resolve.alias)
// to this file instead. It uses a plain ESM `import * as React from "react"`,
// which Vite's federation plugin *does* rewrite to the shared/host React
// instance, so @base-ui ends up calling hooks on the same React the host
// mounted the plugin tree with.
//
// Safe because this plugin's federation config already pins
// `react: { requiredVersion: "^19.0.0" }`, and React 19 has a native
// `useSyncExternalStore` — no polyfill fallback is needed.
import * as React from "react";

export const useSyncExternalStore = React.useSyncExternalStore;

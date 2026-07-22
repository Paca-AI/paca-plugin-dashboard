import path from "node:path";
import react from "@vitejs/plugin-react";
import federation from "@originjs/vite-plugin-federation";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: [
      // @base-ui/react (and @base-ui/utils) import `useSyncExternalStore`
      // from these CJS packages, which internally do `require("react")`.
      // Vite's federation plugin can only rewrite plain ESM `import ...
      // from "react"` into the shared/host React instance — it can't see
      // through a CJS require() buried inside a bundled dependency, so it
      // silently inlines a second, private copy of React into this
      // plugin's bundle. That second copy is what @base-ui's internal
      // store hooks (DialogRoot, PopoverRoot, etc.) call against, and
      // since nothing ever renders with it, every hook call on it throws
      // `Cannot read properties of null (reading 'useSyncExternalStore')`.
      // Aliasing to a local ESM shim lets Vite's federation plugin rewrite
      // the `import * as React from "react"` inside it to the shared
      // instance instead. See src/shims/*.ts for details.
      {
        find: "use-sync-external-store/shim/with-selector",
        replacement: path.resolve(
          __dirname,
          "src/shims/use-sync-external-store-with-selector-shim.ts",
        ),
      },
      {
        find: "use-sync-external-store/shim",
        replacement: path.resolve(
          __dirname,
          "src/shims/use-sync-external-store-shim.ts",
        ),
      },
    ],
  },
  plugins: [
    react(),
    federation({
      name: "com_paca_dashboard",
      filename: "remoteEntry.js",
      exposes: {
        "./ProjectDashboardPage": "./src/ProjectDashboardPage.tsx",
        "./AdminDashboardPage": "./src/AdminDashboardPage.tsx",
        "./DashboardIntegrationView": "./src/DashboardIntegrationView.tsx",
      },
      shared: {
        react: { requiredVersion: "^19.0.0" },
        "react-dom": { requiredVersion: "^19.0.0" },
        "@tanstack/react-query": { requiredVersion: "^5.0.0" },
      },
    }),
  ],
  build: {
    target: "esnext",
    minify: false,
    cssCodeSplit: false,
  },
});

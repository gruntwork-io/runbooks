import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import tailwindcss from "@tailwindcss/vite"
import path from "path"
import { assertNoNestedNodeModules } from "./scripts/no-nested-node-modules.ts"
import { reactWithCompiler } from "./scripts/vite-react.ts"

// A leftover web/node_modules would shadow the root tree for renderer imports.
assertNoNestedNodeModules(__dirname)

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["electron-updater"],
      }),
    ],
    build: {
      outDir: "dist/main",
      rolldownOptions: {
        input: {
          index: path.resolve(__dirname, "electron/main/index.ts"),
        },
        // Bundles the templates of the installed `runbooks` launchers
        // (electron/main/cli-launcher/), which the main process imports
        // `with { type: "text" }`, as strings, as Bun does natively for
        // `bun test`. Rolldown ignores the import attribute itself.
        moduleTypes: { ".sh": "text", ".cmd": "text" },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/preload",
      rolldownOptions: {
        input: {
          index: path.resolve(__dirname, "electron/preload/index.ts"),
          // The Iframe block's local pages (main/embeds.ts).
          embed: path.resolve(__dirname, "electron/preload/embed.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
          // Rolldown only keeps the sources' own "use strict" directives, and
          // these ES module sources have none, so ask for it as Rollup did.
          strict: true,
        },
      },
    },
  },
  renderer: {
    root: path.resolve(__dirname, "web"),
    base: "./",
    plugins: [reactWithCompiler(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "web/src"),
      },
    },
    build: {
      outDir: path.resolve(__dirname, "dist/renderer"),
      rolldownOptions: {
        input: {
          index: path.resolve(__dirname, "web/index.html"),
        },
        output: {
          codeSplitting: {
            groups: [
              { name: "react-vendor", test: /node_modules[\\/](react|react-dom)[\\/]/ },
              {
                name: "mdx-vendor",
                test: /node_modules[\\/](@mdx-js[\\/]mdx|react-markdown|remark-gfm)[\\/]/,
              },
              {
                name: "ui-vendor",
                test: /node_modules[\\/]@radix-ui[\\/](react-alert-dialog|react-tooltip)[\\/]/,
              },
              {
                name: "syntax-highlighter",
                test: /node_modules[\\/]react-syntax-highlighter[\\/]/,
              },
            ],
          },
        },
      },
      chunkSizeWarningLimit: 700,
    },
  },
})

import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import type { Plugin } from "vite"
import tailwindcss from "@tailwindcss/vite"
import fs from "fs"
import path from "path"
import { assertNoNestedNodeModules } from "./scripts/no-nested-node-modules.ts"
import { reactWithCompiler } from "./scripts/vite-react.ts"

// A leftover web/node_modules would shadow the root tree for renderer imports.
assertNoNestedNodeModules(__dirname)

/**
 * Bundles a file imported `with { type: "text" }` as a string, as Bun does
 * natively for `bun test`. The main process imports the templates of the
 * installed `runbooks` launchers (electron/main/cli-launcher/) this way.
 */
function textImports(): Plugin {
  return {
    name: "runbooks:text-imports",
    enforce: "pre",
    load(id) {
      if (this.getModuleInfo(id)?.attributes.type !== "text") return null
      return `export default ${JSON.stringify(fs.readFileSync(id, "utf8"))}`
    },
  }
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["electron-updater"],
      }),
      textImports(),
    ],
    build: {
      outDir: "dist/main",
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, "electron/main/index.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, "electron/preload/index.ts"),
          // The Iframe block's local pages (main/embeds.ts).
          embed: path.resolve(__dirname, "electron/preload/embed.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
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
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, "web/index.html"),
        },
        output: {
          manualChunks: {
            "react-vendor": ["react", "react-dom"],
            "mdx-vendor": ["@mdx-js/mdx", "react-markdown", "remark-gfm"],
            "ui-vendor": ["@radix-ui/react-alert-dialog", "@radix-ui/react-tooltip"],
            "syntax-highlighter": ["react-syntax-highlighter"],
          },
        },
      },
      chunkSizeWarningLimit: 700,
    },
  },
})

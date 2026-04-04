import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react-swc"
import tailwindcss from "@tailwindcss/vite"
import path from "path"

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
        },
      },
    },
  },
  renderer: {
    root: path.resolve(__dirname, "web"),
    plugins: [react(), tailwindcss()],
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
            "mdx-vendor": ["@mdx-js/mdx", "@mdx-js/react", "react-markdown", "remark-gfm"],
            "ui-vendor": [
              "@radix-ui/react-alert-dialog",
              "@radix-ui/react-checkbox",
              "@radix-ui/react-collapsible",
              "@radix-ui/react-label",
              "@radix-ui/react-tabs",
              "@radix-ui/react-tooltip",
            ],
            "syntax-highlighter": ["react-syntax-highlighter"],
          },
        },
      },
      chunkSizeWarningLimit: 700,
    },
  },
})

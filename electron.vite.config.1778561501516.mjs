// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
var __electron_vite_injected_dirname = "/Users/odgrim/dev/work/git/gruntwork-io/runbooks";
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({
      exclude: ["electron-updater"]
    })],
    build: {
      outDir: "dist/main",
      rollupOptions: {
        input: {
          index: path.resolve(__electron_vite_injected_dirname, "electron/main/index.ts")
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: {
          index: path.resolve(__electron_vite_injected_dirname, "electron/preload/index.ts")
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    }
  },
  renderer: {
    root: path.resolve(__electron_vite_injected_dirname, "web"),
    base: "./",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__electron_vite_injected_dirname, "web/src")
      }
    },
    build: {
      outDir: path.resolve(__electron_vite_injected_dirname, "dist/renderer"),
      rollupOptions: {
        input: {
          index: path.resolve(__electron_vite_injected_dirname, "web/index.html")
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
              "@radix-ui/react-tooltip"
            ],
            "syntax-highlighter": ["react-syntax-highlighter"]
          }
        }
      },
      chunkSizeWarningLimit: 700
    }
  }
});
export {
  electron_vite_config_default as default
};

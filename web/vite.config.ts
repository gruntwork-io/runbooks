import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // When running `runbooks open`, we need only a single port, but when running `runbooks serve`, the frontend
    // needs its own port. But all the code in the frontend calls /api/path/to/whatever, without specifying a port 
    // for a backend server. So this proxy allows those simple paths and then re-routes them to correct backend ports.
    proxy: {
      '/api': {
        target: 'http://localhost:7825',
        changeOrigin: true,
        secure: false,
      },
      '/runbook-assets': {
        target: 'http://localhost:7825',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    // Increase chunk size warning limit. The syntax-highlighter library is large (~635 kB) because
    // it includes all language definitions, but this is acceptable for a local development tool.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Split large vendor dependencies into separate chunks to avoid Rollup's 500 kB warning.
        // These named chunks are generated separately, while all other code is bundled automatically.
        // This improves caching (vendors change less frequently than app code) and keeps individual
        // chunk sizes under the warning threshold.
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'mdx-vendor': ['@mdx-js/mdx', '@mdx-js/react', 'react-markdown', 'remark-gfm'],
          'ui-vendor': [
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-checkbox',
            '@radix-ui/react-collapsible',
            '@radix-ui/react-label',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
          ],
          'syntax-highlighter': ['react-syntax-highlighter'],
        },
      },
    },
  },
})

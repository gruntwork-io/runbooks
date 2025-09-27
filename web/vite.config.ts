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
    },
  },
})

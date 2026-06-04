import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5552,
    allowedHosts: true,
    hmr: process.env.TAILSCALE_HOST
      ? {
          protocol: 'wss',
          host: process.env.TAILSCALE_HOST,
          clientPort: parseInt(process.env.TAILSCALE_PORT || '443'),
        }
      : true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5551',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:5551',
        ws: true,
      },
    },
  },
})

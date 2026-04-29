import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5552,
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

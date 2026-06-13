import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
//
// Remote access via Tailscale is configured through env vars, NOT hardcoded.
// Put your own values in `.env.local` (gitignored) or use `--mode remote`
// with a `.env.remote` file. See `.env.example`.
//   TAILSCALE_HOST=your-machine.your-tailnet.ts.net
//   TAILSCALE_PORT=443
export default defineConfig(({ mode }) => {
  // Load .env files into a plain object (empty prefix = load all vars, not
  // just VITE_*). loadEnv works cross-platform — no inline `set`/`export`.
  const env = loadEnv(mode, process.cwd(), '')
  const tailscaleHost = env.TAILSCALE_HOST

  return {
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
      hmr: tailscaleHost
        ? {
            protocol: 'wss',
            host: tailscaleHost,
            clientPort: parseInt(env.TAILSCALE_PORT || '443'),
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
  }
})

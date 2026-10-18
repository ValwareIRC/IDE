import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')
const core = resolve(__dirname, 'src/core')

export default defineConfig({
  main: {
    // zod, diff, the Claude Agent SDK and axe-core (read in as text, which only works bundled) are bundled so the packaged app only has to ship one real module (node-pty)
    plugins: [externalizeDepsPlugin({ exclude: ['zod', '@anthropic-ai/claude-agent-sdk', 'diff', 'unpdf', '@noble/curves', '@noble/hashes', '@noble/ciphers', 'ws', 'axe-core'] })],
    resolve: { alias: { '@shared': shared, '@core': core } },
    // ws's optional native helpers are stubbed out by the bundler, and it would call into the empty stub
    define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: { alias: { '@shared': shared, '@': resolve(__dirname, 'src/renderer/src') } },
    worker: { format: 'es' },
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
      chunkSizeWarningLimit: 4000
    }
  }
})

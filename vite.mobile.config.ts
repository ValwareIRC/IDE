// The Android app's page: the same renderer as a window, built as a plain web page into mobile/www, where
// Capacitor picks it up (see mobile/README.md).
import { resolve } from 'node:path'
import { renameSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  // Capacitor opens index.html
  plugins: [react(), { name: 'index-html', closeBundle: () => renameSync(resolve(__dirname, 'mobile/www/mobile.html'), resolve(__dirname, 'mobile/www/index.html')) }],
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared'), '@': resolve(__dirname, 'src/renderer/src') } },
  worker: { format: 'es' },
  build: {
    outDir: resolve(__dirname, 'mobile/www'),
    emptyOutDir: true,
    // gadget.html is the frame a gadget runs in on the phone; it is opened by the app, not by Capacitor
    rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/mobile.html'), gadget: resolve(__dirname, 'src/renderer/gadget.html') } },
    chunkSizeWarningLimit: 6000
  }
})

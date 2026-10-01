import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const HUB = process.env.HC_HUB_URL ?? 'http://127.0.0.1:8080'
const HUB_WS = HUB.replace(/^http/, 'ws')

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'House Control',
        short_name: 'House',
        description: 'Cameras, gate and lights of the house in one private app.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f1115',
        theme_color: '#0f1115',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      devOptions: { enabled: true, type: 'module', navigateFallback: 'index.html' },
    }),
  ],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: HUB, changeOrigin: false },
      '/ws': { target: HUB_WS, ws: true },
      '/video': { target: HUB, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, target: 'es2020' },
})

import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import UnoCSS from 'unocss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    UnoCSS(),
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['iris-meet-icon.svg', 'iris-meet-icon-180.png', 'iris-meet-icon.png'],
      manifest: {
        name: 'Iris Meet',
        short_name: 'Iris Meet',
        description: 'Simple, private video meetings',
        theme_color: '#121212',
        background_color: '#121212',
        display: 'standalone',
        icons: [
          {
            src: 'iris-meet-icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'iris-meet-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'iris-meet-icon-maskable.png',
            sizes: '640x640',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
      },
    }),
  ],
  base: process.env.GITHUB_PAGES ? '/meet/' : '/',
  server: {
    allowedHosts: true,
  },
})

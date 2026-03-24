import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:7777',
        changeOrigin: true,
      },
      '/customer': {
        target: 'http://localhost:7777',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})

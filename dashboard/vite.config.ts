import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Ship source maps: a production stack trace like `index-abc.js:79:10445`
  // is otherwise a manual bisect of a 450 kB minified file.
  build: { sourcemap: true },
  server: {
    port: 5174,
    // The API lives on another origin in dev; proxying keeps the browser
    // same-origin so cookies and CORS stay boring.
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') } },
  },
})

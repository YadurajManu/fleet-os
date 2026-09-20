import { defineConfig } from 'vite'
import { siteOrigin } from './src/lib/seo.js'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  define: { __SITE_ORIGIN__: JSON.stringify(siteOrigin(process.env.SITE_ORIGIN)) },
  plugins: [
    react({ fastRefresh: false }),
    tailwindcss(),
  ],
})

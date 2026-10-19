import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: { output: { entryFileNames: 'app.js', assetFileNames: '[name][extname]' } },
  },
})

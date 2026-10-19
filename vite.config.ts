import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: { output: { entryFileNames: 'app.js', assetFileNames: '[name][extname]' } },
  },
})

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The staff app (index.html, built as app.js) and the guest pages: booking and online check-in.
const page = (f: string) => fileURLToPath(new URL(f, import.meta.url))

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: { index: page('index.html'), book: page('book.html'), checkin: page('checkin.html') },
      output: { entryFileNames: (c) => (c.name === 'index' ? 'app.js' : '[name].js'), assetFileNames: '[name][extname]' },
    },
  },
})

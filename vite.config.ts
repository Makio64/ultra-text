import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'

const sourceEntry = fileURLToPath(new URL('./src/index.ts', import.meta.url))
const vanillaEntry = fileURLToPath(new URL('./src/vanilla.ts', import.meta.url))

export default defineConfig({
  // Worker assets must resolve beside the installed package, not at the host's /assets root.
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: { format: 'es' },
  build: {
    target: 'esnext',
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        index: sourceEntry,
        vanilla: vanillaEntry,
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: (id) =>
        id === 'three' || id.startsWith('three/') || id.startsWith('@chenglou/pretext/'),
      output: {
        preserveModules: true,
        preserveModulesRoot: fileURLToPath(new URL('./src', import.meta.url)),
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})

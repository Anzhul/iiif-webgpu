import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'IIIFViewer',
      fileName: 'iiif-viewer',
    },
    rollupOptions: {
      external: ['gl-matrix'],
      output: {
        globals: {
          'gl-matrix': 'glMatrix',
        },
      },
    },
  },
});
